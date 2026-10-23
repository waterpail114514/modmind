// build/build-feature.mjs —— 把 preview/ 那套前端 + 后端打成 ModMind 功能包
//
// 产物（dist/）：
//   renderer.js    IIFE（无顶层 import/export）、自包含（deepslate/gl-matrix 打进来）、React 用宿主的
//   renderer.css   我们的样式（宿主会以 <link> 注入；真正生效的是入口里塞进 Shadow DOM 的那份）
//   main.cjs       CJS 后端（activate + 6 个 handler），自包含
//   <id>-<version>.mmfeature   ZIP 包（含 manifest.json 与逐文件 sha256）
//
// 用法：node preview-feature/build/build-feature.mjs [--no-pack]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(here, '..')                    // preview-feature/
const TOOL = path.resolve(PKG, '..')                    // mc-offline-tool/
const PREVIEW = path.join(TOOL, 'preview')
const SRC = path.join(PKG, 'src')
// ---------- 0) 语法层机械自检：违反即**构建失败** ----------
// 审核员 §5-C-2：19:00 实机事故（8 处 `vp.` 漏括号 → 228 条错误）一条命令就该暴露。
// 这里把它变成构建期的硬门槛 —— 不允许"改完就打包装机"。
{
  const lint = path.join(TOOL, 'tools', 'lint-source.mjs')
  if (fs.existsSync(lint)) {
    const r = spawnSync(process.execPath, [lint], { stdio: 'inherit' })
    if (r.status !== 0) { console.error('构建中止：源码自检未通过（见上）'); process.exit(1) }
  } else {
    console.warn('⚠ 找不到 tools/lint-source.mjs，跳过源码自检')
  }
}

const DIST = path.join(PKG, 'dist')

// esbuild 从既有依赖里借（本工具没有 npm 工程）。
// 注：2026-10-10 归档后，交接源码树挪到了 `E:\AI工作台\归档\2026-10-10-旧项目归档\` 下，所以路径跟着改；
// 最省事的做法是把 esbuild 复制到 `mc-offline-tool/tools/node_modules/`（下面第一个候选就是它），
// 这样本项目就不再依赖归档目录。
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
if (!esbuild) throw new Error('找不到 esbuild，试过：' + CANDIDATES.join(' / '))

fs.mkdirSync(DIST, { recursive: true })

// ---------- 1) 生成两个"从源文件抽出来的"模块（避免 html/css 两份拷贝）----------
const html = fs.readFileSync(path.join(PREVIEW, 'index.html'), 'utf8')
const bodyStart = html.indexOf('<body>')
const scriptStart = html.indexOf('<!-- 依赖')
const markup = html.slice(bodyStart + '<body>'.length, scriptStart >= 0 ? scriptStart : html.indexOf('<script')).trim()
if (!markup.includes('id="app"')) throw new Error('从 preview/index.html 里没抽到 #app 结构')
fs.writeFileSync(path.join(SRC, 'dom-template.generated.js'),
  '// 由 build-feature.mjs 从 preview/index.html 抽出（不要手改）\nexport const TEMPLATE = ' + JSON.stringify(markup) + ';\n')

