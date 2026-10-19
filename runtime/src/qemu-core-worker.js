// Dedicated worker that hosts the PC WebAssembly core.
//
// This worker is Emscripten's runtime thread. main() runs on a proxied pthread
// (PROXY_TO_PTHREAD), so this thread's event loop stays free to service
// proxied syscalls (files, poll), start pthread workers and relay commands.
//
// Protocol (page -> worker): {type:'boot', ...}, {type:'command', id, cmd, arg},
// {type:'mount', ...}. Worker -> page: {type:'host-port', port} for each
// pthread worker, plus {qemu:{type,...}} events from the runtime thread.
import {buildArguments, CORE_PATHS, hostIsX86} from './qemu-config.js';
import {mountOpfsFile} from './qemu-opfs-fs.js';
import {cacheBlobReads} from './qemu-blob-cache.js';
import {resolveCdnSource} from './qemu-cdn.js';

let Module = null;
// Set once main() has been entered; commands before that are refused.
let booted = false;
let FS = null;
// wasm64 cores exchange pointers with JavaScript as BigInt.
let toPtr = p => p;
const portedWorkers = new WeakSet();

const send = (msg, transfer = []) => postMessage({qemu: msg}, transfer);

// Core logs are batched: at most one message per interval with repeated lines
// collapsed (per-line page updates were a major slowdown in the sibling
// emulator ports). The first line after a quiet period is sent at once, so a
// fatal message still reaches the page if this thread blocks right after.
const log = {lines: [], timer: 0, last: '', repeats: 0, lastSent: 0, echo: false};
function flushLog() {
  log.timer = 0;
  if (!log.lines.length) return;
  const lines = log.lines;
  log.lines = [];
  log.lastSent = performance.now();
  send({type: 'log', lines});
}
function logLine(stream, text) {
  if (log.echo) (stream === 'err' ? console.error : console.log)(text);
  if (text === log.last) {
    log.repeats++;
    return;
  }
  if (log.repeats) {
    log.lines.push({stream, text: `(previous line repeated ${log.repeats} more times)`});
    log.repeats = 0;
  }
  log.last = text;
  log.lines.push({stream, text});
  if (log.lines.length > 2000) log.lines.splice(0, log.lines.length - 2000);
  if (performance.now() - log.lastSent > 100) {
    flushLog();
  } else if (!log.timer) {
    log.timer = setTimeout(flushLog, 100);
  }
}

// stdout arrives byte by byte so a prompt without a newline (a serial
// console's "login:") is still logged once output pauses.
const stdout = {bytes: [], timer: 0, decoder: new TextDecoder()};
function flushStdout() {
  clearTimeout(stdout.timer);
  stdout.timer = 0;
  if (!stdout.bytes.length) return;
  const text = stdout.decoder.decode(new Uint8Array(stdout.bytes));
  stdout.bytes = [];
  logLine('out', text.replace(/\r$/, ''));
}
function stdoutByte(byte) {
  if (byte === null || byte === 10) {
    flushStdout();
    return;
  }
  stdout.bytes.push(byte);
  if (stdout.bytes.length >= 4096) flushStdout();
  else if (!stdout.timer) stdout.timer = setTimeout(flushStdout, 150);
}

// Gives every pthread worker its own MessagePort to the page. Running
// pthreads never return to their event loop, so this must happen while the
// worker idles in the pool (before Emscripten posts its 'run' message).
function installHostPorts(PThread) {
  const give = worker => {
    if (!worker || portedWorkers.has(worker)) return;
    portedWorkers.add(worker);
    const channel = new MessageChannel();
    worker.postMessage({qemuHostPort: channel.port2}, [channel.port2]);
    send({type: 'host-port', port: channel.port1}, [channel.port1]);
  };
  // Emscripten has kept these as arrays or as id-keyed objects across versions.
  const workers = set => Array.isArray(set) ? set : Object.values(set || {});
  for (const w of workers(PThread.unusedWorkers)) give(w);
  for (const w of workers(PThread.runningWorkers)) give(w);
  const allocate = PThread.allocateUnusedWorker.bind(PThread);
  PThread.allocateUnusedWorker = (...args) => {
    const result = allocate(...args);
    for (const w of workers(PThread.unusedWorkers)) give(w);
    return result;
  };
}

function writeFile(path, data) {
  FS.writeFile(path, data instanceof Uint8Array ? data : new Uint8Array(data));
}

function mkdirp(path) {
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at += '/' + part;
    try { FS.mkdir(at); } catch (e) { /* exists */ }
  }
}

