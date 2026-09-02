import { contextBridge, ipcRenderer } from 'electron'
import type { AgentSettings, AiCreateCodeOptions, AiExecutionProfile, AiOutputEvent, BeginnerAiPreferences, BeginnerCodexProgress, DetectedJavaHome, DeviceConnectionState, DetachedWindowTarget, DiagnosticPageSnapshot, ExistingProjectAdoptInput, ExternalAgentConfiguration, ExternalAgentKind, JavaProbeOutcome, McpBridgeState, ModMindApi, ModpackModuleSide, PipelineEvent, ProjectCreateInput, ProjectInfo, ProjectMigrationInput, ProjectRenameInput, RemoteConnectionState, SidebarViewId } from '../shared/types'
import type { ImageGenerationRequest, ImageProcessingOptions, ImageStudioSettingsInput } from '../shared/imageStudio'
import type { BlockbenchAction, BlockbenchAssetMetadata, BlockbenchAssetSaveRequest, BlockbenchBounds, BlockbenchCaptureRequest } from '../shared/blockbench'
import type { AssetIntentProgram, AssetRefinementProgram } from '../shared/assetIntent'
import type {AdvancedAssetPreviewOptions, AdvancedAssetProgram, ReferenceImageAssetProgram} from '../shared/advancedAsset'
import type { LocalServerEvent, LocalServerState, MinecraftLaunchOptions, MinecraftRuntimeEvent, MinecraftRuntimeState } from '../shared/minecraft'
import type { AddonImportSelection, AddonPlatformInstallInput, AddonPrepareInput, AddonRelationshipRole, AddonSearchProvider, AudioImportInput, ContentCreateInput, DependencyInstallInput, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, TestTarget } from '../shared/production'
import { isExpectedCancellation } from '../shared/diagnostics'

const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer)

function rendererError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message || String(error), ...(error.stack ? { stack: error.stack } : {}) }
  return { name: 'Error', message: String(error) }
}

function sendRendererDiagnostic(payload: Record<string, unknown>): void {
  ipcRenderer.send('diagnostics:rendererEvent', payload)
}

const invoke: typeof ipcRenderer.invoke = async (channel, ...args) => {
  const startedAt = Date.now()
  sendRendererDiagnostic({ subsystem: 'ipc', operation: channel, phase: 'start', level: 'info', message: `IPC operation started: ${channel}` })
  try {
    const result = await rawInvoke(channel, ...args)
    const durationMs = Date.now() - startedAt
    sendRendererDiagnostic({ subsystem: 'ipc', operation: channel, phase: 'success', level: 'info', message: `IPC operation completed: ${channel}`, durationMs })
    return result
  } catch (error) {
    const cancelled = isExpectedCancellation(error)
    sendRendererDiagnostic({ subsystem: 'ipc', operation: channel, phase: cancelled ? 'cancelled' : 'error', level: cancelled ? 'warning' : 'error', message: `IPC operation ${cancelled ? 'cancelled' : 'failed'}: ${channel}`, durationMs: Date.now() - startedAt, error: rendererError(error) })
    throw error
  }
}

window.addEventListener('error', (event) => {
  sendRendererDiagnostic({ subsystem: 'renderer', operation: 'window-error', phase: 'error', level: 'error', message: event.message || 'Renderer window error', data: { filename: event.filename, lineno: event.lineno, colno: event.colno }, error: event.error ? rendererError(event.error) : undefined })
})

window.addEventListener('unhandledrejection', (event) => {
  sendRendererDiagnostic({ subsystem: 'renderer', operation: 'unhandled-rejection', phase: 'error', level: 'error', message: 'Renderer unhandled promise rejection', error: rendererError(event.reason) })
})

