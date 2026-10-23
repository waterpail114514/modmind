// api.mjs —— 3D 建筑预览工具的服务端 API 模块（零依赖，只用 Node 内置模块）
//
// 只做两件事：
//   POST /api/import            任意建筑文件 -> 前端统一 JSON
//   POST /api/export?format=... 前端 JSON -> .schem(Sponge v2) / .litematic 字节
//   OPTIONS /api/*              204 CORS 预检
//
// 为什么不装包：本工具一贯零依赖（没有 package.json / node_modules）。
// NBT 写入器、varint、long 位打包全部手写，读入复用 src/ 下已有模块。
//
// 用法：
//   import { createPreviewApi } from './api.mjs'
//   const api = createPreviewApi({ root: 'E:\\...\\mc-offline-tool' })
//   // 在 http server 里：if (api.handle(req, res, new URL(req.url, 'http://x'))) return
import path from 'node:path';
import zlib from 'node:zlib';
import { readBuildFile } from '../src/schem-reader.mjs';
import { opt } from '../src/paths.mjs';   // ★ B2：路径一律走统一解析器（不再写死开发机路径）

// ---------------------------------------------------------------- NBT 常量

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

const DATA_VERSION = 3465; // 1.20.1 附近，任取一个合理值即可

// ---------------------------------------------------------------- NBT 节点构造器
// 显式带类型，避免 0 / 1 这种数值在 Int / Byte / Short 之间产生歧义。

const nByte = (v) => ({ t: TAG.BYTE, v });
const nShort = (v) => ({ t: TAG.SHORT, v });
const nInt = (v) => ({ t: TAG.INT, v });
const nLong = (v) => ({ t: TAG.LONG, v });
const nString = (v) => ({ t: TAG.STRING, v });
const nCompound = (obj) => ({ t: TAG.COMPOUND, v: obj });
const nList = (itemType, arr) => ({ t: TAG.LIST, itemType, v: arr });
const nByteArray = (buf) => ({ t: TAG.BYTE_ARRAY, v: buf });
const nIntArray = (arr) => ({ t: TAG.INT_ARRAY, v: arr });
const nLongArray = (arr) => ({ t: TAG.LONG_ARRAY, v: arr });

// ---------------------------------------------------------------- NBT 写入器

class NbtWriter {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u1(v) { const b = Buffer.allocUnsafe(1); b.writeUInt8(v & 0xff, 0); return this.push(b); }
  i2(v) { const b = Buffer.allocUnsafe(2); b.writeInt16BE(v | 0, 0); return this.push(b); }
  i4(v) { const b = Buffer.allocUnsafe(4); b.writeInt32BE(v | 0, 0); return this.push(b); }
  i8(v) { const b = Buffer.allocUnsafe(8); b.writeBigInt64BE(BigInt(v), 0); return this.push(b); }
  str(s) {
    const body = Buffer.from(String(s), 'utf8');
    const len = Buffer.allocUnsafe(2); len.writeUInt16BE(body.length, 0);
    return this.push(len).push(body);
  }
  out() { return Buffer.concat(this.parts); }
}

function writePayload(w, node) {
  switch (node.t) {
    case TAG.BYTE: w.u1(node.v); break;
    case TAG.SHORT: w.i2(node.v); break;
    case TAG.INT: w.i4(node.v); break;
    case TAG.LONG: w.i8(node.v); break;
    case TAG.STRING: w.str(node.v); break;
    case TAG.BYTE_ARRAY: {
      const a = node.v; w.i4(a.length); w.push(Buffer.from(a)); break;
    }
    case TAG.INT_ARRAY: { const a = node.v; w.i4(a.length); for (const x of a) w.i4(x); break; }
    case TAG.LONG_ARRAY: { const a = node.v; w.i4(a.length); for (const x of a) w.i8(x); break; }
    case TAG.LIST: {
      const arr = node.v;
      const it = node.itemType ?? (arr.length ? arr[0].t : TAG.END);
      w.u1(it); w.i4(arr.length);
      for (const e of arr) writePayload(w, e);
      break;
    }
    case TAG.COMPOUND: {
      for (const k of Object.keys(node.v)) { const c = node.v[k]; w.u1(c.t); w.str(k); writePayload(w, c); }
      w.u1(TAG.END);
      break;
    }
    default: throw new Error('不支持的 NBT tag: ' + node.t);
  }
}

