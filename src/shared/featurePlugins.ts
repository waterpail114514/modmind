export const FEATURE_PLUGIN_API = 2
export const FEATURE_PLUGIN_HOST = '1.5.0-plugintest'
export type FeaturePluginSurface = 'workbench' | 'inspiration'
export type FeaturePluginPermission = 'read' | 'write' | 'network' | 'process'
export type FeaturePluginSchema = Record<string, unknown>
export interface FeaturePluginCapability { id: string; name: string; description: string }
export interface FeaturePluginView { id: string; label: string; component: string; icon: string; group?: string; order?: number; loaders?: string[] }
export interface FeaturePluginSettings { id: string; label: string; component: string; category: string; keywords?: string }
export interface FeaturePluginAction {
  id: string
  handler: string
  inputSchema: FeaturePluginSchema
  permission: FeaturePluginPermission
  projectRequired?: boolean
  surfaces?: FeaturePluginSurface[]
  inspirationOutput?: boolean
}
export interface FeaturePluginTool { name: string; action: string; description: string }
export interface FeaturePluginContributions {
  capabilities?: FeaturePluginCapability[]
  views?: FeaturePluginView[]
  settings?: FeaturePluginSettings[]
  actions?: FeaturePluginAction[]
  tools?: FeaturePluginTool[]
  events?: string[]
}
export interface FeaturePluginManifest extends FeaturePluginContributions {
  format: 'modmind-feature'
  apiVersion: number
  hostVersion: string
  id: string
  name: string
  version: string
  main: 'main.cjs'
  renderer: 'renderer.js'
  style: 'renderer.css'
  files: Record<string, string>
  dependencies?: string[]
  hostCapabilities?: string[]
  assets?: Record<string, string>
  target?: { platform: string; arch: string }
}
export type FeaturePluginDefinition = Omit<FeaturePluginManifest, 'files'>
export interface FeaturePluginRecord {
  id: string
  name: string
  version: string
  enabled: boolean
  error?: string
  manifest?: FeaturePluginDefinition
}
export interface FeaturePluginCatalogEntry extends FeaturePluginRecord {
  installed: boolean
  available: boolean
  state: 'not-installed' | 'disabled' | 'ready' | 'error' | 'dependency-missing'
  installHint: string
}
export interface FeaturePluginDiscoveredTool extends FeaturePluginTool {
  pluginId: string
  inputSchema: FeaturePluginSchema
  permission: FeaturePluginPermission
  projectRequired: boolean
  inspirationOutput?: boolean
}
export interface FeaturePluginInvocationContext { projectPath?: string | null; readOnly?: boolean; surface?: FeaturePluginSurface; allowInspirationOutput?: boolean; signal?: AbortSignal; windowId?: number }
export interface FeaturePluginRuntime {
  actions?: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown>
  dispose?: () => void | Promise<void>
  projectChanged?: (projectPath: string | null) => void | Promise<void>
}
export interface FeaturePluginApi {
  list: () => Promise<FeaturePluginRecord[]>
  catalog: () => Promise<FeaturePluginCatalogEntry[]>
  invoke: (id: string, action: string, input: Record<string, unknown>) => Promise<unknown>
  onEvent: (id: string, event: string, callback: (value: unknown) => void) => () => void
  install: () => Promise<FeaturePluginRecord[] | null>
  onInstallPreview: (callback: (requestId: string, preview: FeaturePluginInstallPreview) => void) => () => void
  confirmInstall: (requestId: string, accepted: boolean) => void
  setEnabled: (id: string, enabled: boolean) => Promise<FeaturePluginRecord[]>
  uninstall: (id: string) => Promise<FeaturePluginRecord[]>
  onChanged: (callback: () => void) => () => void
}

export interface FeaturePluginInstallPreview {
  name: string
  version: string
  fileName: string
}
