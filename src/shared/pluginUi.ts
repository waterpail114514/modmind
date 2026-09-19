import { themeCssVariables } from './appTheme'
import { scrollbarStyles } from './scrollbars'

/** Portable, dependency-free UI for plugin iframes. Copied templates and the
 * in-app scaffold are generated from this same source. */
export const pluginUiStyles = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; color: var(--theme-text); background: var(--theme-canvas); font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
h1, h2, p { margin: 0; }
h1 { font-size: 14px; font-weight: 600; }
h2 { font-size: 13px; font-weight: 600; }
button, input, select, textarea { font: inherit; color: inherit; }
button, summary, input, select, textarea { border-radius: 6px; }
button { min-height: 32px; padding: 5px 12px; border: 1px solid var(--theme-line); background: var(--theme-surface); cursor: pointer; overflow-wrap: anywhere; }
button.mm-primary { color: var(--theme-on-action); background: var(--theme-action); border-color: transparent; }
button.mm-quiet { background: transparent; border-color: transparent; }
button:disabled { opacity: .5; cursor: default; }
button:not(:disabled):active { transform: scale(.98); }
:is(button, summary, input, select, textarea, a):focus-visible { outline: 2px solid var(--theme-focus); outline-offset: 2px; }
a { color: var(--theme-accent); }
input:not([type=checkbox]):not([type=radio]), select, textarea { width: 100%; min-width: 0; min-height: 34px; padding: 6px 9px; border: 1px solid var(--theme-line); background: var(--theme-surface); }
textarea { resize: vertical; }
.mm-page { min-width: 0; }
.mm-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; min-height: 52px; padding: 10px 20px; border-bottom: 1px solid var(--theme-line); background: var(--theme-surface); }
.mm-heading { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; }
.mm-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mm-content { width: 100%; max-width: 1080px; padding: 20px; overflow-wrap: anywhere; }
.mm-section + .mm-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--theme-line); }
.mm-muted, .mm-description { color: var(--theme-muted); font-size: 12px; }
.mm-status { min-height: 24px; margin-bottom: 12px; color: var(--theme-muted); overflow-wrap: anywhere; }
.mm-status[data-state=error] { color: var(--theme-danger); }
.mm-status[data-state=success] { color: var(--theme-success); }
.mm-empty { padding: 32px 0; color: var(--theme-muted); }
.mm-list { margin: 0; }
.mm-row { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr); gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--theme-line); }
.mm-row dt { color: var(--theme-muted); }
.mm-row dd { margin: 0; overflow-wrap: anywhere; }
.mm-form { display: grid; gap: 16px; }
.mm-field { display: grid; gap: 6px; min-width: 0; }
.mm-details { margin-top: 16px; border-top: 1px solid var(--theme-line); }
.mm-details > summary { width: fit-content; max-width: 100%; padding: 8px 0; cursor: pointer; color: var(--theme-muted); }
pre { max-width: 100%; margin: 8px 0; padding: 12px; border-radius: 6px; background: var(--theme-panel); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) {
  button:not(:disabled):hover { background: var(--theme-panel); }
  button.mm-primary:not(:disabled):hover { background: var(--theme-action-hover); }
  .mm-details > summary:hover { color: var(--theme-text); }
}
@media (max-width: 480px) {
  .mm-toolbar { padding: 10px 14px; }
  .mm-content { padding: 16px 14px; }
  .mm-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
@media (pointer: coarse) { button, summary { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { button:not(:disabled):active { transform: none; } }
`

/** Only accepts the owning host's messages; theme updates never recreate content. */
export const pluginUiBridge = `
(() => {
  let seq = 0
  const pending = new Map()
  let paletteKeys = []
  const request = (payload) => new Promise((resolve, reject) => {
    const requestId = 'mm-' + (++seq)
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('请求超时，请重试。'))
    }, 35000)
    pending.set(requestId, { resolve, reject, timer })
    window.parent.postMessage({ ...payload, requestId }, '*')
  })
  const setStatus = (element, state, message) => {
    element.dataset.state = state
    element.setAttribute('role', state === 'error' ? 'alert' : 'status')
    element.textContent = message
  }
  window.ModMindUI = { request, setStatus, hostInfo: null }
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'hostInfo' || data.type === 'themeChanged') {
      const info = data.type === 'hostInfo' ? data.hostInfo : data
      if (!info || typeof info !== 'object') return
      const root = document.documentElement
      root.dataset.themeMode = info.theme === 'dark' ? 'dark' : 'light'
      root.style.colorScheme = root.dataset.themeMode
      if (typeof info.themePreset === 'string') root.dataset.themePreset = info.themePreset
      // Remove previous custom values, so an older host or a smaller palette cannot leave stale colors.
      paletteKeys.forEach(name => root.style.removeProperty(name))
      paletteKeys = []
      for (const [name, value] of Object.entries(info.palette || {})) {
        if (name.startsWith('--theme-') && typeof value === 'string') {
          root.style.setProperty(name, value)
          paletteKeys.push(name)
        }
      }
      if (typeof info.scrollbarStyle === 'string') document.getElementById('modmind-scrollbars').textContent = info.scrollbarStyle
      if (data.type === 'hostInfo') {
        window.ModMindUI.hostInfo = info
        window.dispatchEvent(new CustomEvent('modmind:hostinfo', { detail: info }))
      }
      return
    }
    if (data.type === 'result' && pending.has(data.requestId)) {
      const entry = pending.get(data.requestId)
      pending.delete(data.requestId)
      clearTimeout(entry.timer)
      if (data.ok) entry.resolve(data.result)
      else entry.reject(new Error(typeof data.error === 'string' ? data.error : '操作失败，请重试。'))
    }
  })
  window.parent.postMessage({ type: 'ready' }, '*')
})()
`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export function pluginUiHead(title: string): string {
  const fallback = (mode: 'light' | 'dark'): string => Object.entries(themeCssVariables('modmind', mode)).map(([name, value]) => `${name}:${value};`).join('')
  return `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style id="modmind-theme-fallback">:root {${fallback('light')}color-scheme:light;} :root[data-theme-mode="dark"] {${fallback('dark')}color-scheme:dark;}</style>
