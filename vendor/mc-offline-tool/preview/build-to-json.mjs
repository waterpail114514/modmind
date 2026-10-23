// build-to-json.mjs —— 把「任何建筑文件」转成页面要的统一 JSON。
//
// 为什么需要它：Deepslate 渲染页原来只吃 MC 结构 .nbt（在浏览器里用 DecompressionStream + NbtFile 解）。
// 而验收②要求"换一个 .litematic 也显示" —— litematic / schem 的解析在 Node 侧（`src/schem-reader.mjs`）已经写好，
// 所以走"先转 JSON、页面只吃 JSON"这一条路径：解析只在 Node 一处，浏览器侧零解析代码。
//
// 输出形状**刻意与「MC 结构 .nbt 在浏览器里解出来的形状」逐字段一致**：
//   { format, name, size:[x,y,z], palette:[{Name,Properties}], blocks:[{pos:[x,y,z],state:i}], stats }
// ⇒ preview/main.js 的放置循环（读 size/palette/blocks）一行都不用改。
//
// 用法：
//   node preview/build-to-json.mjs preview/data/default.nbt              # 默认写 preview/data/build.json
//   node preview/build-to-json.mjs <某个>.litematic --out preview/data/build.json
import fs from 'node:fs'
import path from 'node:path'
import { readBuildFile } from '../src/schem-reader.mjs'

const argv = process.argv.slice(2)
const input = argv.find((a) => !a.startsWith('--'))
if (!input) {
  console.error('用法: node preview/build-to-json.mjs <建筑文件> [--out preview/data/build.json]')
  process.exit(2)
}
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : path.join(import.meta.dirname, 'data', 'build.json')

const buf = fs.readFileSync(input)
const r = readBuildFile(buf, path.basename(input))

// 兼容两种形状：schem-reader 主路径给 {x,y,z} / {x,y,z,p}，`.nbt` 结构路径给数组 / {pos,state}
const n = (v) => Number(typeof v === 'bigint' ? v : v)
const size = Array.isArray(r.size) ? r.size.map(n) : [n(r.size.x), n(r.size.y), n(r.size.z)]
const palette = (r.palette || []).map((p) => ({ Name: p.Name ?? p.id, Properties: p.Properties ?? p.props ?? {} }))
const blocks = (r.blocks || []).map((b) => ({
  pos: b.pos ? b.pos.map(n) : [n(b.x), n(b.y), n(b.z)],
  state: n(b.state ?? b.p),
}))

const payload = { format: r.format, name: r.name, size, palette, blocks, stats: r.stats, source: path.basename(input) }
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(payload))

const kb = (fs.statSync(outPath).size / 1024).toFixed(0)
console.log(`[build-to-json] ${path.basename(input)}`)
console.log(`  format    : ${r.format}    name: ${r.name}`)
console.log(`  尺寸      : ${size.join(' × ')}    方块: ${blocks.length}    调色板: ${palette.length}`)
console.log(`  stats     : ${JSON.stringify(r.stats)}`)
console.log(`  → ${outPath}  (${kb} KB)`)
