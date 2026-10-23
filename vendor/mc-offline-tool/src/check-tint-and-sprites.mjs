// check-tint-and-sprites.mjs — 判定染色是否已烘进顶点色，并盘点 sprite 与贴图的构成
//
// 为什么关键：
//   1. 若顶点色里没有染色，草方块、树叶、水这类会渲染成灰度，正是「贴图不正常」的典型表现。
//   2. 若 sprite 里没有 item/ 前缀，说明平面物品图标完全没被采集，物品栏必然大片空白。

import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// --- 1. 染色是否烘进顶点色 ---
const colorSig = (q) => q.vertices.map((v) => v.color.map((c) => c.toFixed(3)).join(',')).join(' | ');
const tinted = new Map();
const untinted = new Map();
for (const b of j.blocks ?? []) {
  for (const s of b.render?.states ?? []) {
    for (const q of s.quads ?? []) {
      const m = (q.tintIndex ?? -1) >= 0 ? tinted : untinted;
      const sig = colorSig(q);
      if (!m.has(sig)) m.set(sig, { n: 0, sample: null });
      const e = m.get(sig); e.n++;
      if (!e.sample) e.sample = { block: b.id, sprite: q.sprite, tintIndex: q.tintIndex, face: q.face };
    }
  }
}
console.log('=== 带染色 quad 的顶点色组合（前 10 种） ===');
for (const [sig, e] of [...tinted.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
  console.log(`  x${String(e.n).padEnd(7)} ${sig}`);
  console.log(`            ${JSON.stringify(e.sample)}`);
}
console.log(`  带染色顶点色组合数: ${tinted.size}`);
console.log('\n=== 不带染色 quad 的顶点色组合（前 5 种） ===');
for (const [sig, e] of [...untinted.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
  console.log(`  x${String(e.n).padEnd(7)} ${sig}`);
}

// --- 2. sprite 构成 ---
const sprites = new Set();
for (const b of j.blocks ?? []) for (const s of b.render?.states ?? []) for (const q of s.quads ?? []) if (q.sprite) sprites.add(q.sprite);
const bucket = new Map();
for (const sp of sprites) {
  const afterNs = String(sp).split(':')[1] ?? '';
  const head = afterNs.split('/')[0] || '(无斜杠)';
  bucket.set(head, (bucket.get(head) ?? 0) + 1);
}
console.log('\n=== sprite 路径首段分布 ===');
for (const [k, v] of [...bucket.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`  item/ 开头的 sprite 数: ${[...sprites].filter((s) => s.includes(':item/')).length}`);
console.log(`  particle/ 开头的: ${[...sprites].filter((s) => s.includes(':particle/')).length}`);
console.log(`  entity/ 开头的: ${[...sprites].filter((s) => s.includes(':entity/')).length}`);

// --- 3. textures 条目统计 ---
const tex = j.textures ?? [];
console.log(`\n=== textures 条目 ===`);
console.log(`  条数: ${tex.length}`);
const animated = tex.filter((t) => t.animated);
console.log(`  animated=true: ${animated.length}`);
const sizes = new Map();
for (const t of tex) sizes.set(`${t.width}x${t.height}`, (sizes.get(`${t.width}x${t.height}`) ?? 0) + 1);
console.log('  尺寸分布（前 10）:');
for (const [k, v] of [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${k.padEnd(12)} ${v}`);
const frames = new Set(tex.map((t) => t.sampledFrame));
console.log(`  sampledFrame 取值: ${[...frames].join(', ')}`);
const texIds = new Set(tex.map((t) => t.id));
console.log(`  sprite 数与 textures 条数之差: ${sprites.size - tex.length}`);
console.log(`  有几何引用但无 textures 条目的 sprite: ${[...sprites].filter((s) => !texIds.has(s)).length}`);