<style id="modmind-ui">${pluginUiStyles}</style>
<style id="modmind-scrollbars">${scrollbarStyles()}</style>`
}

export function createPluginPanelHtml(name: string, toolName?: string): string {
  // Attribute data avoids injecting user-provided names into JavaScript source.
  return `<!DOCTYPE html>
<!-- Generated from src/shared/pluginUi.ts. Run npm run plugins:generate. -->
<html lang="zh-CN">
<head>${pluginUiHead(name)}</head>
<body>
<main class="mm-page" data-tool="${escapeHtml(toolName ?? '')}">
  <header class="mm-toolbar">
    <div class="mm-heading"><h1>${escapeHtml(name)}</h1><p class="mm-description">${toolName ? '查看工具运行结果' : '查看当前项目的信息'}</p></div>
    <div class="mm-actions"><button class="mm-primary" id="run" type="button">${toolName ? '运行工具' : '刷新信息'}</button></div>
  </header>
  <div class="mm-content">
    <p class="mm-status" id="status" role="status" aria-live="polite">${toolName ? '准备就绪' : '等待项目信息'}</p>
    <section class="mm-section" aria-label="${toolName ? '运行结果' : '项目信息'}" id="result" aria-busy="false">
      <p class="mm-empty" id="empty">${toolName ? '运行后，结果会显示在这里。' : '打开项目后，可在这里查看信息。'}</p>
      <dl class="mm-list" id="project" hidden>
        <div class="mm-row"><dt>项目名称</dt><dd id="project-name"></dd></div>
        <div class="mm-row"><dt>项目类型</dt><dd id="project-kind"></dd></div>
        <div class="mm-row"><dt>项目位置</dt><dd id="project-path"></dd></div>
      </dl>
      <p id="summary" hidden></p>
      <details class="mm-details" id="details" hidden><summary>查看详细结果</summary><pre id="output"></pre></details>
    </section>
  </div>
