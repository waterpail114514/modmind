import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { promises as fs, readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { BlockbenchBridge } from './blockbenchBridge'
import { MinecraftRuntimeManager, detectInstalledJavaHomes, probeJavaHomeInfo } from './minecraftRuntime'
import { HeadlessMcService, supportsHeadlessMc } from './headlessMcService'
import { MappingService } from './mappingService'
import { LoaderCatalog } from './loaderCatalog'
import { descriptorPath, projectTemplateFiles } from './projectTemplates'
import { ContentService } from './contentService'
import { DependencyService } from './dependencyService'
import { AddonRelationshipService, readAddonRelationships } from './addonRelationshipService'
import { GitService } from './gitService'
import { ReleaseService, type ReleaseSecrets } from './releaseService'
import { generateGithubWorkflow } from './workflowService'
import { buildScriptFingerprint } from './buildTrust'
import { MODMIND_SOURCE_FINGERPRINT } from '../shared/sourceFingerprint'
import { detectedProjectVersion, migrateProjectVersion112 } from './projectVersionMigration'
import { CURRENT_PROJECT_VERSION, MIGRATABLE_PROJECT_VERSION } from './projectVersion'
import { inspectProjectPreflight } from './projectPreflight'
import { recordZipExpansion } from './archiveImportPolicy'
import { sameProjectPath } from './projectPath'
import { archiveSignatureForFile, extractTar } from './tarArchive'
import { extractMinecraftVersion, inferGradleLoader, parseGradleProperties } from './existingProjectMetadata'
import { extractSevenZipArchive } from './sevenZipArchive'
import { windowsCmdInvocation } from './windowsCommand'
import { setNetworkProxy } from './networkRequest'
import { migrateMovedProjectMetadata } from './projectMetadataMigration'
import { renameProjectFiles } from './projectRename'
import { convertLegacyModtoolProject, readLegacyModtoolProject } from './legacyProjectImport'
import { copySnapshotFilesIncremental, snapshotFileHash, type SnapshotFileMetadata } from './snapshotStore'
import { requireManagedRuntimePreparation } from './managedRuntimePreparation'
import { isAddonPlatform, isJavaLoader, platformLabel, PROJECT_PLATFORMS } from '../shared/projectPlatform'
import { normalizeProjectName, validateProjectNameInput } from '../shared/projectName'
import { buildBedrockAddon, buildNeteaseArchive, createStoredZip } from './bedrockAddon'
import { detectExternalAgent, detectExternalAgents, externalAgentDocsUrl, externalAgentLabel, externalAgentSupportsHostedConfiguration, installExternalAgent, launchExternalAgent, ModMindBridge, readExternalAgentHistory, refreshExternalAgentContext, runExternalAgent, type ExternalAgentAttemptAudit, type ExternalAgentBridgeHandlers, type ExternalAgentKind, type ExternalAgentRetryState, type ExternalAgentRunOptions } from './externalAgents'
import { createPluginBridgeTarget, getPluginService, getPluginRuntime, importPluginZipInteractive, initializePlugins, refreshPluginRegistry, registerPluginProtocolSchemeEarly, shutdownPlugins, waitForPluginRegistry } from './pluginBridgeIntegration'
import type { PluginDiagnostics, PluginOverlayWindowState, PluginSnapshot } from '../shared/plugins'
import { clearPreparedCodexCredentials, ensureManagedCodexRuntime, isManagedCodexVersion, managedCodexExecutablePath, prepareCodex, type CodexServerConfig, type CodexSetupProgress } from './codexSetup'
import { ChatCompletionsAdapter } from './chatCompletionsAdapter'
import { BackendSwitchCoordinator } from './backendSwitchCoordinator'
import { awaitWithAbort, throwIfAborted, waitForCondition } from './asyncControl'
import {
  activeQuotaModelPreferences,
  normalizeQuotaModelPreferences,
  parseStoredQuotaModelPreferences,
  quotaPreferenceKey,
  resolveQuotaModelPreferences,
  updateQuotaModelPreferences,
  type StoredQuotaModelPreferences
} from './quotaModelPreferences'
import { GiteeBuildService } from './giteeBuildService'
import { beginnerReasoningEffort } from '../shared/aiPreferences'
import { inspirationReasoningEffort, selectInspirationModel } from '../shared/inspirationPerformance'
import { isAiAbandonmentRequest, isAiContinuationRequest } from '../shared/aiPrompt'
import { aiConversationIdForSession, aiRecoveryMatchesSessionScope, aiRecoverySessionScope, normalizeAiSessionScope } from '../shared/aiSession'
import { describeAiFailureForUser } from '../shared/aiFailure'
import { selectFinalAiAnswer } from '../shared/aiOutput'
import { WorkbenchDataStore } from './workbenchDataStore'
import {
  checkAppVersion,
  DEFAULT_DEVICE_MODEL,
  DEFAULT_REASONING_EFFORT,
  DeviceApiError,
  normalizeRelayBaseUrl,
  normalizeSiteUrl,
  openAiV1BaseUrl,
  parseDeviceDeepLink,
  parseModelPayload,
  pollDeviceCode,
  queryDeviceUsage,
  requestDeviceCode,
  sendDeviceFastMode
} from './deviceIntegration'
import {
  listManagedFiles,
  redactSensitiveContent,
  restoreManagedPathsFromSnapshot,
  restoreManagedTreeExact,
  snapshotManifestBelongsToProject,
  validateSnapshotId
} from './agentCore'
import type { BlockbenchAction, BlockbenchAssetMetadata, BlockbenchAssetSaveRequest, BlockbenchBounds, BlockbenchCaptureRequest, BlockbenchCommand } from '../shared/blockbench'
import { compileAssetIntent } from './assetIntentCompiler'
import { compileAssetRefinement } from './assetRefinementCompiler'
import {compileAdvancedAsset, compileAdvancedAssetVariants, optimizeAdvancedProgram} from './advancedAssetCompiler'
import {compileReferenceImageAsset} from './referenceImageAssetCompiler'
import {reviewAssetCaptures} from './assetVisualReview'
import {describeBlockbenchActions} from './blockbenchDiff'
import type {AdvancedAssetCandidate, AdvancedAssetCandidatePreview, AdvancedAssetComparison, AdvancedAssetPreviewOptions, AdvancedAssetProgram, ReferenceImageAssetProgram} from '../shared/advancedAsset'
import type { HeadlessSmokeTestResult, MinecraftLaunchOptions, MinecraftManagedMod, MinecraftRuntimeEvent } from '../shared/minecraft'
import type { AddonImportSelection, AddonPlatformInstallInput, AddonPrepareInput, AddonRelationshipRole, AudioImportInput, ContentCreateInput, GiteeBuildSettings, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, ReleaseSummaryDraft, TestMatrixResult, TestTarget } from '../shared/production'
import type {
  AiAttachment,
  AiAttachmentSelectionKind,
  AiBackendSwitchResult,
  AiOutputEvent,
  AiCreateCodeOptions,
  AiCancellationResult,
  AiProjectTaskState,
  AiRecoveryInfo,
  AiSurface,
  AiModelInfo,
  AiExecutionProfile,
  BeginnerAiPreferences,
  AgentSettings,
  AppVersionCheckResult,
  CodingResult,
  ExistingProjectAdoptInput,
  ExistingProjectAnalysis,
  ExternalAgentConfiguration,
  FileNode,
  JavaPreferences,
  ProjectImageAsset,
  GradleInstallation,
  LoaderKind,
  PipelineEvent,
  PreflightResult,
  ProjectCreateInput,
  ProjectInfo,
  ProjectRenameInput,
  ProjectMigrationInput,
  ProjectMigrationPreview,
  ProjectMigrationResult,
  SnapshotInfo,
  SnapshotRestoreResult,
  DeviceConnectionState,
  RemoteConnectionState,
  McpBridgeState,
  DeviceUsage,
  DiagnosticPageSnapshot,
  ModpackFileOption,
  ModpackMigrationCreateInput,
  ModpackMigrationCreateResult,
  ModpackMigrationMode,
  ModpackMigrationRecord,
  ModpackMigrationUndoResult,
  ModpackModuleSide,
  ModpackSearchResponse,
  ModpackContentDownloadInput,
  ModpackContentKind,
  ModpackContentScope,
  SidebarViewId,
  DetachedWindowTarget
} from '../shared/types'
import type { ImageGenerationRequest } from '../shared/imageStudio'
import { ImageStudioService } from './imageStudioService'
import { addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, updateModpackModuleSide } from './modpackService'
import { inspectExternalModpack, materializeExternalModpack } from './modpackImportService'
import { ModProviderRegistry } from './modProviderService'
import { applyModpackPlan, planModpack } from './modpackPlanner'
import { auditModpackLock, lockedModFromFile, readModpackLock, writeModpackLock } from './modpackLockService'
import { applyKeybindPreset, readKeybindState, writeFtbQuestChapter, writePatchouliBook } from './modpackContentService'
import { readFtbQuestBook, saveFtbQuestBook } from './ftbQuestBookService'
import { downloadModpackContent, importModpackContent, listModpackContent, modpackContentProjectPath, removeModpackContent } from './modpackContentInventoryService'
import { addServerPackMods, buildServerPack, createServerPackArchive, installServerRuntime, readExistingServerPack, readServerPackManifest, removeServerPackMod, serverRuntimeDownloadDescription } from './serverPackService'
import { SERVER_PACK_CREATOR_MIN_JAVA } from './serverPackCreatorService'
import { buildAndJoinServer, runServerScenario } from './serverVerificationService'
import { LocalServerManager } from './localServerService'
import { applyOptimizationProfile, BUILTIN_OPTIMIZATION_PROFILES } from './optimizationService'
import { McmodService, readManualModRequirements, saveManualModRequirements } from './mcmodService'
import { assessModpackMigration, createModpackMigration, inspectModpackMigrationJar } from './modpackMigrationService'
import { modpackModsRoot } from './modpackPaths'
import { assertSeparateMigrationTrees } from './migrationPathSafety'
import { reviewAiAction, reviewAiCompletion, type AiReviewerConfig } from './aiReviewer'
import { RemoteControllerAgent, type RemoteAppAction, type RemoteAppState, type RemoteProjectSummary, type RemoteQuotaConfig } from './remoteAgentController'
import { RemoteClientService, remoteEndpointFromSite, type RemoteServerCancel } from './remoteClientService'
import { DiagnosticArchiveCollector, summarizeDiagnosticDirectory } from './diagnosticArchive'
import { diagnosticJournal, installConsoleDiagnosticCapture, installProcessDiagnosticHandlers, redactDiagnosticText } from './diagnosticLog'
import { downloadActivities } from './downloadActivityService'
import { AppUpdateService, normalizeAppUpdateUrl } from './appUpdateService'
import { inspectForDecompilation, listCachedSourceFiles, readCachedSourceFile, runDecompilation, scanReferencesForJar, type DecompileRunRequest } from './decompilePipeline'
import { DECOMPILE_MIN_JAVA } from './jarDecompileService'
import { createModuleFromDecompiledSources, DECOMPILE_TERMS_TITLE, DECOMPILE_TERMS_VERSION, DECOMPILE_TERMS_SECTIONS, plannedModulePaths, renderDecompileTerms, seedProjectFromDecompiledSources } from './decompileModuleExport'
import { readDecompileCacheEntry } from './decompileCache'
import type { DecompileProvenance } from '../shared/decompile'
import type { DecompileInspectResult } from '../shared/decompile'

function sendDecompileEvent(signal: AbortSignal | undefined, event: { jarSha256: string; phase: string; message: string; ratio?: number }): void {
  if (signal?.aborted) return
  mainWindow?.webContents.send('decompile:event', event)
}

async function readDecompileProvenanceForExport(decompileCacheRoot: string, sourceSha256: string): Promise<DecompileProvenance> {
  if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('缺少有效的反编译缓存标识')
  const entry = await readDecompileCacheEntry(decompileCacheRoot, sourceSha256)
  if (!entry?.provenance) throw new Error('该 JAR 尚无反编译缓存，请先完成反编译')
  return entry.provenance
}

let mainWindow: BrowserWindow | null = null
let resizeObserverDiagnosticAt = 0
let suppressedResizeObserverDiagnostics = 0
let tray: Tray | null = null
let allowWindowClose = false
let quitRequested = false
let closeRequestInFlight = false
let appUpdateService: AppUpdateService | null = null
let currentProject: ProjectInfo | null = null
const aiProjectContext = new AsyncLocalStorage<ProjectInfo>()
const detachedWindows = new Map<DetachedWindowTarget, BrowserWindow>()
const pluginOverlayWindows = new Map<string, BrowserWindow>()

diagnosticJournal.configure(app.getPath('logs'), () => currentProject ? {
  name: currentProject.name,
  namespace: currentProject.namespace,
  kind: currentProject.kind ?? 'mod',
  loader: currentProject.loader,
  minecraftVersion: currentProject.minecraftVersion
} : undefined)
const workbenchDataStore = new WorkbenchDataStore(app.getPath('userData'), (entry) => {
  diagnosticJournal.record({
    subsystem: 'workbench-storage',
    operation: entry.operation,
    phase: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'success',
    level: entry.level,
    message: entry.message,
    data: entry.data,
    error: entry.error
  })
})
installProcessDiagnosticHandlers()
const sidebarViewIds = new Set<SidebarViewId>([
  'workspace', 'relationships', 'modpack-content', 'ftb-quests', 'patchouli', 'modpack-automation', 'modpack-server',
  'modpack-mod-list', 'third-party-mods', 'modpack-manifest', 'modpack-config', 'modpack-scripts',
  'modpack-datapacks', 'modpack-resourcepacks', 'modpack-shaders', 'modpack-ui', 'modpack-worlds',
  'modpack-client', 'modpack-server-content', 'modpack-files', 'inspiration', 'image-studio',
  'blockbench', 'minecraft', 'mappings', 'code', 'build', 'snapshots', 'production', 'decompile', 'settings'
])

function describeRuntimeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const errors = error.errors
    const details = errors.slice(0, 12).map((entry) => describeRuntimeError(entry)).filter(Boolean).join('; ')
    const remainder = errors.length > 12 ? `; 其余 ${errors.length - 12} 个错误已省略` : ''
    return [error.message, `${details}${remainder}`].filter(Boolean).join(': ') || 'multiple runtime operations failed'
  }
  if (error instanceof Error) {
    const cause = 'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined
    const detail = cause ? describeRuntimeError(cause) : ''
    return detail && detail !== error.message ? `${error.message}: ${detail}` : error.message
  }
  return String(error)
}

async function invokeMinecraftOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await withMinecraftResourceLock(operation)
  } catch (error) {
    const detail = describeRuntimeError(error)
    diagnosticJournal.record({ subsystem: 'minecraft', operation: 'ipc-operation', phase: 'error', message: detail || 'Minecraft operation failed', error })
    throw new Error(detail || 'Minecraft 操作失败', { cause: error })
  }
}

async function runDiagnosticOperation<T>(subsystem: string, operation: string, message: string, action: () => Promise<T>, data?: unknown): Promise<T> {
  const startedAt = Date.now()
  diagnosticJournal.record({ subsystem, operation, phase: 'start', message, data })
  try {
    const result = await action()
    diagnosticJournal.record({ subsystem, operation, phase: 'success', message: `${message} completed`, durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    diagnosticJournal.record({ subsystem, operation, phase: 'error', message: `${message} failed`, durationMs: Date.now() - startedAt, error })
    throw error
  }
}
let blockbenchBridge: BlockbenchBridge | null = null
let minecraftRuntime: MinecraftRuntimeManager | null = null
let localServerManager: LocalServerManager | null = null
let headlessMcService: HeadlessMcService | null = null
let forwardMinecraftEventsToServerPanel = false
let mappingService: MappingService | null = null
let loaderCatalog: LoaderCatalog | null = null
let dependencyService: DependencyService | null = null
let addonRelationshipService: AddonRelationshipService | null = null
let gitService: GitService | null = null
let contentService: ContentService | null = null
let releaseService: ReleaseService | null = null
let giteeBuildService: GiteeBuildService | null = null
let imageStudioService: ImageStudioService | null = null
let remoteClient: RemoteClientService | null = null
let remoteDeviceId: string | null = null
let modProviderRegistry: ModProviderRegistry | null = null
const mcmodService = new McmodService()
let publicMcpBridge: ModMindBridge | null = null
let publicMcpBridgeProjectPath = ''
let publicMcpBridgeProjectName = ''
let publicMcpBridgeConfigPath = ''
let publicMcpBridgeStartedAt: string | null = null
let publicMcpBridgeAbort: AbortController | null = null
let publicMcpBridgeStopping = false
// 用户在设置页开启「MCP 接入」后缓存到内存；项目打开/切换时据此自动跟随启动桥接。
let mcpBridgePreferenceEnabled = false
const chatCompletionsAdapter = new ChatCompletionsAdapter()
let publicMcpIntent: 'engineering' | 'informational' = 'informational'
let curseForgeProviderKey = process.env.MODMIND_CURSEFORGE_API_KEY ?? '$2a$10$BB17.sSejQebcTN01XAqmeXbucdfzq/nIKXylaKLpQHtHLrREVPku'
const IMAGE_DEFAULT_MODEL = 'gpt-image-2'
const hasSingleInstanceLock = app.requestSingleInstanceLock()
// modmind-plugin:// scheme 特权必须在 app.ready 前注册
registerPluginProtocolSchemeEarly()
const pendingDeviceDeepLinks: string[] = []
const minecraftDownloadActivityIds = new Map<string, { id: string; projectPath: string; stage: MinecraftRuntimeEvent['stage'] }>()
const DEFAULT_APP_UPDATE_URL = 'https://etherup.cn-nb1.rains3.com/'

downloadActivities.subscribe((snapshot) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('downloads:changed', snapshot)
  }
})

async function prepareMinecraftProject(projectPath: string): Promise<void> {
  const project = await readProjectInfo(projectPath)
  if (!project) throw new Error('无法重试：Minecraft 项目已不存在')
  await invokeMinecraftOperation(() => aiProjectContext.run(project, () => requireMinecraftRuntime().prepare()))
}

async function cancelMinecraftPreparation(projectPath: string): Promise<void> {
  const runtime = requireMinecraftRuntime()
  const state = runtime.getState()
  if (state.projectPath && !sameProjectPath(state.projectPath, projectPath)) return
  await runtime.cancelPreparation()
}

async function cancelTrackedMinecraftPreparation(projectPath: string): Promise<void> {
  await cancelMinecraftPreparation(projectPath)
  const tracked = [...minecraftDownloadActivityIds.entries()].filter(([, activity]) => activity.projectPath === projectPath)
  for (const [, activity] of tracked) await downloadActivities.cancel(activity.id)
}

async function restartTrackedMinecraftPreparation(projectPath: string): Promise<void> {
  const tracked = [...minecraftDownloadActivityIds.values()].find((activity) => activity.projectPath === projectPath)
  if (tracked) {
    await downloadActivities.restart(tracked.id)
    return
  }
  await cancelMinecraftPreparation(projectPath)
  await prepareMinecraftProject(projectPath)
}

function trackMinecraftDownloadEvent(event: MinecraftRuntimeEvent, projectPath: string): void {
  const failed = event.stage === 'error' || event.level === 'error'
  if (failed) {
    for (const [key, activity] of minecraftDownloadActivityIds) {
      if (activity.projectPath !== projectPath) continue
      downloadActivities.fail(activity.id, event.message)
      minecraftDownloadActivityIds.delete(key)
    }
    return
  }

  const trackedStage = event.stage === 'downloading-game'
    || event.stage === 'downloading-java'
    || event.stage === 'installing-loader'
    || event.stage === 'installing-fabric'
  const managedJdkAlreadyTracked = event.stage === 'downloading-java' && /\bJDK\b/i.test(event.message)
  if (trackedStage && !managedJdkAlreadyTracked) {
    const key = `${projectPath}:${event.stage}`
    let current = minecraftDownloadActivityIds.get(key)
    if (current) {
      const status = downloadActivities.snapshot().activities.find((activity) => activity.id === current?.id)?.status
      if (status !== 'downloading') {
        minecraftDownloadActivityIds.delete(key)
        current = undefined
      }
    }
    // Loader installers report no byte counts; show them as indeterminate rows.
    const detail = event.stage === 'installing-loader' || event.stage === 'installing-fabric' ? 'Minecraft Loader' : 'Minecraft 运行时'
    let id = current?.id ?? ''
    if (!id) {
      const retry = async (): Promise<void> => {
        minecraftDownloadActivityIds.set(key, { id, projectPath, stage: event.stage })
        await prepareMinecraftProject(projectPath)
      }
      id = downloadActivities.start({
        label: event.message,
        detail,
        retry,
        cancel: async () => {
          await cancelMinecraftPreparation(projectPath)
          if (minecraftDownloadActivityIds.get(key)?.id === id) minecraftDownloadActivityIds.delete(key)
        },
        restart: async () => {
          await cancelMinecraftPreparation(projectPath)
          minecraftDownloadActivityIds.set(key, { id, projectPath, stage: event.stage })
          await prepareMinecraftProject(projectPath)
        }
      })
    }
    minecraftDownloadActivityIds.set(key, { id, projectPath, stage: event.stage })
    downloadActivities.update(id, {
      label: event.message,
      detail,
      ...(event.progress !== undefined ? { downloadedBytes: event.progress } : {}),
      ...(event.total !== undefined ? { totalBytes: event.total } : {})
    })
    if (event.total !== undefined && event.progress !== undefined && event.total > 0 && event.progress >= event.total) {
      downloadActivities.complete(id)
      minecraftDownloadActivityIds.delete(key)
    }
  }

  for (const [key, activity] of minecraftDownloadActivityIds) {
    if (activity.projectPath === projectPath && activity.stage !== event.stage) {
      downloadActivities.complete(activity.id)
      minecraftDownloadActivityIds.delete(key)
    }
  }
}

function forwardMinecraftRuntimeEvent(event: MinecraftRuntimeEvent): void {
  const projectPath = event.projectPath ?? aiProjectContext.getStore()?.path ?? currentProject?.path
  const routedEvent = projectPath ? {...event, projectPath} : event
  trackMinecraftDownloadEvent(event, projectPath ?? 'global')
  diagnosticJournal.record({
    subsystem: 'minecraft',
    operation: event.stage,
    phase: event.level === 'error' ? 'error' : event.progress !== undefined ? 'progress' : 'event',
    level: event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'info',
    message: event.message,
    data: { progress: event.progress, total: event.total }
  })
  mainWindow?.webContents.send('minecraft:event', routedEvent)
  if (!forwardMinecraftEventsToServerPanel) return
  localServerManager?.recordOperation(event.message, event.level)
  const fraction = event.total && event.total > 0 && event.progress !== undefined ? event.progress / event.total : undefined
  localServerManager?.setOperationProgress({ message: event.message, fraction, downloaded: event.progress, total: event.total })
}

function requireModProviderRegistry(): ModProviderRegistry {
  if (!modProviderRegistry) modProviderRegistry = new ModProviderRegistry({ curseForgeApiKey: curseForgeProviderKey })
  return modProviderRegistry
}

if (!hasSingleInstanceLock) app.quit()
else if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient('mcdev', process.execPath, [path.resolve(process.argv[1])])
else app.setAsDefaultProtocolClient('mcdev')

const initialDeviceDeepLink = process.argv.find((argument) => argument.startsWith('mcdev://'))
if (initialDeviceDeepLink) pendingDeviceDeepLinks.push(initialDeviceDeepLink)

function mcpBridgeRequest(argv: string[] = process.argv): { enabled: boolean; stop: boolean; projectPath?: string } {
  const enabled = argv.includes('--mcp-bridge')
  const stop = argv.includes('--mcp-bridge-stop')
  const projectIndex = argv.findIndex((argument) => argument === '--project')
  const projectValue = projectIndex >= 0 ? argv[projectIndex + 1] : argv.find((argument) => argument.startsWith('--project='))?.slice('--project='.length)
  return { enabled, stop, ...(projectValue?.trim() ? { projectPath: path.resolve(projectValue.trim()) } : {}) }
}

app.on('second-instance', (_event, argv) => {
  if (appUpdateService?.hasDownloadedUpdate()) {
    void appUpdateService.installDownloadedUpdate().catch((error) => console.error('[update] failed to install downloaded update', error))
    return
  }
  const bridgeRequest = mcpBridgeRequest(argv)
  if (bridgeRequest.stop) void stopPublicMcpBridge().catch((error) => console.error('[mcp-bridge] failed to stop from second instance', error))
  else if (bridgeRequest.enabled) void startPublicMcpBridge(bridgeRequest.projectPath).catch((error) => console.error('[mcp-bridge] failed to start from second instance', error))
  const deepLink = argv.find((argument) => argument.startsWith('mcdev://'))
  if (deepLink) void handleDeviceDeepLink(deepLink)
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  void handleDeviceDeepLink(url)
})

app.on('before-quit', (event) => {
  diagnosticJournal.recordCritical({ subsystem: 'app', operation: 'shutdown', phase: 'before-quit', message: 'Application shutdown requested' })
  shutdownPlugins()
  chatCompletionsAdapter.close()
  if (!publicMcpBridge || publicMcpBridgeStopping) return
  event.preventDefault()
  publicMcpBridgeStopping = true
  void stopPublicMcpBridge().finally(() => {
    publicMcpBridgeStopping = false
    app.quit()
  })
})

const ignoredDirectories = new Set(['node_modules', '.git', 'build', '.gradle'])
const currentProjectManifest = 'modmind.project.json'

function projectDataDirectory(_project: ProjectInfo = requireProject()): '.modmind' {
  return '.modmind'
}

function projectManifest(_project: ProjectInfo = requireProject()): string {
  return currentProjectManifest
}

function isToolDataDirectory(name: string): boolean {
  return name === '.modmind'
}

const MAX_AI_ATTACHMENT_FILES = 8

function safeAttachmentName(source: string): string {
  const extension = path.extname(source).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16)
  const stem = path.basename(source, path.extname(source)).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'attachment'
  return `${stem}${extension}`
}

function isImageAttachment(name: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(name)
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

async function attachmentDirectorySize(source: string): Promise<number> {
  let total = 0
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) total += await attachmentDirectorySize(path.join(source, entry.name))
    else if (entry.isFile()) total += (await fs.stat(path.join(source, entry.name))).size
  }
  return total
}

async function pickAiAttachments(kind: AiAttachmentSelectionKind): Promise<AiAttachment[]> {
  const project = requireProject()
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: kind === 'directory' ? '选择发送给 AI 的文件夹' : '选择发送给 AI 的文件或图片',
    properties: kind === 'directory' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  })
  if (result.canceled || !result.filePaths.length) return []
  if (result.filePaths.length > MAX_AI_ATTACHMENT_FILES) throw new Error(`一次最多上传 ${MAX_AI_ATTACHMENT_FILES} 个附件`)
  const relativeDirectory = path.posix.join(projectDataDirectory(project), 'attachments')
  const targetDirectory = path.join(project.path, ...relativeDirectory.split('/'))
  const selected: Array<{ source: string; name: string; size: number; isDirectory: boolean }> = []
  for (const source of result.filePaths) {
    const stat = await fs.stat(source)
    const isDirectory = stat.isDirectory()
    if (!stat.isFile() && !isDirectory) throw new Error('只能上传文件或文件夹')
    if (isDirectory && (isPathInside(targetDirectory, source) || isPathInside(source, targetDirectory))) {
      throw new Error('不能上传 ModMind 附件目录或包含它的文件夹')
    }
    selected.push({ source, name: safeAttachmentName(source), size: isDirectory ? await attachmentDirectorySize(source) : stat.size, isDirectory })
  }
  await fs.mkdir(targetDirectory, { recursive: true })
  return Promise.all(selected.map(async (file) => {
    const id = randomUUID()
    const fileName = `${id.slice(0, 8)}-${file.name}`
    const relativePath = path.posix.join(relativeDirectory, fileName)
    if (file.isDirectory) {
      await fs.cp(file.source, path.join(targetDirectory, fileName), { recursive: true })
    } else {
      await fs.copyFile(file.source, path.join(targetDirectory, fileName))
    }
    return { id, name: file.name, path: relativePath, size: file.size, isImage: !file.isDirectory && isImageAttachment(file.name), isDirectory: file.isDirectory }
  }))
}

async function validateAiAttachments(attachments: AiAttachment[], requestedProjectPath?: string): Promise<AiAttachment[]> {
  if (!Array.isArray(attachments)) return []
  const project = requestedProjectPath?.trim()
    ? await readProjectInfo(path.resolve(requestedProjectPath))
    : requireProject()
  if (!project) throw new Error('附件所属项目不存在或不是有效 ModMind 项目')
  const attachmentDirectory = path.join(project.path, projectDataDirectory(project), 'attachments')
  const canonicalAttachmentDirectory = await fs.realpath(attachmentDirectory).catch(() => path.resolve(attachmentDirectory))
  const validated: AiAttachment[] = []
  const seen = new Set<string>()
  for (const attachment of attachments.slice(0, MAX_AI_ATTACHMENT_FILES)) {
    if (!attachment || typeof attachment.path !== 'string' || typeof attachment.id !== 'string' || typeof attachment.name !== 'string') continue
    const relativePath = attachment.path.slice(0, 8_192).replaceAll('\\', '/')
    if (/[\0\r\n]/.test(relativePath)) continue
    const absolutePath = path.resolve(project.path, ...relativePath.split('/'))
    const childPath = path.relative(attachmentDirectory, absolutePath)
    if (!childPath || !isPathInside(absolutePath, attachmentDirectory) || seen.has(absolutePath.toLowerCase())) continue
    const stat = await fs.stat(absolutePath).catch(() => null)
    if (!stat || (!stat.isFile() && !stat.isDirectory()) || stat.isDirectory() !== (attachment.isDirectory === true)) continue
    const canonicalPath = await fs.realpath(absolutePath).catch(() => '')
    if (!canonicalPath || !isPathInside(canonicalPath, canonicalAttachmentDirectory)) continue
    seen.add(absolutePath.toLowerCase())
    validated.push({
      id: attachment.id.slice(0, 256),
      name: attachment.name.slice(0, 1_024),
      path: path.relative(project.path, absolutePath).replaceAll('\\', '/'),
      size: stat.isDirectory() ? await attachmentDirectorySize(absolutePath) : stat.size,
      isImage: stat.isFile() && isImageAttachment(attachment.name),
      ...(stat.isDirectory() ? { isDirectory: true } : {})
    })
  }
  return validated
}

function requireMappings(): MappingService {
  if (!mappingService) mappingService = new MappingService(path.join(app.getPath('userData'), 'mappings'), app.getVersion())
  return mappingService
}

function requireLoaderCatalog(): LoaderCatalog {
  if (!loaderCatalog) loaderCatalog = new LoaderCatalog(path.join(app.getPath('userData'), 'loader-catalog.json'), app.getVersion())
  return loaderCatalog
}

function requireDependencyService(): DependencyService {
  if (!dependencyService) {
    dependencyService = new DependencyService(
      requireProject,
      (filePath) => requireMinecraftRuntime().importMods([filePath]),
      (fileName) => requireMinecraftRuntime().removeMod(fileName),
      app.getVersion()
    )
  }
  return dependencyService
}

function createAddonRelationshipService(getProject: () => ProjectInfo, runtimeIntegration = true): AddonRelationshipService {
  return new AddonRelationshipService({
    getProject,
    registry: requireModProviderRegistry,
    cacheRoot: path.join(app.getPath('userData'), 'addon-references'),
    importRuntime: runtimeIntegration ? (filePath) => requireMinecraftRuntime().importMods([filePath]) : async () => undefined,
    removeRuntime: runtimeIntegration ? (fileName) => requireMinecraftRuntime().removeMod(fileName) : async () => undefined,
    readProject: (projectPath) => readProjectInfo(projectPath),
    mcmod: mcmodService
  })
}

function requireAddonRelationshipService(): AddonRelationshipService {
  if (!addonRelationshipService) addonRelationshipService = createAddonRelationshipService(requireProject)
  return addonRelationshipService
}

async function buildLinkedProjectTree(project: ProjectInfo, signal: AbortSignal | undefined, stack: string[]): Promise<string> {
  const normalized = path.resolve(project.path)
  if (stack.map((entry) => path.resolve(entry)).includes(normalized)) throw new Error(`检测到 ModMind 项目循环依赖：${[...stack, normalized].join(' -> ')}`)
  const service = createAddonRelationshipService(() => project, false)
  await service.refreshLinkedProjects((linked) => buildLinkedProjectTree(linked, signal, [...stack, normalized]), [...stack, normalized])
  return requireMinecraftRuntime().buildDependencyProject(project, signal)
}

function requireGitService(): GitService {
  if (!gitService) gitService = new GitService(requireProject)
  return gitService
}

function requireContentService(): ContentService {
  if (!contentService) contentService = new ContentService(requireProject)
  return contentService
}

function releaseSecretsFile(): string {
  return path.join(app.getPath('userData'), 'release-secrets.json')
}

async function readReleaseSecrets(): Promise<ReleaseSecrets> {
  const empty: ReleaseSecrets = { modrinthToken: '', curseForgeToken: '', githubToken: '' }
  if (!safeStorage.isEncryptionAvailable()) return empty
  try {
    const value = JSON.parse(await fs.readFile(releaseSecretsFile(), 'utf8')) as Record<string, unknown>
    const decrypt = (key: string): string => {
      const encoded = value[key]
      if (typeof encoded !== 'string' || !encoded) return ''
      try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')) } catch { return '' }
    }
    return { modrinthToken: decrypt('modrinthToken'), curseForgeToken: decrypt('curseForgeToken'), githubToken: decrypt('githubToken') }
  } catch {
    return empty
  }
}

async function writeReleaseSecrets(secrets: ReleaseSecrets): Promise<void> {
  if (!safeStorage.isEncryptionAvailable() && Object.values(secrets).some((value) => value.trim())) {
    throw new Error('系统加密存储不可用，拒绝以明文保存发布令牌')
  }
  const encrypt = (value: string): string => value.trim() ? safeStorage.encryptString(value.trim()).toString('base64') : ''
  await fs.mkdir(path.dirname(releaseSecretsFile()), { recursive: true })
  await fs.writeFile(releaseSecretsFile(), JSON.stringify({
    modrinthToken: encrypt(secrets.modrinthToken),
    curseForgeToken: encrypt(secrets.curseForgeToken),
    githubToken: encrypt(secrets.githubToken)
  }, null, 2), 'utf8')
}

function requireReleaseService(): ReleaseService {
  if (!releaseService) releaseService = new ReleaseService(requireProject, readReleaseSecrets, writeReleaseSecrets, app.getVersion())
  return releaseService
}

function requireGiteeBuildService(): GiteeBuildService {
  if (!giteeBuildService) giteeBuildService = new GiteeBuildService({ getProject: requireProject, readSettings: readGiteeBuildSettings })
  return giteeBuildService
}

interface StoredDeviceCredentials {
  version: 1
  siteUrl: string
  baseUrl: string
  encryptedApiKey: string
  username: string
  balanceCents: string
  connectedAt: string
  usage?: DeviceUsage
}

interface DeviceCredentials extends Omit<StoredDeviceCredentials, 'encryptedApiKey'> {
  apiKey: string
}

let deviceAuthorizationController: AbortController | null = null
let transientDeviceState: DeviceConnectionState | null = null
const QUOTA_USAGE_MAX_AGE_MS = 2 * 60_000
const QUOTA_MODEL_MAX_AGE_MS = 5 * 60_000
const quotaModelAvailabilityCache = new Map<string, { checkedAt: number; models: string[] }>()
const externalModelAvailabilityCache = new Map<string, { checkedAt: number; models: AiModelInfo[] }>()

function quotaModelCacheKey(credentials: Pick<DeviceCredentials, 'baseUrl' | 'apiKey'>): string {
  return quotaPreferenceKey(credentials.baseUrl, credentials.apiKey)
}

async function quotaModelsForCredentials(credentials: DeviceCredentials, force = false): Promise<AiModelInfo[]> {
  const key = quotaModelCacheKey(credentials)
  const cached = quotaModelAvailabilityCache.get(key)
  if (!force && cached && Date.now() - cached.checkedAt <= QUOTA_MODEL_MAX_AGE_MS) {
    return cached.models.map((id) => ({ id }))
  }
  const models = await fetchAvailableModels(openAiV1BaseUrl(credentials.baseUrl), credentials.apiKey, '无法读取账号可用模型')
  quotaModelAvailabilityCache.set(key, { checkedAt: Date.now(), models: models.map((model) => model.id) })
  return models
}

function deviceCredentialsFile(): string {
  return path.join(app.getPath('userData'), 'device-credentials.json')
}

async function writeDeviceFileAtomically(value: StoredDeviceCredentials): Promise<void> {
  const target = deviceCredentialsFile()
  const temporary = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      await fs.rename(temporary, target)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function configuredDeviceSiteUrl(): string | null {
  let value = process.env.MODMIND_SITE_URL?.trim() ?? ''
  if (!value) {
    const configPath = app.isPackaged
      ? path.join(process.resourcesPath, 'service-config.json')
      : path.join(app.getAppPath(), 'resources', 'service-config.json')
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { siteUrl?: unknown }
      if (typeof config.siteUrl === 'string') value = config.siteUrl.trim()
    } catch {
      value = ''
    }
  }
  return value ? normalizeSiteUrl(value) : null
}

function configuredAppUpdateUrl(): string {
  let value = process.env.MODMIND_UPDATE_URL?.trim() ?? ''
  if (!value) {
    const configPath = app.isPackaged
      ? path.join(process.resourcesPath, 'service-config.json')
      : path.join(app.getAppPath(), 'resources', 'service-config.json')
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { updateUrl?: unknown }
      if (typeof config.updateUrl === 'string') value = config.updateUrl.trim()
    } catch {
      value = ''
    }
  }
  try {
    return normalizeAppUpdateUrl(value || DEFAULT_APP_UPDATE_URL)
  } catch (error) {
    console.warn('[update] invalid update URL, using default', error)
    return DEFAULT_APP_UPDATE_URL
  }
}

function disconnectedDeviceState(message?: string): DeviceConnectionState {
  let configured = false
  try { configured = Boolean(configuredDeviceSiteUrl()) } catch { /* Expose the configuration error when authorization starts. */ }
  return { status: 'disconnected', configured, ...(message ? { message } : {}) }
}

async function checkForAppUpdates(): Promise<AppVersionCheckResult | null> {
  const siteUrl = configuredDeviceSiteUrl()
  if (!siteUrl) return null
  try {
    const result = await checkAppVersion(siteUrl, app.getVersion(), AbortSignal.timeout(12_000))
    appUpdateService?.setAvailableUpdate(result)
    return result
  } catch (error) {
    console.warn('[update] version check failed', error)
    return null
  }
}

async function readDeviceCredentials(): Promise<DeviceCredentials | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const stored = JSON.parse(await fs.readFile(deviceCredentialsFile(), 'utf8')) as StoredDeviceCredentials
    if (stored.version !== 1 || !stored.encryptedApiKey || !stored.username || !/^\d+$/.test(stored.balanceCents)) return null
    const apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim()
    if (!apiKey) return null
    return {
      ...stored,
      siteUrl: normalizeSiteUrl(stored.siteUrl),
      baseUrl: normalizeRelayBaseUrl(stored.baseUrl),
      apiKey
    }
  } catch {
    return null
  }
}

async function writeDeviceCredentials(credentials: Omit<DeviceCredentials, 'version'>): Promise<DeviceCredentials> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法安全保存接入凭证')
  const normalized: DeviceCredentials = {
    ...credentials,
    version: 1,
    siteUrl: normalizeSiteUrl(credentials.siteUrl),
    baseUrl: normalizeRelayBaseUrl(credentials.baseUrl),
    apiKey: credentials.apiKey.trim()
  }
  if (!normalized.apiKey) throw new Error('接入凭证为空')
  const { apiKey, ...metadata } = normalized
  const stored: StoredDeviceCredentials = {
    ...metadata,
    encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64')
  }
  await writeDeviceFileAtomically(stored)
  return normalized
}

function publicDeviceState(credentials: DeviceCredentials): DeviceConnectionState {
  return {
    status: 'connected',
    configured: true,
    siteUrl: credentials.siteUrl,
    username: credentials.username,
    balanceCents: credentials.usage?.balanceCents ?? credentials.balanceCents,
    keyStatus: credentials.usage?.keyStatus ?? 'ACTIVE',
    frozenReason: credentials.usage?.frozenReason ?? null,
    checkedAt: credentials.usage?.checkedAt
  }
}

async function readDeviceState(): Promise<DeviceConnectionState> {
  if (transientDeviceState) return transientDeviceState
  const credentials = await readDeviceCredentials()
  return credentials ? publicDeviceState(credentials) : disconnectedDeviceState()
}

function emitDeviceState(state: DeviceConnectionState): void {
  diagnosticJournal.record({
    subsystem: 'device',
    operation: 'state',
    phase: state.status === 'error' ? 'error' : 'update',
    level: state.status === 'error' ? 'error' : 'info',
    message: state.message || `Device state: ${state.status}`,
    data: state
  })
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('device:state', state)
}

async function updateDeviceState(state: DeviceConnectionState | null): Promise<DeviceConnectionState> {
  transientDeviceState = state
  const current = state ?? await readDeviceState()
  emitDeviceState(current)
  return current
}

async function waitForDevicePoll(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function deviceAuthorizationFailure(message: string): Promise<void> {
  const existing = await readDeviceCredentials()
  let configured = false
  try { configured = Boolean(configuredDeviceSiteUrl()) } catch { /* The original configuration error is already in message. */ }
  await updateDeviceState(existing ? { ...publicDeviceState(existing), message } : {
    status: 'error',
    configured,
    message
  })
}

function startDevicePolling(siteUrl: string, code: string, expiresIn: number, controller: AbortController): void {
  const deadline = Date.now() + Math.min(Math.max(expiresIn, 1), 600) * 1_000
  void (async () => {
    let retryIndex = 0
    const retryDelays = [2_000, 5_000, 10_000]
    while (Date.now() < deadline && !controller.signal.aborted) {
      try {
        await waitForDevicePoll(retryDelays[Math.min(retryIndex, retryDelays.length - 1)], controller.signal)
        const result = await pollDeviceCode(siteUrl, code, controller.signal)
        if (result.status === 'pending') {
          retryIndex = 0
          continue
        }
        if (result.status === 'expired') {
          await deviceAuthorizationFailure('授权码已过期，请重新连接账号')
          return
        }
        const credentials = await writeDeviceCredentials({
          siteUrl,
          baseUrl: result.baseUrl,
          apiKey: result.apiKey,
          username: result.username,
          balanceCents: result.balanceCents,
          connectedAt: new Date().toISOString()
        })
        await reconcileQuotaModelPreferences(credentials, true).catch((error) => {
          console.warn('[device] unable to reconcile model preferences after key update', error)
        })
        await updateDeviceState(publicDeviceState(credentials))
        // A live socket authenticated with the previous key cannot update in
        // place. Recreate it after the new credential is durably stored.
        const remoteWasEnabled = remoteClient?.getState().enabled === true || await readRemoteEnabled()
        await stopRemoteClient()
        if (remoteWasEnabled) void startRemoteClientIfPossible().catch((error) => console.warn('[remote] unable to restart after credential sync', error))
        return
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof DeviceApiError && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)) {
          retryIndex += 1
          continue
        }
        await deviceAuthorizationFailure(error instanceof Error ? error.message : String(error))
        return
      }
    }
    if (!controller.signal.aborted) await deviceAuthorizationFailure('授权等待已超时，请重新连接账号')
  })().finally(() => {
    if (deviceAuthorizationController === controller) deviceAuthorizationController = null
  })
}

async function beginDeviceAuthorization(): Promise<DeviceConnectionState> {
  const siteUrl = configuredDeviceSiteUrl()
  if (!siteUrl) throw new Error('未配置正式站点地址，请在发行环境设置 MODMIND_SITE_URL')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法开始授权')
  deviceAuthorizationController?.abort()
  const controller = new AbortController()
  deviceAuthorizationController = controller
  const initial: DeviceConnectionState = { status: 'authorizing', configured: true, siteUrl, message: '正在申请授权码' }
  await updateDeviceState(initial)
  try {
    const result = await requestDeviceCode(siteUrl, controller.signal)
    const expiresAt = new Date(Date.now() + result.expiresIn * 1_000).toISOString()
    const authorizing: DeviceConnectionState = { ...initial, expiresAt, message: '请在浏览器中登录并确认授权' }
    await updateDeviceState(authorizing)
    await shell.openExternal(result.authUrl)
    startDevicePolling(siteUrl, result.code, result.expiresIn, controller)
    return authorizing
  } catch (error) {
    if (deviceAuthorizationController === controller) deviceAuthorizationController = null
    const message = error instanceof Error ? error.message : String(error)
    await deviceAuthorizationFailure(message)
    throw new Error(message)
  }
}

async function beginDeviceDeepLinkAuthorization(rawUrl: string): Promise<DeviceConnectionState> {
  const expectedSite = configuredDeviceSiteUrl()
  if (!expectedSite) throw new Error('未配置正式站点地址，拒绝处理设备深链')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法处理设备深链')
  const { siteUrl, code } = parseDeviceDeepLink(rawUrl, expectedSite)
  deviceAuthorizationController?.abort()
  const controller = new AbortController()
  deviceAuthorizationController = controller
  const state: DeviceConnectionState = {
    status: 'authorizing',
    configured: true,
    siteUrl,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    message: '已收到网页授权，正在同步凭证'
  }
  await updateDeviceState(state)
  startDevicePolling(siteUrl, code, 600, controller)
  return state
}

async function handleDeviceDeepLink(rawUrl: string): Promise<void> {
  if (!app.isReady() || !mainWindow) {
    pendingDeviceDeepLinks.push(rawUrl)
    return
  }
  try {
    await beginDeviceDeepLinkAuthorization(rawUrl)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } catch (error) {
    await deviceAuthorizationFailure(error instanceof Error ? error.message : String(error))
  }
}

async function cancelDeviceAuthorization(): Promise<DeviceConnectionState> {
  deviceAuthorizationController?.abort()
  deviceAuthorizationController = null
  transientDeviceState = null
  const state = await readDeviceState()
  emitDeviceState(state)
  return state
}

async function disconnectDeviceLocally(): Promise<DeviceConnectionState> {
  deviceAuthorizationController?.abort()
  deviceAuthorizationController = null
  await stopRemoteClient()
  await fs.rm(deviceCredentialsFile(), { force: true })
  return updateDeviceState(disconnectedDeviceState('已从本机移除接入凭证'))
}

async function refreshDeviceUsage(): Promise<DeviceConnectionState> {
  const credentials = await readDeviceCredentials()
  if (!credentials) return updateDeviceState(disconnectedDeviceState('请先连接 ModMind 账号'))
  const checkedAt = credentials.usage ? Date.parse(credentials.usage.checkedAt) : Number.NaN
  if (credentials.usage && Number.isFinite(checkedAt) && Date.now() - checkedAt < QUOTA_USAGE_MAX_AGE_MS) {
    return updateDeviceState(publicDeviceState(credentials))
  }
  try {
    const usage = await queryDeviceUsage(credentials.siteUrl, credentials.apiKey, AbortSignal.timeout(20_000))
    const updated = await writeDeviceCredentials({ ...credentials, usage })
    return updateDeviceState(publicDeviceState(updated))
  } catch (error) {
    if (error instanceof DeviceApiError && error.status === 401) {
      await stopRemoteClient()
      await fs.rm(deviceCredentialsFile(), { force: true })
      return updateDeviceState(disconnectedDeviceState('接入 Key 已失效，请重新连接账号'))
    }
    const state = publicDeviceState(credentials)
    return updateDeviceState({ ...state, message: error instanceof Error ? error.message : String(error) })
  }
}

async function ensureQuotaAccountReady(): Promise<void> {
  let credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号')

  let usage = credentials.usage
  const checkedAt = usage ? Date.parse(usage.checkedAt) : Number.NaN
  if (!usage || !Number.isFinite(checkedAt) || Date.now() - checkedAt > QUOTA_USAGE_MAX_AGE_MS) {
    try {
      usage = await queryDeviceUsage(credentials.siteUrl, credentials.apiKey, AbortSignal.timeout(20_000))
      credentials = await writeDeviceCredentials({ ...credentials, usage })
      await updateDeviceState(publicDeviceState(credentials))
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 401) {
        await stopRemoteClient()
        await fs.rm(deviceCredentialsFile(), { force: true })
        await updateDeviceState(disconnectedDeviceState('接入 Key 已失效，请重新连接账号'))
        throw new Error('接入 Key 已失效，请重新连接账号')
      }
      // A persisted balance is still useful when the usage health check is
      // rate-limited or temporarily unavailable.
      if (!usage && credentials.balanceCents === '0') {
        throw new Error('账号余额不足，请充值后再开始制作')
      }
    }
  }

  if (usage?.keyStatus === 'FROZEN') {
    throw new Error(`当前接入 Key 已冻结${usage.frozenReason ? `：${usage.frozenReason}` : ''}，请处理账号状态后重试`)
  }
  if (usage && BigInt(usage.balanceCents) <= 0n && BigInt(usage.remainQuota) <= 0n) {
    throw new Error('账号余额和可用额度均不足，请充值后再开始制作')
  }

  try {
    const models = await quotaModelsForCredentials(credentials)
    if (models.length) await reconcileQuotaModelPreferences(credentials, false, models)
  } catch {
    // Some compatible relays do not expose /model(s). The actual Agent
    // request remains authoritative in that case.
  }
}

async function openConfiguredDeviceSite(relativePath = '/'): Promise<void> {
  const credentials = await readDeviceCredentials()
  const siteUrl = credentials?.siteUrl ?? configuredDeviceSiteUrl()
  if (!siteUrl) throw new Error('未配置正式站点地址')
  const safePath = typeof relativePath === 'string' && /^\/[a-z0-9/_-]*$/i.test(relativePath) ? relativePath : '/'
  await shell.openExternal(new URL(safePath, siteUrl).toString())
}

function remoteDeviceIdFile(): string {
  return path.join(app.getPath('userData'), 'remote-device-id.txt')
}

function remotePreferenceFile(): string {
  return path.join(app.getPath('userData'), 'remote-preferences.json')
}

async function readRemoteEnabled(): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(remotePreferenceFile(), 'utf8')) as { enabled?: unknown }
    return value.enabled !== false
  } catch {
    return true
  }
}

async function writeRemoteEnabled(enabled: boolean): Promise<void> {
  await fs.mkdir(path.dirname(remotePreferenceFile()), { recursive: true })
  await fs.writeFile(remotePreferenceFile(), JSON.stringify({ enabled: Boolean(enabled) }, null, 2), 'utf8')
}

function mcpBridgePreferenceFile(): string {
  return path.join(app.getPath('userData'), 'mcp-bridge-preferences.json')
}

async function loadMcpBridgePreference(): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(mcpBridgePreferenceFile(), 'utf8')) as { enabled?: unknown }
    return value.enabled === true
  } catch {
    return false
  }
}

async function persistMcpBridgePreference(enabled: boolean): Promise<void> {
  mcpBridgePreferenceEnabled = enabled
  await fs.mkdir(path.dirname(mcpBridgePreferenceFile()), { recursive: true })
  await fs.writeFile(mcpBridgePreferenceFile(), JSON.stringify({ enabled }, null, 2), 'utf8')
}

function mcpBridgeState(): McpBridgeState {
  return {
    enabled: mcpBridgePreferenceEnabled,
    running: Boolean(publicMcpBridge),
    projectPath: publicMcpBridge ? publicMcpBridgeProjectPath : null,
    projectName: publicMcpBridge ? publicMcpBridgeProjectName : null,
    mcpConfigPath: publicMcpBridge ? publicMcpBridgeConfigPath : null,
    startedAt: publicMcpBridge ? publicMcpBridgeStartedAt : null
  }
}

function broadcastMcpBridgeState(): void {
  const state = mcpBridgeState()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('mcp-bridge:state', state)
  }
}

async function readRemoteDeviceId(): Promise<string> {
  const stored = await fs.readFile(remoteDeviceIdFile(), 'utf8').catch(() => '')
  if (/^[a-zA-Z0-9._:-]{1,100}$/.test(stored.trim())) return stored.trim()
  const id = `desktop-${randomUUID()}`
  await fs.mkdir(path.dirname(remoteDeviceIdFile()), { recursive: true })
  await fs.writeFile(remoteDeviceIdFile(), id, { encoding: 'utf8', mode: 0o600 })
  return id
}

function remoteProjectId(project: ProjectInfo): string {
  const projectPath = path.resolve(project.path)
  const stablePath = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath
  return createHash('sha256').update(stablePath).digest('hex').slice(0, 24)
}

function remoteProjectSummary(project: ProjectInfo): RemoteProjectSummary {
  return { id: remoteProjectId(project), name: project.name, kind: project.kind ?? 'mod', loader: project.loader, minecraftVersion: project.minecraftVersion }
}

async function remoteAppState(): Promise<RemoteAppState> {
  const settings = await readSettings()
  const recent = await readRecentProjects()
  const model = settings.codingBackend === 'quota'
    ? (await readBeginnerAiPreferences()).model
    : settings.externalAgents?.[settings.codingBackend]?.model
  return {
    currentProject: currentProject ? remoteProjectSummary(currentProject) : null,
    projects: recent.map(remoteProjectSummary),
    agent: settings.codingBackend,
    ...(model ? { model } : {}),
    remote: remoteClient?.getState() ?? { status: 'disabled', enabled: false }
  }
}

function emitProjectChanged(): void {
  diagnosticJournal.record({
    subsystem: 'project',
    operation: 'changed',
    phase: currentProject ? 'opened' : 'closed',
    message: currentProject ? `Project active: ${currentProject.name}` : 'No active project',
    data: currentProject ? { kind: currentProject.kind, loader: currentProject.loader, minecraftVersion: currentProject.minecraftVersion, namespace: currentProject.namespace } : undefined
  })
  // 插件注册表随项目切换刷新（项目级插件目录变化）
  void refreshPluginRegistry().then((snapshot) => broadcastPluginSnapshot(snapshot)).catch(() => undefined)
  if (publicMcpBridge && currentProject && !sameProjectPath(publicMcpBridgeProjectPath, currentProject.path)) {
    void stopPublicMcpBridge().then(() => {
      // 桥接跟随当前项目：项目切换后按用户偏好自动重启
      if (mcpBridgePreferenceEnabled && currentProject) {
        return startPublicMcpBridge(currentProject.path).catch((error) => console.warn('[mcp-bridge] failed to restart after project switch', error))
      }
      return undefined
    }).catch((error) => console.warn('[mcp-bridge] failed to stop after project switch', error))
  } else if (!publicMcpBridge && currentProject && mcpBridgePreferenceEnabled) {
    void startPublicMcpBridge(currentProject.path).catch((error) => console.warn('[mcp-bridge] failed to start after project open', error))
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('project:changed', currentProject)
}

function broadcastPluginSnapshot(snapshot: { plugins: unknown[] }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('plugins:changed', snapshot)
  }
}

async function createProjectForRemote(input: ProjectCreateInput): Promise<ProjectInfo> {
  assertProjectSwitchAllowed()
  if (!(PROJECT_PLATFORMS as readonly string[]).includes(input.loader)) throw new Error('不支持的项目平台')
  const kind = input.kind === 'modpack' ? 'modpack' : 'mod'
  if (kind === 'modpack' && !isJavaLoader(input.loader)) throw new Error('整合包目前仅支持 Java 版 Fabric、Quilt、Forge 和 NeoForge')
  const name = validateProjectNameInput(input.name)
  const minecraftVersion = input.minecraftVersion.trim()
  const compatibility = await requireLoaderCatalog().resolve(input.loader, minecraftVersion)
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) throw new Error('Remote 新建项目已取消')
  const namespace = slugify(name)
  const projectPath = path.join(result.filePaths[0], namespace)
  if (await pathExists(projectPath)) throw new Error('项目目录已经存在，请修改项目名称或选择其他位置')
  const project: ProjectInfo = {
    ...input,
    kind,
    name,
    minecraftVersion,
    namespace,
    path: projectPath,
    createdAt: new Date().toISOString(),
    loaderVersion: compatibility.loaderVersion,
    apiVersion: compatibility.apiVersion,
    qslVersion: compatibility.qslVersion,
    javaVersion: compatibility.javaVersion,
    projectVersion: CURRENT_PROJECT_VERSION,
    toolDataDirectory: '.modmind'
  }
  await fs.mkdir(projectPath)
  try {
    if (kind === 'modpack') {
      await fs.writeFile(path.join(projectPath, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
      await createModpackTemplate(project)
    } else {
      await writeProjectTemplate(project)
    }
    await fs.mkdir(path.join(projectPath, '.modmind'), { recursive: true })
  } catch (error) {
    await fs.rm(projectPath, { recursive: true, force: true })
    throw error
  }
  currentProject = project
  await rememberRecentProject(project)
  await refreshExternalAgentContext(project).catch(() => undefined)
  emitProjectChanged()
  return project
}

async function executeRemoteAppAction(action: RemoteAppAction): Promise<unknown> {
  switch (action.type) {
    case 'create_project':
      return createProjectForRemote(action)
    case 'select_project': {
      const recent = await readRecentProjects()
      const selected = recent.find((project) => remoteProjectId(project) === action.projectId)
      if (!selected) throw new Error('找不到 Remote Controller 要打开的项目')
      assertProjectSwitchAllowed()
      const info = await readProjectInfo(selected.path)
      if (!info) throw new Error('目标项目不存在或项目清单无效')
      currentProject = await offerProjectVersionMigration(info)
      await rememberRecentProject(currentProject)
      await refreshExternalAgentContext(currentProject).catch(() => undefined)
      emitProjectChanged()
      return currentProject
    }
    case 'open_page': {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('ModMind 主窗口不可用')
      mainWindow.show()
      mainWindow.webContents.send('app:openView', action.page)
      return { success: true, page: action.page }
    }
    case 'open_window': {
      const view = action.view as SidebarViewId
      const window = createDetachedWindow(view, action.title?.trim() || view)
      window.show()
      return { success: true, view }
    }
    case 'close_window': {
      if (action.view) {
        detachedWindows.get(action.view as SidebarViewId)?.close()
        return { success: true, view: action.view }
      }
      for (const window of detachedWindows.values()) window.close()
      return { success: true, closed: 'detached' }
    }
    case 'open_settings': {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('ModMind 主窗口不可用')
      mainWindow.show()
      mainWindow.webContents.send('app:openSettings')
      return { success: true }
    }
    case 'open_project_folder': {
      const project = requireProject()
      await shell.openPath(project.path)
      return { success: true, path: project.path }
    }
    case 'open_ide': {
      await prepareProjectIde(requireProject())
      const project = requireProject()
      const invocation = process.platform === 'win32'
        ? windowsCmdInvocation('code.cmd', [project.path])
        : { command: 'code', args: [project.path], windowsVerbatimArguments: false as const }
      await new Promise<void>((resolve, reject) => {
        execFile(invocation.command, invocation.args, { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (error) => error ? reject(error) : resolve())
      }).catch(async () => {
        await shell.openPath(project.path)
        throw new Error('未检测到 VS Code，已打开项目目录')
      })
      return { success: true, path: project.path }
    }
    case 'minimize':
      mainWindow?.minimize()
      return { success: true }
    case 'close_app':
      quitFromTray()
      return { success: true }
    case 'decompile_jar_to_module': {
      const pack = requireProject()
      if (!isModpackProject(pack)) throw new Error('AI 只能在整合包项目中把反编译源码导出为自制模组')
      // The AI must have surfaced the CURRENT terms to the user and passed that exact
      // version back; anything else is rejected so consent can never be fabricated.
      if (action.termsVersionAcknowledged !== DECOMPILE_TERMS_VERSION) {
        throw new Error(`AI 声明的条款版本（${action.termsVersionAcknowledged || '空'}）与当前版本（${DECOMPILE_TERMS_VERSION}）不一致；请让用户在反编译工作区阅读并确认最新条款`)
      }
      const controller = new AbortController()
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntime(undefined, DECOMPILE_MIN_JAVA)
      const result = await runDecompilation({ jarPath: action.jarPath, skipRemap: action.skipRemap, ...(action.minecraftVersion ? { minecraftVersion: action.minecraftVersion } : {}) }, {
        cacheRoot: path.join(app.getPath('userData'), 'decompile'),
        javaPath,
        signal: controller.signal
      })
      const provenance = await readDecompileProvenanceForExport(path.join(app.getPath('userData'), 'decompile'), result.sha256)
      const created = await createModuleFromDecompiledSources({
        packPath: pack.path,
        jarName: provenance.sourceFileName,
        moduleName: action.moduleName,
        provenance,
        sourcesDirectory: path.join(app.getPath('userData'), 'decompile', 'jars', result.sha256, 'sources'),
        acknowledgement: {
          acceptedAt: new Date().toISOString(),
          sourceJarSha256: provenance.sourceSha256,
          sourceFileName: provenance.sourceFileName,
          origin: 'ai-action'
        }
      })
      await addModpackModule(pack, { name: created.name, namespace: created.namespace, path: created.relativePath, createdAt: new Date().toISOString() })
      diagnosticJournal.record({ subsystem: 'decompile', operation: 'remote-create-module', phase: 'success', level: 'info', message: `Remote Controller 已从反编译源码创建自制模组 ${created.namespace}（来源 ${provenance.sourceFileName}，条款 v${DECOMPILE_TERMS_VERSION}）`, data: { namespace: created.namespace, fileCount: created.fileCount } })
      return created
    }
    case 'set_workbench_agent': {
      if (activeAiRuns.size) throw new Error('存在运行中的 AI 任务，暂时不能切换 Agent')
      const settings = await readSettings()
      const saved = await saveAgentSettings({ ...settings, codingBackend: action.agent })
      return { success: true, agent: saved.codingBackend }
    }
    case 'set_workbench_model': {
      if (activeAiRuns.size) throw new Error('存在运行中的 AI 任务，暂时不能切换模型')
      const settings = await readSettings()
      if (settings.codingBackend === 'quota') {
        const preferences = await readBeginnerAiPreferences()
        const saved = await saveBeginnerAiPreferences({ ...preferences, model: action.model })
        return { success: true, model: saved.model }
      }
      const current = settings.externalAgents?.[settings.codingBackend] ?? {}
      const saved = await saveAgentSettings({
        ...settings,
        externalAgents: { ...settings.externalAgents, [settings.codingBackend]: { ...current, model: action.model } }
      })
      return { success: true, model: saved.externalAgents?.[settings.codingBackend]?.model }
    }
    case 'set_app_setting': {
      const result = await applyAppSettingWrite({ key: action.key, value: action.value })
      return { success: true, key: action.key, value: result[action.key] }
    }
    case 'get_app_settings': return publicAgentSettings(await readSettings())
    case 'scan_java_homes': return detectInstalledJavaHomes()
    case 'probe_java_home': {
      const home = action.home.trim()
      if (!home) throw new Error('probe_java_home 需要非空的 Java 路径')
      return probeJavaHomeInfo(home)
    }
  }
}

type AppSettingKey =
  | 'javaPreferences' | 'darkMode' | 'notificationsEnabled' | 'allowBuildScriptChanges'
  | 'preferLocalGradle' | 'closeBehavior' | 'gradleDownloadSource'

const APP_SETTING_KEYS: readonly AppSettingKey[] = [
  'javaPreferences', 'darkMode', 'notificationsEnabled', 'allowBuildScriptChanges',
  'preferLocalGradle', 'closeBehavior', 'gradleDownloadSource'
]

/** Shared write path for the remote controller and the MCP app-setting tool. */
async function applyAppSettingWrite(input: Record<string, unknown>): Promise<AgentSettings> {
  const key = String(input.key ?? '') as AppSettingKey
  const value = input.value
  if (!APP_SETTING_KEYS.includes(key)) throw new Error(`不支持的应用设置键：${key || '(空)'}`)
  const next = { ...await readSettings() } as AgentSettings
  if (key === 'javaPreferences') {
    if (typeof value !== 'object' || value === null) throw new Error('Java 偏好需要对象值')
    next.javaPreferences = normalizeJavaPreferences(value)
  } else if (key === 'darkMode' || key === 'notificationsEnabled' || key === 'allowBuildScriptChanges' || key === 'preferLocalGradle') {
    if (typeof value !== 'boolean') throw new Error(`应用设置 ${key} 需要布尔值`)
    next[key] = value
  } else if (key === 'closeBehavior') {
    if (value !== 'ask' && value !== 'tray' && value !== 'quit') throw new Error('关闭行为只能是 ask、tray 或 quit')
    next.closeBehavior = value
  } else {
    if (value !== 'auto' && value !== 'china' && value !== 'official') throw new Error('Gradle 下载源无效')
    next.gradleDownloadSource = value
  }
  return await saveAgentSettings(next)
}

async function remoteQuotaConfig(): Promise<RemoteQuotaConfig> {
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号')
  const preferences = await readBeginnerAiPreferences()
  return {
    baseUrl: openAiV1BaseUrl(credentials.baseUrl),
    apiKey: credentials.apiKey,
    model: preferences.model,
    reasoningEffort: beginnerReasoningEffort(preferences.model, preferences.reasoningLevel)
  }
}

function broadcastPluginDiagnostics(diagnostics: PluginDiagnostics): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('plugins:diagnostics', diagnostics)
  }
}

function remoteEndpoint(): string | null {
  const configured = process.env.MODMIND_REMOTE_URL?.trim()
  if (configured) return configured
  const site = configuredDeviceSiteUrl()
  return site ? remoteEndpointFromSite(site) : null
}

function beginnerAiPreferencesFile(): string {
  return path.join(app.getPath('userData'), 'beginner-ai-preferences.json')
}

const DEFAULT_BEGINNER_AI_PREFERENCES: BeginnerAiPreferences = { model: DEFAULT_DEVICE_MODEL, reasoningLevel: 'medium', fastMode: false }

async function readStoredBeginnerAiPreferences(): Promise<StoredQuotaModelPreferences> {
  const stored = await fs.readFile(beginnerAiPreferencesFile(), 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => null)
  return parseStoredQuotaModelPreferences(stored, DEFAULT_BEGINNER_AI_PREFERENCES)
}

async function writeStoredBeginnerAiPreferences(value: StoredQuotaModelPreferences): Promise<void> {
  const target = beginnerAiPreferencesFile()
  const temporary = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(temporary, target).catch(async (error) => {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
    })
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readBeginnerAiPreferences(): Promise<BeginnerAiPreferences> {
  const store = await readStoredBeginnerAiPreferences()
  const credentials = await readDeviceCredentials()
  return activeQuotaModelPreferences(store, credentials ? quotaModelCacheKey(credentials) : undefined)
}

async function saveBeginnerAiPreferences(value: BeginnerAiPreferences): Promise<BeginnerAiPreferences> {
  const model = typeof value?.model === 'string' ? value.model.trim().slice(0, 256) : ''
  if (!model) throw new Error('请选择制作使用的模型')
  const reasoningLevel = value.reasoningLevel === 'low' || value.reasoningLevel === 'high' || value.reasoningLevel === 'extreme'
    ? value.reasoningLevel
    : 'medium'
  const preferences = normalizeQuotaModelPreferences({ model, reasoningLevel, fastMode: Boolean(value.fastMode) }, DEFAULT_BEGINNER_AI_PREFERENCES)
  const previous = await readBeginnerAiPreferences()
  const credentials = await readDeviceCredentials()
  if (previous.fastMode !== preferences.fastMode) {
    if (!credentials) throw new Error('请先连接 ModMind 账号，再切换 Fast 模式')
    await sendDeviceFastMode(
      credentials.siteUrl,
      credentials.apiKey,
      preferences.fastMode,
      AbortSignal.timeout(15_000)
    )
  }
  const store = await readStoredBeginnerAiPreferences()
  await writeStoredBeginnerAiPreferences(updateQuotaModelPreferences(store, preferences, credentials ? quotaModelCacheKey(credentials) : undefined))
  return preferences
}

async function reconcileQuotaModelPreferences(credentials: DeviceCredentials, forceScan: boolean, scannedModels?: AiModelInfo[]): Promise<BeginnerAiPreferences> {
  const store = await readStoredBeginnerAiPreferences()
  const models = scannedModels ?? await quotaModelsForCredentials(credentials, forceScan)
  const resolved = resolveQuotaModelPreferences(store, quotaModelCacheKey(credentials), models)
  if (JSON.stringify(resolved.store) !== JSON.stringify(store)) await writeStoredBeginnerAiPreferences(resolved.store)
  diagnosticJournal.record({
    subsystem: 'device',
    operation: 'model-preference',
    phase: resolved.modelChanged ? 'fallback' : resolved.restored ? 'restored' : 'saved',
    level: resolved.modelChanged ? 'warning' : 'info',
    message: resolved.modelChanged
      ? `所选模型不可用，已自动切换到 ${resolved.preferences.model}`
      : resolved.restored ? `已恢复当前 Key 的模型偏好 ${resolved.preferences.model}` : `已保存当前 Key 的模型偏好 ${resolved.preferences.model}`,
    data: { model: resolved.preferences.model, availableModels: models.map((model) => model.id) }
  })
  return resolved.preferences
}

async function readBeginnerAgentServerConfig(): Promise<CodexServerConfig> {
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号')
  const preferences = await readBeginnerAiPreferences()
  return {
    baseUrl: openAiV1BaseUrl(credentials.baseUrl),
    apiKey: credentials.apiKey,
    model: preferences.model,
    reasoningEffort: beginnerReasoningEffort(preferences.model, preferences.reasoningLevel)
  }
}

const managedCodexPreparations = new Map<string, ReturnType<typeof prepareCodex>>()
const managedCodexPreparationListeners = new Map<string, Set<(progress: CodexSetupProgress) => void>>()
let managedCodexPreparationTail = Promise.resolve()

function managedCodexHome(project: ProjectInfo, sessionScope: string, serverConfig: CodexServerConfig): string {
  const scopeKey = createHash('sha256').update(sessionScope.trim() || 'workspace').digest('hex').slice(0, 20)
  const providerKey = createHash('sha256').update(`${serverConfig.baseUrl}\n${codexProviderIdentity(serverConfig)}`).digest('hex').slice(0, 20)
  return path.join(project.path, projectDataDirectory(project), 'external-agents', 'codex-homes', scopeKey, providerKey)
}

function codexProviderIdentity(config: Pick<CodexServerConfig, 'baseUrl' | 'apiKey' | 'model'>): string {
  return `${config.model}\n${createHash('sha256').update(config.apiKey).digest('hex')}`
}

function configuredCodexServerConfig(configuration: ExternalAgentConfiguration): CodexServerConfig {
  const apiKey = configuration.apiKey?.trim() ?? ''
  const baseUrl = normalizeApiBaseUrl(configuration.baseUrl ?? '')
  const model = configuration.model?.trim() ?? ''
  if (!apiKey || !model) throw new Error('Codex 配置缺少 API Key 或模型名')
  return { apiKey, baseUrl, model, reasoningEffort: configuration.reasoningEffort ?? 'high' }
}

async function prepareManagedCodex(
  project: ProjectInfo,
  sessionScope: string,
  serverConfig: CodexServerConfig,
  configSource: 'device' | 'local-settings',
  existingExecutable?: string,
  onProgress?: (progress: CodexSetupProgress) => void,
  signal?: AbortSignal
): ReturnType<typeof prepareCodex> {
  const home = managedCodexHome(project, sessionScope, serverConfig)
  const key = process.platform === 'win32' ? home.toLowerCase() : home
  const listeners = managedCodexPreparationListeners.get(key) ?? new Set<(progress: CodexSetupProgress) => void>()
  managedCodexPreparationListeners.set(key, listeners)
  if (onProgress) listeners.add(onProgress)
  if (!managedCodexPreparations.has(key)) {
    const previousPreparation = managedCodexPreparationTail
    let releasePreparation!: () => void
    managedCodexPreparationTail = new Promise<void>((resolve) => { releasePreparation = resolve })
    const preparation = (async () => {
      await previousPreparation
      try {
        return await prepareCodex({
          rootDir: app.getPath('userData'),
          homeDir: home,
          serverConfig: {
            ...serverConfig,
            baseUrl: await chatCompletionsAdapter.baseUrl(serverConfig.baseUrl, codexProviderIdentity(serverConfig))
          },
          configSource,
          existingExecutable: existingExecutable?.trim() || undefined,
          bundledSkillsDir: bundledCodexSkillsDirectory(),
          imageToolsEnabled: true,
          rememberPrepared: false,
          onProgress: (progress) => {
            for (const listener of listeners) listener(progress)
          }
        })
      } finally {
        releasePreparation()
      }
    })()
    managedCodexPreparations.set(key, preparation)
    const release = (): void => {
      if (managedCodexPreparations.get(key) === preparation) managedCodexPreparations.delete(key)
      if (!listeners.size) managedCodexPreparationListeners.delete(key)
    }
    void preparation.then(release, release)
  }
  const activePreparation = managedCodexPreparations.get(key)!
  const observedPreparation = signal ? awaitWithAbort(activePreparation, signal, 'Codex 准备已停止') : activePreparation
  return observedPreparation.finally(() => {
    if (onProgress) listeners.delete(onProgress)
    if (!listeners.size && !managedCodexPreparations.has(key)) managedCodexPreparationListeners.delete(key)
  })
}

async function prepareConfiguredCodex(
  project: ProjectInfo,
  sessionScope: string,
  configuration: ExternalAgentConfiguration,
  onProgress?: (progress: CodexSetupProgress) => void,
  signal?: AbortSignal
): ReturnType<typeof prepareCodex> {
  return prepareManagedCodex(
    project,
    sessionScope,
    configuredCodexServerConfig(configuration),
    'local-settings',
    undefined,
    onProgress,
    signal
  )
}

async function prepareQuotaCodex(project: ProjectInfo, sessionScope: string, onProgress?: (progress: CodexSetupProgress) => void, signal?: AbortSignal, override?: CodexServerConfig): ReturnType<typeof prepareCodex> {
  const serverConfig = override ?? (signal
    ? await awaitWithAbort(readBeginnerAgentServerConfig(), signal, 'Codex 准备已停止')
    : await readBeginnerAgentServerConfig())
  return prepareManagedCodex(project, sessionScope, serverConfig, 'device', undefined, onProgress, signal)
}

function externalAgentEnvironment(kind: ExternalAgentKind, configuration: ExternalAgentConfiguration, codexHome?: string): NodeJS.ProcessEnv {
  if (kind === 'claude' && configuration.mode !== 'hosted') return {}
  const apiKey = configuration.apiKey?.trim() ?? ''
  if (!apiKey) throw new Error('请先填写 API Key')
  const baseUrl = normalizeApiBaseUrl(configuration.baseUrl ?? '')
  const model = configuration.model?.trim() ?? ''
  if (!model) throw new Error('请先选择模型')
  if (kind === 'codex') {
    if (!codexHome) throw new Error('Codex 配置目录不可用')
    return {CODEX_HOME: codexHome, MODMIND_THIRD_PARTY_API_KEY: apiKey}
  }
  if (kind !== 'claude') return {}
  const claudeEffort = configuration.reasoningEffort === 'low' || configuration.reasoningEffort === 'medium' || configuration.reasoningEffort === 'high' || configuration.reasoningEffort === 'xhigh' || configuration.reasoningEffort === 'max'
    ? configuration.reasoningEffort
    : 'high'
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: claudeEffort
  }
}

async function configureExternalAgentProvider(kind: ExternalAgentKind, settings: AgentSettings): Promise<{kind: ExternalAgentKind; executable?: string; configPath?: string; detail: string}> {
  const configured = settings.externalAgents?.[kind] ?? {}
  if (kind === 'claude' && configured.mode !== 'hosted') {
    return {kind, executable: configured.executable, detail: 'Claude Code 将沿用本机登录状态和本机配置；ModMind 不写入全局 Claude 配置'}
  }
  if (!externalAgentSupportsHostedConfiguration(kind)) {
    return {kind, executable: configured.executable, detail: `${externalAgentLabel(kind)} 使用本机已有配置；ModMind 将在项目中准备 MCP 工具桥`}
  }
  if (!configured.apiKey?.trim()) throw new Error('请先填写 API Key')
  normalizeApiBaseUrl(configured.baseUrl ?? '')
  if (!configured.model?.trim()) throw new Error('请先选择模型')
  const executable = configured.executable
  if (kind === 'claude') {
    externalAgentEnvironment('claude', configured)
    return {kind, executable, detail: 'Claude Code 配置已保存，仅在 ModMind 启动的进程中生效'}
  }
  const managedExecutable = managedCodexExecutablePath(app.getPath('userData'))
  const detected = await detectExternalAgent('codex', {executables: [managedExecutable], includeDefaults: false})
  return {kind, executable: detected.executable || undefined, detail: 'Codex 配置已保存；将与智能额度共用 ModMind 托管运行时、协议适配和项目会话隔离流程'}
}

async function externalAgentRunEnvironment(kind: ExternalAgentKind, settings: AgentSettings): Promise<NodeJS.ProcessEnv | undefined> {
  const configured = settings.externalAgents?.[kind] ?? {}
  if (!configured.apiKey?.trim() || !externalAgentSupportsHostedConfiguration(kind)) return undefined
  if (kind === 'claude' && configured.mode !== 'hosted') return undefined
  if (kind === 'claude') return externalAgentEnvironment('claude', configured)
  return {MODMIND_THIRD_PARTY_API_KEY: configured.apiKey.trim()}
}

function applicationIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), 'resources', 'icon.ico')
}

function bundledCodexSkillsDirectory(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'codex-skills'), path.join(path.dirname(process.execPath), 'resources', 'codex-skills')]
    : [path.join(app.getAppPath(), 'resources', 'codex-skills'), path.join(process.resourcesPath, 'codex-skills')]
  return candidates.find((candidate) => {
    try {
      return readFileSync(path.join(candidate, 'minecraft-mod-development', 'SKILL.md'), 'utf8').length > 0
    } catch {
      return false
    }
  }) ?? candidates[0]
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function disposeBlockbenchBridge(): void {
  const bridge = blockbenchBridge
  blockbenchBridge = null
  try {
    bridge?.destroy()
  } catch {
    // Window shutdown must not surface a native-view cleanup error.
  }
}

function prepareForAppUpdateInstall(): void {
  quitRequested = true
  allowWindowClose = true
  closeRequestInFlight = false
  if (tray) {
    tray.destroy()
    tray = null
  }
  disposeBlockbenchBridge()
}

function quitFromTray(): void {
  if (quitRequested) return
  quitRequested = true
  allowWindowClose = true
  closeRequestInFlight = false
  if (tray) {
    tray.destroy()
    tray = null
  }
  disposeBlockbenchBridge()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
  app.quit()
  const forceExitTimer = setTimeout(() => app.exit(0), 750)
  forceExitTimer.unref()
}

function createTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(applicationIconPath()))
  tray.setToolTip('ModMind')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 ModMind', click: () => showMainWindow() },
    { label: '打开项目目录', enabled: Boolean(currentProject), click: () => { if (currentProject) void shell.openPath(currentProject.path) } },
    { type: 'separator' },
    { label: '打开设置', click: () => { showMainWindow(); mainWindow?.webContents.send('app:openSettings') } },
    { type: 'separator' },
    { label: '退出 ModMind', click: quitFromTray }
  ]))
  tray.on('click', () => showMainWindow())
}

function notifyUser(title: string, body: string): void {
  void readSettings().then((settings) => {
    if (!settings.notificationsEnabled || !Notification.isSupported()) return
    new Notification({ title, body, icon: applicationIconPath() }).show()
  }).catch(() => undefined)
}

async function saveClosePreferences(closeBehavior: AgentSettings['closeBehavior'], notificationsEnabled?: boolean): Promise<void> {
  const file = settingsFile()
  let stored: Record<string, unknown> = {}
  try { stored = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown> } catch { /* first launch */ }
  stored.closeBehavior = closeBehavior
  if (typeof notificationsEnabled === 'boolean') stored.notificationsEnabled = notificationsEnabled
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(stored, null, 2), 'utf8')
}

async function handleWindowClose(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (closeRequestInFlight) return
  closeRequestInFlight = true
  const settings = await readSettings()
  let behavior = settings.closeBehavior
  if (behavior === 'ask') {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '关闭 ModMind',
      message: '你希望如何处理 ModMind？',
      detail: '最小化到系统托盘后，任务仍可继续运行；直接关闭会退出应用',
      buttons: ['最小化到系统托盘', '直接关闭', '取消'],
      cancelId: 2,
      defaultId: 0,
      checkboxLabel: '不再提示，记住我的选择'
    })
    if (result.response === 2) { closeRequestInFlight = false; return }
    behavior = result.response === 0 ? 'tray' : 'quit'
    if (result.checkboxChecked) await saveClosePreferences(behavior)
  }
  if (behavior === 'tray') {
    createTray()
    mainWindow.hide()
    closeRequestInFlight = false
    return
  }
  await workbenchDataStore.flush()
  allowWindowClose = true
  mainWindow.close()
  closeRequestInFlight = false
}

function loadDetachedRenderer(window: BrowserWindow, target: DetachedWindowTarget): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('detached', '1')
    if (target.startsWith('group:')) url.searchParams.set('group', target.slice('group:'.length))
    else url.searchParams.set('view', target)
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { detached: '1', ...(target.startsWith('group:') ? { group: target.slice('group:'.length) } : { view: target }) } })
}

function pluginOverlayWindowState(pluginId: string): PluginOverlayWindowState {
  const window = pluginOverlayWindows.get(pluginId)
  if (!window || window.isDestroyed()) return { pluginId, open: false, alwaysOnTop: false }
  return { pluginId, open: true, alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds() }
}

function pluginOverlayWindowStates(): PluginOverlayWindowState[] {
  return [...pluginOverlayWindows.keys()].map(pluginOverlayWindowState).filter((state) => state.open)
}

function broadcastPluginOverlayWindows(): void {
  const states = pluginOverlayWindowStates()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('plugins:overlayWindowsChanged', states)
  }
}

function loadPluginOverlayRenderer(window: BrowserWindow, pluginId: string): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('pluginOverlay', pluginId)
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { pluginOverlay: pluginId } })
}

function createPluginOverlayWindow(pluginId: string): BrowserWindow {
  const existing = pluginOverlayWindows.get(pluginId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  const record = getPluginService()?.getEnabledPlugin(pluginId)
  const overlay = record?.manifest.overlay
  if (!record || !overlay) throw new Error(`插件 ${pluginId} 没有可用悬浮界面`)

  const width = overlay.width ?? (overlay.mode === 'pet' ? 220 : 360)
  const height = overlay.height ?? (overlay.mode === 'pet' ? 280 : 300)
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const window = new BrowserWindow({
    x: workArea.x + Math.max(0, workArea.width - width - 24),
    y: workArea.y + Math.max(0, workArea.height - height - 24),
    width,
    height,
    minWidth: overlay.minWidth ?? 120,
    minHeight: overlay.minHeight ?? 100,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: overlay.resizable !== false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: overlay.mode !== 'pet',
    alwaysOnTop: overlay.alwaysOnTop === true,
    title: record.manifest.name,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  pluginOverlayWindows.set(pluginId, window)
  window.setMenuBarVisibility(false)
  if (overlay.alwaysOnTop) window.setAlwaysOnTop(true, 'floating')
  window.on('ready-to-show', () => {
    window.show()
    broadcastPluginOverlayWindows()
  })
  window.on('closed', () => {
    if (pluginOverlayWindows.get(pluginId) === window) pluginOverlayWindows.delete(pluginId)
    broadcastPluginOverlayWindows()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    getPluginRuntime()?.recordLog(pluginId, 'overlay', 'error', `悬浮窗口进程退出：${details.reason}`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    getPluginRuntime()?.recordLog(pluginId, 'overlay', 'error', `悬浮窗口加载失败：${errorDescription} (${validatedURL})`)
  })
  loadPluginOverlayRenderer(window, pluginId)
  broadcastPluginOverlayWindows()
  return window
}

function reconcilePluginOverlayWindows(snapshot: PluginSnapshot): void {
  const available = new Set(snapshot.plugins
    .filter((plugin) => plugin.enabled && !plugin.error && plugin.manifest.overlay)
    .map((plugin) => plugin.manifest.id))
  for (const [pluginId, window] of pluginOverlayWindows) {
    if (!available.has(pluginId) && !window.isDestroyed()) window.close()
  }
}

function createDetachedWindow(target: DetachedWindowTarget, rawTitle: string): BrowserWindow {
  const existing = detachedWindows.get(target)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const title = rawTitle.trim().slice(0, 80) || 'ModMind'
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 680,
    minHeight: 460,
    show: false,
    frame: false,
    title: `${title} - ModMind`,
    backgroundColor: '#f5f5f7',
    icon: applicationIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  detachedWindows.set(target, window)
  window.on('ready-to-show', () => window.show())
  window.on('unresponsive', () => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'detached-window', phase: 'unresponsive', level: 'error', message: `Detached window became unresponsive: ${target}`, data: { target } })
  })
  window.on('responsive', () => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'detached-window', phase: 'responsive', message: `Detached window became responsive again: ${target}`, data: { target } })
  })
  window.on('closed', () => {
    if (detachedWindows.get(target) === window) detachedWindows.delete(target)
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:detachedClosed', target)
    }
    for (const candidate of detachedWindows.values()) {
      if (!candidate.isDestroyed() && !candidate.webContents.isDestroyed()) candidate.webContents.send('window:detachedClosed', target)
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'detached-process', phase: 'gone', level: 'error', message: `Detached renderer process exited: ${details.reason}`, data: { target, ...details } })
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'detached-load', phase: 'error', level: 'error', message: errorDescription, data: { target, errorCode, validatedURL } })
  })
  loadDetachedRenderer(window, target)
  return window
}

function isDetachedWindow(window: BrowserWindow | null | undefined): boolean {
  return Boolean(window && [...detachedWindows.values()].includes(window))
}

function createWindow(): void {
  const iconPath = applicationIconPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#f5f5f7',
    titleBarStyle: 'hidden',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Explicitly apply the ICO to the native window so the Windows taskbar
  // uses the ModMind icon in development and packaged builds alike.
  mainWindow.setIcon(nativeImage.createFromPath(iconPath))

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('unresponsive', () => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'window', phase: 'unresponsive', level: 'error', message: 'Main window became unresponsive' })
  })
  mainWindow.on('responsive', () => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'window', phase: 'responsive', message: 'Main window became responsive again' })
  })
  mainWindow.on('close', (event) => {
    if (allowWindowClose || quitRequested) {
      disposeBlockbenchBridge()
      return
    }
    event.preventDefault()
    void handleWindowClose()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'process', phase: 'gone', level: 'error', message: `Renderer process exited: ${details.reason}`, data: details })
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'load', phase: 'error', level: 'error', message: errorDescription, data: { errorCode, validatedURL } })
  })

  const blockbenchEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'blockbench', 'index.html')
    : path.join(app.getAppPath(), 'vendor', 'blockbench', 'index.html')
  blockbenchBridge = new BlockbenchBridge({
    window: mainWindow,
    entryPath: blockbenchEntry,
    getProjectRoot: () => currentProject?.path ?? null
  })
  minecraftRuntime = new MinecraftRuntimeManager({
    getProject: () => aiProjectContext.getStore() ?? currentProject,
    onState: (state) => mainWindow?.webContents.send('minecraft:state', state),
    onEvent: forwardMinecraftRuntimeEvent,
    authorizeBuild: ensureProjectBuildTrusted,
    getGradleDownloadSource: async () => (await readSettings()).gradleDownloadSource ?? 'auto',
    getJavaPreference: async () => (await readSettings()).javaPreferences,
    prepareProjectDependencies: async (project, signal) => {
      if (project.kind === 'modpack' || !isJavaLoader(project.loader)) return
      await requireAddonRelationshipService().refreshLinkedProjects((linked) => buildLinkedProjectTree(linked, signal, [project.path]), [project.path])
    }
  })
  localServerManager = new LocalServerManager({
    getProject: () => currentProject,
    getJavaPath: () => requireMinecraftRuntime().ensureJavaRuntime(),
    onState: (state) => mainWindow?.webContents.send('local-server:state', state),
    onEvent: (event) => {
      diagnosticJournal.record({ subsystem: 'local-server', operation: event.stage, phase: event.level === 'error' ? 'error' : 'event', level: event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'info', message: event.message })
      mainWindow?.webContents.send('local-server:event', event)
    }
  })
  headlessMcService = new HeadlessMcService({
    userDataDirectory: app.getPath('userData'),
    onEvent: forwardMinecraftRuntimeEvent
  })
  blockbenchBridge.onStatus((status) => {
    diagnosticJournal.record({ subsystem: 'blockbench', operation: 'bridge', phase: status.phase, level: status.phase === 'error' ? 'error' : 'info', message: status.message || `Blockbench bridge: ${status.phase}`, data: status })
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow?.webContents.send('blockbench:state', {
      ...status,
      status: status.phase,
      connected: status.phase === 'ready'
    })
  })
  const blockbenchLoad = blockbenchBridge.load()
  void blockbenchLoad.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow?.webContents.send('blockbench:state', { status: 'error', connected: false, message })
  })
  imageStudioService = new ImageStudioService({
    userDataDir: app.getPath('userData'),
    projectRoot: () => currentProject?.path ?? null,
    getHostedLease: createHostedImageLease
  })
  mainWindow.on('closed', () => {
    for (const window of detachedWindows.values()) window.close()
    detachedWindows.clear()
    for (const window of pluginOverlayWindows.values()) window.close()
    pluginOverlayWindows.clear()
    deviceAuthorizationController?.abort()
    deviceAuthorizationController = null
    void stopRemoteClient()
    for (const controller of aiAbortControllers.values()) controller.abort()
    aiAbortControllers.clear()
    activeAiRuns.clear()
    disposeBlockbenchBridge()
    void localServerManager?.destroy()
    localServerManager = null
    minecraftRuntime?.destroy()
    minecraftRuntime = null
    void headlessMcService?.stop()
    headlessMcService = null
    imageStudioService = null
    if (tray) {
      tray.destroy()
      tray = null
    }
    mainWindow = null
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function slugify(value: string): string {
  let normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) {
    // Minecraft namespaces are ASCII identifiers. Preserve a stable link to
    // non-Latin project names instead of assigning every project `my_mod`.
    let hash = 2166136261
    for (const character of value.trim()) {
      hash ^= character.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619)
    }
    normalized = `mod_${(hash >>> 0).toString(36)}`
  }
  if (!/^[a-z]/.test(normalized)) normalized = `mod_${normalized}`
  normalized = normalized.slice(0, 64).replace(/_+$/g, '')
  if (normalized.length < 2) normalized = `${normalized}_mod`
  return normalized
}

function requireProject(): ProjectInfo {
  const taskProject = aiProjectContext.getStore()
  if (taskProject) return taskProject
  if (!currentProject) throw new Error('Please create or open a project first')
  return currentProject
}

function requireBlockbench(): BlockbenchBridge {
  if (!blockbenchBridge) throw new Error('Blockbench bridge is not available')
  return blockbenchBridge
}

function requireBlockbenchForProject(project: ProjectInfo): BlockbenchBridge {
  if (!currentProject || !sameProjectPath(currentProject.path, project.path)) {
    throw new Error('Blockbench 当前属于另一个前台项目；请切回任务项目后重试该操作')
  }
  return requireBlockbench()
}

async function previewAssetIntentCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> {
  const candidate = compileAssetIntent(input)
  if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
  const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision)
  return {
    ...candidate,
    execution: preview.execution,
    validation: preview.validation,
    ...preview.capture
  }
}

async function compileAssetRefinementForBridge(bridge: BlockbenchBridge, input: unknown): Promise<ReturnType<typeof compileAssetRefinement>> {
  return compileAssetRefinement(input, await bridge.getProjectState())
}

async function previewAssetRefinementCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> {
  const candidate = await compileAssetRefinementForBridge(bridge, input)
  if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
  if (expectedRevision && candidate.baseRevision !== expectedRevision) throw new Error(`Blockbench project changed since the refinement was requested (expected ${expectedRevision}, current ${candidate.baseRevision})`)
  const preview = await bridge.previewRefinementActions(candidate.actions, capture, signal, candidate.baseRevision)
  return {
    ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
    baselineCaptures: preview.baselineCapture.captures, diff: preview.diff
  }
}

async function applyAssetRefinementCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> {
  const candidate = await compileAssetRefinementForBridge(bridge, input)
  if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
  if (expectedRevision && candidate.baseRevision !== expectedRevision) {
    throw new Error(`Blockbench project changed since the refinement was requested (expected ${expectedRevision}, current ${candidate.baseRevision})`)
  }
  const execution = await bridge.executeActions(candidate.actions, signal, candidate.baseRevision)
  return {...candidate, execution}
}

async function previewAdvancedAssetComparison(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  options: AdvancedAssetPreviewOptions = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetComparison> {
  const maxIterations = Math.max(1, Math.min(3, Number(options.maxIterations ?? 3)))
  const targetScore = Math.max(0, Math.min(100, Number(options.targetScore ?? 82)))
  const compiled = compileAdvancedAssetVariants(input)
  const errors = compiled.flatMap((candidate) => candidate.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'))
  if (errors.length) throw new Error(errors.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; '))
  const previews: AdvancedAssetCandidatePreview[] = []
  for (const original of compiled) {
    let current = original
    let best = await previewAdvancedCandidate(bridge, current, capture, 1, signal, expectedRevision)
    for (let iteration = 2; iteration <= maxIterations && best.review.score < targetScore; iteration += 1) {
      const mode = best.review.metrics.contrast < 0.25
        ? 'contrast'
        : best.review.metrics.occupancy < 0.18
          ? 'occupancy-up'
          : 'occupancy-down'
      const optimizedProgram = optimizeAdvancedProgram(current.program, mode)
      const optimized = compileAdvancedAsset(optimizedProgram)
      current = {...optimized, variantId: original.variantId, label: original.label}
      const preview = await previewAdvancedCandidate(bridge, current, capture, iteration, signal, expectedRevision)
      if (preview.review.score > best.review.score) best = preview
    }
    previews.push(best)
  }
  previews.sort((left, right) => right.review.score - left.review.score)
  return {comparisonVersion: 1, selectedCandidateId: previews[0].variantId, candidates: previews}
}

async function previewAdvancedCandidate(
  bridge: BlockbenchBridge,
  candidate: AdvancedAssetCandidate,
  capture: BlockbenchCaptureRequest,
  iteration: number,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetCandidatePreview> {
  const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision)
  const review = await reviewAssetCaptures(preview.capture.captures)
  return {
    ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
    review, iteration, actionDiff: describeBlockbenchActions(candidate.actions)
  }
}

async function previewReferenceImageCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetCandidatePreview & {reference: Awaited<ReturnType<typeof compileReferenceImageAsset>>['reference']}> {
  const candidate = await compileReferenceImageAsset(input)
  const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision)
  const review = await reviewAssetCaptures(preview.capture.captures)
  return {
    ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
    review, iteration: 1, actionDiff: describeBlockbenchActions(candidate.actions)
  }
}

function requireMinecraftRuntime(): MinecraftRuntimeManager {
  if (!minecraftRuntime) throw new Error('Minecraft runtime manager is not available')
  return minecraftRuntime
}

let minecraftResourceTail = Promise.resolve()
const minecraftResourceContext = new AsyncLocalStorage<boolean>()

async function withMinecraftResourceLock<T>(operation: () => Promise<T>): Promise<T> {
  if (minecraftResourceContext.getStore()) return operation()
  const previous = minecraftResourceTail
  let release!: () => void
  minecraftResourceTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await minecraftResourceContext.run(true, operation)
  } finally {
    release()
  }
}

function buildProjectWithLock(signal?: AbortSignal): Promise<MinecraftManagedMod> {
  return withMinecraftResourceLock(() => requireMinecraftRuntime().buildProject(signal))
}

async function renameProjectRecord(project: ProjectInfo, input: ProjectRenameInput): Promise<ProjectInfo> {
  assertProjectMutationAllowed(project.path, '重命名')
  if (!input || typeof input.name !== 'string' || typeof input.namespace !== 'string') throw new Error('项目重命名参数无效')
  const name = validateProjectNameInput(input.name)
  if (!input.namespace.trim()) throw new Error('命名空间不能为空')
  const namespace = slugify(input.namespace)
  const nextProject: ProjectInfo = { ...project, name, namespace }
  if (nextProject.name === project.name && nextProject.namespace === project.namespace) return project

  await renameProjectFiles(project, nextProject, [currentProjectManifest])
  const manifestPath = path.join(project.path, projectManifest(project))
  const temporary = `${manifestPath}.tmp-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(nextProject, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, manifestPath)
  if (currentProject && sameProjectPath(currentProject.path, project.path)) currentProject = nextProject
  await rememberRecentProject(nextProject)
  await refreshExternalAgentContext(nextProject).catch(() => undefined)
  return nextProject
}

function requireHeadlessMc(): HeadlessMcService {
  if (!headlessMcService) throw new Error('HeadlessMC 服务不可用')
  return headlessMcService
}

function resolveProjectPath(relativePath: string): string {
  return resolveProjectPathFor(requireProject(), relativePath)
}

function resolveProjectPathFor(project: ProjectInfo, relativePath: string): string {
  const root = path.resolve(project.path)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Access outside the project directory is not allowed')
  }
  return target
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function copyBundledGradleWrapper(projectRoot: string): Promise<void> {
  const wrapperRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'gradle-wrapper')
    : path.join(app.getAppPath(), 'vendor', 'gradle-wrapper')
  const wrapperFiles = [
    { source: 'gradlew', target: 'gradlew', sha256: 'b2fe376b143a459ba5d0bd290dc89beed5399fc6d159cd1214bd642ea94bcf07' },
    { source: 'gradlew.bat', target: 'gradlew.bat', sha256: '9386e790d58b9368ca8e034536a5baa688643d51cb37bfa462503d36fd0291a6' },
    { source: 'gradle-wrapper.jar', target: 'gradle/wrapper/gradle-wrapper.jar', sha256: '423cb469ccc0ecc31f0e4e1c309976198ccb734cdcbb7029d4bda0f18f57e8d9' }
  ]
  for (const entry of wrapperFiles) {
    const bytes = await fs.readFile(path.join(wrapperRoot, entry.source))
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Bundled Gradle Wrapper asset failed verification: ${entry.source}`)
    }
    const target = path.join(projectRoot, ...entry.target.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes)
  }
  if (process.platform !== 'win32') await fs.chmod(path.join(projectRoot, 'gradlew'), 0o755)
}

function requireImageStudio(): ImageStudioService {
  if (!imageStudioService) throw new Error('图像工坊服务尚未准备好')
  return imageStudioService
}

function normalizeAgentImageRequest(input: unknown): ImageGenerationRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const style = value.style === 'free' ? 'free' : 'minecraft'
  const quality = value.quality === 'low' || value.quality === 'high' || value.quality === 'auto' ? value.quality : 'medium'
  const moderation = value.moderation === 'low' ? 'low' : 'auto'
  const count = Math.min(Math.max(Number(value.count ?? 1) || 1, 1), 10)
  return {
    prompt: String(value.prompt ?? '').trim().slice(0, 32_000),
    style,
    size: typeof value.size === 'string' && value.size.trim() ? value.size.trim() : '1024x1024',
    quality,
    moderation,
    count,
    background: 'solid',
    backgroundColor: typeof value.backgroundColor === 'string' ? value.backgroundColor.slice(0, 16) : '#ffffff',
    removeBackground: Boolean(value.removeBackground),
    source: 'agent',
    ...(typeof value.referenceImage === 'string' && value.referenceImage.startsWith('data:image/') ? { referenceImage: value.referenceImage } : {})
  }
}

async function createHostedImageLease(request: ImageGenerationRequest): Promise<{ baseUrl: string; apiKey: string; model: string; jobId: string; reservedCredits: number }> {
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号，或在专业设置中保存图片 API Key')
  const timestamp = new Date().toISOString()
  const response = await fetch(`${credentials.siteUrl}/api/device/image-lease`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ username: credentials.username, timestamp }),
    signal: AbortSignal.timeout(20_000)
  })
  const payload = await response.json().catch(() => null) as { data?: Record<string, unknown>; message?: string; error?: string; apiKey?: unknown; baseUrl?: unknown; model?: unknown } | null
  if (!response.ok) throw new Error(typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : `托管图片授权接口不可用（HTTP ${response.status}）`)
  const data = payload?.data ?? payload ?? {}
  const baseUrl = typeof data.baseUrl === 'string' ? normalizeRelayBaseUrl(data.baseUrl) : ''
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : IMAGE_DEFAULT_MODEL
  const jobId = randomUUID()
  const reservedCredits = Math.max(1, request.count)
  if (!baseUrl || !apiKey) throw new Error('托管图片授权响应缺少临时 Key 或 Base URL')
  return { baseUrl, apiKey, model, jobId, reservedCredits }
}

async function writeProjectTemplate(project: ProjectInfo, includeStarter = true): Promise<void> {
  const files = projectTemplateFiles(project, includeStarter)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const target = path.join(project.path, relativePath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
    })
  )
  if (isJavaLoader(project.loader)) await copyBundledGradleWrapper(project.path)
}

async function readProjectInfo(root: string): Promise<ProjectInfo | null> {
  const currentPath = path.join(root, currentProjectManifest)
  if (!await pathExists(currentPath)) return null
  const content = await fs.readFile(currentPath, 'utf8')
  const parsed = JSON.parse(content) as ProjectInfo
  return { ...parsed, name: normalizeProjectName(parsed.name), path: root, toolDataDirectory: '.modmind' }
}

async function offerProjectVersionMigration(project: ProjectInfo): Promise<ProjectInfo> {
  if (await detectedProjectVersion(project) !== MIGRATABLE_PROJECT_VERSION) return project
  const choice = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: '项目模板需要迁移',
    message: `检测到 ModMind ${MIGRATABLE_PROJECT_VERSION} 项目`,
    detail: `旧版 Gradle 和 Loader 模板可能无法构建。可以自动备份原配置并迁移到 ${CURRENT_PROJECT_VERSION}；源码和自定义入口不会被覆盖`,
    buttons: [`自动迁移到 ${CURRENT_PROJECT_VERSION}`, '暂不迁移'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (choice.response !== 0) return project
  let migrationProject = project
  if (project.loader === 'quilt' && !project.qslVersion) {
    const compatibility = await requireLoaderCatalog().resolve(project.loader, project.minecraftVersion)
    migrationProject = { ...project, qslVersion: compatibility.qslVersion }
  }
  const result = await migrateProjectVersion112(migrationProject, copyBundledGradleWrapper)
  await dialog.showMessageBox(mainWindow!, {
    type: 'info',
    title: '项目迁移完成',
    message: `项目已迁移到 ModMind ${CURRENT_PROJECT_VERSION}`,
    detail: `旧配置已备份到 ${path.relative(project.path, result.backupDirectory)}`,
    buttons: ['确定']
  })
  return result.project
}

const externalProjectIgnoredDirectories = new Set(['node_modules', '.git', '.gradle', '.idea', '.vscode', 'build', 'out', 'run', 'logs', 'target'])
const externalSourceExtensions = new Set(['.java', '.kt', '.scala', '.groovy'])
const externalDocumentExtensions = new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.docx', '.yaml', '.yml', '.xml'])
const importableReferenceExtensions = new Set([...externalSourceExtensions, ...externalDocumentExtensions, '.json', '.toml', '.properties', '.gradle', '.kts', '.mcmeta'])

async function scanExternalFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const queue = [{ directory: root, relative: '', depth: 0 }]
  let cursor = 0
  while (cursor < queue.length && cursor < 4000 && files.length < 6000) {
    const current = queue[cursor++]
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = path.posix.join(current.relative, entry.name)
      if (entry.isDirectory()) {
        if (current.depth >= 10 || externalProjectIgnoredDirectories.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue
        queue.push({ directory: path.join(current.directory, entry.name), relative, depth: current.depth + 1 })
      } else if (entry.isFile()) files.push(relative)
    }
  }
  return files
}

async function analyzeExistingProject(sourcePath: string): Promise<{ analysis: ExistingProjectAnalysis; files: string[] }> {
  const root = path.resolve(sourcePath)
  const existing = await readProjectInfo(root).catch(() => null)
  if (existing) throw new Error('This folder is already a ModMind project. Open it directly.')
  const externalModpack = await inspectExternalModpack(root)
  if (externalModpack) {
    const existingPack = await readProjectInfo(externalModpack.root).catch(() => null)
    if (existingPack) throw new Error('This folder is already a ModMind project. Open it directly.')
    const files = await scanExternalFiles(externalModpack.root)
    const name = externalModpack.name ?? path.basename(externalModpack.root)
    const loader = externalModpack.loader ?? 'fabric'
    const minecraftVersion = externalModpack.minecraftVersion ?? '1.21.1'
    const formatLabel: Record<typeof externalModpack.format, string> = {
      workspace: 'ModMind 工作区', instance: 'Minecraft 实例', prism: 'Prism Launcher 实例', multimc: 'MultiMC 实例',
      curseforge: 'CurseForge 整合包', modrinth: 'Modrinth 整合包', hmcl: 'HMCL 实例', pcl: 'PCL 实例'
    }
    const reasons = [
      externalModpack.layout === 'archive'
        ? `已识别 ${formatLabel[externalModpack.format]} 归档布局；将保留 overrides/ 中的配置、资源和本地 Mod`
        : `已识别 ${formatLabel[externalModpack.format]}，将以实例布局原地接管，不移动 mods、config 或 kubejs`,
      `检测到 ${externalModpack.localModFiles.length} 个本地 Mod、${externalModpack.overrideFiles.length} 个配置或资源文件`,
      ...externalModpack.warnings
    ]
    return {
      files,
      analysis: {
        sourcePath: externalModpack.root,
        sourceName: name,
        kind: 'modpack',
        fileCount: files.length,
        sourceFileCount: 0,
        documentCount: 0,
        detectedFiles: [...externalModpack.localModFiles, ...externalModpack.overrideFiles].slice(0, 20),
        reasons,
        inferred: { name, loader, minecraftVersion, namespace: slugify(name), kind: 'modpack' },
        modpack: {
          format: externalModpack.format,
          layout: externalModpack.layout,
          loaderVersion: externalModpack.loaderVersion,
          modCount: externalModpack.localModFiles.length + externalModpack.remoteFiles.filter((entry) => /^mods\/[^/]+\.jar$/i.test(entry.path)).length,
          overrideCount: externalModpack.overrideFiles.length,
          unresolvedDependencyCount: externalModpack.unresolvedDependencyCount
        }
      }
    }
  }
  const files = await scanExternalFiles(root)
  if (!files.length) throw new Error('The selected folder is empty.')
  const lowerFiles = files.map((file) => file.toLowerCase())
  const buildFiles = files.filter((file) => ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'gradle.properties'].includes(file.toLowerCase()))
  const sourceFiles = files.filter((file) => externalSourceExtensions.has(path.extname(file).toLowerCase()))
  const documentFiles = files.filter((file) => externalDocumentExtensions.has(path.extname(file).toLowerCase()))
  const descriptor = files.find((file) => /(?:^|\/)(?:fabric\.mod\.json|quilt\.mod\.json|mods\.toml|neoforge\.mods\.toml)$/i.test(file))
  const notable = files.filter((file) => buildFiles.includes(file) || file === descriptor || sourceFiles.includes(file)).slice(0, 20)
  const hasSourceRoot = lowerFiles.some((file) => file.startsWith('src/main/'))
  const complete = buildFiles.length > 0 && sourceFiles.length > 0 && hasSourceRoot && Boolean(descriptor)
  const kind: ExistingProjectAnalysis['kind'] = complete ? 'complete' : sourceFiles.length > 0 || buildFiles.length > 0 ? 'partial' : 'api-docs'
  if (kind === 'api-docs' && !documentFiles.length && !files.some((file) => ['.json', '.toml'].includes(path.extname(file).toLowerCase()))) {
    throw new Error('No recognizable source code or API documentation was found')
  }

  let loader: ProjectCreateInput['loader'] = descriptor && /neoforge\.mods\.toml$/i.test(descriptor)
    ? 'neoforge'
    : descriptor && /quilt\.mod\.json$/i.test(descriptor) ? 'quilt'
      : descriptor && /mods\.toml$/i.test(descriptor) ? 'forge' : 'fabric'
  let name = path.basename(root)
  let namespace = slugify(name)
  let minecraftVersion = '1.21.1'
  const importantTextFiles = [...new Set([...buildFiles, ...(descriptor ? [descriptor] : []), ...(files.includes('.build-target-props.json') ? ['.build-target-props.json'] : [])])]
  const importantContents: Array<{ path: string; content: string }> = []
  for (const relative of importantTextFiles) {
    const content = await fs.readFile(path.join(root, ...relative.split('/')), 'utf8').catch(() => '')
    if (content) importantContents.push({ path: relative, content })
  }
  const gradlePropertiesFile = importantContents.find((entry) => /(?:^|\/)gradle\.properties$/i.test(entry.path))
  const properties = gradlePropertiesFile ? parseGradleProperties(gradlePropertiesFile.content) : {}
  const detectedLoader = inferGradleLoader(importantContents, descriptor)
  loader = detectedLoader.loader
  if (properties.mod_name && !properties.mod_name.includes('${')) name = properties.mod_name.trim()
  if (properties.mod_id && !properties.mod_id.includes('${')) namespace = slugify(properties.mod_id)
  const explicitMinecraftVersion = properties.minecraft_version ?? properties.parchment_minecraft_version
  if (explicitMinecraftVersion) minecraftVersion = extractMinecraftVersion(explicitMinecraftVersion) ?? minecraftVersion
  for (const { path: relative, content } of importantContents) {
    if (!content) continue
    if (!explicitMinecraftVersion) minecraftVersion = extractMinecraftVersion(content) ?? minecraftVersion
    if (/fabric\.mod\.json$/i.test(relative)) {
      try {
        const manifest = JSON.parse(content) as { id?: unknown; name?: unknown; depends?: { minecraft?: unknown } }
        if (typeof manifest.id === 'string') namespace = slugify(manifest.id)
        if (typeof manifest.name === 'string' && manifest.name.trim()) name = manifest.name.trim()
        const dependency = manifest.depends?.minecraft
        const dependencyText = Array.isArray(dependency) ? dependency.join(' ') : typeof dependency === 'string' ? dependency : ''
        minecraftVersion = extractMinecraftVersion(dependencyText) ?? minecraftVersion
      } catch {
        // Keep filename-based inference when the descriptor is malformed.
      }
    } else if (/quilt\.mod\.json$/i.test(relative)) {
      try {
        const manifest = JSON.parse(content) as {
          quilt_loader?: { id?: unknown; metadata?: { name?: unknown }; depends?: Array<{ id?: unknown; versions?: unknown }> }
        }
        const quilt = manifest.quilt_loader
        if (typeof quilt?.id === 'string') namespace = slugify(quilt.id)
        if (typeof quilt?.metadata?.name === 'string' && quilt.metadata.name.trim()) name = quilt.metadata.name.trim()
        const minecraft = quilt?.depends?.find((entry) => entry.id === 'minecraft')?.versions
        const dependencyText = Array.isArray(minecraft) ? minecraft.join(' ') : typeof minecraft === 'string' ? minecraft : ''
        minecraftVersion = extractMinecraftVersion(dependencyText) ?? minecraftVersion
      } catch {
        // Keep filename-based inference when the descriptor is malformed.
      }
    } else if (/mods\.toml$/i.test(relative)) {
      const descriptorId = content.match(/modId\s*=\s*["']([^"']+)/i)?.[1]
      const descriptorName = content.match(/displayName\s*=\s*["']([^"']+)/i)?.[1]?.trim()
      if (descriptorId && !descriptorId.includes('${')) namespace = slugify(descriptorId)
      if (descriptorName && !descriptorName.includes('${')) name = descriptorName
    }
  }

  const reasons = kind === 'complete' ? ['Complete project detected; ModMind metadata will be added in place.'] : kind === 'partial' ? ['The source or build structure is incomplete.', 'A new buildable project will be created with references copied to docs/imported-source.'] : ['No buildable source was detected; the content appears to be API documentation.', 'A new buildable project will be created with references copied to docs/imported-api.']
  return {
    files,
    analysis: {
      sourcePath: root,
      sourceName: path.basename(root),
      kind,
      fileCount: files.length,
      sourceFileCount: sourceFiles.length,
      documentCount: documentFiles.length,
      detectedFiles: notable,
      reasons,
      inferred: { name, loader, minecraftVersion, namespace, ...(detectedLoader.loaderVersion ? { loaderVersion: detectedLoader.loaderVersion } : {}) }
    }
  }
}

interface ExternalModpackAdoptionContext {
  sourcePath: string
  projectPath: string
  isTemporaryImport: boolean
  name: string
  namespace: string
  minecraftVersion: string
  loader: ExistingProjectAdoptInput['loader']
}

function modpackAdoptionProgressDetail(progress: {
  path: string
  fileIndex: number
  fileCount: number
  phase: 'checking' | 'downloading' | 'completed'
  sourceLabel?: string
  attempt?: number
  attemptsPerSource?: number
}): string {
  const file = path.basename(progress.path)
  const position = `${progress.fileIndex}/${progress.fileCount}`
  if (progress.phase === 'checking') return `正在校验 ${position} · ${file}`
  if (progress.phase === 'completed') return `已完成 ${position} · ${file}`
  const attempt = progress.attempt && progress.attemptsPerSource
    ? ` · 第 ${progress.attempt}/${progress.attemptsPerSource} 次尝试`
    : ''
  return `正在下载 ${position} · ${file}${progress.sourceLabel ? ` · ${progress.sourceLabel}` : ''}${attempt}`
}

async function performExternalModpackAdoption(context: ExternalModpackAdoptionContext, activityId: string): Promise<ProjectInfo> {
  assertProjectSwitchAllowed()
  downloadActivities.update(activityId, { detail: '正在重新读取并校验整合包清单', downloadedBytes: 0 })
  const refreshed = await analyzeExistingProject(context.sourcePath)
  if (refreshed.analysis.kind !== 'modpack') throw new Error('整合包来源已变更，请重新选择')
  const imported = await inspectExternalModpack(refreshed.analysis.sourcePath)
  if (!imported) throw new Error('整合包来源已变更，请重新选择')

  downloadActivities.update(activityId, { detail: '正在重新解析 Minecraft 与 Loader 兼容信息' })
  const compatibility = await requireLoaderCatalog().resolve(context.loader, context.minecraftVersion)
  const project: ProjectInfo = {
    kind: 'modpack',
    name: context.name,
    path: context.projectPath,
    loader: context.loader,
    minecraftVersion: context.minecraftVersion,
    namespace: context.namespace,
    createdAt: new Date().toISOString(),
    loaderVersion: imported.loader === context.loader && imported.minecraftVersion === context.minecraftVersion
      ? imported.loaderVersion ?? compatibility.loaderVersion
      : compatibility.loaderVersion,
    apiVersion: compatibility.apiVersion,
    qslVersion: compatibility.qslVersion,
    javaVersion: compatibility.javaVersion,
    projectVersion: CURRENT_PROJECT_VERSION,
    toolDataDirectory: '.modmind'
  }

  let createdTemporaryDestination = false
  try {
    if (context.isTemporaryImport) {
      if (await pathExists(context.projectPath)) throw new Error('目标项目目录已经存在，请移除未完成目录后重试')
      await fs.mkdir(context.projectPath, { recursive: true })
      createdTemporaryDestination = true
    }
    const materialized = await materializeExternalModpack(imported, context.projectPath, {
      trackDownloadActivities: false,
      onProgress: (progress) => downloadActivities.update(activityId, { detail: modpackAdoptionProgressDetail(progress) })
    })
    downloadActivities.update(activityId, { detail: '正在写入 ModMind 项目元数据' })
    await fs.writeFile(path.join(context.projectPath, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
    await fs.mkdir(path.join(context.projectPath, '.modmind'), { recursive: true })
    await adoptExternalModpack(project, {
      format: imported.format,
      layout: imported.layout,
      importedAt: new Date().toISOString(),
      ...(materialized.unresolvedDependencyCount ? { unresolvedDependencies: materialized.unresolvedDependencyCount } : {})
    })
  } catch (error) {
    if (context.isTemporaryImport && createdTemporaryDestination) {
      await fs.rm(context.projectPath, { recursive: true, force: true }).catch(() => undefined)
    } else if (!context.isTemporaryImport) {
      await fs.rm(path.join(context.projectPath, currentProjectManifest), { force: true }).catch(() => undefined)
    }
    throw error
  }

  currentProject = project
  await rememberRecentProject(project)
  emitProjectChanged()
  return project
}

async function adoptExternalModpackWithRetry(context: ExternalModpackAdoptionContext): Promise<ProjectInfo> {
  let activityId = ''
  const operation = async (): Promise<void> => {
    await performExternalModpackAdoption(context, activityId)
  }
  activityId = downloadActivities.start({
    label: `接管整合包 · ${context.name}`,
    detail: '正在读取并校验整合包清单',
    retry: operation
  })
  try {
    const project = await performExternalModpackAdoption(context, activityId)
    downloadActivities.complete(activityId, '整合包下载、校验与接管已完成')
    return project
  } catch (error) {
    downloadActivities.fail(activityId, error)
    throw error
  }
}

async function prepareProjectIde(project: ProjectInfo): Promise<string[]> {
  const vscodeRoot = path.join(project.path, '.vscode')
  if (!isJavaLoader(project.loader)) {
    const files: Record<string, string> = project.loader === 'bedrock'
      ? {
          'extensions.json': JSON.stringify({ recommendations: ['dbaeumer.vscode-eslint'] }, null, 2),
          'settings.json': JSON.stringify({ 'javascript.implicitProjectConfig.checkJs': true, 'files.exclude': { '**/.modmind': true, '**/build': true } }, null, 2),
          'tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'ModMind: Build mcaddon', type: 'shell', command: 'npm', args: ['run', 'build'], group: { kind: 'build', isDefault: true }, problemMatcher: [] }] }, null, 2)
        }
      : {
          'extensions.json': JSON.stringify({ recommendations: ['ms-python.python'] }, null, 2),
          'settings.json': JSON.stringify({ 'python.analysis.extraPaths': ['behavior_pack'], 'files.exclude': { '**/.modmind': true, '**/build': true, '**/*.pyc': true } }, null, 2),
          'tasks.json': JSON.stringify({ version: '2.0.0', tasks: [] }, null, 2)
        }
    await fs.mkdir(vscodeRoot, { recursive: true })
    await Promise.all(Object.entries(files).map(([name, content]) => fs.writeFile(path.join(vscodeRoot, name), content, 'utf8')))
    return Object.keys(files).map((name) => `.vscode/${name}`)
  }
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
  const gradleCommand = await pathExists(path.join(project.path, wrapper))
    ? process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'
    : 'gradle'
  const files: Record<string, string> = {
    'extensions.json': JSON.stringify({ recommendations: [
      'redhat.java',
      'vscjava.vscode-java-debug',
      'vscjava.vscode-java-test',
      'vscjava.vscode-gradle'
    ] }, null, 2),
    'settings.json': JSON.stringify({
      'java.configuration.updateBuildConfiguration': 'automatic',
      'java.import.gradle.enabled': true,
      'java.compile.nullAnalysis.mode': 'automatic',
      'java.format.settings.url': '',
      'gradle.nestedProjects': true,
      'files.exclude': { '**/.gradle': true, '**/.modmind': true }
    }, null, 2),
    'tasks.json': JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'ModMind: Build Mod', type: 'shell', command: gradleCommand, args: ['build'], group: { kind: 'build', isDefault: true }, problemMatcher: ['$javac'] },
        { label: 'ModMind: Run Client', type: 'shell', command: gradleCommand, args: ['processResources', 'classes', 'runClient'], problemMatcher: [] },
        { label: 'ModMind: Run Server', type: 'shell', command: gradleCommand, args: ['processResources', 'classes', 'runServer'], problemMatcher: [] },
        { label: 'ModMind: GameTest', type: 'shell', command: gradleCommand, args: ['processResources', 'classes', 'runGameTestServer'], problemMatcher: [] }
      ]
    }, null, 2),
    'launch.json': JSON.stringify({
      version: '0.2.0',
      configurations: [
        { type: 'java', name: 'Attach to Minecraft Client', request: 'attach', hostName: 'localhost', port: 5005 },
        { type: 'java', name: 'Attach to Minecraft Server', request: 'attach', hostName: 'localhost', port: 5006 }
      ]
    }, null, 2)
  }
  await fs.mkdir(vscodeRoot, { recursive: true })
  const changed: string[] = []
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(vscodeRoot, name)
    await fs.writeFile(target, `${content}\n`, 'utf8')
    changed.push(`.vscode/${name}`)
  }
  return changed
}

async function resolveExistingProjectSource(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath)
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat) throw new Error('Selected file or folder does not exist')
  if (stat.isDirectory()) return resolved
  if (!stat.isFile()) {
    throw new Error('Please select a project folder or archive')
  }
  const extractionRoot = await fs.mkdtemp(path.join(app.getPath('temp'), 'modmind-import-'))
  const expansion = { entryCount: 0, expandedBytes: 0 }
  try {
    const extension = path.extname(resolved).toLowerCase()
    const signature = await archiveSignatureForFile(resolved)
    if (signature === 'tar' || extension === '.tar') {
      await extractTar(resolved, extractionRoot, (entry) => recordZipExpansion(expansion, entry))
    } else if (signature === 'zip' || ['.zip', '.mrpack'].includes(extension)) {
      await extractZip(resolved, {
        dir: extractionRoot,
        onEntry: (entry) => recordZipExpansion(expansion, entry)
      })
    } else {
      await extractSevenZipArchive(resolved, extractionRoot, (entry) => recordZipExpansion(expansion, entry))
    }
  } catch (error) {
    await fs.rm(extractionRoot, { recursive: true, force: true })
    throw error
  }
  const entries = await fs.readdir(extractionRoot, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  if (directories.length === 1 && entries.every((entry) => entry.isDirectory() || entry.name.startsWith('.'))) {
    return path.join(extractionRoot, directories[0].name)
  }
  return extractionRoot
}

async function copyImportedReferences(sourceRoot: string, destinationRoot: string, files: string[]): Promise<number> {
  let totalBytes = 0
  let copied = 0
  for (const relative of files) {
    if (!importableReferenceExtensions.has(path.extname(relative).toLowerCase())) continue
    const source = path.join(sourceRoot, ...relative.split('/'))
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isFile() || stat.size > 8 * 1024 * 1024 || totalBytes + stat.size > 60 * 1024 * 1024) continue
    const destination = path.join(destinationRoot, ...relative.split('/'))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    totalBytes += stat.size
    copied += 1
  }
  return copied
}

async function listDirectory(root: string, relative = ''): Promise<FileNode[]> {
  const absolute = path.join(root, relative)
  const entries = await fs.readdir(absolute, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })) {
    if (entry.isSymbolicLink()) continue
    if (ignoredDirectories.has(entry.name) || (isToolDataDirectory(relative) && entry.name === 'snapshots')) continue
    const childPath = path.posix.join(relative.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: childPath, type: 'directory', children: await listDirectory(root, childPath) })
    } else {
      nodes.push({ name: entry.name, path: childPath, type: 'file' })
    }
  }
  return nodes
}

function pipelineEvent(
  stage: PipelineEvent['stage'],
  title: string,
  detail: string,
  status: PipelineEvent['status'],
  todo?: PipelineEvent['todo'],
  options?: Pick<PipelineEvent, 'terminal' | 'recoverable'>
): PipelineEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stage,
    title,
    detail,
    status,
    time: new Date().toISOString(),
    ...(options?.terminal !== undefined ? { terminal: options.terminal } : {}),
    ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}),
    ...(todo ? { todo } : {})
  }
}

async function sendBuildProgress(event: Electron.IpcMainInvokeEvent, item: PipelineEvent, wait = 320): Promise<void> {
  diagnosticJournal.record({
    subsystem: 'build',
    operation: item.stage,
    phase: item.status === 'error' ? 'error' : item.status,
    level: item.status === 'error' ? 'error' : item.status === 'warning' ? 'warning' : 'info',
    message: item.title,
    data: { detail: item.detail, todo: item.todo }
  })
  if (event.sender.isDestroyed()) return
  event.sender.send('build:progress', item)
  if (item.stage === 'complete' || item.stage === 'error') notifyUser(item.status === 'error' ? 'ModMind 构建失败' : 'ModMind 构建完成', item.detail || item.title)
  await new Promise((resolve) => setTimeout(resolve, wait))
}

async function copySnapshotFiles(source: string, destination: string): Promise<number> {
  let count = 0
  const entries = await fs.readdir(source, { withFileTypes: true })
  await fs.mkdir(destination, { recursive: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (ignoredDirectories.has(entry.name) || isToolDataDirectory(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) count += await copySnapshotFiles(from, to)
    else {
      await fs.copyFile(from, to)
      count += 1
    }
  }
  return count
}

async function latestSnapshotBaseline(project: ProjectInfo): Promise<{ root: string; hashes: Record<string, string>; metadata?: Record<string, SnapshotFileMetadata> } | undefined> {
  const snapshotsRoot = path.join(project.path, projectDataDirectory(project), 'snapshots')
  const entries = await fs.readdir(snapshotsRoot, { withFileTypes: true }).catch(() => [])
  const candidates: Array<{ createdAt: string; root: string; manifest: SnapshotManifest }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(snapshotsRoot, entry.name)
    const manifest = await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8')
      .then((value) => JSON.parse(value) as SnapshotManifest)
      .catch(() => null)
    const root = path.join(directory, 'files')
    if (!manifest || typeof manifest.createdAt !== 'string' || !snapshotManifestBelongsToProject(manifest, entry.name, project.path) || !(await pathExists(root))) continue
    candidates.push({ createdAt: manifest.createdAt, root, manifest })
  }
  const latest = candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (!latest) return undefined

  const hashes: Record<string, string> = {}
  const metadata: Record<string, SnapshotFileMetadata> = {}
  if (latest.manifest.hashes && typeof latest.manifest.hashes === 'object') {
    for (const [relative, hash] of Object.entries(latest.manifest.hashes)) {
      if (typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)) hashes[relative] = hash.toLowerCase()
    }
  }
  // Snapshots created before incremental metadata was introduced are still a
  // valid baseline. Hash only their listed files once so the next snapshot can
  // reuse unchanged content as well.
  if (!Object.keys(hashes).length) {
    const files = latest.manifest.files ?? await listSnapshotManagedFiles(latest.root)
    for (const relative of files) {
      const normalized = relative.replaceAll('\\', '/')
      const target = path.resolve(latest.root, ...normalized.split('/'))
      if (!target.startsWith(`${path.resolve(latest.root)}${path.sep}`)) continue
      const info = await snapshotFileHash(target).catch(() => null)
      if (info) hashes[normalized] = info.sha256
    }
  }
  if (latest.manifest.fileMetadata && typeof latest.manifest.fileMetadata === 'object') {
    for (const [relative, value] of Object.entries(latest.manifest.fileMetadata)) {
      if (!value || typeof value !== 'object') continue
      const candidate = value as Partial<SnapshotFileMetadata>
      if (typeof candidate.size !== 'number' || typeof candidate.mtimeMs !== 'number' || typeof candidate.ctimeMs !== 'number' || typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256)) continue
      metadata[relative] = { size: candidate.size, mtimeMs: candidate.mtimeMs, ctimeMs: candidate.ctimeMs, sha256: candidate.sha256.toLowerCase() }
    }
  }
  return Object.keys(hashes).length ? { root: latest.root, hashes, ...(Object.keys(metadata).length ? { metadata } : {}) } : undefined
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function normalizeJavaPreferences(value: unknown): JavaPreferences {
  const input = value && typeof value === 'object' ? value as Partial<JavaPreferences> : {}
  // '' means "automatic"; anything else is a JDK home (or bin/java path) handed
  // to the runtime's own validation before use.
  const normalizeHome = (entry: unknown): string => typeof entry === 'string' ? entry.trim().replace(/^"|"$/g, '').slice(0, 4096) : ''
  return { game: normalizeHome(input.game), build: normalizeHome(input.build), tools: normalizeHome(input.tools) }
}

/** Only http(s) proxy URLs are accepted; anything else falls back to direct connection. */
function normalizeNetworkProxyUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

let agentSettingsWriteTail = Promise.resolve()

async function writeAgentSettingsAtomically(stored: Record<string, unknown>): Promise<void> {
  const target = settingsFile()
  const temporary = `${target}.tmp-${randomUUID()}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      await fs.rename(temporary, target)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function saveAgentSettings(value: AgentSettings): Promise<AgentSettings> {
  let resolveWrite!: (settings: AgentSettings) => void
  let rejectWrite!: (error: unknown) => void
  const result = new Promise<AgentSettings>((resolve, reject) => {
    resolveWrite = resolve
    rejectWrite = reject
  })
  agentSettingsWriteTail = agentSettingsWriteTail.catch(() => undefined).then(async () => {
    try {
  const kinds = ['codex', 'claude'] as const
  const normalized: AgentSettings = {
    ...value,
    codingBackend: ['quota', ...kinds].includes(value.codingBackend) ? value.codingBackend : 'codex',
    allowBuildScriptChanges: value.allowBuildScriptChanges !== false,
    preferLocalGradle: Boolean(value.preferLocalGradle),
    gradleExecutable: typeof value.gradleExecutable === 'string' ? value.gradleExecutable.trim().slice(0, 4096) : '',
    gradleDownloadSource: value.gradleDownloadSource === 'china' || value.gradleDownloadSource === 'official' ? value.gradleDownloadSource : 'auto',
    networkProxyUrl: normalizeNetworkProxyUrl(value.networkProxyUrl),
    javaPreferences: normalizeJavaPreferences(value.javaPreferences),
    darkMode: Boolean(value.darkMode),
    closeBehavior: value.closeBehavior === 'tray' || value.closeBehavior === 'quit' ? value.closeBehavior : 'ask',
    notificationsEnabled: value.notificationsEnabled !== false
  }
  let existingAgentKeys: Partial<Record<ExternalAgentKind, string>> = {}
  try {
    const existing = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as { encryptedKey?: string; externalAgentProvider?: ExternalAgentKind; encryptedAgentKeys?: Partial<Record<ExternalAgentKind, string>> }
    existingAgentKeys = existing.encryptedAgentKeys ?? {}
    if (existing.encryptedKey && existing.externalAgentProvider && !existingAgentKeys[existing.externalAgentProvider]) {
      existingAgentKeys[existing.externalAgentProvider] = existing.encryptedKey
    }
  } catch {
    // First save has no existing settings file.
  }
  const agentEntries: NonNullable<AgentSettings['externalAgents']> = {}
  const encryptedAgentKeys: Partial<Record<ExternalAgentKind, string>> = {}
  for (const kind of kinds) {
    const entry = normalized.externalAgents?.[kind]
    if (!entry) continue
    if (entry.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法保存 API Key')
    agentEntries[kind] = {...entry, mode: kind === 'codex' || entry.mode === 'hosted' ? 'hosted' : 'local', apiKey: undefined, hasStoredKey: undefined}
    if (entry.apiKey && safeStorage.isEncryptionAvailable()) encryptedAgentKeys[kind] = safeStorage.encryptString(entry.apiKey).toString('base64')
    else if (existingAgentKeys[kind]) encryptedAgentKeys[kind] = existingAgentKeys[kind]
  }
  const stored: Record<string, unknown> = { ...normalized, externalAgents: agentEntries }
  if (Object.keys(encryptedAgentKeys).length) stored.encryptedAgentKeys = encryptedAgentKeys
      await writeAgentSettingsAtomically(stored)
      resolveWrite(await readSettings())
    } catch (error) {
      rejectWrite(error)
    }
  })
  return result
}

function publicAgentSettings(settings: AgentSettings): AgentSettings {
  const externalAgents = settings.externalAgents
    ? Object.fromEntries(Object.entries(settings.externalAgents).map(([kind, value]) => [kind, value ? {...value, apiKey: ''} : value])) as AgentSettings['externalAgents']
    : undefined
  return {...settings, externalAgents}
}

async function exportDiagnosticLogs(pageSnapshots: DiagnosticPageSnapshot[] = []): Promise<string | null> {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: '导出 ModMind 诊断日志',
    defaultPath: path.join(app.getPath('downloads'), `ModMind-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`),
    filters: [{ name: 'ModMind 诊断包', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return null
  try {
  await aiOutputLogWrite
  diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'export', phase: 'start', message: 'Exporting diagnostic archive' })
  await diagnosticJournal.flush()
  const exportedAt = new Date().toISOString()
  const collector = new DiagnosticArchiveCollector()

  const project = currentProject
  const runtimeState = minecraftRuntime?.getState()
  const userData = app.getPath('userData')
  const appSettings = await readSettings().catch((error) => {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'settings-summary', phase: 'error', level: 'warning', message: 'Unable to read settings for diagnostics', error })
    return null
  })
  const imageSettings = await requireImageStudio().getSettings().catch(() => null)
  const disk = await fs.statfs(userData).catch(() => null)
  const summary = {
    exportedAt,
    appVersion: app.getVersion(),
    sourceFingerprint: MODMIND_SOURCE_FINGERPRINT,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    locale: app.getLocale(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), memoryUsage: process.memoryUsage(), totalMemory: os.totalmem(), freeMemory: os.freemem() },
    disk: disk ? { blockSize: disk.bsize, blocks: disk.blocks, freeBlocks: disk.bfree, availableBlocks: disk.bavail, freeBytes: Number(disk.bavail) * Number(disk.bsize) } : null,
    network: {
      httpProxyConfigured: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
      httpsProxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
      noProxyConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy)
    },
    settings: appSettings ? {
      codingBackend: appSettings.codingBackend,
      gradleDownloadSource: appSettings.gradleDownloadSource,
      preferLocalGradle: appSettings.preferLocalGradle,
      externalAgents: Object.fromEntries(Object.entries(appSettings.externalAgents ?? {}).map(([kind, value]) => [kind, value ? { configured: true, model: value.model, executableConfigured: Boolean(value.executable), baseUrlConfigured: Boolean(value.baseUrl), hasApiKey: Boolean(value.apiKey || value.hasStoredKey) } : { configured: false }])),
      imageService: imageSettings ? { baseUrl: imageSettings.baseUrl, model: imageSettings.model, hasApiKey: imageSettings.hasStoredKey } : null
    } : null,
    diagnosticJournal: diagnosticJournal.status(),
    project: project ? {
      kind: project.kind ?? 'mod',
      name: project.name,
      loader: project.loader,
      loaderVersion: project.loaderVersion,
      minecraftVersion: project.minecraftVersion,
      namespace: project.namespace
    } : null,
    runtime: runtimeState ? {
      stage: runtimeState.stage,
      message: runtimeState.message,
      minecraftVersion: runtimeState.minecraftVersion,
      loader: runtimeState.loader,
      loaderVersion: runtimeState.loaderVersion,
      installed: runtimeState.installed,
      running: runtimeState.running,
      instanceDirectory: runtimeState.instancePath ? path.basename(runtimeState.instancePath) : undefined,
      javaExecutable: runtimeState.javaPath ? path.basename(runtimeState.javaPath) : undefined,
      lastCrash: runtimeState.lastCrash
    } : null,
    localServer: localServerManager?.getState() ?? null,
    remote: remoteClient?.getState() ?? null
  }
  collector.addJson('diagnostic-summary.json', summary)
  collector.addJson('diagnostic-events-memory.json', diagnosticJournal.snapshot())
  const pageManifest: Array<{ view: string; title: string; url: string; capturedAt: string; archiveName: string }> = []
  const pageNames = new Set<string>()
  const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  for (const page of pageSnapshots.slice(0, 64)) {
    if (!page || typeof page !== 'object' || typeof page.view !== 'string' || typeof page.html !== 'string') continue
    const view = page.view.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    if (!view || pageNames.has(view)) continue
    const html = redactDiagnosticText(page.html).slice(0, 8 * 1024 * 1024)
    if (!html.trim()) continue
    const archiveName = `pages/${view}.html`
    pageNames.add(view)
    pageManifest.push({ view, title: typeof page.title === 'string' ? page.title.slice(0, 200) : '', url: typeof page.url === 'string' ? page.url.slice(0, 2_000) : '', capturedAt: typeof page.capturedAt === 'string' ? page.capturedAt : '', archiveName })
    collector.addBuffer(archiveName, Buffer.from(html, 'utf8'), true)
  }
  if (pageManifest.length) {
    collector.addBuffer('pages/index.html', Buffer.from(`<!doctype html><meta charset="utf-8"><title>ModMind page snapshots</title><h1>ModMind page snapshots</h1><ul>${pageManifest.map((page) => `<li><a href="${escapeHtml(page.archiveName.slice('pages/'.length))}">${escapeHtml(page.view)}</a> <small>${escapeHtml(page.title)}</small></li>`).join('')}</ul>`, 'utf8'), true)
    collector.addJson('pages/manifest.json', pageManifest)
  }
  if (project) {
    const dataRoot = path.join(project.path, projectDataDirectory(project))
    const runDirectories = ['run', 'run-server', 'run-gametest'].map((name) => path.join(project.path, name))

    for (const runDirectory of runDirectories) {
      await collector.addDirectory(path.join(runDirectory, 'crash-reports'), `project/${path.basename(runDirectory)}/crash-reports`)
      await collector.addDirectory(path.join(runDirectory, 'logs'), `project/${path.basename(runDirectory)}/logs`)
      await collector.addFile(path.join(runDirectory, 'launcher-console.log'), `project/${path.basename(runDirectory)}/launcher-console.log`)
    }
    await collector.addDirectory(path.join(dataRoot, 'minecraft', 'crash-reports'), 'project/minecraft/crash-reports')
    await collector.addDirectory(path.join(dataRoot, 'minecraft', 'logs'), 'project/minecraft/logs')
    await collector.addFile(path.join(dataRoot, 'minecraft', 'launcher-console.log'), 'project/minecraft/launcher-console.log')
    await collector.addFile(path.join(dataRoot, 'minecraft', 'runtime.json'), 'project/minecraft/runtime.json')
    await collector.addDirectory(path.join(dataRoot, 'builds'), 'project/builds')
    await collector.addDirectory(path.join(project.path, 'logs'), 'project/logs')
    await collector.addDirectory(path.join(project.path, 'crash-reports'), 'project/crash-reports')
    for (const directory of ['game', 'server-join']) {
      await collector.addDirectory(path.join(dataRoot, 'headlessmc', directory, 'logs'), `project/headlessmc/${directory}/logs`)
      await collector.addDirectory(path.join(dataRoot, 'headlessmc', directory, 'crash-reports'), `project/headlessmc/${directory}/crash-reports`)
    }
    await collector.addDirectory(path.join(dataRoot, 'headlessmc', 'logs'), 'project/headlessmc/service-logs')
    for (const directory of ['server-pack', 'server-scenario', 'test-server-pack']) {
      const root = path.join(dataRoot, directory)
      await collector.addDirectory(path.join(root, 'logs'), `project/${directory}/logs`)
      await collector.addDirectory(path.join(root, 'crash-reports'), `project/${directory}/crash-reports`)
      await collector.addFile(path.join(root, 'installer.log'), `project/${directory}/installer.log`)
      await collector.addFile(path.join(root, 'modmind.server.json'), `project/${directory}/modmind.server.json`)
    }
    for (const [source, archiveName] of [
      [path.join(project.path, projectManifest(project)), `project/context/${projectManifest(project)}`],
      [path.join(project.path, 'modmind.pack.json'), 'project/context/modmind.pack.json'],
      [path.join(project.path, 'modmind.modpack.lock.json'), 'project/context/modmind.modpack.lock.json'],
      [path.join(project.path, 'modrinth.index.json'), 'project/context/modrinth.index.json'],
      [path.join(project.path, 'manifest.json'), 'project/context/curseforge-manifest.json'],
      [path.join(project.path, 'gradle.properties'), 'project/context/gradle.properties'],
      [path.join(project.path, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'project/context/gradle-wrapper.properties'],
      [path.join(project.path, 'settings.gradle'), 'project/context/settings.gradle'],
      [path.join(project.path, 'settings.gradle.kts'), 'project/context/settings.gradle.kts'],
      [path.join(project.path, 'build.gradle'), 'project/context/build.gradle'],
      [path.join(project.path, 'build.gradle.kts'), 'project/context/build.gradle.kts'],
      [path.join(dataRoot, 'active-ai-task.json'), 'project/ai/active-ai-task.json'],
      [path.join(project.path, 'docs', 'last-ai-response.txt'), 'project/ai/last-ai-response.txt'],
      [path.join(project.path, 'docs', 'last-ai-change.json'), 'project/ai/last-ai-change.json'],
      [path.join(project.path, 'docs', 'ai-tasks.md'), 'project/ai/ai-tasks.md'],
      [path.join(dataRoot, 'external-agents', 'session-codex.json'), 'project/ai/session-codex.json'],
      [path.join(dataRoot, 'external-agents', 'session-claude.json'), 'project/ai/session-claude.json'],
      [path.join(dataRoot, 'external-agents', 'agent-context.md'), 'project/ai/agent-context.md']
    ] as const) await collector.addFile(source, archiveName)
  }
  collector.addJson('app-runtime/minecraft-cache-summary.json', await summarizeDiagnosticDirectory(path.join(userData, 'minecraft-runtime')))
  collector.addJson('app-runtime/server-pack-creator-summary.json', await summarizeDiagnosticDirectory(path.join(userData, 'server-pack-creator')))
  await collector.addDirectory(path.join(userData, 'server-pack-creator'), 'app-runtime/server-pack-creator', { include: (relative) => /\.(?:log|json)$/i.test(relative) })
  await collector.addDirectory(app.getPath('logs'), 'app-logs')
  const entries = collector.finalize({ journal: diagnosticJournal.status() })
  await fs.writeFile(result.filePath, createStoredZip(entries))
  diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'export', phase: 'success', message: `Diagnostic archive exported with ${entries.length} files`, data: { target: result.filePath, entries: entries.length } })
  return result.filePath
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'export', phase: 'error', message: 'Diagnostic archive export failed', error })
    await diagnosticJournal.flush()
    throw error
  }
}

function giteeBuildSettingsFile(): string {
  return path.join(app.getPath('userData'), 'gitee-build.json')
}

function trustedBuildsFile(): string {
  return path.join(app.getPath('userData'), 'trusted-builds.json')
}

async function ensureProjectBuildTrusted(project: ProjectInfo): Promise<void> {
  if ((process.env.MODMIND_E2E ?? process.env.MODTOOL_E2E) === '1') return
  const key = path.resolve(project.path).toLowerCase()
  const fingerprint = await buildScriptFingerprint(project.path)
  const trusted = await fs.readFile(trustedBuildsFile(), 'utf8')
    .then((value) => JSON.parse(value) as Record<string, string>)
    .catch(() => ({} as Record<string, string>))
  if (trusted[key] === fingerprint) return
  // Builds stay project-scoped. Record the first fingerprint silently and
  // re-fingerprint whenever the project build scripts change.
  trusted[key] = fingerprint
  await fs.mkdir(path.dirname(trustedBuildsFile()), { recursive: true })
  await fs.writeFile(trustedBuildsFile(), JSON.stringify(trusted, null, 2), 'utf8')
}

function recentProjectsFile(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

async function discoverExistingProjects(): Promise<ProjectInfo[]> {
  const ignored = new Set([
    'node_modules', '.git', '.gradle', '.modmind', 'build', 'out', 'release', 'release-next', 'release-unpacked', 'appdata'
  ])
  const roots = [...new Set(['desktop', 'documents', 'downloads'].map((name) => app.getPath(name as 'desktop' | 'documents' | 'downloads')))]
  const queue = roots.map((directory) => ({ directory, depth: 0 }))
  const discovered: ProjectInfo[] = []
  const seen = new Set<string>()
  let cursor = 0

  while (cursor < queue.length && cursor < 4000 && discovered.length < 20) {
    const { directory, depth } = queue[cursor++]
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.isFile() && entry.name === currentProjectManifest) || await readLegacyModtoolProject(directory).catch(() => null)) {
      const info = await readProjectInfo(directory).catch(() => null) ?? await readLegacyModtoolProject(directory).catch(() => null)
      const key = path.resolve(directory).toLowerCase()
      if (info && !seen.has(key)) {
        seen.add(key)
        discovered.push(info)
      }
    }
    if (depth >= 5) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const name = entry.name.toLowerCase()
      if (name.startsWith('.') || ignored.has(name)) continue
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 })
    }
  }

  return discovered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
}

async function readRecentProjects(): Promise<ProjectInfo[]> {
  let stored: unknown
  try {
    stored = JSON.parse(await fs.readFile(recentProjectsFile(), 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const discovered = await discoverExistingProjects()
      await writeRecentProjects(discovered)
      return discovered
    }
    return []
  }
  if (!Array.isArray(stored)) return []
  const recent: ProjectInfo[] = []
  const seen = new Set<string>()
  for (const entry of stored.slice(0, 20)) {
    const projectPath = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'path' in entry ? (entry as { path?: unknown }).path : null
    if (typeof projectPath !== 'string' || !projectPath.trim()) continue
    const normalized = path.resolve(projectPath)
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    const info = await readProjectInfo(normalized).catch(() => null) ?? await readLegacyModtoolProject(normalized).catch(() => null)
    if (!info) continue
    seen.add(key)
    recent.push(info)
  }
  return recent
}

async function writeRecentProjects(projects: ProjectInfo[]): Promise<void> {
  await fs.mkdir(path.dirname(recentProjectsFile()), { recursive: true })
  await fs.writeFile(recentProjectsFile(), JSON.stringify(projects.map(({ path: projectPath }) => ({ path: projectPath })), null, 2), 'utf8')
}

async function rememberRecentProject(project: ProjectInfo): Promise<void> {
  const recent = await readRecentProjects()
  const key = path.resolve(project.path).toLowerCase()
  await writeRecentProjects([project, ...recent.filter((entry) => path.resolve(entry.path).toLowerCase() !== key)].slice(0, 12))
}

async function deleteProjectDirectory(projectPath: string): Promise<ProjectInfo[]> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
  const resolved = path.resolve(projectPath)
  if (resolved === path.parse(resolved).root) throw new Error('不能删除文件系统根目录')
  const stat = await fs.lstat(resolved).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('项目目录不存在或不是可删除的项目目录')
  const info = await readProjectInfo(resolved)
  if (!info) throw new Error('项目不存在或已经不是有效的 ModMind 项目')
  assertProjectMutationAllowed(info.path, '删除')

  assertProjectSwitchAllowed()
  if (minecraftRuntime?.getState().running) throw new Error('Minecraft 测试实例正在运行，请先停止后再删除项目')
  const recent = await readRecentProjects()
  const key = resolved.toLowerCase()
  if (!recent.some((entry) => path.resolve(entry.path).toLowerCase() === key)) throw new Error('项目不在最近项目列表中')

  await fs.rm(resolved, { recursive: true, force: false })
  const remaining = recent.filter((entry) => path.resolve(entry.path).toLowerCase() !== key)
  await writeRecentProjects(remaining)
  if (currentProject && sameProjectPath(currentProject.path, resolved)) currentProject = null
  return remaining
}

async function migrateLegacyUserData(): Promise<void> {
  const target = app.getPath('userData')
  const legacy = path.join(app.getPath('appData'), 'modtool')
  if (path.resolve(target).toLowerCase() === path.resolve(legacy).toLowerCase() || !(await pathExists(legacy))) return
  const targetEntries = await fs.readdir(target).catch(() => [])
  if (!targetEntries.length) {
    await fs.rm(target, { recursive: true, force: true })
    try {
      await fs.rename(legacy, target)
      return
    } catch {
      // Fall through to the lightweight settings migration if the directory is locked.
    }
  }
  const legacySettings = path.join(legacy, 'settings.json')
  const currentSettings = path.join(target, 'settings.json')
  if (!(await pathExists(currentSettings)) && (await pathExists(legacySettings))) {
    await fs.mkdir(target, { recursive: true })
    await fs.copyFile(legacySettings, currentSettings)
  }
}

async function readSettings(): Promise<AgentSettings> {
  const defaults: AgentSettings = {
    codingBackend: 'codex',
    allowBuildScriptChanges: true,
    preferLocalGradle: false,
    gradleExecutable: '',
    gradleDownloadSource: 'auto',
    networkProxyUrl: '',
    javaPreferences: { game: '', build: '', tools: '' },
    darkMode: false,
    closeBehavior: 'ask',
    notificationsEnabled: true
  }
  let settings = defaults
  try {
    const stored = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Partial<AgentSettings> & {
      encryptedKey?: string
      encryptedAgentKeys?: Partial<Record<ExternalAgentKind, string>>
      externalAgentProvider?: ExternalAgentKind
      codexExecutable?: string
      claudeExecutable?: string
      baseUrl?: string
      model?: string
      reasoningEffort?: unknown
    }
    let legacyApiKey = ''
    if (stored.encryptedKey && safeStorage.isEncryptionAvailable()) {
      try { legacyApiKey = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')) } catch { /* Ignore an unreadable legacy credential. */ }
    }
    const storedReasoning = stored.reasoningEffort
    const storedAgents = stored.externalAgents && typeof stored.externalAgents === 'object' ? stored.externalAgents : {}
    const externalAgents: AgentSettings['externalAgents'] = {}
    for (const kind of ['codex', 'claude'] as const) {
      const entry = storedAgents[kind]
      if (!entry || typeof entry !== 'object') continue
      const encrypted = stored.encryptedAgentKeys?.[kind]
        ?? (stored.externalAgentProvider === kind ? stored.encryptedKey : undefined)
      let agentApiKey = ''
      if (encrypted && safeStorage.isEncryptionAvailable()) {
        try { agentApiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { /* Ignore an unreadable saved credential. */ }
      }
      externalAgents[kind] = {
        executable: typeof entry.executable === 'string' ? entry.executable.slice(0, 4096) : undefined,
        mode: kind === 'codex' || entry.mode === 'hosted' ? 'hosted' : 'local',
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.slice(0, 4096) : undefined,
        model: typeof entry.model === 'string' ? entry.model.slice(0, 512) : undefined,
        reasoningEffort: entry.reasoningEffort === 'low' || entry.reasoningEffort === 'medium' || entry.reasoningEffort === 'high' || entry.reasoningEffort === 'xhigh' || entry.reasoningEffort === 'max' || entry.reasoningEffort === 'ultra' ? entry.reasoningEffort : undefined,
        apiKey: agentApiKey,
        hasStoredKey: Boolean(encrypted)
      }
    }
    // Keep the former shared setting usable after the per-Agent update.
    if (!externalAgents.codex && (stored.codexExecutable || stored.externalAgentProvider === 'codex')) {
      externalAgents.codex = {executable: stored.codexExecutable, mode: 'hosted', baseUrl: stored.baseUrl, model: stored.model, reasoningEffort: storedReasoning as ExternalAgentConfiguration['reasoningEffort'], apiKey: stored.externalAgentProvider === 'codex' ? legacyApiKey : '', hasStoredKey: stored.externalAgentProvider === 'codex' && Boolean(stored.encryptedKey)}
    }
    if (!externalAgents.claude && (stored.claudeExecutable || stored.externalAgentProvider === 'claude')) {
      externalAgents.claude = {executable: stored.claudeExecutable, mode: stored.externalAgentProvider === 'claude' ? 'hosted' : 'local', baseUrl: stored.baseUrl, model: stored.model, reasoningEffort: storedReasoning as ExternalAgentConfiguration['reasoningEffort'], apiKey: stored.externalAgentProvider === 'claude' ? legacyApiKey : '', hasStoredKey: stored.externalAgentProvider === 'claude' && Boolean(stored.encryptedKey)}
    }
    settings = {
      externalAgents,
      codingBackend: ['quota', 'codex', 'claude'].includes(String(stored.codingBackend))
        ? stored.codingBackend as AgentSettings['codingBackend']
        : 'codex',
      allowBuildScriptChanges: stored.allowBuildScriptChanges !== false,
      preferLocalGradle: Boolean(stored.preferLocalGradle),
      gradleExecutable: typeof stored.gradleExecutable === 'string' ? stored.gradleExecutable.slice(0, 4096) : '',
      gradleDownloadSource: stored.gradleDownloadSource === 'china' || stored.gradleDownloadSource === 'official'
        ? stored.gradleDownloadSource
        : 'auto',
      networkProxyUrl: normalizeNetworkProxyUrl(stored.networkProxyUrl),
      javaPreferences: normalizeJavaPreferences(stored.javaPreferences),
      darkMode: Boolean(stored.darkMode),
      closeBehavior: stored.closeBehavior === 'tray' || stored.closeBehavior === 'quit' ? stored.closeBehavior : 'ask',
      notificationsEnabled: stored.notificationsEnabled !== false
    }
  } catch {
    settings = defaults
  }
  return settings
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API URL must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('API URL cannot contain credentials')
  return url.toString().replace(/\/$/, '')
}

async function listAvailableAgentModels(kind: ExternalAgentKind, input: ExternalAgentConfiguration): Promise<AiModelInfo[]> {
  const stored = await readSettings()
  const baseUrl = normalizeApiBaseUrl(input.baseUrl ?? '')
  const storedEntry = stored.externalAgents?.[kind]
  const storedBaseUrl = storedEntry?.baseUrl ? normalizeApiBaseUrl(storedEntry.baseUrl) : ''
  const apiKey = input.apiKey?.trim() || (baseUrl === storedBaseUrl ? storedEntry?.apiKey?.trim() ?? '' : '')
  if (!apiKey) throw new Error('Please enter an API Key before scanning models')

  return fetchAvailableModels(baseUrl, apiKey, 'Please enter a valid Base URL and API Key')
}

async function cachedAvailableAgentModels(kind: ExternalAgentKind, input: ExternalAgentConfiguration): Promise<AiModelInfo[]> {
  const baseUrl = normalizeApiBaseUrl(input.baseUrl ?? '')
  const apiKey = input.apiKey?.trim() ?? ''
  const key = createHash('sha256').update(`${kind}\n${baseUrl}\n${apiKey}`).digest('hex').slice(0, 24)
  const cached = externalModelAvailabilityCache.get(key)
  if (cached && Date.now() - cached.checkedAt <= QUOTA_MODEL_MAX_AGE_MS) return cached.models
  const models = await listAvailableAgentModels(kind, input)
  externalModelAvailabilityCache.set(key, { checkedAt: Date.now(), models })
  return models
}

async function inspirationQuotaConfig(question: string, signal: AbortSignal): Promise<CodexServerConfig> {
  const credentials = await awaitWithAbort(readDeviceCredentials(), signal, '灵感模型选择已停止')
  if (!credentials) throw new Error('请先连接 ModMind 账号')
  const configured = await awaitWithAbort(readBeginnerAgentServerConfig(), signal, '灵感模型选择已停止')
  let models: AiModelInfo[] = []
  try {
    models = await awaitWithAbort(quotaModelsForCredentials(credentials), signal, '灵感模型选择已停止')
  } catch {
    throwIfAborted(signal, '灵感模型选择已停止')
  }
  return {
    ...configured,
    model: selectInspirationModel(models, configured.model)
  }
}

async function inspirationExternalConfiguration(
  kind: ExternalAgentKind,
  configured: ExternalAgentConfiguration,
  question: string,
  signal: AbortSignal
): Promise<ExternalAgentConfiguration> {
  const canScan = Boolean(configured.baseUrl?.trim() && configured.model?.trim() && configured.apiKey?.trim())
  let models: AiModelInfo[] = []
  if (canScan) {
    try {
      models = await awaitWithAbort(cachedAvailableAgentModels(kind, configured), signal, '灵感模型选择已停止')
    } catch {
      throwIfAborted(signal, '灵感模型选择已停止')
    }
  }
  return {
    ...configured,
    ...(configured.model?.trim() ? { model: selectInspirationModel(models, configured.model) } : {})
  }
}

async function listBeginnerModels(force = false): Promise<AiModelInfo[]> {
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接账号后扫描模型')
  const models = await quotaModelsForCredentials(credentials, force)
  if (models.length) await reconcileQuotaModelPreferences(credentials, false, models)
  return models
}

async function fetchAvailableModels(baseUrl: string, apiKey: string, errorMessage: string): Promise<AiModelInfo[]> {
  const endpoints = [`${baseUrl}/model`, `${baseUrl}/models`]
  for (const [index, endpoint] of endpoints.entries()) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      throw new Error(errorMessage)
    }
    if (!response.ok) {
      if (response.status === 404 && index < endpoints.length - 1) continue
      throw new Error(errorMessage)
    }
    let payload: unknown
    try { payload = await response.json() as unknown } catch { throw new Error('模型服务返回了无效数据') }
    const models = parseModelPayload(payload)
    if (models.length) return models
    if (index === endpoints.length - 1) return []
  }
  return []
}

function normalizeCodingPath(value: string, _allowBuildScriptChanges = true, _allowWrapperConfiguration = true, project: ProjectInfo = requireProject()): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || path.win32.isAbsolute(value) || path.posix.isAbsolute(normalized) || normalized.includes('../')) {
    throw new Error(`AI returned an unsafe path: ${value}`)
  }
  resolveProjectPathFor(project, normalized)
  return normalized
}

async function resolveSafeCodingTarget(relativePath: string, project: ProjectInfo = requireProject()): Promise<string> {
  const target = resolveProjectPathFor(project, relativePath)
  const segments = relativePath.replaceAll('\\', '/').split('/').slice(0, -1)
  let current = project.path
  for (const segment of segments) {
    current = path.join(current, segment)
    if (!(await pathExists(current))) break
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`AI cannot write through a symbolic link: ${relativePath}`)
  }
  return target
}

async function createProjectSnapshot(label: string, metadata: { taskId?: string } = {}, projectOverride?: ProjectInfo): Promise<SnapshotInfo> {
  const project = projectOverride ?? requireProject()
  const id = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const snapshotPath = path.join(project.path, projectDataDirectory(project), 'snapshots', id, 'files')
  const copied = await copySnapshotFilesIncremental(
    project.path,
    snapshotPath,
    (name) => ignoredDirectories.has(name) || isToolDataDirectory(name),
    await latestSnapshotBaseline(project)
  )
  const fileCount = copied.fileCount
  const info: SnapshotInfo = { id, label, createdAt: new Date().toISOString(), fileCount }
  const manifest: SnapshotManifest = {
    ...info,
    files: Object.keys(copied.hashes).sort(),
    hashes: copied.hashes,
    fileMetadata: copied.metadata,
    taskId: metadata.taskId,
    projectPath: project.path
  }
  await fs.writeFile(path.join(path.dirname(snapshotPath), 'snapshot.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return info
}

async function readGiteeBuildSettings(): Promise<GiteeBuildSettings> {
  const defaults: GiteeBuildSettings = { repositoryUrl: '', branch: 'main', token: '' }
  try {
    const stored = JSON.parse(await fs.readFile(giteeBuildSettingsFile(), 'utf8')) as GiteeBuildSettings & { encryptedToken?: string }
    let token = ''
    if (stored.encryptedToken && safeStorage.isEncryptionAvailable()) {
      try { token = safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64')) } catch { token = '' }
    }
    return {
      repositoryUrl: typeof stored.repositoryUrl === 'string' ? stored.repositoryUrl.slice(0, 1024) : defaults.repositoryUrl,
      branch: typeof stored.branch === 'string' && stored.branch.trim() ? stored.branch.trim().slice(0, 200) : defaults.branch,
      token,
      hasStoredToken: Boolean(stored.encryptedToken)
    }
  } catch {
    return defaults
  }
}

async function saveGiteeBuildSettings(input: GiteeBuildSettings): Promise<GiteeBuildSettings> {
  const existing = await readGiteeBuildSettings()
  const token = input.token.trim() || existing.token
  if (input.token.trim() && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法保存 Gitee Token')
  const normalized: GiteeBuildSettings = {
    repositoryUrl: input.repositoryUrl.trim().slice(0, 1024),
    branch: (input.branch.trim() || 'main').slice(0, 200),
    token
  }
  const stored: Record<string, unknown> = { ...normalized, token: undefined, hasStoredToken: undefined }
  if (token && safeStorage.isEncryptionAvailable()) stored.encryptedToken = safeStorage.encryptString(token).toString('base64')
  await fs.mkdir(path.dirname(giteeBuildSettingsFile()), { recursive: true })
  await fs.writeFile(giteeBuildSettingsFile(), JSON.stringify(stored, null, 2), 'utf8')
  return { ...normalized, token: '', hasStoredToken: Boolean(stored.encryptedToken) }
}

async function probeGradleInstallation(candidate: string): Promise<GradleInstallation | null> {
  let executable = candidate.trim().replace(/^"|"$/g, '')
  if (!executable || /["\r\n&|<>^]/.test(executable)) return null
  const stat = await fs.stat(executable).catch(() => null)
  if (stat?.isDirectory()) executable = path.join(executable, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  if (!(await pathExists(executable))) return null
  return await new Promise((resolve) => {
    const invocation = process.platform === 'win32'
      ? windowsCmdInvocation(executable, ['--version'])
      : { command: executable, args: ['--version'], windowsVerbatimArguments: false as const }
    execFile(invocation.command, invocation.args, {
      cwd: process.platform === 'win32' ? path.dirname(executable) : undefined,
      windowsHide: true,
      timeout: 10_000,
      windowsVerbatimArguments: process.platform === 'win32' ? invocation.windowsVerbatimArguments : undefined
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(null)
        return
      }
      const output = `${stdout}\n${stderr}`
      const version = output.match(/^Gradle\s+([^\s]+)$/im)?.[1]
      resolve({ path: executable, ...(version ? { version } : {}) })
    })
  })
}

async function scanGradleInstallations(): Promise<GradleInstallation[]> {
  const settings = await readSettings()
  const candidates = new Set<string>()
  const addCandidate = (value: string): void => {
    const trimmed = value.trim().replace(/^"|"$/g, '')
    if (trimmed) candidates.add(path.normalize(trimmed))
  }
  if (settings.gradleExecutable) addCandidate(settings.gradleExecutable)

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const executableNames = process.platform === 'win32' ? ['gradle.bat', 'gradle.cmd', 'gradle.exe', 'gradle'] : ['gradle']
  for (const entry of pathEntries) for (const name of executableNames) addCandidate(path.join(entry, name))

  const locateCommand = process.platform === 'win32' ? 'where.exe' : 'which'
  await new Promise<void>((resolve) => {
    execFile(locateCommand, process.platform === 'win32' ? ['gradle'] : ['-a', 'gradle'], { windowsHide: true, timeout: 5_000 }, (_error, stdout) => {
      for (const line of String(stdout ?? '').split(/\r?\n/)) if (line.trim()) addCandidate(line)
      resolve()
    })
  })

  const home = process.env.USERPROFILE || process.env.HOME || ''
  const gradleUserHome = process.env.GRADLE_USER_HOME || (home ? path.join(home, '.gradle') : '')
  const roots = [
    process.env.GRADLE_HOME,
    gradleUserHome ? path.join(gradleUserHome, 'wrapper', 'dists') : '',
    path.join(app.getPath('userData'), 'gradle-runtime'),
    home ? path.join(home, 'scoop', 'apps', 'gradle') : '',
    home ? path.join(home, '.sdkman', 'candidates', 'gradle') : '',
    process.env.ChocolateyInstall ? path.join(process.env.ChocolateyInstall, 'lib', 'gradle', 'tools') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Gradle') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'gradle') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'gradle') : ''
  ].filter((root): root is string => Boolean(root))
  let budget = 500
  const walk = async (root: string, depth: number): Promise<void> => {
    if (budget <= 0 || depth < 0) return
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (budget-- <= 0) break
      const absolute = path.join(root, entry.name)
      if (entry.isFile() && /^gradle(?:\.bat|\.cmd|\.exe)?$/i.test(entry.name)) addCandidate(absolute)
      else if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'bin') for (const name of executableNames) addCandidate(path.join(absolute, name))
        if (depth > 0) await walk(absolute, depth - 1)
      }
    }
  }
  for (const root of roots) {
    budget = 500
    const stat = await fs.stat(root).catch(() => null)
    if (stat?.isDirectory()) await walk(root, 4)
  }

  const results = (await Promise.all([...candidates].map((candidate) => probeGradleInstallation(candidate))))
    .filter((item): item is GradleInstallation => Boolean(item))
  const unique = new Map<string, GradleInstallation>()
  for (const item of results) unique.set(path.resolve(item.path).toLowerCase(), item)
  return [...unique.values()].sort((left, right) => {
    const leftVersion = left.version ?? ''
    const rightVersion = right.version ?? ''
    return rightVersion.localeCompare(leftVersion, undefined, { numeric: true }) || left.path.localeCompare(right.path)
  })
}

async function previewProjectMigration(input: ProjectMigrationInput): Promise<ProjectMigrationPreview> {
  const project = requireProject()
  if (!input || !isJavaLoader(input.loader)) throw new Error('版本迁移目前只支持 Java Loader 项目')
  if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 不能迁移为 Java Loader；请新建对应平台工程`)
  const target = await requireLoaderCatalog().resolve(input.loader, input.minecraftVersion.trim())
  const automaticChanges = [
    '创建源项目快照并复制到新的项目目录',
    '更新 ModMind 项目清单、Gradle 配置和加载器描述文件',
    '保留源码、资源、数据包与项目文档'
  ]
  if ((project.loader === 'forge' && target.loader === 'neoforge') || (project.loader === 'neoforge' && target.loader === 'forge')) {
    automaticChanges.push('转换 Forge 与 NeoForge 的标准 Java 包名前缀')
  }
  const warnings: string[] = [...target.notes]
  if (project.loader !== target.loader) warnings.push('跨加载器 API 并非一一对应，迁移后需要构建和 Minecraft 启动验证')
  if (project.minecraftVersion !== target.minecraftVersion) warnings.push('Minecraft API、映射名称和资源格式可能已经变化')
  if (target.supportTier === 'experimental') warnings.push('目标组合属于实验性支持，旧版构建工具链可能需要人工调整')
  const blockers = project.loader === target.loader && project.minecraftVersion === target.minecraftVersion
    ? ['目标加载器和 Minecraft 版本与当前项目相同']
    : []
  return {
    source: { loader: project.loader, minecraftVersion: project.minecraftVersion },
    target,
    automaticChanges,
    warnings: [...new Set(warnings)],
    blockers
  }
}

async function migrateProject(input: ProjectMigrationInput): Promise<ProjectMigrationResult | null> {
  assertProjectSwitchAllowed()
  const source = requireProject()
  assertProjectMutationAllowed(source.path, '迁移版本')
  const preview = await previewProjectMigration(input)
  if (preview.blockers.length) throw new Error(preview.blockers.join('\n'))
  const selection = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
  if (selection.canceled || !selection.filePaths[0]) return null
  const parent = path.resolve(selection.filePaths[0])
  const suffix = `${preview.target.loader}-${preview.target.minecraftVersion.replaceAll('.', '_')}`
  const destination = path.resolve(parent, `${source.namespace}-${suffix}`)
  if (path.dirname(destination) !== parent) throw new Error('迁移目标路径无效')
  try { assertSeparateMigrationTrees(source.path, destination) } catch { throw new Error('迁移目标不能位于源项目内部，也不能包含源项目；这会造成目录无限嵌套') }
  if (await pathExists(destination)) throw new Error(`迁移目标已存在：${destination}`)

  const snapshot = await createProjectSnapshot(`迁移前：${source.loader} ${source.minecraftVersion}`)
  await fs.mkdir(destination, { recursive: true })
  await copySnapshotFiles(source.path, destination)
  const targetProject: ProjectInfo = {
    ...source,
    path: destination,
    loader: preview.target.loader,
    minecraftVersion: preview.target.minecraftVersion,
    loaderVersion: preview.target.loaderVersion,
    apiVersion: preview.target.apiVersion,
    qslVersion: preview.target.qslVersion,
    javaVersion: preview.target.javaVersion,
    projectVersion: CURRENT_PROJECT_VERSION,
    createdAt: new Date().toISOString(),
    toolDataDirectory: '.modmind'
  }

  const migrationBackupRoot = path.join(destination, 'docs', 'migration-source-build')
  const sourceBuildFiles = [
    'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties',
    'gradlew', 'gradlew.bat'
  ]
  for (const relative of sourceBuildFiles) {
    const sourceFile = path.join(destination, ...relative.split('/'))
    if (!(await pathExists(sourceFile))) continue
    const backup = path.join(migrationBackupRoot, ...relative.split('/'))
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.copyFile(sourceFile, backup)
  }
  for (const relative of ['gradle', 'buildSrc', 'build-logic']) {
    const sourceDirectory = path.join(destination, relative)
    if (!(await fs.stat(sourceDirectory).then((stat) => stat.isDirectory()).catch(() => false))) continue
    await fs.cp(sourceDirectory, path.join(migrationBackupRoot, relative), { recursive: true })
  }
  const warnings = [...preview.warnings, '原始 Gradle 配置和 Wrapper 已备份到 docs/migration-source-build；请按目标 Loader 检查自定义依赖和任务']
  const sourceDescriptor = descriptorPath(source.loader, source.minecraftVersion)
  const originalDescriptorContent = await fs.readFile(path.join(destination, ...sourceDescriptor.split('/')), 'utf8').catch(() => '')

  const obsoleteDescriptors = [
    'src/main/resources/fabric.mod.json',
    'src/main/resources/quilt.mod.json',
    'src/main/resources/META-INF/mods.toml',
    'src/main/resources/META-INF/neoforge.mods.toml',
    'src/main/resources/mcmod.info'
  ]
  await Promise.all(obsoleteDescriptors.map((relative) => fs.rm(path.join(destination, relative), { force: true })))
  const templateFiles = projectTemplateFiles(targetProject, false)
  delete templateFiles['README.md']
  const targetDescriptor = descriptorPath(targetProject.loader, targetProject.minecraftVersion)
  if (source.loader === targetProject.loader && ['fabric', 'quilt'].includes(source.loader) && sourceDescriptor === targetDescriptor) {
    try {
      const original = JSON.parse(originalDescriptorContent) as Record<string, unknown>
      const generated = JSON.parse(templateFiles[targetDescriptor]) as Record<string, unknown>
      if (source.loader === 'fabric') {
        if (original.entrypoints) generated.entrypoints = original.entrypoints
        const depends = generated.depends as Record<string, unknown>
        depends.minecraft = targetProject.minecraftVersion
        depends.java = `>=${targetProject.javaVersion}`
        depends.fabricloader = `>=${targetProject.loaderVersion}`
      } else {
        const quilt = generated.quilt_loader as Record<string, unknown>
        const originalQuilt = original.quilt_loader as Record<string, unknown> | undefined
        if (originalQuilt?.entrypoints) quilt.entrypoints = originalQuilt.entrypoints
        const depends = Array.isArray(quilt.depends) ? quilt.depends as Array<Record<string, unknown>> : []
        for (const dependency of depends) {
          if (dependency.id === 'minecraft') dependency.versions = targetProject.minecraftVersion
          if (dependency.id === 'java') dependency.versions = `>=${targetProject.javaVersion}`
          if (dependency.id === 'quilt_loader') dependency.versions = `>=${targetProject.loaderVersion}`
        }
      }
      templateFiles[targetDescriptor] = JSON.stringify(generated, null, 2)
    } catch {
      warnings.push('无法解析原始 Loader 描述文件，已保留原文件到迁移备份目录')
    }
  }
  const changedFiles: string[] = []
  for (const [relative, content] of Object.entries(templateFiles)) {
    const target = path.join(destination, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    changedFiles.push(relative)
  }
  await copyBundledGradleWrapper(destination)
  changedFiles.push('gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar')

  if ((source.loader === 'forge' && targetProject.loader === 'neoforge') || (source.loader === 'neoforge' && targetProject.loader === 'forge')) {
    const from = source.loader === 'forge' ? 'net.minecraftforge' : 'net.neoforged'
    const to = targetProject.loader === 'forge' ? 'net.minecraftforge' : 'net.neoforged'
    const javaFiles = (await scanExternalFiles(destination)).filter((relative) => relative.endsWith('.java'))
    for (const relative of javaFiles) {
      const target = path.join(destination, ...relative.split('/'))
      const content = await fs.readFile(target, 'utf8')
      const migrated = content.replaceAll(from, to)
      if (migrated !== content) {
        await fs.writeFile(target, migrated, 'utf8')
        changedFiles.push(relative)
      }
    }
  } else if (source.loader !== targetProject.loader) {
    const starter = Object.entries(projectTemplateFiles(targetProject, true)).find(([relative]) => relative.endsWith('/ModMindEntry.java'))
    if (starter) {
      const [relative, starterContent] = starter
      const target = path.join(destination, ...relative.split('/'))
      const existing = await fs.readFile(target, 'utf8').catch(() => '')
      if (existing.includes('[ModMind]') && existing.length < 5_000) {
        await fs.writeFile(target, starterContent, 'utf8')
        changedFiles.push(relative)
      } else {
        warnings.push('自定义入口类未被覆盖，需要针对目标加载器转换入口和初始化逻辑')
      }
    }
    warnings.push('Fabric 与 Forge 系加载器的注册、事件和网络 API 需要 AI 或人工继续转换')
  }

  const reportLines = [
    '# ModMind migration report',
    '',
    `- Source: ${source.loader} ${source.minecraftVersion}`,
    `- Target: ${targetProject.loader} ${targetProject.minecraftVersion}`,
    `- Loader version: ${targetProject.loaderVersion}`,
    `- Source snapshot: ${snapshot.id}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '## Automatic changes',
    '',
    ...preview.automaticChanges.map((item) => `- ${item}`),
    '',
    '## Verification required',
    '',
    '- Run the ModMind preflight check.',
    '- Build the generated project.',
    '- Complete a Minecraft launch smoke test.',
    '',
    '## Warnings',
    '',
    ...(warnings.length ? [...new Set(warnings)].map((item) => `- ${item}`) : ['- None'])
  ]
  const reportRelative = 'docs/migration-report.md'
  const reportPath = path.join(destination, reportRelative)
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, reportLines.join('\n'), 'utf8')
  changedFiles.push(reportRelative)
  await fs.mkdir(path.join(destination, '.modmind'), { recursive: true })
  currentProject = targetProject
  await rememberRecentProject(targetProject)
  return { project: targetProject, snapshot, reportPath, changedFiles: [...new Set(changedFiles)], warnings: [...new Set(warnings)] }
}

async function readSnapshotInfo(project: ProjectInfo, id: string): Promise<SnapshotInfo | null> {
  const target = path.join(project.path, projectDataDirectory(project), 'snapshots', id, 'snapshot.json')
  return await fs.readFile(target, 'utf8').then((value) => JSON.parse(value) as SnapshotInfo).catch(() => null)
}

function sendAiProgress(event: Electron.IpcMainInvokeEvent, item: PipelineEvent, sessionId?: string, projectPath?: string, runId?: string): void {
  const actualBackend = runId ? activeAiRuns.get(runId)?.backend : undefined
  diagnosticJournal.record({
    subsystem: 'ai',
    operation: item.stage,
    phase: item.status === 'error' && item.terminal !== false ? 'error' : item.status,
    level: item.status === 'error' && item.terminal !== false ? 'error' : item.status === 'warning' || item.status === 'error' ? 'warning' : 'info',
    message: item.title,
    data: { detail: item.detail, sessionId, projectPath, runId, todo: item.todo }
  })
  if (event.sender.isDestroyed()) return
  event.sender.send('ai:progress', {
    ...item,
    ...(sessionId ? { sessionId } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(runId ? { runId } : {}),
    ...(actualBackend ? { backend: actualBackend } : {}),
    title: sanitizeAiUserText(item.title),
    detail: sanitizeAiUserText(item.detail)
  })
  if (!sessionId?.startsWith('inspiration-') && (item.stage === 'complete' || (item.stage === 'error' && item.terminal !== false))) {
    notifyUser(item.status === 'error' ? 'ModMind 任务失败' : 'ModMind 任务完成', item.detail || item.title)
  }
}

let aiOutputLogWrite = Promise.resolve()

function writeAiAttemptAudit(audit: ExternalAgentAttemptAudit, sessionId?: string, projectPath?: string): void {
  const payload = { time: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...(projectPath ? { projectPath } : {}), ...audit }
  aiOutputLogWrite = aiOutputLogWrite.then(async () => {
    await fs.mkdir(app.getPath('logs'), { recursive: true })
    await fs.appendFile(path.join(app.getPath('logs'), 'ai-attempt-audit.jsonl'), `${redactDiagnosticText(JSON.stringify(payload))}\n`, 'utf8')
  }).catch(() => undefined)
}

function sendAiOutput(
  event: Electron.IpcMainInvokeEvent,
  kind: 'start' | 'stream-start' | 'delta' | 'response' | 'answer' | 'retry' | 'tool' | 'warning' | 'error',
  content: string,
  sessionId?: string,
  projectPath?: string,
  runId?: string,
  options?: Pick<AiOutputEvent, 'terminal' | 'recoverable' | 'usage' | 'backend'>
): void {
  const time = new Date().toISOString()
  const safeContent = sanitizeAiUserText(content)
  const actualBackend = options?.backend ?? (runId ? activeAiRuns.get(runId)?.backend : undefined)
  const terminalError = kind === 'error' && options?.terminal !== false
  const payload = { kind, content: safeContent, time, ...(sessionId ? { sessionId } : {}), ...(projectPath ? { projectPath } : {}), ...(runId ? { runId } : {}), ...(actualBackend ? { backend: actualBackend } : {}), ...(options?.usage ? { usage: options.usage } : {}), ...(options?.terminal !== undefined ? { terminal: options.terminal } : {}), ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}) }
  if (kind !== 'delta') {
    diagnosticJournal.record({
      subsystem: 'ai',
      operation: 'output',
      phase: terminalError ? 'error' : kind,
      level: terminalError ? 'error' : kind === 'warning' || kind === 'error' ? 'warning' : 'info',
      message: kind === 'error' || kind === 'warning' ? safeContent : `AI output event: ${kind}`,
      data: { kind, sessionId, projectPath, contentLength: safeContent.length, ...(kind === 'tool' || kind === 'retry' ? { content: safeContent } : {}) }
    })
  }
  if (kind !== 'delta') {
    const logPayload = { ...payload, content: safeContent.slice(-64_000) }
    aiOutputLogWrite = aiOutputLogWrite.then(async () => {
      await fs.mkdir(app.getPath('logs'), { recursive: true })
      await fs.appendFile(path.join(app.getPath('logs'), 'ai-output-events.jsonl'), `${redactDiagnosticText(JSON.stringify(logPayload))}\n`, 'utf8')
    }).catch(() => undefined)
  }
  if (event.sender.isDestroyed()) return
  event.sender.send('ai:output', payload)
}

/** Keep provider responses unchanged in the user-facing AI timeline. */
export function sanitizeAiUserText(value: string): string {
  return value
}

interface AgentTodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

const MAX_READ_ONLY_AI_TASKS_PER_PROJECT = 4

interface ActiveAiRun {
  id: string
  senderId: number
  startedAt: string
  sessionId?: string
  sessionScope?: string
  projectPath: string
  executionProfile: AiExecutionProfile
  backend: AgentSettings['codingBackend']
  surface: AiSurface
}

const aiAbortControllers = new Map<string | number, AbortController>()
const aiCancelRequests = new Set<string | number>()
const activeAiRuns = new Map<string, ActiveAiRun>()
const aiBackendSwitchCoordinator = new BackendSwitchCoordinator<AgentSettings, { backend: AgentSettings['codingBackend']; switchId?: number }>()
const activeAiBackendSwitches = new Map<string, { sequence: number; controller: AbortController }>()
const REMOTE_SENDER_ID = -1
const AI_CANCEL_CONFIRM_TIMEOUT_MS = 15_000
const AI_BACKEND_START_TIMEOUT_MS = 2 * 60_000

function aiRunId(senderId: number, projectPath: string, sessionId?: string): string {
  const normalizedPath = process.platform === 'win32' ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath)
  const projectKey = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16)
  return `${senderId}:${projectKey}:${sessionId?.trim() || randomUUID()}`
}

function runsForProject(projectPath: string): ActiveAiRun[] {
  return [...activeAiRuns.values()].filter((run) => sameProjectPath(run.projectPath, projectPath))
}

function activeWorkspaceRun(projectPath: string): ActiveAiRun | undefined {
  return runsForProject(projectPath).find((run) => run.surface === 'workspace')
}

function aiProjectKey(projectPath: string): string {
  return process.platform === 'win32' ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath)
}

function abortWorkspaceRuns(projectPath: string): void {
  for (const run of runsForProject(projectPath)) {
    if (run.surface !== 'workspace') continue
    aiCancelRequests.add(run.id)
    aiAbortControllers.get(run.id)?.abort()
  }
}

async function waitForWorkspaceRunsToStop(projectPath: string, timeoutMs = 12_000): Promise<void> {
  const stopped = await waitForCondition(() => !activeWorkspaceRun(projectPath), timeoutMs)
  if (!stopped) throw new Error('旧 Agent 未能在超时前完全停止，已保留统一恢复点')
}

async function assertBackendSwitchTargetReady(backend: AgentSettings['codingBackend'], settings: AgentSettings): Promise<void> {
  if (backend === 'quota') {
    if (!await readDeviceCredentials()) throw new Error('请先连接 ModMind 账号，再切换到智能引擎')
    return
  }

  const configured = settings.externalAgents?.[backend] ?? {}
  if (backend === 'codex') {
    const usesConfiguredService = Boolean(configured.apiKey?.trim() || configured.baseUrl?.trim() || configured.model?.trim())
    if (usesConfiguredService) {
      configuredCodexServerConfig(configured)
      return
    }
    const detected = await detectExternalAgent('codex', {
      executables: [configured.executable ?? '', managedCodexExecutablePath(app.getPath('userData'))],
      includeDefaults: false
    })
    if (!detected.installed) throw new Error('Codex 尚未安装或未配置模型服务，请先在设置中完成配置')
    return
  }

  if (configured.mode === 'hosted') externalAgentEnvironment('claude', configured)
  const detected = await detectExternalAgent('claude', {executables: [configured.executable ?? '']})
  if (!detected.installed) throw new Error('Claude Code 尚未安装或命令路径不可用，请先在设置中完成配置')
}

function registerAiRun(run: ActiveAiRun): void {
  const projectRuns = runsForProject(run.projectPath)
  if (run.surface === 'workspace' && projectRuns.some((item) => item.surface === 'workspace')) {
    throw new Error('该项目已有工作台任务正在运行；请等待当前任务完成后再发送新消息')
  }
  if (run.surface === 'inspiration' && projectRuns.filter((item) => item.surface === 'inspiration').length >= MAX_READ_ONLY_AI_TASKS_PER_PROJECT) {
    throw new Error(`该项目同时最多允许 ${MAX_READ_ONLY_AI_TASKS_PER_PROJECT} 个只读任务`)
  }
  if (run.surface === 'inspiration' && run.sessionScope && projectRuns.some((item) => item.surface === 'inspiration' && item.sessionScope === run.sessionScope)) {
    throw new Error('该灵感对话已有处理中的任务，请先等待当前回答完成')
  }
  activeAiRuns.set(run.id, run)
}

async function withAiRun<T>(run: ActiveAiRun, controller: AbortController, operation: () => Promise<T>): Promise<T> {
  registerAiRun(run)
  aiAbortControllers.set(run.id, controller)
  try {
    const project = await readProjectInfo(run.projectPath)
    if (!project) throw new Error('AI 任务所属项目不存在或已不再有效')
    return await aiProjectContext.run(project, operation)
  } finally {
    aiAbortControllers.delete(run.id)
    aiCancelRequests.delete(run.id)
    activeAiRuns.delete(run.id)
  }
}

async function resolveAiProject(options?: AiCreateCodeOptions): Promise<ProjectInfo> {
  const requestedPath = options?.projectPath?.trim()
  if (!requestedPath) return requireProject()
  const project = await readProjectInfo(path.resolve(requestedPath))
  if (!project) throw new Error('AI 任务指定的项目不存在或不是有效 ModMind 项目')
  return project
}

function aiProjectTaskState(projectPath: string): AiProjectTaskState {
  const runs = runsForProject(projectPath)
  const workspaceRun = runs.find((run) => run.surface === 'workspace')
  const conversationId = workspaceRun?.sessionScope?.startsWith('workspace/')
    ? workspaceRun.sessionScope.slice('workspace/'.length) || undefined
    : undefined
  return {
    ...(workspaceRun?.sessionId ? { codingSessionId: workspaceRun.sessionId } : {}),
    ...(workspaceRun?.startedAt ? { startedAt: workspaceRun.startedAt } : {}),
    ...(conversationId ? { activeConversationId: conversationId } : {}),
    ...(workspaceRun?.backend ? { backend: workspaceRun.backend } : {}),
    readOnlyTaskCount: runs.filter((run) => run.surface === 'inspiration').length
  }
}

function remoteInvokeEvent(onActivity: (text: string, progress?: number) => void): Electron.IpcMainInvokeEvent {
  const sender = {
    id: REMOTE_SENDER_ID,
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => {
      if (channel === 'ai:progress' && value && typeof value === 'object') {
        const item = value as { title?: unknown; detail?: unknown; status?: unknown }
        const title = typeof item.title === 'string' ? item.title : '工作台状态更新'
        const detail = typeof item.detail === 'string' ? item.detail : ''
        onActivity(`${title}${detail ? `：${detail}` : ''}`)
      } else if (channel === 'ai:output' && value && typeof value === 'object') {
        const item = value as { kind?: unknown; content?: unknown }
        if (item.kind === 'response' || item.kind === 'error' || item.kind === 'warning') {
          onActivity(typeof item.content === 'string' ? item.content : '工作台输出已更新')
        }
      }
    }
  }
  return { sender } as unknown as Electron.IpcMainInvokeEvent
}

async function runRemoteWorkbenchTask(prompt: string, callbacks: { signal?: AbortSignal; onActivity?: (text: string, progress?: number) => void }): Promise<{ summary: string; result?: Record<string, unknown>; changedFiles?: string[] }> {
  const project = requireProject()
  const settings = await readSettings()
  const backend = settings.codingBackend
  const workbenchAgent = backend === 'quota' ? 'codex' : backend
  const workbenchModel = backend === 'quota'
    ? (await readBeginnerAiPreferences()).model
    : settings.externalAgents?.[backend]?.model
  const controller = new AbortController()
  const signal = callbacks.signal
  const abortFromRemote = (): void => controller.abort()
  signal?.addEventListener('abort', abortFromRemote, { once: true })
  const run: ActiveAiRun = { id: aiRunId(REMOTE_SENDER_ID, project.path), senderId: REMOTE_SENDER_ID, startedAt: new Date().toISOString(), projectPath: project.path, executionProfile: 'standard', backend, surface: 'workspace' }
  try {
    callbacks.onActivity?.(`已打开工作台，使用 Agent：${workbenchAgent}${backend === 'quota' ? '（ModMind 额度）' : ''}${workbenchModel ? `，模型：${workbenchModel}` : ''}`, 0.22)
    callbacks.onActivity?.('工作台已接收任务，正在启动项目 Agent', 0.25)
    const result = await withAiRun(run, controller, () => runExternalCodingAgent(
      remoteInvokeEvent((text, progress) => callbacks.onActivity?.(text, progress)), prompt, undefined, backend, 'standard', undefined, { sessionScope: 'workspace/remote' }, controller.signal
    ))
    return { summary: result.summary, result: { tasks: result.tasks, tests: result.tests, intent: result.intent, workbenchAgent, ...(workbenchModel ? { workbenchModel } : {}) }, changedFiles: result.changedFiles }
  } finally {
    signal?.removeEventListener('abort', abortFromRemote)
  }
}

async function startRemoteClientIfPossible(force = false): Promise<RemoteConnectionState> {
  if (!force && !(await readRemoteEnabled())) return { status: 'disabled', enabled: false }
  if (force) await writeRemoteEnabled(true)
  if (!(await readDeviceCredentials())) return { status: 'disabled', enabled: false, lastError: '请先连接 ModMind 账号' }
  if (remoteClient) return remoteClient.start()
  const endpoint = remoteEndpoint()
  if (!endpoint) return { status: 'disabled', enabled: false }
  const deviceId = remoteDeviceId ??= await readRemoteDeviceId()
  const controller = new RemoteControllerAgent(
    remoteQuotaConfig,
    { getState: remoteAppState, execute: executeRemoteAppAction },
    { run: runRemoteWorkbenchTask }
  )
  remoteClient = new RemoteClientService(endpoint, deviceId, os.hostname().slice(0, 100), app.getVersion(), {
    getCredential: async () => (await readDeviceCredentials())?.apiKey ?? null,
    onCommand: (command, context) => controller.handle(command.text, { signal: context.signal, onActivity: context.activity }),
    onCancel: async (_message: RemoteServerCancel) => {
      for (const run of activeAiRuns.values()) if (run.senderId === REMOTE_SENDER_ID) aiAbortControllers.get(run.id)?.abort()
      return '取消请求已处理'
    },
    onState: (state) => {
      diagnosticJournal.record({ subsystem: 'remote', operation: 'connection', phase: state.status, level: state.status === 'error' ? 'error' : state.status === 'backoff' ? 'warning' : 'info', message: state.lastError || `Remote state: ${state.status}`, data: state })
      if (state.status === 'disabled' && state.lastError) void writeRemoteEnabled(false)
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('remote:state', state)
    }
  })
  return remoteClient.start()
}

async function stopRemoteClient(persist = false): Promise<RemoteConnectionState> {
  if (persist) await writeRemoteEnabled(false)
  if (!remoteClient) return { status: 'disabled', enabled: false }
  const client = remoteClient
  remoteClient = null
  return client.stop()
}

function assertProjectSwitchAllowed(): void {
  if (localServerManager?.isRunning()) throw new Error('本机服务端正在运行，请先停止后再切换项目')
}

function assertProjectMutationAllowed(projectPath: string, action: string): void {
  const agentProject = aiProjectContext.getStore()
  if (agentProject && sameProjectPath(agentProject.path, projectPath)) return
  if (runsForProject(projectPath).length) throw new Error(`该项目存在运行中的 AI 任务，暂时不能${action}`)
}

interface SnapshotManifest extends SnapshotInfo {
  files?: string[]
  hashes?: Record<string, string>
  fileMetadata?: Record<string, SnapshotFileMetadata>
  taskId?: string
  projectPath?: string
}

type AiWorkflowStage = 'project_info' | 'intent' | 'plan' | 'implementation' | 'validate' | 'build' | 'runtime_test' | 'managed_download' | 'todo_complete'

type ManagedDownloadAction = 'dependency_install' | 'maven_dependency_install' | 'addon_prepare' | 'modpack_apply_plan' | 'modpack_apply_optimization_profile' | 'modpack_download_content'

type ManagedNativeDownloadAction = ManagedDownloadAction | 'runtime_download'

interface ManagedDownloadFailure {
  action: ManagedDownloadAction
  message: string
}

interface ManagedDownloadRequirement {
  capability: string
  actions: ManagedDownloadAction[]
}

const MANAGED_DOWNLOAD_POLICY = `MANAGED DOWNLOAD POLICY. When ModMind already provides a managed path for a requested download, that path is mandatory. For a request to extend or integrate with another mod, use modmind_addon_prepare before editing; it resolves compatible target mods and transitive dependencies, verified runtime JARs, exact-version sources when available, Gradle and loader metadata, and test-instance files. Then use modmind_addon_relationships and prefer its exact-version sourcePath, falling back to artifactPath; respect the recorded source license and never copy source unless permitted. Use modmind_dependency_install for ordinary non-addon Modrinth Java dependencies, modmind_maven_dependency_install for Maven coordinates, modmind_modpack_plan followed by modmind_modpack_apply_plan for modpack mods and their dependencies, modmind_modpack_apply_optimization_profile for its managed optimization mods, and modmind_modpack_download_content for HTTPS pack content such as configs, scripts, datapacks, resource packs, shader packs, worlds, and client/server files. Java, Gradle, loader, Minecraft assets, HeadlessMC, server runtime, and JDK downloads are already owned by ModMind's build, test, runtime, and server-pack tools; let those tools perform them. Do not use curl, wget, browser downloads, git clones, or ad-hoc scripts to replace a covered path. Only after the matching ModMind tool has actually failed may native download be used as a fallback; preserve the failure and report the fallback source and verification. Native downloads remain allowed for resources ModMind does not implement.`

interface AiWorkflowState {
  required: AiWorkflowStage[]
  completed: AiWorkflowStage[]
  evidence: Partial<Record<AiWorkflowStage, string>>
}

// Only completion evidence is a hard gate. Planning helpers such as project
// info, intent classification, and Todo remain useful but optional.
const ENGINEERING_WORKFLOW_STAGES: AiWorkflowStage[] = ['implementation', 'validate', 'build']
const INFORMATIONAL_WORKFLOW_STAGES: AiWorkflowStage[] = []

interface ActiveAiTask {
  taskId: string
  runId?: string
  projectPath: string
  snapshotId: string
  startedAt: string
  changedFiles: string[]
  prompt: string
  surface?: AiSurface
  conversationId?: string
  sessionScope?: string
  sessionId?: string
  backend?: AgentSettings['codingBackend']
  /** Native CLI handles are implementation details of one unified task. */
  nativeSessions?: Partial<Record<AgentSettings['codingBackend'], string>>
  contextRevision?: number
  executionProfile?: AiExecutionProfile
  lifecycle?: 'running' | 'waiting_retry' | 'repairing' | 'action_required' | 'paused'
  recovery?: {
    category: ExternalAgentRetryState['category'] | 'action-required' | 'cancelled'
    attempt: number
    message: string
    nextAttemptAt?: string
  }
  workflow?: AiWorkflowState
  state: {
    lastBuildSucceeded: boolean
    summary: string
    tasks: string[]
    tests: string[]
    warnings: string[]
    applyRounds: number
    buildCount?: number
    reviewFeedback?: string
    reviewRound?: number
    managedDownloads?: ManagedDownloadAction[]
    managedDownloadFailures?: ManagedDownloadFailure[]
    nativeCoveredDownloads?: ManagedNativeDownloadAction[]
    intent?: 'engineering' | 'informational'
    todo?: AgentTodoItem[]
  }
}

function managedDownloadRequirements(project: ProjectInfo, prompt: string, changedFiles: string[], nativeCoveredDownloads: ManagedNativeDownloadAction[] = []): ManagedDownloadRequirement[] {
  const files = changedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase())
  const addonChange = isJavaLoader(project.loader)
    && files.some((file) => file === 'modmind.relationships.json')
  const managedJarChange = isJavaLoader(project.loader)
    && !addonChange
    && files.some((file) => file === 'modmind.dependencies.json' || /^libs\/modmind\/[^/]+\.jar$/i.test(file))
  const dependencyBuildChange = isJavaLoader(project.loader)
    && files.some((file) => /^(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/i.test(file))
    && /dependency|dependencies|maven|modrinth|curseforge|library|libraries|sdk|\u4f9d\u8d56|\u5e93|\u5b89\u88c5|\u4e0b\u8f7d/i.test(prompt)
  const modpackChange = project.kind === 'modpack'
    && files.some((file) => file === 'modmind.modpack.lock.json' || /^mods\/[^/]+\.jar$/i.test(file))
  const modpackContentChange = project.kind === 'modpack'
    && files.some((file) => /^(?:config|defaultconfigs|serverconfig|kubejs|scripts|datapacks|openloader|paxi|resourcepacks|shaderpacks|saves|fancymenu_data|defaultoptions)\//i.test(file)
    && /download|url|https|resource\s*pack|shader|world|datapack|config|script|\u4e0b\u8f7d|\u8d44\u6e90\u5305|\u5149\u5f71|\u4e16\u754c|\u6570\u636e\u5305/i.test(prompt))
  const requirements = [
    ...(addonChange ? [{ capability: 'addon_relationship', actions: ['addon_prepare'] as ManagedDownloadAction[] }] : []),
    ...(managedJarChange || dependencyBuildChange ? [{ capability: 'java_dependency', actions: ['dependency_install', 'maven_dependency_install'] as ManagedDownloadAction[] }] : []),
    ...(modpackChange ? [{ capability: 'modpack_mods', actions: ['modpack_apply_plan', 'modpack_apply_optimization_profile'] as ManagedDownloadAction[] }] : []),
    ...(modpackContentChange ? [{ capability: 'modpack_content', actions: ['modpack_download_content'] as ManagedDownloadAction[] }] : [])
  ]
  const nativeRequirements = nativeCoveredDownloads
    .filter((action): action is ManagedDownloadAction => action !== 'runtime_download')
    .map((action) => ({ capability: `native_${action}`, actions: [action] }))
  return [...requirements, ...nativeRequirements]
}

function updateManagedDownloadAudit(workflow: AiWorkflowState, project: ProjectInfo, prompt: string, changedFiles: string[], managedDownloads: ManagedDownloadAction[], failures: ManagedDownloadFailure[], nativeCoveredDownloads: ManagedNativeDownloadAction[] = []): void {
  const requirements = managedDownloadRequirements(project, prompt, changedFiles, nativeCoveredDownloads)
  if (!requirements.length) return
  workflow.required = [...new Set([...workflow.required, 'managed_download' as const])]
  const satisfied = requirements.every((requirement) => requirement.actions.some((action) => managedDownloads.includes(action)
    || failures.some((failure) => failure.action === action)))
  if (satisfied) {
    const evidence = requirements.map((requirement) => {
      const used = requirement.actions.find((action) => managedDownloads.includes(action))
      if (used) return `${requirement.capability}: ${used}`
      const failed = failures.find((failure) => requirement.actions.includes(failure.action))
      return `${requirement.capability}: managed path ${failed?.action ?? 'unknown'} failed; native fallback allowed`
    })
    markWorkflowStage(workflow, 'managed_download', evidence.join('; '))
  }
}

async function listSnapshotManagedFiles(root: string): Promise<string[]> {
  return listManagedFiles(root, (name) => ignoredDirectories.has(name) || isToolDataDirectory(name))
}

async function restoreSnapshotFilesExact(snapshotRoot: string, destinationRoot: string, expectedFiles: string[]): Promise<void> {
  await restoreManagedTreeExact(
    snapshotRoot,
    destinationRoot,
    expectedFiles,
    (name) => ignoredDirectories.has(name) || isToolDataDirectory(name),
    copySnapshotFiles
  )
}

async function readSnapshotManifest(project: ProjectInfo, id: string): Promise<{ manifest: SnapshotManifest; root: string }> {
  const validId = validateSnapshotId(id)
  const directory = path.join(project.path, projectDataDirectory(project), 'snapshots', validId)
  const root = path.join(directory, 'files')
  const manifest = await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8')
    .then((value) => JSON.parse(value) as SnapshotManifest)
    .catch(() => null)
  if (!manifest) throw new Error('找不到属于当前项目的有效快照')
  if (!snapshotManifestBelongsToProject(manifest, validId, project.path)) {
    throw new Error('找不到属于当前项目的有效快照')
  }
  if (!(await pathExists(root))) throw new Error('快照文件不完整，无法恢复')
  return { manifest, root }
}

async function restoreSnapshotTree(project: ProjectInfo, snapshot: { manifest: SnapshotManifest; root: string }): Promise<void> {
  const expectedFiles = snapshot.manifest.files ?? await listSnapshotManagedFiles(snapshot.root)
  const manifestNames = new Set([currentProjectManifest])
  if (!expectedFiles.some((file) => manifestNames.has(file))) {
    throw new Error('快照缺少 ModMind 项目清单，无法恢复')
  }
  await restoreSnapshotFilesExact(snapshot.root, project.path, expectedFiles)
}

async function restoreProjectSnapshot(id: string, projectPath?: string): Promise<SnapshotRestoreResult> {
  assertProjectSwitchAllowed()
  const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
  if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
  if (!currentProject || !sameProjectPath(currentProject.path, project.path)) throw new Error('快照恢复只能作用于当前前台项目')
  assertProjectMutationAllowed(project.path, '恢复快照')
  const activeAiTask = await readActiveAiTask(project)
  const agentProject = aiProjectContext.getStore()
  if (activeAiTask && (!agentProject || !sameProjectPath(agentProject.path, project.path))) {
    throw new Error('存在待处理的 AI 恢复任务，请先继续任务或恢复 AI 修改前状态')
  }
  const runtime = await requireMinecraftRuntime().refresh()
  if (runtime.running || !['idle', 'stopped', 'error'].includes(runtime.stage)) {
    throw new Error('Minecraft 或构建任务正在运行，请停止后再恢复快照')
  }

  const selected = await readSnapshotManifest(project, id)
  const backup = await createProjectSnapshot(`恢复 ${selected.manifest.label} 前的自动备份`)
  const rollback = await readSnapshotManifest(project, backup.id)
  try {
    await restoreSnapshotTree(project, selected)
    const restoredProject = await readProjectInfo(project.path)
    if (!restoredProject) throw new Error('恢复后的项目清单无效')
    currentProject = restoredProject
    await rememberRecentProject(restoredProject)
    return { snapshot: selected.manifest, backup, project: restoredProject }
  } catch (error) {
    try {
      await restoreSnapshotTree(project, rollback)
      currentProject = project
    } catch (rollbackError) {
      throw new Error(
        `快照恢复失败，自动回滚也失败。安全备份 ${backup.id} 已保留。\n恢复错误：${error instanceof Error ? error.message : String(error)}\n回滚错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    throw new Error(`快照恢复失败，已自动回滚到操作前状态：${error instanceof Error ? error.message : String(error)}`)
  }
}

function modpackMigrationDirectory(project: ProjectInfo, migrationId?: string): string {
  const root = path.join(project.path, projectDataDirectory(project), 'migrations')
  return migrationId ? path.join(root, migrationId) : root
}

function validateMigrationId(value: unknown): string {
  if (typeof value !== 'string' || !/^migration-[0-9A-Za-z._-]{1,120}$/.test(value)) throw new Error('迁移记录 ID 无效')
  return value
}

async function writeModpackMigrationRecord(project: ProjectInfo, record: ModpackMigrationRecord): Promise<void> {
  const directory = modpackMigrationDirectory(project, record.id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'migration.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

async function readModpackMigrationRecord(project: ProjectInfo, migrationId: string): Promise<ModpackMigrationRecord> {
  const id = validateMigrationId(migrationId)
  const record = await fs.readFile(path.join(modpackMigrationDirectory(project, id), 'migration.json'), 'utf8')
    .then((value) => JSON.parse(value) as ModpackMigrationRecord)
    .catch(() => null)
  if (!record || record.id !== id || !['backup', 'direct'].includes(record.mode) || !['complete', 'incomplete', 'undone'].includes(record.status)) {
    throw new Error('找不到有效的迁移记录')
  }
  return record
}

async function listModpackMigrationRecords(project: ProjectInfo): Promise<ModpackMigrationRecord[]> {
  const root = modpackMigrationDirectory(project)
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const records: ModpackMigrationRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('migration-')) continue
    const record = await readModpackMigrationRecord(project, entry.name).catch(() => null)
    if (record) records.push(record)
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

async function preserveDirectMigrationSources(project: ProjectInfo, migrationId: string): Promise<void> {
  const manifest = await readModpackManifest(project)
  const modsRoot = modpackModsRoot(project, manifest)
  const destination = path.join(modpackMigrationDirectory(project, migrationId), 'evidence', 'source-jars')
  await fs.mkdir(destination, { recursive: true })
  for (const mod of manifest.mods) {
    const source = path.join(modsRoot, mod.fileName)
    const stat = await fs.stat(source).catch(() => null)
    if (stat?.isFile()) await fs.copyFile(source, path.join(destination, mod.fileName))
  }
}

async function applyModpackMigrationInPlace(
  project: ProjectInfo,
  target: Awaited<ReturnType<LoaderCatalog['resolve']>>,
  input: ModpackMigrationCreateInput
): Promise<ModpackMigrationCreateResult> {
  assertProjectSwitchAllowed()
  assertProjectMutationAllowed(project.path, '迁移版本')
  const mode: ModpackMigrationMode = input.mode === 'direct' ? 'direct' : 'backup'
  const migrationId = `migration-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-modpack-migration-'))
  const stagedRoot = path.join(temporaryRoot, 'target')
  const rollbackRoot = path.join(temporaryRoot, 'rollback')
  let sourceSnapshot: SnapshotInfo | undefined
  let sourceSnapshotTree: Awaited<ReturnType<typeof readSnapshotManifest>> | undefined
  let rollbackFiles: string[] = []
  let commitStarted = false
  try {
    if (mode === 'backup') {
      sourceSnapshot = await createProjectSnapshot(`整合包迁移前：${project.loader} ${project.minecraftVersion} -> ${target.loader} ${target.minecraftVersion}`)
      sourceSnapshotTree = await readSnapshotManifest(project, sourceSnapshot.id)
    } else {
      await copySnapshotFiles(project.path, rollbackRoot)
      rollbackFiles = await listSnapshotManagedFiles(rollbackRoot)
      await preserveDirectMigrationSources(project, migrationId)
    }

    const generated = await createModpackMigration(
      requireModProviderRegistry(),
      project,
      target,
      { ...input, mode },
      stagedRoot,
      copyBundledGradleWrapper,
      mcmodService
    )
    const migratedProject: ProjectInfo = { ...generated.project, path: project.path }
    await fs.writeFile(path.join(stagedRoot, currentProjectManifest), `${JSON.stringify(migratedProject, null, 2)}\n`, 'utf8')
    const expectedFiles = await listSnapshotManagedFiles(stagedRoot)
    if (!expectedFiles.includes(currentProjectManifest) || !expectedFiles.includes('modmind.pack.json')) {
      throw new Error('暂存迁移项目缺少必要清单，未修改原项目')
    }

    commitStarted = true
    await restoreSnapshotFilesExact(stagedRoot, project.path, expectedFiles)
    const committed = await readProjectInfo(project.path)
    if (!committed || committed.kind !== 'modpack' || committed.loader !== target.loader || committed.minecraftVersion !== target.minecraftVersion) {
      throw new Error('迁移提交后的项目清单无效')
    }
    const reportPath = path.join(project.path, path.relative(stagedRoot, generated.reportPath))
    const archivedReportPath = path.join(modpackMigrationDirectory(project, migrationId), 'reports', 'modpack-migration-report.md')
    await fs.mkdir(path.dirname(archivedReportPath), { recursive: true })
    await fs.copyFile(reportPath, archivedReportPath)
    const createdAt = new Date().toISOString()
    const record: ModpackMigrationRecord = {
      id: migrationId,
      mode,
      status: generated.status,
      source: { loader: project.loader, minecraftVersion: project.minecraftVersion, loaderVersion: project.loaderVersion },
      target: { loader: committed.loader, minecraftVersion: committed.minecraftVersion, loaderVersion: committed.loaderVersion },
      ...(sourceSnapshot ? { sourceSnapshotId: sourceSnapshot.id } : {}),
      reportPath: archivedReportPath,
      deferred: generated.deferred,
      createdAt,
      completedAt: createdAt
    }
    const generatedEvidence = path.join(project.path, 'docs', 'migration-evidence')
    const storedEvidence = path.join(modpackMigrationDirectory(project, migrationId), 'evidence')
    if (await fs.stat(generatedEvidence).then((stat) => stat.isDirectory()).catch(() => false)) {
      await fs.mkdir(storedEvidence, { recursive: true })
      await fs.cp(generatedEvidence, storedEvidence, { recursive: true })
    }
    const recordDirectory = modpackMigrationDirectory(project, migrationId)
    await fs.writeFile(path.join(recordDirectory, 'decisions.json'), `${JSON.stringify({ mods: input.mods, modules: input.modules, content: input.content }, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(recordDirectory, 'result.json'), `${JSON.stringify({
      status: generated.status,
      installed: generated.installed,
      manualFiles: generated.manualFiles,
      removed: generated.removed,
      deferred: generated.deferred,
      portedModules: generated.portedModules,
      copiedContent: generated.copiedContent,
      warnings: generated.warnings
    }, null, 2)}\n`, 'utf8')
    await writeModpackMigrationRecord(committed, record)
    currentProject = committed
    await rememberRecentProject(committed)
    emitProjectChanged()
    return {
      ...generated,
      project: committed,
      migrationId,
      mode,
      sourceSnapshotId: sourceSnapshot?.id,
      canUndo: Boolean(sourceSnapshot),
      reportPath
    }
  } catch (error) {
    if (commitStarted) {
      try {
        if (sourceSnapshotTree) await restoreSnapshotTree(project, sourceSnapshotTree)
        else if (rollbackFiles.length) await restoreSnapshotFilesExact(rollbackRoot, project.path, rollbackFiles)
        currentProject = project
        emitProjectChanged()
      } catch (rollbackError) {
        throw new Error(`整合包迁移失败，自动回滚也失败。\n迁移错误：${error instanceof Error ? error.message : String(error)}\n回滚错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
    }
    if (mode === 'direct') await fs.rm(modpackMigrationDirectory(project, migrationId), { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function undoModpackMigration(project: ProjectInfo, migrationId: string): Promise<ModpackMigrationUndoResult> {
  const record = await readModpackMigrationRecord(project, migrationId)
  if (record.status === 'undone') throw new Error('该迁移已经撤销')
  if (!record.sourceSnapshotId) throw new Error('直接迁移没有迁移前备份，不能一键撤销')
  const restored = await restoreProjectSnapshot(record.sourceSnapshotId, project.path)
  const updated: ModpackMigrationRecord = {
    ...record,
    status: 'undone',
    preUndoSnapshotId: restored.backup.id,
    undoneAt: new Date().toISOString()
  }
  await writeModpackMigrationRecord(restored.project, updated)
  currentProject = restored.project
  emitProjectChanged()
  return { migration: updated, restoredProject: restored.project, preUndoSnapshot: restored.backup }
}

async function deleteProjectSnapshot(id: string, projectPath?: string): Promise<SnapshotInfo[]> {
  const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
  if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
  assertProjectMutationAllowed(project.path, '删除快照')
  const selected = await readSnapshotManifest(project, id)
  const migration = (await listModpackMigrationRecords(project)).find((record) =>
    (record.status !== 'undone' && record.sourceSnapshotId === selected.manifest.id)
    || record.preUndoSnapshotId === selected.manifest.id)
  if (migration) throw new Error(`该快照是迁移 ${migration.id} 的恢复依据，不能从普通快照列表删除`)
  const active = await readActiveAiTask(project)
  if (active?.snapshotId === selected.manifest.id) throw new Error('不能删除当前 AI 恢复任务依赖的快照')
  await fs.rm(path.dirname(selected.root), { recursive: true, force: true })
  const root = path.join(project.path, projectDataDirectory(project), 'snapshots')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const snapshots: SnapshotInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      snapshots.push(JSON.parse(await fs.readFile(path.join(root, entry.name, 'snapshot.json'), 'utf8')) as SnapshotInfo)
    } catch {
      // Ignore incomplete snapshots.
    }
  }
  return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function stageHeadlessMinecraftMods(project: ProjectInfo, artifact: MinecraftManagedMod): Promise<string> {
  const sourceDirectory = path.join(project.path, projectDataDirectory(project), 'headlessmc', 'source-mods')
  await fs.rm(sourceDirectory, { recursive: true, force: true })
  await fs.mkdir(sourceDirectory, { recursive: true })
  if (project.kind === 'modpack') {
    const runtimeModsDirectory = path.join(project.path, projectDataDirectory(project), 'minecraft', 'mods')
    const entries = await fs.readdir(runtimeModsDirectory, { withFileTypes: true }).catch(() => [])
    const jars = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    await Promise.all(jars.map((entry) => fs.copyFile(path.join(runtimeModsDirectory, entry.name), path.join(sourceDirectory, entry.name))))
  } else {
    const stat = await fs.stat(artifact.path).catch(() => null)
    if (!stat?.isFile() || !artifact.path.toLowerCase().endsWith('.jar')) throw new Error('构建产物不是可用于 HeadlessMC 的 Mod JAR')
    await fs.copyFile(artifact.path, path.join(sourceDirectory, path.basename(artifact.path)))
  }
  const staged = await fs.readdir(sourceDirectory, { withFileTypes: true })
  if (!staged.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))) {
    throw new Error('没有可用于 HeadlessMC 冒烟测试的 Mod JAR')
  }
  return sourceDirectory
}

async function runHeadlessMinecraftSmokeUnlocked(
  project: ProjectInfo,
  signal?: AbortSignal,
  options: { artifact?: MinecraftManagedMod; stableWindowMs?: number; offline?: boolean } = {}
): Promise<HeadlessSmokeTestResult> {
  if (!supportsHeadlessMc(project.loader)) throw new Error(`HeadlessMC 当前仅支持 Fabric、Forge 和 NeoForge，当前项目为 ${project.loader}`)
  const runtime = requireMinecraftRuntime()
  const artifact = options.artifact
    ?? (runtime.getState().running
      ? (await runtime.listMods()).find((mod) => mod.projectArtifact)
      : await buildProjectWithLock(signal))
  if (!artifact) {
    throw new Error(runtime.getState().running
      ? 'Minecraft 测试实例正在运行，但没有找到已同步的项目 JAR；请停止实例并重新构建'
      : '构建未生成可用于 HeadlessMC 的 Mod JAR')
  }
  const sourceDirectory = await stageHeadlessMinecraftMods(project, artifact)
  try {
    const javaPath = await runtime.ensureJavaRuntime()
    // Prepare the mirrored managed runtime first: HeadlessMC then reuses its
    // versions/libraries/assets via hmc.mcdir instead of re-downloading
    // Mojang-hosted content directly. A failed managed download is a failed
    // test setup, not a reason to silently start a second download pipeline.
    await requireManagedRuntimePreparation(() => runtime.prepare(signal), (error) => {
      diagnosticJournal.record({
        subsystem: 'minecraft',
        operation: 'headless-smoke',
        phase: 'error',
        message: '受管 Minecraft 运行时准备失败，已停止 HeadlessMC 回退下载',
        error
      })
    })
    const preparedState = runtime.getState()
    if (!preparedState.loaderVersionId) throw new Error('Minecraft 运行时已准备，但缺少精确 Loader profile')
    return await requireHeadlessMc().run({
      project,
      gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'game'),
      sourceModsDirectory: sourceDirectory,
      javaPath,
      managedMinecraftDirectory: runtime.managedMinecraftDirectory(),
      loaderVersionId: preparedState.loaderVersionId,
      stableWindowMs: options.stableWindowMs ?? 20_000,
      offline: options.offline !== false
    }, signal)
  } finally {
    await fs.rm(sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runHeadlessMinecraftSmoke(
  project: ProjectInfo,
  signal?: AbortSignal,
  options: { artifact?: MinecraftManagedMod; stableWindowMs?: number; offline?: boolean } = {}
): Promise<HeadlessSmokeTestResult> {
  return withMinecraftResourceLock(() => runHeadlessMinecraftSmokeUnlocked(project, signal, options))
}

async function runProjectTestMatrixUnlocked(
  targets: TestTarget[],
  signal?: AbortSignal,
  onProgress?: (target: TestTarget, completed: number, total: number) => void
): Promise<TestMatrixResult> {
  const activeProject = requireProject()
  const selectedInput = new Set(Array.isArray(targets) ? targets : [])
  const selected = (['build', 'client', 'server', 'gametest'] as TestTarget[]).filter((target) => selectedInput.has(target))
  const startedAt = new Date().toISOString()
  const results: TestMatrixResult['results'] = []
  let buildPassed = false
  const runtime = requireMinecraftRuntime()

  const runGradleTarget = async (target: TestTarget, tasks: string[], stableWindowMs = 0): Promise<void> => {
    const started = Date.now()
    try {
      const result = await runtime.testGradleTask(tasks, stableWindowMs, signal)
      results.push({
        target,
        status: result.skipped ? 'skipped' : result.success ? 'passed' : 'failed',
        summary: result.summary,
        durationMs: Date.now() - started,
        logPath: result.logPath
      })
    } catch (error) {
      results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
    } finally {
      await runtime.stop().catch(() => undefined)
    }
  }

  for (const target of selected) {
    if (signal?.aborted) throw Object.assign(new Error('测试矩阵已取消'), { name: 'AbortError' })
    if (target === 'build') {
      const started = Date.now()
      try {
        const artifact = await buildProjectWithLock(signal)
        buildPassed = true
        results.push({ target, status: 'passed', summary: `${artifact.name} · ${(artifact.size / 1024).toFixed(1)} KB`, durationMs: Date.now() - started })
      } catch (error) {
        results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
      }
    } else if (target === 'client') {
      const started = Date.now()
      try {
        const artifact: MinecraftManagedMod | undefined = buildPassed
          ? (await runtime.listMods()).find((mod) => mod.projectArtifact) ?? await buildProjectWithLock(signal)
          : await buildProjectWithLock(signal)
        buildPassed = Boolean(artifact)
        if (!artifact) throw new Error('构建未生成可用于 HeadlessMC 的 Mod JAR')
        const result = await runHeadlessMinecraftSmokeUnlocked(activeProject, signal, { artifact, stableWindowMs: 20_000, offline: true })
        results.push({ target, status: result.success ? 'passed' : 'failed', summary: result.message, durationMs: Date.now() - started })
      } catch (error) {
        results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
      } finally {
        await runtime.stop().catch(() => undefined)
      }
    } else if (target === 'server') {
      if (isModpackProject(activeProject)) {
        const started = Date.now()
        try {
          const pack = await buildServerPack(activeProject, { outputDirectory: path.join(activeProject.path, projectDataDirectory(activeProject), 'test-server-pack'), acceptEula: true, port: 25565 })
          results.push({ target, status: 'passed', summary: `server pack generated (${pack.copiedMods.length} mods)`, durationMs: Date.now() - started, logPath: pack.manifestPath })
        } catch (error) {
          results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
        }
      } else {
        await runGradleTarget(target, ['runServer'], 15_000)
      }
    } else {
      if (isModpackProject(activeProject)) results.push({ target, status: 'skipped', summary: '整合包 GameTest 需要显式场景适配器；当前仅完成客户端启动和服务端包验收', durationMs: 0 })
      else await runGradleTarget(target, ['runGameTestServer', 'runGametest', 'runGameTest', 'gameTestServer'])
    }
    onProgress?.(target, results.length, selected.length)
  }

  return { success: results.every((result) => result.status !== 'failed'), startedAt, completedAt: new Date().toISOString(), results }
}

async function runProjectTestMatrix(
  targets: TestTarget[],
  signal?: AbortSignal,
  onProgress?: (target: TestTarget, completed: number, total: number) => void
): Promise<TestMatrixResult> {
  return withMinecraftResourceLock(() => runProjectTestMatrixUnlocked(targets, signal, onProgress))
}

function publicMcpTodoTasks(input: unknown): AgentTodoItem[] {
  if (!Array.isArray(input) || input.length > 500) throw new Error('todo list is invalid or too large')
  const ids = new Set<string>()
  return input.map((value, index): AgentTodoItem => {
    if (!value || typeof value !== 'object') throw new Error(`todo ${index + 1} is invalid`)
    const item = value as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const status = item.status
    if (!id || id.length > 64 || ids.has(id)) throw new Error(`todo ${index + 1} has an invalid or duplicate id`)
    if (!title || title.length > 240) throw new Error(`todo ${id} has an invalid title`)
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new Error(`todo ${id} has an invalid status`)
    ids.add(id)
    return { id, title, status }
  })
}

function publicMcpOutputDirectory(project: ProjectInfo, input: Record<string, unknown>, fallback: string): string {
  const raw = typeof input.outputDirectory === 'string' && input.outputDirectory.trim() ? input.outputDirectory.trim() : fallback
  const target = path.resolve(project.path, raw)
  const root = path.resolve(project.path)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('outputDirectory must stay inside the active project')
  return target
}

async function resolveAddonImportPaths(project: ProjectInfo, values: string[]): Promise<string[]> {
  if (!values.length || values.length > 100) throw new Error('add-on import requires between 1 and 100 project-relative JAR paths')
  const root = path.resolve(project.path)
  const resolved: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || path.isAbsolute(value)) throw new Error('add-on import paths must be project-relative')
    const target = path.resolve(project.path, ...value.replaceAll('\\', '/').split('/'))
    if (!target.startsWith(`${root}${path.sep}`) || path.extname(target).toLowerCase() !== '.jar') throw new Error(`invalid add-on JAR path: ${value}`)
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isFile()) throw new Error(`add-on JAR does not exist: ${value}`)
    resolved.push(target)
  }
  return resolved
}

function normalizeAddonPrepareInput(input: Record<string, unknown> | AddonPrepareInput): AddonPrepareInput {
  const names = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))].slice(0, 100)
    : []
  const providers = Array.isArray(input.providers)
    ? input.providers.filter((entry): entry is 'modrinth' | 'curseforge' => entry === 'modrinth' || entry === 'curseforge')
    : undefined
  const required = names(input.required)
  const optional = names(input.optional)
  if (!required.length && !optional.length) throw new Error('at least one required or optional add-on target is required')
  return { required, optional, ...(providers?.length ? { providers } : {}) }
}

async function linkAddonProject(project: ProjectInfo, projectPath: string, signal?: AbortSignal): Promise<unknown> {
  const targetPath = path.resolve(projectPath.trim())
  const target = await readProjectInfo(targetPath)
  if (!target) throw new Error('linked path is not a ModMind project')
  const service = createAddonRelationshipService(() => project)
  return withMinecraftResourceLock(async () => {
    const artifact = await buildLinkedProjectTree(target, signal, [project.path])
    return service.linkProject(target, artifact)
  })
}

async function resolveModpackMigrationTarget(input: Record<string, unknown>): Promise<Awaited<ReturnType<LoaderCatalog['resolve']>>> {
  if (!isJavaLoader(input.loader) || typeof input.minecraftVersion !== 'string' || !input.minecraftVersion.trim()) {
    throw new Error('migration target requires a Java loader and Minecraft version')
  }
  return requireLoaderCatalog().resolve(input.loader, input.minecraftVersion.trim())
}

function normalizeMcpMigrationInput(project: ProjectInfo, input: Record<string, unknown>): ModpackMigrationCreateInput {
  if (!isJavaLoader(input.loader) || typeof input.minecraftVersion !== 'string' || !Array.isArray(input.mods) || !Array.isArray(input.modules) || !Array.isArray(input.content)) {
    throw new Error('migration apply requires loader, minecraftVersion, mods, modules, and content')
  }
  const root = path.resolve(project.path)
  const mods = input.mods.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('migration mod decision is invalid')
    const decision = { ...(value as Record<string, unknown>) }
    if (decision.action === 'manual-file') {
      if (typeof decision.filePath !== 'string' || path.isAbsolute(decision.filePath)) throw new Error('Agent manual migration JAR paths must be project-relative')
      const resolved = path.resolve(project.path, ...decision.filePath.replaceAll('\\', '/').split('/'))
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Agent manual migration JAR path must stay inside the project')
      decision.filePath = resolved
    }
    return decision
  }) as unknown as ModpackMigrationCreateInput['mods']
  return {
    loader: input.loader,
    minecraftVersion: input.minecraftVersion.trim(),
    mode: input.mode === 'direct' ? 'direct' : 'backup',
    mods,
    modules: input.modules as ModpackMigrationCreateInput['modules'],
    content: input.content as ModpackMigrationCreateInput['content']
  }
}

async function previewModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> {
  if (!isModpackProject(project)) throw new Error('current project is not a modpack')
  const target = await resolveModpackMigrationTarget(input)
  return assessModpackMigration(requireModProviderRegistry(), project, target, undefined, mcmodService)
}

async function applyModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<ModpackMigrationCreateResult> {
  if (!isModpackProject(project)) throw new Error('current project is not a modpack')
  const normalized = normalizeMcpMigrationInput(project, input)
  const target = await resolveModpackMigrationTarget(normalized as unknown as Record<string, unknown>)
  const result = await withMinecraftResourceLock(() => applyModpackMigrationInPlace(project, target, normalized))
  Object.assign(project, result.project)
  return result
}

async function createPublicMcpBridgeHandlers(project: ProjectInfo, signal: AbortSignal): Promise<ExternalAgentBridgeHandlers> {
  const localReviewConfig: AiReviewerConfig = {
    reviewMode: 'codex-auto',
    codexExecutable: process.platform === 'win32' ? 'codex.cmd' : 'codex',
    projectPath: project.path
  }
  const addonService = createAddonRelationshipService(() => project)
  const addonContext = await addonService.describeForAi().catch(() => null)
  const handlers: ExternalAgentBridgeHandlers = {
    projectInfo: { ...project, integrationDirectory: path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents'), ...(addonContext ? { addonRelationships: addonContext } : {}) },
    projectFiles: async () => {
      const files = await listManagedFiles(project.path, (name) => ignoredDirectories.has(name) || isToolDataDirectory(name))
      return { files: files.slice(0, 5_000), truncated: files.length > 5_000 }
    },
    reviewAction: (action, input) => reviewAiAction(localReviewConfig, { project, request: 'external MCP integration', action, input }, signal),
    renameProject: (name, namespace) => renameProjectRecord(project, { name, namespace }),
    setIntent: async (intent, reason) => {
      publicMcpIntent = intent
      return { success: true, intent, reason: reason.trim().slice(0, 500) }
    },
    applyEdits: async (values) => {
      if (!values.length) throw new Error('at least one edit is required')
      const settings = await readSettings()
      const staged = new Map<string, { target: string; content: string }>()
      for (const value of values) {
        if (!value || typeof value !== 'object') throw new Error('edit format is invalid')
        const source = value as Record<string, unknown>
        const normalized = normalizeCodingPath(String(source.path ?? ''), settings.allowBuildScriptChanges)
        if (typeof source.newText !== 'string') throw new Error(`edit ${normalized} is missing newText`)
        const oldText = typeof source.oldText === 'string' ? source.oldText : ''
        const target = await resolveSafeCodingTarget(normalized)
        const stagedFile = staged.get(normalized)
        const exists = stagedFile !== undefined || await pathExists(target)
        if (!oldText) {
          if (exists) throw new Error(`new file ${normalized} already exists; provide oldText for an exact edit`)
          staged.set(normalized, { target, content: source.newText })
          continue
        }
        if (!exists) throw new Error(`edit target ${normalized} does not exist`)
        const current = stagedFile?.content ?? await fs.readFile(target, 'utf8')
        const newline = current.includes('\r\n') ? '\r\n' : '\n'
        const matchText = oldText.replace(/\r\n|\r|\n/g, newline)
        const replacement = source.newText.replace(/\r\n|\r|\n/g, newline)
        const occurrences = current.split(matchText).length - 1
        if (occurrences !== 1) throw new Error(`oldText for ${normalized} matched ${occurrences} times; exactly one match is required`)
        staged.set(normalized, { target, content: current.replace(matchText, replacement) })
      }
      for (const file of staged.values()) {
        await fs.mkdir(path.dirname(file.target), { recursive: true })
        await fs.writeFile(file.target, file.content, 'utf8')
      }
      return { success: true, changedFiles: [...staged.keys()] }
    },
    updateTodo: async (values) => {
      const tasks = publicMcpTodoTasks(values)
      return { success: true, tasks, intent: publicMcpIntent }
    },
    mappingsSearch: (query, limit) => requireMappings().search(project.minecraftVersion, query, Math.min(Math.max(limit ?? 20, 1), 50)),
    mappingsClass: (className, memberQuery) => requireMappings().getClass(project.minecraftVersion, className, memberQuery),
    dependencySearch: (query, offset) => requireDependencyService().search(query, Math.min(Math.max(offset ?? 0, 0), 1_000)),
    dependencyInstall: (projectId, versionId) => requireDependencyService().install({ projectId, versionId }),
    mavenDependencyInstall: (input) => requireDependencyService().installMaven(input as unknown as MavenDependencyInput),
    addonRelationships: () => addonService.describeForAi(),
    addonPrepare: (input) => addonService.prepare(normalizeAddonPrepareInput(input)),
    addonImport: async (paths, role) => addonService.importExact(await resolveAddonImportPaths(project, paths), role === 'optional' || role === 'test' ? role : 'required'),
    addonLinkProject: (projectPath) => linkAddonProject(project, projectPath, signal),
    contentValidate: () => requireContentService().validate(),
    testMatrix: (targets) => runProjectTestMatrix(targets.filter((target): target is TestTarget => ['build', 'client', 'server', 'gametest'].includes(target)), signal),
    releasePreflight: () => requireReleaseService().preflight(),
    build: async () => ({ success: true, artifact: await buildProjectWithLock(signal) }),
    testMinecraft: async () => {
      const result = await runHeadlessMinecraftSmoke(project, signal, { stableWindowMs: 20_000, offline: true })
      if (!result.success) throw new Error(result.message || 'HeadlessMC smoke test failed')
      return result
    },
    blockbenchActions: (actions, expectedRevision) => requireBlockbenchForProject(project).executeActions(actions as BlockbenchAction[], signal, expectedRevision),
    blockbenchProjectState: () => requireBlockbenchForProject(project).getProjectState(),
    blockbenchValidate: () => requireBlockbenchForProject(project).validateProject(),
    blockbenchCaptureViews: (input) => requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest),
    blockbenchHistory: () => requireBlockbenchForProject(project).listHistory(),
    blockbenchCheckpoint: (label) => requireBlockbenchForProject(project).createCheckpoint(label),
    blockbenchRestoreHistory: (id) => requireBlockbenchForProject(project).restoreHistory(id),
    assetCompileIntent: async (input) => compileAssetIntent(input),
    assetPreviewIntent: (input, capture, expectedRevision) => previewAssetIntentCandidate(
      requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
    ),
    assetApplyIntent: async (input, expectedRevision) => {
      const candidate = compileAssetIntent(input)
      if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
      const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
      return {...candidate, execution}
    },
    assetCompileRefinement: (input) => compileAssetRefinementForBridge(requireBlockbenchForProject(project), input),
    assetPreviewRefinement: (input, capture, expectedRevision) => previewAssetRefinementCandidate(
      requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
    ),
    assetApplyRefinement: (input, expectedRevision) => applyAssetRefinementCandidate(
      requireBlockbenchForProject(project), input, signal, expectedRevision
    ),
    assetCompileAdvanced: async (input, variantId) => compileAdvancedAsset(input, variantId),
    assetPreviewAdvanced: (input, capture, options, expectedRevision) => previewAdvancedAssetComparison(
      requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined,
      options as AdvancedAssetPreviewOptions | undefined, signal, expectedRevision
    ),
    assetApplyAdvanced: async (input, variantId, expectedRevision) => {
      const candidate = compileAdvancedAsset(input, variantId)
      if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
      const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
      return {...candidate, execution}
    },
    assetCompileReference: (input) => compileReferenceImageAsset(input),
    assetPreviewReference: (input, capture, expectedRevision) => previewReferenceImageCandidate(
      requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
    ),
    assetApplyReference: async (input, expectedRevision) => {
      const candidate = await compileReferenceImageAsset(input)
      const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
      return {...candidate, execution}
    },
    assetVisualReview: async (input) => {
      const captures = await requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest)
      return {...captures, review: await reviewAssetCaptures(captures.captures)}
    },
    runtimeState: async () => requireMinecraftRuntime().getState(),
    javaHomeScan: () => detectInstalledJavaHomes(),
    javaHomeProbe: (home) => probeJavaHomeInfo(home),
    appSettingsRead: async () => publicAgentSettings(await readSettings()),
    appSettingsWrite: (input) => applyAppSettingWrite(input),
    modpackPlan: async (concept) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const plan = await planModpack(requireModProviderRegistry(), project, concept as unknown as Parameters<typeof planModpack>[2], mcmodService, signal)
      await saveManualModRequirements(project, plan.manualRequired ?? [])
      return plan
    },
    modpackApplyPlan: async (plan) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      return applyModpackPlan(requireModProviderRegistry(), project, plan as unknown as Parameters<typeof applyModpackPlan>[2], signal)
    },
    modpackMigrationTargets: async () => (await requireLoaderCatalog().list()).filter((option) => ['fabric', 'quilt', 'forge', 'neoforge'].includes(option.loader)),
    modpackMigrationPreview: (input) => previewModpackMigrationForAgent(project, input),
    modpackMigrationApply: (input) => applyModpackMigrationForAgent(project, input),
    modpackMigrationHistory: () => listModpackMigrationRecords(project),
    modpackMigrationUndo: async (migrationId) => {
      const result = await withMinecraftResourceLock(() => undoModpackMigration(project, migrationId))
      Object.assign(project, result.restoredProject)
      return result
    },
    modpackDownloadContent: (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      return downloadModpackContent(project, input as unknown as ModpackContentDownloadInput)
    },
    mcmodSearch: (query, limit) => mcmodService.search(query, Math.min(Math.max(limit ?? 10, 1), 20), signal),
    mcmodFiles: async (projectId) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const files = await mcmodService.listFiles(projectId, signal)
      const loader = project.loader.toLowerCase()
      return files.filter((file) => file.minecraftVersion.split('/').includes(project.minecraftVersion)
        && (!file.loaders.length || file.loaders.some((value) => value.toLowerCase().includes(loader))))
    },
    modpackWriteFtbQuest: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const relative = await writeFtbQuestChapter(project, input as unknown as Parameters<typeof writeFtbQuestChapter>[1])
      return { success: true, path: relative }
    },
    modpackWritePatchouliBook: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const paths = await writePatchouliBook(project, input as unknown as Parameters<typeof writePatchouliBook>[1])
      return { success: true, paths }
    },
    modpackApplyKeybindPreset: async (input, allowConflicts) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      return applyKeybindPreset(project, input as unknown as Parameters<typeof applyKeybindPreset>[1], allowConflicts)
    },
    modpackBuildServer: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const outputDirectory = publicMcpOutputDirectory(project, input, path.join(project.path, projectDataDirectory(project), 'server-pack'))
      const manifest = await readModpackManifest(project)
      const engine = manifest.mods.length ? 'serverpackcreator' : 'internal'
      const javaPath = engine === 'serverpackcreator' ? await requireMinecraftRuntime().ensureJavaRuntime(undefined, SERVER_PACK_CREATOR_MIN_JAVA) : undefined
      return withMinecraftResourceLock(() => buildServerPack(project, { outputDirectory, port: typeof input.port === 'number' ? input.port : undefined, acceptEula: input.acceptEula !== false, includeUnknownSideMods: false, onlineMode: input.onlineMode !== false, engine, ...(javaPath ? { javaPath, cacheDirectory: path.join(app.getPath('userData'), 'server-pack-creator') } : {}) }))
    },
    modpackVerifyServerJoin: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
      const port = typeof input.port === 'number' ? input.port : 25565
      const outputDirectory = publicMcpOutputDirectory(project, input, path.join(project.path, projectDataDirectory(project), 'server-pack'))
      return withMinecraftResourceLock(() => buildAndJoinServer({ project, outputDirectory, port, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, headless: requireHeadlessMc(), gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'server-join'), managedMinecraftDirectory: requireMinecraftRuntime().managedMinecraftDirectory(), onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
    },
    modpackApplyOptimizationProfile: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const profileId = typeof input.profileId === 'string' ? input.profileId : ''
      const builtIn = BUILTIN_OPTIMIZATION_PROFILES.find((profile) => profile.id === profileId)
      const profile = builtIn ?? input.profile
      if (!profile || typeof profile !== 'object') throw new Error(`optimization profile not found: ${profileId}`)
      return applyOptimizationProfile(requireModProviderRegistry(), project, profile as Parameters<typeof applyOptimizationProfile>[2], signal)
    },
    modpackRunServerScenario: async (input) => {
      if (!isModpackProject(project)) throw new Error('current project is not a modpack')
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
      if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('server scenario requires at least one step')
      const steps = input.steps.map((step) => {
        if (!step || typeof step !== 'object') throw new Error('invalid server scenario step')
        const record = step as Record<string, unknown>
        return { command: String(record.command ?? ''), expect: Array.isArray(record.expect) ? record.expect.map(String) : [], timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined }
      })
      const port = typeof input.port === 'number' ? input.port : 25565
      const outputDirectory = publicMcpOutputDirectory(project, input, path.join(project.path, projectDataDirectory(project), 'server-scenario'))
      return withMinecraftResourceLock(() => runServerScenario({ project, outputDirectory, port, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, steps, onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
    },
    imageGenerate: async (input) => {
      const request = normalizeAgentImageRequest(input)
      if (!request.prompt) throw new Error('image prompt is required')
      return requireImageStudio().generate(request)
    },
    imageProcess: (operation, dataUrl) => requireImageStudio().process(operation, dataUrl),
    imageProjectAssets: async () => {
      const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap((node) => node.type === 'directory' ? flatten(node.children ?? []) : [node])
      return flatten(await listDirectory(project.path)).filter((node) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(node.path)).slice(0, 500).map((node) => node.path)
    },
    imageReadProjectAsset: async (relativePath) => {
      const normalized = normalizeReadablePath(relativePath)
      if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(normalized)) throw new Error('only project image resources can be read')
      const target = resolveProjectPath(normalized)
      const stat = await fs.stat(target)
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('reference image is missing or exceeds 20 MiB')
      const mime = /\.jpe?g$/i.test(normalized) ? 'image/jpeg' : /\.webp$/i.test(normalized) ? 'image/webp' : /\.gif$/i.test(normalized) ? 'image/gif' : /\.bmp$/i.test(normalized) ? 'image/bmp' : 'image/png'
      return { path: normalized, dataUrl: `data:${mime};base64,${(await fs.readFile(target)).toString('base64')}` }
    }
  }
  return handlers
}

async function startPublicMcpBridge(projectPath?: string): Promise<{ projectPath: string; bridgeConfigPath: string; mcpConfigPath: string; serverPath: string }> {
  const requestedPath = projectPath?.trim() ? path.resolve(projectPath.trim()) : undefined
  const project = requestedPath ? await readProjectInfo(requestedPath) : currentProject
  if (!project) throw new Error('a ModMind project is required; pass --project <path>')
  if (publicMcpBridge && sameProjectPath(publicMcpBridgeProjectPath, project.path)) {
    const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents')
    return { projectPath: project.path, bridgeConfigPath: path.join(directory, 'bridge.json'), mcpConfigPath: path.join(directory, 'mcp-config.json'), serverPath: path.join(directory, 'modmind-mcp-server.mjs') }
  }
  await stopPublicMcpBridge()
  currentProject = project
  await rememberRecentProject(project)
  await refreshExternalAgentContext(project).catch(() => undefined)
  const controller = new AbortController()
  const handlers = await createPublicMcpBridgeHandlers(project, controller.signal)
  const bridge = new ModMindBridge(project, handlers, app.getVersion(), bundledCodexSkillsDirectory(), false, undefined, createPluginBridgeTarget())
  try {
    const { mcpConfigPath, contextPath } = await bridge.start()
    await bridge.writeMcpConfig(mcpConfigPath)
    const directory = path.dirname(mcpConfigPath)
    const statusPath = path.join(directory, 'mcp-bridge.json')
    await fs.writeFile(statusPath, `${JSON.stringify({ schemaVersion: 1, projectPath: project.path, bridgeConfigPath: path.join(directory, 'bridge.json'), mcpConfigPath, serverPath: path.join(directory, 'modmind-mcp-server.mjs'), contextPath, startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    publicMcpBridge = bridge
    publicMcpBridgeProjectPath = project.path
    publicMcpBridgeProjectName = project.name
    publicMcpBridgeConfigPath = mcpConfigPath
    publicMcpBridgeStartedAt = new Date().toISOString()
    publicMcpBridgeAbort = controller
    broadcastMcpBridgeState()
    emitProjectChanged()
    return { projectPath: project.path, bridgeConfigPath: path.join(directory, 'bridge.json'), mcpConfigPath, serverPath: path.join(directory, 'modmind-mcp-server.mjs') }
  } catch (error) {
    controller.abort()
    await bridge.stop().catch(() => undefined)
    throw error
  }
}

async function stopPublicMcpBridge(): Promise<void> {
  const bridge = publicMcpBridge
  const projectPath = publicMcpBridgeProjectPath
  const wasRunning = Boolean(bridge)
  publicMcpBridge = null
  publicMcpBridgeProjectPath = ''
  publicMcpBridgeProjectName = ''
  publicMcpBridgeConfigPath = ''
  publicMcpBridgeStartedAt = null
  publicMcpBridgeAbort?.abort()
  publicMcpBridgeAbort = null
  if (wasRunning) broadcastMcpBridgeState()
  if (!bridge) return
  await bridge.stop()
  if (projectPath) {
    const project = currentProject && sameProjectPath(currentProject.path, projectPath) ? currentProject : await readProjectInfo(projectPath)
    if (project) await fs.rm(path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents', 'mcp-bridge.json'), { force: true }).catch(() => undefined)
  }
}

/** 设置页「外部 MCP 接入」开关：持久化偏好，并立即启动/停止桥接（需要已打开项目）。 */
async function setMcpBridgeEnabledFromSettings(enabled: boolean): Promise<McpBridgeState> {
  await persistMcpBridgePreference(enabled)
  if (enabled) {
    if (currentProject && !publicMcpBridge) {
      await startPublicMcpBridge(currentProject.path).catch((error) => {
        console.warn('[mcp-bridge] failed to start from settings', error)
      })
    }
  } else {
    await stopPublicMcpBridge()
  }
  return mcpBridgeState()
}

function activeAiTaskPath(project: ProjectInfo = requireProject()): string {
  return path.join(project.path, projectDataDirectory(project), 'active-ai-task.json')
}

const activeTaskWrites = new Map<string, Promise<void>>()

async function readActiveAiTask(project: ProjectInfo = requireProject()): Promise<ActiveAiTask | null> {
  await migrateMovedProjectMetadata(project)
  try {
    const value = JSON.parse(await fs.readFile(activeAiTaskPath(project), 'utf8')) as ActiveAiTask
    if (!value.taskId || !value.snapshotId || !value.prompt || !value.state
      || typeof value.projectPath !== 'string' || !sameProjectPath(value.projectPath, project.path)) return null
    if (value.surface === 'inspiration') return null
    if (!value.nativeSessions && value.sessionId && value.backend) {
      value.nativeSessions = { [value.backend]: value.sessionId }
    }
    value.contextRevision = Number.isSafeInteger(value.contextRevision) && Number(value.contextRevision) >= 0
      ? Number(value.contextRevision)
      : 0
    return value
  } catch {
    // A truncated checkpoint must not keep reopening a broken recovery modal.
    await fs.rm(activeAiTaskPath(project), { force: true }).catch(() => undefined)
    return null
  }
}

async function writeActiveAiTask(task: ActiveAiTask, project: ProjectInfo): Promise<void> {
  const target = activeAiTaskPath(project)
  const previous = activeTaskWrites.get(target) ?? Promise.resolve()
  const next = previous.then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${randomUUID()}`
    try {
      await fs.writeFile(temporary, JSON.stringify(task, null, 2), 'utf8')
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, {force: true}).catch(() => undefined)
    }
  })
  activeTaskWrites.set(target, next)
  try {
    await next
  } finally {
    if (activeTaskWrites.get(target) === next) activeTaskWrites.delete(target)
  }
}

async function clearActiveAiTask(project: ProjectInfo, taskId?: string): Promise<void> {
  if (taskId) {
    const active = await readActiveAiTask(project)
    if (active && active.taskId !== taskId) return
  }
  const target = activeAiTaskPath(project)
  await activeTaskWrites.get(target)?.catch(() => undefined)
  await fs.rm(target, { force: true })
}

async function getAiRecoveryInfo(projectPath?: string): Promise<AiRecoveryInfo> {
  const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
  if (!project) return { pending: false, snapshot: null }
  if (activeWorkspaceRun(project.path)) return { pending: false, snapshot: null }
  const active = await readActiveAiTask(project)
  if (!active) return { pending: false, snapshot: null }
  const manifestPath = path.join(project.path, projectDataDirectory(project), 'snapshots', active.snapshotId, 'snapshot.json')
  const snapshot = await fs.readFile(manifestPath, 'utf8').then((value) => JSON.parse(value) as SnapshotManifest).catch(() => null)
  if (!snapshot || snapshot.taskId !== active.taskId) return { pending: false, snapshot: null }
  const conversationId = aiConversationIdForSession(active)
  const interruptedWhileRunning = active.lifecycle === 'running'
  const lifecycle = interruptedWhileRunning ? 'repairing' : active.lifecycle
  const retry = active.recovery ?? (interruptedWhileRunning ? {
    category: 'process' as const,
    attempt: 0,
    message: 'ModMind 在任务运行期间退出，正在从持久化检查点恢复',
    nextAttemptAt: new Date().toISOString()
  } : undefined)
  return {
    pending: true,
    snapshot,
    ...(active.sessionId ? { sessionId: active.sessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(active.backend ? { backend: active.backend } : {}),
    contextRevision: active.contextRevision ?? 0,
    ...(lifecycle ? { lifecycle } : {}),
    ...(retry ? { retry } : {})
  }
}

async function restoreAiRecovery(): Promise<SnapshotInfo | null> {
  const project = requireProject()
  const active = await readActiveAiTask(project)
  if (!active) return null
  const recovery = await getAiRecoveryInfo()
  if (!recovery.snapshot || recovery.snapshot.id !== active.snapshotId) return null
  const backup = await createProjectSnapshot('Recovery backup before restoring interrupted AI task')
  const snapshotRoot = path.join(project.path, projectDataDirectory(project), 'snapshots', recovery.snapshot.id, 'files')
  await restoreManagedPathsFromSnapshot(snapshotRoot, project.path, active.changedFiles ?? [])
  await clearActiveAiTask(project, active.taskId)
  diagnosticJournal.record({
    subsystem: 'ai',
    operation: 'restore-recovery',
    phase: 'success',
    message: `Restored ${active.changedFiles?.length ?? 0} Agent-attributed paths from interrupted task ${active.taskId}`,
    data: { snapshotId: recovery.snapshot.id, backupId: backup.id, changedFiles: active.changedFiles ?? [] }
  })
  return backup
}

function normalizeReadablePath(value: string, project: ProjectInfo = requireProject()): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || path.win32.isAbsolute(value) || path.posix.isAbsolute(normalized) || normalized.includes('../')) {
    throw new Error(`Unsafe read path: ${value}`)
  }
  // The Agent may inspect any project-owned directory, including generated
  // and tool metadata. Keep only the credential-file guard below.
  const lower = normalized.toLowerCase()
  if (/(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/.test(lower)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(lower)) {
    throw new Error(`Agent cannot read sensitive path: ${value}`)
  }
  resolveProjectPathFor(project, normalized)
  return normalized
}

function describeAgentRunError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Agent 任务已停止，停止前完成的修改已保留'
  if (error instanceof Error && error.name === 'TimeoutError') return describeAiFailureForUser('上游模型响应超时')
  return describeAiFailureForUser(sanitizeAiUserText(error instanceof Error ? error.message : String(error)))
}

function isRecoverableAgentRunError(error: unknown, message: string): boolean {
  if (error instanceof Error && ['AbortError', 'ExternalAgentTransientFailureError', 'ExternalAgentNoOutputTimeoutError', 'ExternalAgentEmptyResponseError', 'ResumedPromptRejectionError'].includes(error.name)) return true
  return /Review Agent rejected completion|Mandatory workflow incomplete|ModMind 完成检查未通过|recovery snapshot|recovery point|session.{0,40}reject|no-output-timeout|timed out|timeout|stream disconnected|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|ENOTFOUND|(?:^|\D)(?:401|402|403|404|429|500|502|503|504)(?:\D|$)|API Key|审计|工作流未完成|恢复(?:点|快照)|线路繁忙|连接中断|响应超时|没有返回任何内容|会话.{0,20}拒绝|凭证已失效|额度不足|模型接口或所选模型不存在/i.test(message)
}

async function managedCodingHashes(project: ProjectInfo): Promise<Map<string, string>> {
  return managedCodingHashesAt(project.path)
}

async function managedCodingHashesAt(root: string): Promise<Map<string, string>> {
  const files = await listManagedFiles(root, (name) => ignoredDirectories.has(name) || isToolDataDirectory(name))
  const hashes = new Map<string, string>()
  for (const relative of files) {
    const content = await fs.readFile(path.join(root, relative)).catch(() => Buffer.alloc(0))
    hashes.set(relative, createHash('sha256').update(content).digest('hex'))
  }
  return hashes
}

async function getAiReviewerConfig(
  usesQuota: boolean,
  backend: ExternalAgentKind,
  settings: AgentSettings,
  projectPath?: string
): Promise<AiReviewerConfig | null> {
  if (usesQuota) {
    const config = await readBeginnerAgentServerConfig()
    return {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      ...(projectPath ? { reviewMode: 'codex-auto' as const, codexExecutable: process.platform === 'win32' ? 'codex.cmd' : 'codex', projectPath } : {})
    }
  }
  const configured = settings.externalAgents?.[backend]
  if (backend === 'codex' && projectPath) {
    return {
      ...(configured?.baseUrl?.trim() ? { baseUrl: normalizeApiBaseUrl(configured.baseUrl) } : {}),
      ...(configured?.apiKey?.trim() ? { apiKey: configured.apiKey.trim() } : {}),
      ...(configured?.model?.trim() ? { model: configured.model.trim() } : {}),
      reasoningEffort: configured?.reasoningEffort,
      reviewMode: 'codex-auto',
      codexExecutable: configured?.executable?.trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
      projectPath,
      ...(configured?.apiKey?.trim() ? { environment: { MODMIND_THIRD_PARTY_API_KEY: configured.apiKey.trim() } } : {})
    }
  }
  if (!configured?.apiKey?.trim() || !configured.baseUrl?.trim() || !configured.model?.trim()) return null
  return {
    baseUrl: normalizeApiBaseUrl(configured.baseUrl),
    apiKey: configured.apiKey.trim(),
    model: configured.model.trim(),
    reasoningEffort: configured.reasoningEffort
  }
}

function parseReleaseSummary(content: string, fallback: ReleaseSummaryDraft): ReleaseSummaryDraft {
  const candidate = content.match(/\{[\s\S]*\}/)?.[0] ?? content
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>
    const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 500) : ''
    const changelog = typeof value.changelog === 'string' ? value.changelog.trim().slice(0, 100_000) : ''
    if (summary) return { summary, changelog: changelog || fallback.changelog, generatedBy: 'ai' }
  } catch { /* A non-JSON response falls back to the deterministic draft. */ }
  return fallback
}

async function generateAiReleaseSummary(): Promise<ReleaseSummaryDraft> {
  const fallback = await requireReleaseService().suggestSummary()
  const settings = await readSettings()
  const backend = settings.codingBackend
  const config = await getAiReviewerConfig(backend === 'quota', backend === 'quota' ? 'codex' : backend, settings).catch(() => null)
  if (!config?.baseUrl || !config.apiKey || !config.model) return fallback
  const project = requireProject()
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.25,
      messages: [
        { role: 'system', content: 'You write concise Minecraft release notes in Simplified Chinese. Return only JSON with string fields summary and changelog. Do not claim unverified gameplay changes.' },
        { role: 'user', content: `Create a release summary from this local metadata. Do not request files or make edits.\n${JSON.stringify({ project: project.name, minecraft: project.minecraftVersion, loader: project.loader, fallback }, null, 2)}` }
      ]
    }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) return fallback
  const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null
  const content = typeof body?.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : ''
  return content ? parseReleaseSummary(content, fallback) : fallback
}

function codingHashesEqual(left: Map<string, string> | null, right: Map<string, string>): boolean {
  if (!left || left.size !== right.size) return false
  for (const [file, hash] of right) if (left.get(file) !== hash) return false
  return true
}

const MANDATORY_CODING_WORKFLOW = `始终使用简体中文回复用户：所有说明、分析、汇报、Todo 标题与状态描述一律用中文（代码、标识符、报错日志原文除外），除非用户明确要求其他语言。

${MANAGED_DOWNLOAD_POLICY}

MANDATORY MODMIND COMPLETION AUDIT. The only hard gate is the independent audit before your final answer. Planning and setup helpers are optional: modmind_project_info and modmind_set_intent are useful when context is needed. You are strongly encouraged, but not required, to call modmind_update_todo for engineering work so the user can see the plan, progress, remaining work, and recovery state; never repeat Todo work only to satisfy a gate, and Todo status never determines audit approval.

For an engineering change, make sure the applicable completion evidence exists before the final answer: the requested implementation/diff, content validation, and a successful managed build. Prefer a managed runtime test when the task changes startup, registration, mixin, world-generation, networking, loader compatibility, or gameplay behavior, or when the user asks for game verification; it is valuable evidence, but not a universal completion gate. The Agent smoke-test path uses HeadlessMC in an isolated, hidden, offline instance; it must not open the user's Minecraft window. These audit stages may be performed in any order that is efficient for the task. Informational tasks do not need engineering build/test stages.

Native Agent tools, terminal commands, and file tools remain available for uncovered work. Never run Gradle build, assemble, compileJava, runClient, runServer, or runGameTestServer directly; use modmind_build_project, modmind_test_matrix, or modmind_test_minecraft so ModMind owns serialization, cancellation, and process cleanup. Never use Stop-Process -Force, taskkill /f, kill -9, or delete Gradle daemon registry files. On Windows, commands run in Windows PowerShell 5.1, so do not use Bash-only operators such as || or &&. Native actions alone may not create ModMind evidence: after using a native tool for a stage, call the corresponding ModMind evidence tool when one exists. Do not waste tokens replaying optional planning steps or following a fixed sequence.

Do not claim completion when applicable audit evidence is missing. The independent ModMind Review Agent audits the result before releasing your final answer. If it reports missing stages, continue the task and perform exactly those missing stages.`

const NETEASE_CODING_WORKFLOW = `NETEASE MOD SDK RULES. Inspect existing project files first and implement promptly using the Python Mod SDK layout (behavior_pack/modMain.py, behavior_pack/<namespace>/clientSystem.py, behavior_pack/<namespace>/serverSystem.py, and resource-pack UI JSON/textures). Do not use Gradle, Java mappings, Sourcegraph, or broad web scraping. Use official NetEase documentation only for a specific unresolved API after inspecting local templates. Engineering tasks must produce concrete edits, implement client/server events and per-save persistence where required, then call modmind_validate_content and modmind_build_project. ModMind validates and packages the project; runtime testing belongs in the official NetEase developer workbench.`

const MODELING_SYSTEM_PROMPT = `你是 ModMind 内置的 Blockbench 建模 Agent。你必须通过 Modmind 注入的 modmind_* MCP 工具，在实时 Blockbench 视口中直接建模，产出可编辑的 .bbmodel 模型；不要只描述模型，也不要手填 Asset Intent JSON。你与用户的全部交流、说明、汇报、状态描述，一律使用简体中文（除非用户明确要求其他语言）。遵守以下硬规则（闭环）：

1. 动笔前先调用 modmind_blockbench_project_state 读取 revision；之后每次变更都把该 revision 作为 expectedRevision 传入，并在变更后刷新状态。
2. 修改既有模型前，先 modmind_blockbench_checkpoint 建立命名检查点，并保留至最终校验通过。
3. 用 modmind_asset_compile_intent（或高级/精修工具）生成候选，再用 modmind_asset_preview_intent 预览。
4. 用 modmind_blockbench_capture_views 抓取前/侧/等轴三视角截图，必须亲眼看截图做 critique，至少完成一轮 modmind_asset_compile_refinement 精修并再次预览；视觉分目标 ≥82。默认 Production 档，仅当用户明确要求才用 Draft。
5. 用 modmind_asset_apply_intent 应用候选，再 modmind_blockbench_validate 校验，并目视实时结果后才保存/导出。
6. Reference Asset（参考图转网格）严禁用于动物/角色/载具类资产生成。
7. 至多三轮 critique 修正；仍不达标则保留未保存或还原检查点并如实说明缺陷。
8. 验收通过后才保存可编辑 .bbmodel 与贴图，并汇报格式、路径、数量、视角、校验与视觉分。`

function codingWorkflowPrompt(project: ProjectInfo): string {
  return project.loader === 'netease-pc' || project.loader === 'netease-mobile'
    ? `${MANDATORY_CODING_WORKFLOW}\n\n${NETEASE_CODING_WORKFLOW}`
    : MANDATORY_CODING_WORKFLOW
}

function requiredWorkflowStages(project: ProjectInfo, intent: 'engineering' | 'informational' | null): AiWorkflowStage[] {
  if (intent !== 'engineering') return [...INFORMATIONAL_WORKFLOW_STAGES]
  return ENGINEERING_WORKFLOW_STAGES.filter((stage) => project.loader === 'bedrock' || project.loader === 'netease-pc' || project.loader === 'netease-mobile'
    ? stage !== 'runtime_test'
    : true)
}

function markWorkflowStage(workflow: AiWorkflowState, stage: AiWorkflowStage, evidence: string): void {
  if (!workflow.completed.includes(stage)) workflow.completed.push(stage)
  workflow.evidence[stage] = evidence.slice(0, 500)
}

function auditWorkflow(workflow: AiWorkflowState, changedFiles: string[], buildUsed: boolean, runtimeUsed: boolean, todo?: AgentTodoItem[]): { required: AiWorkflowStage[]; completed: AiWorkflowStage[]; missing: AiWorkflowStage[]; evidence: Partial<Record<AiWorkflowStage, string>> } {
  const completed = new Set(workflow.completed)
  const evidence = { ...workflow.evidence }
  if (changedFiles.length) {
    completed.add('implementation')
    evidence.implementation ??= `Detected ${changedFiles.length} changed managed file${changedFiles.length === 1 ? '' : 's'}`
  }
  if (buildUsed) {
    completed.add('build')
    evidence.build ??= 'Managed build completed successfully'
  }
  if (runtimeUsed) {
    completed.add('runtime_test')
    evidence.runtime_test ??= 'Managed runtime test completed successfully'
  }
  const prerequisites = workflow.required.filter((stage) => stage !== 'todo_complete')
  if (todo?.length && todo.every((item) => item.status === 'completed') && prerequisites.every((stage) => completed.has(stage))) {
    completed.add('todo_complete')
    evidence.todo_complete = 'All Todo items are completed after the other required stages'
  }
  const normalized = [...completed]
  const missing = workflow.required.filter((stage) => !completed.has(stage))
  return { required: [...workflow.required], completed: normalized, missing, evidence }
}

async function runExternalCodingAgent(
  event: Electron.IpcMainInvokeEvent,
  prompt: string,
  sessionId: string | undefined,
  backend: AgentSettings['codingBackend'],
  requestedExecutionProfile: AiExecutionProfile = 'standard',
  recovery?: ActiveAiTask,
  context: AiCreateCodeOptions = {},
  taskSignal?: AbortSignal,
  lifecycle: { onBackendReady?: () => void } = {}
): Promise<CodingResult> {
  const project = requireProject()
  const signal = taskSignal ?? new AbortController().signal
  throwIfAborted(signal, 'Agent 任务已停止')
  const surface: AiSurface =
    context.surface === 'inspiration' ? 'inspiration' :
    context.surface === 'modeling' ? 'modeling' :
    'workspace'
  const isInspiration = surface === 'inspiration'
  const isModeling = surface === 'modeling'
  const recoveryBackend = recovery?.backend
  const backendChanged = Boolean(recoveryBackend && recoveryBackend !== backend)
  const nativeSessionId = recovery?.nativeSessions?.[backend]
    ?? (!backendChanged && recoveryBackend === backend ? recovery?.sessionId : undefined)
  // Resumed checkpoints keep their original conversation scope so the CLI
  // session continues inside the same workbench thread.
  const sessionScope = recovery ? aiRecoverySessionScope(recovery) : normalizeAiSessionScope(context.sessionScope)
  // The beginner-unlimited profile belongs exclusively to the quota engine.
  // Never carry it across a hot switch into a user-configured Codex/Claude
  // process, otherwise the target backend would silently use the old account.
  const executionProfile: AiExecutionProfile = backend === 'quota'
    ? (recovery?.executionProfile === 'beginner-unlimited' || requestedExecutionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard')
    : 'standard'
  const usesQuota = backend === 'quota'
  const externalBackend: ExternalAgentKind = backend === 'quota' ? 'codex' : backend
  const agentLabel = externalAgentLabel(externalBackend)
  const settings = await awaitWithAbort(readSettings(), signal, 'Agent 任务已停止')
  const sendCodingProgress = (item: PipelineEvent): void => sendAiProgress(event, item, sessionId, project.path, context.runId)
  const inspirationQuestion = context.inspirationQuestion?.trim() || prompt
  const reasoningEffort = isInspiration ? inspirationReasoningEffort(inspirationQuestion) : undefined
  const savedExternalConfiguration = settings.externalAgents?.[externalBackend] ?? {}
  const runExternalConfiguration = isInspiration && !usesQuota
    ? await inspirationExternalConfiguration(externalBackend, savedExternalConfiguration, inspirationQuestion, signal)
    : savedExternalConfiguration
  const quotaRunConfiguration = isInspiration && usesQuota
    ? await inspirationQuotaConfig(inspirationQuestion, signal)
    : undefined
  let reviewerConfig = await awaitWithAbort(getAiReviewerConfig(usesQuota, externalBackend, settings, project.path).catch(() => null), signal, 'Agent 任务已停止')
  let reviewerUnavailableNotified = false
  let reviewerFallbackNotified = false
  let codexSetup: Awaited<ReturnType<typeof prepareCodex>> | undefined
  if (usesQuota) {
    await awaitWithAbort(ensureQuotaAccountReady(), signal, 'Agent 任务已停止')
    codexSetup = await prepareQuotaCodex(project, sessionScope, (progress) => {
      sendCodingProgress(pipelineEvent('planning', progress.title, progress.detail, progress.status))
    }, signal, quotaRunConfiguration)
  } else if (externalBackend === 'codex') {
    const configured = runExternalConfiguration
    if (configured.apiKey?.trim() || configured.baseUrl?.trim() || configured.model?.trim()) {
      codexSetup = await prepareConfiguredCodex(project, sessionScope, configured, (progress) => {
        sendCodingProgress(pipelineEvent('planning', progress.title, progress.detail, progress.status))
      }, signal)
    }
  }
  throwIfAborted(signal, 'Agent 任务已停止')
  if (reviewerConfig?.reviewMode === 'codex-auto' && codexSetup?.environment) {
    reviewerConfig = { ...reviewerConfig, codexExecutable: codexSetup.executable, environment: codexSetup.environment }
  }
  let configuredExecutable = codexSetup?.executable ?? runExternalConfiguration.executable
  if (!configuredExecutable) {
    const detected = await awaitWithAbort(detectExternalAgent(externalBackend, externalBackend === 'codex'
      ? {executables: [managedCodexExecutablePath(app.getPath('userData'))], includeDefaults: false}
      : {}), signal, 'Agent 任务已停止')
    if (!detected?.installed) {
      throw new Error(`${agentLabel} CLI 未安装或不在 PATH 中`)
    }
    configuredExecutable = detected.executable
  }
  const taskId = recovery?.taskId ?? randomUUID()
  const snapshot = isInspiration
    ? { id: `inspiration-${randomUUID()}`, label: `${agentLabel}: inspiration`, createdAt: new Date().toISOString(), fileCount: 0 }
    : recovery?.snapshotId
      ? await awaitWithAbort(readSnapshotInfo(project, recovery.snapshotId), signal, 'Agent 任务已停止')
      : await awaitWithAbort(createProjectSnapshot(`${agentLabel}: ${prompt.slice(0, 36)}`, { taskId }), signal, 'Agent 任务已停止')
  if (!snapshot) {
    throw new Error('无法创建外部代理任务快照')
  }
  const before = isInspiration
    ? new Map<string, string>()
    : recovery
    ? await awaitWithAbort(managedCodingHashesAt(path.join(project.path, projectDataDirectory(project), 'snapshots', snapshot.id, 'files')), signal, 'Agent 任务已停止')
    : await awaitWithAbort(managedCodingHashes(project), signal, 'Agent 任务已停止')
  let buildUsed = Boolean(recovery?.state.lastBuildSucceeded)
  let runtimeUsed = Boolean(recovery?.workflow?.completed.includes('runtime_test'))
  let buildCount = recovery?.state.buildCount ?? 0
  let declaredIntent: 'engineering' | 'informational' | null = recovery?.state.intent ?? null
  let lastBuildHashes: Map<string, string> | null = null
  let lastRuntimeHashes: Map<string, string> | null = null
  const runtime = requireMinecraftRuntime()
  const conversationId = aiConversationIdForSession(recovery ?? { sessionScope })
  const activeTask: ActiveAiTask = {
    taskId,
    runId: context.runId ?? recovery?.runId ?? taskId,
    projectPath: project.path,
    snapshotId: snapshot.id,
    startedAt: recovery?.startedAt ?? new Date().toISOString(),
    changedFiles: recovery?.changedFiles ?? [],
    prompt,
    surface,
    sessionScope,
    ...(conversationId ? { conversationId } : {}),
    ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
    backend,
    nativeSessions: { ...recovery?.nativeSessions, ...(nativeSessionId ? { [backend]: nativeSessionId } : {}) },
    contextRevision: (recovery?.contextRevision ?? 0) + (recovery ? 1 : 0),
    executionProfile,
    lifecycle: 'running',
    workflow: recovery?.workflow ?? {
      required: (isInspiration || isModeling) ? [] : requiredWorkflowStages(project, declaredIntent),
      completed: [],
      evidence: {}
    },
    state: {
      lastBuildSucceeded: recovery?.state.lastBuildSucceeded ?? false,
      summary: recovery?.state.summary ?? `${agentLabel} 托管任务`,
      tasks: recovery?.state.tasks ?? [],
      tests: recovery?.state.tests ?? [],
      warnings: recovery?.state.warnings ?? [],
      applyRounds: recovery?.state.applyRounds ?? 0,
      buildCount,
      ...(recovery?.state.reviewFeedback ? { reviewFeedback: recovery.state.reviewFeedback } : {}),
      ...(recovery?.state.reviewRound ? { reviewRound: recovery.state.reviewRound } : {}),
      managedDownloads: recovery?.state.managedDownloads ?? [],
      managedDownloadFailures: recovery?.state.managedDownloadFailures ?? [],
      nativeCoveredDownloads: recovery?.state.nativeCoveredDownloads ?? [],
      ...(declaredIntent ? { intent: declaredIntent } : {}),
      todo: recovery?.state.todo ?? []
    }
  }
  const workflow = {
    ...(activeTask.workflow ?? { completed: [], evidence: {} }),
    required: (isInspiration || isModeling) ? [] : requiredWorkflowStages(project, declaredIntent)
  }
  activeTask.workflow = workflow
  const writeTask = (): Promise<void> => isInspiration ? Promise.resolve() : writeActiveAiTask(activeTask, project)
  updateManagedDownloadAudit(workflow, project, prompt, activeTask.changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
  const missingRecoveryStages = recovery
    ? auditWorkflow(workflow, recovery.changedFiles, buildUsed, runtimeUsed, recovery.state.todo).missing
    : []
  let workflowWrite = Promise.resolve()
  let bufferedFinalResponse: string | undefined
  const deliveredResponseContents = new Set<string>()
  const flushBufferedProgress = (): void => {
    if (!bufferedFinalResponse) return
    const content = bufferedFinalResponse
    bufferedFinalResponse = undefined
    const key = content.trim()
    if (!key || deliveredResponseContents.has(key)) return
    deliveredResponseContents.add(key)
    sendAiOutput(event, 'response', content, sessionId, project.path, context.runId)
  }
  // Read-only informational tasks may still run content validation. Validation
  // alone must not turn a question into a full engineering workflow.
  const engineeringEvidenceStages = new Set<AiWorkflowStage>(['implementation', 'build', 'runtime_test'])
  const ensureEngineeringRequirements = (changedFiles: string[] = [], stage?: AiWorkflowStage): void => {
    const hasEngineeringEvidence = changedFiles.length > 0 || buildUsed || runtimeUsed
      || (stage !== undefined && engineeringEvidenceStages.has(stage))
      || workflow.completed.some((completedStage) => engineeringEvidenceStages.has(completedStage))
    if (declaredIntent === 'informational' && !hasEngineeringEvidence) {
      workflow.required = []
      return
    }
    if (declaredIntent === 'engineering' || hasEngineeringEvidence) {
      workflow.required = (isInspiration || isModeling) ? [] : requiredWorkflowStages(project, 'engineering')
    }
  }
  const recordManagedDownload = (action: ManagedDownloadAction): void => {
    if (!activeTask.state.managedDownloads?.includes(action)) activeTask.state.managedDownloads = [...(activeTask.state.managedDownloads ?? []), action]
    markWorkflowStage(workflow, 'managed_download', `Managed download path used: ${action}`)
    workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
  }
  const recordManagedDownloadFailure = (action: ManagedDownloadAction, error: unknown): void => {
    const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 1_000)
    if (/(?:current project is not|project is not|Maven .*coordinate|Maven .*format|optimization profile not found|only .* allowed|must be saved|只允许|只有世界|必须保存|坐标必须|项目 ID|版本 ID)/i.test(message)) return
    activeTask.state.managedDownloadFailures = [
      ...(activeTask.state.managedDownloadFailures ?? []).filter((failure) => failure.action !== action),
      { action, message }
    ]
    workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
  }
  const recordCoveredNativeDownload = (action: ManagedNativeDownloadAction): void => {
    if (!activeTask.state.nativeCoveredDownloads?.includes(action)) {
      activeTask.state.nativeCoveredDownloads = [...(activeTask.state.nativeCoveredDownloads ?? []), action]
      workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
    }
  }
  const recordWorkflow = (stage: AiWorkflowStage, evidence: string): void => {
    ensureEngineeringRequirements([], stage)
    markWorkflowStage(workflow, stage, evidence)
    workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
  }
  await awaitWithAbort(writeTask(), signal, 'Agent 任务已停止')
  if (activeTask.state.todo?.length) {
    sendCodingProgress(pipelineEvent('planning', '恢复外部代理 Todo', `${activeTask.state.todo.length} 个任务已恢复`, 'running', activeTask.state.todo))
  }
  sendCodingProgress(pipelineEvent('planning', `${agentLabel} 正在接管任务`, '已创建快照并启动 ModMind MCP 桥', 'running'))
  try {
    let managedExternalEnvironment = usesQuota
      ? codexSetup?.environment
      : codexSetup?.environment ?? await awaitWithAbort(externalAgentRunEnvironment(externalBackend, {
          ...settings,
          externalAgents: { ...settings.externalAgents, [externalBackend]: runExternalConfiguration }
        }), signal, 'Agent 任务已停止')
    const providerIdentity = usesQuota
      ? await awaitWithAbort(Promise.resolve(quotaRunConfiguration ?? readBeginnerAgentServerConfig()), signal, 'Agent 任务已停止').then((config) => `${config.baseUrl}\n${config.model}\n${codexSetup?.version ?? ''}\n${createHash('sha256').update(config.apiKey).digest('hex')}`)
      : `${runExternalConfiguration.baseUrl ?? 'local'}\n${runExternalConfiguration.model ?? 'local'}\n${configuredExecutable ?? 'detected'}\n${createHash('sha256').update(runExternalConfiguration.apiKey ?? '').digest('hex')}`
    const providerFingerprint = createHash('sha256').update(`${externalBackend}\n${providerIdentity}`).digest('hex').slice(0, 24)
    const savedReviewFeedback = recovery?.state.reviewFeedback?.trim()
    const addonService = createAddonRelationshipService(() => project)
    const addonContext = isInspiration
      ? null
      : await awaitWithAbort(addonService.describeForAi().catch(() => null), signal, 'Agent 任务已停止')
    throwIfAborted(signal, 'Agent 任务已停止')
    const unifiedHandoff = recovery && backendChanged
      ? `\n\nUNIFIED CONTEXT HANDOFF (revision ${activeTask.contextRevision ?? 0}). The user switched the execution backend from ${recoveryBackend} to ${backend}. This is the same conversation and the same task, not a new request.\nOriginal request: ${recovery.prompt}\nLast summary: ${recovery.state.summary || '(none)'}\nTodo: ${JSON.stringify(recovery.state.todo ?? [])}\nChanged files: ${JSON.stringify(recovery.changedFiles ?? [])}\nCompleted workflow stages: ${JSON.stringify(recovery.workflow?.completed ?? [])}\nTests: ${JSON.stringify(recovery.state.tests ?? [])}\nWarnings: ${JSON.stringify(recovery.state.warnings ?? [])}\nContinue from this unified state. Inspect current project files before editing and do not repeat completed work.`
      : ''
    const initialExternalPrompt = recovery
      ? `${prompt}${unifiedHandoff}\n\nContinue the unfinished action from the unified conversation context. Do not recap context or announce preparation; proceed with the next substantive action. Complete only these missing workflow stages: ${missingRecoveryStages.join(', ') || 'none recorded'}.${savedReviewFeedback ? `\n\nPERSISTED REVIEW FEEDBACK: ${savedReviewFeedback}\nResolve only the stated feedback and the listed missing stages. Do not repeat completed stages.` : ''}`
      : prompt
    const platformPrompt = project.loader === 'netease-pc' || project.loader === 'netease-mobile'
      ? `${initialExternalPrompt}\n\n${NETEASE_CODING_WORKFLOW}`
      : initialExternalPrompt
    const externalRunOptions: ExternalAgentRunOptions = {
      kind: externalBackend,
      runId: activeTask.runId,
      appVersion: app.getVersion(),
      executable: configuredExecutable,
      env: managedExternalEnvironment,
      sessionHome: codexSetup?.home,
      project,
      workflowSourceDirectory: bundledCodexSkillsDirectory(),
      pluginTarget: createPluginBridgeTarget(),
      systemPrompt: isInspiration
        ? `你处于灵感台快速只读模式。优先直接回答；只有答案确实依赖当前实现时才读取项目。普通问题最多做 3 次目录发现或文件读取；只有用户明确要求深入分析、完整审计或逐文件检查时才可超过。不得修改文件、安装依赖、构建、测试或调用任何写入工具。需要浏览目录时，优先调用 modmind_project_files；不要使用 Get-ChildItem -Force、dir 或其它宽泛枚举。读取具体文件时使用明确的项目相对路径。本轮推理强度为 ${reasoningEffort ?? 'low'}。`
        : isModeling
          ? MODELING_SYSTEM_PROMPT
          : codingWorkflowPrompt(project),
      sessionScope,
      // A conversation owns its native CLI thread. Inspiration may resume
      // that thread for context, but never gets workspace recovery sessions.
      resumeSession: context.resumeSession === true || (!isInspiration && Boolean(nativeSessionId)),
      ...(context.fallbackPrompt ? { fallbackPrompt: context.fallbackPrompt } : {}),
      readOnly: isInspiration,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
      prompt: platformPrompt,
      signal: signal ?? new AbortController().signal,
      persistentRetry: true,
      onStarted: () => {
        activeTask.lifecycle = 'running'
        delete activeTask.recovery
        workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
        lifecycle.onBackendReady?.()
      },
      onSessionId: (externalSessionId) => {
        activeTask.sessionId = externalSessionId
        activeTask.nativeSessions = { ...activeTask.nativeSessions, [backend]: externalSessionId }
        workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
      },
      onAttemptAudit: (audit) => writeAiAttemptAudit(audit, sessionId, project.path),
      retryScope: providerFingerprint,
      sessionFingerprint: providerFingerprint,
      onRetryState: (state) => {
        activeTask.lifecycle = state.phase === 'waiting' ? 'waiting_retry' : 'repairing'
        activeTask.recovery = {
          category: state.category,
          attempt: state.attempt,
          message: state.message.slice(0, 4_000),
          nextAttemptAt: state.nextAttemptAt
        }
        workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
        return workflowWrite
      },
      onNativeDownload: (action, command) => {
        recordCoveredNativeDownload(action)
        if (action === 'runtime_download') {
          sendAiOutput(event, 'warning', `已阻止绕过 ModMind 的运行时下载：${command}\n请使用 ModMind 的构建、测试、运行时或服务端工具。`, sessionId, project.path, context.runId)
          return false
        }
        const fallbackAllowed = (activeTask.state.managedDownloadFailures ?? []).some((failure) => failure.action === action
          || (action === 'modpack_apply_plan' && failure.action === 'modpack_apply_optimization_profile'))
        if (!fallbackAllowed) {
          sendAiOutput(event, 'warning', `已阻止绕过 ModMind 的已覆盖下载：${command}\n请先使用对应的 ModMind 下载工具；只有工具实际失败后才允许原生回退。`, sessionId, project.path, context.runId)
        }
        return fallbackAllowed
      },
      onOutput: (kind, content) => {
        if (kind === 'response') {
          // A newer reply proves the previous one was progress narration, so
          // it is safe to show before the final completion audit.
          const key = content.trim()
          if (!key || key === bufferedFinalResponse?.trim() || deliveredResponseContents.has(key)) return
          flushBufferedProgress()
          bufferedFinalResponse = content
          return
        }
        // A tool/action after an Agent reply likewise proves that reply was
        // progress, not the final audited result. Do not leave it invisible.
        flushBufferedProgress()
        sendAiOutput(
          event,
          kind,
          content,
          sessionId,
          project.path,
          context.runId,
          kind === 'error' ? { terminal: false, recoverable: true } : undefined
        )
      },
      onProgress: (title, detail, status) => sendCodingProgress(pipelineEvent(
        status === 'error' ? 'error' : status === 'success' ? 'checking' : 'writing', title, detail, status,
        undefined,
        status === 'error' ? { terminal: false, recoverable: true } : undefined
      )),
      bridge: {
        projectInfo: { ...project, integrationDirectory: path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents'), ...(addonContext ? { addonRelationships: addonContext } : {}) },
        projectFiles: async () => {
          const files = await listManagedFiles(project.path, (name) => ignoredDirectories.has(name) || isToolDataDirectory(name))
          return { files: files.slice(0, 5_000), truncated: files.length > 5_000 }
        },
        toolCalled: (action) => {
          if (action === 'project_info') recordWorkflow('project_info', 'modmind_project_info returned active project metadata')
          if (action === 'set_intent') recordWorkflow('intent', 'modmind_set_intent recorded task intent')
          if (action === 'update_todo') recordWorkflow('plan', 'modmind_update_todo published the ordered plan')
        },
        reviewAction: async (action, input) => {
          const decision = await reviewAiAction(reviewerConfig, { project, request: prompt, action, input }, signal)
          if (decision.fallback === 'local-rules' && !reviewerFallbackNotified) {
            reviewerFallbackNotified = true
            sendCodingProgress(pipelineEvent('checking', '审查 Agent 已切换本地规则', decision.feedback, 'warning'))
          } else if (decision.unavailable && !reviewerUnavailableNotified) {
            reviewerUnavailableNotified = true
            sendCodingProgress(pipelineEvent('checking', '审查 Agent 暂不可用', decision.feedback, 'warning'))
          } else if (!decision.unavailable) {
            sendCodingProgress(pipelineEvent('checking', decision.approved ? '审查 Agent 已放行操作' : '审查 Agent 要求调整操作', decision.feedback || `${action} 风险：${decision.risk}`, decision.approved ? 'success' : 'warning'))
          }
          return decision
        },
        renameProject: (name, namespace) => renameProjectRecord(project, { name, namespace }),
        setIntent: async (intent, reason) => {
          declaredIntent = intent
          workflow.required = isInspiration ? [] : requiredWorkflowStages(project, intent)
          recordWorkflow('intent', `Intent classified as ${intent}`)
          activeTask.state.intent = intent
          const explanation = reason.trim().slice(0, 500) || (intent === 'engineering' ? '用户要求修改项目' : '用户没有要求修改项目')
          await writeTask()
          sendCodingProgress(pipelineEvent(
            'planning',
            intent === 'engineering' ? '已识别为工程任务' : '已识别为咨询任务',
            explanation,
            'success'
          ))
          return { success: true, intent, instruction: intent === 'engineering'
            ? 'Use the workflow and tools that best fit the engineering request.'
            : 'Use the workflow and tools that best fit the informational request.' }
        },
        applyEdits: async (values) => {
          if (values.length < 1) throw new Error('modmind_apply_edits 至少需要 1 个精确编辑')
          const staged = new Map<string, {target: string; content: string}>()
          for (const value of values) {
            if (!value || typeof value !== 'object') throw new Error('编辑格式无效')
            const source = value as Record<string, unknown>
            const normalized = normalizeCodingPath(String(source.path ?? ''), settings.allowBuildScriptChanges)
            if (typeof source.newText !== 'string') throw new Error(`编辑 ${normalized} 缺少 newText`)
            const oldText = typeof source.oldText === 'string' ? source.oldText : ''
            const target = await resolveSafeCodingTarget(normalized)
            const stagedFile = staged.get(normalized)
            const exists = stagedFile !== undefined || await pathExists(target)
            if (!oldText) {
              if (exists) throw new Error(`新建文件 ${normalized} 已存在；请提供 oldText 进行精确编辑`)
              staged.set(normalized, {target, content: source.newText})
              continue
            }
            if (!exists) throw new Error(`编辑目标 ${normalized} 不存在`)
            const current = stagedFile?.content ?? await fs.readFile(target, 'utf8')
            const newline = current.includes('\r\n') ? '\r\n' : '\n'
            const matchText = oldText.replace(/\r\n|\r|\n/g, newline)
            const replacement = source.newText.replace(/\r\n|\r|\n/g, newline)
            const occurrences = current.split(matchText).length - 1
            if (occurrences !== 1) throw new Error(`编辑 ${normalized} 的 oldText 匹配 ${occurrences} 次，必须恰好匹配 1 次`)
            staged.set(normalized, {target, content: current.replace(matchText, replacement)})
          }
          for (const {target, content} of staged.values()) {
            await fs.mkdir(path.dirname(target), {recursive: true})
            await fs.writeFile(target, content, 'utf8')
          }
          const changed = [...staged.keys()]
          recordWorkflow('implementation', `Applied ${changed.length} project edit(s)`)
          activeTask.changedFiles = [...new Set([...activeTask.changedFiles, ...changed])]
          activeTask.state.applyRounds += 1
          await writeTask()
          return { success: true, changedFiles: changed }
        },
        updateTodo: async (values) => {
          if (values.length > 500) throw new Error('Todo 列表过大')
          const ids = new Set<string>()
          const next = values.map((value, index): AgentTodoItem => {
            if (!value || typeof value !== 'object') throw new Error(`Todo ${index + 1} 格式无效`)
            const source = value as Record<string, unknown>
            const id = typeof source.id === 'string' ? source.id.trim() : ''
            const title = typeof source.title === 'string' ? source.title.trim() : ''
            const status = source.status
            if (!id || id.length > 64 || ids.has(id)) throw new Error(`Todo ${index + 1} 的 id 无效或重复`)
            if (!title || title.length > 240) throw new Error(`Todo ${id} 的标题无效`)
            if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new Error(`Todo ${id} 的状态无效`)
            ids.add(id)
            return { id, title, status }
          })
          activeTask.state.todo = next
          activeTask.state.tasks = next.map((todo) => todo.title)
          if (next.length > 0) recordWorkflow('plan', `Todo plan contains ${next.length} item(s)`)
          await writeTask()
          const completed = next.filter((todo) => todo.status === 'completed').length
          sendCodingProgress(pipelineEvent('planning', '外部代理 Todo 已更新', `${completed}/${next.length} 个任务完成`, completed === next.length ? 'success' : 'running', next))
          return { success: true, tasks: next }
        },
        mappingsSearch: (query, limit) => requireMappings().search(project.minecraftVersion, query, Math.min(Math.max(limit ?? 20, 1), 50)),
        mappingsClass: (className, memberQuery) => requireMappings().getClass(project.minecraftVersion, className, memberQuery),
        dependencySearch: (query, offset) => requireDependencyService().search(query, Math.min(Math.max(offset ?? 0, 0), 1_000)),
        dependencyInstall: async (projectId, versionId) => {
          try {
            const dependency = await requireDependencyService().install({ projectId, versionId })
            recordManagedDownload('dependency_install')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'build.gradle', 'modmind.dependencies.json', dependency.relativePath])]
            await writeTask()
            return dependency
          } catch (error) {
            recordManagedDownloadFailure('dependency_install', error)
            throw error
          }
        },
        mavenDependencyInstall: async (input) => {
          try {
            const dependency = await requireDependencyService().installMaven(input as unknown as MavenDependencyInput)
            recordManagedDownload('maven_dependency_install')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'build.gradle', 'build.gradle.kts', 'modmind.dependencies.json'])]
            await writeTask()
            return dependency
          } catch (error) {
            recordManagedDownloadFailure('maven_dependency_install', error)
            throw error
          }
        },
        addonRelationships: () => addonService.describeForAi(),
        addonPrepare: async (input) => {
          try {
            const manifest = await addonService.prepare(normalizeAddonPrepareInput(input))
            recordManagedDownload('addon_prepare')
            activeTask.changedFiles = [...new Set([
              ...activeTask.changedFiles,
              'modmind.relationships.json',
              'modmind.dependencies.json',
              'build.gradle',
              'build.gradle.kts',
              descriptorPath(project.loader, project.minecraftVersion),
              ...manifest.relationships.map((entry) => entry.relativePath)
            ])]
            await writeTask()
            return addonService.describeForAi()
          } catch (error) {
            recordManagedDownloadFailure('addon_prepare', error)
            throw error
          }
        },
        addonImport: async (paths, role) => {
          try {
            const manifest = await addonService.importExact(await resolveAddonImportPaths(project, paths), role === 'optional' || role === 'test' ? role : 'required')
            recordManagedDownload('addon_prepare')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'modmind.relationships.json', 'modmind.dependencies.json', descriptorPath(project.loader, project.minecraftVersion), ...manifest.relationships.map((entry) => entry.relativePath)])]
            await writeTask()
            return addonService.describeForAi()
          } catch (error) {
            recordManagedDownloadFailure('addon_prepare', error)
            throw error
          }
        },
        addonLinkProject: async (projectPath) => {
          try {
            const manifest = await linkAddonProject(project, projectPath, signal) as Awaited<ReturnType<AddonRelationshipService['list']>>
            recordManagedDownload('addon_prepare')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'modmind.relationships.json', 'modmind.dependencies.json', descriptorPath(project.loader, project.minecraftVersion), ...manifest.relationships.map((entry) => entry.relativePath)])]
            await writeTask()
            return addonService.describeForAi()
          } catch (error) {
            recordManagedDownloadFailure('addon_prepare', error)
            throw error
          }
        },
        modpackPlan: async (concept) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const plan = await planModpack(requireModProviderRegistry(), project, concept as unknown as Parameters<typeof planModpack>[2], mcmodService, signal)
          await saveManualModRequirements(project, plan.manualRequired ?? [])
          return plan
        },
        modpackApplyPlan: async (plan) => {
          try {
            if (!isModpackProject(project)) throw new Error('current project is not a modpack')
            const result = await applyModpackPlan(requireModProviderRegistry(), project, plan as unknown as Parameters<typeof applyModpackPlan>[2], signal)
            recordManagedDownload('modpack_apply_plan')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'modmind.pack.json', 'modmind.modpack.lock.json', ...result.installed.map((name) => `mods/${name}`)])]
            await writeTask()
            return result
          } catch (error) {
            recordManagedDownloadFailure('modpack_apply_plan', error)
            throw error
          }
        },
        modpackMigrationTargets: async () => (await requireLoaderCatalog().list()).filter((option) => ['fabric', 'quilt', 'forge', 'neoforge'].includes(option.loader)),
        modpackMigrationPreview: (input) => previewModpackMigrationForAgent(project, input),
        modpackMigrationApply: async (input) => {
          const result = await applyModpackMigrationForAgent(project, input)
          activeTask.changedFiles = [...new Set([...activeTask.changedFiles, 'modmind.project.json', 'modmind.pack.json', 'modmind.modpack.lock.json', path.relative(project.path, result.reportPath).replaceAll('\\', '/')])]
          await writeTask()
          return result
        },
        modpackMigrationHistory: () => listModpackMigrationRecords(project),
        modpackMigrationUndo: async (migrationId) => {
          const result = await withMinecraftResourceLock(() => undoModpackMigration(project, migrationId))
          Object.assign(project, result.restoredProject)
          await writeTask()
          return result
        },
        modpackDownloadContent: async (input) => {
          try {
            if (!isModpackProject(project)) throw new Error('current project is not a modpack')
            const result = await downloadModpackContent(project, input as unknown as ModpackContentDownloadInput)
            recordManagedDownload('modpack_download_content')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, result.item.path])]
            await writeTask()
            return result
          } catch (error) {
            recordManagedDownloadFailure('modpack_download_content', error)
            throw error
          }
        },
        mcmodSearch: (query, limit) => mcmodService.search(query, Math.min(Math.max(limit ?? 10, 1), 20), signal),
        mcmodFiles: async (projectId) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const files = await mcmodService.listFiles(projectId, signal)
          const loader = project.loader.toLowerCase()
          return files.filter((file) => file.minecraftVersion.split('/').includes(project.minecraftVersion)
            && (!file.loaders.length || file.loaders.some((value) => value.toLowerCase().includes(loader))))
        },
        modpackWriteFtbQuest: async (input) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const relative = await writeFtbQuestChapter(project, input as unknown as Parameters<typeof writeFtbQuestChapter>[1])
          activeTask.changedFiles = [...new Set([...activeTask.changedFiles, relative])]
          await writeTask()
          return { success: true, path: relative }
        },
        modpackWritePatchouliBook: async (input) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const paths = await writePatchouliBook(project, input as unknown as Parameters<typeof writePatchouliBook>[1])
          activeTask.changedFiles = [...new Set([...activeTask.changedFiles, ...paths])]
          await writeTask()
          return { success: true, paths }
        },
        modpackApplyKeybindPreset: async (input, allowConflicts) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const result = await applyKeybindPreset(project, input as unknown as Parameters<typeof applyKeybindPreset>[1], allowConflicts)
          activeTask.changedFiles = [...new Set([...activeTask.changedFiles, result.path])]
          await writeTask()
          return result
        },
        modpackBuildServer: async (input) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const outputDirectory = typeof input.outputDirectory === 'string' && input.outputDirectory.trim() ? input.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-pack')
          const manifest = await readModpackManifest(project)
          const engine = manifest.mods.length ? 'serverpackcreator' : 'internal'
          const javaPath = engine === 'serverpackcreator' ? await runtime.ensureJavaRuntime(undefined, SERVER_PACK_CREATOR_MIN_JAVA) : undefined
          const result = await withMinecraftResourceLock(() => buildServerPack(project, { outputDirectory, port: typeof input.port === 'number' ? input.port : undefined, acceptEula: true, includeUnknownSideMods: false, onlineMode: input.onlineMode !== false, engine, ...(javaPath ? { javaPath, cacheDirectory: path.join(app.getPath('userData'), 'server-pack-creator') } : {}) }))
           recordWorkflow('build', 'modmind_modpack_build_server completed successfully')
           activeTask.changedFiles = [...new Set([...activeTask.changedFiles, path.relative(project.path, result.manifestPath).replaceAll('\\', '/')])]
          await writeTask()
          return result
        },
        modpackVerifyServerJoin: async (input) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const javaPath = await runtime.ensureJavaRuntime()
          const port = typeof input.port === 'number' ? input.port : 25565
          const outputDirectory = typeof input.outputDirectory === 'string' && input.outputDirectory.trim() ? input.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-pack')
          const result = await withMinecraftResourceLock(() => buildAndJoinServer({ project, outputDirectory, port, acceptEula: true, onlineMode: input.onlineMode === true, javaPath, headless: requireHeadlessMc(), gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'server-join'), onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
           runtimeUsed = result.success
           if (result.success) recordWorkflow('runtime_test', 'modmind_modpack_verify_server_join completed successfully')
           return result
        },
        modpackApplyOptimizationProfile: async (input) => {
          try {
            if (!isModpackProject(project)) throw new Error('current project is not a modpack')
            const value = input as Record<string, unknown>
            const profileId = typeof value.profileId === 'string' ? value.profileId : ''
            const builtIn = BUILTIN_OPTIMIZATION_PROFILES.find((profile) => profile.id === profileId)
            const profile = builtIn ?? value.profile
            if (!profile || typeof profile !== 'object') throw new Error(`optimization profile not found: ${profileId}`)
            const result = await applyOptimizationProfile(requireModProviderRegistry(), project, profile as Parameters<typeof applyOptimizationProfile>[2], signal)
            recordManagedDownload('modpack_apply_optimization_profile')
            activeTask.changedFiles = [...new Set([...activeTask.changedFiles, ...result.appliedPatches, 'modmind.modpack.lock.json'])]
            await writeTask()
            return result
          } catch (error) {
            recordManagedDownloadFailure('modpack_apply_optimization_profile', error)
            throw error
          }
        },
        modpackRunServerScenario: async (input) => {
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const javaPath = await runtime.ensureJavaRuntime()
          if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('server scenario requires at least one step')
          const steps = input.steps.map((step) => {
            if (!step || typeof step !== 'object') throw new Error('invalid server scenario step')
            const record = step as Record<string, unknown>
            return { command: String(record.command ?? ''), expect: Array.isArray(record.expect) ? record.expect.map(String) : [], timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined }
          })
          const port = typeof input.port === 'number' ? input.port : 25565
          const outputDirectory = typeof input.outputDirectory === 'string' && input.outputDirectory.trim() ? input.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-scenario')
          const result = await withMinecraftResourceLock(() => runServerScenario({ project, outputDirectory, port, acceptEula: true, onlineMode: input.onlineMode === true, javaPath, steps, onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
           runtimeUsed = result.success
           if (result.success) recordWorkflow('runtime_test', 'modmind_modpack_run_server_scenario completed successfully')
           return result
        },
        contentValidate: async () => {
          const result = await requireContentService().validate()
          recordWorkflow('validate', 'modmind_validate_content completed successfully')
          return result
        },
        testMatrix: async (targets) => {
          const selected = [...new Set(targets)].filter((target): target is TestTarget => ['build', 'client', 'server', 'gametest'].includes(target))
          const matrix = await runProjectTestMatrix(selected, signal)
          if (selected.includes('build') || selected.includes('client')) {
            buildUsed = matrix.results.some((result) => (result.target === 'build' || result.target === 'client') && result.status === 'passed')
            if (buildUsed) {
              recordWorkflow('build', 'modmind_test_matrix passed a build/client target')
              lastBuildHashes = await managedCodingHashes(project)
            }
          }
          if (selected.some((target) => target === 'client' || target === 'server' || target === 'gametest')) {
            runtimeUsed = matrix.success
            if (runtimeUsed) {
              recordWorkflow('runtime_test', 'modmind_test_matrix passed runtime targets')
              lastRuntimeHashes = await managedCodingHashes(project)
            }
          }
          activeTask.state.lastBuildSucceeded = matrix.success && buildUsed
          await writeTask()
          return matrix
        },
        releasePreflight: () => requireReleaseService().preflight(),
        build: async () => {
          buildCount += 1
          activeTask.state.buildCount = buildCount
          await writeTask()
          buildUsed = true
          const artifact = await buildProjectWithLock(signal)
          recordWorkflow('build', 'modmind_build_project completed successfully')
          lastBuildHashes = await managedCodingHashes(project)
          activeTask.state.lastBuildSucceeded = true
          await writeTask()
          return { success: true, artifact }
        },
        testMinecraft: async () => {
          const currentHashes = await managedCodingHashes(project)
          if (!buildUsed || !codingHashesEqual(lastBuildHashes, currentHashes)) {
            buildCount += 1
            activeTask.state.buildCount = buildCount
            await writeTask()
            buildUsed = true
            await buildProjectWithLock(signal)
            recordWorkflow('build', 'modmind_test_minecraft completed the managed build')
            lastBuildHashes = await managedCodingHashes(project)
            activeTask.state.lastBuildSucceeded = true
            await writeTask()
          }
          const smokeArtifact = (await runtime.listMods()).find((mod) => mod.projectArtifact)
          const smoke = await runHeadlessMinecraftSmoke(project, signal, { artifact: smokeArtifact, stableWindowMs: 20_000, offline: true })
          if (!smoke.success) throw new Error(smoke.message || 'HeadlessMC smoke test failed')
          runtimeUsed = true
          recordWorkflow('runtime_test', 'modmind_test_minecraft completed a HeadlessMC smoke test')
          lastRuntimeHashes = await managedCodingHashes(project)
          return smoke
        },
        blockbenchActions: async (actions, expectedRevision) => {
          return requireBlockbenchForProject(project).executeActions(actions as BlockbenchAction[], signal, expectedRevision)
        },
        blockbenchProjectState: () => requireBlockbenchForProject(project).getProjectState(),
        blockbenchValidate: () => requireBlockbenchForProject(project).validateProject(),
        blockbenchCaptureViews: (input) => requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest),
        blockbenchHistory: () => requireBlockbenchForProject(project).listHistory(),
        blockbenchCheckpoint: (label) => requireBlockbenchForProject(project).createCheckpoint(label),
        blockbenchRestoreHistory: (id) => requireBlockbenchForProject(project).restoreHistory(id),
        assetCompileIntent: async (input) => compileAssetIntent(input),
        assetPreviewIntent: (input, capture, expectedRevision) => previewAssetIntentCandidate(
          requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
        ),
        assetApplyIntent: async (input, expectedRevision) => {
          const candidate = compileAssetIntent(input)
          if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
          const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
          return {...candidate, execution}
        },
        assetCompileRefinement: (input) => compileAssetRefinementForBridge(requireBlockbenchForProject(project), input),
        assetPreviewRefinement: (input, capture, expectedRevision) => previewAssetRefinementCandidate(
          requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
        ),
        assetApplyRefinement: (input, expectedRevision) => applyAssetRefinementCandidate(
          requireBlockbenchForProject(project), input, signal, expectedRevision
        ),
        assetCompileAdvanced: async (input, variantId) => compileAdvancedAsset(input, variantId),
        assetPreviewAdvanced: (input, capture, options, expectedRevision) => previewAdvancedAssetComparison(
          requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined,
          options as AdvancedAssetPreviewOptions | undefined, signal, expectedRevision
        ),
        assetApplyAdvanced: async (input, variantId, expectedRevision) => {
          const candidate = compileAdvancedAsset(input, variantId)
          if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
          const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
          return {...candidate, execution}
        },
        assetCompileReference: (input) => compileReferenceImageAsset(input),
        assetPreviewReference: (input, capture, expectedRevision) => previewReferenceImageCandidate(
          requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision
        ),
        assetApplyReference: async (input, expectedRevision) => {
          const candidate = await compileReferenceImageAsset(input)
          const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision)
          return {...candidate, execution}
        },
        assetVisualReview: async (input) => {
          const captures = await requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest)
          return {...captures, review: await reviewAssetCaptures(captures.captures)}
        },
        runtimeState: async () => runtime.getState(),
        javaHomeScan: () => detectInstalledJavaHomes(),
        javaHomeProbe: (home) => probeJavaHomeInfo(home),
        appSettingsRead: async () => publicAgentSettings(await readSettings()),
        appSettingsWrite: (input) => applyAppSettingWrite(input)
        ,imageGenerate: async (input) => {
          const imageRequest = normalizeAgentImageRequest(input)
          if (!imageRequest.prompt) throw new Error('图片生成工具需要 prompt')
          const generated = await requireImageStudio().generate(imageRequest)
          const outputRoot = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'image-studio', 'generated')
          await fs.mkdir(outputRoot, { recursive: true })
          const files: string[] = []
          const assets: Array<{ path?: string; dataUrl?: string; handoffAvailable: boolean }> = []
          for (const [index, asset] of generated.assets.entries()) {
            const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(asset.dataUrl)
            let relative: string | undefined
            if (match) {
              relative = path.posix.join(project.toolDataDirectory ?? '.modmind', 'image-studio', 'generated', `${generated.jobId}-${index + 1}.png`)
              await fs.writeFile(path.join(project.path, ...relative.split('/')), Buffer.from(match[1], 'base64'))
              files.push(relative)
            }
            // Blockbench accepts a maximum 8 MiB PNG data URL. Give the
            // agent a bounded handoff so it can process or bind the image
            // without granting read access to ModMind's protected folder.
            const handoffAvailable = asset.dataUrl.startsWith('data:image/') && asset.dataUrl.length <= 8 * 1024 * 1024
            assets.push({ ...(relative ? { path: relative } : {}), ...(handoffAvailable ? { dataUrl: asset.dataUrl } : {}), handoffAvailable })
          }
          return { success: true, jobId: generated.jobId, files, assets, credits: generated.credits, hosted: generated.hosted, revisedPrompt: generated.revisedPrompt }
        },
        imageProcess: (operation, dataUrl) => requireImageStudio().process(operation, dataUrl),
        imageProjectAssets: async () => {
          const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap((node) => node.type === 'directory' ? flatten(node.children ?? []) : [node])
          return flatten(await listDirectory(project.path)).filter((node) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(node.path)).slice(0, 500).map((node) => node.path)
        },
        imageReadProjectAsset: async (relativePath) => {
          const normalized = normalizeReadablePath(relativePath)
          if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(normalized)) throw new Error('只能读取项目图片资源')
          const target = resolveProjectPath(normalized)
          const stat = await fs.stat(target)
          if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('参考图不存在或超过 20 MB')
          const mime = /\.jpe?g$/i.test(normalized) ? 'image/jpeg' : /\.webp$/i.test(normalized) ? 'image/webp' : /\.gif$/i.test(normalized) ? 'image/gif' : /\.bmp$/i.test(normalized) ? 'image/bmp' : 'image/png'
          return { path: normalized, dataUrl: `data:${mime};base64,${(await fs.readFile(target)).toString('base64')}` }
        }
      }
    }
    const baseExternalPrompt = platformPrompt
    const completedAnswer = (candidate: Awaited<ReturnType<typeof runExternalAgent>>): string => selectFinalAiAnswer(bufferedFinalResponse, candidate.summary, deliveredResponseContents)
    const runUntilAnswer = async (): Promise<Awaited<ReturnType<typeof runExternalAgent>>> => {
      const requestedRunPrompt = externalRunOptions.prompt
      let missingAnswerAttempts = 0
      while (true) {
        const candidate = await runExternalAgent(externalRunOptions)
        if (completedAnswer(candidate)) return candidate
        missingAnswerAttempts += 1
        const message = `${agentLabel} 本轮只返回了过程或重试状态，没有有效最终回答；正在继续同一会话（第 ${missingAnswerAttempts + 1} 次）`
        sendCodingProgress(pipelineEvent('checking', '正在等待有效回答', message, 'warning'))
        sendAiOutput(event, 'retry', message, sessionId, project.path, context.runId)
        bufferedFinalResponse = undefined
        deliveredResponseContents.clear()
        externalRunOptions.prompt = `${requestedRunPrompt}\n\nThe previous attempt ended without a substantive user-facing final answer. Continue the same request and return the complete answer now. Do not return retry notices, internal reasoning, or process narration as the answer.`
        await awaitWithAbort(new Promise((resolve) => setTimeout(resolve, 1_000)), signal, 'Agent 任务已停止')
      }
    }
    let result = await runUntilAnswer()
    updateManagedDownloadAudit(workflow, project, prompt, activeTask.changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
    let finalWorkflowAudit = auditWorkflow(workflow, [], buildUsed, runtimeUsed, activeTask.state.todo)
    let reviewApproved = isInspiration
    if (isInspiration) finalWorkflowAudit = { ...finalWorkflowAudit, missing: [] }
    for (let reviewRound = 0; reviewRound < (isInspiration ? 0 : 3); reviewRound += 1) {
      const reviewedAfter = await managedCodingHashes(project)
      const reviewedFiles = [...new Set([...before.keys(), ...reviewedAfter.keys()])].filter((file) => before.get(file) !== reviewedAfter.get(file))
      ensureEngineeringRequirements(reviewedFiles)
      updateManagedDownloadAudit(workflow, project, prompt, reviewedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
      finalWorkflowAudit = auditWorkflow(workflow, reviewedFiles, buildUsed, runtimeUsed, activeTask.state.todo)
      const rawDecision = await reviewAiCompletion(reviewerConfig, {
        project,
        request: prompt,
        summary: result.summary,
        changedFiles: reviewedFiles,
        transcriptTail: result.transcript,
        workflow: {
          required: finalWorkflowAudit.required,
          completed: finalWorkflowAudit.completed,
          missing: finalWorkflowAudit.missing,
          evidence: finalWorkflowAudit.evidence as Record<string, string>
        }
      }, signal)
      const missingWorkflow = finalWorkflowAudit.missing
      const workflowFeedback = missingWorkflow.length
        ? `Mandatory workflow incomplete. Missing stages: ${missingWorkflow.join(', ')}.`
        : ''
      const decision = missingWorkflow.length
        ? { ...rawDecision, complete: false, feedback: [workflowFeedback, rawDecision.feedback].filter(Boolean).join(' ') }
        : rawDecision
      if ((decision.approved && decision.complete && missingWorkflow.length === 0) || (decision.unavailable && missingWorkflow.length === 0)) {
        reviewApproved = true
        break
      }
      const feedback = decision.feedback || '请继续检查用户需求、实现完整性和验证结果'
      await workflowWrite
      activeTask.state.reviewFeedback = feedback.slice(0, 4_000)
      activeTask.state.reviewRound = (activeTask.state.reviewRound ?? 0) + 1
      await writeTask()
      sendCodingProgress(pipelineEvent('checking', '审查 Agent 要求继续完善', feedback, 'warning'))
      sendAiOutput(event, 'retry', `审查 Agent 反馈：${feedback}`, sessionId, project.path, context.runId)
      externalRunOptions.prompt = `${baseExternalPrompt}\n\nREVIEW AGENT FEEDBACK: ${feedback}\nResolve only this feedback and the currently missing workflow stages. Preserve completed work; do not replay completed planning, implementation, build, or runtime stages.`
      bufferedFinalResponse = undefined
      result = await runUntilAnswer()
    }
    const after = isInspiration ? before : await managedCodingHashes(project)
    const changedFiles = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file))
    ensureEngineeringRequirements(changedFiles)
    updateManagedDownloadAudit(workflow, project, prompt, changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
    finalWorkflowAudit = auditWorkflow(workflow, changedFiles, buildUsed, runtimeUsed, activeTask.state.todo)
    if (!reviewApproved || finalWorkflowAudit.missing.length > 0) {
      const missing = finalWorkflowAudit.missing.join(', ')
      throw new Error(`Review Agent rejected completion because the mandatory workflow is incomplete. Missing stages: ${missing || 'independent review approval'}. The active task and snapshot were preserved for recovery.`)
    }
    const finalIntent = isModeling ? 'informational' : (declaredIntent ?? (changedFiles.length ? 'engineering' : 'informational'))
    activeTask.changedFiles = changedFiles
    const finalResponse = completedAnswer(result).slice(-120_000)
    const summary = finalResponse.slice(0, 4_000)
    const tests = [
      ...(buildUsed ? ['已使用 ModMind 托管构建'] : []),
      ...(runtimeUsed ? ['已使用 ModMind Minecraft 测试'] : [])
    ]
    const report = {
      prompt,
      sessionId: activeTask.sessionId,
      backend,
      createdAt: new Date().toISOString(),
      summary,
      finalResponse,
      intent: finalIntent,
      tasks: activeTask.state.tasks,
      files: changedFiles.map((file) => ({ path: file, purpose: '外部代理修改' })),
      tests,
      warnings: activeTask.state.warnings,
      ...(changedFiles.length ? { snapshotId: snapshot.id } : {}),
      buildVerified: buildUsed,
      runtimeVerified: runtimeUsed,
      workflow: finalWorkflowAudit
    }
    await fs.mkdir(path.join(project.path, 'docs'), { recursive: true })
    // This file describes the latest completed AI turn, including
    // informational turns with an empty files list.
    if (!isInspiration) await fs.writeFile(resolveProjectPath('docs/last-ai-change.json'), JSON.stringify(report, null, 2), 'utf8')
    if (!changedFiles.length) {
      await fs.rm(path.join(project.path, projectDataDirectory(project), 'snapshots', snapshot.id), { recursive: true, force: true }).catch(() => undefined)
    }
    if (!isInspiration) await fs.writeFile(resolveProjectPath('docs/last-ai-response.txt'), sanitizeAiUserText(finalResponse), 'utf8')
    if (!isInspiration) await clearActiveAiTask(project, taskId)
    // Publish the completed task result as one dedicated event. The last
    // candidate response is intentionally withheld from the ordinary stream
    // so consumers cannot render it once as progress and once as the answer.
    bufferedFinalResponse = undefined
    sendAiOutput(event, 'answer', finalResponse, sessionId, project.path, context.runId, result.usage ? { usage: result.usage } : undefined)
    sendCodingProgress(pipelineEvent('complete', `${agentLabel} 任务完成`, changedFiles.length ? `检测到 ${changedFiles.length} 个文件变化` : '任务已完成，没有要求文件变化', 'success'))
    return {
      summary,
      finalResponse,
      tasks: activeTask.state.tasks,
      files: changedFiles.map((file) => ({ path: file, purpose: '外部代理修改' })),
      tests,
      warnings: activeTask.state.warnings,
      snapshot,
      changedFiles,
      intent: finalIntent,
      todo: activeTask.state.todo
    }
  } catch (error) {
    await workflowWrite.catch(() => undefined)
    if (!isInspiration) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = error instanceof Error && error.name === 'AbortError'
      const actionRequired = /(?:401|402|403|API Key|凭证|额度|余额|权限|模型.*不存在|CLI 未安装)/i.test(message)
      activeTask.lifecycle = cancelled ? 'paused' : actionRequired ? 'action_required' : 'paused'
      activeTask.recovery = {
        category: cancelled ? 'cancelled' : actionRequired ? 'action-required' : 'process',
        attempt: activeTask.recovery?.attempt ?? 0,
        message: message.slice(0, 4_000)
      }
      const failedHashes = await managedCodingHashes(project).catch(() => null)
      if (failedHashes) {
        activeTask.changedFiles = [...new Set([...before.keys(), ...failedHashes.keys()])]
          .filter((file) => before.get(file) !== failedHashes.get(file))
      }
      await writeTask().catch(() => undefined)
    }
    if (isInspiration) await fs.rm(path.join(project.path, projectDataDirectory(project), 'snapshots', snapshot.id), { recursive: true, force: true }).catch(() => undefined)
    // Keep the snapshot and active task for automatic or manual recovery in the workspace.
    flushBufferedProgress()
    throw error
  }
}

async function createAiCode(
  event: Electron.IpcMainInvokeEvent,
  prompt: string,
  sessionId?: string,
  backendOverride?: AgentSettings['codingBackend'],
  executionProfile: AiExecutionProfile = 'standard',
  context: AiCreateCodeOptions = {},
  taskSignal?: AbortSignal
): Promise<CodingResult> {
  const settings = await readSettings()
  const backend = backendOverride ?? settings.codingBackend
  return runExternalCodingAgent(event, prompt, sessionId, backend, executionProfile, undefined, context, taskSignal)
}

async function findE2EAssets(root: string): Promise<{ models: string[]; textures: string[] }> {
  const models: string[] = []
  const textures: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name) || isToolDataDirectory(entry.name)) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else {
        const relative = path.relative(root, fullPath).replaceAll('\\', '/')
        if (relative.endsWith('.bbmodel')) models.push(relative)
        if (relative.endsWith('.png')) textures.push(relative)
      }
    }
  }
  await visit(root)
  return { models, textures }
}

async function findRuntimeResourceWarnings(project: ProjectInfo): Promise<string[]> {
  const logPath = path.join(project.path, projectDataDirectory(project), 'minecraft', 'launcher-console.log')
  const content = await fs.readFile(logPath, 'utf8').catch(() => '')
  const warnings = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(project.namespace))
    .filter((line) => line.includes('Unable to load model:') || line.includes('Missing textures in model'))
    .map((line) => line.replace(/^.*?<!\[CDATA\[/, '').replace(/\]\]>.*$/, '').trim())
  return [...new Set(warnings)].slice(0, 30)
}

async function runAutomatedE2E(): Promise<void> {
  const projectPath = process.env.MODMIND_E2E_PROJECT ?? process.env.MODTOOL_E2E_PROJECT
  if (!projectPath) throw new Error('MODMIND_E2E_PROJECT is required')
  const reportPath = process.env.MODMIND_E2E_REPORT ?? process.env.MODTOOL_E2E_REPORT ?? path.join(app.getPath('temp'), 'modmind-agent-e2e.json')
  const encodedPrompt = process.env.MODMIND_E2E_PROMPT_BASE64 ?? process.env.MODTOOL_E2E_PROMPT_BASE64
  const prompt = encodedPrompt
    ? Buffer.from(encodedPrompt, 'base64').toString('utf8')
    : 'Create a small interesting Minecraft boss with a Blockbench model and patterned texture.'
  const report: Record<string, unknown> = { status: 'starting', projectPath, startedAt: new Date().toISOString() }
  const writeReport = async (): Promise<void> => {
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  }
  await writeReport()

  try {
    const project = await readProjectInfo(projectPath)
    if (!project) throw new Error('E2E project is missing modmind.project.json')
    currentProject = project
    const readyDeadline = Date.now() + 45_000
    while (requireBlockbench().getStatus().phase !== 'ready' && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (requireBlockbench().getStatus().phase !== 'ready') throw new Error('Blockbench did not become ready for E2E')
    const event = { sender: mainWindow!.webContents } as unknown as Electron.IpcMainInvokeEvent
    const sessionId = `e2e-boss-${Date.now()}`
    report.status = 'agent-running'
    report.sessionId = sessionId
    await writeReport()

    let coding = await createAiCode(event, prompt, sessionId)
    let assets = await findE2EAssets(project.path)
    if (!assets.models.length || !assets.textures.length) {
      coding = await createAiCode(
        event,
        `E2E ASSET VALIDATION FAILED. The previous implementation built, but it did not leave both an editable .bbmodel and a PNG texture in the project. Use blockbench_actions now: create a modded_entity model with multiple cubes, create a patterned pixel texture with rectangles, apply it, save the project under models/blockbench/, save the texture under src/main/resources/assets/${project.namespace}/textures/entity/, then call build_project, verify_project, and finish. Current assets: ${JSON.stringify(assets)}`,
        sessionId
      )
      assets = await findE2EAssets(project.path)
    }
    if (!assets.models.length || !assets.textures.length) {
      throw new Error(`Agent did not produce required Blockbench assets: ${JSON.stringify(assets)}`)
    }
    report.status = 'launch-testing'
    report.coding = coding
    report.assets = assets
    await writeReport()

    let launchResult = await requireMinecraftRuntime().testLaunch({
      username: 'ModMindE2E',
      maxMemoryMb: 4096,
      width: 1280,
      height: 720
    })
    for (let repairRound = 1; !launchResult.success && repairRound <= 3; repairRound += 1) {
      const failure = launchResult.crash?.summary ?? launchResult.state.message
      report.status = `runtime-repair-${repairRound}`
      report.lastCrash = launchResult.crash
      await writeReport()
      coding = await createAiCode(
        event,
        `E2E RUNTIME REPAIR ${repairRound}/3. Minecraft failed the 20-second startup test. Fix the deepest root cause without removing the boss, model, texture, or intended behavior. Rebuild, run verify_project, and finish.\n\nRUNTIME OBSERVATION\n${failure}`,
        sessionId
      )
      launchResult = await requireMinecraftRuntime().testLaunch({
        username: 'ModMindE2E',
        maxMemoryMb: 4096,
        width: 1280,
        height: 720
      })
    }
    if (!launchResult.success) throw new Error('Minecraft did not pass startup validation after 3 runtime repairs')

    let resourceWarnings = await findRuntimeResourceWarnings(project)
    for (let repairRound = 1; resourceWarnings.length && repairRound <= 2; repairRound += 1) {
      report.status = `resource-repair-${repairRound}`
      report.resourceWarnings = resourceWarnings
      await writeReport()
      await requireMinecraftRuntime().stop()
      await new Promise((resolve) => setTimeout(resolve, 500))
      coding = await createAiCode(
        event,
        `E2E RESOURCE REPAIR ${repairRound}/2. Minecraft stayed running, but its resource reload found missing models or textures in this project's namespace. Fix every listed warning while preserving the user's requested behavior and all existing project content. Create real PNG textures through blockbench_actions when a referenced texture is missing, add any missing item model JSON, then call build_project, verify_project, and finish.\n\nRESOURCE WARNINGS\n${resourceWarnings.join('\n')}`,
        sessionId
      )
      launchResult = await requireMinecraftRuntime().testLaunch({
        username: 'ModMindE2E',
        maxMemoryMb: 4096,
        width: 1280,
        height: 720
      })
      if (!launchResult.success) throw new Error('Minecraft failed after an automatic resource repair')
      resourceWarnings = await findRuntimeResourceWarnings(project)
    }
    if (resourceWarnings.length) {
      throw new Error(`Minecraft still reports missing project resources: ${resourceWarnings.join('; ')}`)
    }
    report.status = 'success'
    report.finishedAt = new Date().toISOString()
    report.coding = coding
    report.assets = await findE2EAssets(project.path)
    report.minecraft = launchResult
    report.resourceWarnings = []
    await writeReport()
    console.info(`[E2E] Success. Report: ${reportPath}`)
  } catch (error) {
    report.status = 'failed'
    report.finishedAt = new Date().toISOString()
    report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    await writeReport()
    console.error('[E2E] Failed', error)
    setTimeout(() => app.quit(), 1_000)
  }
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:checkForUpdates', () => checkForAppUpdates())
  ipcMain.handle('app:getUpdateState', () => appUpdateService?.snapshot() ?? { phase: 'idle', currentVersion: app.getVersion() })
  ipcMain.handle('app:downloadUpdate', () => {
    if (!appUpdateService) throw new Error('自动更新服务尚未就绪')
    return appUpdateService.downloadUpdate()
  })
  ipcMain.handle('app:installUpdate', () => appUpdateService?.installDownloadedUpdate() ?? false)
  ipcMain.handle('downloads:list', () => downloadActivities.snapshot())
  ipcMain.handle('downloads:retry', (_event, id: unknown) => downloadActivities.retry(typeof id === 'string' ? id : ''))
  ipcMain.handle('downloads:cancel', (_event, id: unknown) => downloadActivities.cancel(typeof id === 'string' ? id : ''))
  ipcMain.handle('downloads:restart', (_event, id: unknown) => downloadActivities.restart(typeof id === 'string' ? id : ''))
  ipcMain.handle('downloads:dismiss', (_event, id: unknown) => downloadActivities.dismiss(typeof id === 'string' ? id : ''))
  ipcMain.handle('downloads:clearFinished', () => downloadActivities.clearFinished())
  ipcMain.handle('device:getState', () => readDeviceState())
  ipcMain.handle('device:authorize', () => beginDeviceAuthorization())
  ipcMain.handle('device:cancelAuthorization', () => cancelDeviceAuthorization())
  ipcMain.handle('device:disconnectLocal', () => disconnectDeviceLocally())
  ipcMain.handle('device:refreshUsage', () => refreshDeviceUsage())
  ipcMain.handle('device:getAiPreferences', () => readBeginnerAiPreferences())
  ipcMain.handle('device:saveAiPreferences', (_event, preferences: BeginnerAiPreferences) => saveBeginnerAiPreferences(preferences))
  ipcMain.handle('device:listModels', (_event, force?: boolean) => listBeginnerModels(force === true))
  ipcMain.handle('device:openSite', (_event, relativePath?: string) => openConfiguredDeviceSite(relativePath))
  ipcMain.handle('remote:getState', () => remoteClient?.getState() ?? { status: 'disabled', enabled: false })
  ipcMain.handle('remote:start', () => startRemoteClientIfPossible(true))
  ipcMain.handle('remote:stop', () => stopRemoteClient(true))
  ipcMain.handle('mcp-bridge:getState', () => mcpBridgeState())
  ipcMain.handle('mcp-bridge:setEnabled', (_event, enabled: unknown) => setMcpBridgeEnabledFromSettings(enabled === true))
  ipcMain.handle('image-studio:getSettings', () => requireImageStudio().getSettings())
  ipcMain.handle('image-studio:saveSettings', (_event, value) => requireImageStudio().saveSettings(value))
  ipcMain.handle('image-studio:capabilities', () => requireImageStudio().capabilities())
  ipcMain.handle('image-studio:generate', (_event, value: ImageGenerationRequest) => runDiagnosticOperation('image-studio', 'generate', 'Image generation', () => requireImageStudio().generate(value)))
  ipcMain.handle('image-studio:process', (_event, operation: 'perfect-pixel' | 'remove-background', dataUrl: string, options) => runDiagnosticOperation('image-studio', operation, 'Image processing', () => requireImageStudio().process(operation, dataUrl, options), { inputBytes: Buffer.byteLength(dataUrl, 'utf8') }))
  ipcMain.handle('image-studio:history', () => requireImageStudio().history())
  ipcMain.handle('image-studio:saveAsset', async (_event, dataUrl: string, suggestedName: string) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('图片数据格式无效')
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片')
    const safeName = String(suggestedName || 'modmind-image').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'modmind-image'
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
    const result = await dialog.showSaveDialog({ defaultPath: `${safeName}.${extension}`, filters: [{ name: 'Image', extensions: [extension] }] })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, Buffer.from(match[2], 'base64'))
    return result.filePath
  })
  ipcMain.handle('image-studio:saveToProject', async (_event, dataUrl: string, suggestedName: string) => {
    const project = requireProject()
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('图片数据格式无效')
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('加入项目目前只支持 PNG、JPEG 或 WebP 图片')
    const safeName = String(suggestedName || 'modmind-image').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'modmind-image'
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
    const relativeDirectory = isModpackProject(project)
      ? 'overrides/modmind-images'
      : isJavaLoader(project.loader)
        ? `src/main/resources/assets/${project.namespace}/textures/modmind`
        : 'resource_pack/textures/modmind'
    const relativePath = `${relativeDirectory}/${safeName}.${extension}`
    const target = resolveProjectPath(relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from(match[2], 'base64'))
    return relativePath
  })
  ipcMain.handle('window:minimize', (event) => (BrowserWindow.fromWebContents(event.sender) ?? mainWindow)?.minimize())
  ipcMain.handle('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.handle('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && window !== mainWindow) return window.close()
    return handleWindowClose()
  })
  ipcMain.handle('window:openDetached', (_event, view: unknown, title: unknown) => {
    const target = typeof view === 'string' ? view : ''
    if (!sidebarViewIds.has(target as SidebarViewId) && !/^group:\d{1,3}$/.test(target)) throw new Error('Unsupported detached window target')
    const window = createDetachedWindow(target as DetachedWindowTarget, typeof title === 'string' ? title : '')
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })
  ipcMain.handle('window:getDetachedState', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isDetachedWindow(window)) return null
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })
  ipcMain.handle('window:setDetachedAlwaysOnTop', (event, alwaysOnTop: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isDetachedWindow(window)) throw new Error('This window cannot be pinned')
    window.setAlwaysOnTop(alwaysOnTop === true, 'floating')
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })

  ipcMain.handle('blockbench:show', (_event, bounds: BlockbenchBounds) => {
    const bridge = requireBlockbench()
    bridge.setBounds(bounds)
    bridge.show()
  })
  ipcMain.handle('blockbench:hide', () => requireBlockbench().hide())
  ipcMain.handle('blockbench:getState', () => {
    const status = requireBlockbench().getStatus()
    return { ...status, status: status.phase, connected: status.phase === 'ready' }
  })
  ipcMain.handle('blockbench:openProject', () =>
    requireBlockbench().executeAction({ type: 'run-command', command: 'open-project' })
  )
  ipcMain.handle('blockbench:saveProject', () =>
    requireBlockbench().executeAction({ type: 'run-command', command: 'save-project-dialog' })
  )
  ipcMain.handle('blockbench:setTheme', (_event, theme: 'light' | 'dark') => requireBlockbench().setTheme(theme))
  ipcMain.handle('blockbench:runAction', (_event, action: string) => {
    const mapping: Record<string, BlockbenchCommand> = {
      undo: 'undo',
      redo: 'redo',
      frame_all: 'frame-all',
      toggle_grid: 'toggle-grid',
      toggle_animate: 'toggle-animate',
      mode_edit: 'mode-edit',
      mode_paint: 'mode-paint',
      mode_animate: 'mode-animate'
    }
    const command = mapping[action]
    if (!command) throw new Error('Unsupported Blockbench toolbar action')
    return requireBlockbench().executeAction({ type: 'run-command', command })
  })
  ipcMain.handle('blockbench:execute', (_event, action: BlockbenchAction) => requireBlockbench().executeAction(action))
  ipcMain.handle('blockbench:executeActions', (_event, actions: BlockbenchAction[], expectedRevision?: string) =>
    requireBlockbench().executeActions(actions, undefined, expectedRevision)
  )
  ipcMain.handle('blockbench:projectState', () => requireBlockbench().getProjectState())
  ipcMain.handle('blockbench:validate', () => requireBlockbench().validateProject())
  ipcMain.handle('blockbench:captureViews', (_event, request: BlockbenchCaptureRequest) => requireBlockbench().captureViews(request))
  ipcMain.handle('blockbench:setAssetMetadata', (_event, metadata: BlockbenchAssetMetadata) => requireBlockbench().setAssetMetadata(metadata))
  ipcMain.handle('blockbench:saveAssetBundle', (_event, request: BlockbenchAssetSaveRequest) => requireBlockbench().saveAssetBundle(request))
  ipcMain.handle('blockbench:history', () => requireBlockbench().listHistory())
  ipcMain.handle('blockbench:createCheckpoint', (_event, label?: string) => requireBlockbench().createCheckpoint(label))
  ipcMain.handle('blockbench:restoreHistory', (_event, id: string) => requireBlockbench().restoreHistory(id))
  ipcMain.handle('asset-intent:compile', (_event, intent: unknown) => compileAssetIntent(intent))
  ipcMain.handle('asset-intent:preview', (_event, intent: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) =>
    previewAssetIntentCandidate(requireBlockbench(), intent, request, undefined, expectedRevision)
  )
  ipcMain.handle('asset-intent:apply', async (_event, intent: unknown, expectedRevision?: string) => {
    const candidate = compileAssetIntent(intent)
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision)
    return {...candidate, execution}
  })
  ipcMain.handle('asset-refinement:compile', async (_event, refinement: unknown) => compileAssetRefinementForBridge(requireBlockbench(), refinement))
  ipcMain.handle('asset-refinement:preview', (_event, refinement: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) =>
    previewAssetRefinementCandidate(requireBlockbench(), refinement, request, undefined, expectedRevision)
  )
  ipcMain.handle('asset-refinement:apply', async (_event, refinement: unknown, expectedRevision?: string) => {
    return applyAssetRefinementCandidate(requireBlockbench(), refinement, undefined, expectedRevision)
  })
  ipcMain.handle('advanced-asset:compile', (_event, program: unknown, variantId = 'base') => compileAdvancedAsset(program, variantId))
  ipcMain.handle('advanced-asset:preview', (_event, program: unknown, request: BlockbenchCaptureRequest, options: AdvancedAssetPreviewOptions, expectedRevision?: string) =>
    previewAdvancedAssetComparison(requireBlockbench(), program, request, options, undefined, expectedRevision)
  )
  ipcMain.handle('advanced-asset:apply', async (_event, program: unknown, variantId = 'base', expectedRevision?: string) => {
    const candidate = compileAdvancedAsset(program, variantId)
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return candidate
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision)
    return {...candidate, execution}
  })
  ipcMain.handle('reference-asset:compile', (_event, program: unknown) => compileReferenceImageAsset(program))
  ipcMain.handle('reference-asset:preview', (_event, program: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) =>
    previewReferenceImageCandidate(requireBlockbench(), program, request, undefined, expectedRevision)
  )
  ipcMain.handle('reference-asset:apply', async (_event, program: unknown, expectedRevision?: string) => {
    const candidate = await compileReferenceImageAsset(program)
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision)
    return {...candidate, execution}
  })
  ipcMain.handle('asset-visual-review:current', async (_event, request: BlockbenchCaptureRequest) => {
    const capture = await requireBlockbench().captureViews(request)
    return {...capture, review: await reviewAssetCaptures(capture.captures)}
  })

  ipcMain.handle('minecraft:getState', () => requireMinecraftRuntime().refresh())
  ipcMain.handle('minecraft:prepare', () => invokeMinecraftOperation(() => requireMinecraftRuntime().prepare()))
  ipcMain.handle('minecraft:cancelPreparation', async () => {
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? requireProject().path
    await cancelTrackedMinecraftPreparation(projectPath)
    return requireMinecraftRuntime().getState()
  })
  ipcMain.handle('minecraft:restartPreparation', async () => {
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? requireProject().path
    await restartTrackedMinecraftPreparation(projectPath)
    return requireMinecraftRuntime().getState()
  })
  ipcMain.handle('minecraft:buildProject', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return invokeMinecraftOperation(() => aiProjectContext.run(project, () => requireMinecraftRuntime().buildProject()))
  })
  ipcMain.handle('minecraft:launch', (_event, options: MinecraftLaunchOptions) =>
    invokeMinecraftOperation(() => requireMinecraftRuntime().launch(options))
  )
  ipcMain.handle('minecraft:testLaunch', (_event, options: MinecraftLaunchOptions) =>
    invokeMinecraftOperation(() => requireMinecraftRuntime().testLaunch(options))
  )
  ipcMain.handle('minecraft:headlessSmokeTest', async () => {
    const project = requireProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 不支持 HeadlessMC 无头冒烟测试`)
    return runHeadlessMinecraftSmoke(project, undefined, { stableWindowMs: 20_000, offline: true })
  })
  ipcMain.handle('minecraft:openHeadlessMcLogin', async () => {
    const project = requireProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 不支持 HeadlessMC 无头冒烟测试`)
    const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
    return requireHeadlessMc().openLoginConsole(javaPath)
  })
  ipcMain.handle('minecraft:stop', async () => {
    await headlessMcService?.stop()
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? currentProject?.path
    const state = await requireMinecraftRuntime().stop()
    if (projectPath) {
      const tracked = [...minecraftDownloadActivityIds.values()].filter((activity) => activity.projectPath === projectPath)
      for (const activity of tracked) await downloadActivities.cancel(activity.id)
    }
    return state
  })
  ipcMain.handle('minecraft:syncProjectMod', () => requireMinecraftRuntime().syncProjectMod())
  ipcMain.handle('minecraft:syncModpack', () => requireMinecraftRuntime().syncModpack())
  ipcMain.handle('minecraft:listMods', () => requireMinecraftRuntime().listMods())
  ipcMain.handle('minecraft:removeMod', (_event, name: string) => requireMinecraftRuntime().removeMod(name))
  ipcMain.handle('minecraft:importMods', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft Mods', extensions: ['jar'] }]
    })
    if (result.canceled) return requireMinecraftRuntime().listMods()
    return requireMinecraftRuntime().importMods(result.filePaths)
  })

  ipcMain.handle('mappings:search', (_event, version: string, query: string, limit?: number) =>
    requireMappings().search(version, query, limit)
  )
  ipcMain.handle('mappings:getClass', (_event, version: string, className: string, memberQuery?: string) =>
    requireMappings().getClass(version, className, memberQuery)
  )
  ipcMain.handle('mappings:openSource', (_event, version: string) => {
    if (!/^[0-9A-Za-z._-]{1,40}$/.test(version)) throw new Error('无效的 Minecraft Mappings 版本')
    return shell.openExternal(`https://mappings.dev/${version}/index.html`)
  })
  ipcMain.handle('mappings:openLoaderDocs', (_event, loader: LoaderKind) => {
    const urls: Record<LoaderKind, string> = {
      fabric: 'https://docs.fabricmc.net/develop/',
      quilt: 'https://wiki.quiltmc.org/en/modding/getting-started',
      forge: 'https://docs.minecraftforge.net/en/latest/',
      neoforge: 'https://docs.neoforged.net/docs/gettingstarted/',
      bedrock: 'https://learn.microsoft.com/minecraft/creator/',
      'netease-pc': 'https://mc.163.com/dev/',
      'netease-mobile': 'https://mc.163.com/dev/'
    }
    if (!urls[loader]) throw new Error('无效的 Loader 文档类型')
    return shell.openExternal(urls[loader])
  })

  ipcMain.handle('project:inspectExisting', async (_event, sourceType: 'folder' | 'zip' = 'folder') => {
    const result = sourceType === 'zip'
      ? await dialog.showOpenDialog(mainWindow!, {
          properties: ['openFile'],
          filters: [
            { name: 'Modpack and project archives', extensions: ['zip', 'mrpack', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'cab', 'iso', 'arj', 'lzh', 'cpio', 'deb', 'rpm', 'wim', 'vhd', 'vhdx', 'vmdk', 'xar'] },
            { name: 'All files', extensions: ['*'] }
          ]
        })
      : await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const sourcePath = await resolveExistingProjectSource(result.filePaths[0])
    return (await analyzeExistingProject(sourcePath)).analysis
  })

  ipcMain.handle('project:listLoaderVersions', (_event, refresh = false) =>
    requireLoaderCatalog().list(Boolean(refresh))
  )

  ipcMain.handle('project:adoptExisting', async (_event, input: ExistingProjectAdoptInput) => {
    assertProjectSwitchAllowed()
    if (!input || typeof input.sourcePath !== 'string') throw new Error('导入参数无效')
    const legacyConversion = await convertLegacyModtoolProject(input.sourcePath)
    if (legacyConversion.project) {
      currentProject = legacyConversion.project
      await rememberRecentProject(currentProject)
      return currentProject
    }
    if (!isJavaLoader(input.loader)) throw new Error('现有项目识别目前仅支持 Java Loader 工程；基岩与网易工程请新建后导入内容')
    const { analysis, files } = await analyzeExistingProject(input.sourcePath)
    const name = validateProjectNameInput(input.name)
    const namespace = slugify(input.namespace)
    const minecraftVersion = input.minecraftVersion.trim()
    if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(minecraftVersion)) throw new Error('Minecraft 版本格式无效')
    if (analysis.kind === 'modpack') {
      let projectPath = analysis.sourcePath
      const temporaryImportRoot = path.join(app.getPath('temp'), 'modmind-import-')
      const isTemporaryImport = analysis.sourcePath.startsWith(temporaryImportRoot)
      if (isTemporaryImport) {
        const destination = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
        if (destination.canceled || !destination.filePaths[0]) return null
        projectPath = path.join(destination.filePaths[0], namespace)
        if (await pathExists(projectPath)) throw new Error('目标项目目录已经存在，请选择其他位置或名称')
      }
      return adoptExternalModpackWithRetry({
        sourcePath: analysis.sourcePath,
        projectPath,
        isTemporaryImport,
        name,
        namespace,
        minecraftVersion,
        loader: input.loader
      })
    }

    const compatibility = await requireLoaderCatalog().resolve(input.loader, minecraftVersion)

    let projectPath = analysis.sourcePath
    const temporaryImportRoot = path.join(app.getPath('temp'), 'modmind-import-')
    const isTemporaryImport = analysis.sourcePath.startsWith(temporaryImportRoot)
    if (analysis.kind !== 'complete' || isTemporaryImport) {
      const destination = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
      if (destination.canceled || !destination.filePaths[0]) return null
      projectPath = path.join(destination.filePaths[0], namespace)
      if (await pathExists(projectPath)) throw new Error('目标项目目录已经存在，请选择其他位置或名称')
    }

    const project: ProjectInfo = {
      name,
      path: projectPath,
      loader: input.loader,
      minecraftVersion,
      namespace,
      createdAt: new Date().toISOString(),
      loaderVersion: input.loaderVersion && input.loader === analysis.inferred.loader && minecraftVersion === analysis.inferred.minecraftVersion
        ? input.loaderVersion
        : compatibility.loaderVersion,
      apiVersion: compatibility.apiVersion,
      qslVersion: compatibility.qslVersion,
      javaVersion: compatibility.javaVersion,
      projectVersion: CURRENT_PROJECT_VERSION,
      toolDataDirectory: '.modmind'
    }
    if (analysis.kind === 'complete') {
      if (isTemporaryImport) {
        await copySnapshotFiles(analysis.sourcePath, projectPath)
      }
      await fs.writeFile(path.join(projectPath, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
      await fs.mkdir(path.join(projectPath, '.modmind'), { recursive: true })
    } else {
      await fs.mkdir(projectPath)
      try {
        await writeProjectTemplate(project)
        const importedFolder = analysis.kind === 'partial' ? 'imported-source' : 'imported-api'
        const destination = path.join(projectPath, 'docs', importedFolder, slugify(analysis.sourceName))
        const copied = await copyImportedReferences(analysis.sourcePath, destination, files)
        const summary = [
          '# Imported reference',
          '',
          `Source: ${analysis.sourcePath}`,
          `Detected type: ${analysis.kind}`,
          `Copied files: ${copied}`,
          '',
          ...analysis.reasons.map((reason) => `- ${reason}`)
        ].join('\n')
        await fs.writeFile(path.join(projectPath, 'docs', 'import-summary.md'), summary, 'utf8')
      } catch (error) {
        await fs.rm(projectPath, { recursive: true, force: true })
        throw error
      }
    }
    currentProject = project
    await rememberRecentProject(project)
    return project
  })

  ipcMain.handle('project:create', async (_event, input: ProjectCreateInput) => {
    assertProjectSwitchAllowed()
    if (!input || !(PROJECT_PLATFORMS as readonly string[]).includes(input.loader)) throw new Error('不支持的项目平台')
    const kind = input.kind === 'modpack' ? 'modpack' : 'mod'
    if (kind === 'modpack' && !isJavaLoader(input.loader)) throw new Error('整合包目前仅支持 Java 版的 Fabric、Quilt、Forge 和 NeoForge')
    const name = validateProjectNameInput(input.name)
    const minecraftVersion = input.minecraftVersion.trim()
    const compatibility = await requireLoaderCatalog().resolve(input.loader, minecraftVersion)
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const namespace = slugify(name)
    const projectPath = path.join(result.filePaths[0], namespace)
    if (await pathExists(projectPath)) throw new Error('项目目录已经存在，请修改项目名称或选择其他位置')
    const project: ProjectInfo = {
      ...input,
      kind,
      name,
      minecraftVersion,
      namespace,
      path: projectPath,
      createdAt: new Date().toISOString(),
      loaderVersion: compatibility.loaderVersion,
      apiVersion: compatibility.apiVersion,
      qslVersion: compatibility.qslVersion,
      javaVersion: compatibility.javaVersion,
      projectVersion: CURRENT_PROJECT_VERSION,
      toolDataDirectory: '.modmind'
    }
    await fs.mkdir(projectPath)
    try {
      if (kind === 'modpack') {
        await fs.writeFile(path.join(projectPath, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
        await createModpackTemplate(project)
      } else {
        await writeProjectTemplate(project)
      }
      await fs.mkdir(path.join(projectPath, '.modmind'), { recursive: true })
    } catch (error) {
      await fs.rm(projectPath, { recursive: true, force: true })
      throw error
    }
    currentProject = project
    await rememberRecentProject(project)
    return project
  })

  ipcMain.handle('project:rename', async (_event, input: ProjectRenameInput) => {
    const requestedPath = typeof input?.projectPath === 'string' ? input.projectPath.trim() : ''
    const project = requestedPath ? await readProjectInfo(path.resolve(requestedPath)) : currentProject
    if (!project) throw new Error('未找到要重命名的 ModMind 项目')
    if (currentProject && sameProjectPath(currentProject.path, project.path)) assertProjectSwitchAllowed()
    return renameProjectRecord(project, input)
  })

  ipcMain.handle('project:open', async () => {
    assertProjectSwitchAllowed()
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const converted = await convertLegacyModtoolProject(result.filePaths[0])
    const info = converted.project ?? await readProjectInfo(result.filePaths[0])
    if (!info) throw new Error('所选目录不是 ModMind 项目，缺少 modmind.project.json')
    currentProject = await offerProjectVersionMigration(info)
    await rememberRecentProject(currentProject)
    return currentProject
  })

  ipcMain.handle('project:openRecent', async (_event, projectPath: string) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
    const resolvedProjectPath = path.resolve(projectPath)
    assertProjectSwitchAllowed()
    const converted = await convertLegacyModtoolProject(resolvedProjectPath)
    const info = converted.project ?? await readProjectInfo(resolvedProjectPath)
    if (!info) throw new Error('最近项目不存在或已经不再是有效的 ModMind 项目')
    currentProject = await offerProjectVersionMigration(info)
    await rememberRecentProject(currentProject)
    return currentProject
  })

  ipcMain.handle('project:listRecent', () => readRecentProjects())
  ipcMain.handle('project:removeRecent', async (_event, projectPath: string) => {
    const key = path.resolve(projectPath).toLowerCase()
    const recent = (await readRecentProjects()).filter((entry) => path.resolve(entry.path).toLowerCase() !== key)
    await writeRecentProjects(recent)
    return recent
  })
  ipcMain.handle('project:delete', (_event, projectPath: string) => deleteProjectDirectory(projectPath))

  ipcMain.handle('project:current', () => currentProject)
  ipcMain.handle('modpack:get', () => readModpackManifest(requireProject()))
  ipcMain.handle('modpack:getServerPackManifest', () => readServerPackManifest(requireProject()))
  ipcMain.handle('modpack:addServerPackMods', async () => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: '添加服务端 Mod',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    })
    if (selected.canceled || !selected.filePaths.length) return null
    return addServerPackMods(project, selected.filePaths)
  })
  ipcMain.handle('modpack:removeServerPackMod', async (_event, fileName: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    return removeServerPackMod(project, typeof fileName === 'string' ? fileName : '')
  })
  ipcMain.handle('modpack:exportServerPack', async () => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    const selected = await dialog.showSaveDialog(mainWindow!, {
      title: '导出服务端包',
      defaultPath: path.join(app.getPath('downloads'), `${project.namespace}-server-${project.minecraftVersion}.zip`),
      filters: [{ name: 'Server Pack ZIP', extensions: ['zip'] }]
    })
    if (selected.canceled || !selected.filePath) return null
    const archive = await createServerPackArchive(project)
    await fs.writeFile(selected.filePath, archive)
    return selected.filePath
  })
  ipcMain.handle('modpack:importMods', async () => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    })
    if (result.canceled || !result.filePaths.length) return readModpackManifest(project)
    return addModpackFiles(project, result.filePaths)
  })
  ipcMain.handle('modpack:removeMod', (_event, fileName: string) => removeModpackFile(requireProject(), fileName))
  ipcMain.handle('modpack:createModule', async (_event, value: string) => {
    const pack = requireProject()
    if (!isModpackProject(pack)) throw new Error('当前项目不是整合包')
    const name = validateProjectNameInput(value)
    const namespace = slugify(name)
    const relativePath = `modules/${namespace}`
    const modulePath = path.join(pack.path, ...relativePath.split('/'))
    if (await pathExists(modulePath)) throw new Error('同名自制 Mod 已存在')
    const module: ProjectInfo = {
      kind: 'mod',
      name,
      path: modulePath,
      loader: pack.loader,
      minecraftVersion: pack.minecraftVersion,
      namespace,
      createdAt: new Date().toISOString(),
      loaderVersion: pack.loaderVersion,
      apiVersion: pack.apiVersion,
      qslVersion: pack.qslVersion,
      javaVersion: pack.javaVersion,
      projectVersion: CURRENT_PROJECT_VERSION,
      toolDataDirectory: '.modmind'
    }
    await fs.mkdir(modulePath, { recursive: true })
    try {
      await writeProjectTemplate(module)
      await fs.mkdir(path.join(modulePath, '.modmind'), { recursive: true })
      return addModpackModule(pack, { name, namespace, path: relativePath, createdAt: module.createdAt })
    } catch (error) {
      await fs.rm(modulePath, { recursive: true, force: true })
      throw error
    }
  })
  ipcMain.handle('modpack:updateModuleSide', async (_event, namespace: unknown, side: unknown) => {
    const pack = requireProject()
    if (!isModpackProject(pack)) throw new Error('current project is not a modpack')
    if (typeof namespace !== 'string' || !['client', 'server', 'both', 'unknown'].includes(String(side))) throw new Error('invalid self-made mod side')
    return updateModpackModuleSide(pack, namespace, side as ModpackModuleSide)
  })
  ipcMain.handle('modpack:openModule', async (_event, namespace: string) => {
    const pack = requireProject()
    const manifest = await readModpackManifest(pack)
    const module = manifest.modules.find((entry) => entry.namespace === namespace)
    if (!module) throw new Error('找不到自制 Mod')
    const root = path.resolve(pack.path, ...module.path.split('/'))
    if (!root.startsWith(`${path.resolve(pack.path)}${path.sep}`)) throw new Error('自制 Mod 路径无效')
    const project = await readProjectInfo(root)
    if (!project) throw new Error('自制 Mod 工程文件已缺失')
    currentProject = project
    await rememberRecentProject(project)
    return project
  })
  ipcMain.handle('modpack:sync', () => requireMinecraftRuntime().syncModpack())
  ipcMain.handle('modpack:listContent', (_event, refresh?: unknown) => listModpackContent(requireProject(), refresh === true))
  ipcMain.handle('modpack:importContent', async (_event, kind: ModpackContentKind, scope?: ModpackContentScope) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    const world = kind === 'worlds'
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: world ? '选择世界存档目录' : '导入整合包内容',
      properties: world ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    if (result.canceled) return null
    return importModpackContent(project, kind, result.filePaths, scope)
  })
  ipcMain.handle('modpack:downloadContent', (_event, input: ModpackContentDownloadInput) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    return downloadModpackContent(project, input)
  })
  ipcMain.handle('modpack:removeContent', (_event, id: string) => removeModpackContent(requireProject(), id))
  ipcMain.handle('modpack:readLock', async () => readModpackLock(requireProject()))
  ipcMain.handle('modpack:auditLock', async () => auditModpackLock(requireProject()))
  ipcMain.handle('modpack:providers', () => requireModProviderRegistry().list().map((id) => ({ id, label: id === 'modrinth' ? 'Modrinth' : 'CurseForge', configured: true, supportsDependencies: true })))
  ipcMain.handle('modpack:recommendProviders', async (): Promise<ModpackSearchResponse[]> => {
    const project = requireProject()
    if (!isModpackProject(project) || !isJavaLoader(project.loader)) throw new Error('只有 Java 整合包支持第三方 Mod 平台搜索')
    const results = await requireModProviderRegistry().search({ query: '', minecraftVersion: project.minecraftVersion, loader: project.loader, limit: 12, index: 'downloads' })
    return results.map((result) => ({
      provider: result.provider,
      total: result.total,
      error: result.error,
      hits: result.hits.map((hit) => ({ provider: hit.provider, projectId: hit.projectId, slug: hit.slug, name: hit.name, summary: hit.summary, projectUrl: hit.projectUrl, downloads: hit.downloads, clientSide: hit.clientSide, serverSide: hit.serverSide, ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}), ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}) }))
    }))
  })
  ipcMain.handle('modpack:recommendMcmod', async () => {
    const project = requireProject()
    if (!isModpackProject(project) || !isJavaLoader(project.loader)) throw new Error('只有 Java 整合包支持模组推荐')
    return mcmodService.recommendations(12)
  })
  ipcMain.handle('modpack:searchProviders', async (_event, rawQuery: unknown, rawProviders?: unknown): Promise<ModpackSearchResponse[]> => {
    const project = requireProject()
    if (!isModpackProject(project) || !isJavaLoader(project.loader)) throw new Error('只有 Java 整合包支持第三方 Mod 平台搜索')
    const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 120) : ''
    if (!query) return []
    const providers = Array.isArray(rawProviders)
      ? rawProviders.filter((value): value is 'modrinth' | 'curseforge' => value === 'modrinth' || value === 'curseforge')
      : undefined
    const results = await requireModProviderRegistry().search({ query, minecraftVersion: project.minecraftVersion, loader: project.loader, limit: 30 }, providers)
    return results.map((result) => ({
      provider: result.provider,
      total: result.total,
      error: result.error,
      hits: result.hits.map((hit) => ({ provider: hit.provider, projectId: hit.projectId, slug: hit.slug, name: hit.name, summary: hit.summary, projectUrl: hit.projectUrl, downloads: hit.downloads, clientSide: hit.clientSide, serverSide: hit.serverSide, ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}), ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}) }))
    }))
  })
  ipcMain.handle('modpack:listProviderFiles', async (_event, rawProvider: unknown, rawProjectId: unknown): Promise<ModpackFileOption[]> => {
    const project = requireProject()
    if (!isModpackProject(project) || !isJavaLoader(project.loader)) throw new Error('只有 Java 整合包支持第三方 Mod 平台下载')
    if (rawProvider !== 'modrinth' && rawProvider !== 'curseforge') throw new Error('不支持的 Mod 平台')
    if (typeof rawProjectId !== 'string' || !rawProjectId.trim()) throw new Error('Mod 项目 ID 无效')
    const files = await requireModProviderRegistry().versions(rawProvider, rawProjectId, { minecraftVersion: project.minecraftVersion, loader: project.loader })
    return files.map((file) => ({ provider: file.provider, projectId: file.projectId, versionId: file.versionId, versionName: file.versionName, filename: file.filename, side: file.side, ...(file.size !== undefined ? { size: file.size } : {}), ...(file.publishedAt ? { publishedAt: file.publishedAt } : {}) }))
  })
  ipcMain.handle('modpack:installProviderFile', async (_event, rawProvider: unknown, rawProjectId: unknown, rawVersionId: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project) || !isJavaLoader(project.loader)) throw new Error('只有 Java 整合包支持第三方 Mod 下载')
    if (rawProvider !== 'modrinth' && rawProvider !== 'curseforge') throw new Error('不支持的 Mod 平台')
    if (typeof rawProjectId !== 'string' || typeof rawVersionId !== 'string') throw new Error('Mod 版本信息无效')
    const files = await requireModProviderRegistry().versions(rawProvider, rawProjectId, { minecraftVersion: project.minecraftVersion, loader: project.loader })
    const file = files.find((candidate) => candidate.versionId === rawVersionId)
    if (!file) throw new Error('该 Mod 版本已不可用，请刷新后重试')
    const stagingRoot = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'provider-downloads', randomUUID())
    const staged = path.join(stagingRoot, file.filename)
    await fs.mkdir(stagingRoot, { recursive: true })
    try {
      const result = await requireModProviderRegistry().install(file, staged)
      const manifest = await addModpackFiles(project, [result.path])
      const lock = await readModpackLock(project)
      const locked = lockedModFromFile(file, result, file.filename)
      await writeModpackLock(project, { ...lock, mods: [...lock.mods.filter((entry) => !(entry.provider === file.provider && entry.projectId === file.projectId) && entry.fileName.toLowerCase() !== file.filename.toLowerCase()), locked] })
      return manifest
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle('modpack:previewMigration', async (event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    if (!input || typeof input !== 'object') throw new Error('迁移目标无效')
    const value = input as { loader?: unknown; minecraftVersion?: unknown }
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string') throw new Error('迁移目标必须是 Java Loader 和 Minecraft 版本')
    const target = await requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim())
    return assessModpackMigration(requireModProviderRegistry(), project, target, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('modpack:migrationProgress', progress)
    }, mcmodService)
  })
  ipcMain.handle('modpack:selectMigrationJar', async (_event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    if (!input || typeof input !== 'object') throw new Error('迁移目标无效')
    const value = input as { loader?: unknown; minecraftVersion?: unknown }
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string') throw new Error('迁移目标必须是 Java Loader 和 Minecraft 版本')
    await requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim())
    const selected = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    return inspectModpackMigrationJar(selected.filePaths[0], value.loader)
  })
  ipcMain.handle('modpack:createMigration', async (_event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    if (!input || typeof input !== 'object') throw new Error('迁移方案无效')
    const value = input as Partial<ModpackMigrationCreateInput>
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string' || !Array.isArray(value.mods) || !Array.isArray(value.modules) || !Array.isArray(value.content)) {
      throw new Error('迁移方案缺少目标版本或取舍记录')
    }
    if (value.mode !== undefined && value.mode !== 'backup' && value.mode !== 'direct') throw new Error('迁移模式无效')
    const target = await requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim())
    return withMinecraftResourceLock(() => applyModpackMigrationInPlace(project, target, { ...(value as ModpackMigrationCreateInput), mode: value.mode === 'direct' ? 'direct' : 'backup' }))
  })
  ipcMain.handle('modpack:migrationHistory', () => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    return listModpackMigrationRecords(project)
  })
  ipcMain.handle('modpack:undoMigration', async (_event, migrationId: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('当前项目不是整合包')
    assertProjectMutationAllowed(project.path, '撤销迁移')
    return withMinecraftResourceLock(() => undoModpackMigration(project, validateMigrationId(migrationId)))
  })
  ipcMain.handle('modpack:plan', async (_event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    if (!input || typeof input !== 'object') throw new Error('modpack concept must be an object')
    const plan = await planModpack(requireModProviderRegistry(), project, input as Parameters<typeof planModpack>[2], mcmodService)
    await saveManualModRequirements(project, plan.manualRequired ?? [])
    return plan
  })
  ipcMain.handle('modpack:applyPlan', async (_event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    if (!input || typeof input !== 'object') throw new Error('modpack plan must be an object')
    return applyModpackPlan(requireModProviderRegistry(), project, input as Parameters<typeof applyModpackPlan>[2])
  })
  ipcMain.handle('modpack:readFtbQuestBook', () => readFtbQuestBook(requireProject()))
  ipcMain.handle('modpack:saveFtbQuestBook', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('invalid FTB Quests book')
    return saveFtbQuestBook(requireProject(), input as Parameters<typeof saveFtbQuestBook>[1])
  })
  ipcMain.handle('modpack:writeFtbQuest', (_event, input: unknown) => writeFtbQuestChapter(requireProject(), input as Parameters<typeof writeFtbQuestChapter>[1]))
  ipcMain.handle('modpack:writePatchouliBook', (_event, input: unknown) => writePatchouliBook(requireProject(), input as Parameters<typeof writePatchouliBook>[1]))
  ipcMain.handle('modpack:contentProjectPath', (_event, contentPath: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    if (typeof contentPath !== 'string') throw new Error('content path must be a string')
    return modpackContentProjectPath(project, contentPath)
  })
  ipcMain.handle('modpack:getKeybinds', () => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    return readKeybindState(project)
  })
  ipcMain.handle('modpack:applyKeybindPreset', (_event, input: unknown, allowConflicts?: boolean) => applyKeybindPreset(requireProject(), input as Parameters<typeof applyKeybindPreset>[1], Boolean(allowConflicts)))
  ipcMain.handle('modpack:buildServerPack', async (_event, input: unknown) => {
    const project = requireProject()
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-pack')
    const manifest = project.kind === 'modpack' ? await readModpackManifest(project) : null
    const engine = value.engine === 'internal' || !manifest?.mods.length ? 'internal' as const : 'serverpackcreator' as const
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info', logPath?: string): void => localServerManager?.recordOperation(message, level, logPath)
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total })
    log(`开始同步服务端包：${engine === 'serverpackcreator' ? 'ServerPackCreator' : 'ModMind 内置引擎'}`)
    progress('正在准备服务端包同步', 0.02)
    try {
      let javaPath: string | undefined
      if (engine === 'serverpackcreator') {
        log('正在准备 ServerPackCreator 所需的托管 Java')
        javaPath = await requireMinecraftRuntime().ensureJavaRuntime(
          (message) => {
            log(message)
            progress(message, 0.04)
          },
          SERVER_PACK_CREATOR_MIN_JAVA,
          ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 ServerPackCreator 所需的 Java`, 0.04 + 0.32 * (total > 0 ? downloaded / total : 0), downloaded, total)
        )
        log('托管 Java 已就绪，正在运行 ServerPackCreator')
        progress('正在启动 ServerPackCreator', 0.38)
      }
      let creatorOutputWasStreamed = false
      const result = await buildServerPack(project, {
        outputDirectory,
        port: typeof value.port === 'number' ? value.port : undefined,
        acceptEula: true,
        includeUnknownSideMods: value.includeUnknownSideMods === true,
        onlineMode: value.onlineMode !== false,
        engine,
        javaPath,
        cacheDirectory: path.join(app.getPath('userData'), 'server-pack-creator'),
        onProgress: (message) => progress(message, 0.42),
        onOutput: (output) => {
          creatorOutputWasStreamed = true
          log(output)
          progress('ServerPackCreator 正在下载并筛选服务端文件', 0.42)
        }
      })
      if (result.logPath && !creatorOutputWasStreamed) {
        const creatorOutput = await fs.readFile(result.logPath, 'utf8').catch(() => '')
        if (creatorOutput.trim()) log(creatorOutput)
      }
      progress('正在写入服务端包清单', 0.94)
      log(`服务端包同步完成：${result.copiedMods.length} 个服务端 Mod，跳过 ${result.skippedClientMods.length} 个客户端 Mod`, 'info', result.logPath)
      progress('服务端包同步完成', 1)
      return result
    } catch (error) {
      const message = describeRuntimeError(error)
      log(`服务端包同步失败：${message}`, 'error')
      throw new Error(`服务端包同步失败：${message}`)
    } finally {
      localServerManager?.clearOperationProgress()
    }
  })
  ipcMain.handle('modpack:installServerRuntime', async (_event, input: unknown) => {
    const project = requireProject()
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const target = serverRuntimeDownloadDescription(project)
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info', logPath?: string): void => localServerManager?.recordOperation(message, level, logPath)
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total })
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, '.modmind', 'server-pack')
    const pack = await readExistingServerPack(project, outputDirectory)
    if (!pack) {
      const message = '请先同步服务端包，再检查服务端运行时'
      log(message, 'warning')
      throw new Error(message)
    }
    log(`开始检查服务端运行时：${target.label}`)
    log(`已找到同步的服务端包：${pack.copiedMods.length} 个服务端 Mod`)
    progress('正在准备服务端运行时', 0.02)
    try {
      log('正在准备 Minecraft 服务器所需的兼容 Java')
      const runtimeJavaPath = await requireMinecraftRuntime().ensureJavaRuntime(
        (message) => {
          log(message)
          progress(message, 0.05)
        },
        undefined,
        ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 Minecraft 兼容 Java`, 0.05 + 0.35 * (total > 0 ? downloaded / total : 0), downloaded, total)
      )
      progress('正在下载并安装服务端 Loader', 0.42)
      const runtime = await installServerRuntime({
        serverPack: pack,
        javaPath: runtimeJavaPath,
        onDownloadProgress: ({ source, downloaded, total }) => progress(`正在从 ${source.label} 下载服务端 Loader`, total ? 0.42 + 0.5 * downloaded / total : undefined, downloaded, total)
      }, project)
      progress('正在验证服务端运行时', 0.96)
      log(`服务端运行时已就绪：${runtime.serverJar ? path.basename(runtime.serverJar) : '启动脚本'}`)
      progress('服务端运行时已就绪', 1)
      return runtime
    } catch (error) {
      const sources = target.sources.length ? `Sources: ${target.sources.join('; ')}` : 'No valid download source was generated'
      const message = `检查服务端运行时失败：${sources}。${describeRuntimeError(error)}`
      log(message, 'error')
      throw new Error(message)
    } finally {
      localServerManager?.clearOperationProgress()
    }
  })
  ipcMain.handle('modpack:verifyServerJoin', async (_event, input: unknown) => {
    const project = requireProject()
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const port = typeof value.port === 'number' ? value.port : 25565
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, '.modmind', 'server-pack')
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info'): void => localServerManager?.recordOperation(message, level)
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total })
    log('开始启动并验证本机服务端')
    progress('正在准备验证环境', 0.02)
    forwardMinecraftEventsToServerPanel = true
    try {
      const pack = await readExistingServerPack(project, outputDirectory)
      if (!pack) throw new Error('请先同步服务端包，再启动并验证')
      log(`已找到同步的服务端包：${pack.copiedMods.length} 个服务端 Mod`)
      log('正在准备 Minecraft 服务器所需的兼容 Java')
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntime(
        (message) => {
          log(message)
          progress(message, 0.05)
        },
        undefined,
        ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 Minecraft 兼容 Java`, 0.05 + 0.27 * (total > 0 ? downloaded / total : 0), downloaded, total)
      )
      progress('正在读取验证用服务端包', 0.32)
      const result = await buildAndJoinServer({
        project,
        outputDirectory,
        port,
        acceptEula: true,
        onlineMode: value.onlineMode === true,
        javaPath,
        serverPack: pack,
        headless: requireHeadlessMc(),
        gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'server-join'),
        onEvent: (event) => {
          log(event.message, event.level)
          progress(event.message, 0.66)
        },
        onProgress: ({ message, fraction, downloaded, total }) => progress(message, fraction, downloaded, total)
      })
      log(result.message, result.success ? 'info' : 'warning')
      progress(result.success ? '本机联机验证完成' : '本机联机验证未通过', 1)
      return result
    } catch (error) {
      const message = `启动并验证失败：${describeRuntimeError(error)}`
      log(message, 'error')
      throw new Error(message)
    } finally {
      forwardMinecraftEventsToServerPanel = false
      localServerManager?.clearOperationProgress()
    }
  })
  ipcMain.handle('modpack:runServerScenario', async (_event, input: unknown) => {
    const project = requireProject()
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
    if (!Array.isArray(value.steps) || !value.steps.length) throw new Error('server scenario requires at least one step')
    const steps = value.steps.map((step) => {
      if (!step || typeof step !== 'object') throw new Error('invalid server scenario step')
      const record = step as Record<string, unknown>
      return { command: String(record.command ?? ''), expect: Array.isArray(record.expect) ? record.expect.map(String) : [], timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined }
    })
    const port = typeof value.port === 'number' ? value.port : 25565
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-scenario')
    return runServerScenario({ project, outputDirectory, port, acceptEula: true, onlineMode: value.onlineMode === true, javaPath, steps, onEvent: (event) => mainWindow?.webContents.send('minecraft:event', event) })
  })
  ipcMain.handle('modpack:getServerState', () => {
    if (!localServerManager) throw new Error('本机服务端管理器不可用')
    return localServerManager.getState()
  })
  ipcMain.handle('modpack:startServer', async (_event, input: unknown) => {
    if (!localServerManager) throw new Error('本机服务端管理器不可用')
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return localServerManager.start({ port: typeof value.port === 'number' ? value.port : undefined, acceptEula: true, onlineMode: value.onlineMode === true })
  })
  ipcMain.handle('modpack:stopServer', () => {
    if (!localServerManager) throw new Error('本机服务端管理器不可用')
    return localServerManager.stop()
  })
  ipcMain.handle('modpack:restartServer', async (_event, input: unknown) => {
    if (!localServerManager) throw new Error('本机服务端管理器不可用')
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return localServerManager.restart({ port: typeof value.port === 'number' ? value.port : undefined, acceptEula: true, onlineMode: value.onlineMode === true })
  })
  ipcMain.handle('modpack:sendServerCommand', (_event, command: unknown) => {
    if (!localServerManager) throw new Error('本机服务端管理器不可用')
    return localServerManager.sendCommand(typeof command === 'string' ? command : '')
  })
  ipcMain.handle('modpack:listOptimizationProfiles', () => BUILTIN_OPTIMIZATION_PROFILES)
  ipcMain.handle('modpack:applyOptimizationProfile', async (_event, input: unknown) => {
    const project = requireProject()
    if (!isModpackProject(project)) throw new Error('current project is not a modpack')
    if (!input || typeof input !== 'object') throw new Error('optimization profile input must be an object')
    const value = input as Record<string, unknown>
    const profileId = typeof value.profileId === 'string' ? value.profileId : ''
    const builtIn = BUILTIN_OPTIMIZATION_PROFILES.find((profile) => profile.id === profileId)
    const profile = builtIn ?? value.profile as Parameters<typeof applyOptimizationProfile>[2]
    if (!profile || typeof profile !== 'object') throw new Error(`optimization profile not found: ${profileId}`)
    return applyOptimizationProfile(requireModProviderRegistry(), project, profile as Parameters<typeof applyOptimizationProfile>[2])
  })
  ipcMain.handle('modpack:listManualMods', () => readManualModRequirements(requireProject()))
  ipcMain.handle('modpack:searchMcmod', (_event, query: string) => mcmodService.search(typeof query === 'string' ? query : '', 20))
  ipcMain.handle('modpack:listMcmodFiles', (_event, projectId: string) => mcmodService.listFiles(typeof projectId === 'string' ? projectId : ''))
  ipcMain.handle('modpack:beginMcmodDownload', (event, projectId: string, fileKey: string) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('MC百科下载只能由当前客户端窗口发起')
    return mcmodService.beginDownload(requireProject(), projectId, fileKey)
  })
  ipcMain.handle('modpack:refreshMcmodCaptcha', (event, sessionId: string) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('验证码只能由当前客户端窗口刷新')
    return mcmodService.refreshCaptcha(requireProject(), sessionId)
  })
  ipcMain.handle('modpack:submitMcmodCaptcha', (event, sessionId: string, captcha: string) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('验证码只能由当前客户端窗口提交')
    return mcmodService.submitCaptcha(requireProject(), sessionId, captcha)
  })
  ipcMain.handle('project:listFiles', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return (await listDirectory(project.path)).filter((node) => !isToolDataDirectory(node.name))
  })
  ipcMain.handle('project:listImageAssets', async (): Promise<ProjectImageAsset[]> => {
    const root = requireProject().path
    const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap((node) => node.type === 'directory' ? flatten(node.children ?? []) : [node])
    const files = flatten(await listDirectory(root)).filter((node) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(node.path))
    const assets: ProjectImageAsset[] = []
    for (const file of files.slice(0, 500)) {
      const stat = await fs.stat(path.join(root, ...file.path.split('/'))).catch(() => null)
      if (stat?.isFile() && stat.size <= 20 * 1024 * 1024) assets.push({ path: file.path, size: stat.size })
    }
    return assets
  })
  ipcMain.handle('project:readImageAsset', async (_event, relativePath: string): Promise<string> => {
    const normalized = normalizeReadablePath(relativePath)
    if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(normalized)) throw new Error('只能读取图片资源作为参考图')
    const target = resolveProjectPath(normalized)
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('参考图不存在或超过 20 MB')
    const mime = /\.jpe?g$/i.test(normalized) ? 'image/jpeg' : /\.webp$/i.test(normalized) ? 'image/webp' : /\.gif$/i.test(normalized) ? 'image/gif' : /\.bmp$/i.test(normalized) ? 'image/bmp' : 'image/png'
    return `data:${mime};base64,${(await fs.readFile(target)).toString('base64')}`
  })
  ipcMain.handle('project:readFile', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const target = resolveProjectPathFor(project, normalizeReadablePath(relativePath, project))
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('只能编辑不超过 2 MB 的文本文件')
    const content = await fs.readFile(target)
    if (content.includes(0)) throw new Error('二进制文件不能在代码编辑器中打开')
    return content.toString('utf8')
  })
  // Workbench data is committed through a revisioned, checksummed store. The
  // project JSON remains as a compatibility copy; it is never the sole copy.
  ipcMain.handle('project:readWorkbenchData', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return workbenchDataStore.read(project.path, relativePath)
  })
  ipcMain.handle('project:writeWorkbenchData', async (_event, relativePath: string, content: string, projectPath?: string) => {
    if (typeof content !== 'string') throw new Error('工作台对话数据无效')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return workbenchDataStore.write(project.path, relativePath, content)
  })
  ipcMain.handle('project:writeFile', async (_event, relativePath: string, content: string, projectPath?: string) => {
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) throw new Error('文件内容超过 2 MB 编辑上限')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeCodingPath(relativePath, true, true, project)
    const target = await resolveSafeCodingTarget(normalized, project)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  })
  ipcMain.handle('project:captureIdea', async (_event, prompt: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('鎸囧畾鐨勯」鐩笉瀛樺湪鎴栨棤鏁')
    const target = path.join(project.path, 'docs', 'idea.md')
    const existing = await fs.readFile(target, 'utf8').catch(() => '')
    const request = prompt.trim()
    if (!request) throw new Error('开发需求不能为空')
    const initial = `# Mod idea\n\n${request}\n\n## Project target\n\n- Loader: ${project.loader}\n- Minecraft: ${project.minecraftVersion}\n- Namespace: ${project.namespace}\n`
    const content = existing.trim() && !existing.includes('Describe the feature in ModMind')
      ? `${existing.trimEnd()}\n\n---\n\n## Development request ${new Date().toLocaleString('zh-CN')}\n\n${request}\n`
      : initial
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  })
  ipcMain.handle('project:createFile', async (_event, relativePath: string, content = '', projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    const target = resolveProjectPathFor(project, normalized)
    if (await pathExists(target)) throw new Error('目标路径已存在')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    return { project, path: normalized }
  })
  ipcMain.handle('project:createDirectory', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    const target = resolveProjectPathFor(project, normalized)
    if (await pathExists(target)) throw new Error('目标路径已存在')
    await fs.mkdir(target, { recursive: true })
    return { project, path: normalized }
  })
  ipcMain.handle('project:renamePath', async (_event, from: string, to: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const source = resolveProjectPathFor(project, normalizeReadablePath(from, project))
    const destination = resolveProjectPathFor(project, normalizeReadablePath(to, project))
    if (!(await pathExists(source))) throw new Error('源路径不存在')
    if (await pathExists(destination)) throw new Error('目标路径已存在')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(source, destination)
    return { project, path: path.relative(project.path, destination).replaceAll('\\', '/') }
  })
  ipcMain.handle('project:deletePath', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    if (isToolDataDirectory(normalized.split('/')[0]) || ignoredDirectories.has(normalized.split('/')[0])) throw new Error('不能删除受保护的项目目录')
    await fs.rm(resolveProjectPathFor(project, normalized), { recursive: true, force: true })
  })
  // The generic delete path refuses everything under .modmind; workbench data
  // cleanup needs a narrow exception for exactly the files ModMind owns.
  ipcMain.handle('project:deleteWorkbenchData', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project).replaceAll('\\', '/')
    // The renderer sends '.modmind/'-prefixed paths; accept both forms so the
    // whitelist cannot silently reject every cleanup call again.
    const scoped = normalized.replace(/^\.modmind\//u, '')
    const workbenchDocument = /^(?:workbench-conversations|workbench-timeline(?:-[\w-]+)?)\.json$/u.test(scoped)
    if (scoped !== 'external-agents/session-codex.json'
      && scoped !== 'external-agents/session-claude.json'
      && !workbenchDocument
      && !/^external-agents\/sessions\/workspace\/[\w.-]+$/u.test(scoped)) {
      throw new Error('只能删除工作台对话数据文件')
    }
    if (workbenchDocument) return workbenchDataStore.delete(project.path, `.modmind/${scoped}`)
    await fs.rm(resolveProjectPathFor(project, `.modmind/${scoped}`), { recursive: true, force: true })
  })
  ipcMain.handle('project:reveal', async (_event, relativePath = '', projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = relativePath ? normalizeReadablePath(relativePath, project) : ''
    shell.showItemInFolder(resolveProjectPathFor(project, normalized))
  })
  ipcMain.handle('project:hasExportArtifact', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (isModpackProject(project)) {
      return readModpackManifest(project).then(() => true).catch(() => false)
    }
    if (!isJavaLoader(project.loader)) {
      const buildDirectory = path.join(project.path, 'build')
      const suffix = project.loader === 'bedrock' ? '.mcaddon' : '.zip'
      const entries = await fs.readdir(buildDirectory, { withFileTypes: true }).catch(() => [])
      return entries.some((entry) => entry.isFile() && entry.name.endsWith(suffix))
    }
    const buildDirectory = path.join(project.path, 'build', 'libs')
    const entries = await fs.readdir(buildDirectory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar') || /(sources|javadoc|dev|shadow)/i.test(entry.name)) continue
      const stat = await fs.stat(path.join(buildDirectory, entry.name)).catch(() => null)
      if (stat && stat.size > 0) return true
    }
    return false
  })
  ipcMain.handle('project:exportArtifact', async () => {
    const project = requireProject()
    if (isModpackProject(project)) {
      const release = await requireReleaseService().prepareExport()
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出 Modrinth 整合包',
        defaultPath: path.join(app.getPath('downloads'), `${project.namespace}-${release.version}.mrpack`),
        filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }]
      })
      if (result.canceled || !result.filePath) return null
      const archive = await createModrinthPackArchive(project, { version: release.version, summary: release.summary })
      await fs.writeFile(result.filePath, archive)
      await requireReleaseService().markExported()
      return result.filePath
    }
    if (!isJavaLoader(project.loader)) {
      const buildDirectory = path.join(project.path, 'build')
      const suffix = project.loader === 'bedrock' ? '.mcaddon' : '.zip'
      const entries = await fs.readdir(buildDirectory, { withFileTypes: true }).catch(() => [])
      const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map(async (entry) => {
        const source = path.join(buildDirectory, entry.name)
        return { source, stat: await fs.stat(source) }
      }))
      const latest = candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
      if (!latest) throw new Error(project.loader === 'bedrock' ? '尚未找到 .mcaddon，请先构建项目' : '尚未找到网易工作台工程归档，请先构建项目')
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: project.loader === 'bedrock' ? '导出基岩 Add-On' : '导出网易工作台工程归档',
        defaultPath: path.join(app.getPath('downloads'), path.basename(latest.source)),
        filters: [{ name: project.loader === 'bedrock' ? 'Minecraft Add-On' : 'NetEase Workbench Archive', extensions: [suffix.slice(1)] }]
      })
      if (result.canceled || !result.filePath) return null
      if (path.resolve(result.filePath) !== path.resolve(latest.source)) await fs.copyFile(latest.source, result.filePath)
      return result.filePath
    }
    await requireReleaseService().prepareExport()
    await requireMinecraftRuntime().buildProject()
    const buildDirectory = path.join(project.path, 'build', 'libs')
    const entries = await fs.readdir(buildDirectory, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar') && !/(sources|javadoc|dev|shadow)/i.test(entry.name))
      .map(async (entry) => {
        const source = path.join(buildDirectory, entry.name)
        return { source, stat: await fs.stat(source) }
      }))
    const latest = candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
    if (!latest || latest.stat.size <= 0) throw new Error('尚未找到可导出的 Mod JAR，请先成功构建项目')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 Mod JAR',
      defaultPath: path.join(app.getPath('downloads'), path.basename(latest.source)),
      filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    })
    if (result.canceled || !result.filePath) return null
    if (path.resolve(result.filePath) !== path.resolve(latest.source)) await fs.copyFile(latest.source, result.filePath)
    await requireReleaseService().markExported()
    return result.filePath
  })
  ipcMain.handle('project:prepareIde', () => prepareProjectIde(requireProject()))
  ipcMain.handle('project:openIde', async () => {
    const project = requireProject()
    await prepareProjectIde(project)
    const result = await new Promise<{ error?: Error }>((resolve) => {
      const invocation = process.platform === 'win32'
        ? windowsCmdInvocation('code.cmd', [project.path])
        : { command: 'code', args: [project.path], windowsVerbatimArguments: false as const }
      execFile(invocation.command, invocation.args, {
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
      }, (error) => resolve({ ...(error ? { error } : {}) }))
    })
    if (result.error) {
      await shell.openPath(project.path)
      throw new Error('未检测到 VS Code 命令行，已在文件管理器中打开项目；安装 VS Code 后运行 “Shell Command: Install code command in PATH”')
    }
  })
  ipcMain.handle('project:previewMigration', (_event, input: ProjectMigrationInput) => previewProjectMigration(input))
  ipcMain.handle('project:migrate', (_event, input: ProjectMigrationInput) => migrateProject(input))

  ipcMain.handle('build:preflight', async (event, projectPath?: string): Promise<PreflightResult> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const progress = (item: PipelineEvent, wait?: number): Promise<void> => sendBuildProgress(event, {...item, projectPath: project.path}, wait)
    await progress(pipelineEvent('checking', '读取项目清单', '正在验证 ModMind 项目元数据', 'running'))
    await progress(pipelineEvent('checking', '检查资源描述', '正在解析 Loader 描述文件', 'running'))
    const { success, logs } = await inspectProjectPreflight(project, projectManifest(project))
    const reportDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    await fs.mkdir(reportDirectory, { recursive: true })
    const reportPath = path.join(reportDirectory, `preflight-${Date.now()}.log`)
    await fs.writeFile(reportPath, logs.join('\n'), 'utf8')
    await progress(
      pipelineEvent(
        success ? 'complete' : 'error',
        success ? '项目预检通过' : '项目预检失败',
        success ? '工程结构有效；仍需执行 Gradle 构建验证依赖和源码' : '请根据报告修复缺失或无效文件',
        success ? 'success' : 'error'
      ), 0
    )
    return {
      success,
      summary: success ? '项目预检通过' : '项目预检发现错误',
      logs,
      reportPath
    }
  })

  ipcMain.handle('snapshots:create', async (_event, label: string, projectPath?: string): Promise<SnapshotInfo> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return createProjectSnapshot(label.trim() || '手动快照', {}, project)
  })
  ipcMain.handle('snapshots:list', async (_event, projectPath?: string): Promise<SnapshotInfo[]> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const root = path.join(project.path, projectDataDirectory(project), 'snapshots')
    if (!(await pathExists(root))) return []
    const entries = await fs.readdir(root, { withFileTypes: true })
    const snapshots: SnapshotInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        snapshots.push(JSON.parse(await fs.readFile(path.join(root, entry.name, 'snapshot.json'), 'utf8')) as SnapshotInfo)
      } catch {
        // Ignore incomplete snapshots.
      }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  ipcMain.handle('snapshots:restore', (_event, id: string, projectPath?: string): Promise<SnapshotRestoreResult> => restoreProjectSnapshot(id, projectPath))
  ipcMain.handle('snapshots:delete', (_event, id: string, projectPath?: string): Promise<SnapshotInfo[]> => deleteProjectSnapshot(id, projectPath))

  ipcMain.handle('relationships:list', () => requireAddonRelationshipService().list())
  ipcMain.handle('relationships:providers', () => requireAddonRelationshipService().providers())
  ipcMain.handle('relationships:recommendations', () => requireAddonRelationshipService().recommendations())
  ipcMain.handle('relationships:search', (_event, query: unknown, providers?: unknown) => {
    const selected = Array.isArray(providers) ? providers.filter((entry): entry is 'modrinth' | 'curseforge' | 'mcmod' => entry === 'modrinth' || entry === 'curseforge' || entry === 'mcmod') : undefined
    return requireAddonRelationshipService().search(typeof query === 'string' ? query : '', selected)
  })
  ipcMain.handle('relationships:versions', (_event, provider: unknown, projectId: unknown) => {
    if (provider === 'mcmod' && typeof projectId === 'string') return requireAddonRelationshipService().versions(provider, projectId)
    if ((provider !== 'modrinth' && provider !== 'curseforge') || typeof projectId !== 'string') throw new Error('模组平台或项目 ID 无效')
    return requireAddonRelationshipService().versions(provider, projectId)
  })
  ipcMain.handle('relationships:installPlatform', (_event, input: AddonPlatformInstallInput) => {
    if (!input || (input.provider !== 'modrinth' && input.provider !== 'curseforge') || typeof input.projectId !== 'string' || !['required', 'optional', 'test'].includes(String(input.role))) throw new Error('平台目标参数无效')
    return requireAddonRelationshipService().installPlatform(input)
  })
  ipcMain.handle('relationships:beginMcmodDownload', (_event, projectId: unknown, fileKey: unknown) => {
    if (typeof projectId !== 'string' || typeof fileKey !== 'string') throw new Error('MC百科文件参数无效')
    return requireAddonRelationshipService().beginMcmodDownload(projectId, fileKey)
  })
  ipcMain.handle('relationships:refreshMcmodCaptcha', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('MC百科验证码会话无效')
    return requireAddonRelationshipService().refreshMcmodCaptcha(sessionId)
  })
  ipcMain.handle('relationships:submitMcmodCaptcha', (_event, sessionId: unknown, captcha: unknown, role: unknown) => {
    if (typeof sessionId !== 'string' || typeof captcha !== 'string' || !['required', 'optional', 'test'].includes(String(role))) throw new Error('MC百科验证码参数无效')
    return requireAddonRelationshipService().submitMcmodCaptcha(sessionId, captcha, role as AddonRelationshipRole)
  })
  ipcMain.handle('relationships:prepare', (_event, input: AddonPrepareInput) => requireAddonRelationshipService().prepare(normalizeAddonPrepareInput(input && typeof input === 'object' ? input : {})))
  ipcMain.handle('relationships:beginImport', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入目标模组 JAR',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    return requireAddonRelationshipService().beginImport(result.filePaths)
  })
  ipcMain.handle('relationships:confirmImport', (_event, batchId: unknown, selections: unknown) => {
    if (typeof batchId !== 'string' || !Array.isArray(selections)) throw new Error('批量导入确认无效')
    return requireAddonRelationshipService().confirmImport(batchId, selections as AddonImportSelection[])
  })
  ipcMain.handle('relationships:cancelImport', (_event, batchId: unknown) => {
    if (typeof batchId === 'string') requireAddonRelationshipService().cancelImport(batchId)
  })
  ipcMain.handle('relationships:linkProject', async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, { title: '选择另一个 ModMind 模组项目', properties: ['openDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const target = await readProjectInfo(selected.filePaths[0])
    if (!target) throw new Error('所选目录不是 ModMind 项目')
    return invokeMinecraftOperation(() => withMinecraftResourceLock(async () => {
      const artifact = await buildLinkedProjectTree(target, undefined, [requireProject().path])
      return requireAddonRelationshipService().linkProject(target, artifact)
    }))
  })
  ipcMain.handle('relationships:importSource', async (_event, relationshipId: unknown, sourceType: unknown) => {
    if (typeof relationshipId !== 'string' || (sourceType !== 'archive' && sourceType !== 'folder')) throw new Error('源码导入参数无效')
    const selected = await dialog.showOpenDialog(mainWindow!, sourceType === 'folder'
      ? { title: '选择目标模组源码目录', properties: ['openDirectory'] }
      : { title: '选择目标模组源码归档', properties: ['openFile'], filters: [{ name: 'Source Archive', extensions: ['jar', 'zip'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    return requireAddonRelationshipService().importSource(relationshipId, selected.filePaths[0])
  })
  ipcMain.handle('relationships:setRole', (_event, relationshipId: unknown, role: unknown) => {
    if (typeof relationshipId !== 'string' || !['required', 'optional', 'test'].includes(String(role))) throw new Error('联动关系参数无效')
    return requireAddonRelationshipService().setRole(relationshipId, role as AddonRelationshipRole)
  })
  ipcMain.handle('relationships:remove', (_event, relationshipId: unknown) => {
    if (typeof relationshipId !== 'string') throw new Error('联动关系 ID 无效')
    return requireAddonRelationshipService().remove(relationshipId)
  })
  ipcMain.handle('relationships:audit', () => requireAddonRelationshipService().audit())

  ipcMain.handle('dependencies:search', (_event, query: string, offset?: number) => requireDependencyService().search(query, offset))
  ipcMain.handle('dependencies:versions', (_event, projectId: string) => requireDependencyService().versions(projectId))
  ipcMain.handle('dependencies:list', () => requireDependencyService().list())
  ipcMain.handle('dependencies:install', (_event, input) => requireDependencyService().install(input))
  ipcMain.handle('dependencies:installMaven', (_event, input) => requireDependencyService().installMaven(input))
  ipcMain.handle('dependencies:audit', () => requireDependencyService().audit())
  ipcMain.handle('dependencies:remove', (_event, projectId: string) => requireDependencyService().remove(projectId))

  ipcMain.handle('git:status', () => requireGitService().status())
  ipcMain.handle('git:initialize', () => requireGitService().initialize())
  ipcMain.handle('git:diff', (_event, relativePath?: string) => requireGitService().diff(relativePath))
  ipcMain.handle('git:commit', (_event, input: GitCommitInput) => requireGitService().commit(input))
  ipcMain.handle('git:createBranch', (_event, name: string) => requireGitService().createBranch(name))
  ipcMain.handle('git:listRemotes', () => requireGitService().listRemotes())
  ipcMain.handle('git:addRemote', (_event, name: string, url: string) => requireGitService().addRemote(name, url))
  ipcMain.handle('git:removeRemote', (_event, name: string) => requireGitService().removeRemote(name))
  ipcMain.handle('git:fetch', (_event, remote?: string) => requireGitService().fetch(remote))
  ipcMain.handle('git:pull', (_event, remote?: string, branch?: string) => requireGitService().pull(remote, branch))
  ipcMain.handle('git:push', (_event, remote?: string, branch?: string) => requireGitService().push(remote, branch))
  ipcMain.handle('git:merge', (_event, branch: string) => requireGitService().merge(branch))
  ipcMain.handle('git:rebase', (_event, branch: string) => requireGitService().rebase(branch))
  ipcMain.handle('git:pullRequestUrl', async (_event, remote?: string) => {
    const url = await requireGitService().pullRequestUrl(remote)
    await shell.openExternal(url)
    return url
  })

  ipcMain.handle('content:create', (_event, input: ContentCreateInput) => requireContentService().create(input))
  ipcMain.handle('content:importAudio', async (_event, input: AudioImportInput) => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'flac', 'm4a'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return requireContentService().importAudio(result.filePaths[0], input)
  })
  ipcMain.handle('content:validate', () => requireContentService().validate())

  ipcMain.handle('tests:runMatrix', async (event, targets: TestTarget[]): Promise<TestMatrixResult> => {
    requireProject()
    return runDiagnosticOperation('tests', 'matrix', 'Project test matrix', () => runProjectTestMatrix(targets, undefined, (target, completed, total) => {
      if (!event.sender.isDestroyed()) event.sender.send('tests:progress', { target, completed, total })
    }), { targets })
  })
  ipcMain.handle('tests:generateWorkflow', () => generateGithubWorkflow(requireProject()))

  ipcMain.handle('release:getSettings', () => requireReleaseService().getSettings())
  ipcMain.handle('release:saveSettings', async (_event, settings: ReleaseSettings) => {
    const saved = await requireReleaseService().saveSettings(settings)
    const providerSecrets = await readReleaseSecrets()
    curseForgeProviderKey = providerSecrets.curseForgeToken || process.env.MODMIND_CURSEFORGE_API_KEY || '$2a$10$BB17.sSejQebcTN01XAqmeXbucdfzq/nIKXylaKLpQHtHLrREVPku'
    modProviderRegistry = null
    return saved
  })
  ipcMain.handle('release:prepareExport', () => requireReleaseService().prepareExport())
  ipcMain.handle('release:markExported', () => requireReleaseService().markExported())
  ipcMain.handle('release:suggestSummary', () => generateAiReleaseSummary())
  ipcMain.handle('release:preflight', () => requireReleaseService().preflight())
  ipcMain.handle('release:publish', (_event, input: ReleasePublishInput) => runDiagnosticOperation('release', 'publish', 'Project release', () => requireReleaseService().publish(input), { targets: input.targets }))

  // Controlled JAR decompilation (受控反编译): results live in the userData cache, never in project sources.
  const decompileCacheRoot = (): string => path.join(app.getPath('userData'), 'decompile')
  const activeDecompileRuns = new Map<string, AbortController>()
  ipcMain.handle('decompile:pickJar', async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, { title: '选择要分析的 Mod JAR', properties: ['openFile'], filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    return selected.filePaths[0]
  })
  ipcMain.handle('decompile:inspect', (_event, jarPath: unknown) => runDiagnosticOperation('decompile', 'inspect', 'JAR decompile inspection', async () => {
    if (typeof jarPath !== 'string' || !jarPath.trim()) throw new Error('缺少 JAR 路径')
    return inspectForDecompilation(jarPath.trim(), { cacheRoot: decompileCacheRoot() })
  }, { jarPath }))
  ipcMain.handle('decompile:start', (_event, input: unknown) => runDiagnosticOperation('decompile', 'start', 'Controlled JAR decompilation', async () => {
    if (!input || typeof input !== 'object') throw new Error('反编译请求无效')
    const value = input as Partial<DecompileRunRequest>
    if (typeof value.jarPath !== 'string' || !value.jarPath.trim()) throw new Error('缺少 JAR 路径')
    const request: DecompileRunRequest = {
      jarPath: value.jarPath.trim(),
      skipRemap: value.skipRemap === true,
      ...(typeof value.minecraftVersion === 'string' && value.minecraftVersion.trim() ? { minecraftVersion: value.minecraftVersion.trim() } : {})
    }
    const controller = new AbortController()
    activeDecompileRuns.set(request.jarPath, controller)
    try {
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntimeForTools(
        DECOMPILE_MIN_JAVA,
        (message) => sendDecompileEvent(controller.signal, { jarSha256: '', phase: 'inspecting', message }),
        ({ source, downloaded, total }) => sendDecompileEvent(controller.signal, { jarSha256: '', phase: 'downloading-mappings', message: `正在从 ${source} 下载托管 Java`, ...(total > 0 ? { ratio: Math.min(0.05, 0.05 * downloaded / total) } : {}) })
      )
      return await runDecompilation(request, {
        cacheRoot: decompileCacheRoot(),
        javaPath,
        signal: controller.signal,
        onProgress: (event) => sendDecompileEvent(controller.signal, event),
        onOutput: (output) => diagnosticJournal.record({ subsystem: 'decompile', operation: 'engine-output', phase: 'output', level: 'debug', message: redactDiagnosticText(output.slice(-2000)) })
      })
    } finally {
      activeDecompileRuns.delete(request.jarPath)
    }
  }))
  ipcMain.handle('decompile:cancel', (_event, jarPath: unknown) => {
    if (typeof jarPath !== 'string') throw new Error('缺少 JAR 路径')
    activeDecompileRuns.get(jarPath)?.abort()
    return true
  })
  ipcMain.handle('decompile:listFiles', (_event, sourceSha256: unknown) => runDiagnosticOperation('decompile', 'listFiles', 'List decompiled sources', async () => {
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('非法的缓存键')
    return listCachedSourceFiles(decompileCacheRoot(), sourceSha256)
  }))
  ipcMain.handle('decompile:readFile', (_event, sourceSha256: unknown, relativePath: unknown) => runDiagnosticOperation('decompile', 'readFile', 'Read decompiled source', async () => {
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('非法的缓存键')
    if (typeof relativePath !== 'string') throw new Error('缺少文件路径')
    return readCachedSourceFile(decompileCacheRoot(), sourceSha256, relativePath)
  }))
  ipcMain.handle('decompile:scanReferences', (_event, jarPath: unknown, knownPackages: unknown) => runDiagnosticOperation('decompile', 'scanReferences', 'Class reference scan', async () => {
    if (typeof jarPath !== 'string' || !jarPath.trim()) throw new Error('缺少 JAR 路径')
    const known = Array.isArray(knownPackages)
      ? knownPackages.filter((entry): entry is { modId: string; packages: string[] } =>
        Boolean(entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).modId === 'string' && Array.isArray((entry as Record<string, unknown>).packages)))
      : []
    return scanReferencesForJar(jarPath.trim(), known)
  }))
  ipcMain.handle('decompile:getTerms', (_event, sourceFileName: unknown) => {
    return { version: DECOMPILE_TERMS_VERSION, title: DECOMPILE_TERMS_TITLE, sections: DECOMPILE_TERMS_SECTIONS, rendered: renderDecompileTerms(typeof sourceFileName === 'string' ? sourceFileName : 'mod.jar') }
  })
  ipcMain.handle('decompile:createModuleFromJar', (_event, input: unknown) => runDiagnosticOperation('decompile', 'createModuleFromJar', 'Export decompiled sources as self-made module', async () => {
    const pack = requireProject()
    if (!isModpackProject(pack)) throw new Error('只有整合包项目可以把反编译结果转为自制模组')
    assertProjectMutationAllowed(pack.path, '从反编译源码创建自制模组')
    if (!input || typeof input !== 'object') throw new Error('导出请求无效')
    const value = input as Record<string, unknown>
    // The terms acknowledgement is mandatory and must reference the current terms version.
    const terms = value.termsAcknowledgement && typeof value.termsAcknowledgement === 'object' ? value.termsAcknowledgement as Record<string, unknown> : null
    if (!terms || terms.termsVersion !== DECOMPILE_TERMS_VERSION) throw new Error(`需要接受当前版本（${DECOMPILE_TERMS_VERSION}）的反编译源码使用条款后才能导出`)
    if (terms.acknowledged !== true) throw new Error('未确认使用条款')
    const origin = terms.origin === 'ai-action' ? 'ai-action' as const : 'user-workspace' as const
    const moduleName = typeof value.moduleName === 'string' ? value.moduleName : ''
    const plan = plannedModulePaths(pack.path, moduleName)
    const provenance = await readDecompileProvenanceForExport(decompileCacheRoot(), String(value.sourceSha256 ?? ''))
    const created = await createModuleFromDecompiledSources({
      packPath: pack.path,
      jarName: provenance.sourceFileName,
      moduleName,
      provenance,
      sourcesDirectory: path.join(decompileCacheRoot(), 'jars', String(value.sourceSha256 ?? ''), 'sources'),
      acknowledgement: {
        acceptedAt: new Date().toISOString(),
        sourceJarSha256: provenance.sourceSha256,
        sourceFileName: provenance.sourceFileName,
        origin
      }
    })
    await addModpackModule(pack, { name: created.name, namespace: created.namespace, path: created.relativePath, createdAt: new Date().toISOString() })
    diagnosticJournal.record({ subsystem: 'decompile', operation: 'create-module', phase: 'success', level: 'info', message: `已从反编译源码创建自制模组 ${created.namespace}（来源 ${provenance.sourceFileName}，条款 v${DECOMPILE_TERMS_VERSION}，${origin === 'ai-action' ? 'AI 发起' : '用户发起'}）`, data: { namespace: created.namespace, fileCount: created.fileCount } })
    return created
  }))
  ipcMain.handle('decompile:createProjectFromJar', (_event, input: unknown) => runDiagnosticOperation('decompile', 'createProjectFromJar', 'Create ModMind project from decompiled sources', async () => {
    assertProjectSwitchAllowed()
    if (!input || typeof input !== 'object') throw new Error('项目创建请求无效')
    const value = input as Record<string, unknown>
    const sourceSha256 = typeof value.sourceSha256 === 'string' ? value.sourceSha256.trim() : ''
    if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('缺少有效的反编译缓存标识')
    const terms = value.termsAcknowledgement && typeof value.termsAcknowledgement === 'object'
      ? value.termsAcknowledgement as Record<string, unknown>
      : null
    if (!terms || terms.termsVersion !== DECOMPILE_TERMS_VERSION) throw new Error(`需要接受当前版本（${DECOMPILE_TERMS_VERSION}）的反编译源码使用条款后才能创建项目`)
    if (terms.acknowledged !== true) throw new Error('未确认使用条款')
    const loader = value.loader
    if (!isJavaLoader(loader)) throw new Error('反编译项目目前仅支持 Fabric、Quilt、Forge 和 NeoForge')
    const name = validateProjectNameInput(typeof value.name === 'string' ? value.name : '')
    const minecraftVersion = typeof value.minecraftVersion === 'string' ? value.minecraftVersion.trim() : ''
    if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(minecraftVersion)) throw new Error('Minecraft 版本格式无效')
    const compatibility = await requireLoaderCatalog().resolve(loader, minecraftVersion)
    const destination = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    if (destination.canceled || !destination.filePaths[0]) return null
    const namespace = slugify(name)
    const projectPath = path.join(destination.filePaths[0], namespace)
    if (await pathExists(projectPath)) throw new Error('目标项目目录已经存在，请选择其他位置或名称')
    const project: ProjectInfo = {
      name,
      path: projectPath,
      loader,
      minecraftVersion,
      namespace,
      createdAt: new Date().toISOString(),
      loaderVersion: compatibility.loaderVersion,
      apiVersion: compatibility.apiVersion,
      qslVersion: compatibility.qslVersion,
      javaVersion: compatibility.javaVersion,
      projectVersion: CURRENT_PROJECT_VERSION,
      toolDataDirectory: '.modmind'
    }
    const provenance = await readDecompileProvenanceForExport(decompileCacheRoot(), sourceSha256)
    let seededFileCount = 0
    await fs.mkdir(projectPath)
    try {
      await writeProjectTemplate(project, false)
      const seeded = await seedProjectFromDecompiledSources({
        projectPath,
        jarName: provenance.sourceFileName,
        provenance,
        sourcesDirectory: path.join(decompileCacheRoot(), 'jars', sourceSha256, 'sources'),
        acknowledgement: {
          acceptedAt: new Date().toISOString(),
          sourceJarSha256: provenance.sourceSha256,
          sourceFileName: provenance.sourceFileName,
          origin: terms.origin === 'ai-action' ? 'ai-action' : 'user-workspace'
        }
      })
      seededFileCount = seeded.fileCount
    } catch (error) {
      await fs.rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    currentProject = project
    await rememberRecentProject(project)
    await refreshExternalAgentContext(project).catch(() => undefined)
    emitProjectChanged()
    diagnosticJournal.record({ subsystem: 'decompile', operation: 'create-project', phase: 'success', level: 'info', message: `已从反编译源码创建 ModMind 项目 ${project.namespace}（来源 ${provenance.sourceFileName}，条款 v${DECOMPILE_TERMS_VERSION}）`, data: { projectPath, fileCount: seededFileCount } })
    return project
  }))

  ipcMain.handle('settings:getAgent', async () => {
    const settings = await readSettings()
    return publicAgentSettings(settings)
  })
  ipcMain.handle('settings:saveAgent', async (_event, settings: AgentSettings) => {
    const saved = await saveAgentSettings(settings)
    setNetworkProxy(saved.networkProxyUrl ?? '')
    return publicAgentSettings(saved)
  })
  ipcMain.handle('settings:listAgentModels', (_event, kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) => listAvailableAgentModels(kind, configuration))
  ipcMain.handle('settings:scanGradle', () => scanGradleInstallations())
  ipcMain.handle('settings:scanJavaHomes', () => detectInstalledJavaHomes())
  ipcMain.handle('settings:probeJavaHome', (_event, home: unknown) => {
    if (typeof home !== 'string' || !home.trim()) throw new Error('缺少要检测的 Java 路径')
    return probeJavaHomeInfo(home)
  })
  ipcMain.handle('settings:pickJavaHome', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 JDK 或 Java 运行时目录',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.on('diagnostics:rendererEvent', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return
    const value = input as Record<string, unknown>
    const subsystem = typeof value.subsystem === 'string' ? value.subsystem : 'renderer'
    const operation = typeof value.operation === 'string' ? value.operation : 'event'
    const phase = typeof value.phase === 'string' ? value.phase : 'event'
    let message = typeof value.message === 'string' ? value.message : 'Renderer diagnostic event'
    if (/ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/i.test(message)) {
      const now = Date.now()
      if (now - resizeObserverDiagnosticAt < 60_000) {
        suppressedResizeObserverDiagnostics += 1
        return
      }
      if (suppressedResizeObserverDiagnostics) {
        message = `${message} (${suppressedResizeObserverDiagnostics} duplicate events suppressed)`
        suppressedResizeObserverDiagnostics = 0
      }
      resizeObserverDiagnosticAt = now
    }
    const level = value.level === 'debug' || value.level === 'warning' || value.level === 'error' ? value.level : 'info'
    let rendererError: Error | undefined
    if (value.error && typeof value.error === 'object') {
      const errorValue = value.error as Record<string, unknown>
      rendererError = new Error(typeof errorValue.message === 'string' ? errorValue.message : 'Renderer error')
      if (typeof errorValue.name === 'string') rendererError.name = errorValue.name
      if (typeof errorValue.stack === 'string') rendererError.stack = errorValue.stack
    }
    diagnosticJournal.record({
      subsystem,
      operation,
      phase,
      level,
      message,
      ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
      ...(value.data !== undefined ? { data: value.data } : {}),
      ...(rendererError ? { error: rendererError } : {})
    })
  })
  ipcMain.handle('diagnostics:exportLogs', (_event, input: unknown) => {
    const pages = Array.isArray(input) ? input as DiagnosticPageSnapshot[] : []
    return exportDiagnosticLogs(pages)
  })
  ipcMain.handle('remote-build:gitee:getSettings', () => readGiteeBuildSettings().then((settings) => ({ ...settings, token: '' })))
  ipcMain.handle('remote-build:gitee:saveSettings', (_event, settings: GiteeBuildSettings) => saveGiteeBuildSettings(settings))
  ipcMain.handle('remote-build:gitee:validate', async (_event, settings?: GiteeBuildSettings) => runDiagnosticOperation('gitee', 'validate', 'Gitee connection validation', async () => {
    const stored = await readGiteeBuildSettings()
    const input = settings ? { ...stored, ...settings, token: settings.token?.trim() || stored.token } : stored
    return requireGiteeBuildService().validate(input)
  }))
  ipcMain.handle('remote-build:gitee:trigger', () => runDiagnosticOperation('gitee', 'trigger', 'Gitee remote build', () => requireGiteeBuildService().trigger()))
  ipcMain.handle('external-agents:detect', async () => {
    const settings = await readSettings()
    return Promise.all([
      detectExternalAgent('codex', {
        executables: [managedCodexExecutablePath(app.getPath('userData'))],
        includeDefaults: false
      }),
      detectExternalAgent('claude', {executables: [settings.externalAgents?.claude?.executable ?? '']})
    ])
  })
  ipcMain.handle('external-agents:configure', async (_event, kind: ExternalAgentKind, configuration: NonNullable<AgentSettings['externalAgents']>[ExternalAgentKind]) => {
    if (!['codex', 'claude'].includes(kind)) throw new Error('不支持的外部代理')
    const settings = await readSettings()
    const existingConfiguration = settings.externalAgents?.[kind]
    const nextConfiguration = {
      ...existingConfiguration,
      ...configuration,
      ...(kind === 'codex' ? { executable: undefined } : {}),
      ...(configuration?.apiKey?.trim() ? {apiKey: configuration.apiKey.trim()} : existingConfiguration?.apiKey ? {apiKey: existingConfiguration.apiKey} : {})
    }
    const next: AgentSettings = {
      ...settings,
      externalAgents: {...settings.externalAgents, [kind]: nextConfiguration}
    }
    const saved = await saveAgentSettings(next)
    return configureExternalAgentProvider(kind, saved)
  })
  ipcMain.handle('external-agents:history', async (_event, kind: ExternalAgentKind) => {
    if (!['codex', 'claude'].includes(kind)) throw new Error('不支持的外部代理')
    return readExternalAgentHistory(requireProject(), kind)
  })
  ipcMain.handle('external-agents:install', async (_event, kind: ExternalAgentKind) => {
    if (!['codex', 'claude'].includes(kind)) throw new Error('不支持的外部代理')
    if (kind === 'codex') {
      const executable = await ensureManagedCodexRuntime({rootDir: app.getPath('userData')})
      const status = await detectExternalAgent('codex', {executables: [executable], includeDefaults: false})
      if (!status.installed || !isManagedCodexVersion(status.version)) throw new Error('Codex 托管运行时版本校验失败')
      const settings = await readSettings()
      await saveAgentSettings({
        ...settings,
        externalAgents: {
          ...settings.externalAgents,
          codex: {...settings.externalAgents?.codex, executable}
        }
      })
      return status
    }
    return downloadActivities.run({ label: `安装 ${externalAgentLabel(kind)}`, detail: '正在通过系统包管理器下载安装' }, () => installExternalAgent(kind))
  })
  ipcMain.handle('external-agents:openDocs', (_event, kind: ExternalAgentKind) => {
    if (!['codex', 'claude'].includes(kind)) throw new Error('不支持的外部代理')
    return shell.openExternal(externalAgentDocsUrl(kind))
  })
  ipcMain.handle('external-agents:launch', async (_event, kind: ExternalAgentKind) => {
    if (!['codex', 'claude'].includes(kind)) throw new Error('不支持的外部代理')
    const project = requireProject()
    const settings = await readSettings()
    const configured = settings.externalAgents?.[kind] ?? {}
    const configuredCodex = kind === 'codex' && Boolean(configured.apiKey?.trim() || configured.baseUrl?.trim() || configured.model?.trim())
      ? await prepareConfiguredCodex(project, 'manual', configured)
      : undefined
    const env = configuredCodex?.environment ?? await externalAgentRunEnvironment(kind, settings)
    let executable = configuredCodex?.executable ?? configured.executable
    if (!executable && kind === 'codex') {
      const managed = await detectExternalAgent('codex', {executables: [managedCodexExecutablePath(app.getPath('userData'))], includeDefaults: false})
      executable = managed.executable || undefined
    }
    await launchExternalAgent(kind, project, executable, env)
  })
  ipcMain.handle('beginner-codex:prepare', async (event, projectPath?: string) => {
    const routedProjectPath = typeof projectPath === 'string' && projectPath.trim() ? path.resolve(projectPath) : undefined
    const project = routedProjectPath ? await readProjectInfo(routedProjectPath) : currentProject
    if (!project) throw new Error('请先创建或打开项目')
    try {
      const result = await prepareQuotaCodex(project, 'workspace', (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('beginner-codex:progress', {...progress, ...(routedProjectPath ? {projectPath: routedProjectPath} : {})})
      })
      return {
        ready: true,
        version: result.version,
        configChanged: result.configChanged,
        configSource: result.configSource
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!event.sender.isDestroyed()) event.sender.send('beginner-codex:progress', {
        stage: 'error',
        title: '开发工具准备失败',
        detail,
        status: 'error',
        ...(routedProjectPath ? {projectPath: routedProjectPath} : {})
      })
      throw new Error(detail)
    } finally {
      // Readiness checks never retain the device key. A quota task prepares a
      // fresh environment immediately before it spawns Codex.
      clearPreparedCodexCredentials()
    }
  })
  ipcMain.handle('ai:pickAttachments', (_event, kind: AiAttachmentSelectionKind) => {
    if (kind !== 'files' && kind !== 'directory') throw new Error('附件选择类型无效')
    return pickAiAttachments(kind)
  })
  ipcMain.handle('ai:validateAttachments', (_event, attachments: AiAttachment[], projectPath?: string) => validateAiAttachments(attachments, projectPath))
  ipcMain.handle('ai:createCode', async (event, prompt: string, sessionId?: string, backend?: AgentSettings['codingBackend'], executionProfile?: AiExecutionProfile, options?: AiCreateCodeOptions) => {
    if (false) {
      aiCancelRequests.delete(event.sender.id)
      const error = new Error('AI 编程已停止')
      error.name = 'AbortError'
      throw error
    }
    const requestedSurface: AiSurface =
      options?.surface === 'inspiration' ? 'inspiration' :
      options?.surface === 'modeling' ? 'modeling' :
      'workspace'
    const project = await resolveAiProject(options)
    if (requestedSurface === 'workspace' && isAiAbandonmentRequest(prompt)) {
      const recovery = await readActiveAiTask(project)
      const ownsRecovery = Boolean(recovery && aiRecoveryMatchesSessionScope(recovery, options?.sessionScope))
      if (recovery && ownsRecovery) await clearActiveAiTask(project, recovery.taskId)
      const response = recovery && !ownsRecovery
        ? '当前对话没有可放弃的恢复任务，其他对话的任务未受影响。'
        : '已放弃当前恢复任务。'
      return { summary: response, finalResponse: response, tasks: [], files: [], tests: [], warnings: [], snapshot: { id: '', label: '', createdAt: new Date().toISOString(), fileCount: 0 }, changedFiles: [], intent: 'informational' }
    }
    const recoveryCandidate = requestedSurface === 'workspace' && isAiContinuationRequest(prompt)
      ? await readActiveAiTask(project)
      : undefined
    const recovery = recoveryCandidate && aiRecoveryMatchesSessionScope(recoveryCandidate, options?.sessionScope)
      ? recoveryCandidate
      : undefined
    const selectedBackend = backend === 'quota' || backend === 'codex' || backend === 'claude'
      ? backend
      : recovery?.backend === 'quota' || recovery?.backend === 'codex' || recovery?.backend === 'claude'
        ? recovery.backend
        : (await readSettings()).codingBackend
    const normalizedExecutionProfile: AiExecutionProfile = recovery?.executionProfile === 'beginner-unlimited' || executionProfile === 'beginner-unlimited'
      ? 'beginner-unlimited'
      : 'standard'
    const run: ActiveAiRun = {
      id: aiRunId(event.sender.id, project.path, sessionId), senderId: event.sender.id, startedAt: recovery?.startedAt ?? new Date().toISOString(), sessionId, sessionScope: options?.sessionScope, projectPath: project.path,
      executionProfile: normalizedExecutionProfile, backend: selectedBackend, surface: requestedSurface
    }
    const controller = new AbortController()
    try {
      return await withAiRun(run, controller, () => recovery
        ? runExternalCodingAgent(event, recovery.prompt, sessionId, selectedBackend, normalizedExecutionProfile, recovery, { ...options, runId: run.id, surface: 'workspace', projectPath: project.path }, controller.signal)
        : createAiCode(event, prompt, sessionId, selectedBackend, normalizedExecutionProfile, { ...options, runId: run.id, surface: requestedSurface, projectPath: project.path }, controller.signal))
    } catch (error) {
      const message = describeAgentRunError(error)
      const cancellation = error instanceof Error && error.name === 'AbortError'
      const recoverable = cancellation || isRecoverableAgentRunError(error, message)
      sendAiOutput(event, cancellation ? 'warning' : 'error', message, sessionId, project.path, run.id, { terminal: !recoverable, recoverable, backend: run.backend })
      throw new Error(message)
    }

  })
  ipcMain.handle('ai:cancelCode', async (event, sessionId?: string, projectPath?: string): Promise<AiCancellationResult> => {
    const inspirationCancellation = Boolean(sessionId?.startsWith('inspiration-'))
    const switchKey = !inspirationCancellation && projectPath ? aiProjectKey(projectPath) : undefined
    const activeSwitch = switchKey ? activeAiBackendSwitches.get(switchKey) : undefined
    if (switchKey) aiBackendSwitchCoordinator.invalidatePending(switchKey)
    if (activeSwitch && !activeSwitch.controller.signal.aborted) {
      activeSwitch.controller.abort(Object.assign(new Error('Agent 切换已由用户停止'), { name: 'AbortError' }))
    }
    const matches = [...activeAiRuns.values()].filter((run) => {
      if (projectPath && !sameProjectPath(run.projectPath, projectPath)) return false
      if (inspirationCancellation) return run.senderId === event.sender.id && run.sessionId === sessionId
      if (run.surface !== 'workspace') return run.senderId === event.sender.id && Boolean(sessionId && run.sessionId === sessionId)
      // A renderer reload changes sender.id while the project-owned process
      // remains alive. An explicit project path therefore owns cancellation.
      return Boolean(projectPath) || run.senderId === event.sender.id
    })
    const runIds = matches.map((run) => run.id)
    for (const run of matches) {
      aiCancelRequests.add(run.id)
      aiAbortControllers.get(run.id)?.abort()
    }
    const switchSharesRun = Boolean(activeSwitch && matches.some((run) => aiAbortControllers.get(run.id) === activeSwitch.controller))
    const matched = runIds.length + (activeSwitch && !switchSharesRun ? 1 : 0)
    if (!matched) return { status: 'idle', matched: 0, remaining: 0 }
    const stopped = await waitForCondition(
      () => runIds.every((runId) => !activeAiRuns.has(runId))
        && (!activeSwitch || !switchKey || activeAiBackendSwitches.get(switchKey) !== activeSwitch),
      AI_CANCEL_CONFIRM_TIMEOUT_MS
    )
    const remainingRuns = runIds.filter((runId) => activeAiRuns.has(runId)).length
    const switchRemaining = Boolean(activeSwitch && switchKey && activeAiBackendSwitches.get(switchKey) === activeSwitch)
    const remaining = remainingRuns + (switchRemaining && (!switchSharesRun || remainingRuns === 0) ? 1 : 0)
    // Cancellation preserves the checkpoint. A later natural-language
    // "继续" resumes only the missing stages and saved review feedback.
    return { status: stopped ? 'stopped' : 'timed_out', matched, remaining }
  })
  ipcMain.handle('ai:clearQuotaCredentials', () => clearPreparedCodexCredentials())
  ipcMain.handle('ai:getRecovery', (_event, projectPath?: string) => getAiRecoveryInfo(projectPath))
  ipcMain.handle('ai:getProjectTaskState', async (_event, projectPath?: string): Promise<AiProjectTaskState> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效 ModMind 项目')
    return aiProjectTaskState(project.path)
  })
  ipcMain.handle('ai:resumeRecovery', async (event, projectPath?: string) => {
    if (false) {
      aiCancelRequests.delete(event.sender.id)
      const error = new Error('AI 编程已停止')
      error.name = 'AbortError'
      throw error
    }
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('继续任务所属的项目不存在或已不再有效')
    const recovery = await readActiveAiTask(project)
    if (!recovery) throw new Error('没有找到可继续的 AI 任务')
    const executionProfile = recovery.executionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard'
    const backend = recovery.backend === 'quota' || recovery.backend === 'codex' || recovery.backend === 'claude' ? recovery.backend : 'codex'
    const run: ActiveAiRun = { id: aiRunId(event.sender.id, project.path, recovery.sessionId), senderId: event.sender.id, startedAt: recovery.startedAt, sessionId: recovery.sessionId, sessionScope: recovery.sessionScope, projectPath: project.path, executionProfile, backend, surface: 'workspace' }
    const controller = new AbortController()
    try {
      return await withAiRun(run, controller, () => runExternalCodingAgent(event, recovery.prompt, recovery.sessionId, backend, executionProfile, recovery, { runId: run.id, surface: 'workspace', projectPath: project.path }, controller.signal))
    } catch (error) {
      const message = describeAgentRunError(error)
      const cancellation = error instanceof Error && error.name === 'AbortError'
      const recoverable = cancellation || isRecoverableAgentRunError(error, message)
      sendAiOutput(event, cancellation ? 'warning' : 'error', message, recovery.sessionId, project.path, run.id, { terminal: !recoverable, recoverable, backend: run.backend })
      throw new Error(message)
    }

  })
  ipcMain.handle('ai:switchBackend', async (event, requestedBackend: AgentSettings['codingBackend'], projectPath?: string, sessionScope?: string, switchId?: number): Promise<AiBackendSwitchResult> => {
    if (!['quota', 'codex', 'claude'].includes(requestedBackend)) throw new Error('不支持的 AI 内核')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或无效')
    const key = aiProjectKey(project.path)
    const ticket = aiBackendSwitchCoordinator.request(key)
    const previousSettings = await readSettings()
    try {
      await assertBackendSwitchTargetReady(requestedBackend, previousSettings)
    } catch (error) {
      if (!aiBackendSwitchCoordinator.isLatestRequest(ticket)) return { status: 'superseded', backend: requestedBackend }
      const activeRun = activeWorkspaceRun(project.path)
      const activeSwitch = aiBackendSwitchCoordinator.current(key)
      const matchesActiveRun = Boolean(activeRun && activeSwitch?.target.backend === activeRun.backend)
      return {
        status: 'rejected',
        backend: requestedBackend,
        message: describeAgentRunError(error),
        activeBackend: activeRun?.backend ?? previousSettings.codingBackend,
        ...(matchesActiveRun && activeSwitch?.target.switchId !== undefined ? { activeSwitchId: activeSwitch.target.switchId } : {}),
        ...(matchesActiveRun ? { activeReady: activeSwitch?.ready === true } : {})
      }
    }
    const switchState = aiBackendSwitchCoordinator.accept(ticket, previousSettings, { backend: requestedBackend, ...(switchId !== undefined ? { switchId } : {}) })
    if (!switchState) return { status: 'superseded', backend: requestedBackend }
    const generation = switchState.sequence
    let recovery: ActiveAiTask | null = null
    let run: ActiveAiRun | null = null
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let startupTimedOut = false
    let backendReady = false
    const controller = new AbortController()
    const previousSwitch = activeAiBackendSwitches.get(key)
    if (previousSwitch && !previousSwitch.controller.signal.aborted) {
      previousSwitch.controller.abort(Object.assign(new Error('Agent 切换已被后续选择取代'), { name: 'AbortError' }))
    }
    const activeSwitch = { sequence: switchState.sequence, controller }
    activeAiBackendSwitches.set(key, activeSwitch)
    startupTimer = setTimeout(() => {
      if (backendReady || controller.signal.aborted) return
      startupTimedOut = true
      const timeout = new Error('目标 Agent 启动准备超时；当前任务恢复点已保留，可直接重试切换')
      timeout.name = 'BackendStartupTimeoutError'
      controller.abort(timeout)
    }, AI_BACKEND_START_TIMEOUT_MS)
    startupTimer.unref?.()
    try {
      abortWorkspaceRuns(project.path)
      await awaitWithAbort(waitForWorkspaceRunsToStop(project.path), controller.signal, 'Agent 切换已停止')
      if (!aiBackendSwitchCoordinator.isCurrent(switchState)) return { status: 'superseded', backend: requestedBackend }
      recovery = await awaitWithAbort(readActiveAiTask(project), controller.signal, 'Agent 切换已停止')
      if (previousSettings.codingBackend !== requestedBackend) {
        await awaitWithAbort(saveAgentSettings({ ...previousSettings, codingBackend: requestedBackend }), controller.signal, 'Agent 切换已停止')
      }
      if (!recovery) {
        if (!aiBackendSwitchCoordinator.markReady(switchState)) return { status: 'superseded', backend: requestedBackend }
        return { status: 'idle', backend: requestedBackend }
      }
      const scope = sessionScope?.trim() || recovery.sessionScope
      run = {
        id: aiRunId(event.sender.id, project.path, recovery.sessionId ?? `switch-${generation}`),
        senderId: event.sender.id,
        startedAt: recovery.startedAt,
        sessionId: recovery.sessionId,
        sessionScope: scope,
        projectPath: project.path,
        executionProfile: requestedBackend === 'quota' && recovery.executionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard',
        backend: requestedBackend,
        surface: 'workspace'
      }
      if (!aiBackendSwitchCoordinator.isCurrent(switchState)) return { status: 'superseded', backend: requestedBackend }
      const activeRecovery = recovery
      const activeRun = run
      const result = await withAiRun(activeRun, controller, () => runExternalCodingAgent(
        event,
        activeRecovery.prompt,
        activeRecovery.sessionId,
        requestedBackend,
        activeRun.executionProfile,
        activeRecovery,
        { runId: activeRun.id, surface: 'workspace', projectPath: project.path, sessionScope: scope, resumeSession: true, fallbackPrompt: activeRecovery.prompt },
        controller.signal,
        {
          onBackendReady: () => {
            if (!aiBackendSwitchCoordinator.markReady(switchState)) return
            backendReady = true
            if (startupTimer) clearTimeout(startupTimer)
            if (event.sender.isDestroyed()) return
            event.sender.send('ai:backendReady', { backend: requestedBackend, projectPath: project.path, ...(switchId !== undefined ? { switchId } : {}) })
          }
        }
      ))
      return { status: 'completed', backend: requestedBackend, result }
    } catch (error) {
      if (!backendReady && aiBackendSwitchCoordinator.isCurrent(switchState)) {
        if (switchState.rollbackValue.codingBackend !== requestedBackend) {
          await awaitWithAbort(saveAgentSettings(switchState.rollbackValue), AbortSignal.timeout(10_000)).catch(() => undefined)
        }
        if (recovery) await awaitWithAbort(writeActiveAiTask(recovery, project), AbortSignal.timeout(10_000)).catch(() => undefined)
        aiBackendSwitchCoordinator.fail(switchState)
      }
      const effectiveError = startupTimedOut
        ? Object.assign(new Error('目标 Agent 启动准备超时；当前任务恢复点已保留，可直接重试切换'), { name: 'BackendStartupTimeoutError' })
        : error
      const message = describeAgentRunError(effectiveError)
      const cancellation = effectiveError instanceof Error && effectiveError.name === 'AbortError'
      const recoverable = cancellation || isRecoverableAgentRunError(effectiveError, message)
      if (recovery && run) sendAiOutput(event, cancellation ? 'warning' : 'error', message, recovery.sessionId, project.path, run.id, { terminal: !recoverable, recoverable, backend: run.backend })
      throw new Error(message)
    } finally {
      if (startupTimer) clearTimeout(startupTimer)
      if (activeAiBackendSwitches.get(key) === activeSwitch) activeAiBackendSwitches.delete(key)
    }
  })
  ipcMain.handle('ai:restoreRecovery', () => restoreAiRecovery())

  // --- 用户插件系统 ---------------------------------------------------------
  ipcMain.handle('plugins:list', async () => {
    const service = getPluginService()
    if (!service) return { plugins: [] }
    await waitForPluginRegistry()
    return service.getSnapshot()
  })
  ipcMain.handle('plugins:setEnabled', (_event, pluginId: string, enabled: boolean) => {
    const service = getPluginService()
    if (!service) throw new Error('插件系统未初始化')
    service.setEnabled(String(pluginId), Boolean(enabled))
    getPluginRuntime()?.syncRecords(new Map(service.getSnapshot().plugins.map((record) => [record.manifest.id, record])))
    broadcastPluginSnapshot(service.getSnapshot())
    return service.getSnapshot()
  })
  ipcMain.handle('plugins:importZip', async (_event, scope?: 'global' | 'project') => importPluginZipInteractive(scope === 'project' && currentProject ? 'project' : 'global'))
  ipcMain.handle('plugins:reload', async () => refreshPluginRegistry(true))
  ipcMain.handle('plugins:openDirectory', async () => {
    const target = path.join(app.getPath('userData'), 'plugins')
    await fs.mkdir(target, { recursive: true })
    await shell.openPath(target)
  })
  ipcMain.handle('plugins:exportDoc', async (_event, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('文档内容为空')
    const target = path.join(app.getPath('downloads'), 'ModMind插件开发文档.md')
    await fs.writeFile(target, content, 'utf8')
    return target
  })
  ipcMain.handle('plugins:invokeTool', async (_event, pluginId: string, toolName: string, input: unknown) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.callTool(String(pluginId), String(toolName), input)
  })
  ipcMain.handle('plugins:activate', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.activate(String(pluginId))
  })
  ipcMain.handle('plugins:restart', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.restart(String(pluginId))
  })
  ipcMain.handle('plugins:diagnostics', (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.getDiagnostics(String(pluginId))
  })
  ipcMain.handle('plugins:clearDiagnostics', (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.clearDiagnostics(String(pluginId))
  })
  ipcMain.handle('plugins:recordLog', (_event, pluginId: string, source: unknown, level: unknown, message: unknown) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    const normalizedSource = source === 'panel' || source === 'overlay' ? source : 'host'
    const normalizedLevel = level === 'warn' || level === 'error' ? level : 'info'
    runtime.recordLog(String(pluginId), normalizedSource, normalizedLevel, String(message ?? '').slice(0, 10_000))
  })
  ipcMain.handle('plugins:handleContextOp', async (_event, pluginId: string, op: string, args: Record<string, unknown>) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), String(op), args ?? {})
  })
  ipcMain.handle('plugins:getProjectInfo', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), 'projectInfo', {})
  })
  ipcMain.handle('plugins:copyToClipboard', async (_event, pluginId: string, text: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), 'clipboardWrite', { text })
  })
  ipcMain.handle('plugins:export', async (_event, pluginId: string) => {
    const service = getPluginService()
    if (!service) throw new Error('插件系统未初始化')
    const result = await dialog.showSaveDialog({
      title: '导出 ModMind 插件',
      defaultPath: `${String(pluginId)}.zip`,
      filters: [{ name: 'ModMind 插件', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    await service.exportZip(String(pluginId), result.filePath)
    return result.filePath
  })
  ipcMain.handle('plugins:delete', async (_event, pluginId: string) => {
    const service = getPluginService()
    if (!service) throw new Error('插件系统未初始化')
    await service.deletePlugin(String(pluginId))
    await refreshPluginRegistry()
    return service.getSnapshot()
  })
  ipcMain.handle('plugins:getOverlayWindows', () => pluginOverlayWindowStates())
  ipcMain.handle('plugins:openOverlayWindow', (_event, pluginId: string) => {
    const normalizedId = String(pluginId)
    createPluginOverlayWindow(normalizedId)
    return pluginOverlayWindowState(normalizedId)
  })
  ipcMain.handle('plugins:closeOverlayWindow', (_event, pluginId: string) => {
    const normalizedId = String(pluginId)
    const window = pluginOverlayWindows.get(normalizedId)
    if (window && !window.isDestroyed()) window.close()
    return { pluginId: normalizedId, open: false, alwaysOnTop: false } satisfies PluginOverlayWindowState
  })
  ipcMain.handle('plugins:setOverlayAlwaysOnTop', (_event, pluginId: string, alwaysOnTop: unknown) => {
    const normalizedId = String(pluginId)
    const window = pluginOverlayWindows.get(normalizedId)
    if (!window || window.isDestroyed()) throw new Error('悬浮窗口未打开')
    window.setAlwaysOnTop(alwaysOnTop === true, 'floating')
    broadcastPluginOverlayWindows()
    return pluginOverlayWindowState(normalizedId)
  })
}

app.whenReady().then(async () => {
  installConsoleDiagnosticCapture()
  diagnosticJournal.record({
    subsystem: 'app',
    operation: 'startup',
    phase: 'ready',
    message: `ModMind ${app.getVersion()} is starting`,
    data: { platform: process.platform, arch: process.arch, packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node }
  })
  const providerSecrets = await readReleaseSecrets()
  curseForgeProviderKey = providerSecrets.curseForgeToken || curseForgeProviderKey
  modProviderRegistry = null
  setNetworkProxy((await readSettings().catch(() => null))?.networkProxyUrl ?? '')
  if (!hasSingleInstanceLock) return
  appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    updateUrl: configuredAppUpdateUrl(),
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    beforeInstall: prepareForAppUpdateInstall,
    quit: () => app.quit(),
    notifyDownloaded: (version) => notifyUser('ModMind 更新已下载', `${version} 已准备好，下次启动时将自动安装`)
  })
  appUpdateService.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('app:updateState', state)
    }
  })
  if (await appUpdateService.installPendingUpdateOnStartup()) return
  await migrateLegacyUserData()
  electronApp.setAppUserModelId('dev.modmind.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
  // 用户插件系统初始化（零插件时无副作用）
  initializePlugins({
    userDataDirectory: app.getPath('userData'),
    projectRoot: () => currentProject?.path ?? null,
    projectInfo: () => currentProject ? { name: currentProject.name, path: currentProject.path, kind: currentProject.kind ?? 'mod' } : null,
    onSnapshotChanged: (snapshot) => {
      getPluginRuntime()?.syncRecords(new Map(snapshot.plugins.map((record) => [record.manifest.id, record])))
      reconcilePluginOverlayWindows(snapshot)
      broadcastPluginSnapshot(snapshot)
    },
    onDiagnosticsChanged: broadcastPluginDiagnostics
  })
  const initialPluginRegistry = refreshPluginRegistry()
  createWindow()
  void initialPluginRegistry.then((snapshot) => {
    reconcilePluginOverlayWindows(snapshot)
    broadcastPluginSnapshot(snapshot)
  }).catch(() => undefined)
  await loadMcpBridgePreference().catch(() => undefined)
  const bridgeRequest = mcpBridgeRequest()
  if (bridgeRequest.stop) {
    void stopPublicMcpBridge().catch((error) => console.error('[mcp-bridge] failed to stop', error))
  } else if (bridgeRequest.enabled) {
    // 命令行 --mcp-bridge 视同用户显式开启，偏好随本次启动记住
    mcpBridgePreferenceEnabled = true
    void startPublicMcpBridge(bridgeRequest.projectPath).then((result) => {
      console.info(`[mcp-bridge] listening for ${result.projectPath}; config: ${result.bridgeConfigPath}`)
    }).catch((error) => console.error('[mcp-bridge] failed to start', error))
  }
  void readDeviceCredentials().then((credentials) => {
    if (credentials) return startRemoteClientIfPossible()
    return undefined
  }).catch((error) => console.warn('[remote] startup failed', error))
  for (const deepLink of pendingDeviceDeepLinks.splice(0)) void handleDeviceDeepLink(deepLink)
  if ((process.env.MODMIND_E2E ?? process.env.MODTOOL_E2E) === '1') void runAutomatedE2E()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  diagnosticJournal.record({ subsystem: 'app', operation: 'windows', phase: 'closed', message: 'All application windows closed' })
  if (process.platform !== 'darwin') app.quit()
})
