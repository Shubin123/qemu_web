// Cache small reads from immutable WORKERFS files. Each file retains at most
// 1 MiB, avoiding repeated synchronous Blob reads without copying a whole ISO.
export function cacheBlobReads(node, size, {blockSize = 65536, maxBlocks = 16} = {}) {
  const original = node.stream_ops;
  const blocks = new Map();
  node.stream_ops = {...original, read(stream, buffer, offset, length, position) {
    if (length <= 0 || position >= size) return 0;
    // Large transfers already amortize FileReaderSync overhead.
    if (length >= blockSize || position < 0) {
      return original.read(stream, buffer, offset, length, position);
    }
    const count = Math.min(length, size - position);
    let copied = 0;
    while (copied < count) {
      const at = position + copied;
      const start = Math.floor(at / blockSize) * blockSize;
      let block = blocks.get(start);
      if (block) {
        blocks.delete(start);
      } else {
        // A first visit only records the block, without speculative I/O.
        // Scattered reads therefore retain their original transfer sizes.
        if (!blocks.has(start)) {
          if (blocks.size >= maxBlocks) blocks.delete(blocks.keys().next().value);
          blocks.set(start, null);
          return copied + original.read(stream, buffer, offset + copied, count - copied, at);
        }
        blocks.delete(start);
        block = new Uint8Array(Math.min(blockSize, size - start));
        const n = original.read(stream, block, 0, block.length, start);
        // Do not cache short/failed reads or conceal their EOF behavior.
        if (n !== block.length) {
          return copied + original.read(stream, buffer, offset + copied, count - copied, at);
        }
        if (blocks.size >= maxBlocks) blocks.delete(blocks.keys().next().value);
      }
      blocks.set(start, block);
      const n = Math.min(count - copied, block.length - (at - start));
      buffer.set(block.subarray(at - start, at - start + n), offset + copied);
      copied += n;
    }
    return copied;
  }};
}
