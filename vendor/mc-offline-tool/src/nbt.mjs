// nbt.mjs —— 零依赖 NBT 读取（大端 + gzip/zlib 解压），供建筑文件解析用
//
// 为什么自己写：本机取不到外网（D021 已确认 npm/pip 装不了），而这个项目一贯零依赖。
// NBT 的格式很小，读一遍规范约 150 行即可覆盖全部 13 种 tag。
//
// 用途：.litematic / .schem / .schematic / .nbt(structure) 四种建筑文件都是「gzip 包的 NBT」，
// 差别只在里面的字段名与方块编码方式，读层共用这一个模块。

import zlib from 'node:zlib';

export const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u1() { return this.b[this.p++]; }
  i1() { const v = this.b.readInt8(this.p); this.p += 1; return v; }
  i2() { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  i4() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  i8() {
    // 用 BigInt 读，再按需要降级：NBT 的 Long 常被用作位数组容器，不能丢精度
    const v = this.b.readBigInt64BE(this.p); this.p += 8; return v;
  }
  f4() { const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  f8() { const v = this.b.readDoubleBE(this.p); this.p += 8; return v; }
  str() { const n = this.b.readUInt16BE(this.p); this.p += 2; const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.BYTE: return r.i1();
    case TAG.SHORT: return r.i2();
    case TAG.INT: return r.i4();
    case TAG.LONG: return r.i8();
    case TAG.FLOAT: return r.f4();
    case TAG.DOUBLE: return r.f8();
    case TAG.BYTE_ARRAY: { const n = r.i4(); return r.bytes(n); }
    case TAG.STRING: return r.str();
    case TAG.LIST: {
      const itemType = r.u1();
      const n = r.i4();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readPayload(r, itemType);
      return out;
    }
    case TAG.COMPOUND: {
      const out = {};
      for (;;) {
        const t = r.u1();
        if (t === TAG.END) break;
        const name = r.str();
        out[name] = readPayload(r, t);
      }
      return out;
    }
    case TAG.INT_ARRAY: { const n = r.i4(); const out = new Int32Array(n); for (let i = 0; i < n; i++) out[i] = r.i4(); return out; }
    case TAG.LONG_ARRAY: { const n = r.i4(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = r.i8(); return out; }
    default: throw new Error('未知的 NBT tag 类型: ' + type);
  }
}

/** 解析 NBT 字节流 -> { name, value } */
export function parseNbt(buf) {
  const r = new Reader(buf);
  const type = r.u1();
  if (type === TAG.END) return { name: '', value: {} };
  const name = r.str();
  return { name, value: readPayload(r, type) };
}

/** 自动识别 gzip / zlib / 裸 NBT。建筑文件基本都是 gzip。 */
export function maybeDecompress(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  // zlib 头：0x78 开头
  if (buf.length >= 2 && buf[0] === 0x78) {
    try { return zlib.inflateSync(buf); } catch { /* 落到裸 NBT */ }
  }
  return buf;
}

/** 一步到位：从文件字节读出 NBT 根 compound */
export function readNbtFile(buf) {
  return parseNbt(maybeDecompress(buf));
}

/**
 * 把 packed long 数组按 bits 位解包成整数数组。
 *
 * 有两种排布，必须区分（选错会得到完全错的方块）：
 *   - spanning：一个值可以跨两个 long（MC 1.15 及更早 / Litematica 沿用）
 *   - nonSpanning：每个 long 内独立对齐（MC 1.16+ 的调色板容器）
 * 本函数实现的是 **spanning**，因为 .litematic 用的是这一种。
 */
export function unpackLongsSpanning(longs, bits, count) {
  const out = new Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  const total = BigInt(longs.length) * 64n;
  for (let i = 0; i < count; i++) {
    const start = BigInt(i) * BigInt(bits);
    if (start + BigInt(bits) > total) { out[i] = 0; continue; }
    const startLong = Number(start / 64n);
    const startOff = Number(start % 64n);
    let v;
    if (startOff + bits <= 64) {
      v = (longs[startLong] >> BigInt(startOff)) & mask;
    } else {
      // ★ 跨 long 边界时的两个坑（2026-10-10 修）：
      //   ① LongArray 是有符号 BigInt，直接 `>>` 会做算术右移把符号位带进来 ——
      //      先 `BigInt.asUintN(64, …)` 转成无符号，位移才是逻辑右移；
      //   ② 低位片段只能取 `take = 64 - startOff` 位，不能取满 `bits` 位 ——
      //      否则它与高位片段在 take..bits-1 上重叠，OR 之后会把越界值带进来。
      const take = 64 - startOff;
      const lo = (BigInt.asUintN(64, longs[startLong]) >> BigInt(startOff)) & ((1n << BigInt(take)) - 1n);
      const hi = (BigInt.asUintN(64, longs[startLong + 1]) & ((1n << BigInt(bits - take)) - 1n)) << BigInt(take);
      v = lo | hi;
    }
    out[i] = Number(v);
  }
  return out;
}

/** nonSpanning 版本（每 long 内独立，MC 1.16+）。留作对照与将来支持其它格式。 */
export function unpackLongsNonSpanning(longs, bits, count) {
  const per = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const li = Math.floor(i / per);
    const off = BigInt((i % per) * bits);
    out[i] = li < longs.length ? Number((longs[li] >> off) & mask) : 0;
  }
  return out;
}
