// uv-check.mjs — 判定几何 UV 的坐标空间，并检查子矩形 UV 是否被保留
//
// 为什么关键：
//   若 UV 是「贴图局部归一化坐标」，则产物自足 —— sprite 名加局部 UV 加贴图 blob 就能重建。
//   若 UV 是「整张图集的归一化坐标」，则必须额外知道每个 sprite 在图集里的矩形，
//   而现有采集器没有导出矩形，产物就不自足。
//
// 判定方法：统计所有 quad 的 UV 范围组合。若绝大多数 quad 的 UV 恰好都是同一个
// "整幅" 范围，说明要么 UV 是局部坐标且模型都整幅贴图，要么局部子矩形信息已丢失。
// 再找模型确实使用子矩形的方块（如蜂巢），看其 UV 范围是否窄于整幅。

import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const INSET = 1 / 4096;
const pats = new Map();
let total = 0, nonFull = 0;
const samples = [];

for (const b of j.blocks ?? []) {
  for (const s of b.render?.states ?? []) {
    for (const q of s.quads ?? []) {
      total++;
      const us = q.vertices.map((v) => v.uv[0]);
      const vs = q.vertices.map((v) => v.uv[1]);
      const uMin = Math.min(...us), uMax = Math.max(...us);
      const vMin = Math.min(...vs), vMax = Math.max(...vs);
      const key = `${uMin.toFixed(6)}..${uMax.toFixed(6)} / ${vMin.toFixed(6)}..${vMax.toFixed(6)}`;
      pats.set(key, (pats.get(key) ?? 0) + 1);
      const full = uMin <= INSET + 1e-9 && uMax >= 1 - INSET - 1e-9 && vMin <= INSET + 1e-9 && vMax >= 1 - INSET - 1e-9;
      if (!full) {
        nonFull++;
        if (samples.length < 8) samples.push({ block: b.id, sprite: q.sprite, face: q.face, key });
      }
    }
  }
}

console.log(`quad 总数                    : ${total}`);
console.log(`UV 不是整幅范围的 quad       : ${nonFull}  (${(nonFull / Math.max(1, total) * 100).toFixed(2)}%)`);
const arr = [...pats.entries()].sort((a, b) => b[1] - a[1]);
console.log(`不同 UV 范围组合数           : ${arr.length}`);
console.log('前 14 个组合：');
for (const [k, v] of arr.slice(0, 14)) console.log(`  ${k}   x${v}`);
console.log('非整幅样本（最多 8 条）：');
for (const s of samples) console.log('  ' + JSON.stringify(s));
