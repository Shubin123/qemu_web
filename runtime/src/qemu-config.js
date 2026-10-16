// Explicit, bounded i386 PC configuration; no external files are downloaded.
export const CORE_PATHS = Object.freeze({dir: '/pc', bios: '/pc/bios.bin', hdd: '/disk/disk.img', media: '/media'});
export function buildArguments(settings = {}, files = {}) {
  const memory = Number(settings.memory ?? 64);
  if (!Number.isInteger(memory) || memory < 16 || memory > 128) throw new Error('PC memory must be 16–128 MiB');
  const cpu = settings.cpu ?? 'pentium3';
  if (!['486', 'pentium', 'pentium2', 'pentium3', 'qemu32'].includes(cpu)) throw new Error('Unsupported i386 CPU');
  if (!files.bios) throw new Error('A local PC BIOS is required');
  const format = settings.diskFormat ?? 'raw';
  if (!['raw', 'qcow2'].includes(format)) throw new Error('Disk format must be raw or qcow2');
  const args = ['-machine', 'pc,vmport=off,usb=off', '-accel', 'tcg,thread=single', '-cpu', cpu,
    '-global', 'apic.vapic=off', '-m', String(memory), '-bios', CORE_PATHS.bios, '-nodefaults', '-device', 'VGA,addr=02.0,romfile=',
    '-display', 'web', '-serial', 'none', '-monitor', 'none', '-no-reboot', '-net', 'none'];
  if (files.hdd) args.push('-drive', `file=${CORE_PATHS.hdd},if=ide,index=0,media=disk,format=${format}`);
  if (files.disc) args.push('-drive', `file=${files.disc},if=ide,index=2,media=cdrom,format=raw,readonly=on`);
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
