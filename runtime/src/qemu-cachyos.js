// Experimental CachyOS live boot profile for frontend start buttons.
import {QemuHost} from './qemu-host.js';
import {readIsoFile} from './qemu-iso.js';
import {prepareBrowserBoot} from './qemu-boot-cache.js';

// Session services have their own 15-second default in this live image.
// A systemd tmpfiles credential installs a volatile user-manager override
// before live-user login, without altering the ISO or guest's installed files.
const moduleTimeout = btoa('[Service]\nTimeoutStartSec=600s\n');
const desktopMarker = 'QEMU-CACHYOS-DESKTOP-READY';
const desktopUnit = btoa(`[Unit]
After=display-manager.service
[Service]
Type=simple
ExecStart=/bin/sh -c 'until [ -S /run/user/1000/wayland-0 ] && setpriv --reuid=1000 --regid=1000 --clear-groups busctl --address=unix:path=/run/user/1000/bus --timeout=30s call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s org.kde.plasmashell 2>/dev/null | grep -q true; do sleep 2; done; while true; do echo ${desktopMarker} >/dev/ttyS0; sleep 5; done'
`);

const sessionSetup = btoa('d /run/systemd/user.conf.d 0755 root root -\nf /run/systemd/user.conf.d/99-browser.conf 0644 root root - [Manager]\\nDefaultTimeoutStartSec=600s\\nDefaultEnvironment=KWIN_COMPOSE=Q QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1\\n\n');

/** Loads configured assets and boots directly into the ISO's default live system.
 * Assets are Blobs/Files or deployment URLs. The caller owns redistribution.
 * Resolves at machine startup. Await host.desktopReady for the live desktop.
 */
