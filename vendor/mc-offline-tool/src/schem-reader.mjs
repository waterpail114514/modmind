// schem-reader.mjs —— 把建筑文件读成统一的方块网格
//
// 统一输出（下游渲染只认这一种）：
//   {
//     format, name, size: {x,y,z},
//     palette: [ { id, props } ],           // 索引 = 调色板下标
//     blocks: [ { x, y, z, p } ],           // p = palette 下标
//     stats: { usedPalette, blocks, skippedAir, skippedBadRef }   // badRef = 调色板下标越界（数据损坏，≠空气）
//   }
//
// 支持：
//   .nbt        MC 结构方块导出的 structure（pos 显式给出，最好读；负坐标自动整体平移归零）
//   .litematic  Litematica 投影（LongArray 位压缩，spanning 排布）
//   .schem      WorldEdit 投影 v2（BlockData 变长整数 + 名字调色板）
// 明确拒绝（给出可读提示，不是崩溃）：
//   .schem v1   WorldEdit 旧版，BlockData 是数字 id —— 需要 id→名字映射表，本工具不做。
//   .schematic  MCEdit 老格式，同样是数字 id 平行字节数组。
//   ⇒ 导入入口的 accept 里**只列真正支持的三种**（见 preview/index.html）；拖入这两种也会收到明确提示。
//
// 注意索引顺序：WorldEdit / MCEdit 用 idx = (y * sizeZ + z) * sizeX + x；
// 结构文件与 litematic 的 pos 是显式的或按同一顺序，所以统一按这个顺序读。

import { readNbtFile, unpackLongsSpanning } from './nbt.mjs';

const AIR_LIKE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** "minecraft:oak_stairs[facing=north,half=bottom]" -> { id, props } */
export function parseStateString(s) {
  const i = s.indexOf('[');
  if (i < 0) return { id: s, props: {} };
  const id = s.slice(0, i);
  const props = {};
  for (const kv of s.slice(i + 1, s.lastIndexOf(']')).split(',')) {
    const j = kv.indexOf('=');
    if (j > 0) props[kv.slice(0, j)] = kv.slice(j + 1);
  }
  return { id, props };
}

