// Origin-local boot files and immutable session checkpoints. No guest data is
// uploaded. Content keys include every byte without buffering an entire ISO.
import {createQcow2} from './qemu-qcow2.js';
import {readIsoFile} from './qemu-iso.js';
import {buildArguments, CORE_PATHS} from './qemu-config.js';
const directoryName = 'qemu-boot-v1';
async function acquire() {
  if (!navigator.locks) throw new Error('Browser boot caching requires Web Locks');
  return new Promise((resolve, reject) => {
    let releaseHold;
    const held = new Promise(done => { releaseHold = done; });
    const request = navigator.locks.request(directoryName, {ifAvailable: true}, async lock => {
      if (!lock) throw new Error('Boot cache is in use. Stop the session in the other tab first.');
      // Await actual release acknowledgement, not just resolution of the held
      // promise: immediately restarting must not race the browser lock manager.
      resolve(async () => { releaseHold(); await request; });
      await held;
    }).catch(reject);
  });
}

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export async function hashBootBlob(blob, {signal, onProgress = () => {}} = {}) {
  signal?.throwIfAborted();
  const hashes = [];
  for (let at = 0; at < blob.size; at += 8 * 1024 * 1024) {
    signal?.throwIfAborted();
    hashes.push(hex(await crypto.subtle.digest('SHA-256', await blob.slice(at, at + 8 * 1024 * 1024).arrayBuffer())));
    onProgress(Math.min(blob.size, at + 8 * 1024 * 1024));
  }
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${blob.size}:${hashes.join(':')}`)));
}
const root = () => navigator.storage.getDirectory();
const directory = async () => (await root()).getDirectoryHandle(directoryName, {create: true});
async function json(dir, name) {
  try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); }
  catch (e) { if (e.name === 'NotFoundError' || e instanceof SyntaxError) return null; throw e; }
}
async function write(dir, name, data, signal) {
  const out = await (await dir.getFileHandle(name, {create: true})).createWritable();
  try {
    if (data instanceof Blob) await data.stream().pipeTo(out, {signal});
    else { signal?.throwIfAborted(); await out.write(data); await out.close(); }
  } catch (e) { try { await out.abort(); } catch {} throw e; }
}
async function file(dir, info) {
  if (!info || !/^[a-zA-Z0-9.-]+$/.test(info.name)) return null;
  try {
    const value = await (await dir.getFileHandle(info.name)).getFile();
    return value.size === info.size ? value : null;
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
async function checkpoint(dir, info) {
  const blob = await file(dir, info);
  if (!blob || blob.size < 104) return null;
  const header = new DataView(await blob.slice(0, 104).arrayBuffer());
  const offset = header.getBigUint64(64);
  return header.getUint32(0) === 0x514649fb && header.getUint32(4) === 3 &&
    header.getUint32(60) > 0 && offset > 0n && offset < BigInt(blob.size) ? blob : null;
}
export async function getBootCacheInfo(slot = 'cachyos') {
  try {
    const names = await slotNames(slot);
    const dir = await directory(), last = await json(dir, names.latest);
    if (!last) return {cached: false, saved: false};
    const media = last.kind === 'machine' ? (await Promise.all(Object.values(last.files).map(info => file(dir, info)))).every(Boolean) : await file(dir, last.disc);
    const session = await json(dir, names.session);
    return {cached: !!media, name: last.label || last.disc?.label, bytes: last.disc?.size, settings: last.settings, hasDisc: !!last.files?.disc, hasDisk: !!last.files?.hdd, serial: !!last.args?.includes('isa-serial,chardev=console,index=0'),
      saved: !!(media && session?.identity === last.identity && await checkpoint(dir, session.file)), savedAt: session?.savedAt};
  } catch { return {cached: false, saved: false}; }
}
export async function clearBootCache() {
  const release = await acquire();
  try {
    try { await (await root()).removeEntry(directoryName, {recursive: true}); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    try { await caches.delete('qemu-core-binaries-v1'); } catch {}
  } finally { await release(); }
}

async function cachedCore(coreUrl, signal, progress) {
  const url = new URL(coreUrl, globalThis.location?.href ?? import.meta.url);
  const recordUrl = new URL(url); recordUrl.pathname = recordUrl.pathname.replace(/\.js$/, '.build.json');
  const response = await fetch(recordUrl, {signal, cache: 'no-store'});
  if (!response.ok) throw new Error('Cannot identify the core for a browser session');
  const record = await response.json();
  if (!/^sha256:[a-f0-9]{64}$/.test(record.coreId) || record.vendorDirty) throw new Error('Browser sessions require a clean, identified core build');
  // Cache verified wasm by content rather than by a mutable deployment URL.
  const wasmUrl = new URL('qemu-core.wasm', url);
  wasmUrl.searchParams.set('build', record.coreId);
  const cacheKey = new URL(`.boot-cache/${record.coreId.slice(7)}.wasm`, url);
  let storage;
  try { storage = await caches.open('qemu-core-binaries-v1'); } catch {}
  let binary = await storage?.match(cacheKey);
  const verify = async value => {
    if (!value) return null;
    const bytes = await value.arrayBuffer();
    return `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}` === record.coreId ? bytes : null;
  };
  let wasmBinary = await verify(binary);
  if (!wasmBinary) {
    binary = await fetch(wasmUrl, {signal, cache: 'no-cache'});
    if (!binary.ok) throw new Error('Failed to load browser core');
    wasmBinary = await verify(binary.clone());
    if (!wasmBinary) throw new Error('Browser core does not match its build record');
    try { await storage?.put(cacheKey, binary); } catch {}
  } else progress('cache-hit', {asset: 'engine'});
  url.searchParams.set('build', record.files?.find(f => f.path === 'qemu-core.js')?.sha256 || record.coreId);
  return {coreUrl: url, wasmBinary, record};
}

function checkpointStore({dir, workingName, identity, saved, sessionName = 'session.json', progress, onProgress, release}) {
  let saving = false, disposed = false, disposal, activeSave;
  return {
    state: {opfs: `${directoryName}/${workingName}`, writable: true},
    async save(host, desktopReady) {
      if (disposed || saving) throw new Error('A session save is already running or the session has stopped');
      saving = true;
      let finishSave, published = false;
      activeSave = new Promise(resolve => { finishSave = resolve; });
      const name = `saved-${crypto.randomUUID()}.qcow2`;
      try {
        progress('saving-session');
        await host.saveSession({copyTo: `${directoryName}/${name}`});
        if (disposed) throw new Error('Session stopped before saving completed');
        const blob = await (await dir.getFileHandle(name)).getFile();
        const next = {identity, savedAt: new Date().toISOString(), desktopReady,
          file: {name, size: blob.size}};
        await write(dir, sessionName, JSON.stringify(next));
        published = true;
        if (saved?.file?.name && saved.file.name !== name) await dir.removeEntry(saved.file.name).catch(() => {});
        saved = next; onProgress({phase: 'session-saved'}); return next;
      } catch (e) { if (!published) await dir.removeEntry(name).catch(() => {}); throw e; }
      finally { saving = false; finishSave(); }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        try {
          // Worker shutdown releases the sync access handle asynchronously.
          for (let attempt = 0; attempt < 10; attempt++) {
            try { await dir.removeEntry(workingName); return; }
            catch (e) { if (e.name === 'NotFoundError') return; await new Promise(r => setTimeout(r, 50)); }
          }
        } finally { if (activeSave) await activeSave; await release(); }
      })();
      return disposal;
    },
  };
}

async function slotNames(slot = 'cachyos') {
  if (slot === 'cachyos') return {latest: 'latest.json', session: 'session.json'};
  const key = await hashBootBlob(new Blob([slot]));
  return {latest: `latest-${key}.json`, session: `session-${key}.json`};
}
async function collectWorkingCopies(dir) {
  const keep = new Set();
  for await (const [name] of dir.entries()) {
    if (/^session(?:-[a-f0-9]+)?\.json$/.test(name)) {
      const saved = await json(dir, name); if (saved?.file?.name) keep.add(saved.file.name);
    }
  }
  for await (const [name] of dir.entries()) {
    if (name.startsWith('working-') || (name.startsWith('saved-') && !keep.has(name))) await dir.removeEntry(name).catch(() => {});
  }
}

/** Prepares the live profile's cache. Call dispose only after terminating its
 * worker; the immutable saved checkpoint is never mounted writable. */
export async function prepareBrowserBoot({disc, bios, vgabios, linuxboot, coreUrl, memory,
  sessionMode = 'fresh', profile = '', signal, onProgress = () => {}}) {
  if (!['fresh', 'resume'].includes(sessionMode)) throw new Error('Invalid session mode');
  const release = await acquire();
  let partialWorking;
  try {
    const dir = await directory();
    const latest = await json(dir, 'latest.json');
    await collectWorkingCopies(dir);
    const progress = (phase, extra = {}) => { signal?.throwIfAborted(); onProgress({phase, ...extra}); };
    const put = async (blob, label, source) => {
      progress('checking-cache', {asset: label});
      const hash = await hashBootBlob(blob, {signal, onProgress: received => progress('checking-cache', {asset: label, received, total: blob.size})});
      const info = {name: `${hash}.${label}`, hash, size: blob.size, label: blob.name || label, source};
      if (!await file(dir, info)) {
        progress('caching', {asset: label});
        await write(dir, info.name, blob, signal);
      }
      return {info, blob: await file(dir, info)};
    };
    const load = async (asset, label, previous) => {
      if (!asset) {
        const blob = await file(dir, previous);
        if (!blob) throw new Error(`No cached ${label}; choose boot files first`);
        return {info: previous, blob};
      }
      if (asset instanceof Blob) return put(asset, label);
      progress('loading', {asset: label});
      const response = await fetch(asset, {signal, cache: 'no-cache'});
      if (!response.ok) throw new Error(`Failed to load ${label}: HTTP ${response.status}`);
      if (label !== 'disc') return put(await response.blob(), label, String(asset));
      // Keep multi-gigabyte responses off the JS heap.
      const name = `download-${crypto.randomUUID()}.iso`;
      const out = await (await dir.getFileHandle(name, {create: true})).createWritable();
      try {
        await response.body.pipeTo(out, {signal});
        const blob = await (await dir.getFileHandle(name)).getFile();
        const hash = await hashBootBlob(blob, {signal});
        return {info: {name, hash, size: blob.size, label: String(asset).split('/').pop(), source: String(asset), validator: response.headers.get('ETag') || response.headers.get('Last-Modified')}, blob};
      } catch (e) { try { await out.abort(); } catch {} await dir.removeEntry(name).catch(() => {}); throw e; }
    };
    // Reuse a URL download only after the server confirms its validator.
    let media;
    if (typeof disc === 'string' && latest?.disc.source === disc && latest.disc.validator) {
      try {
        const response = await fetch(disc, {method: 'HEAD', signal, cache: 'no-cache'});
        const validator = response.headers.get('ETag') || response.headers.get('Last-Modified');
        const blob = await file(dir, latest.disc);
        if (response.ok && validator === latest.disc.validator && blob) media = {info: latest.disc, blob};
      } catch (e) { signal?.throwIfAborted(); }
    }
    media ||= await load(disc, 'disc', latest?.disc);
    const firmware = {};
    for (const [label, asset] of Object.entries({bios, vgabios, linuxboot})) firmware[label] = await load(asset, label, latest?.[label]);
    const configName = `${media.info.hash}.boot.json`;
    let config = await json(dir, configName);
    let kernel = config && await file(dir, config.kernel), initrd = config && await file(dir, config.initrd);
    if (!kernel || !initrd) {
      progress('preparing');
      const text = await (await readIsoFile(media.blob, '/boot/syslinux/archiso_sys-linux.cfg')).text();
      const first = text.split(/^LABEL\s+/m).find(s => /^\S+[\s\S]*?^LINUX\s+/m.test(s));
      const field = key => first?.match(new RegExp(`^${key}\\s+(.+)$`, 'm'))?.[1].trim();
      if (!field('LINUX') || !field('INITRD') || !field('APPEND')?.includes('archisobasedir=arch')) throw new Error('Unrecognized CachyOS live boot configuration');
      const k = await put(await readIsoFile(media.blob, field('LINUX')), 'kernel');
      const i = await put(await readIsoFile(media.blob, field('INITRD')), 'initrd');
      config = {append: field('APPEND'), kernel: k.info, initrd: i.info}; kernel = k.blob; initrd = i.blob;
      await write(dir, configName, JSON.stringify(config), signal);
    } else progress('cache-hit', {asset: 'kernel and initramfs'});
    const {coreUrl: url, wasmBinary, record} = await cachedCore(coreUrl, signal, progress);
    const identity = await hashBootBlob(new Blob([JSON.stringify({version: 1, core: record.coreId,
      profile, disc: media.info.hash, firmware: Object.values(firmware).map(f => f.info.hash), memory, config})]));
    let saved = await json(dir, 'session.json');
    const savedFile = saved?.identity === identity && await checkpoint(dir, saved.file);
    const restore = sessionMode === 'resume' && !!savedFile;
    if (sessionMode === 'resume' && !restore) progress('session-miss');
    const workingName = partialWorking = `working-${crypto.randomUUID()}.qcow2`;
    progress(restore ? 'restoring' : 'cache-hit', {asset: restore ? 'saved session' : 'boot files'});
    await write(dir, workingName, restore ? savedFile : createQcow2(1024 * 1024), signal);
    const manifest = {identity, settings: {memory}, disc: media.info, ...Object.fromEntries(Object.entries(firmware).map(([k, v]) => [k, v.info]))};
    await write(dir, 'latest.json', JSON.stringify(manifest), signal);
    return {
      image: media.blob, bios: firmware.bios.blob, vgabios: firmware.vgabios.blob, linuxboot: firmware.linuxboot.blob,
      kernel, initrd, append: config.append, wasmBinary, coreUrl: url, restore,
      desktopReady: restore && !!saved.desktopReady,
      disc: {opfs: `${directoryName}/${media.info.name}`, writable: false},
      ...checkpointStore({dir, workingName, identity, saved, progress, onProgress, release}),
    };
  } catch (e) {
    if (partialWorking) {
      try { await (await directory()).removeEntry(partialWorking); } catch {}
    }
    await release(); throw e;
  }
}

/** Cache a general PC boot and provide an explicit, per-system checkpoint.
 * The immutable selected disk is the backing file of a disposable qcow2
 * overlay. The overlay contains both disk changes and the saved VM state. */
export async function prepareCachedMachine({slot, label = 'PC', files = {}, settings, args,
  coreUrl, sessionMode = 'resume', replaceFiles = false, signal, onProgress = () => {}}) {
  if (!slot || slot === 'cachyos') throw new Error('A separate machine cache slot is required');
  if (!['fresh', 'resume'].includes(sessionMode)) throw new Error('Invalid session mode');
  const release = await acquire();
  let workingName;
  try {
    const dir = await directory(), names = await slotNames(slot);
    await collectWorkingCopies(dir);
    const previous = await json(dir, names.latest);
    const progress = (phase, extra = {}) => { signal?.throwIfAborted(); onProgress({phase, ...extra}); };
    const infos = {}, blobs = {};
    const keys = new Set([...(replaceFiles ? [] : Object.keys(previous?.files || {})), ...Object.keys(files)]);
    for (const key of keys) {
      if (!['bios', 'vgabios', 'linuxboot', 'disc', 'hdd', 'kernel', 'initrd'].includes(key)) throw new Error('Unsupported cached boot asset');
      const selected = Object.hasOwn(files, key);
      let blob = files[key];
      if (selected && blob == null) continue;
      if (ArrayBuffer.isView(blob) || blob instanceof ArrayBuffer) blob = new Blob([blob]);
      if (!selected) {
        blob = await file(dir, previous.files[key]);
        if (!blob) throw new Error(`Cached ${key} is missing; select the original boot files again`);
        infos[key] = previous.files[key];
      } else {
        if (!(blob instanceof Blob)) throw new Error('Cached PC boot files must be local Blobs or Files');
        progress('checking-cache', {asset: key});
        const hash = await hashBootBlob(blob, {signal, onProgress: received => progress('checking-cache', {asset: key, received, total: blob.size})});
        infos[key] = {name: `${hash}.${key}`, hash, size: blob.size, label: blob.name || key};
        if (!await file(dir, infos[key])) { progress('caching', {asset: key}); await write(dir, infos[key].name, blob, signal); }
        blob = await file(dir, infos[key]);
      }
      blobs[key] = blob;
    }
    if (!blobs.bios) throw new Error('Choose a BIOS for the first cached boot');
    const effectiveSettings = {...previous?.settings, ...settings};
    const effectiveArgs = args ?? previous?.args ?? [];
    const configuration = buildArguments(effectiveSettings, {bios: true, vgabios: !!blobs.vgabios,
      disc: blobs.disc ? '/media/disc-1.iso' : '', kernel: blobs.kernel ? CORE_PATHS.kernel : '', initrd: blobs.initrd ? CORE_PATHS.initrd : ''});
    const core = await cachedCore(coreUrl, signal, progress);
    const identity = await hashBootBlob(new Blob([JSON.stringify({version: 1, core: core.record.coreId,
      slot, files: Object.fromEntries(Object.keys(infos).sort().map(k => [k, infos[k].hash])),
      configuration, settings: effectiveSettings, args: effectiveArgs})]));
    const saved = await json(dir, names.session);
    const savedFile = saved?.identity === identity && await checkpoint(dir, saved.file);
    const restore = sessionMode === 'resume' && !!savedFile;
    if (sessionMode === 'resume' && !restore) progress('session-miss');
    let overlay = createQcow2(1024 * 1024);
    if (blobs.hdd) {
      const format = effectiveSettings.diskFormat || 'raw';
      let size = blobs.hdd.size;
      if (format === 'qcow2') {
        const header = new DataView(await blobs.hdd.slice(0, 32).arrayBuffer());
        if (header.byteLength < 32 || header.getUint32(0) !== 0x514649fb) throw new Error('Invalid qcow2 base disk');
        if (header.getUint32(16)) throw new Error('Use a self-contained qcow2 disk without external backing files');
        const value = header.getBigUint64(24);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Disk is too large');
        size = Number(value);
      } else if (format !== 'raw') throw new Error('Unsupported disk format');
      overlay = createQcow2(size, {backingFile: '/disk/base.img', backingFormat: format});
    }
    workingName = `working-${crypto.randomUUID()}.qcow2`;
    progress(restore ? 'restoring' : 'cache-hit', {asset: restore ? 'saved session' : 'boot files'});
    await write(dir, workingName, restore ? savedFile : overlay, signal);
    const bootFiles = {};
    for (const [key, blob] of Object.entries(blobs)) {
      if (key === 'hdd') bootFiles.baseDisk = {opfs: `${directoryName}/${infos[key].name}`, writable: false};
      else if (key === 'disc') bootFiles.disc = {opfs: `${directoryName}/${infos[key].name}`, writable: false};
      else bootFiles[key] = blob;
    }
    await write(dir, names.latest, JSON.stringify({kind: 'machine', identity, label, files: infos,
      settings: effectiveSettings, args: effectiveArgs}), signal);
    const store = checkpointStore({dir, workingName, identity, saved, sessionName: names.session, progress, onProgress, release});
    return {...store, restore, coreUrl: core.coreUrl,
      boot: {files: {...bootFiles, state: store.state}, settings: effectiveSettings, args: effectiveArgs,
        wasmBinary: core.wasmBinary, restoreSession: restore, sessionDisk: !!blobs.hdd}};
  } catch (e) {
    if (workingName) { try { await (await directory()).removeEntry(workingName); } catch {} }
    await release(); throw e;
  }
}