export async function bootCachyos({canvas, disc, bios, vgabios, linuxboot,
  coreUrl = new URL('../cores/qemu-x86_64-wasm64/qemu-core.js', import.meta.url),
  memory = 3072, cacheBoot = false, sessionMode = 'fresh', autoSaveSession = false, signal, onProgress = () => {}, onHost = () => {}} = {}) {
  if (!globalThis.crossOriginIsolated) throw new Error('CachyOS requires cross-origin isolation (COOP/COEP headers)');
  if (!['fresh', 'resume'].includes(sessionMode)) throw new Error('Invalid session mode');
  if (sessionMode === 'resume' && !cacheBoot) throw new Error('Resume requires browser boot caching');
  const cleanup = [];
  let discStorage;
  const controller = new AbortController();
  const loadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const release = () => Promise.all(cleanup.splice(0).map(fn => Promise.resolve().then(fn).catch(console.error)));
  const load = async (name, asset) => {
    if (!asset) throw new Error(`Missing CachyOS asset: ${name}`);
    onProgress({phase: 'loading', asset: name});
    if (asset instanceof Blob) return asset;
    const response = await fetch(asset, {signal: loadSignal});
    if (!response.ok) throw new Error(`Failed to load ${name}: HTTP ${response.status}`);
    if (name !== 'disc') return response.blob();
    // Response.blob() fails for multi-gigabyte media in Chromium. Stream the
    // image to OPFS and pass its disk-backed File to WORKERFS instead.
    const directory = await navigator.storage.getDirectory();
    const fileName = `qemu-live-${crypto.randomUUID()}.iso`;
    cleanup.push(() => directory.removeEntry(fileName));
    const handle = await directory.getFileHandle(fileName, {create: true});
    const output = await handle.createWritable();
    let received = 0, lastProgress = 0;
    const total = Number(response.headers.get('Content-Length')) || undefined;
    await response.body.pipeThrough(new TransformStream({transform(chunk, controller) {
      received += chunk.byteLength;
      const now = performance.now();
      if (now - lastProgress >= 100 || received === total) {
        lastProgress = now;
        onProgress({phase: 'loading', asset: name, received, total});
      }
      controller.enqueue(chunk);
    }})).pipeTo(output, {signal: loadSignal});
    discStorage = {opfs: fileName, writable: false};
    return handle.getFile();
  };
  let host;
  try {
    const cached = cacheBoot ? await prepareBrowserBoot({disc, bios, vgabios, linuxboot,
      coreUrl, memory, sessionMode, profile: [sessionSetup, moduleTimeout, desktopUnit, 'live-profile-v1'], signal: loadSignal, onProgress}) : null;
    if (cached) cleanup.push(() => cached.dispose());
    let image, pcBios, videoBios, loader, kernel, initrd, append;
    if (cached) {
      ({image, bios: pcBios, vgabios: videoBios, linuxboot: loader, kernel, initrd, append} = cached);
      discStorage = cached.disc;
      coreUrl = cached.coreUrl;
    } else {
      const loaded = await Promise.allSettled(Object.entries({disc, bios, vgabios, linuxboot}).map(
        ([name, asset]) => load(name, asset).catch(error => { controller.abort(error); throw error; })));
      const failure = loaded.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      [image, pcBios, videoBios, loader] = loaded.map(result => result.value);
      onProgress({phase: 'preparing'});
      const config = await (await readIsoFile(image, '/boot/syslinux/archiso_sys-linux.cfg')).text();
      const first = config.split(/^LABEL\s+/m).find(section => /^\S+[\s\S]*?^LINUX\s+/m.test(section));
      const field = key => first?.match(new RegExp(`^${key}\\s+(.+)$`, 'm'))?.[1].trim();
      const kernelPath = field('LINUX'), initrdPath = field('INITRD');
      append = field('APPEND');
      if (!kernelPath || !initrdPath || !append || !append.includes('archisobasedir=arch')) throw new Error('Unrecognized CachyOS live boot configuration');
      [kernel, initrd] = await Promise.all([readIsoFile(image, kernelPath), readIsoFile(image, initrdPath)]);
    }
    signal?.throwIfAborted();
    // Relative URLs resolve against the page, like the asset URLs above.
    host = new QemuHost({canvas, coreUrl: new URL(coreUrl, globalThis.location?.href ?? import.meta.url)});
    let resolveDesktop, rejectDesktop, desktopFinished = false, readyForSnapshot = false;
    host.desktopReady = new Promise((resolve, reject) => { resolveDesktop = resolve; rejectDesktop = reject; });
    // A caller may use only onProgress; keep a later termination from producing
    // an unhandled rejection while preserving the promise for callers awaiting it.
    host.desktopReady.catch(() => {});
    const finishDesktop = error => {
      if (desktopFinished) return;
      desktopFinished = true;
      clearTimeout(desktopTimer);
      host.removeEventListener('log', desktopLog);
      for (const event of ['error', 'abort', 'exited']) host.removeEventListener(event, desktopError);
      if (error) rejectDesktop(error);
      else { readyForSnapshot = true; resolveDesktop(host); onProgress({phase: 'desktop-ready'}); }
    };
    const desktopLog = e => {
      if (e.detail.lines.some(line => line.text.trim() === desktopMarker)) finishDesktop();
    };
    const desktopError = e => finishDesktop(new Error(e.detail.message || 'CachyOS exited before the desktop was ready'));
    const desktopTimer = setTimeout(() => finishDesktop(new Error('CachyOS desktop startup timed out')), 1800000);
    host.addEventListener('log', desktopLog);
    for (const event of ['error', 'abort', 'exited']) host.addEventListener(event, desktopError);
    const terminate = host.terminate.bind(host);
    host.terminate = () => { finishDesktop(new Error('CachyOS terminated')); terminate(); host.cacheClosed ||= release(); };
    host.resumedSession = !!cached?.restore;
    if (cached) {
      host.saveBootSession = () => cached.save(host, readyForSnapshot);
      if (autoSaveSession) host.desktopReady.then(() => {
        if (!cached.restore) host.saveBootSession().catch(error => onProgress({phase: 'session-save-failed', message: error.message}));
      }, () => {});
    }
    onHost(host);
    onProgress({phase: 'booting'});
    const abortBoot = () => host.terminate();
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abortBoot, {once: true});
    const kernelArgs = [
      append.replace(/\bcopytoram=\S+/g, '').trim(), 'copytoram=n',
      'console=tty0', 'console=ttyS0,115200',
      `systemd.set_credential_binary=tmpfiles.extra:${sessionSetup}`,
      `systemd.set_credential_binary=systemd.unit-dropin.systemd-modules-load.service:${moduleTimeout}`,
      `systemd.set_credential_binary=systemd.extra-unit.qemu-desktop-ready.service:${desktopUnit}`,
      'systemd.wants=qemu-desktop-ready.service',
      'systemd.firstboot=no', 'systemd.condition_needs_update=no',
      'systemd.mask=systemd-firstboot.service',
      'systemd.mask=pacman-init.service',
      'systemd.mask=zfs-import-cache.service', 'systemd.mask=zfs-import-scan.service',
      'systemd.mask=systemd-time-wait-sync.service',
      'systemd.mask=systemd-timesyncd.service', 'systemd.default_timeout_start_sec=600',
      'systemd.default_device_timeout_sec=600', 'udev.children_max=2', 'rd.udev.children_max=2',
    ].join(' ');
    try {
      await host.boot({args: ['-device', 'virtio-rng-pci,addr=06.0'],
        wasmBinary: cached?.wasmBinary, restoreSession: !!cached?.restore,
        files: {...(cached ? {state: cached.state} : {}), disc: discStorage || image, bios: pcBios, vgabios: videoBios, linuxboot: loader, kernel, initrd},
        settings: {cpu: 'max', memory, pointer: 'tablet', serial: 'log', boot: 'cdrom', append: kernelArgs}});
    } finally { signal?.removeEventListener('abort', abortBoot); }
    if (cached?.desktopReady) finishDesktop();
    return host;
  } catch (error) { host?.terminate(); release(); throw error; }
}
