import type { LoaderKind, McmodCaptchaChallenge, McmodDownloadResult, ProjectInfo } from './types'

export interface DependencyProject {
  projectId: string
  slug: string
  title: string
  description: string
  iconUrl?: string
  downloads: number
  followers: number
  clientSide: 'required' | 'optional' | 'unsupported' | 'unknown'
  serverSide: 'required' | 'optional' | 'unsupported' | 'unknown'
  categories: string[]
}

export interface DependencySearchResult {
  query: string
  total: number
  offset: number
  hits: DependencyProject[]
}

export interface DependencyVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  versionType: 'release' | 'beta' | 'alpha'
  datePublished: string
  gameVersions: string[]
  loaders: string[]
}

export interface ManagedDependency {
  projectId: string
  versionId: string
  slug: string
  name: string
  versionNumber: string
  fileName: string
  relativePath: string
  installedAt: string
  environment: 'client' | 'server' | 'both'
  source?: 'modrinth' | 'maven'
  coordinate?: string
  repository?: string
  configuration?: 'implementation' | 'modImplementation' | 'compileOnly' | 'runtimeOnly'
  sha512?: string
  /** Relationship ID when this build dependency is owned by the add-on workflow. */
  relationshipId?: string
  /** Transitive dependencies are installed for compilation/testing but are not published directly. */
  relationshipRole?: AddonRelationshipRole | 'transitive'
  provider?: AddonRelationshipProvider
  parentProjectId?: string
}

export type AddonRelationshipRole = 'required' | 'optional' | 'test'
export type AddonRelationshipProvider = 'modrinth' | 'curseforge' | 'modmind-project' | 'private'

export interface AddonApiProfile {
  primaryModId: string
  modIds: string[]
  displayName: string
  version: string
  loader: LoaderKind
  classCount: number
  packages: string[]
  sourceKind: 'sources' | 'project' | 'jar'
  sourcePath?: string
  sourceMatched?: boolean
  sourceLicense?: string
}