// CSS：Shadow DOM 里没有 :root（那匹配的是 document 根），要换成 :host；100vh 也换成 100%
const cssRaw = fs.readFileSync(path.join(PREVIEW, 'app.css'), 'utf8')
const css = cssRaw
  .replace(/:root\s*\{/g, ':host{')
  // ⚠ 必须容忍冒号后的空格：`height:100vh` 与 `height: 100vh` 都要替换掉。
  //   漏了的话功能包里 `#app` 会按**整窗**高度撑开，直接溢出宿主给的那块容器（实测 838px vs 472px）。
  .replace(/height:\s*100vh/g, 'height:100%')
// ★ `.mcp-wrap` 是 shadow 里那层包裹 div（见 feature-entry.jsx）。它**必须**有确定高度，
//   否则 `#app{height:100%}` 的百分比会落到一个 height:auto 的父元素上 → 退回内容高度
//   ⇒ 功能包只占宿主容器上半截（实测 402.5px / 790px）。
const cssOut = ':host{display:block;height:100%;min-height:0;overflow:hidden}\n'
  + '.mcp-wrap{display:flex;flex-direction:column;height:100%;min-height:0}\n'
  + css + '\n.mcp-host{display:block;height:100%;min-height:0}\n'
fs.writeFileSync(path.join(SRC, 'css.generated.js'),
  '// 由 build-feature.mjs 从 preview/app.css 抽出（不要手改）\nexport const CSS = ' + JSON.stringify(cssOut) + ';\n')
fs.writeFileSync(path.join(DIST, 'renderer.css'), cssOut)

// ---------- 1.2) 内联「原版方块默认态」 ----------
// 为什么要内联：按需打包只收**当前建筑用到的 state**，而用户会从物品栏放**建筑里没有的**方块
//   （栅栏、按钮、玻璃板…）。功能包里 `registryDefaults` 是空的（包内没有侧车文件）、
//   按需打包成功时又不会落回预打包 ⇒ `window.__ASSETS__` 也不加载
//   ⇒ 拿不到默认态 ⇒ 状态推断无从下手 ⇒ 放下去的栅栏仍是孤柱、按钮仍浮空（就是用户报的那个 bug）。
// 为什么只内联**原版**：原版 642 个只要 45 KB；全量（含 mod）4182 个要 243 KB，
//   其中 2228 个是靠 facing 判出来的 mod 方块（多为自定义渲染的机器，朝向不影响"连接"）。
//   mod 方块仍由后端 scene 兜底（异步、一次性）。
// 为什么连"看起来没用"的原版方块也要带上：**"已知它没有属性"和"还不知道"是两种状态**。
//   实测踩过：stone 的默认态是 `{}` ⇒ 旧判断"props 非空才算已知"永远为假 ⇒ 每次放置都去 await 后端
//   ⇒ `actAt` 变成异步 ⇒ 拖拽时 pointerup 早就把撤销组关了 ⇒ **一次拖拽变成 N 条历史**
//   （闸门 P3-d2 抓到 [3 => 6]）。带上原版全表后，原版方块的放置**永远同步**。
const regDefaults = JSON.parse(fs.readFileSync(path.join(PREVIEW, 'data', 'registry-defaults.json'), 'utf8'))
const inlineDefaults = {}
for (const [id, props] of Object.entries(regDefaults)) {
  if (id.startsWith('minecraft:')) inlineDefaults[id] = props
}
// ⚠ 这个文件要生成到 **preview/src/**（与 main.js 同目录，它 `import './block-defaults.generated.js'`），
//   不要跟上面两个 .generated.js 混了 —— 那两个是给 `preview-feature/src/feature-entry.jsx` 用的，
//   所以落在 `SRC`（= preview-feature/src）。第一版我就写错成 SRC，构建直接报
//   `Could not resolve "./block-defaults.generated.js"`。
fs.writeFileSync(path.join(PREVIEW, 'src', 'block-defaults.generated.js'),
  '// 由 build-feature.mjs 从 preview/data/registry-defaults.json 抽出（不要手改）\n' +
  '// 只含**原版**方块的默认态 —— 见构建脚本里的注释（45 KB vs 全量 243 KB；mod 走后端兜底）。\n' +
  'export const BLOCK_DEFAULTS = ' + JSON.stringify(inlineDefaults) + ';\n')

// ---------- 2) 渲染侧：IIFE ----------
// legalComments:'eof' —— **保留上游法律注释**（我们把 deepslate / gl-matrix 两个 MIT 组件打进包，
// 署名义务要求它们的版权头跟着产物走）。之前写的 'none' 把 MIT 署名剥掉了，属合规缺口。
const common = { bundle: true, logLevel: 'warning', sourcemap: false, legalComments: 'eof' }
const r1 = await esbuild.build({
  ...common,
  absWorkingDir: TOOL,
  entryPoints: [path.join(SRC, 'feature-entry.jsx')],
  outfile: path.join(DIST, 'renderer.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
})
const inputs = Object.entries(r1.metafile.outputs).flatMap(([, o]) => Object.keys(o.inputs))
for (const must of ['preview/src/main.js', 'preview/src/viewport.js', 'preview/vendor/deepslate.umd.cjs']) {
  if (!inputs.some((f) => f.replaceAll('\\', '/').endsWith(must))) throw new Error('渲染产物里缺少 ' + must)
}

// ---------- 3) 后端：CJS ----------
await esbuild.build({
  ...common,
  absWorkingDir: TOOL,
  entryPoints: [path.join(PKG, 'backend/main.js')],
  outfile: path.join(DIST, 'main.cjs'),
  format: 'cjs',
  platform: 'node',
  target: 'node22',
})

console.log(`renderer.js ${(fs.statSync(path.join(DIST, 'renderer.js')).size / 1024).toFixed(0)} KB`)
console.log(`renderer.css ${(fs.statSync(path.join(DIST, 'renderer.css')).size / 1024).toFixed(0)} KB`)
console.log(`main.cjs     ${(fs.statSync(path.join(DIST, 'main.cjs')).size / 1024).toFixed(0)} KB`)

// ---------- 4) 打包 ----------
if (!process.argv.includes('--no-pack')) {
  const { packFeature } = await import('./pack.cjs')
  packFeature({ pkgDir: PKG, distDir: DIST })
}
