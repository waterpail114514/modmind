import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import { resolvePreviewPages, previewResourceUrls } from '../../src/shared/developerRenderer'
import { resolveFeatureModule } from '../../src/renderer/src/featurePluginDefinitions'
import * as dialogs from '../../src/renderer/src/components/InteractionDialogs'
import MiniPaintEditor from '../../src/renderer/src/components/MiniPaintEditor'
import MonacoCodeEditor from '../../src/renderer/src/components/MonacoCodeEditor'
import * as theme from '../../src/renderer/src/theme'
import '../../src/renderer/src/theme-tokens.css'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/workspace-chrome.css'
import '../../src/renderer/src/palette.css'
import '../../src/renderer/src/appearance.css'

const g = window as any
g.__modmindFeatureHost = { React, ReactDOM, jsxRuntime, dialogs, MiniPaintEditor, MonacoCodeEditor, theme }
g.__modmindCreateRoot = createRoot
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const listeners = new Map<string, Set<(value: unknown) => void>>()
const report = (type: string, value: unknown) => parent.postMessage({ channel: g.__devToken, type, value }, '*')
g.__devErrors = []
g.__devPending = 0
g.__devLastRequest = 0
const ipcListeners = new Map<string, Set<(...args: unknown[]) => void>>()
const emitIpc = (name: string, args: unknown[]) => { for (const listener of ipcListeners.get(name) ?? []) listener({}, ...args) }
g.__devCapture?.onEvent(emitIpc)
const resourceResult = (value: any): any => {
  return previewResourceUrls(value, g.__devResourceBase)
}
const callHost = async (name: string, args: unknown[]) => {
  g.__devPending++; g.__devLastRequest = Date.now()
  try { return resourceResult(await (g.__devCapture ? g.__devCapture.invoke(name, args) : new Promise((resolve, reject) => {
  const key = crypto.randomUUID()
  const timer = setTimeout(() => { pending.delete(key); reject(new Error('动作执行超时，请重试')) }, 35_000)
  pending.set(key, { resolve, reject, timer })
  parent.postMessage({ channel: g.__devToken, type: 'host-api', id: key, name, args }, '*')
  }))) } finally { g.__devPending--; g.__devLastRequest = Date.now() }
}
g.__devIPC = {
  invoke: callHost,
  on: (name: string, callback: (...args: unknown[]) => void) => { const group = ipcListeners.get(name) ?? new Set(); group.add(callback); ipcListeners.set(name, group) },
  off: (name: string, callback: (...args: unknown[]) => void) => ipcListeners.get(name)?.delete(callback)
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.channel !== g.__devToken) return
  if (event.data.type === 'ipc-event') { emitIpc(event.data.name, event.data.args); return }
  if (event.data.type === 'event') {
    for (const listener of listeners.get(event.data.value.name) ?? []) listener(event.data.value.payload)
    for (const listener of ipcListeners.get('feature-plugins:event') ?? []) listener({}, g.__devManifest.id, event.data.value.name, event.data.value.payload)
    return
  }
  const item = pending.get(event.data.id)
  if (!item) return
  clearTimeout(item.timer); pending.delete(event.data.id)
  if (event.data.error) item.reject(new Error(event.data.error))
  else item.resolve(event.data.result)
})
g.modmind = { featurePlugins: {
  invoke: (id: string, action: string, input: Record<string, unknown>) => new Promise((resolve, reject) => {
    if (id !== g.__devManifest.id) { reject(new Error('预览仅能调用当前开发包')); return }
    const key = crypto.randomUUID()
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('动作执行超时，请重试')) }, 35_000)
    pending.set(key, { resolve, reject, timer })
    parent.postMessage({ channel: g.__devToken, type: 'invoke', id: key, action, input }, '*')
  }),
  onEvent: (_id: string, name: string, callback: (value: unknown) => void) => {
    const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group)
    return () => { group.delete(callback) }
  }
} }
class Boundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  componentDidCatch(error: Error) { g.__devErrors.push(error.message); report('error', error.stack || error.message) }
  render() { return this.state.error ? <div role="alert" className="inline-error">{this.state.error}</div> : this.props.children }
}
function Mounted({ children, pages }: { children: React.ReactNode; pages: { id: string; label: string }[] }) {
  React.useLayoutEffect(() => { g.__devReady = true; report('ready', { pages }) }, [])
  return <>{children}</>
}
g.__modmindRegisterFeature = (id: string, module: unknown) => {
  resolvePreviewPages(g.__devManifest, id, module)
  const resolved = resolveFeatureModule({ id, manifest: g.__devManifest } as any, module as Record<string, unknown>)
  const pages = [...resolved.pages, ...(resolved.settings ?? []).map(section => ({ ...section, label: g.__devManifest.settings.find((entry: any) => entry.id === section.id).label }))]
  const page = g.__devPage ? pages.find(page => page.id === g.__devPage) : pages[0]
  if (g.__devPage && !page) throw new Error('预览页面未声明：' + g.__devPage)
  if (!page) { document.getElementById('root')!.textContent = '当前包没有页面，请在调试中检查动作或创建工作台项目。'; g.__devReady = true; report('ready', { pages: [] }); return }
  g.__devRegistered = true
  const Component = page.component
  const setting = resolved.settings?.find(section => section.id === page.id)
  const context = { project: g.__devProject, visible: true, darkMode: g.__devDark, uiMode: 'advanced', deviceState: { status: 'unconfigured', configured: false }, routeData: null,
    hasPage: (target: string) => pages.some(page => page.id === target), navigate: (target: string) => report('navigate', target),
    openSettings: (target: string) => report('navigate', target), filesChanged: () => report('filesChanged', null), setBusy: () => undefined,
    openFile: (path?: string) => report('notice', path ? '测试文件：' + path : '请在测试项目中选择文件'),
    createFile: () => report('notice', '请通过当前功能包的创建操作添加测试文件'), openProject: () => report('notice', '预览使用独立测试项目'),
    sendToWorkbench: (prompt: string) => report('notice', prompt), setNotice: (notice: string) => report('notice', notice),
    exportArtifact: () => report('notice', '请使用开发工作台的导出操作'), projectBusy: false,
    saveBeforeRestore: async () => undefined, projectRestored: () => report('filesChanged', null) }
  theme.applyAppearance({ ...g.__devAppearance, darkMode: g.__devDark })
  createRoot(document.getElementById('root')!).render(<Boundary><React.Suspense fallback={<div className="editor-empty" role="status">正在载入…</div>}><Mounted pages={pages.map(({ id, label }) => ({ id, label }))}>{resolved.backgroundComponents?.map((Background, index) => <Background key={index} {...context} />)}{setting ? <div className="settings-page" style={{height:'100%',overflow:'auto'}}><section id={setting.id} className={`settings-section ${setting.className ?? ''}`}><Component {...context} /></section></div> : <div className={('className' in page && page.className) || 'keep-alive-route'}><Component {...context} /></div>}</Mounted></React.Suspense></Boundary>)
}
g.__devRendererLoaded = () => {
  if (g.__devReady || g.__devRegistered) return
  if (g.__devManifest.views?.length || g.__devManifest.settings?.length) {
    report('error', '插件未注册界面，请检查 renderer.js 的同步注册入口')
    return
  }
  document.getElementById('root')!.textContent = '当前包没有页面，请在调试中检查动作或创建工作台项目。'
  g.__devReady = true
  report('ready', { pages: [] })
}
window.addEventListener('error', event => { g.__devErrors.push(event.message); report('error', event.message) })
window.addEventListener('unhandledrejection', event => { g.__devErrors.push(String(event.reason)); report('error', String(event.reason)) })
