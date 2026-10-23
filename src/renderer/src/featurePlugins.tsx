import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as dialogs from './components/InteractionDialogs'
import MiniPaintEditor from './components/MiniPaintEditor'
import * as theme from './theme'
import type { FeaturePluginRecord, FeaturePluginCatalogEntry } from '../../shared/featurePlugins'
import { featurePageApplies } from '../../shared/featureApplicability'
import { resolveFeatureModule } from './featurePluginDefinitions'
import type { FeaturePageContext, FeatureRendererModule, FeaturePageDefinition, FeatureSettingsDefinition } from './featurePluginTypes'

type Snapshot = { ready: boolean; records: FeaturePluginRecord[]; catalog: FeaturePluginCatalogEntry[]; modules: Record<string, FeatureRendererModule>; error?: string }
let snapshot: Snapshot = { ready: false, records: [], catalog: [], modules: {} }
const listeners = new Set<() => void>()
const registered: Record<string, Record<string, unknown>> = {}
const assets = new Map<string, { script: HTMLScriptElement; style: HTMLLinkElement; version: string }>()
const hostWindow = window as unknown as { __modmindFeatureHost: unknown; __modmindRegisterFeature: (id: string, module: Record<string, unknown>) => void }
const MonacoCodeEditor = React.lazy(() => import('./components/MonacoCodeEditor'))
hostWindow.__modmindFeatureHost = { React, ReactDOM, jsxRuntime, dialogs, MiniPaintEditor, MonacoCodeEditor, theme }
hostWindow.__modmindRegisterFeature = (id, module) => {
  if (assets.has(id) && module && typeof module === 'object') registered[id] = module
}

function resolveModule(record: FeaturePluginRecord): FeatureRendererModule { return resolveFeatureModule(record, registered[record.id]) }
let refreshQueue = Promise.resolve()
function publish(value: Snapshot): void { snapshot = value; listeners.forEach(listener => listener()) }
function removeAssets(id: string): void { const entry = assets.get(id); entry?.script.remove(); entry?.style.remove(); assets.delete(id); delete registered[id] }
async function load(record: FeaturePluginRecord): Promise<FeatureRendererModule> {
  if (assets.get(record.id)?.version === record.version && registered[record.id]) return resolveModule(record)
  removeAssets(record.id)
  const script = document.createElement('script'), style = document.createElement('link')
  assets.set(record.id, { script, style, version: record.version })
  script.src = `modmind-feature://${record.id}/renderer.js`
  style.rel = 'stylesheet'; style.href = `modmind-feature://${record.id}/renderer.css`
  const append = (element: HTMLScriptElement | HTMLLinkElement): Promise<void> => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { element.remove(); reject(new Error('插件加载超时，请重试')) }, 15000)
    element.onload = () => { clearTimeout(timer); resolve() }
    element.onerror = () => { clearTimeout(timer); reject(new Error('插件界面无法加载，请重试或重新安装')) }
    // Preserve the original import cascade: feature styles precede application theme overrides.
    if (element === style) document.head.insertBefore(element, document.head.querySelector('link[rel=stylesheet], style')); else document.head.append(element)
  })
  try { await Promise.all([append(style), append(script)]); return resolveModule(record) }
  catch (error) { removeAssets(record.id); throw error }
}
export function refreshFeaturePlugins(): Promise<void> {
  refreshQueue = refreshQueue.catch(() => undefined).then(async () => {
    try {
      const [records, catalog] = await Promise.all([window.modmind.featurePlugins.list(), window.modmind.featurePlugins.catalog()])
      const modules: Record<string, FeatureRendererModule> = {}
      for (const id of assets.keys()) if (!catalog.some(record => record.id === id && record.available)) removeAssets(id)
      for (const record of records) {
        if (!catalog.some(entry => entry.id === record.id && entry.available) || record.error) continue
        try { modules[record.id] = await load(record) } catch (error) { record.error = String(error) }
      }
      publish({ ready: true, records, catalog, modules })
    } catch (error) { publish({ ...snapshot, ready: true, error: String(error) }) }
  })
  return refreshQueue
}
let started = false
export function useFeaturePlugins(): Snapshot {
  React.useEffect(() => {
    if (started) return
    started = true
    window.modmind.featurePlugins.onChanged(() => { void refreshFeaturePlugins() })
    void refreshFeaturePlugins()
  }, [])
  return React.useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback) }, () => snapshot)
}

export function featurePages(modules: Record<string, FeatureRendererModule>): FeaturePageDefinition[] {
  const ids = new Set(['workspace', 'inspiration', 'code', 'build', 'settings', 'plugins', 'features'])
  return Object.values(modules).flatMap(module => module.pages).filter(page => {
    if (ids.has(page.id)) return false
    ids.add(page.id)
    return true
  })
}

export function featureSettings(modules: Record<string, FeatureRendererModule>): FeatureSettingsDefinition[] {
  const ids = new Set<string>()
  return Object.values(modules).flatMap(module => module.settings ?? []).filter(section => {
    if (ids.has(section.id)) return false
    ids.add(section.id)
    return true
  })
}

function FeatureRoute({ page, context }: { page: FeaturePageDefinition; context: FeaturePageContext }): React.JSX.Element | null {
  const [visited, setVisited] = React.useState(context.visible)
  React.useEffect(() => { if (context.visible) setVisited(true) }, [context.visible])
  if (!context.visible && (!page.keepAlive || !visited)) return null
  const Page = page.component
  return <div className={page.className ?? 'keep-alive-route'} hidden={!context.visible}><FeaturePluginBoundary><React.Suspense fallback={<div className="editor-empty" role="status">正在载入…</div>}><Page {...context} /></React.Suspense></FeaturePluginBoundary></div>
}

export function FeaturePluginRoutes({ pages, view, context, routeData }: { pages: FeaturePageDefinition[]; view: string; context: Omit<FeaturePageContext, 'visible'>; routeData: Record<string, unknown> }): React.JSX.Element {
  return <>{pages.filter(page => featurePageApplies(page, context.project, context.uiMode)).map(page =>
    <FeatureRoute key={`${page.id}:${page.scope === 'application' ? 'application' : context.project?.path ?? 'standalone'}`} page={page} context={{ ...context, routeData: routeData[page.id], visible: view === page.id }} />)}</>
}

export function FeaturePluginBackgrounds({ modules, context }: { modules: Record<string, FeatureRendererModule>; context: FeaturePageContext }): React.JSX.Element {
  return <>{Object.entries(modules).filter(([, module]) => featurePageApplies(module, context.project, context.uiMode)
    && (!module.pages.length || module.pages.some(page => featurePageApplies(page, context.project, context.uiMode))))
    .flatMap(([id, module]) => (module.backgroundComponents ?? []).map((Component, index) => <FeaturePluginBoundary key={`${id}:${index}:${context.project?.path ?? 'application'}`}><Component {...context} /></FeaturePluginBoundary>))}</>
}

export function FeatureSettingsSection({ definition, context }: { id?: string; definition: FeatureSettingsDefinition; context: FeaturePageContext }): React.JSX.Element | null {
  if (!featurePageApplies(definition, context.project, context.uiMode)) return null
  const Settings = definition.component
  return <section id={definition.id} className={`settings-section ${definition.className ?? ''}`}><FeaturePluginBoundary><Settings {...context} /></FeaturePluginBoundary></section>
}

export class FeaturePluginBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error): { error: string } { return { error: error.message } }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return <div role="alert" className="settings-section"><p>插件界面加载失败：{this.state.error}</p><button className="secondary-button" onClick={() => this.setState({ error: '' })}>重试</button></div>
  }
}
