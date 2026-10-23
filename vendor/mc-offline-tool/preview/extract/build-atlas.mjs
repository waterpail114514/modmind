// build-atlas.mjs —— 用**修好的**流水线重建 Deepslate 三件套（assets.js / atlas.png / opaque.js）
//
// 这是 `extract/build-assets3.py` 的替代实现（本机 Python 是商店占位程序，跑不了那条）：
//   · 修掉了"引用过滤只认带命名空间的引用"与"去重丢掉其余路径"两个 bug（见 ../scene-assets.mjs 头注释）；
//   · 贴图收 textures/ 下**全部类别**；图集尺寸取**恰好装得下的 2 的幂**（Deepslate 硬要求）。
//
// 用法：
//   node preview/extract/build-atlas.mjs --all                  # 全量（= 旧的预打包，写入 preview/data）
//   node preview/extract/build-atlas.mjs --states "minecraft:grass_block[snowy=false],…" --out <目录>
//   node preview/extract/build-atlas.mjs --all --instance "E:/mc/.minecraft/versions/GregTech Leisure"
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSceneAssets } from '../scene-assets.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
// ⚠ 必须用 fileURLToPath：`new URL(import.meta.url).pathname` 是 **URL 编码**过的，
//   含中文的路径会变成 `AI%E5%B7%A5...` 这种"字面名字"的目录，产物会写错地方（踩过一次）。
const here = path.dirname(fileURLToPath(import.meta.url))
const PREV = path.resolve(here, '..')
const OUT = arg('--out', path.join(PREV, 'data'))
const MC = arg('--mc', 'E:/mc/.minecraft')

function findInstance() {
  const explicit = arg('--instance')
  if (explicit) return explicit
  const versions = path.join(MC, 'versions')
  if (!fs.existsSync(versions)) throw new Error('找不到 versions 目录：' + versions)
  const cands = fs.readdirSync(versions).map((n) => path.join(versions, n))
    .filter((d) => fs.existsSync(path.join(d, 'mods')) && fs.readdirSync(d).some((f) => f.endsWith('.jar')))
  if (!cands.length) throw new Error('versions 下没有"含 mods/ 与客户端 jar"的实例')
  return cands.find((d) => /GregTech/i.test(d)) || cands[0]
}

const instanceDir = findInstance()
console.log(`实例：${instanceDir}`)
const scene = createSceneAssets({ instanceDir, mcDir: MC, log: (m) => console.log('  ' + m) })

const states = arg('--states')
const t0 = Date.now()
const out = argv.includes('--all') || !states
  ? scene.buildAll()
  : scene.buildForStates(states.split(',').map((s) => s.trim()).filter(Boolean))
console.log(`解析+打包 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`  ${JSON.stringify(out.stats)}`)
if (out.missing.length) {
  console.log(`  缺贴图 ${out.missing.length}（源里没有 / 解码失败）：`)
  for (const m of out.missing.slice(0, 10)) console.log('    ✗ ' + m)
}
if (out.failed.length) { console.log(`  ⚠ 图集装不下 ${out.failed.length} 张：` + out.failed.slice(0, 5).join(', ')); }

fs.mkdirSync(OUT, { recursive: true })
const bak = path.join(PREV, '.work', 'backup-atlas')
fs.mkdirSync(bak, { recursive: true })
for (const [f, name] of [['assets.js', 'before-pipeline-assets.js'], ['atlas.png', 'before-pipeline-atlas.png']]) {
  const src = path.join(OUT, f)
  if (fs.existsSync(src) && !fs.existsSync(path.join(bak, name))) { fs.copyFileSync(src, path.join(bak, name)); console.log(`  备份 ${name}`) }
}
fs.writeFileSync(path.join(OUT, 'assets.js'), 'window.__ASSETS__=' + JSON.stringify({ blockstates: out.blockstates, models: out.models, textures: out.uv }) + ';')
fs.writeFileSync(path.join(OUT, 'atlas.png'), out.png)
// opaque.js：把"半透明方块"表一起写出来（不设它会把半透明方块当不透明渲染 ⇒ 互相错误遮挡、"贴图消失"）
if (out.flags) {
  fs.writeFileSync(path.join(OUT, 'opaque.js'),
    'window.__OPAQUE__=' + JSON.stringify({ opaque: out.flags.opaque || [], nonSelfCulling: out.flags.nonSelfCulling || [], transparent: out.flags.transparent || [] }) + ';\n')
  console.log(`半透明方块 ${out.flags.transparent.length} 个（opaque.js）`)
  // O1：开面剔除侧车（全量 opaque id 表）。按需打包时 scene-assets.mjs 直接查它——
  //   按需路径的贴图 alpha 只是子集，现场算会把"非默认态贴图未入包"误判成缺失（furnace 实测被误排）。
  if (argv.includes('--all') || !states) {
    fs.writeFileSync(path.join(OUT, 'registry-opaque.json'), JSON.stringify(out.flags.opaque || []))
    console.log(`开面剔除表 ${(out.flags.opaque || []).length} 个（registry-opaque.json）`)
  }
}
console.log(`写出 → ${path.join(OUT, 'assets.js')} ${(fs.statSync(path.join(OUT, 'assets.js')).size / 1048576).toFixed(2)} MB`)
console.log(`写出 → ${path.join(OUT, 'atlas.png')}  ${out.stats.atlas}  ${(fs.statSync(path.join(OUT, 'atlas.png')).size / 1048576).toFixed(2)} MB`)
