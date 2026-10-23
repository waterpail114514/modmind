// build-tint-requests.mjs — 从已捕获的几何里统计每个方块实际出现的 tintIndex，
// 写成探针的待解析清单（.modmind/probe/tint-requests.json）。
//
// 为什么这样做：tintIndex 是几何的属性，已捕获的 registry.json 里就有。
// 探针固定遍历 0-3 会漏掉高值（framedblocks 用 1024），而盲目把上界调大则代价爆炸
// （9374 个方块 × 1025 次调用）。按实际出现值采样既覆盖全，又不浪费。
//
// 用法： node build-tint-requests.mjs <registry.json> <输出 tint-requests.json>

import fs from 'node:fs';

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) { console.error('用法: node build-tint-requests.mjs <registry.json> <tint-requests.json>'); process.exit(2); }

const j = JSON.parse(fs.readFileSync(src, 'utf8'));
const requests = {};
const valueHist = new Map();
let pairs = 0;

for (const b of j.blocks ?? []) {
  const set = new Set();
  for (const s of b.render?.states ?? []) {
    for (const q of s.quads ?? []) {
      const t = q.tintIndex;
      if (typeof t === 'number' && t >= 0) set.add(t);
    }
  }
  if (set.size === 0) continue;
  const list = [...set].sort((a, b2) => a - b2);
  requests[b.id] = list;
  pairs += list.length;
  for (const t of list) valueHist.set(t, (valueHist.get(t) ?? 0) + 1);
}

fs.writeFileSync(out, JSON.stringify(requests), 'utf8');

const byNs = {};
for (const id of Object.keys(requests)) {
  const ns = id.split(':')[0];
  byNs[ns] = (byNs[ns] ?? 0) + 1;
}

console.log(`输入     : ${src}`);
console.log(`输出     : ${out}`);
console.log(`方块数   : ${Object.keys(requests).length}`);
console.log(`(方块,tintIndex) 组合数: ${pairs}`);
console.log('tintIndex 实际取值分布:');
for (const [t, n] of [...valueHist.entries()].sort((a, b) => a[0] - b[0])) console.log(`  ${String(t).padStart(6)}  ${n}`);
console.log('按命名空间:');
for (const [ns, n] of Object.entries(byNs).sort((a, b) => b[1] - a[1])) console.log(`  ${ns.padEnd(22)} ${n}`);
const framed = Object.entries(requests).filter(([, v]) => v.includes(1024));
console.log(`含 tintIndex=1024 的方块数: ${framed.length}`);
if (framed.length) console.log('  例: ' + framed.slice(0, 3).map(([k, v]) => `${k} -> [${v.join(',')}]`).join(' | '));
