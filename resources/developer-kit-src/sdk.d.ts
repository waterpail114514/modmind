import type * as React from 'react'

export interface ProjectInfo {
  name: string; path: string; loader: string; minecraftVersion: string; namespace: string; createdAt: string
  kind?: string; studioId?: string; studioName?: string; studioValues?: Record<string, string>
}
export interface FeaturePageContext {
  project: ProjectInfo | null; visible: boolean; darkMode: boolean; uiMode: 'beginner' | 'advanced'
  navigate: (id: string, data?: unknown) => void
  filesChanged: () => void; setBusy: (busy: boolean) => void
  routeData?: unknown
}
export interface FeaturePage {
  id: string; exportName?: string; label: string; group?: string; icon?: React.ComponentType<any>
  scope?: 'application' | 'project'; keepAlive?: boolean
  component: React.ComponentType<FeaturePageContext>
  supports?: (project: ProjectInfo | null) => boolean
}
export interface FeatureRendererModule { apiVersion: 2; pages: FeaturePage[]; settings?: FeaturePage[] }
export function registerFeature(id: string, module: FeatureRendererModule): void
export interface InvocationContext {
  projectPath?: string | null; readOnly?: boolean; surface?: 'workbench' | 'inspiration'; signal?: AbortSignal; windowId?: number
}
export interface FeaturePluginRuntime {
  actions?: Record<string, (input: Record<string, unknown>, context: InvocationContext) => unknown | Promise<unknown>>
  dispose?: () => void | Promise<void>
  projectChanged?: (path: string | null) => void | Promise<void>
}
export interface StudioProvider {
  templateFiles?: (project: ProjectInfo, includeStarter: boolean) => Record<string, string>
  scaffold?: (project: ProjectInfo) => Promise<void>
}
export interface StudioRuntime extends FeaturePluginRuntime { studios: Record<string, StudioProvider> }
export interface ActivateOptions {
  pluginId: string; pluginDirectory: string; assetBaseUrl: string; userDataDir: string
  projectRoot: () => string | null
  emitEvent: (name: string, payload: unknown, windowId?: number) => void
}
declare global {
  interface Window {
    modmind: {
      featurePlugins: {
        invoke: (id: string, action: string, input: Record<string, unknown>) => Promise<any>
        onEvent: (id: string, event: string, callback: (value: any) => void) => () => void
      }
    }
  }
}
