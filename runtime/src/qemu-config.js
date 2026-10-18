// Explicit, bounded i386 PC configuration; no external files are downloaded.
export const CORE_PATHS = Object.freeze({dir: '/pc', bios: '/pc/bios.bin', vgabios: '/pc/vgabios.bin',
  linuxboot: '/pc/linuxboot_dma.bin', hdd: '/disk/disk.img', media: '/media', kernel: '/pc/vmlinuz', initrd: '/pc/initrd.img'});
export function buildArguments(settings = {}, files = {}) {
  const cpu = settings.cpu ?? 'pentium3';
  // qemu64 and max need the experimental x86_64 core; the i386 core lacks long mode.
  if (!['486', 'pentium', 'pentium2', 'pentium3', 'qemu32', 'qemu64', 'max'].includes(cpu)) throw new Error('Unsupported CPU model');
  // The i386 core has a fixed 512 MiB heap; the x86_64 (wasm64) core grows to 16 GiB.
  const long = ['qemu64', 'max'].includes(cpu);
  const memory = Number(settings.memory ?? 64);
  const [low, high] = long ? [64, 8192] : [16, 128];
  if (!Number.isInteger(memory) || memory < low || memory > high) throw new Error(`PC memory must be ${low}–${high} MiB`);
  if (!files.bios) throw new Error('A local PC BIOS is required');
  const format = settings.diskFormat ?? 'raw';
  if (!['raw', 'qcow2'].includes(format)) throw new Error('Disk format must be raw or qcow2');
  // A local VGA BIOS (optional) lets boot loaders draw text before the OS driver.
  const vgaRom = files.vgabios ? CORE_PATHS.vgabios : '';
  // serial: 'log' routes COM1 to the core log (Linux console=ttyS0).
  const serial = settings.serial ?? 'none';
  if (!['none', 'log'].includes(serial)) throw new Error('Serial must be none or log');
  const args = ['-machine', 'pc,vmport=off,usb=off', '-accel', 'tcg,thread=single', '-cpu', cpu,
    '-global', 'apic.vapic=off', '-m', String(memory), '-bios', CORE_PATHS.bios, '-nodefaults', '-device', `VGA,addr=02.0,romfile=${vgaRom}`,
    '-display', 'web', '-serial', serial === 'log' ? 'stdio' : 'none', '-monitor', 'none', '-no-reboot', '-net', 'none', '-L', CORE_PATHS.dir];
  // pointer: 'tablet' adds an absolute virtio pointer (x86_64 core only).
  const pointer = settings.pointer ?? 'none';
  if (!['none', 'tablet'].includes(pointer)) throw new Error('Pointer must be none or tablet');
  if (pointer === 'tablet') args.push('-device', 'virtio-tablet-pci,addr=05.0');
  // boot: 'cdrom' tries the disc first (live media with a target disk attached).
  const boot = settings.boot ?? 'disk';
  if (!['disk', 'cdrom'].includes(boot)) throw new Error('Boot must be disk or cdrom');
  args.push('-boot', boot === 'cdrom' ? 'order=dc' : 'order=cd');
  if (files.hdd) args.push('-drive', `file=${CORE_PATHS.hdd},if=ide,index=0,media=disk,format=${format}`);
  if (files.disc) args.push('-drive', `file=${files.disc},if=ide,index=2,media=cdrom,format=raw,readonly=on`);
  if (files.kernel) args.push('-kernel', typeof files.kernel === 'string' && files.kernel !== true ? files.kernel : CORE_PATHS.kernel);
  if (files.initrd) args.push('-initrd', typeof files.initrd === 'string' && files.initrd !== true ? files.initrd : CORE_PATHS.initrd);
  if (settings.append !== undefined) {
    if (typeof settings.append !== 'string') throw new Error('Kernel append line must be a string');
    args.push('-append', settings.append);
  }
  return args;
}

// x86 hosts already order plain accesses like an x86 guest, so the JIT's
// guest memory fences can go (measured ~3x on x86-64 Linux Chrome). Only
// answer true when the browser says so unambiguously; anything else keeps
// fences. Firefox lacks userAgentData but reports the Linux machine type.
// macOS and Windows user agents claim x86 on Arm hardware and are not trusted.
export function hostIsX86({architecture, userAgent = '', platform = ''} = {}) {
  if (architecture) return architecture === 'x86';
  return /^Linux (x86_64|i[3-6]86)$/.test(platform) && /\bLinux (x86_64|i[3-6]86)\b/.test(userAgent);
}
