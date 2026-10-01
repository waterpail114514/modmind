import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { DeviceConnectionState, ProjectInfo, UiMode } from '../../shared/types'

export interface FeaturePageContext {
  project: ProjectInfo | null
  visible: boolean
  darkMode: boolean
  uiMode: UiMode
  deviceState: DeviceConnectionState
  routeData: unknown
  hasPage: (id: string) => boolean
  navigate: (id: string, data?: unknown) => void
  openSettings: (section?: string) => void
  filesChanged: () => void
  openFile: (path?: string) => void
  createFile: (path: string, content?: string) => void
  openProject: (project: ProjectInfo) => void
  sendToWorkbench: (prompt: string) => void
  setNotice: (notice: string) => void
  projectBusy: boolean
  saveBeforeRestore: () => Promise<void>
  projectRestored: (project: ProjectInfo) => void
}

export interface FeaturePageDefinition {
  id: string
  label: string
  group: string
  icon: LucideIcon
  order?: number
  keepAlive?: boolean
  scope?: 'application' | 'project'
  className?: string
  supports?: (project: ProjectInfo | null, uiMode: UiMode) => boolean
  component: ComponentType<FeaturePageContext>
  exportName?: string
}

export interface FeatureSettingsDefinition {
  id: string
  category: 'general' | 'ai' | 'development' | 'integrations' | 'about'
  keywords: string
  className?: string
  supports?: (project: ProjectInfo | null) => boolean
  component: ComponentType<FeaturePageContext>
  exportName?: string
}

export interface FeatureRendererModule {
  apiVersion: 2
  pages: FeaturePageDefinition[]
  settings?: FeatureSettingsDefinition[]
  launcherActions?: ComponentType<FeaturePageContext>[]
  backgroundComponents?: ComponentType<FeaturePageContext>[]
}
