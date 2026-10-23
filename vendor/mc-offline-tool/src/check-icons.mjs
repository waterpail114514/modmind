// check-icons.mjs —— A7「平面图标独立基准比对」（P1 判据 ⑤ 的实现）
//
// 判据：平面物品的图标，应当等于「游戏原始贴图」按最近邻放大 pxPerTexel 倍的结果。
// 基准的独立性：基准来自 app/data/game/<ns>/textures/... —— **游戏自己的贴图文件**，
//   不是 pull 产出的图标，因此这次比对能独立地检验 pull 的图标光栅化有没有错。
//
// 用法: node src/check-icons.mjs [--limit N] [--show N]
// 退出码: 比对到样本且 0 处差异 -> 0；有差异 -> 1；无法比对（基准缺失）-> 2
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = path.join(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'app', 'data')
const argv = process.argv.slice(2)
const limit = Number((argv[argv.indexOf('--limit') + 1] || '0')) || 0
const show = Number((argv[argv.indexOf('--show') + 1] || '8')) || 8

// ---------------------------------------------------------------- PNG 解码（8 位）
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bd = 8, ct = 0, plte = null, trns = null
  const idat = []
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const d = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9] }
    else if (type === 'PLTE') plte = d
    else if (type === 'tRNS') trns = d
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bd !== 8) return null
  const chan = ct === 6 ? 4 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 0 ? 1 : ct === 4 ? 2 : 0
  if (!chan) return null
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * chan
  const out = Buffer.alloc(h * stride)
  let o = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[o++]
    const line = raw.subarray(o, o + stride); o += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= chan ? cur[x - chan] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= chan) ? prev[x - chan] : 0
      let v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 255
    }
  }
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    let r, g, bl, al = 255
    if (ct === 6) { r = out[i * 4]; g = out[i * 4 + 1]; bl = out[i * 4 + 2]; al = out[i * 4 + 3] }
    else if (ct === 2) { r = out[i * 3]; g = out[i * 3 + 1]; bl = out[i * 3 + 2] }
    else if (ct === 0) { r = g = bl = out[i] }
    else if (ct === 4) { r = g = bl = out[i * 2]; al = out[i * 2 + 1] }
    else { const k = out[i] * 3; r = plte[k]; g = plte[k + 1]; bl = plte[k + 2]; if (trns && out[i] < trns.length) al = trns[out[i]] }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = bl; rgba[i * 4 + 3] = al
  }
  return { w, h, ct, rgba }
}

// ---------------------------------------------------------------- 主流程
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'items.json'), 'utf8'))
const { ids, block, icons, pxPerTexel: k } = meta
console.log(`  items.json: ${ids.length} 件，iconPx ${meta.iconPx}，pxPerTexel ${k}`)

// 平面物品 = block[i] === false
const flats = []
for (let i = 0; i < ids.length; i++) if (block[i] === false) flats.push(i)
console.log(`  平面物品（block=false）: ${flats.length} 件`)

let tested = 0, exact = 0, diff = 0, noBaseline = 0, badPng = 0, noIcon = 0
const samples = []
const pathStats = {}

for (const i of flats) {
  if (limit && tested >= limit) break
  const id = ids[i]
  const [ns, name] = id.split(':')
  // 候选基准路径（游戏原始贴图）
  const cands = [
    path.join(DATA, 'game', ns, 'textures', 'item', name + '.png'),
    path.join(DATA, 'game', ns, 'textures', 'block', name + '.png'),
    path.join(DATA, 'game', ns, 'textures', 'items', name + '.png')
  ]
  const base = cands.find(p => fs.existsSync(p))
  if (!base) { noBaseline++; pathStats['基准缺失'] = (pathStats['基准缺失'] || 0) + 1; continue }
  const icoPath = path.join(DATA, 'icons', icons[i])
  if (!fs.existsSync(icoPath)) { noIcon++; continue }

  let b, o
  try { b = decodePNG(fs.readFileSync(base)) } catch { badPng++; continue }
  try { o = decodePNG(fs.readFileSync(icoPath)) } catch { badPng++; continue }
  if (!b || !o) { badPng++; continue }

  // 期望：贴图最近邻放大 k 倍
  const ew = b.w * k, eh = b.h * k
  tested++
  if (o.w !== ew || o.h !== eh) {
    diff++
    if (samples.length < show) samples.push({ id, why: `尺寸不符 期望 ${ew}x${eh} 实际 ${o.w}x${o.h}`, base })
    continue
  }
  let bad = 0
  for (let y = 0; y < eh; y++) {
    const sy = (y / k) | 0
    for (let x = 0; x < ew; x++) {
      const sx = (x / k) | 0
      const bi = (sy * b.w + sx) * 4, oi = (y * ew + x) * 4
      if (b.rgba[bi] !== o.rgba[oi] || b.rgba[bi + 1] !== o.rgba[oi + 1] ||
          b.rgba[bi + 2] !== o.rgba[oi + 2] || b.rgba[bi + 3] !== o.rgba[oi + 3]) { bad++; if (bad > 64) break }
    }
  }
  if (bad === 0) exact++
  else { diff++; if (samples.length < show) samples.push({ id, why: `像素差异 ${bad > 64 ? '>64' : bad} 处`, base }) }
}

console.log('')
console.log(`  可比对 ${tested} 件  完全一致 ${exact}  有差异 ${diff}`)
console.log(`  基准缺失 ${noBaseline}  图标缺失 ${noIcon}  PNG 不可解 ${badPng}`)
if (samples.length) {
  console.log('  差异样例:')
  for (const s of samples) console.log(`    ${s.id}  ${s.why}\n      基准 ${s.base.slice(ROOT.length + 1)}`)
}
console.log('')
if (tested === 0) { console.log('  判定: 无法比对（基准缺失），判据未达成'); process.exit(2) }
console.log(diff === 0 ? `  判定: 通过（${exact}/${tested} 完全一致，0 处差异）` : `  判定: 未通过（${diff} 件有差异）`)
process.exit(diff === 0 ? 0 : 1)
