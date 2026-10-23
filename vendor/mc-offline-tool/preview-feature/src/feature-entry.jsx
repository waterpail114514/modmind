// src/feature-entry.jsx —— 功能包渲染侧入口（esbuild IIFE 的 entryPoint）。
//
// 宿主契约（来自交接源码里的 注释/逆向）：
//   · `renderer.js` 用**经典 <script>** 注入宿主 document ⇒ 必须是 IIFE，产物里不得有顶层 import/export；
//   · 宿主**先**建好 id→模块的路由表，再设 script.src ⇒ **注册必须最外层同步执行**，不能包在
//     then/setTimeout/DOMContentLoaded 里（内部 `if (!has(id)) 静默丢弃`，不报错）；
//   · 宿主 `sN()` 取 `module[views[].component]` ⇒ 注册对象里必须有一个**同名函数**（这里 `PreviewWorkspace`）；
//   · 组件由**宿主的 React**渲染；渲染侧调后端走 `window.modmind.featurePlugins.invoke(id, 'action:with:colon', input)`；
//   · 宿主把我们的 stylesheet 插在它自己之前（优先级更低）⇒ 这里用 **Shadow DOM** 隔离（现有 CSS/标记原样复用）。
import * as deepslateNS from '../../preview/vendor/deepslate.umd.cjs'
import * as glMatrixNS from '../../preview/vendor/gl-matrix.js'
import { setHost, setRoot } from '../../preview/src/host.js'
import { TEMPLATE } from './dom-template.generated.js'
import { CSS } from './css.generated.js'

const FEATURE_ID = 'mc-preview'
const pick = (ns, name) => (globalThis[name] = globalThis[name] || (ns && ns.default) || ns)
pick(deepslateNS, 'deepslate')
pick(glMatrixNS, 'glMatrix')

