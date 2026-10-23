// build-viewer.mjs — 把 134 MB 的 registry.json 转成查看器可用的按命名空间分片，
// 并输出两项决定查看器设计的诊断。
//
// 诊断一：采集是否偏向靠前的方块（采集器按注册表顺序遍历，撞上限就停）。
// 诊断二：带染色的 sprite 其贴图本身是不是灰度的（是灰度则染色不可省，否则可以忽略染色）。
//
// 用法： node --max-old-space-size=8192 build-viewer.mjs <registry.json> <输出目录>

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const src = process.argv[2];
const outDir = process.argv[3] ?? path.join(path.dirname(src), 'viewer');
const texDir = path.join(path.dirname(src), 'textures');

const j = JSON.parse(fs.readFileSync(src, 'utf8'));
const blocks = j.blocks ?? [];

// ---------- 诊断一：位置偏置 ----------
const n = blocks.length;
const decile = (b) => Math.min(9, Math.floor((blocks.indexOf(b) / n) * 10));
let quadsByDecile = new Array(10).fill(0);
let statesByDecile = new Array(10).fill(0);
for (let i = 0; i < n; i++) {
  const d = Math.min(9, Math.floor((i / n) * 10));
  const st = blocks[i].render?.states ?? [];
  statesByDecile[d] += st.length;
  for (const s of st) quadsByDecile[d] += s.quads?.length ?? 0;
}
console.log('=== 诊断一：按方块序位的十等分分布 ===');
console.log('  分位   实采状态   quad');
for (let d = 0; d < 10; d++) console.log(`  ${(d * 10 + '-').padStart(4)}%  ${String(statesByDecile[d]).padStart(8)}  ${String(quadsByDecile[d]).padStart(8)}`);
const zeroStateBlocks = blocks.filter((b) => (b.render?.states ?? []).length === 0).length;
console.log(`  完全没采到状态的方块: ${zeroStateBlocks}`);

// ---------- 诊断二：染色 sprite 是否灰度 ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported bitDepth=${bitDepth} interlace=${interlace}`);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported colorType=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, px: out };
}

// 收集被染色 quad 引用的 sprite
const tintedSprites = new Map();
for (const b of blocks) for (const s of b.render?.states ?? []) for (const q of s.quads ?? []) {
  if ((q.tintIndex ?? -1) >= 0 && q.sprite) tintedSprites.set(q.sprite, b.id);
}
const texById = new Map((j.textures ?? []).map((t) => [t.id, t]));
let checked = 0, grayish = 0, colorful = 0, undecodable = 0;
const graySamples = [], colorSamples = [];
for (const [sp] of tintedSprites) {
  const t = texById.get(sp);
  if (!t) { undecodable++; continue; }
  const f = path.join(path.dirname(src), t.path);
  if (!fs.existsSync(f)) { undecodable++; continue; }
  try {
    const img = decodePng(fs.readFileSync(f));
    let satSum = 0, cnt = 0;
    for (let i = 0; i < img.px.length; i += img.ch) {
      if (img.ch === 4 && img.px[i + 3] < 128) continue;
      const r = img.px[i], g = img.px[i + 1], b2 = img.px[i + 2];
      const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
      cnt++;
    }
    const avgSat = cnt ? satSum / cnt : 0;
    checked++;
    if (avgSat < 0.06) { grayish++; if (graySamples.length < 5) graySamples.push({ sprite: sp, avgSat: +avgSat.toFixed(4) }); }
    else { colorful++; if (colorSamples.length < 5) colorSamples.push({ sprite: sp, avgSat: +avgSat.toFixed(4) }); }
  } catch { undecodable++; }
}
console.log('\n=== 诊断二：带染色 quad 所用 sprite 的饱和度 ===');
console.log(`  检查了 ${checked} 个 sprite（另有 ${undecodable} 个无法解码）`);
console.log(`  近似灰度（均值饱和度 < 0.06）: ${grayish}`);
console.log(`  本身有色（>= 0.06）          : ${colorful}`);
console.log('  灰度样本: ' + JSON.stringify(graySamples));
console.log('  有色样本: ' + JSON.stringify(colorSamples));