</main>
<script>${pluginUiBridge}</script>
<script>
const ui = window.ModMindUI
const button = document.getElementById('run')
const status = document.getElementById('status')
const result = document.getElementById('result')
const toolName = document.querySelector('main').dataset.tool
const renderProject = project => {
  document.getElementById('empty').hidden = Boolean(project)
  document.getElementById('project').hidden = !project
  if (!project) { ui.setStatus(status, 'empty', '当前没有打开的项目'); return }
  document.getElementById('project-name').textContent = project.name || '未命名项目'
  document.getElementById('project-kind').textContent = ({ mod: '模组', modpack: '整合包', 'server-plugin': '服务端插件' })[project.kind] || project.kind || '模组'
  document.getElementById('project-path').textContent = project.path || '—'
  ui.setStatus(status, 'success', '项目信息已更新')
}
window.addEventListener('modmind:hostinfo', event => { if (!toolName && !button.disabled) renderProject(event.detail.project) })
button.addEventListener('click', async () => {
  if (button.disabled) return
  button.disabled = true
  result.setAttribute('aria-busy', 'true')
  ui.setStatus(status, 'loading', toolName ? '正在运行…' : '正在读取…')
  try {
    const value = await ui.request(toolName ? { type: 'invokeTool', toolName, input: {} } : { type: 'getProjectInfo' })
    if (toolName) {
      document.getElementById('empty').hidden = true
      const summary = document.getElementById('summary')
      summary.hidden = false
      summary.textContent = typeof value?.summary === 'string' ? value.summary : '工具已运行完成。'
      document.getElementById('output').textContent = JSON.stringify(value ?? null, null, 2)
      document.getElementById('details').hidden = false
      ui.setStatus(status, 'success', '运行完成')
    } else renderProject(value)
  } catch (error) {
    ui.setStatus(status, 'error', '操作失败：' + error.message + ' 可再次点击按钮重试。')
  } finally {
    button.disabled = false
    result.setAttribute('aria-busy', 'false')
  }
})
</script>
</body>
</html>
`
}

export function createPluginOverlayHtml(): string {
  return `<!DOCTYPE html>
<!-- Generated from src/shared/pluginUi.ts. Run npm run plugins:generate. -->
<html lang="zh-CN"><head>${pluginUiHead('悬浮伙伴')}
<style>
html, body { width: 100%; height: 100%; background: transparent; }
body { display: grid; place-items: end center; padding: 36px 12px 12px; }
.pet-wrap { display: grid; justify-items: center; max-width: 100%; }
.message { margin-bottom: 8px; padding: 6px 9px; border: 1px solid var(--theme-line); border-radius: 6px; background: var(--theme-raised); color: var(--theme-text); font-size: 11px; text-align: center; }
/* Artwork colors belong to the character, not application chrome. */
.mm-artwork { width: 112px; display: grid; justify-items: center; }
.mm-artwork .head { width: 112px; height: 96px; position: relative; border: 3px solid #303137; border-radius: 8px; background: #f4c542; }
.mm-artwork .head::before, .mm-artwork .head::after { content: ''; position: absolute; top: 34px; width: 12px; height: 15px; border-radius: 4px; background: #303137; }
.mm-artwork .head::before { left: 24px; } .mm-artwork .head::after { right: 24px; }
.mm-artwork .mouth { position: absolute; left: 50%; bottom: 20px; width: 28px; height: 9px; transform: translateX(-50%); border: solid #303137; border-width: 0 0 3px; border-radius: 50%; }
.mm-artwork .pet-body { width: 82px; height: 70px; margin-top: -2px; display: grid; place-items: center; border: 3px solid #303137; border-radius: 7px; background: #4c8ed9; color: #fff; font-size: 20px; font-weight: 700; }
@media (max-height: 220px) { .mm-artwork { zoom: .5; } }
</style></head><body>
<main class="pet-wrap"><p class="message" id="message" role="status">我会一直留在这里</p>
<div class="mm-artwork" role="img" aria-label="ModMind 悬浮伙伴"><div class="head"><span class="mouth"></span></div><div class="pet-body">MM</div></div></main>
<script>${pluginUiBridge}</script>
<script>window.addEventListener('modmind:hostinfo', event => {
  document.getElementById('message').textContent = event.detail.surface === 'overlay' ? '可以把我弹到桌面' : '悬浮界面已连接'
})</script>
</body></html>
`
}