const b64ToBytes = (b64) => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const bytesToB64 = (bytes) => {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

// 宿主给的项目路径（`props.project.path`）。**采集数据就存在项目里**（`<project>/.modmind/mc-capture/`），
// 所以"读物品表/图标"这两个 action 必须带上它，后端才知道该用哪个数据包。
let PROJECT_PATH = ''

function invoke(action, input, withProject) {
  const api = globalThis.modmind && globalThis.modmind.featurePlugins
  if (!api || typeof api.invoke !== 'function') throw new Error('宿主未提供 modmind.featurePlugins.invoke（不在功能包环境？）')
  // ⚠ 只给**声明了 projectPath** 的 action 加这个字段：宿主对每个 action 跑 ajv，且 additionalProperties:false。
  const payload = (withProject && PROJECT_PATH) ? { ...(input || {}), projectPath: PROJECT_PATH } : (input || {})
  return api.invoke(FEATURE_ID, action, payload)
}

/** 宿主适配器：把「HTTP /api/*」换成「宿主 action」—— 前端代码一行都不用改 */
const host = {
  kind: 'feature',
  async scene(states) {
    const r = await invoke('preview:scene', { states }, true)
    return {
      assets: { blockstates: r.blockstates, models: r.models, textures: r.uv },
      atlasUrl: r.atlas,                       // data URL，直接喂给 new Image()
      stats: r.stats, key: r.key,
      missing: r.missing || [], unknownStates: r.unknownStates || [],
      defaults: r.defaults || {}, flags: r.flags || null,
      truncated: r.truncated || null,          // U4：截断标记必须透传，否则前端无从知道"结果被砍过"
    }
  },
  async initialBuild() { return (await invoke('preview:open', {})).build },
  async importBuild(name, bytes) { return (await invoke('preview:import', { name, dataBase64: bytesToB64(bytes) })).build },
  async exportBuild(build, format) {
    const r = await invoke('preview:export', { format, build })
    return { blob: new Blob([b64ToBytes(r.dataBase64)], { type: 'application/octet-stream' }), filename: r.filename, materials: r.materials || [] }
  },
  async icons(ids) { return (await invoke('preview:icons', { ids }, true)).icons || {} },
  async items() {
    const items = []
    let offset = 0
    do {
      const page = await invoke('preview:items', { offset, limit: 500 }, true)
      items.push(...page.items)
      offset = page.nextOffset
    } while (offset !== null && items.length < 100000)
    return items
  },
}

function PreviewWorkspace(props) {
  const React = (globalThis.__modmindFeatureHost || {}).React
  if (!React) return null
  const ref = React.useRef(null)
  React.useEffect(() => {
    // 宿主把项目路径放在 props 里（`project.path`）。采集数据就在这个项目里 ⇒ 先记下来再挂载。
    PROJECT_PATH = (props && ((props.project && props.project.path) || props.projectPath || props.path))
      || globalThis.__MCPREVIEW_PROJECT__ || ''
    const el = ref.current
    if (!el || el.dataset.mcpBooted) return
    el.dataset.mcpBooted = '1'
    // ★ 幂等：同一个宿主元素被复用（React 复用 DOM 节点）时**不能**再 attachShadow，会抛 NotSupportedError。
    const shadow = el.shadowRoot || el.attachShadow({ mode: 'open' })
    if (!shadow.querySelector('style.mcp-css')) {
      const style = document.createElement('style')
      style.className = 'mcp-css'
      style.textContent = CSS
      shadow.appendChild(style)
    }
    // 每次挂载都给一棵**干净**的 DOM 树（上一次挂载可能留下了半初始化的节点）
    const old = shadow.querySelector('.mcp-wrap')
    if (old) old.remove()
    const wrap = document.createElement('div')
    wrap.className = 'mcp-wrap'      // ★ 必须带这个类：CSS 里给它确定高度，否则 #app 的 height:100% 落空
    wrap.innerHTML = TEMPLATE
    shadow.appendChild(wrap)
    setRoot(shadow)          // 之后所有 $() 都从 shadow root 里找
    setHost(host)
    // ★ 动态 import 是异步的；组件可能在它 resolve 之前就被宿主卸载（切走），
    //   所以用一个标记把"先卸载、后加载完"这种情况也收住 —— 否则模块起来了却没人清理。
    let mod = null, disposed = false
    import('../../preview/src/main.js')
      .then((m) => {
        mod = m
        if (disposed) { m.shutdown?.(); return }
        // ★★ 必须**每次挂载**显式调 boot()：ES 模块只求值一次，第二次 import 直接命中缓存、
        //    模块体不再执行 ⇒ 那句"自动 boot"永远不会再跑，新 shadow 树就只剩静态 HTML。
        //    （2026-10-10 实机「切走再切回来 ⇒ 面板空白/不显示建筑世界」的根因）
        return m.boot?.()
      })
      .catch((e) => {
        const err = shadow.getElementById('err')
        if (err) err.textContent = 'ERROR[挂载]：' + (e && e.stack || e)
        console.error('[mc-preview] 挂载失败', e)
      })
    // ★ 卸载清理：宿主切走/重建组件时，把 document/window 上的监听与 rAF 帧循环一起收掉。
    //   不收的话第二次挂载会叠加（按一次 w 走两格、双份绘制一直发热）。
    return () => {
      disposed = true
      try { mod?.shutdown?.() } catch { /* 尽力而为 */ }
      try { delete el.dataset.mcpBooted } catch { /* 允许重新挂载 */ }
    }
  }, [])
  return React.createElement('div', { ref, className: 'mcp-host' })
}

function register() {
  const reg = globalThis.__modmindRegisterFeature
  if (typeof reg === 'function') reg(FEATURE_ID, { PreviewWorkspace })
  else console.warn('[mc-preview] 宿主未提供 __modmindRegisterFeature，功能包不会被挂载')
}
register()          // ★ 必须最外层同步执行
