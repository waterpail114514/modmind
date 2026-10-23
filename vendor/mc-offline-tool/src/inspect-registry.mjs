// inspect-registry.mjs — 针对性查看 registry.json 的关键字段与异常样本
// 用法： node --max-old-space-size=8192 inspect-registry.mjs <registry.json>

import fs from 'node:fs';

const p = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const cut = (o, n = 1200) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s.length > n ? s.slice(0, n) + ' …' : s; };

console.log('=== counts（采集器自报计数） ===');
console.log(cut(j.counts, 800));

console.log('\n=== limits（本次生效的上限） ===');
console.log(cut(j.limits, 800));

console.log(`\n=== mods（环境记录）===`);
console.log(`  条数: ${(j.mods ?? []).length}`);
console.log(`  前 6 条: ${cut((j.mods ?? []).slice(0, 6), 600)}`);

console.log(`\n=== diagnostics ===`);
console.log(cut(j.diagnostics, 1500));

console.log(`\n=== textures[0] ===`);
console.log(cut(j.textures?.[0], 900));
console.log(`=== textures[1] ===`);
console.log(cut(j.textures?.[1], 900));
const texKeys = j.textures?.[0] ? Object.keys(j.textures[0]) : [];
console.log(`textures 条目的键: ${texKeys.join(', ')}`);

// 被截断的方块
const tr = (j.blocks ?? []).filter((b) => b.render?.truncated);
console.log(`\n=== 被截断的方块（共 ${tr.length} 个，看前 2 个） ===`);
for (const b of tr.slice(0, 2)) {
  const r = b.render ?? {};
  console.log(`  id=${b.id} stateCount=${b.stateCount} states=${(r.states ?? []).length} quads=${(r.states ?? []).reduce((a, s) => a + (s.quads?.length ?? 0), 0)}`);
  console.log(`    render.kind=${r.kind} quality=${r.quality} truncated=${r.truncated}`);
  console.log(`    notes=${cut(r.notes, 300)}`);
  console.log(`    首个状态: ${cut({ ...(r.states?.[0] ?? {}), quads: `(${(r.states?.[0]?.quads ?? []).length} 个 quad)` }, 500)}`);
}

// 方块实体样本
const be = (j.blocks ?? []).filter((b) => (b.render?.notes ?? []).includes('block_entity_renderer_not_captured'));
console.log(`\n=== 方块实体样本（共 ${be.length} 个） ===`);
for (const b of be.slice(0, 2)) console.log(`  ${cut({ id: b.id, hasBlockEntity: b.hasBlockEntity, stateCount: b.stateCount, render: { kind: b.render?.kind, notes: b.render?.notes, states: (b.render?.states ?? []).length } }, 500)}`);

// dynamic 样本
const dyn = (j.blocks ?? []).filter((b) => b.render?.kind === 'dynamic');
console.log(`\n=== kind=dynamic 样本（共 ${dyn.length} 个） ===`);
for (const b of dyn.slice(0, 2)) console.log(`  ${cut({ id: b.id, stateCount: b.stateCount, notes: b.render?.notes, states: (b.render?.states ?? []).length }, 400)}`);

// 多状态方块：声明了上千个状态、但只采了一个
const many = (j.blocks ?? []).filter((b) => (b.stateCount ?? 0) >= 1024).sort((a, b) => b.stateCount - a.stateCount).slice(0, 6);
console.log(`\n=== 声明状态数最多的方块（前 6） ===`);
for (const b of many) console.log(`  ${b.id}  stateCount=${b.stateCount}  实采状态=${(b.render?.states ?? []).length}  kind=${b.render?.kind}  truncated=${b.render?.truncated}`);

// layer 字段里的异常值
const weird = new Set();
for (const b of j.blocks ?? []) for (const s of b.render?.states ?? []) for (const q of s.quads ?? []) if (q.layer && !/^[a-z_]+$/.test(q.layer)) weird.add(q.layer);
console.log(`\n=== layer 字段里的非规范值（${weird.size} 种） ===`);
[...weird].slice(0, 3).forEach((w) => console.log('  ' + cut(w, 500)));