/** 顶层根 compound（空名），与 nbt.mjs 的 parseNbt 期望一致；再 gzip（maybeDecompress 认 1f 8b）。 */
function encodeNbt(root) {
  const w = new NbtWriter();
  w.u1(TAG.COMPOUND);
  w.str('');            // 根名长度 0
  writePayload(w, root); // 内容 + END
  return zlib.gzipSync(w.out());
}

// ---------------------------------------------------------------- 调色板状态串

/** {Name, Properties:{}} -> "minecraft:oak_stairs[facing=north,half=bottom]"（键按字母序） */
function stateString(entry) {
  const name = entry.Name ?? entry.id ?? 'minecraft:air';
  const props = entry.Properties ?? entry.props ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return name;
  keys.sort();
  return name + '[' + keys.map((k) => `${k}=${props[k]}`).join(',') + ']';
}

/** 状态串 -> { id, props } */
function parseStateString(s) {
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

// ---------------------------------------------------------------- 前端 JSON -> 网格

const AIR = 'minecraft:air';

/**
 * 把前端 JSON（只有非空气方块）摊平成完整网格：每个格子一个调色板下标。
 * 空格子统一填 minecraft:air（若调色板里没有就追加）。
 * 索引顺序 (y*sz + z)*sx + x，与 schem-reader 读回时一致。
 */
function buildGrid(payload) {
  const [sx, sy, sz] = (payload.size || [0, 0, 0]).map(Number);
  const volume = sx * sy * sz;
  const states = (payload.palette || []).map(stateString);
  const cells = new Int32Array(volume).fill(-1);
  for (const b of payload.blocks || []) {
    const [x, y, z] = b.pos.map(Number);
    const i = (y * sz + z) * sx + x;
    if (i >= 0 && i < volume) cells[i] = Number(b.state);
  }
  let needsAir = false;
  for (let i = 0; i < volume; i++) if (cells[i] < 0) { needsAir = true; break; }
  if (needsAir) {
    let air = states.indexOf(AIR);
    if (air < 0) { air = states.length; states.push(AIR); }
    for (let i = 0; i < volume; i++) if (cells[i] < 0) cells[i] = air;
  }
  return { sx, sy, sz, volume, states, cells };
}

// ---------------------------------------------------------------- .schem (Sponge v2)

function writeVarInt(out, value) {
  let v = value >>> 0;
  for (;;) {
    if ((v & ~0x7f) === 0) { out.push(v & 0x7f); break; }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

export function writeSchem(payload) {
  const { sx, sy, sz, volume, states, cells } = buildGrid(payload);

  const palette = {};
  states.forEach((s, i) => { palette[s] = nInt(i); });

  const data = [];
  for (let i = 0; i < volume; i++) writeVarInt(data, cells[i]);

  const root = nCompound({
    Version: nInt(2),
    DataVersion: nInt(DATA_VERSION),
    Width: nShort(sx),
    Height: nShort(sy),
    Length: nShort(sz),
    PaletteMax: nInt(states.length),
    Palette: nCompound(palette),
    BlockData: nByteArray(Uint8Array.from(data)),
    Offset: nIntArray([0, 0, 0]),
  });
  return encodeNbt(root);
}

// ---------------------------------------------------------------- .litematic

/**
 * 按 nbt.mjs#unpackLongsSpanning 的语义反向位打包：值在 64 位 long 流中连续排布（可跨 long），
 * 每个 long 内低位在前（little-endian 位序）。返回有符号 BigInt（供 writeBigInt64BE）。
 *
 * 注意 bits 的选择见 bitsFor()：必须整除 64，否则会踩到 unpackLongsSpanning 的坑——
 * 它用 BigInt 的算术右移 (>>) 读 long，而 LongArray 读进来是 **有符号** BigInt；
 * 当某个 long 的 bit63 为 1（跨 long 边界处落了一个奇数下标）时，右移会把符号位带进来，
 * 使跨界的那个值高位被强置为 1，解出错误下标。bits | 64 时永不进入跨界分支，即可规避。
 */
function packLongsSpanning(values, bits) {
  const count = values.length;
  const nLongs = Math.ceil((count * bits) / 64);
  const longs = new Array(nLongs).fill(0n);
  const B = BigInt;
  const mask = (1n << B(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const startLong = Math.floor(start / 64);
    const startOff = start % 64;
    const v = BigInt(values[i] | 0) & mask;
    if (startOff + bits <= 64) {
      longs[startLong] |= v << B(startOff);
    } else {
      const take = 64 - startOff;
      longs[startLong] |= (v & ((1n << B(take)) - 1n)) << B(startOff);
      longs[startLong + 1] |= v >> B(take);
    }
  }
  const sign = 1n << 63n;
  return longs.map((x) => (x >= sign ? x - (1n << 64n) : x));
}

/**
 * 位宽：**标准做法** —— `max(2, ceil(log2(size)))`（可以是 3/5/6/7 等非 2 的幂）。
 * 这样产出的 .litematic 与游戏内 Litematica 的读取口径一致（它是按调色板大小自己算位宽的，
 * 不读文件里的 Bits 字段）——若把位宽向上取到 2 的幂，游戏内会读成错的状态。
 * 允许跨 long 边界：`src/nbt.mjs#unpackLongsSpanning` 的符号位 bug 已于 2026-10-10 修掉。
 */
function bitsFor(n) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(2, n))));
}

