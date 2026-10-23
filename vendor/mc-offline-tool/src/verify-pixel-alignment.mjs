// verify-pixel-alignment.mjs —— 像素对齐回归检查
//
// 起因：用户反馈「图标像素不够，不清晰」。根因是画布后备缓冲开成了 CSS 像素，
// 在 125% 缩放的屏幕上（dpr=1.25）浏览器又把整块画布放大了 1.25 倍，
// 于是 48 设备像素的图标被拉到 60，每个纹素从 3 像素变成 3.75，切出 1/2/4/5 像素交替的块。
//
// 判据：图标区域内「水平同色连长」必须全部是 K 的整数倍（K = 每单位设备像素）。
// 只要出现不是 K 的倍数的连长，就说明纹素没有落在整数像素边界上。
//
// 用法：node verify-pixel-alignment.mjs [--snap <png>] [--x <px>] [--y <px>] [--size 48] [--k 3]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from './png.mjs';

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

let snap = args.snap;
if (!snap) {
  // 注意用 fileURLToPath：import.meta.url 在含中文/空格的路径上会被百分号编码，
  // 手动截字符串会得到 E:\AI%E5%B7%A5... 这种不存在的路径。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '..', '.work', 'snap');
  if (!fs.existsSync(dir)) {
    console.error('没有 --snap，且找不到 ' + dir + '（先打开 app 并带 ?snap=1）');
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  snap = path.join(dir, files[files.length - 1]);
}

const im = decode(fs.readFileSync(snap));
const K = Number(args.k || 3);
const ox = Number(args.x || 0), oy = Number(args.y || 0);
const size = Number(args.size || 48);

const px = (x, y) => { const o = (y * im.width + x) * 4; return im.data[o] + ',' + im.data[o + 1] + ',' + im.data[o + 2]; };
const runs = new Map();
for (let y = oy; y < oy + size; y++) {
  let run = 1;
  for (let x = ox + 1; x <= ox + size; x++) {
    const same = x < ox + size && px(x, y) === px(x - 1, y);
    if (same) run++; else { runs.set(run, (runs.get(run) || 0) + 1); run = 1; }
  }
}
const total = [...runs.values()].reduce((a, b) => a + b, 0);
const order = [...runs.entries()].sort((a, b) => a[0] - b[0]);
const bad = order.filter(([l]) => l % K !== 0).reduce((a, [, n]) => a + n, 0);
const badPct = 100 * bad / total;

console.log('快照   ' + snap);
console.log('画布   ' + im.width + 'x' + im.height + '   分析区 (' + ox + ',' + oy + ') ' + size + 'x' + size + '   期望倍数 K=' + K);
console.log('连长分布  ' + order.map(([l, n]) => l + 'px:' + (100 * n / total).toFixed(0) + '%').join('  '));
console.log('非 ' + K + ' 倍数连长占比 = ' + badPct.toFixed(1) + '%');
if (badPct === 0) console.log('判定  通过：纹素全部落在整数像素边界上');
else console.log('判定  失败：存在非整数像素块，画面会发虚');
process.exit(badPct === 0 ? 0 : 1);
