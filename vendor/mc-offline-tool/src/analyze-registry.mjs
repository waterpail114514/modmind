// analyze-registry.mjs — 解析采集器产出的 registry.json，输出规模与结构统计
//
// 用途：把「规模未知」变成已知数字。图标与几何的时长估算、分片策略、
// 体积口径都依赖这里的统计结果。
//
// 用法： node --max-old-space-size=8192 analyze-registry.mjs <registry.json>

import fs from 'node:fs';

const p = process.argv[2];
if (!p) { console.error('用法: node analyze-registry.mjs <registry.json>'); process.exit(2); }

const t0 = Date.now();
const buf = fs.readFileSync(p);
const tRead = Date.now() - t0;
console.log(`文件字节数        : ${buf.length}`);
console.log(`读取耗时          : ${tRead} ms`);
console.log(`首 80 字符        : ${buf.toString('utf8', 0, 80)}`);
console.log(`尾 120 字符       : ${buf.toString('utf8', buf.length - 120)}`);

let j;
const t1 = Date.now();
try {
  j = JSON.parse(buf.toString('utf8'));
} catch (e) {
  console.error(`JSON 解析失败: ${e.message}`);
  process.exit(1);
}
console.log(`JSON.parse 耗时   : ${Date.now() - t1} ms`);
console.log(`堆已用            : ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);

console.log('\n=== 顶层键 ===');
for (const k of Object.keys(j)) {
  const v = j[k];
  const desc = Array.isArray(v) ? `array[${v.length}]` : (v && typeof v === 'object' ? `object{${Object.keys(v).join(',')}}` : String(v));
  console.log(`  ${k}: ${desc}`);
}

console.log('\n=== 元信息 ===');
for (const k of ['schemaVersion', 'requestId', 'minecraftVersion', 'dataVersion', 'capturedAt', 'complete', 'worldLoaded']) {
  console.log(`  ${k}: ${JSON.stringify(j[k])}`);
}
if (j.loader) console.log(`  loader: ${JSON.stringify(j.loader)}`);

const blocks = j.blocks ?? [];
console.log(`\n=== 方块统计 ===`);
console.log(`  方块条目数      : ${blocks.length}`);

let declaredStates = 0, presentStates = 0, quads = 0;
let beCount = 0, rootTruncated = 0, stateTruncated = 0;
const kindHist = new Map(), qualityHist = new Map(), noteHist = new Map();
const layerHist = new Map(), nsHist = new Map();
let tinted = 0, shaded = 0, culled = 0, noQuadsBlocks = 0;
const sprites = new Set();
let maxStatesOfOne = 0, maxStatesBlock = '';

for (const b of blocks) {
  const ns = String(b.id ?? '').split(':')[0] || '(无命名空间)';
  nsHist.set(ns, (nsHist.get(ns) ?? 0) + 1);
  declaredStates += b.stateCount ?? 0;
  if (b.hasBlockEntity) beCount++;
  const r = b.render ?? {};
  if (r.truncated) rootTruncated++;
  qualityHist.set(r.quality ?? '(无)', (qualityHist.get(r.quality ?? '(无)') ?? 0) + 1);
  kindHist.set('render.' + (r.kind ?? '(无)'), (kindHist.get('render.' + (r.kind ?? '(无)')) ?? 0) + 1);
  for (const n of r.notes ?? []) noteHist.set(n, (noteHist.get(n) ?? 0) + 1);

  const st = r.states ?? [];
  presentStates += st.length;
  if ((b.stateCount ?? 0) > maxStatesOfOne) { maxStatesOfOne = b.stateCount ?? 0; maxStatesBlock = b.id; }
  let thisBlockQuads = 0;
  for (const s of st) {
    if (s.truncated) stateTruncated++;
    kindHist.set('state.' + (s.kind ?? '(无)'), (kindHist.get('state.' + (s.kind ?? '(无)')) ?? 0) + 1);
    for (const q of s.quads ?? []) {
      quads++; thisBlockQuads++;
      if (q.sprite) sprites.add(q.sprite);
      if ((q.tintIndex ?? -1) >= 0) tinted++;
      if (q.shade) shaded++;
      if (q.cullFace) culled++;
      layerHist.set(q.layer ?? '(无)', (layerHist.get(q.layer ?? '(无)') ?? 0) + 1);
    }
  }
  if (thisBlockQuads === 0) noQuadsBlocks++;
}

console.log(`  声明状态总数    : ${declaredStates}`);
console.log(`  实采状态条目数  : ${presentStates}`);
console.log(`  quad 总数       : ${quads}`);
console.log(`  去重 sprite 数  : ${sprites.size}`);
console.log(`  方块实体方块数  : ${beCount}`);
console.log(`  状态数最多的方块: ${maxStatesBlock} (${maxStatesOfOne})`);
console.log(`  渲染结果被截断  : ${rootTruncated} 个方块`);
console.log(`  状态被截断      : ${stateTruncated} 个状态`);
console.log(`  零 quad 的方块  : ${noQuadsBlocks}`);
console.log(`  带染色 quad     : ${tinted}  (${(tinted / Math.max(1, quads) * 100).toFixed(2)}%)`);
console.log(`  shade=true      : ${shaded}`);
console.log(`  有 cullFace     : ${culled}`);

function hist(title, map, limit = 22) {
  console.log(`\n=== ${title} ===`);
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of arr.slice(0, limit)) console.log(`  ${String(k).padEnd(46)} ${v}`);
  if (arr.length > limit) console.log(`  ... 其余 ${arr.length - limit} 项省略`);
}
hist('命名空间分布（按方块数）', nsHist, 30);
hist('render.quality', qualityHist);
hist('kind', kindHist);
hist('layer', layerHist);
hist('notes', noteHist);

// sprite 命名空间，用于判断贴图覆盖了哪些 mod
const spriteNs = new Map();
for (const s of sprites) {
  const ns = String(s).split(':')[0] || '(无)';
  spriteNs.set(ns, (spriteNs.get(ns) ?? 0) + 1);
}
hist('sprite 命名空间分布（按去重 sprite 数）', spriteNs, 30);

console.log(`\n=== 体积口径 ===`);
console.log(`  registry.json   : ${(buf.length / 1048576).toFixed(2)} MB`);
console.log(`  每方块平均 quad : ${(quads / Math.max(1, blocks.length)).toFixed(1)}`);
console.log(`  每状态平均 quad : ${(quads / Math.max(1, presentStates)).toFixed(1)}`);
console.log(`  总耗时          : ${Date.now() - t0} ms`);
console.log(`  堆峰值估计      : ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
