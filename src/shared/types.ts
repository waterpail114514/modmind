import type { BlockbenchAction, BlockbenchBounds, BlockbenchBridgeStatus } from './blockbench'
import type { MinecraftApi } from './minecraft'
import type { MappingsApi } from './mappings'
import type { ProductionApi, ProjectFileMutationResult } from './production'

export type LoaderKind = 'fabric' | 'quilt' | 'forge' | 'neoforge'

export type LoaderSupportTier = 'stable' | 'experimental'

export interface LoaderVersionOption {
  loader: LoaderKind
  minecraftVersion: string
  loaderVersion: string
  apiVersion?: string
  qslVersion?: string
  javaVersion: number
  channel: 'release' | 'beta'
  supportTier: LoaderSupportTier
  notes: string[]
}

export interface ProjectInfo {
  name: string
  path: string
  loader: LoaderKind
  minecraftVersion: string
  namespace: string
  createdAt: string
  loaderVersion?: string
  apiVersion?: string
  qslVersion?: string
  javaVersion?: number
  projectVersion?: string
  toolDataDirectory?: '.modmind' | '.modtool'
}

export interface ProjectCreateInput {
  name: string
  loader: LoaderKind
  minecraftVersion: string
}

export interface ProjectMigrationInput {
  loader: LoaderKind
  minecraftVersion: string
}

export interface ProjectMigrationPreview {
  source: Pick<ProjectInfo, 'loader' | 'minecraftVersion'>
  target: LoaderVersionOption
  automaticChanges: string[]
  warnings: string[]
  blockers: string[]
}

export interface ProjectMigrationResult {
  project: ProjectInfo
  snapshot: SnapshotInfo
  reportPath: string
  changedFiles: string[]
  warnings: string[]
}

export type ExistingProjectKind = 'complete' | 'partial' | 'api-docs'

export interface ExistingProjectAnalysis {
  sourcePath: string
  sourceName: string
  kind: ExistingProjectKind
  fileCount: number
  sourceFileCount: number
  documentCount: number
  detectedFiles: string[]
  reasons: string[]
  inferred: ProjectCreateInput & { namespace: string }
}