/** 读变长整数（WorldEdit BlockData 用） */
function readVarInts(buf, count) {
  const out = new Array(count);
  let p = 0;
  for (let i = 0; i < count; i++) {
    let v = 0, shift = 0;
    for (;;) {
      if(p>=buf.length || shift>=35)throw new Error('Schem 方块数据不完整或 VarInt 无效');
      const b = buf[p++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    out[i] = v;
  }
  return out;
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
function checkSize(sx,sy,sz) {
  if([sx,sy,sz].some(n=>!Number.isInteger(n)||n<1||n>2048)||sx*sy*sz>8000000)throw new Error('建筑尺寸无效或超过 800 万格');
}

// ---------------------------------------------------------------- .nbt structure

/**
 * .nbt 结构文件读入。
 * ★ 负坐标归一化（审核员 B5）：规范上结构文件的 pos ≥ 0，但手工构造/第三方导出的可能带负数 pos，
 *   而下游（preview/src/main.js#structureFrom）只接受非负坐标、越界会被静默丢掉 ⇒ 这里统一**整体平移**到 0 起，
 *   并把声明的 size 相应放大（同时不小于实际最大坐标 +1），保证"负坐标方块一个都不丢"。
 * 导出（非本模块内部）：`test-api.mjs` 直接构造 root 对象来测这条不变量，不需要真实 NBT 字节。
 */
export function readStructure(root, name) {
  const size = root.size.map(num);
  let minX = 0, minY = 0, minZ = 0;          // 只用来看是否需要平移（初值 0：没有负数就不动）
  let maxX = -1, maxY = -1, maxZ = -1;
  const raw = [];
  for (const b of root.blocks || []) {
    const [x, y, z] = b.pos.map(num);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    raw.push({ x, y, z, p: num(b.state) });
  }
  const dx = -minX, dy = -minY, dz = -minZ;  // ≥ 0
  const shift = (dx || dy || dz) ? raw.map((b) => ({ x: b.x + dx, y: b.y + dy, z: b.z + dz, p: b.p })) : raw;
  // 尺寸：声明值 + 平移量，且不小于实际最大坐标 +1（避免"声明小、内容大"）
  const sz = [
    Math.max(size[0] + dx, maxX + dx + 1, 0),
    Math.max(size[1] + dy, maxY + dy + 1, 0),
    Math.max(size[2] + dz, maxZ + dz + 1, 0),
  ];
  return emit('.nbt', name || 'structure', { x: sz[0], y: sz[1], z: sz[2] }, paletteOf(root), shift);
}

/** 调色板：{Name, Properties} → {id, props} */
function paletteOf(root) {
  return (root.palette || []).map((e) => ({ id: e.Name, props: e.Properties || {} }));
}

// ---------------------------------------------------------------- .litematic

function readLitematic(root, name) {
  const regions = root.Regions || {};
  const names = Object.keys(regions);
  if (names.length === 0) throw new Error('litematic 里没有 Regions');
  // 多个 region 时取并集，按各自 Position 平移到统一坐标系
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const palette = [];
  const blocks = [];
  const seen = new Map();
  for (const rn of names) {
    const r = regions[rn];
    const pos = r.Position || { x: 0, y: 0, z: 0 };
    const sz = r.Size || { x: 1, y: 1, z: 1 };
    const sx = Math.abs(num(sz.x)), sy = Math.abs(num(sz.y)), szz = Math.abs(num(sz.z));
    checkSize(sx,sy,szz);
    if(blocks.length+sx*sy*szz>8000000)throw new Error('Litematic 区域总量超过 800 万格');
    // Litematica stores containers from the minimum corner, even when the
    // selection's primary corner and signed Size point in the negative direction.
    const ox = num(pos.x) + Math.min(0,num(sz.x)+1), oy = num(pos.y) + Math.min(0,num(sz.y)+1), oz = num(pos.z) + Math.min(0,num(sz.z)+1);
    const pal = (r.BlockStatePalette || []).map((e) => ({ id: e.Name, props: e.Properties || {} }));
    const bits = num(r.Bits) || Math.max(2, Math.ceil(Math.log2(Math.max(2, pal.length))));
    if(!Number.isInteger(bits)||bits<2||bits>32 || (r.BlockStates?.length||0)*64 < sx*sy*szz*bits)throw new Error('Litematic 方块位数据不完整');
    const flat = unpackLongsSpanning(r.BlockStates || [], bits, sx * sy * szz);
    // 调色板可能每个 region 不同，做一次局部到全局的映射
    const remap = pal.map((e) => {
      const k = e.id + '\u0000' + JSON.stringify(e.props);
      if (!seen.has(k)) { seen.set(k, palette.length); palette.push(e); }
      return seen.get(k);
    });
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < szz; z++) {
        for (let x = 0; x < sx; x++) {
          const idx = (y * szz + z) * sx + x;
          const gp = remap[flat[idx]] ?? -1;
          const gx = ox + x, gy = oy + y, gz = oz + z;
          if (gx < minX) minX = gx; if (gy < minY) minY = gy; if (gz < minZ) minZ = gz;
          if (gx > maxX) maxX = gx; if (gy > maxY) maxY = gy; if (gz > maxZ) maxZ = gz;
          blocks.push({ x: gx, y: gy, z: gz, p: gp });
        }
      }
    }
  }
  // 归一化到 (0,0,0) 起
  for (const b of blocks) { b.x -= minX; b.y -= minY; b.z -= minZ; }
  const meta = root.Metadata || {};
  return emit('.litematic', meta.Name || name, { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 }, palette, blocks);
}

// ---------------------------------------------------------------- .schem (WorldEdit v1/v2)

function readSchem(root, name) {
  const sx = num(root.Width), sy = num(root.Height), sz = num(root.Length);
  checkSize(sx,sy,sz);
  if (!sx || !sy || !sz) throw new Error('.schem 缺少 Width/Height/Length（不是 WorldEdit 投影？）');

  let palette, data;
  if (root.BlockData && root.Palette) {
    // v2：Palette 是 name->int 的 compound，BlockData 是变长整数
    const entries = Object.entries(root.Palette).sort((a, b) => num(a[1]) - num(b[1]));
    palette = entries.map(([s]) => parseStateString(s));
    data = readVarInts(root.BlockData, sx * sy * sz);
    // 变长整数的下标即调色板值；若顺序不是 0..n-1，重排
    const remap = entries.map(([, v]) => num(v));
    if(remap.length>20000 || remap.some(n=>!Number.isInteger(n)||n<0||n>20000))throw new Error('Schem 调色板索引无效');
    const maxV = Math.max(...remap);
    const byVal = new Array(maxV + 1).fill(-1);
    remap.forEach((v, i) => { byVal[v] = i; });
    data = data.map((v) => byVal[v] ?? -1);
  } else if (root.Blocks) {
    // v1：Blocks 是逐格数字 id 字节；v3（real.schem）也是 Blocks 形态（内含 Palette + Data）。
    // ★ 直接拒绝，不要先算一遍 data 再 throw（那是死代码，白算一次）。
    throw new Error('.schem 的 Blocks 形态（v1 数字 id / v3 压缩调色板）暂不支持：本工具只认 v2 的 BlockData+Palette（名字调色板）。请用 WorldEdit/Amulet 另存为 v2 或 .litematic 后重试');
  } else {
    throw new Error('.schem 里既没有 BlockData/Palette 也没有 Blocks');
  }

  const blocks = [];
  let i = 0;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++, i++) blocks.push({ x, y, z, p: data[i] });
    }
  }
  return emit('.schem', name, { x: sx, y: sy, z: sz }, palette, blocks);
}

