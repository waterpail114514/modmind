// extract-gui-assets.mjs —— 取出原版 GUI 贴图与字体（本机离线，两个来源合并）
//
// 为什么需要两个来源：本机把原版资源分成了两处。
//   A) Forge 的 client-extra.jar：装着 textures/gui/**、textures/font/**、font/default.json
//   B) assets/indexes/5.json + assets/objects/**：装着 font/unifont.zip（以及被裁剪过的其它对象）
//   单独任何一个都取不全，所以两边都查，先 jar 后索引。
//
// 注意路径：1.20.1 的字体贴图在 textures/font/ 下（不是 font/），例如 textures/font/ascii.png。
//
// 用法：
//   node extract-gui-assets.mjs --jar <extra.jar> [--assets <assets根> --index 5] --out <app/data> [--list]

import fs from 'node:fs';
import path from 'node:path';
import { listEntries, readEntry } from './zipread.mjs';

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
const jar = path.resolve(args.jar || '');
const outDir = path.resolve(args.out || 'app/data');
const assetsRoot = args.assets ? path.resolve(args.assets) : null;
const indexId = args.index || '5';

const buf = fs.readFileSync(jar);

if (args.list) {
  for (const e of listEntries(buf)) {
    const n = e.name.replace(/\\/g, '/');
    if (n.includes('/textures/gui/') || n.includes('/font/') || n.includes('/textures/font/')) console.log('jar ' + n);
  }
  if (assetsRoot) {
    const idx = JSON.parse(fs.readFileSync(path.join(assetsRoot, 'indexes', `${indexId}.json`), 'utf8'));
    for (const k of Object.keys(idx.objects).sort()) {
      if (k.includes('/textures/gui/') || k.includes('/font/')) console.log('idx ' + k);
    }
  }
  process.exit(0);
}

let indexObjects = null;
if (assetsRoot) {
  const p = path.join(assetsRoot, 'indexes', `${indexId}.json`);
  if (fs.existsSync(p)) indexObjects = JSON.parse(fs.readFileSync(p, 'utf8')).objects || {};
}

/** 先在 jar 里找；找不到再走 assets 索引（objects/<hash 前2位>/<hash>） */
function fetchEntry(logical) {
  const fromJar = readEntry(buf, logical);
  if (fromJar) return { data: fromJar, from: 'jar' };
  if (indexObjects) {
    // 注意：assets/indexes/*.json 的键**不带** "assets/" 前缀，例如 minecraft/font/unifont.zip
    const bare = logical.replace(/^assets\//, '');
    const rec = indexObjects[logical] || indexObjects[bare];
    if (rec) {
      const h = rec.hash;
      const f = path.join(assetsRoot, 'objects', h.slice(0, 2), h);
      if (fs.existsSync(f)) return { data: fs.readFileSync(f), from: 'assets' };
    }
  }
  return null;
}

/** 逻辑名（jar 内路径） -> 输出相对 outDir 的路径 */
const WANTED = {
  'assets/minecraft/textures/gui/container/inventory.png': 'gui/container/inventory.png',
  'assets/minecraft/textures/gui/widgets.png': 'gui/widgets.png',
  'assets/minecraft/textures/gui/icons.png': 'gui/icons.png',
  'assets/minecraft/textures/gui/options_background.png': 'gui/options_background.png',
  'assets/minecraft/font/default.json': 'font/default.json',
  'assets/minecraft/font/include/default.json': 'font/include/default.json',
  'assets/minecraft/font/include/space.json': 'font/include/space.json',
  'assets/minecraft/font/include/unifont.json': 'font/include/unifont.json',
  'assets/minecraft/font/unifont.zip': 'font/unifont.zip',
  'assets/minecraft/textures/font/ascii.png': 'font/ascii.png',
  'assets/minecraft/textures/font/accented.png': 'font/accented.png',
  'assets/minecraft/textures/font/nonlatin_european.png': 'font/nonlatin_european.png',
};

const found = [];
const missing = [];
for (const [logical, rel] of Object.entries(WANTED)) {
  const got = fetchEntry(logical);
  if (!got) { missing.push(logical); continue; }
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, got.data);
  found.push({ logical, rel, from: got.from, bytes: got.data.length });
}

console.log(JSON.stringify({ jar, outDir, copied: found.length, found, missing }, null, 2));