// ---------- 生成分片 ----------
fs.mkdirSync(outDir, { recursive: true });
const shards = new Map();
const texIndex = {};
let satOk = 0, satGray = 0, satFail = 0;
for (const t of j.textures ?? []) {
  // 预计算平均饱和度：查看器据此判断是否需要对染色 quad 上色。
  // 贴图本身已是彩色时不上色，避免二次染色；贴图是灰度时必须上色，否则会渲染成灰白。
  let sat = -1;
  try {
    const f = path.join(path.dirname(src), t.path);
    if (fs.existsSync(f)) {
      const img = decodePng(fs.readFileSync(f));
      let s = 0, c = 0;
      for (let i = 0; i < img.px.length; i += img.ch) {
        if (img.ch === 4 && img.px[i + 3] < 128) continue;
        const r = img.px[i], g = img.px[i + 1], b2 = img.px[i + 2];
        const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2);
        s += mx === 0 ? 0 : (mx - mn) / mx; c++;
      }
      sat = c ? +(s / c).toFixed(4) : -1;
    }
  } catch { sat = -1; }
  if (sat < 0) satFail++; else if (sat < 0.06) satGray++; else satOk++;
  texIndex[t.id] = { p: t.path, w: t.width, h: t.height, a: t.animated, sat };
}
console.log(`\n=== 全部贴图的饱和度 ===`);
console.log(`  近灰度: ${satGray}   有色: ${satOk}   无法判定: ${satFail}`);

const round = (x, d) => { const f = Math.pow(10, d); return Math.round(x * f) / f; };
for (const b of blocks) {
  const id = String(b.id ?? '');
  const ns = id.split(':')[0] || 'unknown';
  if (!shards.has(ns)) shards.set(ns, []);
  const st = b.render?.states ?? [];
  const first = st[0];
  const item = {
    id,
    stateCount: b.stateCount ?? 0,
    capturedStates: st.length,
    hasBE: !!b.hasBlockEntity,
    kind: b.render?.kind ?? null,
    truncated: !!b.render?.truncated,
    notes: b.render?.notes ?? [],
  };
  if (first) {
    item.props = first.properties ?? {};
    item.quads = (first.quads ?? []).map((q) => ({
      s: q.sprite ?? '',
      t: q.tintIndex ?? -1,
      l: q.layer ?? '',
      f: q.face ?? '',
      sh: q.shade !== false,
      v: q.vertices.map((vx) => [round(vx.position[0], 4), round(vx.position[1], 4), round(vx.position[2], 4), round(vx.uv[0], 6), round(vx.uv[1], 6)]),
    }));
  } else {
    item.quads = [];
  }
  shards.get(ns).push(item);
}

let totalBytes = 0;
const shardIndex = [];
for (const [ns, items] of [...shards.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const file = `shard-${ns.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
  const text = JSON.stringify(items);
  fs.writeFileSync(path.join(outDir, file), text, 'utf8');
  totalBytes += Buffer.byteLength(text);
  shardIndex.push({
    ns, file, count: items.length,
    withQuads: items.filter((i) => (i.quads ?? []).length > 0).length,
    withTint: items.filter((i) => (i.quads ?? []).some((q) => q.t >= 0)).length,
    blockEntities: items.filter((i) => i.hasBE).length,
    truncated: items.filter((i) => i.truncated).length,
  });
}

fs.writeFileSync(path.join(outDir, 'textures.json'), JSON.stringify(texIndex), 'utf8');
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
  source: path.basename(src),
  capturedAt: j.capturedAt,
  minecraftVersion: j.minecraftVersion,
  loader: j.loader,
  counts: j.counts,
  limits: j.limits,
  mods: j.mods,
  shards: shardIndex,
}, null, 2), 'utf8');

console.log('\n=== 分片与索引 ===');
console.log('  命名空间  条目  有几何  有染色  方块实体  截断');
for (const s of shardIndex) {
  console.log(`  ${s.ns.padEnd(22)} ${String(s.count).padStart(6)} ${String(s.withQuads).padStart(6)} ${String(s.withTint).padStart(6)} ${String(s.blockEntities).padStart(8)} ${String(s.truncated).padStart(6)}`);
}
console.log(`  分片总字节数: ${(totalBytes / 1048576).toFixed(2)} MB`);
console.log(`  输出目录: ${outDir}`);
