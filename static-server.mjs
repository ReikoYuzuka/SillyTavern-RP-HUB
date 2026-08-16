// 8002 静态文件服务器：服务构建产物 dist/
// 用法: node static-server.mjs [port] [root]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8002);
const root = path.resolve(process.argv[3] ?? path.join(__dirname, 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

// CORS：允许酒馆（http://127.0.0.1:8000）跨源 import/加载本服务产物
const CORS = { 'Access-Control-Allow-Origin': '*' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    let file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403, CORS).end('Forbidden');
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }
    if (info.isDirectory()) file = path.join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      ...CORS,
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { ...CORS }).end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[static-server] serving ${root} at http://127.0.0.1:${port}`);
});