// Files from the page arrive as Blobs/Files (read lazily through WORKERFS),
// ArrayBuffers (copied into memory) or OPFS paths (read/write in place).
async function placeFile(spec, target) {
  if (!spec) return false;
  const dir = target.slice(0, target.lastIndexOf('/')) || '/';
  const name = target.slice(target.lastIndexOf('/') + 1);
  mkdirp(dir);
  if (spec.opfs) {
    await mountOpfsFile(Module, FS, spec.opfs, dir, name, {writable: !!spec.writable});
  } else if (resolveCdnSource(spec) || (typeof spec === 'string' && /^https?:\/\//i.test(spec)) || spec?.url || spec?.streamUrl) {
    const cdn = resolveCdnSource(spec);
    const url = cdn ? cdn.streamUrl : (typeof spec === 'string' ? spec : (spec.streamUrl || spec.url));
    let blob = null;
    const cacheStorage = typeof caches !== 'undefined' ? caches : (typeof self !== 'undefined' && self.caches ? self.caches : null);
    if (cacheStorage) {
      try {
        const cache = await cacheStorage.open('qemu-downloads-v1');
        const match = await cache.match(url);
        if (match) blob = await match.blob();
      } catch (_) {}
    }
    if (!blob) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CDN fetch failed (${response.status}) for ${url}`);
      if (cacheStorage) {
        try {
          const cache = await cacheStorage.open('qemu-downloads-v1');
          await cache.put(url, response.clone());
        } catch (_) {}
      }
      blob = await response.blob();
    }
    return placeFile(blob, target);
  } else if (spec instanceof Blob || spec.blob) {
    const blob = spec.blob || spec;
    if (spec.copy || target === CORE_PATHS.kernel || target === CORE_PATHS.initrd || blob.size <= 16 * 1024 * 1024) {
      writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    } else {
      const mountDir = `${dir}/.blob-${name}`;
      mkdirp(mountDir);
      FS.mount(FS.filesystems.WORKERFS ?? Module.WORKERFS, {blobs: [{name, data: blob}]}, mountDir);
      cacheBlobReads(FS.lookupPath(`${mountDir}/${name}`).node, blob.size);
      FS.symlink(`${mountDir}/${name}`, target);
    }
  } else if (spec instanceof ArrayBuffer || ArrayBuffer.isView(spec)) {
    writeFile(target, spec instanceof ArrayBuffer ? new Uint8Array(spec) : new Uint8Array(spec.buffer, spec.byteOffset, spec.byteLength));
  } else {
    throw new Error(`Unsupported file description for ${target}`);
  }
  return true;
}

async function boot(msg) {
  log.echo = !!msg.echoLog;
  const factory = (await import(msg.coreUrl)).default;
  const started = performance.now();
  Module = await factory({
    locateFile: path => {
      const url = new URL(path, msg.coreUrl);
      const build = new URL(msg.coreUrl).searchParams.get('build');
      if (build) url.searchParams.set('build', build);
      return url.href;
    },
    stdout: stdoutByte,
    printErr: text => logLine('err', text),
    onAbort: what => { flushLog(); send({type: 'abort', message: String(what)}); },
    onExit: status => { flushLog(); send({type: 'exited', status}); },
    ...(msg.wasmBinary ? {wasmBinary: msg.wasmBinary} : {}),
  });
  FS = Module.FS;
  installHostPorts(Module.PThread);

  // GLib's temporary directory is /var/tmp in the pinned build. QEMU uses
  // it for private writable overlays when a local read-only file is booted
  // with -snapshot. Emscripten only creates /tmp by default.
  mkdirp('/var/tmp');
  FS.chmod('/var/tmp', 0o1777);
  mkdirp(CORE_PATHS.dir);
  const files = msg.files || {};
  const present = {
    bios: await placeFile(files.bios, CORE_PATHS.bios),
    vgabios: await placeFile(files.vgabios, CORE_PATHS.vgabios),
    linuxboot: files.linuxboot ? await placeFile(files.linuxboot, CORE_PATHS.linuxboot) : false,
    hdd: await placeFile(files.hdd, CORE_PATHS.hdd),
    kernel: files.kernel ? await placeFile(files.kernel, CORE_PATHS.kernel) : false,
    initrd: files.initrd ? await placeFile(files.initrd, CORE_PATHS.initrd) : false,
  };
  if (files.disc) {
    present.disc = nextDiscPath();
    await placeFile(files.disc, present.disc);
  }
  const args = [...buildArguments(msg.settings, present), ...(msg.args || [])];
  if (files.baseDisk) await placeFile(files.baseDisk, '/disk/base.img');
  if (files.state) {
    mkdirp('/state');
    await placeFile(files.state, '/state/session.qcow2');
    args.push('-drive', `file=/state/session.qcow2,if=${msg.sessionDisk ? 'ide,index=0' : 'none'},id=browser-state-drive,node-name=browser-state,format=qcow2`);
    if (msg.restoreSession) args.push('-loadvm', 'browser-session');
  }
  const memory = Module.wasmMemory;
  const ptr = {stats: Number(Module._qemu_web_stats_ptr())};
  if (typeof Module._qemu_web_stats_ptr() === 'bigint') toPtr = BigInt;
  const layout = {};

  const reference = msg.x87 === 'reference';
  if (msg.x87 && !['fast', 'reference'].includes(msg.x87)) throw new Error('Invalid x87 mode');
  if (Module._xemu_web_x87_configure && Module._tci_wasm_jit_set_x87_options) {
    ptr.x87 = Number(Module._xemu_web_x87_configure(reference ? 1 : 0, msg.x87Profile ? 1 : 0));
    ptr.x87Jit = Number(Module._tci_wasm_jit_set_x87_options(reference ? 1 : 0,
      msg.x87Cache ? 1 : 0, msg.x87Profile ? 1 : 0));
  } else if (reference || msg.x87Cache || msg.x87Profile) {
    throw new Error('This core does not support x87 diagnostics; rebuild the core');
  }
  send({type: 'diag', stage: 'x87', mode: reference ? 'reference' : 'fast',
        cache: !reference && !!msg.x87Cache, profile: !!msg.x87Profile});

  // Shared memory goes to the page before main() so input/audio work at once.
  send({type: 'ready', memory, ptr, layout, loadMs: performance.now() - started});

  if (msg.jit === false && Module._tci_wasm_jit_set_enabled) Module._tci_wasm_jit_set_enabled(0);
  const fences = await memoryFences(msg.memoryOrder);
  if (!fences && Module._tci_wasm_jit_set_fences) Module._tci_wasm_jit_set_fences(0);
  send({type: 'diag', stage: 'memory order', fences});
  let rc;
  booted = true;
  try {
    rc = Module.callMain(args);
  } catch (err) {
    send({type: 'diag', stage: 'callMain threw', message: String(err && err.stack || err)});
  }
  send({type: 'diag', stage: 'main started', rc, ...poolState()});
}

// Strict ordering is the portable default; 'auto' drops fences on x86 hosts.
async function memoryFences(order = 'strict') {
  if (order === 'strict') return true;
  if (order === 'relaxed') return false;
  let architecture;
  try {
    ({architecture} = await navigator.userAgentData.getHighEntropyValues(['architecture']));
  } catch { /* Firefox and Safari: fall back to the user agent */ }
  return !hostIsX86({architecture, userAgent: navigator.userAgent, platform: navigator.platform});
}

function poolState() {
  const P = Module?.PThread;
  const count = set => Array.isArray(set) ? set.length : Object.keys(set || {}).length;
  return P ? {unused: count(P.unusedWorkers), running: count(P.runningWorkers)} : {};
}

self.addEventListener('message', e => {
  if (e.data?.type === 'diag') send({type: 'diag', stage: 'probe', ...poolState()});
});

// Input can arrive while the core is still loading (or after it failed to
// load); answer the request instead of reporting a core error.
function command(msg) {
  if (!Module?._qemu_web_command || !booted) {
    send({type: 'command-result', id: msg.id, ok: false, error: 'Core is not running'});
    return;
  }
  const arg = Module.stringToNewUTF8(msg.arg ?? '');
  try {
    const rc = Module._qemu_web_command(msg.id, msg.cmd, toPtr(arg));
    if (rc !== 0) send({type: 'command-result', id: msg.id, ok: false, error: 'Unknown command'});
  } finally {
    Module._free(arg);
  }
}

// Each insertion gets its own mount: WORKERFS and OPFS handles can remain open
// while QEMU releases the previous disc. User filenames never become FS paths.
let discSerial = 0;
function nextDiscPath() { return `${CORE_PATHS.media}/disc-${++discSerial}.iso`; }

// Places a file in the running core (e.g. a disc picked after boot).
async function mount(msg) {
  const path = nextDiscPath();
  await placeFile(msg.file, path);
  send({type: 'mounted', id: msg.id, path});
}

async function copySession(msg) {
  if (!FS || !/^[a-zA-Z0-9./-]+$/.test(msg.path) || msg.path.split('/').some(p => !p || p === '..')) throw new Error('Invalid session destination');
  let dir = await navigator.storage.getDirectory();
  const parts = msg.path.split('/'), name = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, {create: true});
  const out = await (await dir.getFileHandle(name, {create: true})).createWritable();
  const stream = FS.open('/state/session.qcow2', 'r');
  try {
    const size = FS.stat('/state/session.qcow2').size;
    const chunk = new Uint8Array(1024 * 1024);
    for (let at = 0; at < size;) {
      const n = FS.read(stream, chunk, 0, Math.min(chunk.length, size - at), at);
      if (!n) throw new Error('Short session read');
      await out.write(chunk.subarray(0, n)); at += n;
    }
    await out.close();
  } catch (e) { try { await out.abort(); } catch {} throw e; }
  finally { FS.close(stream); }
  send({type: 'session-copied', id: msg.id});
}

self.onmessage = async e => {
  const msg = e.data;
  if (!msg || !msg.type) return;
  try {
    if (msg.type === 'boot') await boot(msg);
    else if (msg.type === 'command') command(msg);
    else if (msg.type === 'mount') await mount(msg);
    else if (msg.type === 'copy-session') await copySession(msg);
  } catch (err) {
    send({type: 'error', message: String(err && err.stack || err), id: msg.id});
  }
};
