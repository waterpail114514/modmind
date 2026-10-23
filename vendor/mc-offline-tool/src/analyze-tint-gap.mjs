// 量化染色缺口：把"哪些方块的染色缺失"精确到命名空间与类别，
// 并与探针已能供给的颜色（tints.json）做交集。只读。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'e:/AI工作台/mc-offline-tool/.work/probe-01';
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, '.modmind/voxel-capture/registry.json'), 'utf8'));
const tints = JSON.parse(fs.readFileSync('e:/AI工作台/mc-offline-tool/.work/viewer/tints.json'), 'utf8');

const blocks = reg.blocks || [];
const nsStat = new Map();

for (const b of blocks) {
  const id = String(b.id ?? b.block ?? '');
  const ns = id.includes(':') ? id.slice(0, id.indexOf(':')) : '(无)';
  let hasTint = false, tintIdx = new Set();
  for (const s of (b?.render?.states || [])) {
    for (const q of (s.quads || [])) {
      const t = q.tintIndex;
      if (t !== undefined && t !== null && t >= 0) { hasTint = true; tintIdx.add(t); }
    }
  }
  if (!nsStat.has(ns)) nsStat.set(ns, { total: 0, tinted: 0, ore: 0, oreTinted: 0, idx: new Set() });
  const e = nsStat.get(ns);
  e.total++;
  const isOre = /ore|raw_|.*_ore$/.test(id.split(':')[1] ?? '');
  if (isOre) e.ore++;
  if (hasTint) {
    e.tinted++;
    if (isOre) e.oreTinted++;
    for (const i of tintIdx) e.idx.add(i);
  }
}

console.log('=== 按命名空间：方块总数 / 需染色的方块数 / 其中矿石 ===');
const rows = [...nsStat.entries()].sort((a, b) => b[1].tinted - a[1].tinted);
for (const [ns, e] of rows.slice(0, 14)) {
  console.log('  ' + ns.padEnd(22),
    String(e.total).padStart(6),
    '需染色', String(e.tinted).padStart(5),
    '| 矿石', String(e.ore).padStart(5),
    '矿石需染色', String(e.oreTinted).padStart(5),
    '| tintIndex 取值', [...e.idx].sort((a, b) => a - b).join(',').slice(0, 30));
}

const tot = { total: 0, tinted: 0, ore: 0, oreTinted: 0 };
for (const [, e] of nsStat) {
  tot.total += e.total; tot.tinted += e.tinted; tot.ore += e.ore; tot.oreTinted += e.oreTinted;
}
console.log('\n=== 全局 ===');
console.log('  方块总数        :', tot.total);
console.log('  需染色的方块数  :', tot.tinted, `(${((tot.tinted / tot.total) * 100).toFixed(2)}%)`);
console.log('  矿石类方块      :', tot.ore, ' 其中需染色:', tot.oreTinted);

// 探针能供给多少
const covered = new Set(Object.keys(tints));
console.log('\n=== 供给 vs 需求 ===');
console.log('  探针 tints.json 覆盖方块数:', covered.size);
let hit = 0, missByNs = new Map();
for (const b of blocks) {
  const id = String(b.id ?? b.block ?? '');
  let hasTint = false;
  for (const s of (b?.render?.states || []))
    for (const q of (s.quads || [])) {
      const t = q.tintIndex;
      if (t !== undefined && t !== null && t >= 0) { hasTint = true; break; }
    }
  if (!hasTint) continue;
  if (covered.has(id)) hit++;
  else {
    const ns = id.includes(':') ? id.slice(0, id.indexOf(':')) : '(无)';
    missByNs.set(ns, (missByNs.get(ns) || 0) + 1);
  }
}
console.log('  需染色的方块中，能拿到颜色的:', hit);
console.log('  拿不到的（按命名空间前 10）:');
[...missByNs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([k, v]) => console.log('    ' + k.padEnd(22), v));
console.log('  缺口合计:', [...missByNs.values()].reduce((a, b) => a + b, 0));

// alpha 语义核查
console.log('\n=== 探针颜色的 alpha 字节分布（验证 alpha 不可信）===');
const rpt = JSON.parse(fs.readFileSync(path.join(ROOT, '.modmind/probe/report.json'), 'utf8'));
const alphaStat = new Map();
for (const s of (rpt.samples || [])) {
  const a = (s.argb ?? s.color ?? 0) >>> 24;
  alphaStat.set(a, (alphaStat.get(a) || 0) + 1);
}
console.log('  样本数:', (rpt.samples || []).length);
[...alphaStat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([k, v]) => console.log('    alpha=' + k.toString(16).padStart(2, '0'), 'x' + v));
console.log('  tints.json 是否保留 alpha:', Object.values(tints)[0] &&
  /^[0-9A-Fa-f]{6}$/.test(String(Object.values(tints)[0][Object.keys(Object.values(tints)[0])[0]] || '')) ? '否（6 位 RGB）' : '是');