const api: ModMindApi = {
  app: {
    getVersion: () => invoke('app:version'),
    checkForUpdates: () => invoke('app:checkForUpdates'),
    getUpdateState: () => invoke('app:getUpdateState'),
    downloadUpdate: () => invoke('app:downloadUpdate'),
    installUpdate: () => invoke('app:installUpdate'),
    onUpdateState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => listener(state)
      ipcRenderer.on('app:updateState', handler)
      return () => ipcRenderer.removeListener('app:updateState', handler)
    },
    onOpenSettings: (listener: () => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('app:openSettings', handler)
      return () => ipcRenderer.removeListener('app:openSettings', handler)
    },
    onOpenView: (listener: (view: SidebarViewId) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: SidebarViewId): void => listener(value)
      ipcRenderer.on('app:openView', handler)
      return () => ipcRenderer.removeListener('app:openView', handler)
    },
    onDetachedWindowClosed: (listener: (target: DetachedWindowTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, target: DetachedWindowTarget): void => listener(target)
      ipcRenderer.on('window:detachedClosed', handler)
      return () => ipcRenderer.removeListener('window:detachedClosed', handler)
    },
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    openDetachedWindow: (target: DetachedWindowTarget, title: string) => invoke('window:openDetached', target, title),
    getDetachedWindowState: () => invoke('window:getDetachedState'),
    setDetachedWindowAlwaysOnTop: (alwaysOnTop: boolean) => invoke('window:setDetachedAlwaysOnTop', alwaysOnTop)
  },
  downloads: {
    list: () => invoke('downloads:list'),
    retry: (id: string) => invoke('downloads:retry', id),
    cancel: (id: string) => invoke('downloads:cancel', id),
    restart: (id: string) => invoke('downloads:restart', id),
    dismiss: (id: string) => invoke('downloads:dismiss', id),
    clearFinished: () => invoke('downloads:clearFinished'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => listener(snapshot)
      ipcRenderer.on('downloads:changed', handler)
      return () => ipcRenderer.removeListener('downloads:changed', handler)
    }
  },
  project: {
    listLoaderVersions: (refresh?: boolean) => invoke('project:listLoaderVersions', refresh),
    create: (input: ProjectCreateInput) => invoke('project:create', input),
    rename: (input: ProjectRenameInput) => invoke('project:rename', input),
    open: () => invoke('project:open'),
    openRecent: (projectPath: string) => invoke('project:openRecent', projectPath),
    listRecent: () => invoke('project:listRecent'),
    removeRecent: (projectPath: string) => invoke('project:removeRecent', projectPath),
    deleteProject: (projectPath: string) => invoke('project:delete', projectPath),
    inspectExisting: (sourceType?: 'folder' | 'zip') => invoke('project:inspectExisting', sourceType),
    adoptExisting: (input: ExistingProjectAdoptInput) => invoke('project:adoptExisting', input),
    current: () => invoke('project:current'),
    listFiles: (projectPath?: string) => invoke('project:listFiles', projectPath),
    listImageAssets: () => invoke('project:listImageAssets'),
    readImageAsset: (relativePath: string) => invoke('project:readImageAsset', relativePath),
    readFile: (relativePath: string, projectPath?: string) => invoke('project:readFile', relativePath, projectPath),
    writeFile: (relativePath: string, content: string, projectPath?: string) => invoke('project:writeFile', relativePath, content, projectPath),
    readWorkbenchData: (relativePath: string, projectPath?: string) => invoke('project:readWorkbenchData', relativePath, projectPath),
    writeWorkbenchData: (relativePath: string, content: string, projectPath?: string) => invoke('project:writeWorkbenchData', relativePath, content, projectPath),
    createFile: (relativePath: string, content?: string, projectPath?: string) => invoke('project:createFile', relativePath, content, projectPath),
    createDirectory: (relativePath: string, projectPath?: string) => invoke('project:createDirectory', relativePath, projectPath),
    renamePath: (from: string, to: string, projectPath?: string) => invoke('project:renamePath', from, to, projectPath),
    deletePath: (relativePath: string, projectPath?: string) => invoke('project:deletePath', relativePath, projectPath),
    deleteWorkbenchData: (relativePath: string, projectPath?: string) => invoke('project:deleteWorkbenchData', relativePath, projectPath),
    reveal: (relativePath?: string, projectPath?: string) => invoke('project:reveal', relativePath, projectPath),
    hasExportArtifact: (projectPath?: string) => invoke('project:hasExportArtifact', projectPath),
    exportArtifact: () => invoke('project:exportArtifact'),
    prepareIde: () => invoke('project:prepareIde'),
    openIde: () => invoke('project:openIde'),
    captureIdea: (prompt: string, projectPath?: string) => invoke('project:captureIdea', prompt, projectPath),
    previewMigration: (input: ProjectMigrationInput) => invoke('project:previewMigration', input),
    migrate: (input: ProjectMigrationInput) => invoke('project:migrate', input),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: ProjectInfo | null): void => listener(value)
      ipcRenderer.on('project:changed', handler)
      return () => ipcRenderer.removeListener('project:changed', handler)
    }
  },
  modpack: {
    get: () => invoke('modpack:get'),
    getServerPackManifest: () => invoke('modpack:getServerPackManifest'),
    addServerPackMods: () => invoke('modpack:addServerPackMods'),
    removeServerPackMod: (fileName: string) => invoke('modpack:removeServerPackMod', fileName),
    exportServerPack: () => invoke('modpack:exportServerPack'),
    importMods: () => invoke('modpack:importMods'),
    removeMod: (fileName: string) => invoke('modpack:removeMod', fileName),
    createModule: (name: string) => invoke('modpack:createModule', name),
    updateModuleSide: (namespace: string, side: ModpackModuleSide) => invoke('modpack:updateModuleSide', namespace, side),
    openModule: (namespace: string) => invoke('modpack:openModule', namespace),
    sync: () => invoke('modpack:sync'),
    listContent: (refresh?: boolean) => invoke('modpack:listContent', refresh),
    contentProjectPath: (contentPath) => invoke('modpack:contentProjectPath', contentPath),
    importContent: (kind, scope) => invoke('modpack:importContent', kind, scope),
    downloadContent: (input) => invoke('modpack:downloadContent', input),
    removeContent: (id) => invoke('modpack:removeContent', id),
    getKeybinds: () => invoke('modpack:getKeybinds'),
    readLock: () => invoke('modpack:readLock'),
    auditLock: () => invoke('modpack:auditLock'),
    providers: () => invoke('modpack:providers'),
    recommendProviders: () => invoke('modpack:recommendProviders'),
    recommendMcmod: () => invoke('modpack:recommendMcmod'),
    searchProviders: (query, providers) => invoke('modpack:searchProviders', query, providers),
    listProviderFiles: (provider, projectId) => invoke('modpack:listProviderFiles', provider, projectId),
    installProviderFile: (provider, projectId, versionId) => invoke('modpack:installProviderFile', provider, projectId, versionId),
    previewMigration: (input) => invoke('modpack:previewMigration', input),
    selectMigrationJar: (input) => invoke('modpack:selectMigrationJar', input),
    createMigration: (input) => invoke('modpack:createMigration', input),
    undoMigration: (migrationId) => invoke('modpack:undoMigration', migrationId),
    migrationHistory: () => invoke('modpack:migrationHistory'),
    onMigrationProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]): void => listener(progress)
      ipcRenderer.on('modpack:migrationProgress', handler)
      return () => ipcRenderer.removeListener('modpack:migrationProgress', handler)
    },
    plan: (concept: unknown) => invoke('modpack:plan', concept),
    applyPlan: (plan: unknown) => invoke('modpack:applyPlan', plan),
    readFtbQuestBook: () => invoke('modpack:readFtbQuestBook'),
    ftbQuestIcon: (itemId: string) => invoke('modpack:ftbQuestIcon', itemId),
    ftbQuestItemNames: (itemIds: string[]) => invoke('modpack:ftbQuestItemNames', itemIds),
    ftbDependencyTexture: () => invoke('modpack:ftbQuestDependencyTexture'),
    ftbQuestShapes: () => invoke('modpack:ftbQuestShapes'),
    saveFtbQuestBook: (book) => invoke('modpack:saveFtbQuestBook', book),
    writeFtbQuest: (input: unknown) => invoke('modpack:writeFtbQuest', input),
    writePatchouliBook: (input: unknown) => invoke('modpack:writePatchouliBook', input),
    applyKeybindPreset: (input: unknown, allowConflicts?: boolean) => invoke('modpack:applyKeybindPreset', input, allowConflicts),
    buildServerPack: (input: unknown) => invoke('modpack:buildServerPack', input),
    installServerRuntime: (input: unknown) => invoke('modpack:installServerRuntime', input),
    verifyServerJoin: (input: unknown) => invoke('modpack:verifyServerJoin', input),
    runServerScenario: (input: unknown) => invoke('modpack:runServerScenario', input),
    getServerState: () => invoke('modpack:getServerState'),
    startServer: (input: unknown) => invoke('modpack:startServer', input),
    stopServer: () => invoke('modpack:stopServer'),
    restartServer: (input: unknown) => invoke('modpack:restartServer', input),
    sendServerCommand: (command: string) => invoke('modpack:sendServerCommand', command),
    onServerState: (listener: (state: LocalServerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: LocalServerState): void => listener(value)
      ipcRenderer.on('local-server:state', handler)
      return () => ipcRenderer.removeListener('local-server:state', handler)
    },
    onServerEvent: (listener: (event: LocalServerEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: LocalServerEvent): void => listener(value)
      ipcRenderer.on('local-server:event', handler)
      return () => ipcRenderer.removeListener('local-server:event', handler)
    },
    listOptimizationProfiles: () => invoke('modpack:listOptimizationProfiles'),
    applyOptimizationProfile: (input: unknown) => invoke('modpack:applyOptimizationProfile', input),
    listManualMods: () => invoke('modpack:listManualMods'),
    searchMcmod: (query: string) => invoke('modpack:searchMcmod', query),
    listMcmodFiles: (projectId: string) => invoke('modpack:listMcmodFiles', projectId),
    beginMcmodDownload: (projectId: string, fileKey: string) => invoke('modpack:beginMcmodDownload', projectId, fileKey),
    refreshMcmodCaptcha: (sessionId: string) => invoke('modpack:refreshMcmodCaptcha', sessionId),
    submitMcmodCaptcha: (sessionId: string, captcha: string) => invoke('modpack:submitMcmodCaptcha', sessionId, captcha)
  },
  build: {
    preflight: (projectPath?: string) => invoke('build:preflight', projectPath),
    onProgress: (listener: (event: PipelineEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PipelineEvent): void => listener(value)
      ipcRenderer.on('build:progress', handler)
      return () => ipcRenderer.removeListener('build:progress', handler)
    }
  },
  snapshots: {
    create: (label: string, projectPath?: string) => invoke('snapshots:create', label, projectPath),
    list: (projectPath?: string) => invoke('snapshots:list', projectPath),
    restore: (id: string, projectPath?: string) => invoke('snapshots:restore', id, projectPath),
    delete: (id: string, projectPath?: string) => invoke('snapshots:delete', id, projectPath)
  },
  settings: {
    getAgent: () => invoke('settings:getAgent'),
    saveAgent: (settings: AgentSettings) => invoke('settings:saveAgent', settings),
    listAgentModels: (kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) => invoke('settings:listAgentModels', kind, configuration),
    scanGradle: () => invoke('settings:scanGradle'),
    scanJavaHomes: (): Promise<DetectedJavaHome[]> => invoke('settings:scanJavaHomes'),
    probeJavaHome: (home: string): Promise<JavaProbeOutcome> => invoke('settings:probeJavaHome', home),
    pickJavaHome: (): Promise<string | null> => invoke('settings:pickJavaHome')
  },
  diagnostics: {
    exportLogs: (pages?: DiagnosticPageSnapshot[]) => invoke('diagnostics:exportLogs', pages)
  },
  device: {
    getState: () => invoke('device:getState'),
    authorize: () => invoke('device:authorize'),
    cancelAuthorization: () => invoke('device:cancelAuthorization'),
    disconnectLocal: () => invoke('device:disconnectLocal'),
    refreshUsage: () => invoke('device:refreshUsage'),
    getAiPreferences: () => invoke('device:getAiPreferences'),
    saveAiPreferences: (preferences: BeginnerAiPreferences) => invoke('device:saveAiPreferences', preferences),
    listModels: (force?: boolean) => invoke('device:listModels', force),
    openSite: (path?: string) => invoke('device:openSite', path),
    onState: (listener: (state: DeviceConnectionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: DeviceConnectionState): void => listener(value)
      ipcRenderer.on('device:state', handler)
      return () => ipcRenderer.removeListener('device:state', handler)
    }
  },
  remote: {
    getState: () => invoke('remote:getState'),
    start: () => invoke('remote:start'),
    stop: () => invoke('remote:stop'),
    onState: (listener: (state: RemoteConnectionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: RemoteConnectionState): void => listener(value)
      ipcRenderer.on('remote:state', handler)
      return () => ipcRenderer.removeListener('remote:state', handler)
    }
  },
  mcpBridge: {
    getState: () => invoke('mcp-bridge:getState'),
    setEnabled: (enabled: boolean) => invoke('mcp-bridge:setEnabled', enabled),
    onState: (listener: (state: McpBridgeState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: McpBridgeState): void => listener(value)
      ipcRenderer.on('mcp-bridge:state', handler)
      return () => ipcRenderer.removeListener('mcp-bridge:state', handler)
    }
  },
  ai: {
    createCode: (prompt: string, sessionId?: string, backend?: AgentSettings['codingBackend'], executionProfile?: AiExecutionProfile, options?: AiCreateCodeOptions) => invoke('ai:createCode', prompt, sessionId, backend, executionProfile, options),
    pickAttachments: (kind) => invoke('ai:pickAttachments', kind),
    validateAttachments: (attachments, projectPath) => invoke('ai:validateAttachments', attachments, projectPath),
    cancelCode: (sessionId?: string, projectPath?: string) => invoke('ai:cancelCode', sessionId, projectPath),
    clearQuotaCredentials: () => invoke('ai:clearQuotaCredentials'),
    getRecovery: (projectPath?: string) => invoke('ai:getRecovery', projectPath),
    getProjectTaskState: (projectPath?: string) => invoke('ai:getProjectTaskState', projectPath),
    resumeRecovery: (projectPath?: string) => invoke('ai:resumeRecovery', projectPath),
    switchBackend: (backend: AgentSettings['codingBackend'], projectPath?: string, sessionScope?: string, switchId?: number) => invoke('ai:switchBackend', backend, projectPath, sessionScope, switchId),
    onBackendReady: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on('ai:backendReady', handler)
      return () => ipcRenderer.removeListener('ai:backendReady', handler)
    },
    restoreRecovery: () => invoke('ai:restoreRecovery'),
    onProgress: (listener: (event: PipelineEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PipelineEvent): void => listener(value)
      ipcRenderer.on('ai:progress', handler)
      return () => ipcRenderer.removeListener('ai:progress', handler)
    },
    onOutput: (listener: (event: AiOutputEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AiOutputEvent): void => listener(value)
      ipcRenderer.on('ai:output', handler)
      return () => ipcRenderer.removeListener('ai:output', handler)
    }
  },
  beginnerCodex: {
    prepare: (projectPath?: string) => invoke('beginner-codex:prepare', projectPath),
    onProgress: (listener: (progress: BeginnerCodexProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: BeginnerCodexProgress): void => listener(value)
      ipcRenderer.on('beginner-codex:progress', handler)
      return () => ipcRenderer.removeListener('beginner-codex:progress', handler)
    }
  },
  externalAgents: {
    detect: () => invoke('external-agents:detect'),
    configure: (kind: ExternalAgentKind, settings: ExternalAgentConfiguration) => invoke('external-agents:configure', kind, settings),
    history: (kind: ExternalAgentKind) => invoke('external-agents:history', kind),
    install: (kind: ExternalAgentKind) => invoke('external-agents:install', kind),
    openDocs: (kind: ExternalAgentKind) => invoke('external-agents:openDocs', kind),
    launch: (kind: ExternalAgentKind) => invoke('external-agents:launch', kind)
  },
  blockbench: {
    show: (bounds: BlockbenchBounds) => invoke('blockbench:show', bounds),
    hide: () => invoke('blockbench:hide'),
    openProject: () => invoke('blockbench:openProject'),
    saveProject: () => invoke('blockbench:saveProject'),
    setTheme: (theme: 'light' | 'dark') => invoke('blockbench:setTheme', theme),
    runAction: (action: string) => invoke('blockbench:runAction', action),
    execute: (action: BlockbenchAction) => invoke('blockbench:execute', action),
    executeActions: (actions: BlockbenchAction[], expectedRevision?: string) => invoke('blockbench:executeActions', actions, expectedRevision),
    projectState: () => invoke('blockbench:projectState'),
    validate: () => invoke('blockbench:validate'),
    captureViews: (request = {}) => invoke('blockbench:captureViews', request),
    setAssetMetadata: (metadata: BlockbenchAssetMetadata) => invoke('blockbench:setAssetMetadata', metadata),
    saveAssetBundle: (request: BlockbenchAssetSaveRequest) => invoke('blockbench:saveAssetBundle', request),
    history: () => invoke('blockbench:history'),
    createCheckpoint: (label?: string) => invoke('blockbench:createCheckpoint', label),
    restoreHistory: (id: string) => invoke('blockbench:restoreHistory', id),
    getState: () => invoke('blockbench:getState'),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on('blockbench:state', handler)
      void invoke('blockbench:getState').then(listener)
      return () => ipcRenderer.removeListener('blockbench:state', handler)
    }
  },
  assetIntent: {
    compile: (intent: AssetIntentProgram) => invoke('asset-intent:compile', intent),
    preview: (intent: AssetIntentProgram, request: BlockbenchCaptureRequest = {}, expectedRevision?: string) => invoke('asset-intent:preview', intent, request, expectedRevision),
    apply: (intent: AssetIntentProgram, expectedRevision?: string) => invoke('asset-intent:apply', intent, expectedRevision)
  },
  assetRefinement: {
    compile: (refinement: AssetRefinementProgram) => invoke('asset-refinement:compile', refinement),
    preview: (refinement: AssetRefinementProgram, request: BlockbenchCaptureRequest = {}, expectedRevision?: string) => invoke('asset-refinement:preview', refinement, request, expectedRevision),
    apply: (refinement: AssetRefinementProgram, expectedRevision?: string) => invoke('asset-refinement:apply', refinement, expectedRevision)
  },
  advancedAsset: {
    compile: (program: AdvancedAssetProgram, variantId = 'base') => invoke('advanced-asset:compile', program, variantId),
    preview: (program: AdvancedAssetProgram, request: BlockbenchCaptureRequest = {}, options: AdvancedAssetPreviewOptions = {}, expectedRevision?: string) => invoke('advanced-asset:preview', program, request, options, expectedRevision),
    apply: (program: AdvancedAssetProgram, variantId = 'base', expectedRevision?: string) => invoke('advanced-asset:apply', program, variantId, expectedRevision)
  },
  referenceAsset: {
    compile: (program: ReferenceImageAssetProgram) => invoke('reference-asset:compile', program),
    preview: (program: ReferenceImageAssetProgram, request: BlockbenchCaptureRequest = {}, expectedRevision?: string) => invoke('reference-asset:preview', program, request, expectedRevision),
    apply: (program: ReferenceImageAssetProgram, expectedRevision?: string) => invoke('reference-asset:apply', program, expectedRevision)
  },
  assetVisualReview: {
    current: (request: BlockbenchCaptureRequest = {}) => invoke('asset-visual-review:current', request)
  },
  mappings: {
    search: (version: string, query: string, limit?: number) => invoke('mappings:search', version, query, limit),
    getClass: (version: string, className: string, memberQuery?: string) =>
      invoke('mappings:getClass', version, className, memberQuery),
    openSource: (version: string) => invoke('mappings:openSource', version),
    openLoaderDocs: (loader) => invoke('mappings:openLoaderDocs', loader)
  },
  minecraft: {
    getState: () => invoke('minecraft:getState'),
    prepare: () => invoke('minecraft:prepare'),
    cancelPreparation: () => invoke('minecraft:cancelPreparation'),
    restartPreparation: () => invoke('minecraft:restartPreparation'),
    buildProject: (projectPath?: string) => invoke('minecraft:buildProject', projectPath),
    launch: (options: MinecraftLaunchOptions) => invoke('minecraft:launch', options),
    testLaunch: (options: MinecraftLaunchOptions) => invoke('minecraft:testLaunch', options),
    headlessSmokeTest: () => invoke('minecraft:headlessSmokeTest'),
    openHeadlessMcLogin: () => invoke('minecraft:openHeadlessMcLogin'),
    stop: () => invoke('minecraft:stop'),
    syncProjectMod: () => invoke('minecraft:syncProjectMod'),
    syncModpack: () => invoke('minecraft:syncModpack'),
    importMods: () => invoke('minecraft:importMods'),
    removeMod: (name: string) => invoke('minecraft:removeMod', name),
    listMods: () => invoke('minecraft:listMods'),
    onState: (listener: (state: MinecraftRuntimeState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: MinecraftRuntimeState): void => listener(value)
      ipcRenderer.on('minecraft:state', handler)
      return () => ipcRenderer.removeListener('minecraft:state', handler)
    },
    onEvent: (listener: (event: MinecraftRuntimeEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: MinecraftRuntimeEvent): void => listener(value)
      ipcRenderer.on('minecraft:event', handler)
      return () => ipcRenderer.removeListener('minecraft:event', handler)
    }
  },
  production: {
    relationships: {
      list: () => invoke('relationships:list'),
      providers: () => invoke('relationships:providers'),
      search: (query: string, providers?: AddonSearchProvider[]) => invoke('relationships:search', query, providers),
      recommendations: () => invoke('relationships:recommendations'),
      versions: (provider: AddonSearchProvider, projectId: string) => invoke('relationships:versions', provider, projectId),
      installPlatform: (input: AddonPlatformInstallInput) => invoke('relationships:installPlatform', input),
      prepare: (input: AddonPrepareInput) => invoke('relationships:prepare', input),
      beginImport: () => invoke('relationships:beginImport'),
      confirmImport: (batchId: string, selections: AddonImportSelection[]) => invoke('relationships:confirmImport', batchId, selections),
      cancelImport: (batchId: string) => invoke('relationships:cancelImport', batchId),
      linkProject: () => invoke('relationships:linkProject'),
      importSource: (relationshipId: string, sourceType: 'archive' | 'folder') => invoke('relationships:importSource', relationshipId, sourceType),
      setRole: (relationshipId: string, role: AddonRelationshipRole) => invoke('relationships:setRole', relationshipId, role),
      remove: (relationshipId: string) => invoke('relationships:remove', relationshipId),
      audit: () => invoke('relationships:audit'),
      beginMcmodDownload: (projectId: string, fileKey: string) => invoke('relationships:beginMcmodDownload', projectId, fileKey),
      refreshMcmodCaptcha: (sessionId: string) => invoke('relationships:refreshMcmodCaptcha', sessionId),
      submitMcmodCaptcha: (sessionId: string, captcha: string, role: AddonRelationshipRole) => invoke('relationships:submitMcmodCaptcha', sessionId, captcha, role)
    },
    dependencies: {
      search: (query: string, offset?: number) => invoke('dependencies:search', query, offset),
      versions: (projectId: string) => invoke('dependencies:versions', projectId),
      list: () => invoke('dependencies:list'),
      install: (input: DependencyInstallInput) => invoke('dependencies:install', input),
      installMaven: (input: MavenDependencyInput) => invoke('dependencies:installMaven', input),
      audit: () => invoke('dependencies:audit'),
      remove: (projectId: string) => invoke('dependencies:remove', projectId)
    },
    git: {
      status: () => invoke('git:status'),
      initialize: () => invoke('git:initialize'),
      diff: (relativePath?: string) => invoke('git:diff', relativePath),
      commit: (input: GitCommitInput) => invoke('git:commit', input),
      createBranch: (name: string) => invoke('git:createBranch', name),
      listRemotes: () => invoke('git:listRemotes'),
      addRemote: (name: string, url: string) => invoke('git:addRemote', name, url),
      removeRemote: (name: string) => invoke('git:removeRemote', name),
      fetch: (remote?: string) => invoke('git:fetch', remote),
      pull: (remote?: string, branch?: string) => invoke('git:pull', remote, branch),
      push: (remote?: string, branch?: string) => invoke('git:push', remote, branch),
      merge: (branch: string) => invoke('git:merge', branch),
      rebase: (branch: string) => invoke('git:rebase', branch),
      pullRequestUrl: (remote?: string) => invoke('git:pullRequestUrl', remote)
    },
    remoteBuild: {
      getGiteeSettings: () => invoke('remote-build:gitee:getSettings'),
      saveGiteeSettings: (settings) => invoke('remote-build:gitee:saveSettings', settings),
      validateGitee: (settings) => invoke('remote-build:gitee:validate', settings),
      triggerGitee: () => invoke('remote-build:gitee:trigger')
    },
    content: {
      create: (input: ContentCreateInput) => invoke('content:create', input),
      importAudio: (input: AudioImportInput) => invoke('content:importAudio', input),
      validate: () => invoke('content:validate')
    },
    tests: {
      runMatrix: (targets: TestTarget[]) => invoke('tests:runMatrix', targets),
      generateWorkflow: () => invoke('tests:generateWorkflow')
    },
    release: {
      getSettings: () => invoke('release:getSettings'),
      saveSettings: (settings: ReleaseSettings) => invoke('release:saveSettings', settings),
      prepareExport: () => invoke('release:prepareExport'),
      markExported: () => invoke('release:markExported'),
      suggestSummary: () => invoke('release:suggestSummary'),
      preflight: () => invoke('release:preflight'),
      publish: (input: ReleasePublishInput) => invoke('release:publish', input)
    }
  }
  ,
  imageStudio: {
    getSettings: () => invoke('image-studio:getSettings'),
    saveSettings: (settings: ImageStudioSettingsInput) => invoke('image-studio:saveSettings', settings),
    capabilities: () => invoke('image-studio:capabilities'),
    generate: (request: ImageGenerationRequest) => invoke('image-studio:generate', request),
    process: (operation: 'perfect-pixel' | 'remove-background', dataUrl: string, options?: ImageProcessingOptions) => invoke('image-studio:process', operation, dataUrl, options),
    history: () => invoke('image-studio:history'),
    saveAsset: (dataUrl: string, suggestedName: string) => invoke('image-studio:saveAsset', dataUrl, suggestedName),
    saveToProject: (dataUrl: string, suggestedName: string) => invoke('image-studio:saveToProject', dataUrl, suggestedName)
  }
  ,
  decompile: {
    pickJar: () => invoke('decompile:pickJar'),
    inspect: (jarPath: string) => invoke('decompile:inspect', jarPath) as Promise<import('../shared/decompile').DecompileInspectResult>,
    start: (input: { jarPath: string; skipRemap?: boolean; minecraftVersion?: string }) => invoke('decompile:start', input) as Promise<import('../shared/decompile').DecompileRunResult>,
    cancel: (jarPath: string) => invoke('decompile:cancel', jarPath) as Promise<boolean>,
    listFiles: (sourceSha256: string) => invoke('decompile:listFiles', sourceSha256) as Promise<import('../shared/decompile').DecompileFileEntry[]>,
    readFile: (sourceSha256: string, relativePath: string) => invoke('decompile:readFile', sourceSha256, relativePath) as Promise<string>,
    scanReferences: (jarPath: string, knownPackages?: Array<{ modId: string; packages: string[] }>) => invoke('decompile:scanReferences', jarPath, knownPackages) as Promise<import('../shared/decompile').DecompileReferenceReport & { scannedClasses: number }>,
    onProgress: (listener: (event: import('../shared/decompile').DecompileProgressEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/decompile').DecompileProgressEvent): void => listener(value)
      ipcRenderer.on('decompile:event', handler)
      return () => ipcRenderer.removeListener('decompile:event', handler)
    },
    getTerms: (sourceFileName?: string) => invoke('decompile:getTerms', sourceFileName) as Promise<import('../shared/decompileModuleExport').DecompileTermsPayload>,
    createModuleFromJar: (input: { sourceSha256: string; moduleName: string; termsAcknowledgement: { termsVersion: string; acknowledged: true; origin?: 'user-workspace' | 'ai-action' } }) =>
      invoke('decompile:createModuleFromJar', input) as Promise<import('../shared/decompileModuleExport').CreatedModuleFromDecompiled>,
    createProjectFromJar: (input: import('../shared/decompileModuleExport').CreateProjectFromDecompiledInput) =>
      invoke('decompile:createProjectFromJar', input) as Promise<ProjectInfo | null>
  }
  ,
  plugins: {
    list: () => invoke('plugins:list'),
    setEnabled: (pluginId: string, enabled: boolean) => invoke('plugins:setEnabled', pluginId, enabled),
    importZip: (scope?: 'global' | 'project') => invoke('plugins:importZip', scope),
    reload: () => invoke('plugins:reload'),
    openDirectory: () => invoke('plugins:openDirectory'),
    invokeTool: (pluginId: string, toolName: string, input?: unknown) => invoke('plugins:invokeTool', pluginId, toolName, input),
    activate: (pluginId: string) => invoke('plugins:activate', pluginId),
    restart: (pluginId: string) => invoke('plugins:restart', pluginId),
    diagnostics: (pluginId: string) => invoke('plugins:diagnostics', pluginId),
    clearDiagnostics: (pluginId: string) => invoke('plugins:clearDiagnostics', pluginId),
    recordLog: (pluginId: string, source: import('../shared/plugins').PluginLogSource, level: 'info' | 'warn' | 'error', message: string) => invoke('plugins:recordLog', pluginId, source, level, message),
    handleContextOp: (pluginId: string, op: string, args?: Record<string, unknown>) => invoke('plugins:handleContextOp', pluginId, op, args),
    getProjectInfo: (pluginId: string) => invoke('plugins:getProjectInfo', pluginId),
    copyToClipboard: (pluginId: string, text: string) => invoke('plugins:copyToClipboard', pluginId, text),
    export: (pluginId: string) => invoke('plugins:export', pluginId),
    exportDoc: (content: string) => invoke('plugins:exportDoc', content),
    delete: (pluginId: string) => invoke('plugins:delete', pluginId),
    getOverlayWindows: () => invoke('plugins:getOverlayWindows'),
    openOverlayWindow: (pluginId: string) => invoke('plugins:openOverlayWindow', pluginId),
    closeOverlayWindow: (pluginId: string) => invoke('plugins:closeOverlayWindow', pluginId),
    setOverlayAlwaysOnTop: (pluginId: string, alwaysOnTop: boolean) => invoke('plugins:setOverlayAlwaysOnTop', pluginId, alwaysOnTop),
    onChanged: (listener: (snapshot: import('../shared/plugins').PluginSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: import('../shared/plugins').PluginSnapshot): void => listener(snapshot)
      ipcRenderer.on('plugins:changed', handler)
      return () => ipcRenderer.removeListener('plugins:changed', handler)
    },
    onDiagnosticsChanged: (listener: (diagnostics: import('../shared/plugins').PluginDiagnostics) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, diagnostics: import('../shared/plugins').PluginDiagnostics): void => listener(diagnostics)
      ipcRenderer.on('plugins:diagnostics', handler)
      return () => ipcRenderer.removeListener('plugins:diagnostics', handler)
    },
    onOverlayWindowsChanged: (listener: (states: import('../shared/plugins').PluginOverlayWindowState[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, states: import('../shared/plugins').PluginOverlayWindowState[]): void => listener(states)
      ipcRenderer.on('plugins:overlayWindowsChanged', handler)
      return () => ipcRenderer.removeListener('plugins:overlayWindowsChanged', handler)
    }
  }
}

contextBridge.exposeInMainWorld('modmind', api)
