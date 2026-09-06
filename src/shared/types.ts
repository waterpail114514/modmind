import type { BlockbenchAction, BlockbenchBounds, BlockbenchBridgeStatus } from './blockbench'
import type { LocalServerEvent, LocalServerState, MinecraftApi, MinecraftRuntimeState } from './minecraft'
import type { MappingsApi } from './mappings'
import type { ProductionApi, ProjectFileMutationResult } from './production'
import type { ImageGenerationRequest, ImageGenerationResult, ImageHistoryItem, ImageProcessingOptions, ImageProcessingResult, ImageStudioCapabilities, ImageStudioSettings, ImageStudioSettingsInput } from './imageStudio'
import type { AssetIntentCandidate, AssetIntentPreview, AssetIntentProgram, AssetRefinementCandidate, AssetRefinementPreview, AssetRefinementProgram } from './assetIntent'
import type {AdvancedAssetCandidate, AdvancedAssetComparison, AdvancedAssetPreviewOptions, AdvancedAssetProgram, AssetVisualReview, ReferenceImageAssetCandidate, ReferenceImageAssetProgram} from './advancedAsset'

export type JavaLoaderKind = 'fabric' | 'quilt' | 'forge' | 'neoforge'
export type AddonPlatformKind = 'bedrock' | 'netease-pc' | 'netease-mobile'
export type LoaderKind = JavaLoaderKind | AddonPlatformKind
export type ProjectKind = 'mod' | 'modpack'

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
  kind?: ProjectKind
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
  toolDataDirectory?: '.modmind'
}

export interface ProjectCreateInput {
  name: string
  loader: LoaderKind
  minecraftVersion: string
  /** Optional version detected from an existing project's build metadata. */
  loaderVersion?: string
  kind?: ProjectKind
}

export interface ProjectRenameInput {
  name: string
  namespace: string
  projectPath?: string
}

export interface ModpackManagedMod {
  fileName: string
  sha256: string
  size: number
  addedAt: string
}

export type ModpackModuleSide = 'client' | 'server' | 'both' | 'unknown'

export interface ModpackLocalModule {
  name: string
  namespace: string
  path: string
  createdAt: string
  /** Missing values from older manifests are normalized to `both`. */
  side?: ModpackModuleSide
}

/**
 * `archive` is the directory layout produced by Modrinth/CurseForge pack
 * archives: runtime files, including local JARs, live below `overrides/`.
 */
export type ModpackLayout = 'workspace' | 'instance' | 'archive'
export type ModpackImportFormat = 'workspace' | 'instance' | 'prism' | 'multimc' | 'curseforge' | 'modrinth' | 'hmcl' | 'pcl'

export interface ModpackImportSource {
  format: ModpackImportFormat
  layout: ModpackLayout
  importedAt: string
  unresolvedDependencies?: number
}

export interface ModpackManifest {
  version: 1
  name: string
  minecraftVersion: string
  loader: JavaLoaderKind
  mods: ModpackManagedMod[]
  modules: ModpackLocalModule[]
  source?: ModpackImportSource
}

/** Manifest written only after the initial server-pack synchronization completes. */
export interface ServerPackManifest {
  version: number
  name: string
  minecraftVersion: string
  loader: JavaLoaderKind
  loaderVersion: string
  engine: string
  engineVersion: string
  port: number
  onlineMode: boolean
  eulaAccepted: boolean
  mods: string[]
  skippedClientMods: string[]
  directMods?: string[]
  generatedAt: string
  engineLog?: string
}

export type ModpackContentKind =
  | 'config'
  | 'scripts'
  | 'datapacks'
  | 'quests'
  | 'resourcepacks'
  | 'shaderpacks'
  | 'ui'
  | 'worlds'
  | 'client'
  | 'server'
  | 'other'

export type ModpackContentScope = 'common' | 'client' | 'server'
export type ModpackContentDelivery = 'embedded' | 'remote'

export interface ModpackContentItem {
  id: string
  path: string
  kind: ModpackContentKind
  scope: ModpackContentScope
  delivery: ModpackContentDelivery
  directory?: boolean
  sourceUrl?: string
  sha1?: string
  sha512?: string
  size?: number
  addedAt: string
}

export interface ModpackContentInventory {
  version: 1
  items: ModpackContentItem[]
}

export type FtbQuestBookFormat = 'snbt' | 'json5'

export interface FtbQuestDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  chapterId?: string
  questId?: string
}

export interface FtbQuestTaskDocument {
  id: string
  type: string
  title?: string
  /** 所有类型专属字段（item、count、entity、value…）都保存在 raw 中并原样读写。 */
  raw: Record<string, unknown>
}

export interface FtbQuestRewardDocument {
  id: string
  type: string
  title?: string
  /** 所有类型专属字段（item、count、xp、command…）都保存在 raw 中并原样读写。 */
  raw: Record<string, unknown>
}

export interface FtbQuestDocumentQuest {
  id: string
  title: string
  /** A display-only title derived from the first task; do not write it unless the user edits it. */
  titleIsFallback: boolean
  subtitle: string
  description: string
  icon: string
  shape: string
  x: number
  y: number
  dependencies: string[]
  /** 完成依赖任务的最少数量；未设置时表示需要全部完成。 */
  minRequiredTasks?: number
  /** 隐藏依赖连线（游戏中只显示依赖图标）。 */
  hideDependencyLines?: boolean
  tasks: FtbQuestTaskDocument[]
  rewards: FtbQuestRewardDocument[]
  raw: Record<string, unknown>
}

export interface FtbQuestDocumentChapter {
  id: string
  title: string
  subtitle: string
  icon: string
  group: string
  filename: string
  source: string
  quests: FtbQuestDocumentQuest[]
  raw: Record<string, unknown>
}

export interface FtbQuestBook {
  format: FtbQuestBookFormat
  root: string
  chapters: FtbQuestDocumentChapter[]
  /** 奖励表（reward_tables/ 目录，每表一个文件）。 */
  rewardTables: FtbQuestRewardTable[]
  diagnostics: FtbQuestDiagnostic[]
}

/** 奖励表中的单个条目：一个奖励 + 抽取权重。 */
export interface FtbQuestRewardTableEntry {
  id: string
  type: string
  title?: string
  /** 抽取权重（游戏默认 1.0）。 */
  weight: number
  /** 类型专属字段（item、count、xp…）原样读写。 */
  raw: Record<string, unknown>
}