// ---------------------------------------------------------------- .schematic (MCEdit)

function readMcedit(root, name) {
  const sx = num(root.Width), sy = num(root.Height), sz = num(root.Length);
  if (!sx || !sy || !sz) throw new Error('.schematic 缺少 Width/Height/Length');
  throw new Error('.schematic 是数字 id 格式，需要一张 id->名字映射表才能转成名字；本工具暂时只支持名字调色板的格式（.nbt / .litematic / .schem v2）');
}

// ---------------------------------------------------------------- 汇总

function emit(format, name, size, palette, blocks) {
  // 丢掉空气，压缩调色板
  const used = new Map();
  const out = [];
  // ★ 两个计数器必须**分开**（审核员 B6）：把"调色板下标越界（=数据损坏）"算进"空气"会**误导排查方向**——
  //   用户看到"跳过空气 1,234"，但其实是上游数据坏了。分开后 skippedBadRef 非零时前端显红。
  let skippedAir = 0;
  let skippedBadRef = 0;
  for (const b of blocks) {
    const pal = palette[b.p];
    if (!pal) { skippedBadRef++; continue; }
    if (AIR_LIKE.has(pal.id)) { skippedAir++; continue; }
    let np = used.get(b.p);
    if (np === undefined) { np = used.size; used.set(b.p, np); }
    out.push({ x: b.x, y: b.y, z: b.z, p: np });
  }
  const newPalette = new Array(used.size);
  for (const [op, np] of used) newPalette[np] = palette[op];
  return {
    format, name, size,
    palette: newPalette,
    blocks: out,
    stats: { usedPalette: newPalette.length, blocks: out.length, skippedAir, skippedBadRef, raw: blocks.length },
  };
}

/** 按扩展名分派 */
export function readBuildFile(buf, filename) {
  const lower = (filename || '').toLowerCase();
  const { name, value } = readNbtFile(buf);
  const base = (filename || '').replace(/\.[^.]+$/, '');
  if (lower.endsWith('.litematic')) return readLitematic(value, name || base);
  if (lower.endsWith('.schem')) return readSchem(value, name || base);
  if (lower.endsWith('.schematic')) return readMcedit(value, name || base);
  // .nbt / 未知：先按结构文件试，再按 litematic 试
  if (value && value.size && value.palette && value.blocks) return readStructure(value, name || base);
  if (value && value.Regions) return readLitematic(value, name || base);
  throw new Error('无法识别的建筑文件：既不像结构文件，也没有 Regions。顶层键 = ' + Object.keys(value || {}).join(','));
}
