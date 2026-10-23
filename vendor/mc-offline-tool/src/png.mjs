// png.mjs —— 零依赖 PNG 编解码（只用 node:zlib）
//
// 为什么自己写：本机 npm 取不到外网（实测连外网超时），装不了 pngjs/sharp。
// 需求又很窄：①读游戏导出的截图（NativeImage 写出的 RGBA8 / RGB8，非隔行）
// ②写 16x16 的图标 PNG（RGBA8）。自己实现约 150 行，且不引入任何依赖，离线可复现。

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** 每个通道的字节数（按 colorType 推） */
function channelsOf(colorType) {
  switch (colorType) {
    case 0: return 1; // gray
    case 2: return 3; // rgb
    case 3: return 1; // palette (index)
    case 4: return 2; // gray+alpha
    case 6: return 4; // rgba
    default: throw new Error('unsupported PNG colorType ' + colorType);
  }
}

/**
 * 解码 PNG -> { width, height, data: Buffer(RGBA8) }
 * 仅支持 bitDepth=8、非隔行；这两点是 NativeImage 与常规工具的输出形态。
 */
export function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
  }
  if (![1, 2, 4, 8].includes(bitDepth)) throw new Error('unsupported PNG bitDepth ' + bitDepth);

  const ch = channelsOf(colorType);
  // ★ 2026-10-10 扩展一：原版 Minecraft 贴图有相当一部分是 **4/2/1-bit 索引图**（colorType 3），
  //   旧版这里直接 throw，导致补图集时解不了那 155 张。下面按 PNG 规范同时支持 <8bit：
  //   · 行字节数 = ceil(宽 × 每像素位数 / 8)；
  //   · 反滤波的"每像素字节"= max(1, 每像素位数 >> 3)（规范 9.2，<8bit 时按 1 字节）；
  //   · 取下标：行内按位打包，每个字节高位在前。
  // ★ 扩展二：支持 **Adam7 隔行**（`interlace=1`）。实测 `gtlcore:…fuel_rod_assembly_base` 与
  //   `usclb:item/clipboard` 就是隔行图，旧版直接 throw ⇒ 全量图集里最后 2 张"缺贴图"就是它俩。
  const bppBits = ch * bitDepth;
  const maxIdx = (1 << bitDepth) - 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);

  /** 解一个 pass（非隔行时就是整张图）。offset 为它在 raw 里的起始位置，返回消费后的位置。 */
  function runPass(offset, pw, ph, x0, dx, y0, dy) {
    if (pw <= 0 || ph <= 0) return offset;
    const stride = Math.ceil((pw * bppBits) / 8);
    const fbpp = Math.max(1, bppBits >> 3);
    const cur = Buffer.alloc(stride);
    const prev = Buffer.alloc(stride);
    let p = offset;
    for (let y = 0; y < ph; y++) {
      const filter = raw[p++];
      raw.copy(cur, 0, p, p + stride);
      p += stride;
      // 反滤波（PNG 规范 9.2）
      for (let i = 0; i < stride; i++) {
        const a = i >= fbpp ? cur[i - fbpp] : 0;
        const b = prev[i];
        const c = i >= fbpp ? prev[i - fbpp] : 0;
        switch (filter) {
          case 0: break;
          case 1: cur[i] = (cur[i] + a) & 0xff; break;
          case 2: cur[i] = (cur[i] + b) & 0xff; break;
          case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
          case 4: {
            const pp = a + b - c;
            const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
            const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            cur[i] = (cur[i] + pr) & 0xff;
            break;
          }
          default: throw new Error('bad PNG filter ' + filter);
        }
      }
      // 展开成 RGBA（写到整图的对应像素上）
      const oy = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const d = (oy * width + x0 + x * dx) * 4;
        if (bitDepth < 8) {
          const bit = x * bitDepth;
          const v = (cur[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxIdx;
          if (colorType === 3) {
            const i3 = v * 3;
            out[d] = palette[i3]; out[d + 1] = palette[i3 + 1]; out[d + 2] = palette[i3 + 2];
            out[d + 3] = trns && v < trns.length ? trns[v] : 255;
          } else {
            const g = Math.round((v * 255) / maxIdx);
            out[d] = out[d + 1] = out[d + 2] = g; out[d + 3] = 255;
          }
          continue;
        }
        const s = x * ch;
        switch (colorType) {
          case 0: out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; break;
          case 2: out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; break;
          case 3: {
            const i3 = cur[s] * 3;
            out[d] = palette[i3]; out[d + 1] = palette[i3 + 1]; out[d + 2] = palette[i3 + 2];
            out[d + 3] = trns && cur[s] < trns.length ? trns[cur[s]] : 255;
            break;
          }
          case 4: out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; break;
          case 6: out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; break;
        }
      }
      cur.copy(prev);
    }
    return p;
  }

  if (interlace === 0) {
    runPass(0, width, height, 0, 1, 0, 1);
  } else if (interlace === 1) {
    // Adam7：7 个 pass，每个都有自己的扫描线序列（各自独立滤波）
    const X0 = [0, 4, 0, 2, 0, 1, 0];
    const Y0 = [0, 0, 4, 0, 2, 0, 1];
    const DX = [8, 8, 4, 4, 2, 2, 1];
    const DY = [8, 8, 8, 4, 4, 2, 2];
    let off = 0;
    for (let i = 0; i < 7; i++) {
      const pw = Math.ceil(Math.max(0, width - X0[i]) / DX[i]);
      const ph = Math.ceil(Math.max(0, height - Y0[i]) / DY[i]);
      off = runPass(off, pw, ph, X0[i], DX[i], Y0[i], DY[i]);
    }
  } else {
    throw new Error('unsupported PNG interlace ' + interlace);
  }
  return { width, height, data: out };
}

/**
 * 把 RGBA8 编码为 PNG（colorType 6）。
 * ★ 2026-10-10（大图）：原来所有行都用 filter 0，导致 8192² 图集重编码后从 30.5 MB 涨到 41 MB。
 *   改成按行在 filter **0（不滤）与 2（Up，减去上一行）**里取"绝对值和更小"的那个 ——
 *   图集这种"大片透明 + 逐行高度相关"的数据，Up 通常好得多。
 * ★ 2026-10-10（小图，审核员 P3-1/O10）：这套"择优"判据是**绝对值和**，不等于 deflate 之后的体积。
 *   实测同一批 1,330 张 **48×48 图标**：择优版 1,461,985 B vs 纯 filter 0 版 1,017,276 B —— **大了 43%**。
 *   所以按尺寸分流：**max(宽,高) < 128 的图（图标）不做择优，直接 filter 0**；大图（图集）才择优。
 *   `opts.pickBest` 可显式覆盖（自测要拿两种策略对打）。
 */
export function encodeRGBA(width, height, rgba, opts) {
  const pickBest = opts && opts.pickBest !== undefined ? !!opts.pickBest : Math.max(width, height) >= 128;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const o = y * stride;
    const prev = y > 0 ? o - stride : o;
    let s0 = 0, s2 = 0;
    for (let i = 0; i < stride; i++) {
      const a = rgba[o + i];
      s0 += a < 128 ? a : 256 - a;
      const b = (a - (y > 0 ? rgba[prev + i] : 0)) & 0xff;
      cand[i] = b;
      s2 += b < 128 ? b : 256 - b;
    }
    const dst = y * (stride + 1);
    if (pickBest && s2 < s0) { raw[dst] = 2; cand.copy(raw, dst + 1); }
    else { raw[dst] = 0; rgba.copy(raw, dst + 1, o, o + stride); }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