/** FTB Quests 奖励表，存储于 reward_tables/{filename}.snbt/json5。 */
export interface FtbQuestRewardTable {
  id: string
  filename: string
  source: string
  title: string
  useTitle: boolean
  hideTooltip: boolean
  emptyWeight: number
  lootSize: number
  lootCrate: { stringId: string; itemName: string; color: number; glow: boolean; passive: number; monster: number; boss: number } | null
  rewards: FtbQuestRewardTableEntry[]
  raw: Record<string, unknown>
}

export interface FtbQuestSaveResult {
  written: string[]
  removed: string[]
  diagnostics: FtbQuestDiagnostic[]
}

export interface ModpackContentImportResult {
  items: ModpackContentItem[]
  copiedFiles: number
}

export interface ModpackContentDownloadInput {
  kind: ModpackContentKind
  scope?: ModpackContentScope
  url: string
  targetPath?: string
  extract?: boolean
}

export interface ModpackContentDownloadResult {
  item: ModpackContentItem
  downloadedBytes: number
  extractedFiles?: number
}

export interface ModpackKeybindConflict {
  key: string
  bindings: string[]
}

export interface ModpackKeybindState {
  path: string
  bindings: Record<string, string>
  conflicts: ModpackKeybindConflict[]
}

export interface ModpackProviderInfo {
  id: 'modrinth' | 'curseforge'
  label: string
  configured: boolean
  supportsDependencies: boolean
}

export type ModpackSearchProvider = 'modrinth' | 'curseforge' | 'mcmod'

export interface ModpackSearchHit {
  provider: ModpackSearchProvider
  projectId: string
  slug: string
  name: string
  summary: string
  projectUrl: string
  downloads: number
  clientSide: 'client' | 'server' | 'both' | 'unknown'
  serverSide: 'client' | 'server' | 'both' | 'unknown'
  iconUrl?: string
  updatedAt?: string
}

export interface ModpackSearchResponse {
  provider: ModpackSearchProvider
  total: number
  hits: ModpackSearchHit[]
  error?: string
}

export interface ModpackFileOption {
  provider: 'modrinth' | 'curseforge'
  projectId: string
  versionId: string
  versionName: string
  filename: string
  side: 'client' | 'server' | 'both' | 'unknown'
  size?: number
  publishedAt?: string
}

export type ModpackMigrationStatus = 'compatible' | 'replacement' | 'source-port' | 'missing' | 'unknown'
export type ModpackMigrationContentStatus = 'compatible' | 'review' | 'blocked'

export interface ModpackMigrationCandidate {
  provider: 'modrinth' | 'curseforge'
  projectId: string
  versionId: string
  versionName: string
  fileName: string
  name: string
  side: ModpackModuleSide
  relation: 'same-project' | 'search-candidate' | 'mcmod-alias'
  confidence: 'exact' | 'candidate'
}

export interface ModpackMigrationJarEvidence {
  sha1: string
  sha512: string
  loader: JavaLoaderKind
  classCount: number
  packages: string[]
  dependencies: Array<{ modId?: string; provider?: 'modrinth' | 'curseforge'; projectId?: string; versionId?: string; kind: 'required' | 'optional' | 'incompatible' | 'embedded' }>
  warnings: string[]
}

export interface ModpackMigrationModAssessment {
  id: string
  sourceFileName: string
  sourceName: string
  sourceVersion: string
  sourceSha256: string
  sourceSize: number
  sourceJar?: ModpackMigrationJarEvidence
  sourceProvider?: 'modrinth' | 'curseforge' | 'mcmod'
  sourceProjectId?: string
  sourceModIds?: string[]
  sourceUrl?: string
  sourceLicense?: string
  identityEvidence: 'lock' | 'hash' | 'metadata' | 'mcmod' | 'unknown'
  mcmodMatches?: McmodSearchResult[]
  status: ModpackMigrationStatus
  reason: string
  compatible?: ModpackMigrationCandidate
  alternatives: ModpackMigrationCandidate[]
}

export interface ModpackMigrationModuleAssessment {
  id: string
  name: string
  namespace: string
  path: string
  status: 'source-port'
  reason: string
}

export interface ModpackMigrationContentAssessment {
  kind: ModpackContentKind
  count: number
  paths: string[]
  status: ModpackMigrationContentStatus
  reason: string
  copyByDefault: boolean
}

export interface ModpackMigrationAssessment {
  source: Pick<ProjectInfo, 'loader' | 'minecraftVersion' | 'loaderVersion'>
  target: LoaderVersionOption
  direction: 'upgrade' | 'downgrade' | 'loader-change'
  mods: ModpackMigrationModAssessment[]
  modules: ModpackMigrationModuleAssessment[]
  content: ModpackMigrationContentAssessment[]
  summary: Record<ModpackMigrationStatus, number>
  warnings: string[]
}

export interface ModpackMigrationProgress {
  phase: 'inventory' | 'identifying' | 'content' | 'complete'
  completed: number
  total: number
  message: string
}

export type ModpackMigrationModDecision =
  | { modId: string; action: 'use-compatible'; candidate: ModpackMigrationCandidate }
  | { modId: string; action: 'use-replacement'; candidate: ModpackMigrationCandidate }
  | { modId: string; action: 'manual-file'; filePath: string }
  | { modId: string; action: 'create-compat-module' }
  | { modId: string; action: 'defer' }
  | { modId: string; action: 'remove' }

export interface ModpackMigrationModuleDecision {
  moduleId: string
  action: 'port-source' | 'remove'
}

export interface ModpackMigrationContentDecision {
  kind: ModpackContentKind
  action: 'copy' | 'exclude'
}

export interface ModpackMigrationCreateInput {
  loader: JavaLoaderKind
  minecraftVersion: string
  mode?: ModpackMigrationMode
  mods: ModpackMigrationModDecision[]
  modules: ModpackMigrationModuleDecision[]
  content: ModpackMigrationContentDecision[]
}

export type ModpackMigrationMode = 'backup' | 'direct'
export type ModpackMigrationProjectStatus = 'complete' | 'incomplete'

export interface ModpackMigrationRecord {
  id: string
  mode: ModpackMigrationMode
  status: ModpackMigrationProjectStatus | 'undone'
  source: Pick<ProjectInfo, 'loader' | 'minecraftVersion' | 'loaderVersion'>
  target: Pick<ProjectInfo, 'loader' | 'minecraftVersion' | 'loaderVersion'>
  sourceSnapshotId?: string
  preUndoSnapshotId?: string
  reportPath: string
  deferred: string[]
  createdAt: string
  completedAt: string
  undoneAt?: string
}

