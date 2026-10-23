// zipread.mjs —— 零依赖 zip 读取（只用 node:zlib），只为从本机 jar 里取出少量条目。
//
// 不装依赖的原因同 png.mjs：本机取不到外网。实现很窄：从 EOCD 找到中央目录，按名查条目，
// 再按本地头定位数据，stored/deflate 两种方式解压。不支持 ZIP64 —— 我们要读的都是 10~25 MB 的 jar。

import zlib from 'node:zlib';

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('EOCD not found (not a zip, or ZIP64)');
}

/** 返回 [{name, method, compressedSize, size, localOffset}] */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central directory at ' + pos);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    out.push({ name, method, compressedSize, size, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取单个条目的内容（Buffer），名字用正斜杠；找不到返回 null */
export function readEntry(buf, name) {
  const target = name.replace(/\\/g, '/');
  const e = listEntries(buf).find((x) => x.name.replace(/\\/g, '/') === target);
  if (!e) return null;
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('bad local header for ' + name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip method ' + e.method + ' for ' + name);
}
