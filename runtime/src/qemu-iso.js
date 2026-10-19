// Read ISO9660 files lazily from a Blob; never copy a complete OS image to RAM.
const sector = 2048;
const nameKey = name => name.toUpperCase().replace(/;\d+$/, '').replace(/\.$/, '').replaceAll('-', '_');
export async function readIsoFile(iso, path) {
  const read = async (offset, size) => {
    if (offset < 0 || size < 0 || offset + size > iso.size) throw new Error('ISO extent is outside the image');
    return new Uint8Array(await iso.slice(offset, offset + size).arrayBuffer());
  };
  const pvd = await read(16 * sector, sector);
  if (pvd[0] !== 1 || new TextDecoder().decode(pvd.subarray(1, 6)) !== 'CD001') throw new Error('Expected an ISO9660 image');
  const extent = record => {
    const v = new DataView(record.buffer, record.byteOffset, record.byteLength);
    return {offset: v.getUint32(2, true) * sector, size: v.getUint32(10, true), directory: !!(record[25] & 2)};
  };
  let entry = extent(pvd.subarray(156, 190));
  for (const part of path.split('/').filter(Boolean)) {
    if (!entry.directory || entry.size > 16 * 1024 * 1024) throw new Error(`Invalid ISO directory for ${path}`);
    const data = await read(entry.offset, entry.size);
    let found;
    for (let at = 0; at < data.length;) {
      const length = data[at];
      if (!length) { at = (Math.floor(at / sector) + 1) * sector; continue; }
      if (length < 34 || at + length > data.length || data[at + 32] > length - 33) throw new Error('Invalid ISO directory record');
      const record = data.subarray(at, at + length);
      const name = new TextDecoder().decode(record.subarray(33, 33 + record[32]));
      if (nameKey(name) === nameKey(part)) { found = extent(record); break; }
      at += length;
    }
    if (!found) throw new Error(`ISO file not found: ${path}`);
    entry = found;
  }
  if (entry.directory) throw new Error(`Expected an ISO file: ${path}`);
  if (entry.offset + entry.size > iso.size) throw new Error('ISO extent is outside the image');
  return iso.slice(entry.offset, entry.offset + entry.size);
}
