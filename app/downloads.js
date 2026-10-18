/**
 * Persistent download cache manager using browser Cache API.
 * Ensures downloaded ISOs and BIOS fixtures are saved locally in browser storage
 * and never re-fetched across page reloads.
 */
export const CACHE_NAME = 'qemu-downloads-v1';

async function openCache() {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (_) {
    return null;
  }
}

export async function isCached(url) {
  if (!url) return false;
  const cache = await openCache();
  if (!cache) return false;
  try {
    return Boolean(await cache.match(url));
  } catch (_) {
    return false;
  }
}

export async function getCachedBlob(url) {
  if (!url) return null;
  const cache = await openCache();
  if (!cache) return null;
  try {
    const res = await cache.match(url);
    if (!res) return null;
    return await res.blob();
  } catch (_) {
    return null;
  }
}

export async function putCachedBlob(url, blob, contentType = 'application/octet-stream') {
  if (!url || !blob) return false;
  const cache = await openCache();
  if (!cache) return false;
  try {
    const response = new Response(blob, {
      headers: {
        'content-type': contentType,
        'content-length': String(blob.size),
      },
    });
    await cache.put(url, response);
    return true;
  } catch (_) {
    return false;
  }
}

export async function deleteCached(url) {
  if (!url) return false;
  const cache = await openCache();
  if (!cache) return false;
  try {
    return await cache.delete(url);
  } catch (_) {
    return false;
  }
}

export async function fetchWithCache(url, onProgress) {
  if (!url) throw new Error('Missing URL to fetch');
  // Check cache first
  const existing = await getCachedBlob(url);
  if (existing) {
    if (onProgress) onProgress({ loaded: existing.size, total: existing.size, cached: true });
    return existing;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentLength = Number(response.headers.get('content-length')) || 0;
  let blob;

  if (response.body && typeof response.body.getReader === 'function' && contentLength > 0) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) onProgress({ loaded: received, total: contentLength, cached: false });
    }
    blob = new Blob(chunks, { type: 'application/octet-stream' });
  } else {
    blob = await response.blob();
    if (onProgress) onProgress({ loaded: blob.size, total: blob.size, cached: false });
  }

  // Store into persistent browser Cache API
  await putCachedBlob(url, blob);
  return blob;
}

export async function getCacheSummary() {
  const cache = await openCache();
  if (!cache) return { count: 0, totalBytes: 0, urls: [] };
  try {
    const requests = await cache.keys();
    let totalBytes = 0;
    const urls = [];
    for (const req of requests) {
      urls.push(req.url);
      const res = await cache.match(req);
      if (res) {
        const b = await res.blob();
        totalBytes += b.size;
      }
    }
    return { count: requests.length, totalBytes, urls };
  } catch (_) {
    return { count: 0, totalBytes: 0, urls: [] };
  }
}