export interface AddonRelationshipDependency {
  provider?: 'modrinth' | 'curseforge'
  projectId?: string
  versionId?: string
  modId?: string
  kind: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface AddonRelationship {
  id: string
  role: AddonRelationshipRole
  provider: AddonRelationshipProvider
  name: string
  version: string
  primaryModId: string
  modIds: string[]
  fileName: string
  relativePath: string
  installedAt: string
  environment: 'client' | 'server' | 'both' | 'unknown'
  projectId?: string
  versionId?: string
  slug?: string
  linkedProjectPath?: string
  linkedProjectId?: string
  /** Published compatibility constraint; the installed version/hash remains an exact development lock. */
  compatibilityRange?: string
  platformLinks?: Partial<Record<'modrinth' | 'curseforge', { projectId: string; slug?: string }>>
  sha256?: string
  automatic?: boolean
  parentRelationshipIds?: string[]
  dependencies?: AddonRelationshipDependency[]
  api: AddonApiProfile
}

export interface AddonRelationshipManifest {
  version: 1
  minecraftVersion: string
  loader: LoaderKind
  updatedAt: string
  relationships: AddonRelationship[]
}

export type AddonSearchProvider = 'modrinth' | 'curseforge' | 'mcmod'

export interface AddonSearchHit {
  provider: AddonSearchProvider
  projectId: string
  slug: string
  name: string
  summary: string
  projectUrl: string
  downloads: number
  iconUrl?: string
  license?: string
  englishName?: string
}

export interface AddonVersionOption {
  provider: AddonSearchProvider
  projectId: string
  versionId: string
  versionName: string
  filename: string
  side: 'client' | 'server' | 'both' | 'unknown'
  publishedAt?: string
  fileKey?: string
  minecraftVersion?: string
  loaders?: string[]
  sha256?: string
  size?: number
}

export interface AddonPlatformInstallInput {
  provider: 'modrinth' | 'curseforge'
  projectId: string
  versionId?: string
  name?: string
  role: AddonRelationshipRole
}

export interface AddonPrepareInput {
  required?: string[]
  optional?: string[]
  providers?: Array<'modrinth' | 'curseforge'>
}

export interface AddonImportMatch {
  provider: 'modrinth' | 'curseforge'
  projectId: string
  versionId: string
  name: string
  versionName: string
  exact: boolean
}

export interface AddonImportReviewItem {
  id: string
  fileName: string
  size: number
  detectedName: string
  detectedVersion: string
  primaryModId: string
  modIds: string[]
  loader: LoaderKind
  match?: AddonImportMatch
  candidates: AddonImportMatch[]
  warnings: string[]
}

export interface AddonImportReview {
  batchId: string
  items: AddonImportReviewItem[]
}

export interface AddonImportSelection {
  itemId: string
  role: AddonRelationshipRole
  match?: Pick<AddonImportMatch, 'provider' | 'projectId' | 'versionId' | 'name' | 'versionName'>
  privateMod?: boolean
}

export interface AddonRelationshipAudit {
  success: boolean
  checked: number
  errors: string[]
  warnings: string[]
}

export interface DependencyInstallInput {
  projectId: string
  versionId?: string
  environment?: ManagedDependency['environment']
}

export interface MavenDependencyInput {
  coordinate: string
  repository?: string
  configuration?: ManagedDependency['configuration']
}

export interface DependencyAuditResult {
  success: boolean
  checked: number
  errors: string[]
  warnings: string[]
}

export interface GitChange {
  path: string
  index: string
  worktree: string
}

export interface GitStatus {
  available: boolean
  initialized: boolean
  branch: string
  ahead: number
  behind: number
  changes: GitChange[]
}

export interface GitCommitInput {
  message: string
  authorName?: string
  authorEmail?: string
}

export interface GitRemote {
  name: string
  url: string
}

export interface GiteeBuildSettings {
  repositoryUrl: string
  branch: string
  token: string
  hasStoredToken?: boolean
}

export interface GiteeBuildValidation {
  valid: boolean
  owner?: string
  repository?: string
  defaultBranch?: string
  detail: string
}

export interface GiteeBuildResult {
  success: boolean
  branch: string
  commitSha?: string
  pipelineUrl?: string
  detail: string
}

export type ContentKind =
  | 'language'
  | 'recipe-shaped'
  | 'recipe-shapeless'
  | 'item-tag'
  | 'block-tag'
  | 'loot-block'
  | 'advancement'
  | 'data-json'
  | 'asset-json'

export interface ContentCreateInput {
  kind: ContentKind
  id: string
  locale?: string
  data: Record<string, unknown>
}

export interface ContentCreateResult {
  paths: string[]
  summary: string
  warnings: string[]
}

export interface AudioImportInput {
  eventId: string
  stream?: boolean
  volume?: number
  pitch?: number
}

export interface ContentValidationResult {
  success: boolean
  checkedFiles: number
  errors: string[]
  warnings: string[]
}

export type TestTarget = 'build' | 'client' | 'server' | 'gametest'

export interface TestTargetResult {
  target: TestTarget
  status: 'passed' | 'failed' | 'skipped'
  summary: string
  durationMs: number
  logPath?: string
}

export interface TestMatrixResult {
  success: boolean
  startedAt: string
  completedAt: string
  results: TestTargetResult[]
}

export interface ReleaseSettings {
  version: string
  displayName: string
  summary?: string
  changelog: string
  autoBump?: boolean
  bumpMode?: 'patch' | 'minor' | 'major'
  channel: 'release' | 'beta' | 'alpha'
  modrinthProjectId: string
  curseForgeProjectId: string
  githubRepository: string
  hasModrinthToken?: boolean
  hasCurseForgeToken?: boolean
  hasGithubToken?: boolean
  modrinthToken?: string
  curseForgeToken?: string
  githubToken?: string
}

export interface ReleaseSummaryDraft {
  summary: string
  changelog: string
  generatedBy?: 'ai' | 'local'
}

export interface ReleaseCheck {
  id: string
  label: string
  status: 'pass' | 'warning' | 'fail'
  detail: string
}

export interface ReleasePreflightResult {
  ready: boolean
  artifactPath?: string
  artifactSize?: number
  checks: ReleaseCheck[]
}

export interface ReleasePublishInput {
  targets: Array<'modrinth' | 'curseforge' | 'github'>
  confirmed: boolean
}

export interface ReleasePublishResult {
  target: 'modrinth' | 'curseforge' | 'github'
  success: boolean
  url?: string
  detail: string
}

export interface ProductionApi {
  relationships: {
    list: () => Promise<AddonRelationshipManifest>
    providers: () => Promise<Array<{ id: AddonSearchProvider; label: string }>>
    search: (query: string, providers?: AddonSearchProvider[]) => Promise<AddonSearchHit[]>
    recommendations: () => Promise<AddonSearchHit[]>
    versions: (provider: AddonSearchProvider, projectId: string) => Promise<AddonVersionOption[]>
    installPlatform: (input: AddonPlatformInstallInput) => Promise<AddonRelationshipManifest>
    prepare: (input: AddonPrepareInput) => Promise<AddonRelationshipManifest>
    beginImport: () => Promise<AddonImportReview | null>
    confirmImport: (batchId: string, selections: AddonImportSelection[]) => Promise<AddonRelationshipManifest>
    cancelImport: (batchId: string) => Promise<void>
    linkProject: () => Promise<AddonRelationshipManifest | null>
    importSource: (relationshipId: string, sourceType: 'archive' | 'folder') => Promise<AddonRelationshipManifest | null>
    setRole: (relationshipId: string, role: AddonRelationshipRole) => Promise<AddonRelationshipManifest>
    remove: (relationshipId: string) => Promise<AddonRelationshipManifest>
    audit: () => Promise<AddonRelationshipAudit>
    beginMcmodDownload: (projectId: string, fileKey: string) => Promise<McmodCaptchaChallenge>
    refreshMcmodCaptcha: (sessionId: string) => Promise<McmodCaptchaChallenge>
    submitMcmodCaptcha: (sessionId: string, captcha: string, role: AddonRelationshipRole) => Promise<McmodDownloadResult & { relationshipAdded?: boolean }>
  }
  dependencies: {
    search: (query: string, offset?: number) => Promise<DependencySearchResult>
    versions: (projectId: string) => Promise<DependencyVersion[]>
    list: () => Promise<ManagedDependency[]>
    install: (input: DependencyInstallInput) => Promise<ManagedDependency>
    installMaven: (input: MavenDependencyInput) => Promise<ManagedDependency>
    audit: () => Promise<DependencyAuditResult>
    remove: (projectId: string) => Promise<ManagedDependency[]>
  }
  git: {
    status: () => Promise<GitStatus>
    initialize: () => Promise<GitStatus>
    diff: (relativePath?: string) => Promise<string>
    commit: (input: GitCommitInput) => Promise<GitStatus>
    createBranch: (name: string) => Promise<GitStatus>
    listRemotes: () => Promise<GitRemote[]>
    addRemote: (name: string, url: string) => Promise<GitRemote[]>
    removeRemote: (name: string) => Promise<GitRemote[]>
    fetch: (remote?: string) => Promise<GitStatus>
    pull: (remote?: string, branch?: string) => Promise<GitStatus>
    push: (remote?: string, branch?: string) => Promise<GitStatus>
    merge: (branch: string) => Promise<GitStatus>
    rebase: (branch: string) => Promise<GitStatus>
    pullRequestUrl: (remote?: string) => Promise<string>
  }
  remoteBuild: {
    getGiteeSettings: () => Promise<GiteeBuildSettings>
    saveGiteeSettings: (settings: GiteeBuildSettings) => Promise<GiteeBuildSettings>
    validateGitee: (settings?: GiteeBuildSettings) => Promise<GiteeBuildValidation>
    triggerGitee: () => Promise<GiteeBuildResult>
  }
  content: {
    create: (input: ContentCreateInput) => Promise<ContentCreateResult>
    importAudio: (input: AudioImportInput) => Promise<ContentCreateResult | null>
    validate: () => Promise<ContentValidationResult>
  }
  tests: {
    runMatrix: (targets: TestTarget[]) => Promise<TestMatrixResult>
    generateWorkflow: () => Promise<string>
  }
  release: {
    getSettings: () => Promise<ReleaseSettings>
    saveSettings: (settings: ReleaseSettings) => Promise<ReleaseSettings>
    prepareExport: () => Promise<ReleaseSettings>
    markExported: () => Promise<ReleaseSettings>
    suggestSummary: () => Promise<ReleaseSummaryDraft>
    preflight: () => Promise<ReleasePreflightResult>
    publish: (input: ReleasePublishInput) => Promise<ReleasePublishResult[]>
  }
}

export interface ProjectFileMutationResult {
  project: ProjectInfo
  path: string
}

export interface ProductionContext {
  project: ProjectInfo
  loader: LoaderKind
}
