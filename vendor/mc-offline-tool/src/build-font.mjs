// build-font.mjs —— 从原版 Unifont 数据里只抽出「物品名实际用到」的 CJK 字形
//
// 为什么需要：原版 font/ascii.png 只覆盖 ASCII 与少量符号，CJK 由 GNU Unifont 提供
// （assets/minecraft/font/unifont.zip 里的 .hex）。把整个 .hex 塞进前端太重，
// 这里先扫一遍物品名，收集出现过的码点，只导出这些字形。
//
// 输出：app/data/font/glyphs.js  ->  window.MC_GLYPHS = { size, ascent, glyphs: { "4e2d": {w,h,hex} } }
//
// 用法：node build-font.mjs --zip <unifont.zip> --items <app/data/items.json> --out <app/data/font>

import fs from 'node:fs';
import path from 'node:path';
import { listEntries, readEntry } from './zipread.mjs';
import { decode } from './png.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const zipPath = path.resolve(args.zip || '');
const itemsPath = path.resolve(args.items || 'app/data/items.json');
const asciiPath = path.resolve(args.ascii || 'app/data/font/ascii.png');
const outDir = path.resolve(args.out || 'app/data/font');

const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));

// 1. 收集需要渲染的码点：物品名里所有非 ASCII 字符
const needed = new Set();
for (const n of items.names || []) {
  for (const ch of String(n)) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7e || cp < 0x20) needed.add(cp);
  }
}
// 一并带上常用界面词与数字符号，避免 UI 文案缺字
for (const ch of '0123456789 ×/·-+():：，。、物品栏背包快捷已选择数量搜索清空全部共个格') {
  needed.add(ch.codePointAt(0));
}

// 2. 从 zip 里取 .hex
const z = fs.readFileSync(zipPath);
const hexEntry = listEntries(z).find((e) => e.name.toLowerCase().endsWith('.hex'));
if (!hexEntry) throw new Error('unifont.zip 内没有 .hex 条目');
const hexText = readEntry(z, hexEntry.name).toString('latin1');

// 3. 解析 .hex：<码点十六进制>:<位图十六进制>，位图 32 字符 = 8 宽，64 字符 = 16 宽，每行 8 或 16 像素
const glyphs = {};
let found = 0;
const missing = [];
for (const line of hexText.split(/\r?\n/)) {
  const i = line.indexOf(':');
  if (i < 0) continue;
  const cp = parseInt(line.slice(0, i), 16);
  if (!needed.has(cp)) continue;
  const hex = line.slice(i + 1).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex)) continue;
  const bits = hex.length * 4;
  const w = bits % 16 === 0 && hex.length === 64 ? 16 : 8;
  const h = bits / w;
  glyphs[cp.toString(16)] = { w, h, hex: hex.toLowerCase() };
  found++;
}

const absent = [...needed].filter((cp) => !glyphs[cp.toString(16)]);
for (const cp of absent.slice(0, 40)) missing.push('U+' + cp.toString(16).toUpperCase());

// Unifont 的 16 行字形，基线在第 14 行（descender 2 行）。MC 的 unicode 字体按 ascent 取值，
// 这里取 ascent = 14 - 2 = 12? 说明：GNU Unifont 约定 baseline 位于第 14 行（自顶 0 计），
// 即上方 14 行、下方 2 行。前端按 ascent=14-descent 用，这里统一给出 ascent/descent 供前端使用。
const payload = {
  size: 16,
  ascent: 12,
  descent: 4,
  note: 'hex 为逐行位图；w=16 时每行 4 个十六进制字符，w=8 时每行 2 个。ascent 用于把字形对齐到基线。',
  source: hexEntry.name,
  needed: needed.size,
  found,
  absent,
  glyphs,
};

// ---------- ascii.png 的字格与步进 ----------
// 为什么在这里算：浏览器用 file:// 打开时，对本地图片 drawImage 之后再 getImageData 会因
// 「画布被污染」抛 SecurityError。所以把「裁剪列宽」这类需要读像素的信息在构建期算好，
// 前端只消费数字，永远不读像素。
//
// ascii.png 是 16x16 的等距字格；每个字的实际步进 = 裁掉右侧全空列后的宽度 + 1（字间距），
// 空格由 include/space.json 显式规定为 4。
const ASCII_ROWS = [
  ' !"#$%&\'()*+,-./',
  '0123456789:;<=>?',
  '@ABCDEFGHIJKLMNO',
  'PQRSTUVWXYZ[\\]^_',
  '`abcdefghijklmno',
  'pqrstuvwxyz{|}~\u0000',
];
const ascii = decode(fs.readFileSync(asciiPath));
const cellW = ascii.width / 16;
const cellH = ascii.height / 16;
const widths = {};
for (let r = 0; r < ASCII_ROWS.length; r++) {
  for (let c = 0; c < 16; c++) {
    const ch = ASCII_ROWS[r][c];
    if (!ch || ch === '\u0000') continue;
    const gridRow = r + 2;              // 见 include/default.json：0x20 落在第 2 行
    const ox = c * cellW, oy = gridRow * cellH;
    let last = -1;
    for (let x = 0; x < cellW; x++) {
      for (let y = 0; y < cellH; y++) {
        if (ascii.data[((oy + y) * ascii.width + ox + x) * 4 + 3] !== 0) { last = x; break; }
      }
    }
    const trimmed = last + 1;
    widths[ch.codePointAt(0)] = trimmed <= 0 ? 4 : trimmed + 1;
  }
}
widths[32] = 4;   // 空格（include/space.json）
payload.ascii = { cellW, cellH, ascent: 7, widths };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'glyphs.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(outDir, 'glyphs.js'), 'window.MC_GLYPHS = ' + JSON.stringify(payload) + ';\n');
console.log(JSON.stringify({ needed: needed.size, found, absentSample: missing, out: path.join(outDir, 'glyphs.js') }, null, 2));
