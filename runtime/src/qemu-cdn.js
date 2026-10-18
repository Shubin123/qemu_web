// CDN source registry for PC guest operating system media.
// Guest media is fetched on demand from CORS-enabled archives and never committed to git.
export const CDN_SOURCES = Object.freeze({
  seabios: Object.freeze({
    id: 'seabios',
    name: 'SeaBIOS 256K (Default PC BIOS)',
    fileName: 'bios-256k.bin',
    url: 'https://raw.githubusercontent.com/qemu/qemu/master/pc-bios/bios-256k.bin',
    streamUrl: 'https://raw.githubusercontent.com/qemu/qemu/master/pc-bios/bios-256k.bin',
    size: 262144,
    sha256: 'ae6f6aa973aaccc143f57aa960fb035fd9de4daee4ad0cd713322f8c259e7650',
    type: 'bios',
    format: 'bin',
  }),
  vgabios: Object.freeze({
    id: 'vgabios',
    name: 'SeaVGABIOS Standard VGA',
    fileName: 'vgabios-stdvga.bin',
    url: 'https://raw.githubusercontent.com/qemu/qemu/master/pc-bios/vgabios-stdvga.bin',
    streamUrl: 'https://raw.githubusercontent.com/qemu/qemu/master/pc-bios/vgabios-stdvga.bin',
    size: 39424,
    sha256: 'e8fc9e55790dbe3cb31f019a3deb57206ba6c54f5e581adb2ab2677a9d391472',
    type: 'vgabios',
    format: 'bin',
  }),
  templeos: Object.freeze({
    id: 'templeos',
    name: 'TempleOS V5.03',
    fileName: 'TempleOSCDV5.03.ISO',
    url: 'https://archive.org/download/TempleOS_ISO_Archive/TempleOSCDV5.03.ISO',
    streamUrl: 'https://archive.org/cors/TempleOS_ISO_Archive/TempleOSCDV5.03.ISO',
    detailsUrl: 'https://archive.org/details/TempleOS_ISO_Archive',
    size: 17817600,
    sha256: 'a7e2a4d940852b9680fa71ff11faf66daccd5db11741110ae43d54f72a245fdf',
    architecture: 'x86_64',
    format: 'iso',
  }),
});

/**
 * Resolves a CDN source descriptor from a key (id string, url, or descriptor object).
 */
export function resolveCdnSource(key) {
  if (!key) return null;
  if (typeof key === 'object') {
    if (key.streamUrl || key.url) return key;
    if (key.id && CDN_SOURCES[key.id.toLowerCase()]) return CDN_SOURCES[key.id.toLowerCase()];
    return null;
  }
  if (typeof key !== 'string') return null;
  const id = key.toLowerCase().trim();
  if (CDN_SOURCES[id]) return CDN_SOURCES[id];
  for (const source of Object.values(CDN_SOURCES)) {
    if (source.fileName.toLowerCase() === id || source.url.toLowerCase() === id || source.streamUrl.toLowerCase() === id) {
      return source;
    }
  }
  if (/^https?:\/\//i.test(key)) {
    return {
      id: 'custom',
      name: key.split('/').pop() || 'remote.iso',
      fileName: key.split('/').pop() || 'remote.iso',
      url: key,
      streamUrl: key,
      format: 'iso',
    };
  }
  return null;
}