export function writeLitematic(payload) {
  const { sx, sy, sz, volume, states, cells } = buildGrid(payload);
  const bits = bitsFor(states.length);
  const longs = packLongsSpanning(cells, bits);

  const blockStatePalette = states.map((s) => {
    const { id, props } = parseStateString(s);
    const propsNode = {};
    for (const k of Object.keys(props)) propsNode[k] = nString(props[k]);
    return nCompound({ Name: nString(id), Properties: nCompound(propsNode) });
  });

  const now = BigInt(Date.now());
  const region = nCompound({
    Position: nCompound({ x: nInt(0), y: nInt(0), z: nInt(0) }),
    Size: nCompound({ x: nInt(sx), y: nInt(sy), z: nInt(sz) }),
    BlockStatePalette: nList(TAG.COMPOUND, blockStatePalette),
    BlockStates: nLongArray(longs),
    Bits: nInt(bits), // 显式给出位宽，读端（readLitematic）优先采用
    Entities: nList(TAG.COMPOUND, []),
    PendingBlockTicks: nList(TAG.COMPOUND, []),
    PendingFluidTicks: nList(TAG.COMPOUND, []),
    TileEntities: nList(TAG.COMPOUND, []),
  });

  const root = nCompound({
    MinecraftDataVersion: nInt(DATA_VERSION),
    Version: nInt(6),
    TotalBlocks: nInt(volume),
    TotalVolume: nInt(volume),
    Metadata: nCompound({
      Name: nString(String(payload.name || 'build')),
      Author: nString('mc-offline-tool'),
      Description: nString(''),
      RegionCount: nInt(1),
      TimeCreated: nLong(now),
      TimeModified: nLong(now),
    }),
    Regions: nCompound({ Unnamed: region }),
  });
  return encodeNbt(root);
}

