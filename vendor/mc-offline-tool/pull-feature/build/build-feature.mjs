// build/build-feature.mjs —— 把「游戏数据采集」后端 + 轻量渲染入口打成 `.mmfeature`
// 打包逻辑直接复用 preview-feature 的 pack.cjs（同一套宿主口径回验）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { packFeature } from '../../preview-feature/build/pack.cjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(here, '..')
const TOOL = path.resolve(PKG, '..')

// ---------- 0) 语法层机械自检：违反即**构建失败**（审核员 §5-C-2）----------
{
  const lint = path.join(TOOL, 'tools', 'lint-source.mjs')
  if (fs.existsSync(lint)) {
    // ★ 传入**本包**的 src 目录（默认只扫 preview/src ⇒ 本包改动的 jsx 会被漏掉）
    const r = spawnSync(process.execPath, [lint, path.join(PKG, 'src')], { stdio: 'inherit' })
    if (r.status !== 0) { console.error('构建中止：源码自检未通过（见上）'); process.exit(1) }
  } else {
    console.warn('⚠ 找不到 tools/lint-source.mjs，跳过源码自检')
  }
}
const DIST = path.join(PKG, 'dist')

// esbuild 从既有依赖里借（本工具没有 npm 工程）。
// 注：2026-10-10 归档后，交接源码树挪到了 `E:\AI工作台\归档\2026-10-10-旧项目归档\` 下，所以路径跟着改。
const CANDIDATES = [
  path.join(TOOL, 'tools/node_modules/esbuild/package.json'),
  path.join(TOOL, 'app/package.json'),
  'E:/AI工作台/归档/2026-10-10-旧项目归档/旧项目/ModMind-1.5.0-新交接包/源码/modmind-src/package.json',
  'E:/AI工作台/旧项目/ModMind-1.5.0-新交接包/源码/modmind-src/package.json',
]
let esbuild = null
for (const c of CANDIDATES) {
  if (!fs.existsSync(c)) continue
  try { esbuild = createRequire(c)('esbuild'); break } catch { /* 换下一个 */ }
}
if (!esbuild) throw new Error('找不到 esbuild')

fs.mkdirSync(DIST, { recursive: true })

// 面板样式：**单一来源**是 `src/pull.css`。它被内联进 renderer.js（挂进 Shadow DOM），
// 而宿主注入的 `renderer.css` 只留最小作用域兜底（宿主会把它插在自己样式之前，优先级更低）。
const cssSrc = fs.readFileSync(path.join(PKG, 'src/pull.css'), 'utf8')
fs.writeFileSync(path.join(PKG, 'src/css.generated.js'),
  '// 由 build-feature.mjs 从 src/pull.css 抽出（不要手改）\nexport const CSS = ' + JSON.stringify(cssSrc) + ';\n')

// legalComments:'eof'：与 preview 包保持一致（保留上游法律注释；本包不打包第三方代码，无副作用）
const common = { bundle: true, logLevel: 'warning', sourcemap: false, legalComments: 'eof' }

await esbuild.build({
  ...common,
  absWorkingDir: TOOL,
  entryPoints: [path.join(PKG, 'src/feature-entry.jsx')],
  outfile: path.join(DIST, 'renderer.js'),
  format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
await esbuild.build({
  ...common,
  absWorkingDir: TOOL,
  entryPoints: [path.join(PKG, 'backend/main.js')],
  outfile: path.join(DIST, 'main.cjs'),
  format: 'cjs', platform: 'node', target: 'node22',
})
console.log(`renderer.js ${(fs.statSync(path.join(DIST, 'renderer.js')).size / 1024).toFixed(0)} KB`)
console.log(`main.cjs     ${(fs.statSync(path.join(DIST, 'main.cjs')).size / 1024).toFixed(0)} KB`)

// 宿主硬要求：`manifest.style` 必须恰好是 `renderer.css`，且**包里必须有这个条目**
// （`validate()` 里 `main/renderer/style` 三者缺一 ⇒ 抛「插件入口无效」；文件清单里缺 ⇒ 抛「插件文件清单无效」）。
// 本包的界面全部走内联样式，所以这里只放最小作用域的规则，不碰宿主自身的 UI。
const CSS = `/* mc-pull —— 界面全部使用内联样式；这里仅保留最小作用域的兜底规则。
   宿主把 renderer.css 注入在它自己的样式之前（优先级更低），所以规则必须自带选择器。 */
.mcpull-root { box-sizing: border-box; height: 100%; overflow: auto; }
.mcpull-root * { box-sizing: border-box; }
`
fs.writeFileSync(path.join(DIST, 'renderer.css'), CSS)
console.log(`renderer.css  ${CSS.length} B`)

packFeature({ pkgDir: PKG, distDir: DIST })
