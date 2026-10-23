// 独立复核 D006 / D007 的关键结论，并补两项它们未做的检查：
//   1) 导出贴图 blob 的字节来源（资源原图 vs 图集上传像素）
//   2) 非染色 quad 的顶点色是否也有信息量（判断 color 字段价值）
// 只读，不修改任何产物。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'e:/AI工作台/mc-offline-tool/.work/probe-01';
const REG = path.join(ROOT, '.modmind/voxel-capture/registry.json');
const TEX = path.join(ROOT, '.modmind/voxel-capture/textures');

const t0 = Date.now();
const buf = fs.readFileSync(REG);
console.log('文件字节数        :', buf.length);
const reg = JSON.parse(buf.toString('utf8'));
console.log('JSON.parse 耗时   :', Date.now() - t0, 'ms');
console.log('堆已用            :', Math.round(process.memoryUsage().heapUsed / 1048576), 'MB');

console.log('\n=== counts / limits ===');
console.log(JSON.stringify(reg.counts));
console.log(JSON.stringify(reg.limits));
console.log('schemaVersion:', reg.schemaVersion, '| complete:', reg.complete, '| worldLoaded:', reg.worldLoaded);

const blocks = reg.blocks || [];
const textures = reg.textures || [];
console.log('\n方块条目数:', blocks.length, '| 贴图条目数:', textures.length);

// ---- 1. sprite id 的类别前缀分布（验证"物品图标未采"）----
const prefix = new Map();
for (const t of textures) {
  const id = String(t.id || '');
  const colon = id.indexOf(':');
  const rest = colon < 0 ? id : id.slice(colon + 1);
  const slash = rest.indexOf('/');
  const p = slash < 0 ? '(无/) ' + rest : rest.slice(0, slash);
  prefix.set(p, (prefix.get(p) || 0) + 1);
}
console.log('\n=== sprite id 的类别前缀分布（前 20）===');
[...prefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([k, v]) => console.log('  ' + k.padEnd(24), v));

// ---- 2. 顶点色：染色 quad 与非染色 quad 分开统计 ----
const tintColors = new Map();
const plainColors = new Map();
let quads = 0, tintQuads = 0, plainQuads = 0;
let uvFull = 0, uvSub = 0;
const uvKeys = new Map();
let zeroQuadBlocks = 0, truncatedBlocks = 0;

for (const b of blocks) {
  const st = b?.render?.states || [];
  if (st.length === 0) zeroQuadBlocks++;
  if (b?.render?.truncated) truncatedBlocks++;
  for (const s of st) {
    for (const q of (s.quads || [])) {
      quads++;
      const vs = q.vertices || [];
      const key = vs.map(v => (v.color || []).map(n => Number(n).toFixed(3)).join(',')).join(' | ');
      const hasTint = q.tintIndex !== undefined && q.tintIndex !== null && q.tintIndex >= 0;
      if (hasTint) {
        tintQuads++;
        tintColors.set(key, (tintColors.get(key) || 0) + 1);
      } else {
        plainQuads++;
        plainColors.set(key, (plainColors.get(key) || 0) + 1);
      }
      // UV 范围
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const v of vs) {
        const uv = v.uv || [0, 0];
        u0 = Math.min(u0, uv[0]); u1 = Math.max(u1, uv[0]);
        v0 = Math.min(v0, uv[1]); v1 = Math.max(v1, uv[1]);
      }
      const isFull = u0 < 0.01 && u1 > 0.99 && v0 < 0.01 && v1 > 0.99;
      if (isFull) uvFull++; else uvSub++;
      const uk = `${u0.toFixed(6)}..${u1.toFixed(6)} / ${v0.toFixed(6)}..${v1.toFixed(6)}`;
      uvKeys.set(uk, (uvKeys.get(uk) || 0) + 1);
    }
  }
}

console.log('\n=== quad 统计 ===');
console.log('  quad 总数        :', quads, '| limits.maxTotalQuads =', reg.limits?.maxTotalQuads);
console.log('  撞上限?          :', quads >= (reg.limits?.maxTotalQuads ?? Infinity) ? '是（精确等于上限）' : '否');
console.log('  带染色 quad      :', tintQuads);
console.log('  非染色 quad      :', plainQuads);
console.log('  零 quad 方块     :', zeroQuadBlocks);
console.log('  truncated 方块   :', truncatedBlocks);

console.log('\n=== 带染色 quad 的顶点色组合（前 5）===');
[...tintColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .forEach(([k, v]) => console.log('  x' + String(v).padEnd(8), k));
console.log('  组合总数:', tintColors.size);

console.log('\n=== 非染色 quad 的顶点色组合（前 5，判断 color 字段是否有信息量）===');
[...plainColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .forEach(([k, v]) => console.log('  x' + String(v).padEnd(8), k));
console.log('  组合总数:', plainColors.size);

console.log('\n=== UV 坐标空间 ===');
console.log('  整幅 [0,1] 的 quad :', uvFull, `(${((uvFull / quads) * 100).toFixed(2)}%)`);
console.log('  非整幅 quad        :', uvSub, `(${((uvSub / quads) * 100).toFixed(2)}%)`);
console.log('  不同 UV 组合数     :', uvKeys.size);

// ---- 3. 贴图 blob 的基本指纹（供与 jar 原图比对）----
console.log('\n=== 贴图条目抽样（id / 声明宽高 / blob 实际字节数 / 实际宽高）===');
const samples = [];
for (let i = 0; i < textures.length; i += Math.max(1, Math.floor(textures.length / 12))) {
  samples.push(textures[i]);
}
const crypto = await import('node:crypto');
for (const t of samples) {
  const p = path.join(TEX, path.basename(String(t.path)));
  let bytes = -1, w = -1, h = -1, sha = '';
  try {
    const b = fs.readFileSync(p);
    bytes = b.length;
    sha = crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
    // PNG IHDR 宽高：字节 16..24
    if (b.length > 24 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      w = b.readUInt32BE(16); h = b.readUInt32BE(20);
    }
  } catch (e) { bytes = -1; }
  console.log('  ' + String(t.id).padEnd(46),
    `声明 ${t.width}x${t.height}`.padEnd(14),
    `实际 ${w}x${h}`.padEnd(14),
    `${bytes}B`.padEnd(10), 'sha=' + sha, 'path=' + path.basename(String(t.path)).slice(0, 12));
}

// ---- 4. 全部贴图 size 分布（判断是否为统一 16x16 单 sprite）----
const sizeDist = new Map();
for (const t of textures) {
  const k = `${t.width}x${t.height}`;
  sizeDist.set(k, (sizeDist.get(k) || 0) + 1);
}
console.log('\n=== 贴图声明尺寸分布 ===');
[...sizeDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log('  ' + k.padEnd(14), v));
console.log('  不同尺寸种数:', sizeDist.size);

const totalTexBytes = fs.readdirSync(TEX).reduce((a, f) => {
  try { return a + fs.statSync(path.join(TEX, f)).size; } catch { return a; }
}, 0);
console.log('\ntextures 目录总字节:', totalTexBytes, '| 文件数:', fs.readdirSync(TEX).length,
  '| 平均每文件:', Math.round(totalTexBytes / fs.readdirSync(TEX).length), 'B');
console.log('counts.decodedTextureBytes:', reg.counts?.decodedTextureBytes);
