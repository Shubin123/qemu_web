// Creates an empty qcow2 (version 3) disk image in memory.
//
// Layout with 64 KiB clusters: cluster 0 header, 1 refcount table,
// 2 refcount block (16-bit refcounts), 3 L1 table. Every L1 entry is zero,
// so the whole virtual disk reads as zeros until written.

export function createQcow2(virtualSize = 8 * 1024 ** 3, {backingFile, backingFormat = 'raw'} = {}) {
  if (!Number.isSafeInteger(virtualSize) || virtualSize <= 0) throw new Error('Invalid qcow2 virtual size');
  const clusterBits = 16;
  const cluster = 1 << clusterBits;
  const l2Entries = cluster / 8;
  const l1Size = Math.ceil(virtualSize / (cluster * l2Entries));
  if (l1Size * 8 > cluster) throw new Error('Virtual size too large for a one-cluster L1 table');

  const image = new Uint8Array(cluster * 4);
  const view = new DataView(image.buffer);
  const u32 = (at, v) => view.setUint32(at, v);
  const u64 = (at, v) => view.setBigUint64(at, BigInt(v));

  u32(0, 0x514649fb);              // magic "QFI\xfb"
  u32(4, 3);                       // version
  u64(8, 0);                       // backing file offset
  u32(16, 0);                      // backing file size
  u32(20, clusterBits);
  u64(24, virtualSize);
  u32(32, 0);                      // no encryption
  u32(36, l1Size);
  u64(40, cluster * 3);            // L1 table offset
  u64(48, cluster * 1);            // refcount table offset
  u32(56, 1);                      // refcount table clusters
  u32(60, 0);                      // snapshots
  u64(64, 0);                      // snapshots offset
  u64(72, 0);                      // incompatible features
  u64(80, 0);                      // compatible features
  u64(88, 0);                      // autoclear features
  u32(96, 4);                      // refcount order: 16-bit
  u32(100, 104);                   // header length
  if (backingFile) {
    if (!['raw', 'qcow2'].includes(backingFormat)) throw new Error('Invalid backing format');
    const name = new TextEncoder().encode(backingFile);
    if (name.length > cluster - 512) throw new Error('Backing path too long');
    u64(8, 512); u32(16, name.length); image.set(name, 512);
    const format = new TextEncoder().encode(backingFormat);
    u32(104, 0xe2792aca); u32(108, format.length); image.set(format, 112);
    // Extension terminator follows the 8-byte-aligned format payload.
  }
  // Unused bytes include the header extension list terminator.

  u64(cluster, cluster * 2);       // refcount table[0] -> refcount block
  for (let i = 0; i < 4; i++) view.setUint16(cluster * 2 + i * 2, 1); // clusters 0-3 in use
  return image;
}