// ---------------------------------------------------------------- HTTP 层

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-filename',
  'access-control-expose-headers': 'x-filename, x-materials',
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** readBuildFile 输出 -> 前端统一 JSON（与 preview/data/build.json 逐字段一致） */
export function toApiJson(r, source) {
  const n = (v) => Number(typeof v === 'bigint' ? v : v);
  const size = Array.isArray(r.size) ? r.size.map(n) : [n(r.size.x), n(r.size.y), n(r.size.z)];
  const palette = (r.palette || []).map((p) => ({ Name: p.Name ?? p.id, Properties: p.Properties ?? p.props ?? {} }));
  const blocks = (r.blocks || []).map((b) => ({
    pos: b.pos ? b.pos.map(n) : [n(b.x), n(b.y), n(b.z)],
    state: n(b.state ?? b.p),
  }));
  return { format: r.format, name: r.name, size, palette, blocks, stats: r.stats, source };
}

/** 材料清单：[{id, count}]，按 count 降序。name 留给前端补中文。 */
export function computeMaterials(payload) {
  const counts = new Map();
  const palette = payload.palette || [];
  for (const b of payload.blocks || []) {
    const entry = palette[b.state];
    const id = entry ? (entry.Name ?? entry.id) : 'minecraft:air';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
}

export function safeName(name) {
  const s = String(name || 'build').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return s || 'build';
}

export function createPreviewApi({ root } = {}) {
  // root 用来定位 src/ 下的模块；本文件与 src/ 相对位置固定，已静态 import。
  void root;

  // ---- 按需打包（P4）：给一批方块状态 → 只解析它们用到的 blockstates/models/textures，现打一张小图集 ----
  // 懒加载：读实例要几秒，只有页面真的请求 /api/scene 时才做。
  let sceneAssets = null;
  // ★ 缓存指纹：把**管线源码**的 size+mtime 混进缓存键。改了 scene-assets / defaults / png 就自动换键，
  //   否则会命中旧缓存 —— 这一轮真踩到了：pickNs 修好、stats 变了，磁盘上却还是修之前那份空 JSON。
  let sceneFingerprint = 'nofp';
  async function getSceneAssets() {
    if (sceneAssets) return sceneAssets;
    const [{ createSceneAssets, findInstanceDir }, fsMod, pathMod, urlMod] = await Promise.all([
      import('./scene-assets.mjs'), import('node:fs'), import('node:path'), import('node:url'),
    ]);
    try {
      const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
      const fp = (p) => { const s = fsMod.statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; };
      sceneFingerprint = ['scene-assets.mjs', 'src/defaults.js', 'src/png.mjs'].map((f) => fp(pathMod.join(here, f))).join('|');
    } catch { /* 取不到指纹就退回固定值 */ }
    const mcDir = opt('MC_ROOT');   // ★ B2：走统一解析器（原来是写死的 'E:/mc/.minecraft'）
    const instanceDir = process.env.PREVIEW_INSTANCE || findInstanceDir(mcDir);
    console.log('[api] 按需打包实例：' + instanceDir);
    sceneAssets = createSceneAssets({ instanceDir, mcDir, log: (m) => console.log('[scene] ' + m) });
    return sceneAssets;
  }

  return {
    handle(req, res, url) {
      const pathname = url.pathname;

      // OPTIONS 预检：任何 /api/* 都回 204 + CORS
      if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return true;
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        (async () => {
          const raw = req.headers['x-filename'];
          let filename = 'building.nbt';
          if (raw) { try { filename = decodeURIComponent(raw); } catch { filename = raw; } }
          try {
            const buf = await readBody(req);
            const result = readBuildFile(buf, filename);
            sendJson(res, 200, toApiJson(result, path.basename(filename)));
          } catch (e) {
            sendJson(res, 400, { error: e && e.message ? e.message : String(e) });
          }
        })();
        return true;
      }

      if (pathname === '/api/export' && req.method === 'POST') {
        (async () => {
          const format = (url.searchParams.get('format') || 'schem').toLowerCase();
          if (format !== 'schem' && format !== 'litematic') {
            sendJson(res, 400, { error: `未知导出格式: ${format}（只支持 schem / litematic）` });
            return;
          }
          let payload;
          try {
            payload = JSON.parse((await readBody(req)).toString('utf8'));
          } catch (e) {
            sendJson(res, 400, { error: '请求体不是合法 JSON: ' + e.message });
            return;
          }
          let bytes;
          try {
            bytes = format === 'litematic' ? writeLitematic(payload) : writeSchem(payload);
          } catch (e) {
            sendJson(res, 400, { error: '导出失败: ' + (e && e.message ? e.message : String(e)) });
            return;
          }
          const base = safeName(payload.name);
          const fileName = `${base}.${format}`;
          const materials = computeMaterials(payload);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': bytes.length,
            'content-disposition': `attachment; filename="${fileName}"`,
            'x-filename': encodeURIComponent(fileName),
            'x-materials': encodeURIComponent(JSON.stringify(materials)),
            ...CORS,
          });
          res.end(bytes);
        })();
        return true;
      }

      // POST /api/scene { states:[...] } → { key, atlas, assets, stats }
      // 只打包这批方块状态用到的贴图；产物按内容哈希缓存到 preview/.work/scene-cache/，同场景不重算。
      if (pathname === '/api/scene' && req.method === 'POST') {
        (async () => {
          let body;
          try {
            body = JSON.parse((await readBody(req)).toString('utf8'));
          } catch (e) {
            sendJson(res, 400, { error: '请求体不是合法 JSON: ' + e.message });
            return;
          }
          const rawStates = Array.isArray(body.states) ? body.states.filter((s) => typeof s === 'string') : [];
          const states = rawStates.slice(0, 20000);
          if (!states.length) {
            sendJson(res, 400, { error: 'states 不能为空（应是方块状态串数组）' });
            return;
          }
          try {
            const [scene, fsMod, pathMod, cryptoMod] = await Promise.all([
              getSceneAssets(), import('node:fs'), import('node:path'), import('node:crypto'),
            ]);
            const out = scene.buildForStates(states);
            // 缓存键 = 管线指纹 + 状态列表：源码一变就换键，杜绝"修了 bug 却命中旧缓存"
            const key = cryptoMod.createHash('sha1').update(sceneFingerprint + '|' + [...states].sort().join('\n')).digest('hex').slice(0, 16);
            const dir = pathMod.join(root || '.', 'preview', '.work', 'scene-cache');
            fsMod.mkdirSync(dir, { recursive: true });
            const pngName = `${key}.png`, jsonName = `${key}.json`;
            const pngPath = pathMod.join(dir, pngName), jsonPath = pathMod.join(dir, jsonName);
            if (!fsMod.existsSync(pngPath)) fsMod.writeFileSync(pngPath, out.png);
            // 形状与 data/assets.js **完全一致**（blockstates / models / textures），这样前端同一个 buildResources 直接吃
            if (!fsMod.existsSync(jsonPath)) fsMod.writeFileSync(jsonPath, JSON.stringify({ blockstates: out.blockstates, models: out.models, textures: out.uv }));
            const missingAll = out.missing || [];
            console.log(`[api] /api/scene ${states.length} 个状态 → ${out.stats.atlas} / ${(out.png.length / 1024).toFixed(0)} KB（${key}）`);
            sendJson(res, 200, {
              key,
              atlas: `/preview/.work/scene-cache/${pngName}`,
              assets: `/preview/.work/scene-cache/${jsonName}`,
              stats: out.stats,
              defaults: out.defaults || {},
              flags: out.flags || null,
              unknownStates: out.unknownStates || [],
              missing: missingAll.slice(0, 20),
              // ★ 截断标记（审核员 U4）：与功能包后端同一口径，前端据此显黄条（静默截断 = 看着正常、结果少了）
              truncated: { states: rawStates.length - states.length, missing: missingAll.length - Math.min(missingAll.length, 20) },
            });
          } catch (e) {
            sendJson(res, 500, { error: '按需打包失败: ' + (e && e.message ? e.message : String(e)) });
          }
        })();
        return true;
      }

      return false;
    },
  };
}

export default createPreviewApi;
