export const FEATURE_PLUGIN_ARCHIVE_LIMIT = 64 * 1024 * 1024
export const FEATURE_PLUGIN_UNPACKED_LIMIT = 128 * 1024 * 1024
export const FEATURE_PLUGIN_API = 2
export const FEATURE_PLUGIN_HOST = '1.5.0-plugintest'
export type FeaturePluginSurface = 'workbench' | 'inspiration'
export type FeaturePluginPermission = 'read' | 'write' | 'network' | 'process'
export type FeaturePluginSchema = Record<string, unknown>
export interface FeaturePluginScope { studioIds?: string[]; loaders?: string[] }
export interface FeaturePluginCapability { id: string; name: string; description: string }
export interface FeaturePluginView extends FeaturePluginScope { id: string; label: string; component: string; icon: string; group?: string; order?: number }
export interface FeaturePluginSettings extends FeaturePluginScope { id: string; label: string; component: string; category: string; keywords?: string }
export interface FeaturePluginAction extends FeaturePluginScope {
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
  studios?: import('./studios').StudioDefinition[]
  capabilities?: FeaturePluginCapability[]
  views?: FeaturePluginView[]
  settings?: FeaturePluginSettings[]
  actions?: FeaturePluginAction[]
  tools?: FeaturePluginTool[]
  events?: string[]
}
export interface FeaturePluginManifest extends FeaturePluginContributions, FeaturePluginScope {
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
  builtin?: boolean
  /** Verified package identity; changes even when a local rebuild keeps its version. */
  contentHash?: string
  id: string
  name: string
  version: string
  enabled: boolean
  error?: string
  manifest?: FeaturePluginDefinition
}
export interface FeaturePluginCatalogEntry extends FeaturePluginRecord {
  /** Official means the installed fingerprint matches a verified download receipt. */
  installationSource?: 'builtin' | 'official' | 'local'
  /** Confirmed official installation absent from the last valid official catalog. Never an uninstall instruction. */
  withdrawn?: boolean
  description?: string
  installed: boolean
  available: boolean
  state: 'not-installed' | 'disabled' | 'ready' | 'error' | 'dependency-missing'
  installHint: string
  download?: { available: boolean; latestVersion?: string; updateAvailable: boolean; message?: string }
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
  stopForSignal?: (signal: AbortSignal) => void | Promise<void>
  isBusy?: () => boolean
}
export interface FeaturePluginApi {
  store: () => Promise<import('./featureStore').FeatureStoreSnapshot>
  refreshStore: () => Promise<import('./featureStore').FeatureStoreSnapshot>
  installOfficial: (id: string) => Promise<FeaturePluginRecord[]>
  cancelDownload: () => Promise<void>
  onStoreChanged: (callback: (snapshot: import('./featureStore').FeatureStoreSnapshot) => void) => () => void
  list: () => Promise<FeaturePluginRecord[]>
  catalog: () => Promise<FeaturePluginCatalogEntry[]>
  invoke: (id: string, action: string, input: Record<string, unknown>) => Promise<unknown>
  onEvent: (id: string, event: string, callback: (value: unknown) => void) => () => void
  install: (expectedId?: string) => Promise<FeaturePluginRecord[] | null>
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