export interface ExistingProjectAdoptInput extends ProjectCreateInput {
  sourcePath: string
  namespace: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export type PipelineStage = 'planning' | 'writing' | 'checking' | 'building' | 'complete' | 'error'

export interface PipelineEvent {
  id: string
  stage: PipelineStage
  title: string
  detail: string
  time: string
  status: 'running' | 'success' | 'warning' | 'error'
  todo?: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export interface PreflightResult {
  success: boolean
  summary: string
  logs: string[]
  reportPath?: string
}

export interface BuildTrustRequest {
  id: string
  projectName: string
  projectPath: string
}

export interface SnapshotInfo {
  id: string
  label: string
  createdAt: string
  fileCount: number
}

export interface SnapshotRestoreResult {
  snapshot: SnapshotInfo
  backup: SnapshotInfo
  project: ProjectInfo
}

export interface AiRecoveryInfo {
  pending: boolean
  snapshot: SnapshotInfo | null
}

export interface AiSettings {
  provider: 'openai-compatible' | 'openai' | 'local'
  codingBackend: 'internal' | 'codex' | 'claude' | 'opencode'
  codexExecutable?: string
  claudeExecutable?: string
  opencodeExecutable?: string
  baseUrl: string
  model: string
  apiKey: string
  hasStoredKey?: boolean
  parallelism: number
  agentMaxSteps: number
  maxBuilds: number
  allowBuildScriptChanges: boolean
  preferLocalGradle: boolean
  gradleExecutable?: string
  gradleDownloadSource: 'auto' | 'china' | 'official'
  darkMode: boolean
}

export interface ExternalAgentStatus {
  kind: 'codex' | 'claude' | 'opencode'
  label: string
  installed: boolean
  executable: string
  version?: string
  detail: string
}

export interface AiModelInfo {
  id: string
  ownedBy?: string
}

export interface AiOutputEvent {
  kind: 'start' | 'stream-start' | 'delta' | 'response' | 'answer' | 'retry' | 'tool' | 'warning' | 'error'
  content: string
  time: string
}

export interface InspirationChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiPlan {
  summary: string
  tasks: string[]
  files: Array<{ path: string; purpose: string }>
  tests: string[]
  warnings: string[]
}

export interface CodingResult extends AiPlan {
  snapshot: SnapshotInfo
  changedFiles: string[]
  intent?: 'engineering' | 'informational'
  todo?: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export interface ModMindApi {
  app: {
    getVersion: () => Promise<string>
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
  project: {
    listLoaderVersions: (refresh?: boolean) => Promise<LoaderVersionOption[]>
    create: (input: ProjectCreateInput) => Promise<ProjectInfo | null>
    open: () => Promise<ProjectInfo | null>
    openRecent: (projectPath: string) => Promise<ProjectInfo>
    listRecent: () => Promise<ProjectInfo[]>
    removeRecent: (projectPath: string) => Promise<ProjectInfo[]>
    inspectExisting: (sourceType?: 'folder' | 'zip') => Promise<ExistingProjectAnalysis | null>
    adoptExisting: (input: ExistingProjectAdoptInput) => Promise<ProjectInfo | null>
    current: () => Promise<ProjectInfo | null>
    listFiles: () => Promise<FileNode[]>
    readFile: (relativePath: string) => Promise<string>
    writeFile: (relativePath: string, content: string) => Promise<void>
    createFile: (relativePath: string, content?: string) => Promise<ProjectFileMutationResult>
    createDirectory: (relativePath: string) => Promise<ProjectFileMutationResult>
    renamePath: (from: string, to: string) => Promise<ProjectFileMutationResult>
    deletePath: (relativePath: string) => Promise<void>
    reveal: (relativePath?: string) => Promise<void>
    exportArtifact: () => Promise<string | null>
    prepareIde: () => Promise<string[]>
    openIde: () => Promise<void>
    captureIdea: (prompt: string) => Promise<void>
    previewMigration: (input: ProjectMigrationInput) => Promise<ProjectMigrationPreview>
    migrate: (input: ProjectMigrationInput) => Promise<ProjectMigrationResult | null>
  }
  build: {
    preflight: () => Promise<PreflightResult>
    onProgress: (listener: (event: PipelineEvent) => void) => () => void
    respondTrust: (id: string, allow: boolean) => Promise<void>
    onTrustRequired: (listener: (request: BuildTrustRequest) => void) => () => void
  }
  snapshots: {
    create: (label: string) => Promise<SnapshotInfo>
    list: () => Promise<SnapshotInfo[]>
    restore: (id: string) => Promise<SnapshotRestoreResult>
    delete: (id: string) => Promise<SnapshotInfo[]>
  }
  settings: {
    getAi: () => Promise<AiSettings>
    saveAi: (settings: AiSettings) => Promise<AiSettings>
    listModels: (settings: AiSettings) => Promise<AiModelInfo[]>
  }
  ai: {
    createCode: (prompt: string, sessionId?: string, backend?: AiSettings['codingBackend']) => Promise<CodingResult>
    cancelCode: () => Promise<void>
    getRecovery: () => Promise<AiRecoveryInfo>
    resumeRecovery: () => Promise<CodingResult>
    restoreRecovery: () => Promise<SnapshotInfo | null>
    inspire: (message: string, history: InspirationChatMessage[]) => Promise<string>
    onProgress: (listener: (event: PipelineEvent) => void) => () => void
    onOutput: (listener: (event: AiOutputEvent) => void) => () => void
  }
  externalAgents: {
    detect: () => Promise<ExternalAgentStatus[]>
    history: (kind: 'codex' | 'claude' | 'opencode') => Promise<string>
    install: (kind: 'codex' | 'claude' | 'opencode') => Promise<ExternalAgentStatus>
    openDocs: (kind: 'codex' | 'claude' | 'opencode') => Promise<void>
    launch: (kind: 'codex' | 'claude' | 'opencode') => Promise<void>
  }
  blockbench: {
    show: (bounds: BlockbenchBounds) => Promise<void>
    hide: () => Promise<void>
    openProject: () => Promise<void>
    saveProject: () => Promise<void>
    runAction: (action: string) => Promise<void>
    execute: (action: BlockbenchAction) => Promise<unknown>
    getState: () => Promise<BlockbenchBridgeStatus & Record<string, unknown>>
    onState: (listener: (state: BlockbenchBridgeStatus & Record<string, unknown>) => void) => () => void
  }
  mappings: MappingsApi
  minecraft: MinecraftApi
  production: ProductionApi
}