export interface ModpackMigrationManualFile {
  filePath: string
  fileName: string
  displayName: string
  version: string
  loader: JavaLoaderKind
  modIds: string[]
  sha256: string
  warnings: string[]
}

export interface ModpackMigrationCreateResult {
  project: ProjectInfo
  migrationId: string
  mode: ModpackMigrationMode
  status: ModpackMigrationProjectStatus
  sourceSnapshotId?: string
  canUndo: boolean
  reportPath: string
  installed: string[]
  manualFiles: string[]
  removed: string[]
  deferred: string[]
  portedModules: string[]
  copiedContent: string[]
  warnings: string[]
}

export interface ModpackMigrationUndoResult {
  migration: ModpackMigrationRecord
  restoredProject: ProjectInfo
  preUndoSnapshot: SnapshotInfo
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

export type ExistingProjectKind = 'complete' | 'partial' | 'api-docs' | 'modpack'

export interface ExistingModpackAnalysis {
  format: ModpackImportFormat
  layout: ModpackLayout
  loaderVersion?: string
  modCount: number
  overrideCount: number
  unresolvedDependencyCount: number
}

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
  modpack?: ExistingModpackAnalysis
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

export interface ProjectImageAsset {
  path: string
  size: number
}

export interface AiAttachment {
  id: string
  name: string
  path: string
  size: number
  isImage: boolean
  isDirectory?: boolean
}

/** 从整合包 mod jar 提取出的物品图标。动画贴图为纵向精灵图，渲染端按帧裁剪并播放。 */
export interface FtbQuestIconResult {
  url: string
  frameWidth: number
  frameHeight: number
  frameCount: number
  frametimeMs: number
  animated: boolean
}

/** 任务节点形状的三层贴图。 */
export interface FtbQuestShapeSet {
  shape: string
  background: string
  outline: string
}

/** Structured user-turn data retained for edit, resend, and context rebuilds. */
export interface AiTurnReplay {
  prompt: string
  attachments?: AiAttachment[]
}

export type AiAttachmentSelectionKind = 'files' | 'directory'

export type PipelineStage = 'planning' | 'writing' | 'checking' | 'building' | 'complete' | 'error'

/** The visible product surface; it is independent from the configured AI backend. */
export type UiMode = 'beginner' | 'advanced'

export type BeginnerTaskState = 'idle' | 'working' | 'success' | 'error'

export interface PipelineEvent {
  id: string
  sessionId?: string
  projectPath?: string
  runId?: string
  conversationId?: string
  generation?: number
  turnId?: string
  sequence?: number
  eventId?: string
  /** Backend that actually produced this event. */
  backend?: CodingBackend
  stage: PipelineStage
  title: string
  detail: string
  time: string
  status: 'running' | 'success' | 'warning' | 'error'
  /** Error-like progress can be recoverable and should remain inside steps. */
  terminal?: boolean
  recoverable?: boolean
  todo?: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export interface PreflightResult {
  success: boolean
  summary: string
  logs: string[]
  reportPath?: string
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
  sessionId?: string
  /** Workbench conversation the interrupted task belongs to. */
  conversationId?: string
  /** Backend that last owned the unified recovery checkpoint. */
  backend?: CodingBackend
  /** Monotonic unified-context revision. */
  contextRevision?: number
  lifecycle?: 'running' | 'waiting_retry' | 'repairing' | 'action_required' | 'paused'
  retry?: {
    category: 'rate-limit' | 'server' | 'connection' | 'no-output' | 'compatibility' | 'process' | 'policy' | 'action-required' | 'cancelled'
    attempt: number
    message: string
    nextAttemptAt?: string
  }
}

export interface BeginnerTaskStatus {
  state: BeginnerTaskState
  label: string
  detail: string
}

export type BeginnerCodexStage = 'checking' | 'downloading' | 'verifying' | 'configuring' | 'ready' | 'error'

export interface BeginnerCodexProgress {
  stage: BeginnerCodexStage
  title: string
  detail: string
  status: 'running' | 'success' | 'warning' | 'error'
  projectPath?: string
}

export interface BeginnerCodexPreparationResult {
  ready: boolean
  version: string
  configChanged: boolean
  configSource: 'device' | 'local-settings'
}

export type DeviceConnectionStatus = 'disconnected' | 'authorizing' | 'connected' | 'error'
export type DeviceKeyStatus = 'ACTIVE' | 'FROZEN'

export interface DeviceConnectionState {
  status: DeviceConnectionStatus
  configured: boolean
  siteUrl?: string
  username?: string
  balanceCents?: string
  keyStatus?: DeviceKeyStatus
  frozenReason?: string | null
  checkedAt?: string
  expiresAt?: string
  message?: string
}

export type RemoteConnectionStatus = 'disabled' | 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'error'

export interface RemoteConnectionState {
  status: RemoteConnectionStatus
  enabled: boolean
  endpoint?: string
  deviceId?: string
  protocolVersion?: number
  activeRequestId?: string
  lastError?: string
  reconnectAt?: string
}

/** 外部 MCP 接入桥（--mcp-bridge）的运行状态，供设置页开关展示。 */
export interface McpBridgeState {
  /** 用户偏好：是否允许外部 MCP 客户端接入。 */
  enabled: boolean
  /** 桥接服务当前是否正在监听。 */
  running: boolean
  /** 桥接绑定的项目路径（未运行时为 null）。 */
  projectPath: string | null
  projectName: string | null
  /** mcp-config.json 的位置，外部 MCP 客户端从这里读取接入配置。 */
  mcpConfigPath: string | null
  startedAt: string | null
}

export interface AppVersionCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  currentChannel: 'stable' | 'beta'
  targetChannel: 'stable' | 'beta'
  downloadUrl?: string
}

export type AppUpdatePhase = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  latestVersion?: string
  targetChannel?: 'stable' | 'beta'
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  message?: string
}

