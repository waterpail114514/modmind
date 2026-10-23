import type { FeaturePluginDefinition, FeaturePluginManifest } from './featurePlugins'
import type { AiOutputEvent, AgentSettings } from './types'

export interface DeveloperProject {
  format: 'modmind-developer'
  version: 1
  id: string
  name: string
  kind: 'feature' | 'studio'
  sourceMode?: 'package'
  createdAt: string
  root: string
  session: string
}
export interface DeveloperFile { path: string; bytes: number; readOnly: boolean }
export interface DeveloperDiagnostic { file?: string; line?: number; column?: number; message: string }
export interface DeveloperBuild {
  id: string
  sourceRevision: string
  manifest: FeaturePluginManifest
  completedAt: string
  bytes: number
  archiveSha256: string
}
export interface DeveloperState {
  project: DeveloperProject
  files: DeveloperFile[]
  manifest: FeaturePluginDefinition | null
  build: DeveloperBuild | null
}
export interface DeveloperText { path: string; content: string; revision: string }
export interface DeveloperPreview { buildId: string; html: string; url?: string; token: string; readOnly: boolean; pages: { id: string; label: string }[] }
export interface DeveloperDebugResult {
  status: 'completed'
  buildId: string
  result: unknown
  logs: string[]
  projectPath: string
  events: { name: string; payload: unknown; delivered?: boolean }[]
  mcp?: { initialize: unknown; catalog: unknown; response: unknown }
}
export interface DeveloperConversation {
  id: string
  title: string
  prompt: string
  nativeSessionId?: string
  nativeSessions?: Partial<Record<AgentSettings['codingBackend'], string>>
  pinned?: boolean
  timeline: unknown[]
  updatedAt: string
}
export interface DeveloperAiEvent { session: string; conversationId: string; event: AiOutputEvent }
export type DeveloperDebugInput = {
  operation: 'inspect' | 'action' | 'tool' | 'create-studio'
  name?: string
  input?: Record<string, unknown>
  readOnly?: boolean
}
export interface DeveloperApi {
  recent: () => Promise<Omit<DeveloperProject, 'session'>[]>
  editorTypes: () => Promise<{ path: string; content: string }[]>
  create: (input: { id: string; name: string; kind: 'feature' | 'studio' }) => Promise<DeveloperState | null>
  open: (root?: string) => Promise<DeveloperState | null>
  importPackage: () => Promise<DeveloperState | null>
  close: (session: string) => Promise<void>
  state: (session: string) => Promise<DeveloperState>
  read: (session: string, file: string) => Promise<DeveloperText>
  write: (session: string, file: string, content: string, revision: string | null) => Promise<DeveloperText>
  remove: (session: string, file: string, revision: string) => Promise<void>
  importAssets: (session: string) => Promise<DeveloperState | null>
  build: (session: string) => Promise<DeveloperBuild>
  preview: (session: string, page?: string, dark?: boolean, readOnly?: boolean) => Promise<DeveloperPreview>
  debug: (session: string, input: DeveloperDebugInput) => Promise<DeveloperDebugResult>
  previewInvoke: (session: string, channel: string, args: unknown[], readOnly?: boolean) => Promise<DeveloperDebugResult>
  onPreviewEvent: (callback: (event: { session: string; channel: string; args: unknown[] }) => void) => () => void
  export: (session: string) => Promise<{ path: string; bytes: number; buildId: string } | null>
  cancel: (session: string) => Promise<void>
  drafts: (session: string) => Promise<DeveloperText[]>
  saveDrafts: (session: string, drafts: DeveloperText[]) => Promise<void>
  restoreCheckpoint: (session: string) => Promise<void>
  conversations: (session: string) => Promise<DeveloperConversation[]>
  saveConversation: (session: string, conversation: DeveloperConversation) => Promise<void>
  deleteConversation: (session: string, id: string) => Promise<void>
  runAi: (session: string, conversationId: string, prompt: string, backend: AgentSettings['codingBackend'], selection?: import('./aiSelection').AiModelSelection) => Promise<void>
  stopAi: (session: string) => Promise<void>
  onAi: (callback: (event: DeveloperAiEvent) => void) => () => void
}
