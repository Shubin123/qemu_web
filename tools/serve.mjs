// Static server with the cross-origin isolation headers SharedArrayBuffer
// (and therefore wasm threads) requires.
//   node tools/serve.mjs [--root=dir] [--port=8080] [--open]
import {createServer} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, normalize, resolve} from 'node:path';
import {execFile} from 'node:child_process';
const paths = {project: resolve('web')};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

export function serve({root = paths.project, port = 8080, host = '127.0.0.1', quiet = false} = {}) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(base, path);
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      if (process.env.XEMU_SERVE_LOG) console.error('[serve] 404', req.url);
      res.writeHead(404).end('Not found');
      return;
    }
    const size = statSync(file).size;
    const headers = {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1});
      createReadStream(file, {start, end}).pipe(res);
      return;
    }
    res.writeHead(200, {...headers, 'Content-Length': size});
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(port, host, () => {
    const address = `http://${host}:${server.address().port}/`;
    if (!quiet) console.log(`Serving ${base} at ${address}`);
    ok({server, url: address});
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
  const {url} = await serve({root: args.root || paths.project, port: Number(args.port || 8080)});
  if ('open' in args) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