export interface DeviceUsage {
  keyStatus: DeviceKeyStatus
  frozenReason: string | null
  balanceCents: string
  usedQuota: string
  remainQuota: string
  billedCentsTotal: string
  lastSeenUsedQuota: string
  quotaSyncedAt: string | null
  checkedAt: string
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type BeginnerReasoningLevel = 'low' | 'medium' | 'high' | 'extreme'
export type AiExecutionProfile = 'standard' | 'beginner-unlimited'
export type ExternalAgentKind = 'codex' | 'claude'
export type CodingBackend = 'quota' | ExternalAgentKind
export type ExternalAgentProvider = ExternalAgentKind

export interface ExternalAgentConfiguration {
  executable?: string
  mode?: 'local' | 'hosted'
  baseUrl?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  apiKey?: string
  hasStoredKey?: boolean
}

export interface BeginnerAiPreferences {
  model: string
  reasoningLevel: BeginnerReasoningLevel
  fastMode: boolean
}

export interface JavaPreferences {
  game: string
  build: string
  tools: string
}

export interface AgentSettings {
  codingBackend: CodingBackend
  externalAgents?: Partial<Record<ExternalAgentKind, ExternalAgentConfiguration>>
  allowBuildScriptChanges: boolean
  preferLocalGradle: boolean
  gradleExecutable?: string
  gradleDownloadSource: 'auto' | 'china' | 'official'
  networkProxyUrl?: string
  javaPreferences: JavaPreferences
  darkMode: boolean
  closeBehavior: 'ask' | 'tray' | 'quit'
  notificationsEnabled: boolean
}

export interface DetectedJavaHome {
  home: string
  major: number
}

export interface JavaProbeOutcome {
  valid: boolean
  major: number
}

export interface ExternalAgentStatus {
  kind: ExternalAgentKind
  label: string
  installed: boolean
  executable: string
  version?: string
  detail: string
}

export interface ExternalAgentProviderSetup {
  kind: ExternalAgentProvider
  executable?: string
  configPath?: string
  detail: string
}

export interface AiModelInfo {
  id: string
  ownedBy?: string
}

export interface McmodSearchResult {
  projectId: string
  name: string
  summary: string
  pageUrl: string
  iconUrl?: string
  englishName?: string
}

export interface McmodFileInfo {
  fileId: string
  projectId: string
  fileKey: string
  filename: string
  minecraftVersion: string
  loaders: string[]
  sha256: string
  size?: number
}

export interface McmodManualRequirement {
  request: string
  reason: string
  matches: McmodSearchResult[]
}

export interface McmodCaptchaChallenge {
  sessionId: string
  file: McmodFileInfo
  captchaDataUrl: string
  attemptsRemaining: number
  expiresAt: string
}

export interface McmodDownloadResult {
  success: boolean
  message: string
  attemptsRemaining: number
  captchaDataUrl?: string
  fileName?: string
  sha256?: string
  filePath?: string
}

export interface GradleInstallation {
  path: string
  version?: string
}

export interface AiTokenUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  contextWindow?: number
}

export interface AiOutputEvent {
  kind: 'start' | 'stream-start' | 'delta' | 'response' | 'answer' | 'retry' | 'tool' | 'warning' | 'error'
  content: string
  time: string
  sessionId?: string
  projectPath?: string
  runId?: string
  /** Durable conversation routing. Events without these fields are legacy-only. */
  conversationId?: string
  generation?: number
  turnId?: string
  /** Monotonic within one conversation generation; used for replay and dedupe. */
  sequence?: number
  eventId?: string
  /** Stable provider item identity. Deltas for one item may update its projection. */
  itemId?: string
  /** Stable stream identity used to merge only the active streaming item. */
  streamId?: string
  /** Backend that actually produced this event. */
  backend?: CodingBackend
  /** Latest CLI-reported token usage; lets the workbench show context occupancy. */
  usage?: AiTokenUsage
  /** Only terminal failures should become the workbench's red error state. */
  terminal?: boolean
  recoverable?: boolean
}

export interface InspirationChatMessage {
  role: 'user' | 'assistant'
  kind?: 'tool'
  id?: string
  time?: string
  sessionId?: string
  turnId?: string
  sequence?: number
  content: string
  status?: 'streaming' | 'completed' | 'error' | 'cancelled'
  dedupeKey?: string
  replay?: AiTurnReplay
  /** Only the completed answer for a turn can be sent to the workbench. */
  isFinal?: boolean
}

export type AiSurface = 'workspace' | 'inspiration'

export type ConversationEventKind = 'user' | 'progress' | 'output' | 'system'

export interface ConversationEventRecord {
  eventId: string
  conversationId: string
  generation: number
  turnId: string
  runId?: string
  sequence: number
  kind: ConversationEventKind
  time: string
  payload: unknown
}

export interface ConversationNativeState {
  sessionId: string
  sessionHome?: string
  lastModmindTurnId?: string
  /** Native turn corresponding to the latest completed ModMind turn. */
  lastTurnId?: string
  updatedAt: string
}

export interface ConversationBranchPoint {
  conversationId: string
  generation: number
  turnId?: string
  nativeTurnId?: string
  boundary?: 'before' | 'through'
  sequence?: number
  /** Claude cannot fork at an arbitrary historical turn and uses this fallback. */
  nativeMode: 'native' | 'visible-history-rebuild'
}

export interface ConversationSummary {
  id: string
  surface: AiSurface
  title: string
  createdAt: string
  updatedAt: string
  generation: number
  archived?: boolean
  parent?: ConversationBranchPoint
}

export interface ConversationDocument extends ConversationSummary {
  schemaVersion: 2
  lastSequence: number
  checkpointSequence: number
  events: ConversationEventRecord[]
  /** Renderer-owned projection. Durable events remain the recovery authority. */
  view: { timeline?: unknown[]; messages?: InspirationChatMessage[] }
  native: Partial<Record<CodingBackend, ConversationNativeState>>
  nativeTurns: Record<string, Partial<Record<CodingBackend, string>>>
  /** A native fork is consumed once by the first turn on this branch. */
  nativeForkPending?: boolean
}

export interface ConversationCreateInput {
  id?: string
  surface: AiSurface
  title?: string
  view?: ConversationDocument['view']
}

export interface ConversationForkInput {
  sourceConversationId: string
  id?: string
  title?: string
  beforeTurnId?: string
  throughTurnId?: string
  throughSequence?: number
  view: ConversationDocument['view']
  /** Backend selected for the first turn on the branch. */
  backend?: CodingBackend
}

export interface ConversationEventsPage {
  conversationId: string
  generation: number
  checkpointSequence: number
  events: ConversationEventRecord[]
  nextSequence: number | null
}

export interface AiCreateCodeOptions {
  surface?: AiSurface
  sessionScope?: string
  resumeSession?: boolean
  /** Unwrapped inspiration question used for per-turn latency policy. */
  inspirationQuestion?: string
  /** Allows an independently opened workbench to bind a task to its project. */
  projectPath?: string
  /** Original request used if a persisted CLI session is no longer available. */
  fallbackPrompt?: string
  /** Internal identity shared by all retry attempts of one AI run. */
  runId?: string
  /** Required by current renderers; optional only for legacy IPC callers. */
  conversationId?: string
  generation?: number
  turnId?: string
  /** Pending native branch operation created by edit/rewind. */
  forkFrom?: { sessionId: string; lastTurnId?: string; beforeTurnId?: string; nativeMode: 'native' | 'visible-history-rebuild' }
}

