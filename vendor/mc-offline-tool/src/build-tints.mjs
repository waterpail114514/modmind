// build-tints.mjs — 把探针 v0.3/v0.4 的 report.json 转成查看器消费的染色数据。
//
// 三处关键决定：
//
// 1. **图标染色以 iconArgb 为准，不用 worldArgb。** 游戏给方块物品画物品栏图标时走的是
//    ItemColors（见 ItemColors.m_92685_ 的字节码：它以 null level 与 null pos 调 BlockColors）。
//    ItemColors 只对它注册过的方块物品上色，因此拿 BlockColors 的结果去染图标会**多染**。
//    实测多染 146 条（gtceu 138、minecraft 7、ae2 1）。
//
// 2. **alpha 字节不可信，只保留 6 位 RGB。** 探针返回 ARGB，草方块是 FF7CBD6B、橡树叶是 0048B518，
//    同一来源内部都不一致。游戏渲染时忽略该 alpha 只取 RGB。
//
// 3. **世界侧的「取不到」不能一律当成「不上色」。** 图标侧 -1 等价于「未注册 ItemColor」，
//    而 ItemColors 是图标路径的唯一入口，所以图标侧可以判「不上色」。但世界侧 -1 只说明
//    「没走 BlockColors 这条路径」——GT 走的是自绘渲染器（OreBlockRenderer / MaterialBlockRenderer），
//    对它而言「未注册 BlockColor」**不构成「游戏不上色」的证据**。因此世界侧未解析的条目单独
//    输出成 tints-unknown.json，标记为 source=unknown，与「已证不上色」分开，不得合并。
//    （该口径由 A001 §6.3 提出，我接受。）
//
// 用法： node build-tints.mjs <report.json> <tints.json> [tints-world.json] [tints-unknown.json]

import fs from 'node:fs';

const src = process.argv[2];
const outIcon = process.argv[3];
const outWorld = process.argv[4];
const outUnknown = process.argv[5];
if (!src || !outIcon) { console.error('用法: node build-tints.mjs <report.json> <tints.json> [tints-world.json] [tints-unknown.json]'); process.exit(2); }

const report = JSON.parse(fs.readFileSync(src, 'utf8'));
const samples = report.samples ?? [];

const asRgb = (v) => {
  if (typeof v !== 'number' || v === -1 || v === 0xFFFFFFFF) return null;
  return (v >>> 0).toString(16).padStart(8, '0').slice(2).toUpperCase();
};

const icon = {};
const world = {};
const unknown = {};
let iconPairs = 0, worldPairs = 0, unknownPairs = 0;
const overTint = [];

for (const s of samples) {
  const id = s.id, t = String(s.tintIndex);
  const ic = asRgb(s.iconArgb);
  const wd = asRgb(s.worldArgb);
  const mt = asRgb(s.materialArgb);
  if (ic) { (icon[id] ??= {})[t] = ic; iconPairs++; }
  else if (wd) { if (overTint.length < 12) overTint.push(`${id} t=${t} world=${wd}`); }
  if (wd) { (world[id] ??= {})[t] = wd; worldPairs++; }
  else if (!mt) { (unknown[id] ??= []).push(s.tintIndex); unknownPairs++; }
}

fs.writeFileSync(outIcon, JSON.stringify(icon), 'utf8');
if (outWorld) fs.writeFileSync(outWorld, JSON.stringify(world), 'utf8');
if (outUnknown) fs.writeFileSync(outUnknown, JSON.stringify(unknown), 'utf8');

const byNs = (o) => { const m = {}; for (const id of Object.keys(o)) { const ns = id.split(':')[0]; m[ns] = (m[ns] ?? 0) + 1; } return m; };
const fmt = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k.padEnd(22)} ${v}`).join('\n');

console.log(`输入        : ${src}`);
console.log(`探针版本    : ${report.version}   用清单: ${report.requestFileUsed}   ItemColors 可用: ${report.itemColorsAvailable}`);
console.log(`探针条目    : ${report.pairs}    timedOut: ${report.timedOut}    elapsedMs: ${report.elapsedMs}    counts: ${JSON.stringify(report.counts)}`);
console.log(`\n图标染色（以 ItemColors 为准，查看器用这份）`);
console.log(`  组合 ${iconPairs}   覆盖方块 ${Object.keys(icon).length}`);
console.log(fmt(byNs(icon)));
console.log(`\n世界染色（另存，供后期三维视图）`);
console.log(`  组合 ${worldPairs}   覆盖方块 ${Object.keys(world).length}`);
console.log(`\n世界侧来源未查明（source=unknown，禁止当成「不上色」）`);
console.log(`  组合 ${unknownPairs}   覆盖方块 ${Object.keys(unknown).length}`);
console.log(fmt(byNs(unknown)));
console.log(`\n按 BlockColors 染图标会多染的条目: ${samples.filter((s) => !asRgb(s.iconArgb) && asRgb(s.worldArgb)).length}`);
for (const s of overTint) console.log(`    ${s}`);
console.log(`\n输出: ${[outIcon, outWorld, outUnknown].filter(Boolean).join('  ')}`);
