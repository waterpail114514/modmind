// serve.mjs — 极简静态文件服务，供查看器读取分片与贴图。
// 查看器用 fetch 读 JSON 与 PNG，file:// 会被浏览器的跨域策略拦下，因此必须走 HTTP。
// 用法： node serve.mjs <根目录> [端口]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8788);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url).split('?')[0]);
  const rel = url === '/' ? '/viewer/index.html' : url;
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 ' + rel); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, () => {
  console.log(`服务已启动： http://localhost:${port}/viewer/index.html`);
  console.log(`根目录： ${root}`);
});