export interface AiProjectTaskState {
  codingSessionId?: string
  /** Stable start time of the active workspace run, including pre-session setup. */
  startedAt?: string
  /** Workbench conversation owning the active task, parsed from its session scope. */
  activeConversationId?: string
  /** Backend of the currently running workspace process. */
  backend?: CodingBackend
  readOnlyTaskCount: number
}

export interface WorkbenchDataReadResult {
  status: 'ok' | 'missing' | 'unavailable'
  content?: string
  revision: number
  source: 'project-store' | 'user-mirror' | 'legacy' | 'tombstone' | 'none'
  recovered?: boolean
  warning?: string
  message?: string
}

export interface WorkbenchDataWriteResult {
  revision: number
  bytes: number
  durability: 'redundant' | 'degraded'
  copies: {
    project: boolean
    mirror: boolean
    compatibility: boolean
  }
  warning?: string
}

export interface AiBackendSwitchResult {
  status: 'completed' | 'idle' | 'superseded' | 'rejected'
  backend: CodingBackend
  result?: CodingResult
  message?: string
  activeBackend?: CodingBackend
  activeSwitchId?: number
  activeReady?: boolean
}

export interface AiBackendReadyEvent {
  backend: CodingBackend
  projectPath: string
  switchId?: number
}

export interface AiCancellationResult {
  status: 'idle' | 'stopped' | 'timed_out'
  matched: number
  remaining: number
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
  finalResponse?: string
  todo?: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export interface DiagnosticPageSnapshot {
  view: string
  title: string
  url: string
  capturedAt: string
  html: string
}

export type SidebarViewId =
  | 'workspace'
  | 'relationships'
  | 'modpack-content'
  | 'ftb-quests'
  | 'patchouli'
  | 'modpack-automation'
  | 'modpack-migration'
  | 'modpack-server'
  | 'modpack-mod-list'
  | 'third-party-mods'
  | 'modpack-manifest'
  | 'modpack-config'
  | 'modpack-scripts'
  | 'modpack-datapacks'
  | 'modpack-resourcepacks'
  | 'modpack-shaders'
  | 'modpack-ui'
  | 'modpack-worlds'
  | 'modpack-client'
  | 'modpack-server-content'
  | 'modpack-files'
  | 'inspiration'
  | 'image-studio'
  | 'blockbench'
  | 'minecraft'
  | 'mappings'
  | 'code'
  | 'build'
  | 'snapshots'
  | 'production'
  | 'settings'
  | 'plugins'
  | `plugin:${string}`
  | 'decompile'

export type DetachedWindowTarget = SidebarViewId | `group:${string}`

export interface DetachedWindowState {
  alwaysOnTop: boolean
}

export type DownloadActivityStatus = 'downloading' | 'completed' | 'failed' | 'cancelled'

export interface DownloadActivity {
  id: string
  label: string
  detail?: string
  status: DownloadActivityStatus
  retryable?: boolean
  cancellable?: boolean
  restartable?: boolean
  downloadedBytes: number
  totalBytes?: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  error?: string
}

export interface DownloadActivitySnapshot {
  activities: DownloadActivity[]
}

export interface ModMindApi {
  app: {
    getVersion: () => Promise<string>
    checkForUpdates: () => Promise<AppVersionCheckResult | null>
    getUpdateState: () => Promise<AppUpdateState>
    downloadUpdate: () => Promise<AppUpdateState>
    installUpdate: () => Promise<boolean>
    onUpdateState: (listener: (state: AppUpdateState) => void) => () => void
    onOpenSettings: (listener: () => void) => () => void
    onOpenView: (listener: (view: SidebarViewId) => void) => () => void
    onDetachedWindowClosed: (listener: (target: DetachedWindowTarget) => void) => () => void
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    openDetachedWindow: (target: DetachedWindowTarget, title: string) => Promise<DetachedWindowState>
    getDetachedWindowState: () => Promise<DetachedWindowState | null>
    setDetachedWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<DetachedWindowState>
  }
  downloads: {
    list: () => Promise<DownloadActivitySnapshot>
    retry: (id: string) => Promise<DownloadActivitySnapshot>
    cancel: (id: string) => Promise<DownloadActivitySnapshot>
    restart: (id: string) => Promise<DownloadActivitySnapshot>
    dismiss: (id: string) => Promise<DownloadActivitySnapshot>
    clearFinished: () => Promise<DownloadActivitySnapshot>
    onChanged: (listener: (snapshot: DownloadActivitySnapshot) => void) => () => void
  }
  project: {
    listLoaderVersions: (refresh?: boolean) => Promise<LoaderVersionOption[]>
    create: (input: ProjectCreateInput) => Promise<ProjectInfo | null>
    rename: (input: ProjectRenameInput) => Promise<ProjectInfo>
    open: () => Promise<ProjectInfo | null>
    openRecent: (projectPath: string) => Promise<ProjectInfo>
    listRecent: () => Promise<ProjectInfo[]>
    removeRecent: (projectPath: string) => Promise<ProjectInfo[]>
    deleteProject: (projectPath: string) => Promise<ProjectInfo[]>
    inspectExisting: (sourceType?: 'folder' | 'zip') => Promise<ExistingProjectAnalysis | null>
    adoptExisting: (input: ExistingProjectAdoptInput) => Promise<ProjectInfo | null>
    current: () => Promise<ProjectInfo | null>
    listFiles: (projectPath?: string) => Promise<FileNode[]>
    listImageAssets: () => Promise<ProjectImageAsset[]>
    readImageAsset: (relativePath: string) => Promise<string>
    readFile: (relativePath: string, projectPath?: string) => Promise<string>
    writeFile: (relativePath: string, content: string, projectPath?: string) => Promise<void>
    /** Reads only ModMind-owned workbench data files under .modmind. */
    readWorkbenchData: (relativePath: string, projectPath?: string) => Promise<WorkbenchDataReadResult>
    /** Writes only ModMind-owned workbench data files under .modmind. */
    writeWorkbenchData: (relativePath: string, content: string, projectPath?: string) => Promise<WorkbenchDataWriteResult>
    createFile: (relativePath: string, content?: string, projectPath?: string) => Promise<ProjectFileMutationResult>
    createDirectory: (relativePath: string, projectPath?: string) => Promise<ProjectFileMutationResult>
    renamePath: (from: string, to: string, projectPath?: string) => Promise<ProjectFileMutationResult>
    deletePath: (relativePath: string, projectPath?: string) => Promise<void>
    /** Removes only ModMind-owned workbench data files under .modmind. */
    deleteWorkbenchData: (relativePath: string, projectPath?: string) => Promise<void>
    reveal: (relativePath?: string, projectPath?: string) => Promise<void>
    hasExportArtifact: (projectPath?: string) => Promise<boolean>
    exportArtifact: () => Promise<string | null>
    prepareIde: () => Promise<string[]>
    openIde: () => Promise<void>
    captureIdea: (prompt: string, projectPath?: string) => Promise<void>
    previewMigration: (input: ProjectMigrationInput) => Promise<ProjectMigrationPreview>
    migrate: (input: ProjectMigrationInput) => Promise<ProjectMigrationResult | null>
    onChanged: (listener: (project: ProjectInfo | null) => void) => () => void
  }
  modpack: {
    get: () => Promise<ModpackManifest>
    getServerPackManifest: () => Promise<ServerPackManifest | null>
    addServerPackMods: () => Promise<ServerPackManifest | null>
    removeServerPackMod: (fileName: string) => Promise<ServerPackManifest>
    exportServerPack: () => Promise<string | null>
    importMods: () => Promise<ModpackManifest>
    removeMod: (fileName: string) => Promise<ModpackManifest>
    createModule: (name: string) => Promise<ModpackManifest>
    updateModuleSide: (namespace: string, side: ModpackModuleSide) => Promise<ModpackManifest>
    openModule: (namespace: string) => Promise<ProjectInfo>
    sync: () => Promise<MinecraftRuntimeState>
    listContent: (refresh?: boolean) => Promise<ModpackContentInventory>
    contentProjectPath: (contentPath: string) => Promise<string>
    importContent: (kind: ModpackContentKind, scope?: ModpackContentScope) => Promise<ModpackContentImportResult | null>
    downloadContent: (input: ModpackContentDownloadInput) => Promise<ModpackContentDownloadResult>
    removeContent: (id: string) => Promise<ModpackContentInventory>
    getKeybinds: () => Promise<ModpackKeybindState>
    readLock: () => Promise<unknown>
    auditLock: () => Promise<unknown>
    providers: () => Promise<ModpackProviderInfo[]>
    recommendProviders: () => Promise<ModpackSearchResponse[]>
    recommendMcmod: () => Promise<McmodSearchResult[]>
    searchProviders: (query: string, providers?: Array<'modrinth' | 'curseforge'>) => Promise<ModpackSearchResponse[]>
    listProviderFiles: (provider: 'modrinth' | 'curseforge', projectId: string) => Promise<ModpackFileOption[]>
    installProviderFile: (provider: 'modrinth' | 'curseforge', projectId: string, versionId: string) => Promise<ModpackManifest>
    previewMigration: (input: Pick<ModpackMigrationCreateInput, 'loader' | 'minecraftVersion'>) => Promise<ModpackMigrationAssessment>
    selectMigrationJar: (input: Pick<ModpackMigrationCreateInput, 'loader' | 'minecraftVersion'>) => Promise<ModpackMigrationManualFile | null>
    createMigration: (input: ModpackMigrationCreateInput) => Promise<ModpackMigrationCreateResult | null>
    undoMigration: (migrationId: string) => Promise<ModpackMigrationUndoResult>
    migrationHistory: () => Promise<ModpackMigrationRecord[]>
    onMigrationProgress: (listener: (progress: ModpackMigrationProgress) => void) => () => void
    plan: (concept: unknown) => Promise<unknown>
    applyPlan: (plan: unknown) => Promise<unknown>
    readFtbQuestBook: () => Promise<FtbQuestBook>
    ftbQuestIcon: (itemId: string) => Promise<FtbQuestIconResult | null>
    /** 批量解析模组物品/流体显示名（zh_cn 优先，en_us 兜底）；原版命名空间由渲染端 CDN 处理。 */
    ftbQuestItemNames: (itemIds: string[]) => Promise<Record<string, string>>
    ftbDependencyTexture: () => Promise<string | null>
    ftbQuestShapes: () => Promise<Record<string, FtbQuestShapeSet>>
    saveFtbQuestBook: (book: FtbQuestBook) => Promise<FtbQuestSaveResult>
    writeFtbQuest: (input: unknown) => Promise<string>
    writePatchouliBook: (input: unknown) => Promise<string[]>
    applyKeybindPreset: (input: unknown, allowConflicts?: boolean) => Promise<unknown>
    buildServerPack: (input: unknown) => Promise<unknown>
    installServerRuntime: (input: unknown) => Promise<unknown>
    verifyServerJoin: (input: unknown) => Promise<unknown>
    runServerScenario: (input: unknown) => Promise<unknown>
    getServerState: () => Promise<LocalServerState>
    startServer: (input: unknown) => Promise<LocalServerState>
    stopServer: () => Promise<LocalServerState>
    restartServer: (input: unknown) => Promise<LocalServerState>
    sendServerCommand: (command: string) => Promise<LocalServerState>
    onServerState: (listener: (state: LocalServerState) => void) => () => void
    onServerEvent: (listener: (event: LocalServerEvent) => void) => () => void
    listOptimizationProfiles: () => Promise<unknown>
    applyOptimizationProfile: (input: unknown) => Promise<unknown>
    listManualMods: () => Promise<McmodManualRequirement[]>
    searchMcmod: (query: string) => Promise<McmodSearchResult[]>
    listMcmodFiles: (projectId: string) => Promise<McmodFileInfo[]>
    beginMcmodDownload: (projectId: string, fileKey: string) => Promise<McmodCaptchaChallenge>
    refreshMcmodCaptcha: (sessionId: string) => Promise<McmodCaptchaChallenge>
    submitMcmodCaptcha: (sessionId: string, captcha: string) => Promise<McmodDownloadResult>
  }
  build: {
    preflight: (projectPath?: string) => Promise<PreflightResult>
    onProgress: (listener: (event: PipelineEvent) => void) => () => void
  }
  snapshots: {
    create: (label: string, projectPath?: string) => Promise<SnapshotInfo>
    list: (projectPath?: string) => Promise<SnapshotInfo[]>
    restore: (id: string, projectPath?: string) => Promise<SnapshotRestoreResult>
    delete: (id: string, projectPath?: string) => Promise<SnapshotInfo[]>
  }
  settings: {
    getAgent: () => Promise<AgentSettings>
    saveAgent: (settings: AgentSettings) => Promise<AgentSettings>
    listAgentModels: (kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) => Promise<AiModelInfo[]>
    scanGradle: () => Promise<GradleInstallation[]>
    scanJavaHomes: () => Promise<DetectedJavaHome[]>
    probeJavaHome: (home: string) => Promise<JavaProbeOutcome>
    pickJavaHome: () => Promise<string | null>
  }
  diagnostics: {
    exportLogs: (pages?: DiagnosticPageSnapshot[]) => Promise<string | null>
  }
  device: {
    getState: () => Promise<DeviceConnectionState>
    authorize: () => Promise<DeviceConnectionState>
    cancelAuthorization: () => Promise<DeviceConnectionState>
    disconnectLocal: () => Promise<DeviceConnectionState>
    refreshUsage: () => Promise<DeviceConnectionState>
    getAiPreferences: () => Promise<BeginnerAiPreferences>
    saveAiPreferences: (preferences: BeginnerAiPreferences) => Promise<BeginnerAiPreferences>
    listModels: (force?: boolean) => Promise<AiModelInfo[]>
    openSite: (path?: string) => Promise<void>
    onState: (listener: (state: DeviceConnectionState) => void) => () => void
  }
  remote: {
    getState: () => Promise<RemoteConnectionState>
    start: () => Promise<RemoteConnectionState>
    stop: () => Promise<RemoteConnectionState>
    onState: (listener: (state: RemoteConnectionState) => void) => () => void
  }
  mcpBridge: {
    getState: () => Promise<McpBridgeState>
    setEnabled: (enabled: boolean) => Promise<McpBridgeState>
    onState: (listener: (state: McpBridgeState) => void) => () => void
  }
  ai: {
    createCode: (prompt: string, sessionId?: string, backend?: CodingBackend, executionProfile?: AiExecutionProfile, options?: AiCreateCodeOptions) => Promise<CodingResult>
    pickAttachments: (kind: AiAttachmentSelectionKind) => Promise<AiAttachment[]>
    validateAttachments: (attachments: AiAttachment[], projectPath?: string) => Promise<AiAttachment[]>
    cancelCode: (sessionId?: string, projectPath?: string) => Promise<AiCancellationResult>
    clearQuotaCredentials: () => Promise<void>
    getRecovery: (projectPath?: string) => Promise<AiRecoveryInfo>
    getProjectTaskState: (projectPath?: string) => Promise<AiProjectTaskState>
    resumeRecovery: (projectPath?: string) => Promise<CodingResult>
    switchBackend: (backend: CodingBackend, projectPath?: string, sessionScope?: string, switchId?: number) => Promise<AiBackendSwitchResult>
    onBackendReady: (listener: (event: AiBackendReadyEvent) => void) => () => void
    restoreRecovery: () => Promise<SnapshotInfo | null>
    onProgress: (listener: (event: PipelineEvent) => void) => () => void
    onOutput: (listener: (event: AiOutputEvent) => void) => () => void
  }
  conversations: {
    list: (projectPath: string, surface?: AiSurface, includeArchived?: boolean) => Promise<ConversationSummary[]>
    read: (projectPath: string, conversationId: string) => Promise<ConversationDocument | null>
    create: (projectPath: string, input: ConversationCreateInput) => Promise<ConversationDocument>
    saveView: (projectPath: string, conversationId: string, generation: number, view: ConversationDocument['view'], title?: string) => Promise<ConversationDocument>
    eventsSince: (projectPath: string, conversationId: string, generation: number, afterSequence?: number, limit?: number) => Promise<ConversationEventsPage>
    fork: (projectPath: string, input: ConversationForkInput) => Promise<ConversationDocument>
    archive: (projectPath: string, conversationId: string, archived: boolean) => Promise<ConversationDocument>
    delete: (projectPath: string, conversationId: string) => Promise<void>
    flush: () => Promise<void>
  }
  beginnerCodex: {
    prepare: (projectPath?: string) => Promise<BeginnerCodexPreparationResult>
    onProgress: (listener: (progress: BeginnerCodexProgress) => void) => () => void
  }
  externalAgents: {
    detect: () => Promise<ExternalAgentStatus[]>
    configure: (kind: ExternalAgentProvider, settings: ExternalAgentConfiguration) => Promise<ExternalAgentProviderSetup>
    history: (kind: ExternalAgentKind) => Promise<string>
    install: (kind: ExternalAgentKind) => Promise<ExternalAgentStatus>
    openDocs: (kind: ExternalAgentKind) => Promise<void>
    launch: (kind: ExternalAgentKind) => Promise<void>
  }
  blockbench: {
    show: (bounds: BlockbenchBounds) => Promise<void>
    hide: () => Promise<void>
    openProject: () => Promise<void>
    saveProject: () => Promise<void>
    setTheme: (theme: 'light' | 'dark') => Promise<void>
    runAction: (action: string) => Promise<void>
    execute: (action: BlockbenchAction) => Promise<unknown>
    executeActions: (actions: BlockbenchAction[], expectedRevision?: string) => Promise<import('./blockbench').BlockbenchActionBatchResult>
    projectState: () => Promise<import('./blockbench').BlockbenchProjectState>
    validate: () => Promise<import('./blockbench').BlockbenchValidationResult>
    captureViews: (request?: import('./blockbench').BlockbenchCaptureRequest) => Promise<import('./blockbench').BlockbenchCaptureResult>
    setAssetMetadata: (metadata: import('./blockbench').BlockbenchAssetMetadata) => Promise<import('./blockbench').BlockbenchActionResult>
    saveAssetBundle: (request: import('./blockbench').BlockbenchAssetSaveRequest) => Promise<import('./blockbench').BlockbenchAssetSaveResult>
    history: () => Promise<import('./blockbench').BlockbenchHistoryEntry[]>
    createCheckpoint: (label?: string) => Promise<import('./blockbench').BlockbenchHistoryEntry>
    restoreHistory: (id: string) => Promise<{restored: import('./blockbench').BlockbenchHistoryEntry; revision: string}>
    getState: () => Promise<BlockbenchBridgeStatus & Record<string, unknown>>
    onState: (listener: (state: BlockbenchBridgeStatus & Record<string, unknown>) => void) => () => void
  }
  assetIntent: {
    compile: (intent: AssetIntentProgram) => Promise<AssetIntentCandidate>
    preview: (intent: AssetIntentProgram, request?: import('./blockbench').BlockbenchCaptureRequest, expectedRevision?: string) => Promise<AssetIntentCandidate | AssetIntentPreview>
    apply: (intent: AssetIntentProgram, expectedRevision?: string) => Promise<AssetIntentCandidate & {execution?: import('./blockbench').BlockbenchActionBatchResult}>
  }
  assetRefinement: {
    compile: (refinement: AssetRefinementProgram) => Promise<AssetRefinementCandidate>
    preview: (refinement: AssetRefinementProgram, request?: import('./blockbench').BlockbenchCaptureRequest, expectedRevision?: string) => Promise<AssetRefinementCandidate | AssetRefinementPreview>
    apply: (refinement: AssetRefinementProgram, expectedRevision?: string) => Promise<AssetRefinementCandidate & {execution?: import('./blockbench').BlockbenchActionBatchResult}>
  }
  advancedAsset: {
    compile: (program: AdvancedAssetProgram, variantId?: string) => Promise<AdvancedAssetCandidate>
    preview: (program: AdvancedAssetProgram, request?: import('./blockbench').BlockbenchCaptureRequest, options?: AdvancedAssetPreviewOptions, expectedRevision?: string) => Promise<AdvancedAssetComparison>
    apply: (program: AdvancedAssetProgram, variantId?: string, expectedRevision?: string) => Promise<AdvancedAssetCandidate & {execution?: import('./blockbench').BlockbenchActionBatchResult}>
  }
  referenceAsset: {
    compile: (program: ReferenceImageAssetProgram) => Promise<ReferenceImageAssetCandidate>
    preview: (program: ReferenceImageAssetProgram, request?: import('./blockbench').BlockbenchCaptureRequest, expectedRevision?: string) => Promise<unknown>
    apply: (program: ReferenceImageAssetProgram, expectedRevision?: string) => Promise<ReferenceImageAssetCandidate & {execution?: import('./blockbench').BlockbenchActionBatchResult}>
  }
  assetVisualReview: {
    current: (request?: import('./blockbench').BlockbenchCaptureRequest) => Promise<import('./blockbench').BlockbenchCaptureResult & {review: AssetVisualReview}>
  }
  mappings: MappingsApi
  minecraft: MinecraftApi
  production: ProductionApi
  decompile: {
    pickJar: () => Promise<string | null>
    inspect: (jarPath: string) => Promise<import('./decompile').DecompileInspectResult>
    start: (input: { jarPath: string; skipRemap?: boolean; minecraftVersion?: string }) => Promise<import('./decompile').DecompileRunResult>
    cancel: (jarPath: string) => Promise<boolean>
    listFiles: (sourceSha256: string) => Promise<import('./decompile').DecompileFileEntry[]>
    readFile: (sourceSha256: string, relativePath: string) => Promise<string>
    scanReferences: (jarPath: string, knownPackages?: Array<{ modId: string; packages: string[] }>) => Promise<import('./decompile').DecompileReferenceReport & { scannedClasses: number }>
    onProgress: (listener: (event: import('./decompile').DecompileProgressEvent) => void) => () => void
    getTerms: (sourceFileName?: string) => Promise<import('./decompileModuleExport').DecompileTermsPayload>
    createModuleFromJar: (input: { sourceSha256: string; moduleName: string; termsAcknowledgement: { termsVersion: string; acknowledged: true; origin?: 'user-workspace' | 'ai-action' } }) => Promise<import('./decompileModuleExport').CreatedModuleFromDecompiled>
    createProjectFromJar: (input: import('./decompileModuleExport').CreateProjectFromDecompiledInput) => Promise<ProjectInfo | null>
  }
  imageStudio: {
    getSettings: () => Promise<ImageStudioSettings>
    saveSettings: (settings: ImageStudioSettingsInput) => Promise<ImageStudioSettings>
    capabilities: () => Promise<ImageStudioCapabilities>
    generate: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>
    process: (operation: 'perfect-pixel' | 'remove-background', dataUrl: string, options?: ImageProcessingOptions) => Promise<ImageProcessingResult>
    history: () => Promise<ImageHistoryItem[]>
    saveAsset: (dataUrl: string, suggestedName: string) => Promise<string | null>
    saveToProject: (dataUrl: string, suggestedName: string) => Promise<string>
  }
  plugins: {
    list: () => Promise<import('./plugins').PluginSnapshot>
    setEnabled: (pluginId: string, enabled: boolean) => Promise<import('./plugins').PluginSnapshot>
    importZip: (scope?: 'global' | 'project') => Promise<{ imported: string } | { cancelled: true }>
    reload: () => Promise<import('./plugins').PluginSnapshot>
    openDirectory: () => Promise<void>
    invokeTool: (pluginId: string, toolName: string, input?: unknown) => Promise<unknown>
    activate: (pluginId: string) => Promise<import('./plugins').PluginDiagnostics>
    restart: (pluginId: string) => Promise<import('./plugins').PluginDiagnostics>
    diagnostics: (pluginId: string) => Promise<import('./plugins').PluginDiagnostics>
    clearDiagnostics: (pluginId: string) => Promise<import('./plugins').PluginDiagnostics>
    recordLog: (pluginId: string, source: import('./plugins').PluginLogSource, level: 'info' | 'warn' | 'error', message: string) => Promise<void>
    handleContextOp: (pluginId: string, op: string, args?: Record<string, unknown>) => Promise<unknown>
    getProjectInfo: (pluginId: string) => Promise<unknown>
    copyToClipboard: (pluginId: string, text: string) => Promise<unknown>
    export: (pluginId: string) => Promise<string | null>
    exportDoc: (content: string) => Promise<string>
    delete: (pluginId: string) => Promise<import('./plugins').PluginSnapshot>
    getOverlayWindows: () => Promise<import('./plugins').PluginOverlayWindowState[]>
    openOverlayWindow: (pluginId: string) => Promise<import('./plugins').PluginOverlayWindowState>
    closeOverlayWindow: (pluginId: string) => Promise<import('./plugins').PluginOverlayWindowState>
    setOverlayAlwaysOnTop: (pluginId: string, alwaysOnTop: boolean) => Promise<import('./plugins').PluginOverlayWindowState>
    onChanged: (listener: (snapshot: import('./plugins').PluginSnapshot) => void) => () => void
    onDiagnosticsChanged: (listener: (diagnostics: import('./plugins').PluginDiagnostics) => void) => () => void
    onOverlayWindowsChanged: (listener: (states: import('./plugins').PluginOverlayWindowState[]) => void) => () => void
  }
}
