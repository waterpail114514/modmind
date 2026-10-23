// serve-app.mjs —— 极简静态服务器，只为让浏览器能加载字体文件
//
// 为什么需要它：@font-face 加载的是「CORS 模式的请求」，而 file:// 页面的源是 null，
// 浏览器会以 CORS 拒绝加载本地字体（图标的 <img> 不受影响）。所以要么把字体 base64 内联
// （源汉黑体 8.3 MB → 内联后 11 MB），要么起一个本机 http 服务。选后者：零内联、零依赖、
// 且离线（只绑 127.0.0.1）。
//
// 用法：node serve-app.mjs [--root <目录>] [--port 8787] [--open] [--path /app/index.html]
//
// 默认 root 是工具根目录（不是 app/）：因为 3D 预览（app3d/）与物品栏（app/）并列，
// 而且 3D 预览要复用 src/ 下的模块。两个页面各自用相对路径取自己的数据，互不影响。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || path.join(import.meta.dirname, '..'));
const port = Number(args.port || 8787);
const openPath = args.path || '/app/index.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

// 自测通道：页面可以把 canvas 的 PNG POST 到 /snap，由这里落盘。
// 为什么需要它：本机没有 playwright，而靠「切窗口 + 整屏截图」既不稳定、又是缩放后的近似。
// 页面自报真实画布像素，既准确又不需要抢焦点。
const snapDir = process.env.MODMIND_SNAP_DIR || path.join(root, '.work', 'snap');

// 可选：功能包 API（`--api <module>`）。模块需导出 createPreviewApi({root}) → { handle(req,res,url) }。
// 不带 --api 时行为与以前完全一致（本文件其余逻辑一行未改）。
let api = null;
if (typeof args.api === 'string') {
  try {
    const mod = await import(pathToFileURL(path.resolve(args.api)).href);
    if (typeof mod.createPreviewApi === 'function') {
      api = mod.createPreviewApi({ root });
      console.log('api = ' + path.resolve(args.api));
    } else {
      console.error('[api] 模块没有导出 createPreviewApi，已忽略');
    }
  } catch (error) {
    console.error('[api] 载入失败: ' + (error && error.message));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/snap')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      fs.mkdirSync(snapDir, { recursive: true });
      const name = 'snap-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      fs.writeFileSync(path.join(snapDir, name), body);
      console.log('[snap] ' + name + '  ' + body.length + ' bytes  -> ' + snapDir);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, bytes: body.length }));
    });
    return;
  }

  // 功能包 API（可选，见上）
  if (api && req.url.startsWith('/api/')) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (api.handle(req, res, url)) return;
  }

  let rel = decodeURIComponent(req.url.split('?')[0]);
  // 根路径直接跳到默认页面：换了 root 之后旧习惯的书签（http://127.0.0.1:8787/）不该 404
  if (rel === '/' || rel === '') {
    res.writeHead(302, { location: openPath }).end();
    return;
  }
  // 目录要以 index.html 结尾，否则 /app3d/ 这种写法会 404
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, path.normalize(rel).replace(/^[\\/]+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}${openPath}`;
  console.log('root = ' + root);
  console.log('snap dir = ' + snapDir);
  console.log('serving ' + url);
  if (args.open) {
    // Windows 下用 start 打开默认浏览器；失败也不影响服务本身
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
  console.log('按 Ctrl+C 结束');
});
