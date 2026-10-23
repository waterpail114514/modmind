// serve-compare.mjs — 对照工作台的一键入口。
//
// 做三件事：
//   1. 扫描游戏截图目录（%APPDATA%\.minecraft\screenshots、E:\mc\.minecraft\screenshots、
//      .work\game-shots），把 PNG 归集到 .work\game-shots\，并写出 .work\game-shots.json
//   2. 起静态服务
//   3. 打印要打开的地址
//
// 用法: node src/serve-compare.mjs [端口]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] ?? 8790);
const SHOTS = path.join(ROOT, '.work', 'game-shots');
const LIST = path.join(ROOT, '.work', 'game-shots.json');

const SOURCES = [
  path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft', 'screenshots'),
  path.join('E:', 'mc', '.minecraft', 'screenshots'),
  SHOTS,
];

fs.mkdirSync(SHOTS, { recursive: true });

let copied = 0, seen = 0;
const names = new Set();
for (const dir of SOURCES) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.png$/i.test(f)) continue;
    seen++;
    const src = path.join(dir, f);
    if (src === path.join(SHOTS, f)) { names.add(f); continue; }
    try {
      fs.copyFileSync(src, path.join(SHOTS, f));
      copied++;
      names.add(f);
    } catch (e) {
      console.log(`  跳过 ${f}：${e.message}`);
    }
  }
}
// 也收本地已有但不在来源目录里的
for (const f of fs.readdirSync(SHOTS)) if (/\.png$/i.test(f)) names.add(f);

const files = [...names].sort();
fs.writeFileSync(LIST, JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2), 'utf-8');

console.log(`游戏截图目录扫描：找到 ${seen} 张，新归集 ${copied} 张，可用 ${files.length} 张`);
for (const d of SOURCES) console.log(`  ${fs.existsSync(d) ? '有' : '无'}  ${d}`);
if (!files.length) {
  console.log('\n还没有截图。请在游戏里按 F2 截图（会存到 .minecraft\\screenshots\\），再重跑本命令。');
  console.log('也可以把任意 PNG 直接丢进 ' + SHOTS + ' 再重跑。');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url).split('?')[0]);
  const rel = url === '/' ? '/viewer/compare.html' : url;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 ' + rel); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}/viewer/compare.html`;
  console.log(`\n对照工作台已就绪： ${url}`);
  console.log(`物品栏查看器：     http://127.0.0.1:${PORT}/viewer/inventory.html`);
  console.log('（关掉这个窗口即结束）');
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});
