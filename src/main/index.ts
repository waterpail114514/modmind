import { fetchDeviceModelCatalog } from './deviceModelCatalogApi'
import { manageModpackLock } from './modpackLockService'
import { installEditContextMenu } from './editContextMenu'
import { collectDiagnosticEvidence } from './diagnosticEvidence'
import { diagnosticValue } from './diagnosticContext'
import { installNetworkDiagnostics } from './networkDiagnostics'
import { readDiagnosticState, setContributionDiagnosticProvider } from './diagnosticState'
import { ContributionService } from './contributionService'
import { verifiedDiagnosticWrite } from './diagnosticFiles'
import { osCrashEvidence } from './osCrashEvidence'
import { DiagnosticAttachments, diagnosticExportOptions, exportRecoveryDiagnostics, writeDiagnosticArchive } from './diagnosticDelivery'
import type { DiagnosticExportOptions } from '../shared/diagnostics'
import { crashReporter } from 'electron'
import { pluginDiagnosticSnapshot } from './pluginBridgeIntegration'
import { deleteSnapshotSelection, snapshotListPage } from './snapshotBatchDelete'
import type { SnapshotBatchDeleteResult } from '../shared/types'
import { collectBuildDiagnostics, gradleDiagnosticState } from './gradleDiagnostics'
import { developerHostConfig } from './developer/hostEnvironment'
import { configureDeveloperHost } from './developer/hostRuntime'
import { featureDevelopment } from './featureDevelopmentEnvironment'
import { FeatureDevelopmentLoader } from './featureDevelopment'
import { is,optimizer } from '@electron-toolkit/utils'
import { app,BrowserWindow,dialog,ipcMain,Menu,nativeImage,Notification,protocol,safeStorage,screen,shell,Tray } from 'electron'
import extractZip from './safeExtractZip'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { createReadStream,promises as fs,readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerDeveloperIpc } from './developer/ipc'
import { type BlockbenchBridge } from '../../feature-plugins/model-studio/src/main/blockbenchBridge'
import { normalizeAgentApprovalMode } from '../shared/agentApproval'
import { scopedFilePath } from './scopedFilePath'
import { InspirationWorkflowStore, type InspirationWorkflowIdentity } from './inspirationWorkflowStore'
import { inspirationWorkflowInstruction, parseInspirationWorkflow } from '../shared/inspirationWorkflow'
import { mokoInspirationSystemPrompt } from '../shared/mokoInspiration'
import type { AiAttachmentSource } from '../shared/aiAttachments'
import { normalizeAppearance } from '../shared/appTheme'
import { mergeAgentSettingsPatch, type AgentSettingsPatch } from '../shared/agentSettingsPatch'
import { writeSettingsFile } from './settingsFile'
import { retryTransientFileLock } from './fileLockRetry'
import { summarizeLog } from '../shared/creationFeedback'
import type { InspirationEvidenceRequest } from '../shared/inspirationEvidence'
import { runtimePlatformInfo } from '../shared/platform'
import { assertAgentWriteAllowed,configureAgentProtection } from './agentProtection'
import { importAiAttachmentSources } from './aiAttachmentImport'
import { requestAiName } from './aiNaming'
import { importBackgroundMedia,pruneSavedBackgroundMedia,serveBackgroundMedia } from './appearanceMedia'
import { installApplicationMenu } from './applicationMenu'
import { BuildRuntimeManager,detectInstalledJavaHomes,probeJavaHomeInfo } from './buildRuntime'
import { currentVerification } from './creationBuildEvidence'
import { captureCreationRequest } from './creationEvidence'
import { CreationFeedbackService } from './creationFeedbackService'
import { desktopProcessEnvironment } from './desktopEnvironment'
import { DeviceDeepLinkQueue } from './deviceDeepLinkQueue'
import { verifiedDownload } from './downloadService'
import { featureHostRuntime } from './featureHostRuntime'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'
import { delegateModpackModule,ModpackModuleTasks } from './modpackModuleDelegation'
import { ManagedBuildTasks } from './managedBuildTasks'
import { AbortableResourceQueue } from './abortableResourceQueue'
import { inspectModpackModules,resolveAgentModpackModule } from './modpackModuleTools'
import { cleanupTerminalScripts } from './nativeTerminal'
import { nativeToolDiagnostics } from './nativeToolDiagnostics'
import { platformWindowOptions } from './platformWindow'
import { requestWindowConfirmation } from './pluginImportConfirmation'
import { beginProcessShutdown,shutdownProcessTrees } from './processTree'
import { readProjectImage } from './projectImages'
import { readProjectModel } from './projectModels'
import { assignDefaultProjectNamespace,projectNamespacePrompt } from './projectNamespace'
import { projectSearchFiles,searchProjectText } from './projectSearch'
import { readProjectTextFile } from './projectTextRead'
import { WorkbenchApprovals } from './workbenchApprovals'
import { WorkbenchQuestions } from './workbenchQuestions'
import type { WorkbenchQuestionContext } from '../shared/agentQuestion'
import { workbenchSkillNames } from './workbenchSkillPolicy'
import { UserSkillStore } from './userSkillStore'


const readYsmSource: typeof import("../../feature-plugins/model-studio/src/main/modelSourceService").readYsmSource = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').readYsmSource(...args)

import { type MappingService } from '../../feature-plugins/mappings/src/main/mappingService'
import type { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import type { HeadlessMcService } from '../../feature-plugins/testing/src/main/headlessMcService'


import { type ContentService } from '../../feature-plugins/publishing/src/main/contentService'
import { LoaderCatalog } from './loaderCatalog'
import { descriptorPath,projectTemplateFiles } from './projectTemplates'
import { configureStudios, StudioRegistry, studios } from './studioRegistry'
import { builtinStudioDirectories } from './bundledStudioService'
import { studioFormValues, type StudioSurface } from '../shared/studios'
import { featureDefinitionApplies } from '../shared/featureApplicability'
const soundServiceForProject: typeof import("../../feature-plugins/sound-studio/src/main/soundLibraryIpc").soundServiceForProject = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/sound-studio/main').activate>>('sound-studio').soundServiceForProject(...args)

const createSoundMcpHandlers: typeof import("../../feature-plugins/sound-studio/src/main/soundMcpService").createSoundMcpHandlers = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/sound-studio/main').activate>>('sound-studio').createSoundMcpHandlers(...args)

const renderMusicInWindow: typeof import("../../feature-plugins/sound-studio/src/main/soundRenderBridge").renderMusicInWindow = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/sound-studio/main').activate>>('sound-studio').renderMusicInWindow(...args)

import { type DependencyService } from '../../feature-plugins/relationships/src/main/dependencyService'


import { type AddonRelationshipService } from '../../feature-plugins/relationships/src/main/addonRelationshipService'
const readAddonRelationships: typeof import("../../feature-plugins/relationships/src/main/addonRelationshipService").readAddonRelationships = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').readAddonRelationships(...args)

import { type GitService } from '../../feature-plugins/versions/src/main/gitService'


import { type ReleaseSecrets,type ReleaseService } from '../../feature-plugins/publishing/src/main/releaseService'


import { isJavaLoader,isServerPluginPlatform,platformLabel,PROJECT_PLATFORMS } from '../shared/projectPlatform'
import { MODMIND_SOURCE_FINGERPRINT } from '../shared/sourceFingerprint'
import { recordZipExpansion } from './archiveImportPolicy'
import { buildScriptFingerprint } from './buildTrust'
import { inferMinecraftVersions,inferGradleLoader,parseGradleProperties } from './existingProjectMetadata'
import { convertLegacyModtoolProject,readLegacyModtoolProject } from './legacyProjectImport'
import { networkFetch,setNetworkProxy,shutdownNetwork } from './networkRequest'
import { requestAiTextResponse } from './aiTextRequest'
import { migrateMovedProjectMetadata, migrateSelectedSnapshotMetadata } from './projectMetadataMigration'
import { sameProjectPath } from './projectPath'
import { inspectProjectPreflight } from './projectPreflight'
import { renameProjectFiles } from './projectRename'
import { CURRENT_PROJECT_VERSION,MIGRATABLE_PROJECT_VERSION } from './projectVersion'
import { detectedProjectVersion,migrateProjectVersion112 } from './projectVersionMigration'
import { registerServerPluginIpc } from './serverPluginIpc'
import { findPluginArtifact,parsePluginDescriptor } from './serverPluginService'
import { extractSevenZipArchive } from './sevenZipArchive'
import { ignoreSnapshotDirectory, repairLegacySnapshotCaches, snapshotStorageInfo, invalidateSnapshotStorage, canRefreshSnapshotStorageIncrementally } from './snapshotStorage'
import { copySnapshotFilesIncremental, snapshotFileHash, listSnapshotSummaries, invalidateSnapshotCatalog, type SnapshotFileMetadata } from './snapshotStore'
import { withProjectMutation } from './projectMutation'
import { archiveSignatureForFile,extractTar } from './tarArchive'
import { windowsCmdInvocation } from './windowsCommand'


const importItemTexture: typeof import("../../feature-plugins/item-editor/src/main/itemEditorService").importItemTexture = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/item-editor/main').activate>>('item-editor').importItemTexture(...args)
const listManagedItems: typeof import("../../feature-plugins/item-editor/src/main/itemEditorService").listManagedItems = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/item-editor/main').activate>>('item-editor').listManagedItems(...args)
const removeManagedItem: typeof import("../../feature-plugins/item-editor/src/main/itemEditorService").removeManagedItem = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/item-editor/main').activate>>('item-editor').removeManagedItem(...args)
const saveManagedItem: typeof import("../../feature-plugins/item-editor/src/main/itemEditorService").saveManagedItem = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/item-editor/main').activate>>('item-editor').saveManagedItem(...args)


const listVanillaItems: typeof import("../../feature-plugins/item-editor/src/main/itemCatalogService").listVanillaItems = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/item-editor/main').activate>>('item-editor').listVanillaItems(...args)

const createResourcePack: typeof import("../../feature-plugins/resource-packs/src/main/resourcePackService").createResourcePack = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/resource-packs/main').activate>>('resource-packs').createResourcePack(...args)
const deployResourcePack: typeof import("../../feature-plugins/resource-packs/src/main/resourcePackService").deployResourcePack = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/resource-packs/main').activate>>('resource-packs').deployResourcePack(...args)
const listResourcePacks: typeof import("../../feature-plugins/resource-packs/src/main/resourcePackService").listResourcePacks = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/resource-packs/main').activate>>('resource-packs').listResourcePacks(...args)
const resourcePackArchive: typeof import("../../feature-plugins/resource-packs/src/main/resourcePackService").resourcePackArchive = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/resource-packs/main').activate>>('resource-packs').resourcePackArchive(...args)
const validateResourcePack: typeof import("../../feature-plugins/resource-packs/src/main/resourcePackService").validateResourcePack = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/resource-packs/main').activate>>('resource-packs').validateResourcePack(...args)

import { normalizeAiModelSelection,settingsForAiSelection,type AiModelSelection } from '../shared/aiSelection'
import { ProviderSyncService, parseProviderSnapshot, providerOwnerKey, reconcileProviderSync, type ProviderSnapshot, type ProviderModelDiscovery } from './providerSync'
import { normalizeModelAutoCompactTokenLimits,normalizeModelContextWindows,validModelContext } from '../shared/modelContext'
import { codexReasoningCapabilities,isReasoningEffort,normalizeReasoningEffortOptions,reasoningSelectionEffort,selectedReasoningEfforts } from '../shared/modelReasoning'
import type { PluginDiagnostics,PluginOverlayWindowState,PluginSnapshot } from '../shared/plugins'
import { normalizeProjectName,validateProjectNameInput } from '../shared/projectName'
import { awaitWithAbort,throwIfAborted,waitForCondition } from './asyncControl'
import { BackendSwitchCoordinator } from './backendSwitchCoordinator'
import { createStoredZip } from './bedrockAddon'
import { ChatCompletionsAdapter } from './chatCompletionsAdapter'
import { resolveCodexAutoCompactTokenLimit, validateCodexAutoCompactTokenLimit } from './codexModelCatalog'
import { clearPreparedCodexCredentials,ensureManagedCodexRuntime,isManagedCodexVersion,managedCodexExecutablePath,prepareCodex,type CodexServerConfig,type CodexSetupProgress } from './codexSetup'
import { deleteExternalAgentSession,detectExternalAgent,externalAgentDocsUrl,externalAgentLabel,externalAgentSupportsHostedConfiguration,launchExternalAgent,listLocalCodexModels,ModMindBridge,readExternalAgentHistory,refreshExternalAgentContext,runExternalAgent,type ExternalAgentAttemptAudit,type ExternalAgentBridgeHandlers,type ExternalAgentKind,type ExternalAgentRetryState,type ExternalAgentRunOptions } from './externalAgents'
import { GiteeBuildService } from './giteeBuildService'
import { LiveConfiguration,SerialState,type ConfigurationRevision } from './liveConfiguration'
import { QuotaModelRouting, type RoutingCredentials } from './quotaModelRouting'
import { QuotaRoutingSessionStore } from './quotaRoutingSessionStore'
import { validateQuotaModelSelection } from '../shared/quotaModels'
import type { QuotaModelCatalog, QuotaModelSwitchResult } from '../shared/quotaModels'
import { readLocalCodexApiKey,readLocalCodexConfig } from './localCodexConfig'
import { sameApiBaseUrl } from '../shared/apiConnection'
import { resolveModelContextBudget } from './modelContextRegistry'
import { modelReasoningCatalog } from './modelReasoningCatalog'
import { createPluginBridgeTarget,getPluginRuntime,getPluginService,importPluginZipInteractive,initializePlugins,refreshPluginRegistry,registerPluginProtocolSchemeEarly,shutdownPlugins,waitForPluginRegistry } from './pluginBridgeIntegration'
import { PluginChatBridge } from './pluginChatBridge'
import {
activeQuotaModelPreferences,
normalizeQuotaModelPreferences,
parseStoredQuotaModelPreferences,
quotaPreferenceKey,
quotaProfileKey,
resolveQuotaModelPreferences,
updateQuotaModelPreferences,
type StoredQuotaModelPreferences
} from './quotaModelPreferences'

import { describeAiFailureForUser } from '../shared/aiFailure'
import { aiNoticeDetails } from '../shared/aiNotice'
import { selectFinalAiAnswer } from '../shared/aiOutput'
import { isAiAbandonmentRequest,isAiContinuationRequest } from '../shared/aiPrompt'
import { aiConversationIdForSession,aiRecoveryMatchesSessionScope,aiRecoverySessionScope,normalizeAiSessionScope } from '../shared/aiSession'
import type { BlockbenchCaptureRequest } from '../shared/blockbench'
import { draftProjectContext } from '../shared/draftProject'
import { inspirationFeaturePrompt,normalizeInspirationFeatures } from '../shared/inspirationFeatures'
import { normalizeWorkbenchFeatures,type WorkbenchFeatures } from '../shared/workbenchFeatures'
import { usesInspirationWorkflow,WORKBENCH_REQUEST_GUIDANCE } from '../shared/workbenchFlow'
import {
listManagedFiles,
restoreManagedPathsFromSnapshot,
restoreManagedTreeExact,
snapshotManifestBelongsToProject,
validateSnapshotId
} from './agentCore'
import { BEGINNER_AGENT_WORKFLOW_GUIDANCE } from './beginnerAgentPolicy'
import { ConversationStore } from './conversationStore'
import {
checkAppVersion,
DEFAULT_DEVICE_MODEL,
DeviceApiError,
normalizeRelayBaseUrl,
normalizeSiteUrl,
openAiV1BaseUrl,
orderModelsForAgent,
parseDeviceDeepLink,
parseModelPayload,
pollDeviceCode,
queryDeviceUsage,
queryDeviceImageProvider,
requestDeviceCode,
requestDeviceImageLease,
sendDeviceFastMode,
type CustomApiConfig,
type DeviceImageLease
} from './deviceIntegration'
import { PROVIDER_SYNC_CAPABILITY_HEADERS } from '../shared/providerAccounts'
import { createDraftProject,initializeDraftProject,recordDraftMessage } from './draftProjectService'
import { runInspirationResearch } from './inspirationResearch'
import { WorkbenchDataStore } from './workbenchDataStore'

const compileAssetIntent: typeof import("../../feature-plugins/model-studio/src/main/assetIntentCompiler").compileAssetIntent = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileAssetIntent(...args)


const compileAssetRefinement: typeof import("../../feature-plugins/model-studio/src/main/assetRefinementCompiler").compileAssetRefinement = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileAssetRefinement(...args)


const compileAdvancedAsset: typeof import("../../feature-plugins/model-studio/src/main/advancedAssetCompiler").compileAdvancedAsset = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileAdvancedAsset(...args)
const compileAdvancedAssetVariants: typeof import("../../feature-plugins/model-studio/src/main/advancedAssetCompiler").compileAdvancedAssetVariants = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileAdvancedAssetVariants(...args)
const optimizeAdvancedProgram: typeof import("../../feature-plugins/model-studio/src/main/advancedAssetCompiler").optimizeAdvancedProgram = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').optimizeAdvancedProgram(...args)


const compileReferenceImageAsset: typeof import("../../feature-plugins/model-studio/src/main/referenceImageAssetCompiler").compileReferenceImageAsset = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileReferenceImageAsset(...args)


const reviewAssetCaptures: typeof import("../../feature-plugins/model-studio/src/main/assetVisualReview").reviewAssetCaptures = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').reviewAssetCaptures(...args)


const describeBlockbenchActions: typeof import("../../feature-plugins/model-studio/src/main/blockbenchDiff").describeBlockbenchActions = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').describeBlockbenchActions(...args)

import type { AdvancedAssetCandidate,AdvancedAssetCandidatePreview,AdvancedAssetComparison,AdvancedAssetPreviewOptions } from '../shared/advancedAsset'
import type { ImageGenerationRequest,ImageStudioBackend } from '../shared/imageStudio'
import type { HeadlessSmokeTestResult,MinecraftManagedMod,MinecraftRuntimeEvent } from '../shared/minecraft'
import type { AddonPrepareInput,GiteeBuildSettings,ReleaseSummaryDraft,TestMatrixResult,TestTarget } from '../shared/production'
import type {
AppDialogRequest,
AgentSettings,
AiAttachment,
AiAttachmentSelectionKind,
AiBackendSwitchResult,
AiCancellationResult,
AiCreateCodeOptions,
AiExecutionProfile,
AiModelInfo,
AiOutputEvent,
AiProjectTaskState,
AiRecoveryInfo,
AiSurface,
AppVersionCheckResult,
BeginnerAiPreferences,
CodingResult,
DetachedWindowTarget,
DeviceConnectionState,
DeviceUsage,
DiagnosticPageSnapshot,
ExistingProjectAdoptInput,
ExistingProjectAnalysis,
ExistingProjectInspectionProgress,
ExternalAgentConfiguration,
FileNode,
GradleInstallation,
JavaPreferences,
McpBridgeState,
ModpackMigrationCreateInput,
ModpackMigrationCreateResult,
ModpackMigrationRecord,
ModpackMigrationUndoResult,
PipelineEvent,
PreflightResult,
ProjectCreateInput,
ProjectImageAsset,
ProjectInfo,
ProjectMigrationInput,
ProjectMigrationPreview,
ProjectMigrationResult,
ProjectRenameInput,
RemoteConnectionState,
SidebarViewId,
SnapshotInfo,
SnapshotRestoreResult,
SnapshotStorageInfo
} from '../shared/types'
import { FeaturePluginService,prepareFeaturePlugin,importLocalFeaturePlugin } from './featurePluginService'
import { FeatureStoreService } from './featureStoreService'
import { inspectExternalModpack,materializeExternalModpack } from './modpackImportService'
import { addModpackModule,adoptExternalModpack,auditImportedPackArtifacts,writeModrinthPackArchive,isModpackProject,onModpackManifestChanged,readModpackManifest,readModpackImportStatus } from './modpackService'
import { configureNativeFeatureServices } from './nativeFeatureServices'
const curseForgePackResolver: typeof import("../../feature-plugins/modpack-mods/src/main/curseForgePackService").curseForgePackResolver = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-mods/main').activate>>('modpack-mods').curseForgePackResolver(...args)
const installCurseForgePack: typeof import("../../feature-plugins/modpack-mods/src/main/curseForgePackService").installCurseForgePack = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-mods/main').activate>>('modpack-mods').installCurseForgePack(...args)
const readCurseForgePackState: typeof import("../../feature-plugins/modpack-mods/src/main/curseForgePackService").readCurseForgePackState = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-mods/main').activate>>('modpack-mods').readCurseForgePackState(...args)

import { ModProviderRegistry } from './modProviderService'
const applyModpackPlan: typeof import("../../feature-plugins/modpack-mods/src/main/modpackPlanner").applyModpackPlan = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-mods/main').activate>>('modpack-mods').applyModpackPlan(...args)
const planModpack: typeof import("../../feature-plugins/modpack-mods/src/main/modpackPlanner").planModpack = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-mods/main').activate>>('modpack-mods').planModpack(...args)

const applyKeybindPreset: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentService").applyKeybindPreset = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').applyKeybindPreset(...args)
const readKeybindState: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentService").readKeybindState = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').readKeybindState(...args)
const writeFtbQuestChapter: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentService").writeFtbQuestChapter = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').writeFtbQuestChapter(...args)
const writePatchouliBook: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentService").writePatchouliBook = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').writePatchouliBook(...args)

const listFtbQuestBackups: typeof import("../../feature-plugins/ftb-quests/src/main/ftbQuestBookService").listFtbQuestBackups = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').listFtbQuestBackups(...args)
const readFtbQuestBook: typeof import("../../feature-plugins/ftb-quests/src/main/ftbQuestBookService").readFtbQuestBook = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').readFtbQuestBook(...args)
const restoreFtbQuestBackup: typeof import("../../feature-plugins/ftb-quests/src/main/ftbQuestBookService").restoreFtbQuestBackup = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').restoreFtbQuestBackup(...args)
const saveFtbQuestBook: typeof import("../../feature-plugins/ftb-quests/src/main/ftbQuestBookService").saveFtbQuestBook = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').saveFtbQuestBook(...args)

const inspectFtbQuestIcon: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").inspectFtbQuestIcon = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').inspectFtbQuestIcon(...args)
const refreshFtbQuestResources: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").refreshFtbQuestResources = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').refreshFtbQuestResources(...args)
const resolveFtbQuestDependencyTexture: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").resolveFtbQuestDependencyTexture = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').resolveFtbQuestDependencyTexture(...args)
const resolveFtbQuestIcon: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").resolveFtbQuestIcon = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').resolveFtbQuestIcon(...args)
const resolveFtbQuestItemNames: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").resolveFtbQuestItemNames = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').resolveFtbQuestItemNames(...args)
const resolveFtbQuestShapes: typeof import("../../feature-plugins/ftb-quests/src/main/ftbquesticonservice").resolveFtbQuestShapes = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/ftb-quests/main').activate>>('ftb-quests').resolveFtbQuestShapes(...args)

const downloadModpackContent: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentInventoryService").downloadModpackContent = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').downloadModpackContent(...args)
const importModpackContent: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentInventoryService").importModpackContent = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').importModpackContent(...args)
const listModpackContent: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentInventoryService").listModpackContent = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').listModpackContent(...args)
const modpackContentProjectPath: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentInventoryService").modpackContentProjectPath = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').modpackContentProjectPath(...args)
const removeModpackContent: typeof import("../../feature-plugins/modpack-content/src/main/modpackContentInventoryService").removeModpackContent = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-content/main').activate>>('modpack-content').removeModpackContent(...args)

const SERVER_PACK_CREATOR_MIN_JAVA = 21
const buildServerPack: typeof import('../../feature-plugins/testing/src/main/serverPackService').buildServerPack = (...args) => requireTestingService().buildServerPack(...args)
import type { buildAndJoinServer,runServerScenario,ServerJoinVerificationResult } from '../../feature-plugins/testing/src/main/serverVerificationService'
const applyOptimizationProfile: typeof import("../../feature-plugins/modpack-automation/src/main/optimizationService").applyOptimizationProfile = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-automation/main').activate>>('modpack-automation').applyOptimizationProfile(...args)

import { McmodService } from './mcmodService'
const assessModpackMigration: typeof import("../../feature-plugins/modpack-migration/src/main/modpackMigrationService").assessModpackMigration = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').assessModpackMigration(...args)
const createModpackMigration: typeof import("../../feature-plugins/modpack-migration/src/main/modpackMigrationService").createModpackMigration = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').createModpackMigration(...args)
const inspectModpackMigrationJar: typeof import("../../feature-plugins/modpack-migration/src/main/modpackMigrationService").inspectModpackMigrationJar = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').inspectModpackMigrationJar(...args)

import { reviewAiAction,type AiReviewerConfig } from './aiReviewer'
import { AppChangelogService } from './appChangelogService'
import { prepareCleanReinstall, prepareOverwriteReinstall } from './appReinstall'
import { AppUpdateService,normalizeAppUpdateUrl } from './appUpdateService'
import { DiagnosticArchiveCollector,summarizeDiagnosticDirectory } from './diagnosticArchive'
import { diagnosticHandle,diagnosticIpcOperations } from './diagnosticIpc'
import { diagnosticJournal,installConsoleDiagnosticCapture,installProcessDiagnosticHandlers,redactDiagnosticText } from './diagnosticLog'
import { DiagnosticSession } from './diagnosticSession'
import { downloadActivities } from './downloadActivityService'
import { assertSeparateMigrationTrees } from './migrationPathSafety'
import { RemoteControllerAgent,type RemoteAppAction,type RemoteAppState,type RemoteProjectSummary,type RemoteQuotaConfig } from './remoteAgentController'
import { RemoteClientService,remoteEndpointFromSite,type RemoteServerCancel } from './remoteClientService'
const inspectForDecompilation: typeof import("../../feature-plugins/decompile/src/main/decompilePipeline").inspectForDecompilation = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').inspectForDecompilation(...args)
const listCachedSourceFiles: typeof import("../../feature-plugins/decompile/src/main/decompilePipeline").listCachedSourceFiles = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').listCachedSourceFiles(...args)
const readCachedSourceFile: typeof import("../../feature-plugins/decompile/src/main/decompilePipeline").readCachedSourceFile = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').readCachedSourceFile(...args)
const runDecompilation: typeof import("../../feature-plugins/decompile/src/main/decompilePipeline").runDecompilation = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').runDecompilation(...args)
const scanReferencesForJar: typeof import("../../feature-plugins/decompile/src/main/decompilePipeline").scanReferencesForJar = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').scanReferencesForJar(...args)


const restoreDecompiledPluginProject: typeof import("../../feature-plugins/decompile/src/main/decompiledPluginProject").restoreDecompiledPluginProject = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').restoreDecompiledPluginProject(...args)
const validateDecompiledProjectTarget: typeof import("../../feature-plugins/decompile/src/main/decompiledPluginProject").validateDecompiledProjectTarget = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').validateDecompiledProjectTarget(...args)

function decompileMinimumJava(): number { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').DECOMPILE_MIN_JAVA }


function decompileTermsVersion(): string { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').DECOMPILE_TERMS_VERSION }
const createModuleFromDecompiledSources: typeof import("../../feature-plugins/decompile/src/main/decompileModuleExport").createModuleFromDecompiledSources = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').createModuleFromDecompiledSources(...args)
const plannedModulePaths: typeof import("../../feature-plugins/decompile/src/main/decompileModuleExport").plannedModulePaths = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').plannedModulePaths(...args)
const renderDecompileTerms: typeof import("../../feature-plugins/decompile/src/main/decompileModuleExport").renderDecompileTerms = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').renderDecompileTerms(...args)
const seedProjectFromDecompiledSources: typeof import("../../feature-plugins/decompile/src/main/decompileModuleExport").seedProjectFromDecompiledSources = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').seedProjectFromDecompiledSources(...args)


const readDecompileCacheEntry: typeof import("../../feature-plugins/decompile/src/main/decompileCache").readDecompileCacheEntry = (...args) => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').readDecompileCacheEntry(...args)

import type { DecompileProvenance } from '../shared/decompile'

if (process.argv.includes('--macos-smoke-check') && process.env.MODMIND_SMOKE_ROOT && path.isAbsolute(process.env.MODMIND_SMOKE_ROOT)) {
  app.setPath('userData', path.join(process.env.MODMIND_SMOKE_ROOT, 'userData'))
}

const diagnosticRecoveryTarget = process.argv.find(argument => argument.startsWith('--export-diagnostics='))?.slice('--export-diagnostics='.length)
const diagnosticAttachments = new DiagnosticAttachments()
configureAgentProtection([
  app.getAppPath(), app.getPath('userData'), app.getPath('logs'),
  ...(app.isPackaged ? [path.dirname(process.execPath), process.resourcesPath] : []),
  ...(app.isPackaged && process.platform === 'darwin' ? [path.resolve(process.execPath, '../../..')] : []),
  ...[process.env.APPDATA, process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    .flatMap(root => [path.join(root, 'ModMind'), path.join(root, 'modmind-updater')])
])

function sendDecompileEvent(signal: AbortSignal | undefined, event: { jarSha256: string; phase: string; message: string; ratio?: number }): void {
  if (signal?.aborted) return
  mainWindow?.webContents.send('decompile:event', event)
}
async function readDecompileProvenanceForExport(decompileCacheRoot: string, sourceSha256: string): Promise<DecompileProvenance> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile').readDecompileProvenanceForExport(decompileCacheRoot, sourceSha256) }


const aiRuntimeActivityContext = new AsyncLocalStorage<(event: MinecraftRuntimeEvent) => void>()
const workbenchApprovals = new WorkbenchApprovals(owner => {
  const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.id === owner)
  if (window && !window.webContents.isDestroyed()) window.webContents.send('ai:approvalsChanged')
})
const questionOwners = new Set<number>()
const workbenchQuestions = new WorkbenchQuestions(owner => {
  const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.id === owner)
  if (window && !window.webContents.isDestroyed()) window.webContents.send('ai:questionsChanged')
})

let mainWindow: BrowserWindow | null = null
type PendingAppDialog = {
  window: BrowserWindow
  resolve: (confirmed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingAppDialogs = new Map<string, PendingAppDialog>()

function requestRendererDialog(request: Omit<AppDialogRequest, 'id'>): Promise<boolean> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(false)
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingAppDialogs.get(id)
      if (!pending) return
      pendingAppDialogs.delete(id)
      resolve(false)
    }, 120_000)
    pendingAppDialogs.set(id, { window, resolve, timer })
    try {
      window.webContents.send('app:dialogRequested', { id, ...request } satisfies AppDialogRequest)
    } catch {
      pendingAppDialogs.delete(id)
      clearTimeout(timer)
      resolve(false)
    }
  })
}

function resolveRendererDialog(sender: Electron.WebContents, requestId: unknown, confirmed: unknown): void {
  if (typeof requestId !== 'string' || requestId.length > 100 || typeof confirmed !== 'boolean') return
  const pending = pendingAppDialogs.get(requestId)
  if (!pending || pending.window.isDestroyed() || pending.window.webContents !== sender) return
  pendingAppDialogs.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve(confirmed)
}

function cancelRendererDialogsForWindow(window: BrowserWindow): void {
  for (const [id, pending] of pendingAppDialogs) {
    if (pending.window !== window) continue
    pendingAppDialogs.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(false)
  }
}

let resizeObserverDiagnosticAt = 0
let suppressedResizeObserverDiagnostics = 0
let tray: Tray | null = null
let allowWindowClose = false
let quitRequested = false
let closeRequestInFlight = false
let resolveCloseChoice: ((choice: { behavior: 'tray' | 'quit' | 'cancel'; remember: boolean }) => void) | null = null
let appUpdateService: AppUpdateService | null = null
let appChangelogService: AppChangelogService | null = null
let currentProject: ProjectInfo | null = null
const aiProjectContext = new AsyncLocalStorage<ProjectInfo>()
const detachedWindows = new Map<DetachedWindowTarget, BrowserWindow>()
const pluginOverlayWindows = new Map<string, BrowserWindow>()
const hiddenPluginOverlays = new Set<string>()
const pluginChatBridge = new PluginChatBridge(() => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null
  return { id: mainWindow.webContents.id, send: (request) => mainWindow!.webContents.send('plugins:workbenchRequest', request) }
})

diagnosticJournal.configure(app.getPath('logs'), () => {
  const project = aiProjectContext.getStore() ?? currentProject
  return project ? { path: project.path, name: project.name, namespace: project.namespace, kind: project.kind ?? 'mod', loader: project.loader, minecraftVersion: project.minecraftVersion } : undefined
}, !diagnosticRecoveryTarget)
installNetworkDiagnostics()
const userSkillStore = new UserSkillStore(path.join(app.getPath('userData'), 'workbench-skills'))
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
const conversationStore = new ConversationStore(workbenchDataStore)
let inspirationKnowledgeStore: InspirationKnowledgeStore | undefined
function projectKnowledgeStore(): InspirationKnowledgeStore {
  return inspirationKnowledgeStore ??= new InspirationKnowledgeStore(path.join(app.getPath('userData'), 'inspiration-knowledge'), (projectPath, notes) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('inspiration:knowledgeChanged', { projectPath, notes })
    }
  })
}
let inspirationWorkflowStore: InspirationWorkflowStore | undefined
function projectInspirationWorkflowStore(): InspirationWorkflowStore {
  return inspirationWorkflowStore ??= new InspirationWorkflowStore(path.join(app.getPath('userData'), 'inspiration-workflows'), projectKnowledgeStore())
}

installProcessDiagnosticHandlers()
const sidebarViewIds = new Set<SidebarViewId>([
  'workspace', 'modpack-server', 'inspiration', 'minecraft', 'code', 'build', 'settings', 'plugins', 'features'
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
    throw new Error(detail || 'Minecraft 操作未完成', { cause: error })
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


let forwardMinecraftEventsToServerPanel = false
let loaderCatalog: LoaderCatalog | null = null
let giteeBuildService: GiteeBuildService | null = null
let featurePluginService: FeaturePluginService
let featureDevelopmentLoader: FeatureDevelopmentLoader | undefined
let featureStoreService: FeatureStoreService
let remoteClient: RemoteClientService | null = null
let contributionService: ContributionService | undefined
let remoteDeviceId: string | null = null
let modProviderRegistry: ModProviderRegistry | null = null
const mcmodService = new McmodService()
let publicMcpBridge: ModMindBridge | null = null
let publicMcpBridgeProjectPath = ''
let publicMcpBridgeProjectName = ''
let publicMcpBridgeConfigPath = ''
let publicMcpBridgeStartedAt: string | null = null
let publicMcpBridgeAbort: AbortController | null = null
// 用户在设置页开启「MCP 接入」后缓存到内存；项目打开/切换时据此自动跟随启动桥接。
let mcpBridgePreferenceEnabled = false
const chatCompletionsAdapter = new ChatCompletionsAdapter()
let publicMcpIntent: 'engineering' | 'informational' = 'informational'
let curseForgeProviderKey = process.env.MODMIND_CURSEFORGE_API_KEY ?? '$2a$10$BB17.sSejQebcTN01XAqmeXbucdfzq/nIKXylaKLpQHtHLrREVPku'
const hasSingleInstanceLock = !diagnosticRecoveryTarget && app.requestSingleInstanceLock()
const diagnosticSession = hasSingleInstanceLock ? new DiagnosticSession(app.getPath('logs'), diagnosticJournal) : undefined
if (hasSingleInstanceLock) {
  try {
    crashReporter.start({ uploadToServer: false, compress: true, extra: { modmind_version: app.getVersion() } })
    diagnosticJournal.recordCritical({ subsystem: 'process', operation: 'crash-reporter', phase: 'ready', message: 'Local native crash collection enabled; automatic upload disabled', data: { directory: app.getPath('crashDumps') } })
  } catch (error) { diagnosticJournal.recordCritical({ subsystem: 'process', operation: 'crash-reporter', phase: 'error', message: 'Local native crash collection unavailable', error }) }
}
diagnosticSession?.startHeartbeat()
app.on('quit', (_event, exitCode) => {
  if (exitCode === 0 && shutdownComplete) diagnosticSession?.finish()
})
app.on('child-process-gone', (_event, details) => {
  diagnosticJournal.recordCritical({ subsystem: 'process', operation: 'child-process-gone', phase: 'gone',
    level: details.reason === 'clean-exit' ? 'info' : 'error', message: `${details.type} process exited: ${details.reason}`, data: details })
})
// modmind-plugin:// scheme 特权必须在 app.ready 前注册
registerPluginProtocolSchemeEarly()
const pendingDeviceDeepLinks = new DeviceDeepLinkQueue(handleDeviceDeepLink)
let shutdownPromise: Promise<void> | null = null
let shutdownComplete = false
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
  aiRuntimeActivityContext.getStore()?.(event)
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
  optionalTestingService()?.localServerManager?.recordOperation(event.message, event.level)
  const fraction = event.total && event.total > 0 && event.progress !== undefined ? event.progress / event.total : undefined
  optionalTestingService()?.localServerManager?.setOperationProgress({ message: event.message, fraction, downloaded: event.progress, total: event.total })
}

function requireModProviderRegistry(): ModProviderRegistry {
  if (!modProviderRegistry) modProviderRegistry = new ModProviderRegistry({ curseForgeApiKey: curseForgeProviderKey })
  return modProviderRegistry
}

if (!hasSingleInstanceLock && !diagnosticRecoveryTarget) app.quit()
else if (!diagnosticRecoveryTarget && !app.getVersion().endsWith('-plugintest')) {
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient('mcdev', process.execPath, [path.resolve(process.argv[1])])
  else app.setAsDefaultProtocolClient('mcdev')
}

const initialDeviceDeepLinkIndex = process.argv.findIndex((argument) => argument.startsWith('mcdev://'))
if (initialDeviceDeepLinkIndex >= 0) {
  pendingDeviceDeepLinks.enqueue(process.argv[initialDeviceDeepLinkIndex])
  process.argv[initialDeviceDeepLinkIndex] = '[device-link-consumed]'
}

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
  if (deepLink) {
    pendingDeviceDeepLinks.enqueue(deepLink)
    argv[argv.indexOf(deepLink)] = '[device-link-consumed]'
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  pendingDeviceDeepLinks.enqueue(url)
})

app.on('before-quit', (event) => {
  if (shutdownComplete || !app.isReady()) return
  event.preventDefault()
  void shutdownApplication()
})

function shutdownApplication(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  quitRequested = true
  allowWindowClose = true
  closeRequestInFlight = false
  resolveCloseChoice?.({ behavior: 'cancel', remember: false })
  resolveCloseChoice = null
  beginProcessShutdown()
  verifiedDownload.beginShutdown()
  const contributionShutdown = contributionService?.shutdown().catch(() => undefined)
  deviceAuthorizationController?.abort()
  for (const controller of aiAbortControllers.values()) controller.abort()
  featureStoreService?.shutdown()
  featureDevelopmentLoader?.stop()
  for (const active of activeAiBackendSwitches.values()) active.controller.abort()
  const timeout = setTimeout(() => {
    diagnosticJournal.recordCritical({ subsystem: 'app', operation: 'shutdown', phase: 'timeout', message: 'Shutdown exceeded 20 seconds' })
    app.exit(1)
  }, 20_000)
  shutdownPromise = (async () => {
    diagnosticJournal.recordCritical({ subsystem: 'app', operation: 'shutdown', phase: 'start', message: 'Stopping tasks and process trees' })
    await optionalTestingService()?.playerTestService?.stop().catch(error => console.warn('测试会话停止失败', error))
    await optionalTestingService()?.localTestService?.stop().catch(error => console.warn('本机测试停止失败', error))
    await optionalTestingService()?.localServerManager?.stop().catch(error => diagnosticJournal.recordCritical({ subsystem: 'local-server', operation: 'shutdown', phase: 'error', message: '服务端正常停止失败', error }))
    const results = await Promise.allSettled([
      contributionShutdown,
      Promise.resolve().then(() => shutdownPlugins()),
      Promise.resolve().then(() => featurePluginService?.shutdown()),
      Promise.resolve().then(() => chatCompletionsAdapter.close()),
      stopRemoteClient(), stopPublicMcpBridge(),
      optionalTestingService()?.playerTestService?.stop(), optionalTestingService()?.headlessMcService?.stop(), optionalTestingService()?.localServerManager?.stop(), optionalTestingService()?.minecraftRuntime?.stop(),
      shutdownProcessTrees(), verifiedDownload.shutdown(), conversationStore.flush()
    ])
    for (const result of results) if (result.status === 'rejected') diagnosticJournal.recordCritical({ subsystem: 'app', operation: 'shutdown', phase: 'error', message: 'A shutdown operation failed', error: result.reason })
    await shutdownNetwork()
    disposeBlockbenchBridge()
    tray?.destroy()
    tray = null
    await diagnosticJournal.flush()
    shutdownComplete = true
    clearTimeout(timeout)
    app.quit()
  })()
  return shutdownPromise
}

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

async function attachmentProject(requestedProjectPath?: string): Promise<ProjectInfo> {
  const project = requestedProjectPath?.trim() ? await readProjectInfo(path.resolve(requestedProjectPath)) : requireProject()
  if (!project) throw new Error('附件所属项目不存在或不是有效 ModMind 项目')
  return project
}

async function pickAiAttachments(kind: AiAttachmentSelectionKind, requestedProjectPath?: string): Promise<AiAttachment[]> {
  const project = await attachmentProject(requestedProjectPath)
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: kind === 'directory' ? '选择发送给 AI 的文件夹' : '选择发送给 AI 的文件或图片',
    properties: kind === 'directory' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  })
  if (result.canceled || !result.filePaths.length) return []
  const copied = await importAiAttachmentSources(project.path, result.filePaths.map((source) => ({ path: source })))
  return validateAiAttachments(copied, project.path)
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
    let diagnosticSummary: string | undefined
    if (stat.isFile() && stat.size <= 16 * 1024 * 1024 && /\.(?:log|txt)$/i.test(attachment.name)) {
      const text = await fs.readFile(canonicalPath, 'utf8')
      if (summarizeLog(text).diagnostic) diagnosticSummary = (await new CreationFeedbackService(project).evidence(text, 'user-attachment')).prompt
    }
    seen.add(absolutePath.toLowerCase())
    validated.push({
      id: attachment.id.slice(0, 256),
      name: attachment.name.slice(0, 1_024),
      path: path.relative(project.path, absolutePath).replaceAll('\\', '/'),
      size: stat.isDirectory() ? await attachmentDirectorySize(absolutePath) : stat.size,
      isImage: stat.isFile() && isImageAttachment(attachment.name),
      ...(diagnosticSummary ? { diagnosticSummary } : {}),
      ...(stat.isDirectory() ? { isDirectory: true } : {})
    })
  }
  return validated
}
function requireMappings(): MappingService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/mappings/main').activate>>('mappings').requireMappings() }


function requireLoaderCatalog(): LoaderCatalog {
  if (!loaderCatalog) loaderCatalog = new LoaderCatalog(path.join(app.getPath('userData'), 'loader-catalog.json'), app.getVersion())
  return loaderCatalog
}
function requireDependencyService(): DependencyService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').requireDependencyService() }

function createAddonRelationshipService(getProject: () => ProjectInfo, runtimeIntegration = true): AddonRelationshipService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').createAddonRelationshipService(getProject, runtimeIntegration) }

function requireAddonRelationshipService(): AddonRelationshipService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').requireAddonRelationshipService() }
async function buildLinkedProjectTree(project: ProjectInfo, signal: AbortSignal | undefined, stack: string[]): Promise<string> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').buildLinkedProjectTree(project, signal, stack) }

function requireGitService(): GitService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/versions/main').activate>>('versions').requireGitService() }

function requireContentService(): ContentService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/publishing/main').activate>>('publishing').requireContentService() }


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
function requireReleaseService(): ReleaseService { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/publishing/main').activate>>('publishing').requireReleaseService() }


function requireGiteeBuildService(): GiteeBuildService {
  if (!giteeBuildService) giteeBuildService = new GiteeBuildService({ getProject: requireProject, readSettings: readGiteeBuildSettings })
  return giteeBuildService
}

interface StoredDeviceCredentials {
  version: 1 | 2
  siteUrl: string
  baseUrl: string
  encryptedApiKey: string
  username: string
  balanceCents: string
  connectedAt: string
  usage?: DeviceUsage
  provider?: 'custom'
  providerId?: string
  account?: string
  group?: string | null
  node?: string
  model?: string
  imageApi?: { baseUrl: string; model: string; encryptedApiKey: string } | null
  encryptedConnections?: string
  refreshBeforeSelection?: boolean
}

interface DeviceCredentials extends Omit<StoredDeviceCredentials, 'encryptedApiKey'> {
  apiKey: string
  sync?: ProviderSnapshot
  localImageApi?: { baseUrl: string; apiKey: string; model: string } | null
}
function isFreeDeviceAccount(credentials: DeviceCredentials): boolean {
  if (credentials.sync) return credentials.sync.connections.find(c => c.account === (credentials.sync!.defaults?.account ?? credentials.sync!.defaultAccount))?.kind === 'free'
  return credentials.account?.startsWith('trial:') === true || new URL(credentials.baseUrl).pathname.replace(/\/$/, '') === '/api/trial/v1'
}

let deviceAuthorizationController: AbortController | null = null
const quotaConfiguration = new LiveConfiguration()
const deviceStateWrites = new SerialState()
const preferenceWrites = deviceStateWrites
let transientDeviceState: DeviceConnectionState | null = null
const QUOTA_USAGE_MAX_AGE_MS = 2 * 60_000
const QUOTA_MODEL_MAX_AGE_MS = 5 * 60_000
const quotaModelAvailabilityCache = new Map<string, { checkedAt: number; models: AiModelInfo[] }>()
const scannedModelCapabilities = new Map<string, { checkedAt: number; models: AiModelInfo[] }>()
let quotaModelRouter: QuotaModelRouting | undefined
let quotaModelSwitchInProgress = false
let providerSyncService: ProviderSyncService | undefined
let providerCatalogRevision = 0
let legacyProviderUpgrade: { owner: string; at: number; task: Promise<void> } | undefined
function providerSync(): ProviderSyncService {
  return providerSyncService ??= new ProviderSyncService({
    authorizationBusy: () => Boolean(deviceAuthorizationController),
    read: async () => { const c = await readDeviceCredentials(); return c?.sync ? { siteUrl: c.siteUrl, username: c.username, sync: c.sync, authorizationKey: c.apiKey, refreshBeforeSelection: c.refreshBeforeSelection } : null },
    write: (previous, next) => deviceStateWrites.run(async () => {
      const c = await readDeviceCredentials()
      if (!c?.sync || providerOwnerKey(c) !== providerOwnerKey(previous) || JSON.stringify(c.sync) !== JSON.stringify(previous.sync)) throw new Error('账号或连接已更新，请重试')
      const current = next.connections.find(x => x.account === next.defaultAccount)!
      const saved = await writeDeviceCredentialsUnlocked({ ...c, sync: next, refreshBeforeSelection: undefined, account: current.account, group: current.group, node: current.node ?? undefined, baseUrl: current.inferenceBaseUrl, apiKey: current.apiKey })
      quotaModelAvailabilityCache.clear(); scannedModelCapabilities.clear()
      if (c.sync.selectionRevision !== next.selectionRevision || c.sync.defaultAccount !== next.defaultAccount || JSON.stringify(c.sync.connections) !== JSON.stringify(next.connections)) emitProviderConnectionsChanged(saved)
      for (const surface of ['workspace', 'inspiration'] as const) {
        const before = c.sync.bindings?.[surface], selection = next.bindings?.[surface]
        if (before && selection && JSON.stringify(before) !== JSON.stringify(selection)) emitAiSelection(surface, selection)
      }
    }),
    readSession: () => quotaSessionStore().read(), writeSession: s => deviceStateWrites.run(async () => {
      const c = await readDeviceCredentials(); if (!c?.sync || providerOwnerKey(c) !== s.owner) throw new Error('账号已切换')
      await quotaSessionStore().write(s)
    }),
    readDiscovery: async () => {
      if (!safeStorage.isEncryptionAvailable()) return null
      try {
        const target = path.join(app.getPath('userData'), 'provider-model-discovery.enc')
        if ((await fs.stat(target)).size > 24 * 1024 * 1024) return null
        return JSON.parse(safeStorage.decryptString(Buffer.from(await fs.readFile(target, 'utf8'), 'base64'))) as ProviderModelDiscovery
      } catch { return null }
    },
    writeDiscovery: discovery => deviceStateWrites.run(async () => {
      const c = await readDeviceCredentials()
      if (!c?.sync || providerOwnerKey(c) !== discovery.owner) throw new Error('账号已切换，请重新读取模型')
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用')
      const text = JSON.stringify(discovery)
      if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('模型目录过大，请减少已连接供应商后重试')
      const target = path.join(app.getPath('userData'), 'provider-model-discovery.enc')
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, safeStorage.encryptString(text).toString('base64'), { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporary, target)
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    }),
    readPreferences: readBeginnerAiPreferences,
    applyDefaults: async (selection, previous) => {
      const c = await readDeviceCredentials(); if (!c?.sync) throw new Error('账号已切换')
      return preferenceWrites.run(async () => {
        if (!sameDeviceCredentials(await readDeviceCredentials(), c) || providerOwnerKey(c) !== providerOwnerKey(previous) || JSON.stringify(c.sync) !== JSON.stringify(previous.sync)) throw new Error('账号已切换')
        const store = await readStoredBeginnerAiPreferences()
        const preferences = normalizeQuotaModelPreferences({ ...activeQuotaModelPreferences(store, deviceProfileKey(c)), ...selection }, DEFAULT_BEGINNER_AI_PREFERENCES)
        return preferences
      })
    },
    paidBusy: account => [...activeAiRuns.values()].some(run => run.backend === 'quota' && (!run.quotaAccount || run.quotaAccount === account))
  })
}
function quotaSessionStore(): QuotaRoutingSessionStore {
  return new QuotaRoutingSessionStore(path.join(app.getPath('userData'), 'quota-routing-session.enc'), text => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用')
    return safeStorage.encryptString(text)
  }, bytes => safeStorage.decryptString(bytes))
}
function emitAiPreferences(preferences: BeginnerAiPreferences): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('device:aiPreferences', preferences)
  for (const window of BrowserWindow.getAllWindows()) if (window !== mainWindow && !window.isDestroyed()) window.webContents.send('device:aiPreferences', preferences)
}
function emitAiSelection(surface: 'workspace' | 'inspiration', selection?: AiModelSelection): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('device:aiSelection', { surface, ...(selection ? { selection } : {}) })
}
function emitProviderConnectionsChanged(credentials: DeviceCredentials): void {
  providerCatalogRevision++
  if (deviceAuthorizationController) return
  transientDeviceState = null
  // Existing renderer state listeners reload their catalogs without resetting
  // saved defaults or per-surface selections.
  emitDeviceState(publicDeviceState(credentials))
}
async function upgradeQuotaConnections(previous: RoutingCredentials, token: string): Promise<boolean> {
  const before = await readDeviceCredentials()
  const unchanged = (current: DeviceCredentials | null): current is DeviceCredentials => Boolean(current && !current.provider && !current.sync &&
    current.siteUrl === previous.siteUrl && current.username === previous.username && current.apiKey === previous.apiKey &&
    current.baseUrl === previous.baseUrl && current.account === previous.account && current.group === previous.group)
  if (!unchanged(before)) throw new Error('账号或连接已更新，请重试')
  const response = await fetch(`${previous.siteUrl}/api/device/providers?credentials=1`, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { ...PROVIDER_SYNC_CAPABILITY_HEADERS, Authorization: `Bearer ${token}` } })
  if (response.status === 404) return false
  if (!response.ok) throw new Error('无法刷新供应商连接，请稍后重试')
  const envelope = await response.json() as { success?: unknown; data?: unknown }
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new Error('供应商连接响应无效')
  const data = envelope.data as Record<string, unknown>
  if (data.protocolVersion !== 2) return false
  const snapshot = parseProviderSnapshot(data)
  const defaults = snapshot.connections.find(c => c.account === snapshot.defaultAccount)!
  const preferences = await readBeginnerAiPreferences()
  const original = snapshot.connections.find(c => c.apiKey === previous.apiKey && (c.inferenceBaseUrl === previous.baseUrl || c.baseUrl === previous.baseUrl))
  const account = preferences.account ?? previous.account ?? original?.account
  if (!account) throw new Error('无法确认原来的供应商，请重新同步并明确选择模型')
  const billing = preferences.billing ?? (account.startsWith('trial:') ? 'free' : 'quota')
  const group = preferences.group ?? (previous.account === undefined || account === previous.account ? previous.group : undefined)
  const selection: AiModelSelection = { model: preferences.model, account, billing, ...(billing === 'quota' && group ? { group } : {}), reasoningLevel: preferences.reasoningLevel }
  const current = await readDeviceCredentials()
  if (!unchanged(current)) throw new Error('账号或连接已更新，请重试')
  const saved = await writeDeviceCredentialsUnlocked({ ...current, sync: { ...snapshot, defaults: selection }, account: defaults.account, group: defaults.group, node: defaults.node ?? undefined, baseUrl: defaults.inferenceBaseUrl, apiKey: defaults.apiKey })
  providerSyncService?.invalidate(); quotaModelAvailabilityCache.clear(); scannedModelCapabilities.clear()
  emitProviderConnectionsChanged(saved)
  return true
}
function quotaRouter(): QuotaModelRouting {
  if (quotaModelRouter) return quotaModelRouter
  const sessions = new QuotaRoutingSessionStore(path.join(app.getPath('userData'), 'quota-routing-session.enc'), text => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用')
    return safeStorage.encryptString(text)
  }, bytes => safeStorage.decryptString(bytes))
  return quotaModelRouter = new QuotaModelRouting({
    readCredentials: readDeviceCredentials,
    writeCredentials: async next => {
      const current = await readDeviceCredentials()
      if (!current || current.username !== next.username || current.siteUrl !== next.siteUrl || current.provider === 'custom') throw new Error('账号已变更，请重新选择模型')
      await writeDeviceCredentialsUnlocked({ ...next, connectedAt: current.connectedAt })
      quotaModelAvailabilityCache.clear()
      scannedModelCapabilities.clear()
    },
    readSession: () => sessions.read(), writeSession: value => sessions.write(value), clearSession: () => sessions.clear(),
    upgradeConnections: (credentials, session) => upgradeQuotaConnections(credentials, session.token),
    listModels: credentials => quotaModelsForCredentials({ ...credentials, version: 1, connectedAt: '' }, true),
    readPreferences: readBeginnerAiPreferences,
    applyModel: async (model, route) => {
      const credentials = await readDeviceCredentials()
      if (!credentials) throw new Error('请先连接账号')
      const store = await readStoredBeginnerAiPreferences()
      const preferences = normalizeQuotaModelPreferences({ ...store.current, model, ...(route ? { account: route.account, group: route.group ?? undefined, billing: route.account.startsWith('trial:') ? 'free' : 'quota' } : {}),
        reasoningLevel: store.current.model === model ? store.current.reasoningLevel : 'auto' }, DEFAULT_BEGINNER_AI_PREFERENCES)
      await writeStoredBeginnerAiPreferences(updateQuotaModelPreferences(store, preferences, deviceProfileKey(credentials)))
      return preferences
    }
  })
}
async function getQuotaModelCatalog(force = false, cached = false): Promise<QuotaModelCatalog> {
  // Existing desktop sessions can read the full provider snapshot without a new login.
  // Migrate local storage once, while keeping running requests on their captured tuple.
  const previous = await readDeviceCredentials()
  if (cached) {
    if (previous?.sync) return providerSync().catalog(false, true)
    const preferences = await readBeginnerAiPreferences()
    return { models: [], currentModel: preferences.model, currentOptionKey: '', connected: Boolean(previous), canSwitch: false, stale: true, checkedAt: null, billing: previous?.provider === 'custom' ? 'custom' : 'quota', recoveryRequired: false }
  }
  if (previous && !previous.sync && previous.provider !== 'custom' && !quotaModelSwitchInProgress && ![...activeAiRuns.values()].some(run => run.backend === 'quota')) {
    const session = await quotaSessionStore().read().catch(() => null)
    const owner = providerOwnerKey(previous)
    if (session?.owner === owner && !session.pending && session.expiresAt > Date.now()) {
      if (!legacyProviderUpgrade || legacyProviderUpgrade.owner !== owner || Date.now() - legacyProviderUpgrade.at >= 60_000) {
        const task = deviceStateWrites.run(async () => {
          const current = await readDeviceCredentials()
          if (!current || !sameDeviceCredentials(current, previous) || current.sync || quotaModelSwitchInProgress || [...activeAiRuns.values()].some(run => run.backend === 'quota')) return
          const latestSession = await quotaSessionStore().read()
          if (latestSession?.owner !== owner || latestSession.token !== session.token || latestSession.pending) return
          await upgradeQuotaConnections(previous, session.token)
        }).catch(() => undefined)
        legacyProviderUpgrade = { owner, at: Date.now(), task }
      }
      await legacyProviderUpgrade.task
    }
  }
  if ((await readDeviceCredentials())?.sync) {
    return providerSync().catalog(force)
  }
  const catalog = await quotaRouter().catalog(force)
  const running = [...activeAiRuns.values()].some(run => run.backend === 'quota')
  return { ...catalog, canSwitch: catalog.canSwitch && !running && !quotaModelSwitchInProgress,
    ...(running && !catalog.message ? { message: 'AI 任务正在运行，完成后即可切换模型' } : {}) }
}
async function discoverQuotaModels(): Promise<QuotaModelCatalog> {
  // Legacy connections may be upgraded by a read; all model directories come from the website cache.
  await getQuotaModelCatalog()
  const credentials = await readDeviceCredentials()
  if (!credentials?.sync) throw new Error('请先重新同步供应商连接，再读取全部线路模型')
  try { return await providerSync().discoverModels() }
  finally { await updateDeviceState(null) }
}

async function selectQuotaModel(model: unknown, selection?: unknown): Promise<QuotaModelSwitchResult> {
  if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('请选择有效的工作台模型')
  const version = validateQuotaModelSelection(selection)
  if ((await readDeviceCredentials())?.sync) {
    if (deviceAuthorizationController) throw new Error('账号正在授权，请完成后再选择模型')
    let result: QuotaModelSwitchResult
    try { result = await providerSync().select(model.trim(), version) }
    catch (error) {
      await updateDeviceState(null).catch(() => undefined)
      throw error
    }
    if (result.preferences) emitAiPreferences(result.preferences)
    else if (result.selection && (version.scope === 'workspace' || version.scope === 'inspiration')) {
      for (const [surface, selection] of Object.entries({ ...result.linkedSelections, [version.scope]: result.selection })) {
        emitAiSelection(surface as 'workspace' | 'inspiration', selection)
      }
    }
    await updateDeviceState(null)
    return result
  }
  if (quotaModelSwitchInProgress) throw new Error('正在切换模型，请稍候')
  if (deviceAuthorizationController) throw new Error('账号正在授权，请完成后再切换模型')
  if ([...activeAiRuns.values()].some(run => run.backend === 'quota')) throw new Error('AI 任务正在运行，请在任务完成后切换模型')
  quotaModelSwitchInProgress = true
  const revision = quotaConfiguration.begin()
  let result: QuotaModelSwitchResult
  try { result = await deviceStateWrites.run(() => quotaRouter().select(model.trim(), version)) }
  finally { quotaModelSwitchInProgress = false; quotaConfiguration.finish(revision) }
  if (result.requiresProviderSync) {
    const catalog = await getQuotaModelCatalog()
    const requested = catalog.models.find(m => m.id === model.trim() && m.billing === (version.billing ?? 'quota') && (!version.account || m.account === version.account) && (version.group === undefined || m.group === version.group))
    if (requested) return selectQuotaModel(model, { ...version, account: requested.account })
    result = { status: 'error', message: '这个供应商尚未同步，请在官网勾选后同步连接', requiresProviderSync: true, catalog }
    emitAiPreferences(await readBeginnerAiPreferences())
  }
  await updateDeviceState(null)
  if (remoteClient?.getState().enabled === true) {
    await stopRemoteClient().catch(() => undefined)
    void startRemoteClientIfPossible().catch(() => undefined)
  }
  return result
}
async function ensureQuotaRoutingReady(): Promise<void> {
  if ((await readDeviceCredentials())?.sync) return
  await quotaConfiguration.acquire(AbortSignal.timeout(30_000))
  if (!await quotaRouter().recoveryRequired()) return
  const revision = quotaConfiguration.begin()
  try { await deviceStateWrites.run(() => quotaRouter().resume()) }
  finally { quotaConfiguration.finish(revision) }
}
function modelReasoningFor(baseUrl: string, apiKey: string, model: string) {
  return scannedModelCapabilities.get(quotaPreferenceKey(baseUrl, apiKey))?.models.find(entry => entry.id === model)?.reasoning
    ?? modelReasoningCatalog.resolve(model, baseUrl)
}

async function refreshConfiguredReasoning(kind: ExternalAgentKind, configuration: ExternalAgentConfiguration): Promise<void> {
  void kind
  if (!configuration.baseUrl?.trim() || !configuration.apiKey?.trim()) return
  const baseUrl = normalizeApiBaseUrl(configuration.baseUrl), apiKey = configuration.apiKey.trim()
  const key = quotaPreferenceKey(baseUrl, apiKey)
  const cached = scannedModelCapabilities.get(key)
  if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return
  await modelReasoningCatalog.refresh()
  try {
    await fetchAvailableModels(baseUrl, apiKey, '无法读取模型能力')
  } catch { /* Relays without model-list support still use exact public metadata. */ }
}

function quotaModelCacheKey(credentials: Pick<DeviceCredentials, 'baseUrl' | 'apiKey'>): string {
  return quotaPreferenceKey(credentials.baseUrl, credentials.apiKey)
}

function deviceProfileKey(credentials: DeviceCredentials): string {
  if (credentials.sync) return providerOwnerKey(credentials).slice(0, 24)
  return quotaProfileKey(credentials.siteUrl, credentials.username, credentials.provider === 'custom'
    ? `${openAiV1BaseUrl(credentials.baseUrl)}#${credentials.providerId}`
    : openAiV1BaseUrl(credentials.baseUrl))
}

function sameDeviceCredentials(left: DeviceCredentials | null, right: DeviceCredentials): boolean {
  return Boolean(left && left.apiKey === right.apiKey && left.baseUrl === right.baseUrl && left.siteUrl === right.siteUrl && left.username === right.username && left.provider === right.provider && left.providerId === right.providerId)
}

async function quotaModelsForCredentials(credentials: DeviceCredentials, force = false): Promise<AiModelInfo[]> {
  const revision = quotaConfiguration.current()
  const key = quotaModelCacheKey(credentials)
  const cached = quotaModelAvailabilityCache.get(key)
  if (!force && cached && Date.now() - cached.checkedAt <= QUOTA_MODEL_MAX_AGE_MS) {
    return cached.models
  }
  const models = credentials.provider === 'custom'
    ? await fetchAvailableModels(openAiV1BaseUrl(credentials.baseUrl), credentials.apiKey, '无法读取账号可用模型')
    : (await fetchDeviceModelCatalog(credentials.siteUrl, credentials.apiKey, credentials.account ?? undefined)).models
  if (revision !== quotaConfiguration.current()) throw new Error('线路已更新，请重新读取模型列表')
  quotaModelAvailabilityCache.set(key, { checkedAt: Date.now(), models })
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
    await retryTransientFileLock(() => fs.rename(temporary, target))
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

async function checkForAppUpdates(): Promise<AppVersionCheckResult> {
  if (app.getVersion().endsWith('-plugintest')) return { currentVersion: app.getVersion(), latestVersion: app.getVersion(), updateAvailable: false, currentChannel: 'beta', targetChannel: 'beta' }
  const siteUrl = configuredDeviceSiteUrl()
  if (!siteUrl) throw new Error('未配置版本检查服务，暂时无法检查更新')
  return checkAppVersion(siteUrl, app.getVersion(), AbortSignal.timeout(12_000))
}

async function readDeviceCredentials(): Promise<DeviceCredentials | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const stored = JSON.parse(await retryTransientFileLock(() => fs.readFile(deviceCredentialsFile(), 'utf8'))) as StoredDeviceCredentials
    if ((stored.version !== 1 && stored.version !== 2) || !stored.encryptedApiKey || !stored.username || !/^\d+$/.test(stored.balanceCents)) return null
    if (stored.version === 2 && (stored.provider !== 'custom' || !stored.providerId || !stored.model)) return null
    const apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim()
    if (!apiKey) return null
    const rawSync = stored.encryptedConnections ? JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedConnections, 'base64'))) : undefined
    const sync = rawSync ? { ...parseProviderSnapshot(rawSync), ...(rawSync.defaults ? { defaults: normalizeAiModelSelection(rawSync.defaults) } : {}), ...(rawSync.bindings ? { bindings: Object.fromEntries(Object.entries(rawSync.bindings).filter(([key]) => key === 'workspace' || key === 'inspiration').map(([key, value]) => [key, normalizeAiModelSelection(value)])) } : {}) } : undefined
    const localImageApi = stored.provider === 'custom' && stored.imageApi
      ? {
        baseUrl: normalizeRelayBaseUrl(stored.imageApi.baseUrl),
        model: stored.imageApi.model,
        apiKey: safeStorage.decryptString(Buffer.from(stored.imageApi.encryptedApiKey, 'base64')).trim()
      }
      : null
    if (stored.imageApi && !localImageApi?.apiKey) return null
    return {
      ...stored,
      siteUrl: normalizeSiteUrl(stored.siteUrl),
      baseUrl: normalizeRelayBaseUrl(stored.baseUrl),
      apiKey,
      ...(sync ? { sync } : {}),
      ...(stored.provider === 'custom' ? { localImageApi } : {})
    }
  } catch {
    return null
  }
}

async function writeDeviceCredentialsUnlocked(credentials: Omit<DeviceCredentials, 'version'>): Promise<DeviceCredentials> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法安全保存接入凭证')
  const normalized: DeviceCredentials = {
    ...credentials,
    version: credentials.provider === 'custom' ? 2 : 1,
    siteUrl: normalizeSiteUrl(credentials.siteUrl),
    baseUrl: normalizeRelayBaseUrl(credentials.baseUrl),
    apiKey: credentials.apiKey.trim()
  }
  if (!normalized.apiKey) throw new Error('接入凭证为空')
  const { apiKey, sync, encryptedConnections: _oldConnections, localImageApi, imageApi: _imageApi, ...metadata } = normalized
  const stored: StoredDeviceCredentials = {
    ...metadata,
    encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64'),
    ...(sync ? { encryptedConnections: safeStorage.encryptString(JSON.stringify(sync)).toString('base64') } : {}),
    ...(normalized.provider === 'custom' ? { imageApi: localImageApi ? {
      baseUrl: normalizeRelayBaseUrl(localImageApi.baseUrl),
      model: localImageApi.model,
      encryptedApiKey: safeStorage.encryptString(localImageApi.apiKey).toString('base64')
    } : null } : {})
  }
  await writeDeviceFileAtomically(stored)
  return normalized
}

async function updateCurrentDeviceUsage(credentials: DeviceCredentials, usage: DeviceUsage): Promise<DeviceCredentials | null> {
  return deviceStateWrites.run(async () => {
    const current = await readDeviceCredentials()
    return sameDeviceCredentials(current, credentials) ? writeDeviceCredentialsUnlocked({ ...current!, usage }) : null
  })
}

async function removeCurrentDeviceCredentials(credentials: DeviceCredentials): Promise<boolean> {
  return deviceStateWrites.run(async () => {
    if (quotaModelSwitchInProgress || await quotaRouter().recoveryRequired()) return false
    if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) return false
    await fs.rm(deviceCredentialsFile(), { force: true })
    await stopRemoteClient()
    return true
  })
}

function publicDeviceState(credentials: DeviceCredentials): DeviceConnectionState {
  if (credentials.provider === 'custom') return {
    status: 'connected', configured: true, siteUrl: credentials.siteUrl,
    username: credentials.username, provider: 'custom', providerId: credentials.providerId, model: credentials.model, billing: 'custom', modelCatalogRevision: providerCatalogRevision
  }
  return {
    status: 'connected',
    configured: true,
    siteUrl: credentials.siteUrl,
    username: credentials.username,
    modelCatalogRevision: providerCatalogRevision,
    account: credentials.sync?.defaults?.account ?? credentials.sync?.defaultAccount ?? credentials.account,
    billing: isFreeDeviceAccount(credentials) ? 'free' : 'quota',
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
  if (state.status === 'connected') contributionService?.setUsername(state.username)
  else if (state.status === 'disconnected') contributionService?.setUsername(undefined)
  diagnosticJournal.record({
    subsystem: 'device',
    operation: 'state',
    phase: state.status === 'error' ? 'error' : 'update',
    level: state.status === 'error' ? 'error' : 'info',
    message: state.message || `Device state: ${state.status}`,
    data: state
  })
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed() && (window === mainWindow || isDetachedWindow(window))) window.webContents.send('device:state', state)
}

async function updateDeviceState(state: DeviceConnectionState | null): Promise<DeviceConnectionState> {
  transientDeviceState = state
  const current = state ?? await readDeviceState()
  emitDeviceState(current)
  return current
}

async function waitForDevicePoll(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function waitForDeviceSyncIdle(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 600_000
  while (providerSyncService?.busy || quotaModelSwitchInProgress) {
    throwIfAborted(signal)
    if (Date.now() >= deadline) throw new Error('线路仍在更新，请完成后在官网重新同步')
    await waitForDevicePoll(100, signal)
  }
  throwIfAborted(signal)
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

function startDevicePolling(siteUrl: string, code: string, expiresIn: number, controller: AbortController, configuration?: ConfigurationRevision, customApi?: CustomApiConfig): void {
  const deadline = Date.now() + Math.min(Math.max(expiresIn, 1), 600) * 1_000
  void (async () => {
    let retryIndex = 0
    const retryDelays = [2_000, 5_000, 10_000]
    while (Date.now() < deadline && !controller.signal.aborted) {
      try {
        await waitForDevicePoll(retryDelays[Math.min(retryIndex, retryDelays.length - 1)], controller.signal)
        const result = await pollDeviceCode(siteUrl, code, controller.signal, fetch, Boolean(customApi))
        if (result.status === 'pending') {
          retryIndex = 0
          continue
        }
        if (result.status === 'expired') {
          await deviceAuthorizationFailure('授权码已过期，请重新连接账号')
          return
        }
        const v2 = 'sync' in result && result.sync
        if (!v2 && Boolean(customApi) !== ('provider' in result)) throw new Error('授权模式与同步结果不匹配')
        throwIfAborted(controller.signal)
        let initialV2Model: string | undefined
        let preserveClientCatalog = false
        let syncedCatalogChanged = false
        if (v2) {
          const previous = await readDeviceCredentials()
          if (!previous?.sync || previous.username !== result.username || previous.siteUrl !== siteUrl) {
            const c = v2.connections.find(c => c.account === v2.defaultAccount)!
            const models = c.modelsReady === false ? [] : c.models ?? (await fetchDeviceModelCatalog(siteUrl, c.apiKey, c.account).catch(() => ({ models: [] as AiModelInfo[] }))).models.map(m => m.id)
            initialV2Model = c.model ?? models[0]
          }
        }
        if (customApi) await stopRemoteClient()
        configuration ??= quotaConfiguration.begin()
        const credentials = await deviceStateWrites.run(async () => {
          throwIfAborted(controller.signal)
          const previous = await readDeviceCredentials()
          const sameOwner = previous?.siteUrl === siteUrl && previous.username === result.username
          preserveClientCatalog = Boolean(v2 && sameOwner && previous?.sync)
          if (!sameOwner) for (const run of activeAiRuns.values()) if (run.backend === 'quota') aiAbortControllers.get(run.id)?.abort()
          const synced = v2 ? sameOwner && previous?.sync
            ? reconcileProviderSync(previous.sync, result.sync!, activeQuotaModelPreferences(await readStoredBeginnerAiPreferences(), deviceProfileKey(previous)))
            : result.sync! : undefined
          syncedCatalogChanged = Boolean(synced && previous?.sync && JSON.stringify(synced.connections) !== JSON.stringify(previous.sync.connections))
          const saved = await writeDeviceCredentialsUnlocked({
            siteUrl,
            baseUrl: v2 ? result.baseUrl : customApi?.baseUrl ?? ('baseUrl' in result ? result.baseUrl : ''),
            apiKey: v2 ? result.apiKey : customApi?.apiKey ?? ('apiKey' in result ? result.apiKey : ''),
            username: result.username,
            balanceCents: 'balanceCents' in result ? result.balanceCents : '0',
            ...('account' in result ? { account: result.account, group: result.group, node: result.node } : {}),
            connectedAt: new Date().toISOString(),
            ...(preserveClientCatalog ? { refreshBeforeSelection: true } : {}),
            ...(synced ? { sync: synced } : customApi ? { provider: 'custom' as const, providerId: customApi.providerId, model: customApi.model, localImageApi: customApi.imageApi } : {})
          })
          if (synced && (!sameOwner || !previous?.sync)) {
            const c = synced.connections.find(c => c.account === synced.defaultAccount)!
            const preferences = normalizeQuotaModelPreferences({ ...DEFAULT_BEGINNER_AI_PREFERENCES, account: c.account, ...(c.kind === 'paid' && c.group ? { group: c.group } : {}), billing: c.kind === 'free' ? 'free' : 'quota', model: initialV2Model ?? c.model ?? c.models?.[0] ?? DEFAULT_DEVICE_MODEL }, DEFAULT_BEGINNER_AI_PREFERENCES)
            await writeStoredBeginnerAiPreferences(updateQuotaModelPreferences(await readStoredBeginnerAiPreferences(), preferences, deviceProfileKey(saved)))
            emitAiPreferences(preferences)
          }
          if (customApi && !v2) {
            const store = await readStoredBeginnerAiPreferences()
            await writeStoredBeginnerAiPreferences(updateQuotaModelPreferences(store, {
              ...activeQuotaModelPreferences(store, deviceProfileKey(saved)), model: customApi.model, reasoningLevel: 'auto', fastMode: false
            }, deviceProfileKey(saved)))
          }
          return saved
        })
        throwIfAborted(controller.signal)
        if (!credentials.sync) await quotaRouter().reset()
        else {
          const session = await quotaSessionStore().read().catch(() => null)
          if (session?.owner !== providerOwnerKey(credentials)) await quotaSessionStore().clear()
        }
        if (!preserveClientCatalog || syncedCatalogChanged) { providerCatalogRevision++; providerSyncService?.invalidate() }
        if (credentials.sync) {
          await providerSync().initializeSession()
        } else if (!customApi) await reconcileQuotaModelPreferences(credentials, true).catch((error) => {
          console.warn('[device] unable to reconcile model preferences after key update', error)
        })
        throwIfAborted(controller.signal)
        quotaConfiguration.finish(configuration)
        await updateDeviceState(publicDeviceState(credentials))
        // A live socket authenticated with the previous key cannot update in
        // place. Recreate it after the new credential is durably stored.
        const remoteWasEnabled = remoteClient?.getState().enabled === true || await readRemoteEnabled()
        await stopRemoteClient()
        if (remoteWasEnabled && !customApi) void startRemoteClientIfPossible().catch((error) => console.warn('[remote] unable to restart after credential sync', error))
        return
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof DeviceApiError && (error.status === 0 || error.status === 409 || error.status === 502 || error.status === 503 || error.status === 504)) {
          retryIndex += 1
          continue
        }
        await deviceAuthorizationFailure(error instanceof Error ? error.message : String(error))
        return
      }
    }
    if (!controller.signal.aborted) await deviceAuthorizationFailure('授权等待已超时，请重新连接账号')
  })().finally(() => {
    if (configuration) quotaConfiguration.finish(configuration)
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
    await waitForDeviceSyncIdle(controller.signal)
    const result = await requestDeviceCode(siteUrl, controller.signal)
    const expiresAt = new Date(Date.now() + result.expiresIn * 1_000).toISOString()
    const authorizing: DeviceConnectionState = { ...initial, expiresAt, message: '请在浏览器中登录并确认授权' }
    await updateDeviceState(authorizing)
    await shell.openExternal(result.authUrl)
    startDevicePolling(siteUrl, result.code, result.expiresIn, controller)
    return authorizing
  } catch (error) {
    if (deviceAuthorizationController === controller) deviceAuthorizationController = null
    if (controller.signal.aborted) return readDeviceState()
    const message = error instanceof Error ? error.message : String(error)
    await deviceAuthorizationFailure(message)
    throw new Error(message)
  }
}

async function beginDeviceDeepLinkAuthorization(rawUrl: string): Promise<DeviceConnectionState> {
  const expectedSite = configuredDeviceSiteUrl()
  if (!expectedSite) throw new Error('未配置正式站点地址，拒绝处理设备深链')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法处理设备深链')
  const { siteUrl, code, customApi } = parseDeviceDeepLink(rawUrl, expectedSite)
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
  try { await waitForDeviceSyncIdle(controller.signal) }
  catch (error) {
    if (deviceAuthorizationController === controller) deviceAuthorizationController = null
    throw error
  }
  startDevicePolling(siteUrl, code, 600, controller, quotaConfiguration.begin(), customApi)
  return state
}

async function handleDeviceDeepLink(rawUrl: string): Promise<void> {
  if (quitRequested) return
  showMainWindow()
  if (!mainWindow) return
  try {
    await beginDeviceDeepLinkAuthorization(rawUrl)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
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
  if (providerSyncService?.busy) throw new Error('连接正在更新，请稍候再断开账号')
  if (quotaModelSwitchInProgress) throw new Error('正在切换模型，请稍候再断开账号')
  deviceAuthorizationController?.abort()
  deviceAuthorizationController = null
  await stopRemoteClient()
  for (const run of activeAiRuns.values()) if (run.backend === 'quota') aiAbortControllers.get(run.id)?.abort()
  const previous = await readDeviceCredentials()
  if (previous?.sync) {
    const session = await quotaSessionStore().read().catch(() => null)
    if (session?.owner === providerOwnerKey(previous)) await fetch(`${previous.siteUrl}/api/device/session`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined)
  }
  await deviceStateWrites.run(() => fs.rm(deviceCredentialsFile(), { force: true }))
  await quotaRouter().reset()
  providerSyncService?.invalidate()
  const revision = quotaConfiguration.begin()
  quotaConfiguration.finish(revision)
  return updateDeviceState(disconnectedDeviceState('已从本机移除接入凭证'))
}

async function refreshDeviceUsage(options?: { force?: boolean; account?: string }): Promise<DeviceConnectionState> {
  if (quotaModelSwitchInProgress || await quotaRouter().recoveryRequired()) {
    if (options?.force === true) throw new Error('模型连接正在更新，请稍后刷新余额。')
    return readDeviceState()
  }
  const credentials = await readDeviceCredentials()
  if (!credentials) return updateDeviceState(disconnectedDeviceState('请先连接 ModMind 账号'))
  if (options?.force === true && credentials.provider !== 'custom') {
    // A free default must not hide the paid balance the user is about to use.
    const paid = credentials.sync?.connections.find(connection => connection.kind === 'paid' && (!options.account || connection.account === options.account))
    if (credentials.sync && !paid || !credentials.sync && options.account && options.account !== credentials.account) throw new Error('这条付费线路已变化，请刷新连接后再试。')
    if (!paid && isFreeDeviceAccount(credentials)) throw new Error('请先同步可用的付费线路。')
    const apiKey = paid?.apiKey ?? credentials.apiKey
    const usage = await queryDeviceUsage(credentials.siteUrl, apiKey, AbortSignal.timeout(20_000))
    const current = await readDeviceCredentials()
    if (!sameDeviceCredentials(current, credentials) || paid && !current?.sync?.connections.some(connection => connection.account === paid.account && connection.apiKey === paid.apiKey)) throw new Error('账号或连接已更新，请重新刷新余额。')
    if (apiKey === credentials.apiKey) {
      const updated = await updateCurrentDeviceUsage(credentials, usage)
      if (!updated) throw new Error('账号连接已变化，请重新刷新余额。')
      return updateDeviceState(publicDeviceState(updated))
    }
    // Keep another provider's usage out of the active provider's stored snapshot.
    return { ...publicDeviceState(current!), balanceCents: usage.balanceCents, checkedAt: usage.checkedAt }
  }
  if (credentials.provider === 'custom' || isFreeDeviceAccount(credentials)) return updateDeviceState(publicDeviceState(credentials))
  const checkedAt = credentials.usage ? Date.parse(credentials.usage.checkedAt) : Number.NaN
  if (credentials.usage && Number.isFinite(checkedAt) && Date.now() - checkedAt < QUOTA_USAGE_MAX_AGE_MS) {
    return updateDeviceState(publicDeviceState(credentials))
  }
  try {
    const usage = await queryDeviceUsage(credentials.siteUrl, credentials.apiKey, AbortSignal.timeout(20_000))
    const updated = await updateCurrentDeviceUsage(credentials, usage)
    if (!updated) return readDeviceState()
    return updateDeviceState(publicDeviceState(updated))
  } catch (error) {
    if (error instanceof DeviceApiError && error.status === 401) {
      if (credentials.sync) {
        const before = await readDeviceCredentials()
        if (!sameDeviceCredentials(before, credentials) || JSON.stringify(before?.sync) !== JSON.stringify(credentials.sync)) return readDeviceState()
        const current = await readDeviceCredentials()
        if (!current?.sync || providerOwnerKey(current) !== providerOwnerKey(credentials)) return readDeviceState()
        return updateDeviceState({ ...publicDeviceState(current), message: '用量暂不可用，已保留现有连接；请手动刷新连接' })
      }
      if (!await removeCurrentDeviceCredentials(credentials)) return readDeviceState()
      return updateDeviceState(disconnectedDeviceState('接入 Key 已失效，请重新连接账号'))
    }
    if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) return readDeviceState()
    const state = publicDeviceState(credentials)
    return updateDeviceState({ ...state, message: error instanceof Error ? error.message : String(error) })
  }
}

async function ensureQuotaAccountReady(): Promise<void> {
  await ensureQuotaRoutingReady()
  let credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号')
  if (credentials.sync) return
  if (credentials.provider === 'custom' || isFreeDeviceAccount(credentials)) return

  const usage = credentials.usage
  const checkedAt = usage ? Date.parse(usage.checkedAt) : Number.NaN
  if (!usage || !Number.isFinite(checkedAt) || Date.now() - checkedAt > QUOTA_USAGE_MAX_AGE_MS) {
    try {
      const refreshedUsage = await queryDeviceUsage(credentials.siteUrl, credentials.apiKey, AbortSignal.timeout(20_000))
      const updated = await updateCurrentDeviceUsage(credentials, refreshedUsage)
      if (!updated) return ensureQuotaAccountReady()
      credentials = updated
      await updateDeviceState(publicDeviceState(credentials))
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 401) {
        if (!await removeCurrentDeviceCredentials(credentials)) return ensureQuotaAccountReady()
        await updateDeviceState(disconnectedDeviceState('接入 Key 已失效，请重新连接账号'))
        throw new Error('接入 Key 已失效，请重新连接账号')
      }
      // Usage is informational. A failed health check must not block a free route.
    }
  }

  // Zero balance/quota and account freeze snapshots do not describe access to
  // the selected route. Let the actual model request enforce upstream policy.

  try {
    const models = await quotaModelsForCredentials(credentials)
    const preferences = await readBeginnerAiPreferences()
    if (models.length && !preferences.account && !preferences.group) await reconcileQuotaModelPreferences(credentials, false, models)
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

const snapshotMaintenanceJobs = new Map<string, Promise<void>>()
const snapshotStatusJobs = new Map<string, Promise<SnapshotStorageInfo>>()
const snapshotMaintenanceDone = new Set<string>()

function snapshotStorageKey(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function readSnapshotStorage(projectPath: string): Promise<SnapshotStorageInfo> {
  const key = snapshotStorageKey(projectPath)
  await snapshotMaintenanceJobs.get(key)?.catch(() => undefined)
  const running = snapshotStatusJobs.get(key)
  if (running) return running
  const task = snapshotStorageInfo(projectPath)
  snapshotStatusJobs.set(key, task)
  try { return await task } finally { if (snapshotStatusJobs.get(key) === task) snapshotStatusJobs.delete(key) }
}

async function publishSnapshotStorage(projectPath: string): Promise<void> {
  if (!canRefreshSnapshotStorageIncrementally(projectPath)) return
  const status = await readSnapshotStorage(projectPath)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('snapshots:storageChanged', status)
  }
}

function scheduleSnapshotStorageMaintenance(project: ProjectInfo): void {
  const key = snapshotStorageKey(project.path)
  if (snapshotMaintenanceDone.has(key) || snapshotMaintenanceJobs.has(key)) return
  const task = withProjectMutation(project.path, async () => {
    if (runsForProject(project.path).some(run => run.surface === 'workspace') || await pathExists(activeAiTaskPath(project))) return
    const result = await repairLegacySnapshotCaches(project.path)
    snapshotMaintenanceDone.add(key)
    if (snapshotMaintenanceDone.size > 32) snapshotMaintenanceDone.delete(snapshotMaintenanceDone.values().next().value!)
    if (result.repaired || result.skipped) diagnosticJournal.record({
      subsystem: 'snapshots', operation: 'legacy-cache-cleanup', phase: result.skipped ? 'warning' : 'success',
      level: result.skipped ? 'warning' : 'info', message: `旧快照缓存清理：已修复 ${result.repaired} 份，跳过 ${result.skipped} 份`
    })
  })
  snapshotMaintenanceJobs.set(key, task)
  void task.finally(() => { if (snapshotMaintenanceJobs.get(key) === task) snapshotMaintenanceJobs.delete(key) })
    .catch(error => console.warn('旧快照缓存清理失败', error))
}

function emitProjectChanged(): void {
  void featurePluginService?.projectChanged(currentProject?.path ?? null).catch(error => diagnosticJournal.record({ subsystem: 'feature-plugins', operation: 'project-change', phase: 'error', message: 'Plugin project lifecycle failed', error }))
  diagnosticJournal.record({
    subsystem: 'project',
    operation: 'changed',
    phase: currentProject ? 'opened' : 'closed',
    message: currentProject ? `Project active: ${currentProject.name}` : 'No active project',
    data: currentProject ? { kind: currentProject.kind, loader: currentProject.loader, minecraftVersion: currentProject.minecraftVersion, namespace: currentProject.namespace } : undefined
  })
  // 插件注册表随项目切换刷新（项目级插件目录变化）
  void refreshPluginRegistry().then((snapshot) => broadcastPluginSnapshot(snapshot)).catch(() => undefined)
  if (publicMcpBridge && (!currentProject || !sameProjectPath(publicMcpBridgeProjectPath, currentProject.path))) {
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
  void optionalTestingService()?.playerTestService?.projectChanged(currentProject?.path).catch(error => console.warn('测试会话清理失败', error))
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
  if (!input || typeof input.loader !== 'string') throw new Error('项目平台无效')
  const kind = input.kind ?? (isServerPluginPlatform(input.loader) ? 'server-plugin' : 'mod')
  const selectedStudio = studios().select({ ...input, kind })
  if (kind === 'modpack' && !isJavaLoader(input.loader)) throw new Error('整合包目前仅支持 Java 版 Fabric、Quilt、Forge 和 NeoForge')
  const name = validateProjectNameInput(input.name)
  const minecraftVersion = input.minecraftVersion.trim()
  const compatibility: Partial<import('../shared/types').LoaderVersionOption> = (PROJECT_PLATFORMS as readonly string[]).includes(input.loader) ? await requireLoaderCatalog().resolve(input.loader, minecraftVersion) : {}
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) throw new Error('Remote 新建项目已取消')
  const namespace = slugify(name)
  const projectPath = path.join(result.filePaths[0], namespace)
  if (await pathExists(projectPath)) throw new Error('项目目录已经存在，请修改项目名称或选择其他位置')
  const project: ProjectInfo = {
    ...input,
    kind,
    studioId: selectedStudio.definition.id,
    studioName: selectedStudio.definition.name,
    name,
    minecraftVersion,
    namespace,
    namespaceSource: 'generated',
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
    await projectKnowledgeStore().clearProject(projectPath)
    Object.assign(project, await assignDefaultProjectNamespace(project, candidate => suggestProjectNamespace(candidate)))
    await scaffoldStudioProject(project)
    await fs.mkdir(path.join(projectPath, '.modmind'), { recursive: true })
  } catch (error) {
    await fs.rm(projectPath, { recursive: true, force: true })
    throw error
  }
  currentProject = project
  await rememberRecentProject(project)
  await refreshExternalAgentContext(project, featurePluginService.enabled('image-studio')).catch(() => undefined)
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
      await refreshExternalAgentContext(currentProject, featurePluginService.enabled('image-studio')).catch(() => undefined)
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
      if (action.termsVersionAcknowledged !== decompileTermsVersion()) {
        throw new Error(`AI 声明的条款版本（${action.termsVersionAcknowledged || '空'}）与当前版本（${decompileTermsVersion()}）不一致；请让用户在反编译工作区阅读并确认最新条款`)
      }
      const controller = new AbortController()
      const javaPath = await requireMinecraftRuntime().ensureJavaRuntime(undefined, decompileMinimumJava())
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
      diagnosticJournal.record({ subsystem: 'decompile', operation: 'remote-create-module', phase: 'success', level: 'info', message: `Remote Controller 已从反编译源码创建自制模组 ${created.namespace}（来源 ${provenance.sourceFileName}，条款 v${decompileTermsVersion()}）`, data: { namespace: created.namespace, fileCount: created.fileCount } })
      return created
    }
    case 'set_workbench_agent': {
      if (activeAiRuns.size) throw new Error('存在运行中的 AI 任务，暂时不能切换 Agent')
      const saved = await saveAgentSettings(current => ({ ...current, codingBackend: action.agent }))
      return { success: true, agent: saved.codingBackend }
    }
    case 'set_workbench_model': {
      if (activeAiRuns.size) throw new Error('存在运行中的 AI 任务，暂时不能切换模型')
      const settings = await readSettings()
      if (settings.codingBackend === 'quota') {
        const result = await selectQuotaModel(action.model)
        return { success: result.status === 'ok', model: result.preferences?.model, message: result.message }
      }
      const backend = settings.codingBackend
      const saved = await saveAgentSettings(current => ({
        ...current,
        externalAgents: { ...current.externalAgents, [backend]: { ...current.externalAgents?.[backend], model: action.model } }
      }))
      return { success: true, model: saved.externalAgents?.[backend]?.model }
    }
    case 'set_app_setting': {
      const result = await applyAppSettingWrite({ key: action.key, value: action.value })
      return { success: true, key: action.key, value: result[action.key] }
    }
    case 'get_app_settings': return publicAgentSettings(await readSettings())
    case 'scan_java_homes': return scanConfiguredJavaHomes()
    case 'probe_java_home': {
      const home = action.home.trim()
      if (!home) throw new Error('probe_java_home 需要非空的 Java 路径')
      return probeJavaHomeInfo(home)
    }
  }
}

type AppSettingKey =
  | 'javaPreferences' | 'darkMode' | 'notificationsEnabled' | 'allowLongerContext'
  | 'closeBehavior' | 'gradleDownloadSource'

const APP_SETTING_KEYS: readonly AppSettingKey[] = [
  'javaPreferences', 'darkMode', 'notificationsEnabled', 'allowLongerContext',
  'closeBehavior', 'gradleDownloadSource'
]

/** Shared write path for the remote controller and the MCP app-setting tool. */
async function applyAppSettingWrite(input: Record<string, unknown>): Promise<AgentSettings> {
  const key = String(input.key ?? '') as AppSettingKey
  const value = input.value
  if (!APP_SETTING_KEYS.includes(key)) throw new Error(`不支持的应用设置键：${key || '(空)'}`)
  const next: Partial<AgentSettings> = {}
  if (key === 'javaPreferences') {
    if (typeof value !== 'object' || value === null) throw new Error('Java 偏好需要对象值')
    next.javaPreferences = normalizeJavaPreferences(value)
  } else if (key === 'darkMode' || key === 'notificationsEnabled' || key === 'allowLongerContext') {
    if (typeof value !== 'boolean') throw new Error(`应用设置 ${key} 需要布尔值`)
    next[key] = value
  } else if (key === 'closeBehavior') {
    if (value !== 'ask' && value !== 'tray' && value !== 'quit') throw new Error('关闭行为只能是 ask、tray 或 quit')
    next.closeBehavior = value
  } else {
    if (value !== 'auto' && value !== 'china' && value !== 'official') throw new Error('Gradle 下载源无效')
    next.gradleDownloadSource = value
  }
  return await saveAgentSettings(current => ({ ...current, ...next }))
}

async function remoteQuotaConfig(): Promise<RemoteQuotaConfig> {
  const config = await readBeginnerAgentServerConfig()
  return { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort }
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

const DEFAULT_BEGINNER_AI_PREFERENCES: BeginnerAiPreferences = { model: DEFAULT_DEVICE_MODEL, reasoningLevel: 'auto', fastMode: false }

async function readStoredBeginnerAiPreferences(): Promise<StoredQuotaModelPreferences> {
  const stored = await fs.readFile(beginnerAiPreferencesFile(), 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => null)
  return parseStoredQuotaModelPreferences(stored, DEFAULT_BEGINNER_AI_PREFERENCES)
}

async function writeStoredBeginnerAiPreferences(value: StoredQuotaModelPreferences): Promise<void> {
  await writeSettingsFile(beginnerAiPreferencesFile(), value)
}

async function readBeginnerAiPreferences(): Promise<BeginnerAiPreferences> {
  const store = await readStoredBeginnerAiPreferences()
  const credentials = await readDeviceCredentials()
  if (!credentials) return store.current
  if (credentials.sync) return { ...activeQuotaModelPreferences(store, deviceProfileKey(credentials)), ...credentials.sync.defaults }
  if (await quotaRouter().recoveryRequired()) return store.current
  const key = deviceProfileKey(credentials)
  const legacyKey = quotaModelCacheKey(credentials)
  const cached = quotaModelAvailabilityCache.get(legacyKey)
  const preferences = activeQuotaModelPreferences(store, store.profiles[key] ? key : legacyKey)
  if (credentials.provider === 'custom' && !store.profiles[key]) return { ...preferences, model: credentials.model! }
  if (!preferences.group && cached?.models.length && !cached.models.some(model => model.id === preferences.model)) {
    return resolveQuotaModelPreferences(store, key, cached.models).preferences
  }
  return preferences
}

async function saveBeginnerAiPreferences(value: BeginnerAiPreferences): Promise<BeginnerAiPreferences> {
  const initialRevision = await quotaConfiguration.acquire(AbortSignal.timeout(30_000))
  const model = typeof value?.model === 'string' ? value.model.trim().slice(0, 256) : ''
  if (!model) throw new Error('请选择制作使用的模型')
  const contextWindow = value.modelContextWindows?.[model]
  if (contextWindow !== undefined && !validModelContext(contextWindow)) throw new Error('上下文窗口必须是 1,024–100,000,000 之间的整数')
  const compactLimit = value.modelAutoCompactTokenLimits?.[model]
  if (compactLimit !== undefined && !validModelContext(compactLimit)) throw new Error('自动压缩阈值必须是 1,024–100,000,000 之间的整数')
  const reasoningLevel = isReasoningEffort(value.reasoningLevel) ? value.reasoningLevel : 'auto'
  const preferences = normalizeQuotaModelPreferences({ model, account: value.account, group: value.group, billing: value.billing, reasoningLevel, fastMode: Boolean(value.fastMode), modelContextWindows: value.modelContextWindows, modelAutoCompactTokenLimits: value.modelAutoCompactTokenLimits, reasoningEffortOptions: value.reasoningEffortOptions }, DEFAULT_BEGINNER_AI_PREFERENCES)
  const previous = await readBeginnerAiPreferences()
  if (initialRevision !== quotaConfiguration.current()) throw new Error('线路正在切换，请稍后重新选择模型')
  const previousWindows = previous.modelContextWindows ?? {}
  const nextWindows = preferences.modelContextWindows ?? {}
  const sameWindows = Object.keys(previousWindows).length === Object.keys(nextWindows).length
    && Object.entries(previousWindows).every(([id, window]) => nextWindows[id] === window)
  const previousCompactLimits = previous.modelAutoCompactTokenLimits ?? {}
  const nextCompactLimits = preferences.modelAutoCompactTokenLimits ?? {}
  const sameCompactLimits = Object.keys(previousCompactLimits).length === Object.keys(nextCompactLimits).length
    && Object.entries(previousCompactLimits).every(([id, limit]) => nextCompactLimits[id] === limit)
  const previousEfforts = previous.reasoningEffortOptions ?? {}
  const nextEfforts = preferences.reasoningEffortOptions ?? {}
  const sameEfforts = Object.keys(previousEfforts).length === Object.keys(nextEfforts).length
    && Object.entries(previousEfforts).every(([id, efforts]) => efforts.join(',') === nextEfforts[id]?.join(','))
  if (previous.model === preferences.model && previous.account === preferences.account && previous.group === preferences.group && previous.reasoningLevel === preferences.reasoningLevel && previous.fastMode === preferences.fastMode && sameWindows && sameCompactLimits && sameEfforts) return preferences
  const credentials = await readDeviceCredentials()
  if (credentials?.sync && (previous.model !== preferences.model || previous.account !== preferences.account || previous.group !== preferences.group)) throw new Error('请通过模型列表切换模型与供应商')
  validateCodexAutoCompactTokenLimit(model, { baseUrl: credentials ? openAiV1BaseUrl(credentials.baseUrl) : undefined, contextWindow }, compactLimit)
  if (preferences.reasoningLevel !== 'auto') {
    reasoningSelectionEffort(preferences.reasoningLevel, undefined, selectedReasoningEfforts(model, preferences.reasoningEffortOptions))
  }
  const fastConnection = credentials?.sync?.connections.find(c => c.account === preferences.account)
  if (previous.fastMode !== preferences.fastMode && (fastConnection?.account ?? credentials?.account) === 'ls') throw new Error('LS 暂不支持 Fast 模式')
  if (previous.fastMode !== preferences.fastMode && credentials?.provider !== 'custom' && !(credentials && (credentials.sync ? fastConnection?.kind === 'free' : isFreeDeviceAccount(credentials)))) {
    if (!credentials) throw new Error('请先连接 ModMind 账号，再切换 Fast 模式')
    await sendDeviceFastMode(
      credentials.siteUrl,
      fastConnection?.apiKey ?? credentials.apiKey,
      preferences.fastMode,
      AbortSignal.timeout(15_000)
    )
  }
  if (initialRevision !== quotaConfiguration.current()) throw new Error('线路正在切换，请稍后重新选择模型')
  const revision = credentials?.sync ? undefined : quotaConfiguration.begin()
  try {
    await preferenceWrites.run(async () => {
      if (revision) throwIfAborted(revision.signal)
      const current = await readDeviceCredentials()
      if (credentials && (!sameDeviceCredentials(current, credentials) || credentials.sync && JSON.stringify(current?.sync) !== JSON.stringify(credentials.sync))) throw new Error('账号或连接已更新，请重新选择模型')
      const store = await readStoredBeginnerAiPreferences()
      await writeStoredBeginnerAiPreferences(updateQuotaModelPreferences(store, preferences, credentials ? deviceProfileKey(credentials) : undefined))
      if (credentials?.sync?.defaults) await writeDeviceCredentialsUnlocked({ ...credentials, sync: { ...credentials.sync, defaults: { ...credentials.sync.defaults, reasoningLevel: preferences.reasoningLevel } } })
    })
  } finally { if (revision) quotaConfiguration.finish(revision) }
  return preferences
}

async function reconcileQuotaModelPreferences(credentials: DeviceCredentials, forceScan: boolean, scannedModels?: AiModelInfo[], expectedRevision = quotaConfiguration.current()): Promise<BeginnerAiPreferences> {
  const models = scannedModels ?? await quotaModelsForCredentials(credentials, forceScan)
  const resolved = await preferenceWrites.run(async () => {
    if (expectedRevision !== quotaConfiguration.current()) throw new Error('线路已更新，请重新读取模型列表')
    const store = await readStoredBeginnerAiPreferences()
    const key = deviceProfileKey(credentials)
    if (!store.profiles[key] && store.profiles[quotaModelCacheKey(credentials)]) store.profiles[key] = store.profiles[quotaModelCacheKey(credentials)]
    const resolved = resolveQuotaModelPreferences(store, key, models)
    if (sameDeviceCredentials(await readDeviceCredentials(), credentials) && JSON.stringify(resolved.store) !== JSON.stringify(store)) await writeStoredBeginnerAiPreferences(resolved.store)
    return resolved
  })
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

async function readBeginnerAgentServerConfig(selection?: AiModelSelection): Promise<CodexServerConfig> {
  await ensureQuotaRoutingReady()
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号')
  const allowLongerContext = (await readSettings()).allowLongerContext === true
  if (credentials.sync) {
    let resolved: Awaited<ReturnType<ProviderSyncService['resolve']>>
    try { resolved = await providerSync().resolve(selection) }
    catch (error) {
      await updateDeviceState(null).catch(() => undefined)
      throw error
    }
    const { owner, connection, model } = resolved
    const preferences = { ...await readBeginnerAiPreferences(), ...selection }
    if (connection.kind === 'paid') {
      try {
        await queryDeviceUsage(credentials.siteUrl, connection.apiKey, AbortSignal.timeout(20_000))
      } catch (error) {
        if (error instanceof DeviceApiError && error.status === 401) throw error
        // Usage availability and balances do not determine access to this model.
      }
    }
    const current = await readDeviceCredentials()
    if (!current?.sync || providerOwnerKey(current) !== providerOwnerKey(credentials)) throw new Error('账号已切换，请重新发送')
    if (JSON.stringify(current.sync.connections) !== JSON.stringify(owner.sync.connections)) return readBeginnerAgentServerConfig(selection)
    const efforts = selectedReasoningEfforts(model, preferences.reasoningEffortOptions)
    const capabilities = modelReasoningFor(connection.inferenceBaseUrl, connection.apiKey, model)
    return { baseUrl: connection.inferenceBaseUrl, apiKey: connection.apiKey, model,
      reasoningEffort: reasoningSelectionEffort(preferences.reasoningLevel, capabilities, efforts), reasoningCapabilities: codexReasoningCapabilities(capabilities, efforts),
      contextWindow: preferences.modelContextWindows?.[model], autoCompactTokenLimit: preferences.modelAutoCompactTokenLimits?.[model], allowLongerContext }
  }
  if (credentials.provider === 'custom') {
    const preferences = selection ? { ...await readBeginnerAiPreferences(), ...selection } : await readBeginnerAiPreferences()
    if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) return readBeginnerAgentServerConfig(selection)
    const model = preferences.model
    const baseUrl = openAiV1BaseUrl(credentials.baseUrl)
    const reasoningCapabilities = modelReasoningFor(baseUrl, credentials.apiKey, model)
    const efforts = selectedReasoningEfforts(model, preferences.reasoningEffortOptions)
    return {
      baseUrl, apiKey: credentials.apiKey, model,
      reasoningEffort: reasoningSelectionEffort(preferences.reasoningLevel, reasoningCapabilities, efforts),
      reasoningCapabilities: codexReasoningCapabilities(reasoningCapabilities, efforts),
      contextWindow: normalizeModelContextWindows(preferences.modelContextWindows)?.[model],
      autoCompactTokenLimit: normalizeModelAutoCompactTokenLimits(preferences.modelAutoCompactTokenLimits)?.[model],
      allowLongerContext
    }
  }
  // Upstream groups may change without rotating the key or changing the URL.
  // Execution must use a fresh catalog; a failed scan must not revive a stale model.
  const saved = await readBeginnerAiPreferences()
  const exact = selection ? { ...saved, ...selection, ...(selection.account !== undefined || selection.billing !== undefined ? { group: selection.group } : {}) } : saved
  let models: AiModelInfo[]
  if (exact.account || exact.group) {
    const catalog = await quotaRouter().catalog(true)
    if (catalog.stale || !catalog.currentRoute) throw new Error('无法确认当前线路，请刷新后重试')
    if (exact.account && exact.account !== catalog.currentRoute.account || exact.group !== undefined && exact.group !== catalog.currentRoute.group) throw new Error('所选分组已变化，请重新选择线路；消息已保留')
    models = catalog.models.filter(model => model.routeCurrent && model.modelEvidence === 'verified')
  } else models = await quotaModelsForCredentials(credentials, true)
  if (!models.length) throw new Error('当前分组没有可用于任务的模型，请检查账号分组')
  const preferences = selection || exact.account || exact.group ? exact : await reconcileQuotaModelPreferences(credentials, false, models)
  if (!models.some(model => model.id === preferences.model)) throw new Error(`当前线路没有模型 ${preferences.model}，请重新选择`)
  if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) return readBeginnerAgentServerConfig(selection)
  const reasoningCapabilities = models.find(model => model.id === preferences.model)?.reasoning ?? modelReasoningCatalog.resolve(preferences.model, credentials.baseUrl)
  const efforts = selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions)
  return {
    baseUrl: openAiV1BaseUrl(credentials.baseUrl),
    apiKey: credentials.apiKey,
    model: preferences.model,
    reasoningEffort: reasoningSelectionEffort(preferences.reasoningLevel, reasoningCapabilities, efforts),
    reasoningCapabilities: codexReasoningCapabilities(reasoningCapabilities, efforts),
    contextWindow: normalizeModelContextWindows(preferences.modelContextWindows)?.[preferences.model],
    autoCompactTokenLimit: normalizeModelAutoCompactTokenLimits(preferences.modelAutoCompactTokenLimits)?.[preferences.model],
    allowLongerContext
  }
}

const managedCodexPreparations = new Map<string, ReturnType<typeof prepareCodex>>()
const managedCodexPreparationUsers = new Map<string, { controller: AbortController; count: number }>()
const managedCodexPreparationListeners = new Map<string, Set<(progress: CodexSetupProgress) => void>>()
let managedCodexPreparationTail = Promise.resolve()

function managedCodexHome(project: ProjectInfo, sessionScope: string, configSource: 'device' | 'local-settings'): string {
  const scopeKey = createHash('sha256').update(sessionScope.trim() || 'workspace').digest('hex').slice(0, 20)
  const lane = configSource === 'device' ? 'quota' : 'configured-codex'
  return path.join(project.path, projectDataDirectory(project), 'external-agents', 'codex-homes', scopeKey, lane)
}

async function migrateLegacyManagedCodexSessions(home: string): Promise<void> {
  const scopeRoot = path.dirname(home)
  const legacyHomes = await fs.readdir(scopeRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of legacyHomes) {
    if (!entry.isDirectory() || !/^[0-9a-f]{20}$/i.test(entry.name)) continue
    const source = path.join(scopeRoot, entry.name, 'sessions')
    const target = path.join(home, 'sessions')
    if (!await pathExists(source)) continue
    await fs.mkdir(target, { recursive: true })
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false }).catch(() => undefined)
  }
}

function codexProviderIdentity(config: Pick<CodexServerConfig, 'baseUrl' | 'apiKey' | 'model'>): string {
  return `${config.model}\n${createHash('sha256').update(config.apiKey).digest('hex')}`
}

async function configuredCodexServerConfig(configuration: ExternalAgentConfiguration): Promise<CodexServerConfig> {
  const apiKey = configuration.apiKey?.trim() ?? ''
  const baseUrl = normalizeApiBaseUrl(configuration.baseUrl ?? '')
  const model = configuration.model?.trim() ?? ''
  if (!apiKey || !model) throw new Error('Codex 配置缺少 API Key 或模型名')
  await refreshConfiguredReasoning('codex', configuration)
  const reasoningCapabilities = modelReasoningFor(baseUrl, apiKey, model)
  const efforts = selectedReasoningEfforts(model, configuration.reasoningEffortOptions)
  return { apiKey, baseUrl, model, reasoningEffort: reasoningSelectionEffort(configuration.reasoningEffort ?? 'auto', reasoningCapabilities, efforts), reasoningCapabilities: codexReasoningCapabilities(reasoningCapabilities, efforts), contextWindow: normalizeModelContextWindows(configuration.modelContextWindows)?.[model], autoCompactTokenLimit: normalizeModelAutoCompactTokenLimits(configuration.modelAutoCompactTokenLimits)?.[model], allowLongerContext: (await readSettings()).allowLongerContext === true }
}

async function prepareManagedCodex(
  project: ProjectInfo,
  sessionScope: string,
  serverConfig: CodexServerConfig,
  configSource: 'device' | 'local-settings',
  existingExecutable?: string,
  onProgress?: (progress: CodexSetupProgress) => void,
  signal?: AbortSignal,
  surface: StudioSurface = 'workbench'
): ReturnType<typeof prepareCodex> {
  signal?.throwIfAborted()
  const home = managedCodexHome(project, sessionScope, configSource)
  await migrateLegacyManagedCodexSessions(home)
  const routeRevision = configSource === 'device' && !(await readDeviceCredentials())?.sync ? quotaConfiguration.current() : undefined
  const configurationId = createHash('sha256').update(JSON.stringify(serverConfig)).digest('hex')
  const key = `${process.platform === 'win32' ? home.toLowerCase() : home}:${configurationId}:${routeRevision?.sequence ?? 0}:${existingExecutable ?? ''}:${surface}`
  if (managedCodexPreparationUsers.get(key)?.controller.signal.aborted) {
    await managedCodexPreparations.get(key)?.catch(() => undefined)
    signal?.throwIfAborted()
  }
  const listeners = managedCodexPreparationListeners.get(key) ?? new Set<(progress: CodexSetupProgress) => void>()
  managedCodexPreparationListeners.set(key, listeners)
  if (onProgress) listeners.add(onProgress)
  if (!managedCodexPreparations.has(key)) {
    const users = { controller: new AbortController(), count: 0 }
    managedCodexPreparationUsers.set(key, users)
    const previousPreparation = managedCodexPreparationTail
    let releasePreparation!: () => void
    managedCodexPreparationTail = new Promise<void>((resolve) => { releasePreparation = resolve })
    const preparation = (async () => {
      await previousPreparation
      try {
        users.controller.signal.throwIfAborted()
        const contextBudget = resolveModelContextBudget(serverConfig.model, { baseUrl: serverConfig.baseUrl, contextWindow: serverConfig.contextWindow })
        if (contextBudget.source === 'inferred') diagnosticJournal.record({
          subsystem: 'ai', operation: 'model-context-budget', phase: 'inferred',
          message: `上下文预算参考 ${contextBudget.inferredFrom}`,
          data: { model: serverConfig.model, ...contextBudget }
        })
        return await prepareCodex({
          rootDir: app.getPath('userData'),
          homeDir: home,
          serverConfig: {
            ...serverConfig,
            upstreamBaseUrl: serverConfig.baseUrl,
            baseUrl: await chatCompletionsAdapter.baseUrl(serverConfig.baseUrl, `${codexProviderIdentity(serverConfig)}:${routeRevision?.sequence ?? 0}`, routeRevision?.signal, serverConfig.model, serverConfig.model, serverConfig.reasoningEffort ?? null)
          },
          configSource,
          existingExecutable: existingExecutable?.trim() || undefined,
          bundledSkillsDir: sessionScope.startsWith('developer/') ? undefined : bundledCodexSkillsDirectory(),
          bundledSkillNames: sessionScope.startsWith('developer/') ? [] : workbenchSkillNames(project, featurePluginService.enabled('image-studio'), surface),
          bundledSkillDirectories: sessionScope.startsWith('developer/') ? [] : studios().skillDirectories(project),
          imageToolsEnabled: featurePluginService.enabled('image-studio'),
          rememberPrepared: false,
          signal: users.controller.signal,
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
      if (managedCodexPreparations.get(key) === preparation) {
        managedCodexPreparations.delete(key)
        managedCodexPreparationUsers.delete(key)
      }
      if (!listeners.size) managedCodexPreparationListeners.delete(key)
    }
    void preparation.then(release, release)
  }
  const activePreparation = managedCodexPreparations.get(key)!
  const users = managedCodexPreparationUsers.get(key)!
  users.count += 1
  const observedPreparation = signal ? awaitWithAbort(activePreparation, signal, 'Codex 准备已停止') : activePreparation
  return observedPreparation.finally(() => {
    users.count -= 1
    if (users.count === 0 && managedCodexPreparations.get(key) === activePreparation) users.controller.abort()
    if (onProgress) listeners.delete(onProgress)
    if (!listeners.size && !managedCodexPreparations.has(key)) managedCodexPreparationListeners.delete(key)
  })
}

async function detectInstalledCodex(configuration: ExternalAgentConfiguration = {}) {
  // A user-installed CLI wins; the already-downloaded managed runtime is a
  // fallback executable only. Its account/configuration is never imported.
  let managedExecutable: string | undefined
  try { managedExecutable = managedCodexExecutablePath(app.getPath('userData')) } catch { /* The user CLI can still support an unbundled platform. */ }
  return detectExternalAgent('codex', {
    executables: configuration.executable ? [configuration.executable] : [],
    fallbackExecutables: managedExecutable ? [managedExecutable] : []
  })
}

async function prepareConfiguredCodex(
  project: ProjectInfo,
  sessionScope: string,
  configuration: ExternalAgentConfiguration,
  onProgress?: (progress: CodexSetupProgress) => void,
  signal?: AbortSignal,
  surface: StudioSurface = 'workbench'
): ReturnType<typeof prepareCodex> {
  const installed = await detectInstalledCodex(configuration)
  return prepareManagedCodex(
    project,
    sessionScope,
    await configuredCodexServerConfig(configuration),
    'local-settings',
    installed.installed ? installed.executable : undefined,
    onProgress,
    signal,
    surface
  )
}

async function prepareQuotaCodex(project: ProjectInfo, sessionScope: string, onProgress?: (progress: CodexSetupProgress) => void, signal?: AbortSignal, override?: CodexServerConfig, surface: StudioSurface = 'workbench'): ReturnType<typeof prepareCodex> {
  const serverConfig = override ?? (signal
    ? await awaitWithAbort(readBeginnerAgentServerConfig(), signal, 'Codex 准备已停止')
    : await readBeginnerAgentServerConfig())
  return prepareManagedCodex(project, sessionScope, serverConfig, 'device', undefined, onProgress, signal, surface)
}

function externalAgentEnvironment(kind: ExternalAgentKind, configuration: ExternalAgentConfiguration, codexHome?: string): NodeJS.ProcessEnv {
  void kind
  const apiKey = configuration.apiKey?.trim() ?? ''
  if (!apiKey) throw new Error('请先填写 API Key')
  const baseUrl = normalizeApiBaseUrl(configuration.baseUrl ?? '')
  const model = configuration.model?.trim() ?? ''
  if (!model) throw new Error('请先选择模型')
  if (!codexHome) throw new Error('Codex 配置目录不可用')
  return {CODEX_HOME: codexHome, MODMIND_THIRD_PARTY_API_KEY: apiKey}
}

async function externalAgentRunEnvironment(kind: ExternalAgentKind, settings: AgentSettings): Promise<NodeJS.ProcessEnv | undefined> {
  const configured = settings.externalAgents?.[kind] ?? {}
  if (configured.mode !== 'hosted') return undefined
  if (!configured.apiKey?.trim() || !externalAgentSupportsHostedConfiguration(kind)) return undefined
  return {MODMIND_THIRD_PARTY_API_KEY: configured.apiKey.trim()}
}

function applicationIconPath(): string {
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.join(app.getAppPath(), 'resources', fileName)
}

function applicationUserModelId(): string {
  if (app.getVersion().endsWith('-plugintest')) return 'dev.modmind.desktop.plugintest'
  return app.isPackaged ? 'dev.modmind.desktop' : 'dev.modmind.desktop.development'
}

function setApplicationWindowIdentity(window: BrowserWindow): void {
  if (process.platform !== 'win32') return
  const iconPath = applicationIconPath()
  window.setIcon(nativeImage.createFromPath(iconPath))
  // Windows taskbar groups use relaunch metadata, independently of WM_SETICON.
  window.setAppDetails({
    appId: applicationUserModelId(),
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: app.isPackaged ? 'ModMind' : 'ModMind (开发)'
  })
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
  if (quitRequested) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
function disposeBlockbenchBridge(): void {}


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
  app.quit()
}

function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(process.platform === 'darwin'
    ? path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'trayTemplate.png')
    : applicationIconPath())
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
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
  if (process.platform === 'darwin') { mainWindow.hide(); return }
  if (closeRequestInFlight) return
  closeRequestInFlight = true
  try {
    const settings = await readSettings()
    let behavior = settings.closeBehavior
    if (behavior === 'ask') {
      const choice = await new Promise<{ behavior: 'tray' | 'quit' | 'cancel'; remember: boolean }>((resolve) => {
        resolveCloseChoice = resolve
        mainWindow!.webContents.send('window:closeRequested')
      })
      resolveCloseChoice = null
      if (choice.behavior === 'cancel' || !mainWindow || mainWindow.isDestroyed()) return
      behavior = choice.behavior
      if (choice.remember) await saveClosePreferences(behavior)
    }
    if (behavior === 'tray') {
      createTray()
      mainWindow.hide()
      return
    }
    await conversationStore.flush()
    allowWindowClose = true
    mainWindow.close()
  } finally {
    resolveCloseChoice = null
    closeRequestInFlight = false
  }
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
  if (!window || window.isDestroyed()) return { pluginId, open: false, hidden: hiddenPluginOverlays.has(pluginId), alwaysOnTop: false }
  return { pluginId, open: true, hidden: false, alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds() }
}

function pluginOverlayWindowStates(): PluginOverlayWindowState[] {
  return [...new Set([...pluginOverlayWindows.keys(), ...hiddenPluginOverlays])].map(pluginOverlayWindowState)
}

function setPluginOverlayVisibility(pluginId: string, visible: boolean): PluginOverlayWindowState {
  const record = getPluginService()?.getEnabledPlugin(pluginId)
  if (!record?.manifest.overlay) throw new Error(`插件 ${pluginId} 没有可用悬浮界面`)
  if (visible) hiddenPluginOverlays.delete(pluginId)
  else hiddenPluginOverlays.add(pluginId)
  const window = pluginOverlayWindows.get(pluginId)
  // Remove before close: docking must not be interpreted as the user dismissing the window.
  pluginOverlayWindows.delete(pluginId)
  if (window && !window.isDestroyed()) window.close()
  broadcastPluginOverlayWindows()
  return pluginOverlayWindowState(pluginId)
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
  hiddenPluginOverlays.delete(pluginId)

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
  installEditContextMenu(window)
  pluginOverlayWindows.set(pluginId, window)
  window.setMenuBarVisibility(false)
  if (overlay.alwaysOnTop) window.setAlwaysOnTop(true, 'floating')
  window.on('ready-to-show', () => {
    window.show()
    broadcastPluginOverlayWindows()
  })
  window.on('closed', () => {
    if (pluginOverlayWindows.get(pluginId) === window) {
      pluginOverlayWindows.delete(pluginId)
      hiddenPluginOverlays.add(pluginId)
    }
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
    ...platformWindowOptions(),
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
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false)
  setApplicationWindowIdentity(window)
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
  const offscreenQa = !app.isPackaged && process.env.MODMIND_UI_QA_OFFSCREEN === '1'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    ...platformWindowOptions(),
    backgroundColor: '#f5f5f7',
    icon: iconPath,
    webPreferences: {
      offscreen: offscreenQa,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false)
  setApplicationWindowIdentity(mainWindow)

  mainWindow.on('ready-to-show', () => { if (!offscreenQa) mainWindow?.show() })
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
    resolveCloseChoice?.({ behavior: 'cancel', remember: false })
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'process', phase: 'gone', level: 'error', message: `Renderer process exited: ${details.reason}`, data: details })
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    diagnosticJournal.record({ subsystem: 'renderer', operation: 'load', phase: 'error', level: 'error', message: errorDescription, data: { errorCode, validatedURL } })
  })

  buildRuntime = new BuildRuntimeManager(runtimeOptions())
  mainWindow.on('closed', () => {
    cancelRendererDialogsForWindow(mainWindow!)
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
    void optionalTestingService()?.dispose()
    buildRuntime?.destroy()
    buildRuntime = null
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
function requireBlockbench(): BlockbenchBridge { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').requireBlockbench() }

function requireBlockbenchForProject(project: ProjectInfo): BlockbenchBridge { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').requireBlockbenchForProject(project) }

async function previewAssetIntentCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').previewAssetIntentCandidate(bridge, input, capture, signal, expectedRevision) }

async function compileAssetRefinementForBridge(bridge: BlockbenchBridge, input: unknown): Promise<ReturnType<typeof compileAssetRefinement>> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').compileAssetRefinementForBridge(bridge, input) }

async function previewAssetRefinementCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').previewAssetRefinementCandidate(bridge, input, capture, signal, expectedRevision) }

async function applyAssetRefinementCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<unknown> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').applyAssetRefinementCandidate(bridge, input, signal, expectedRevision) }

async function previewAdvancedAssetComparison(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  options: AdvancedAssetPreviewOptions = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetComparison> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').previewAdvancedAssetComparison(bridge, input, capture, options, signal, expectedRevision) }

async function previewAdvancedCandidate(
  bridge: BlockbenchBridge,
  candidate: AdvancedAssetCandidate,
  capture: BlockbenchCaptureRequest,
  iteration: number,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetCandidatePreview> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').previewAdvancedCandidate(bridge, candidate, capture, iteration, signal, expectedRevision) }

async function previewReferenceImageCandidate(
  bridge: BlockbenchBridge,
  input: unknown,
  capture: BlockbenchCaptureRequest = {},
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<AdvancedAssetCandidatePreview & {reference: Awaited<ReturnType<typeof compileReferenceImageAsset>>['reference']}> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/model-studio/main').activate>>('model-studio').previewReferenceImageCandidate(bridge, input, capture, signal, expectedRevision) }


function requireMinecraftRuntime(): MinecraftRuntimeManager {
  if (!buildRuntime) throw new Error('构建环境尚未就绪')
  return new Proxy(buildRuntime, { get(target, key) {
    const core = ['ensureJavaRuntime', 'ensureJavaRuntimeForTools', 'buildDependencyProject', 'inspectMinecraftClass'].includes(String(key))
    const owner = core || !featurePluginService.enabled('testing') ? target : requireTestingService().minecraftRuntime
    const value = Reflect.get(owner, key)
    if (value === undefined && key !== 'then') throw new Error('请在侧边栏 → 功能中安装并启用“游戏与服务端测试”')
    return typeof value === 'function' ? value.bind(owner) : value
  } }) as unknown as MinecraftRuntimeManager
}
let buildRuntime: BuildRuntimeManager | null = null
type TestingService = ReturnType<typeof import('../../feature-plugins/testing/main').activate>
function requireTestingService(): TestingService { return featurePluginService.service<TestingService>('testing') }
function optionalTestingService(): TestingService | undefined { return featurePluginService.activeService<TestingService>('testing') }
function runtimeOptions(): import('./buildRuntime').MinecraftRuntimeOptions { return {
  getProject: () => aiProjectContext.getStore() ?? currentProject,
  onState: state => mainWindow?.webContents.send('minecraft:state', state), onEvent: forwardMinecraftRuntimeEvent,
  authorizeBuild: ensureProjectBuildTrusted,
  getGradleDownloadSource: async () => (await readSettings()).gradleDownloadSource ?? 'auto',
  getJavaPreference: async () => (await readSettings()).javaPreferences,
  prepareProjectDependencies: async (project, signal) => {
    if (project.kind === 'modpack' || !isJavaLoader(project.loader) || !featurePluginService.enabled('relationships')) return
    await requireAddonRelationshipService().refreshLinkedProjects(linked => buildLinkedProjectTree(linked, signal, [project.path]), [project.path])
  }
} }


const minecraftResourceQueue = new AbortableResourceQueue()
const minecraftResourceContext = new AsyncLocalStorage<boolean>()

async function withMinecraftResourceLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal) throwIfAborted(signal, '构建已取消')
  if (minecraftResourceContext.getStore()) return operation()
  return minecraftResourceQueue.run(() => minecraftResourceContext.run(true, operation), signal)
}

function buildProjectWithLock(signal?: AbortSignal): Promise<MinecraftManagedMod> {
  const project = requireProject()
  if (studios().resolve(project)?.definition.tasks?.build) return studios().invokeTask(project, 'build', {}, { projectPath: project.path, surface: 'workbench', signal }).then(async value => {
    const artifact = value as { path?: unknown }
    if (typeof artifact?.path !== 'string') throw new Error('工作台未返回构建产物')
    const file = await fs.realpath(artifact.path), relative = path.relative(await fs.realpath(project.path), file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('工作台构建产物超出项目目录')
    const stat = await fs.stat(file)
    if (!stat.isFile() || !stat.size) throw new Error('工作台构建产物不是有效文件')
    return { name: path.basename(file), path: file, size: stat.size, modifiedAt: stat.mtime.toISOString(), projectArtifact: true }
  })
  return withMinecraftResourceLock(async () => {
    const startedAt = Date.now()
    const feedback = new CreationFeedbackService(project)
    try {
      return await feedback.build(() => requireMinecraftRuntime().buildProject(signal), signal)
    } finally {
      for (const buildLog of [path.join(project.path, projectDataDirectory(project), 'builds', 'minecraft-test-build.log'), path.join(project.path, '.modmind', 'builds', 'maven-build.log')]) {
        const stat = await fs.stat(buildLog).catch(() => null)
        if (!stat || stat.mtimeMs < startedAt) continue
        const text = await fs.readFile(buildLog, 'utf8').catch(() => '')
        if (text) await feedback.evidence(text, 'managed-build').catch(error => console.warn('构建日志归档失败', error))
      }
    }
  }, signal)
}


async function renameProjectRecord(project: ProjectInfo, input: ProjectRenameInput): Promise<ProjectInfo> {
  assertProjectMutationAllowed(project.path, '重命名')
  if (!input || typeof input.name !== 'string' || typeof input.namespace !== 'string') throw new Error('项目重命名参数无效')
  const name = validateProjectNameInput(input.name)
  if (!input.namespace.trim()) throw new Error('命名空间不能为空')
  const namespace = slugify(input.namespace)
  const nextProject: ProjectInfo = { ...project, name, namespace, namespaceSource: 'manual' }
  if (nextProject.name === project.name && nextProject.namespace === project.namespace && project.namespaceSource === 'manual') return project

  await renameProjectFiles(project, nextProject, [currentProjectManifest])
  const manifestPath = path.join(project.path, projectManifest(project))
  const temporary = `${manifestPath}.tmp-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(nextProject, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, manifestPath)
  if (currentProject && sameProjectPath(currentProject.path, project.path)) currentProject = nextProject
  await rememberRecentProject(nextProject)
  await refreshExternalAgentContext(nextProject, featurePluginService.enabled('image-studio')).catch(() => undefined)
  return nextProject
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

function requireImageStudio(): ImageStudioBackend {
  return featurePluginService.service<ImageStudioBackend>('image-studio')
}

function generateStudioImage(input: ImageGenerationRequest | Record<string, unknown>, source: 'manual' | 'agent', signal?: AbortSignal) {
  signal?.throwIfAborted()
  return runDiagnosticOperation('image-studio', 'generate', 'Image generation', () => requireImageStudio().generate(input, source, signal), { source })
}

async function hostedImageAuthorization(): Promise<{ credentials: DeviceCredentials; routingToken: string }> {
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接 ModMind 账号，或在专业设置中保存图片 API Key')
  if (credentials.provider === 'custom') throw new Error('自定义 API 模式下请配置图片 API，无法使用 ModMind 额度图像服务')
  const routingToken = credentials.sync ? await providerSync().routingToken() : await deviceStateWrites.run(() => quotaRouter().routingToken())
  if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) throw new Error('账号已切换，请重新运行图像任务')
  return { credentials, routingToken }
}

async function createHostedImageLease(request?: ImageGenerationRequest, signal?: AbortSignal): Promise<DeviceImageLease & { jobId: string; reservedCredits: number }> {
  signal?.throwIfAborted()
  const { credentials, routingToken } = await hostedImageAuthorization()
  const lease = await requestDeviceImageLease({ ...credentials, routingToken }, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000))
  if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) throw new Error('账号已切换，请重新运行图像任务')
  const jobId = randomUUID()
  const reservedCredits = request ? Math.max(1, request.count) : 0
  return { ...lease, jobId, reservedCredits }
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
  if (isJavaLoader(project.loader) || isServerPluginPlatform(project.loader)) await copyBundledGradleWrapper(project.path)
}

async function scaffoldStudioProject(project: ProjectInfo): Promise<void> {
  const record = studios().require(project)
  project.studioId = record.definition.id
  project.studioName = record.definition.name
  if (record.definition.creation) project.studioValues = studioFormValues(record.definition, project)
  await studios().scaffold(project, async files => {
    for (const [relative, content] of Object.entries(files)) {
      if (!relative || relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) throw new Error('工作台模板包含无效文件路径')
      const target = path.resolve(project.path, relative)
      if (!path.relative(project.path, target) || path.relative(project.path, target).startsWith('..')) throw new Error('工作台模板路径超出项目')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
    }
    if (isJavaLoader(project.loader) || isServerPluginPlatform(project.loader)) await copyBundledGradleWrapper(project.path)
  })
  await fs.writeFile(path.join(project.path, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
}

async function readProjectInfo(root: string): Promise<ProjectInfo | null> {
  const currentPath = path.join(root, currentProjectManifest)
  if (!await pathExists(currentPath)) return null
  const content = await fs.readFile(currentPath, 'utf8')
  const parsed = JSON.parse(content) as ProjectInfo
  return { ...parsed, name: normalizeProjectName(parsed.name), path: root, toolDataDirectory: '.modmind' }
}

async function offerProjectVersionMigration(project: ProjectInfo): Promise<ProjectInfo> {
  if (project.draft) return project
  if (await detectedProjectVersion(project) !== MIGRATABLE_PROJECT_VERSION) return project
  const shouldMigrate = await requestRendererDialog({
    kind: 'confirm',
    title: '项目模板需要迁移',
    message: `检测到 ModMind ${MIGRATABLE_PROJECT_VERSION} 项目`,
    detail: `旧版 Gradle 和 Loader 模板可能无法构建。可以自动备份原配置并迁移到 ${CURRENT_PROJECT_VERSION}；源码和自定义入口不会被覆盖`,
    confirmLabel: `自动迁移到 ${CURRENT_PROJECT_VERSION}`,
    cancelLabel: '暂不迁移'
  })
  if (!shouldMigrate) return project
  let migrationProject = project
  if (project.loader === 'quilt' && !project.qslVersion) {
    const compatibility = await requireLoaderCatalog().resolve(project.loader, project.minecraftVersion)
    migrationProject = { ...project, qslVersion: compatibility.qslVersion }
  }
  const result = await migrateProjectVersion112(migrationProject, copyBundledGradleWrapper)
  await requestRendererDialog({
    kind: 'info',
    title: '项目迁移完成',
    message: `项目已迁移到 ModMind ${CURRENT_PROJECT_VERSION}`,
    detail: `旧配置已备份到 ${path.relative(project.path, result.backupDirectory)}`,
    confirmLabel: '知道了'
  })
  return result.project
}

async function readAvailableProjectForOpening(root: string): Promise<ProjectInfo | null> {
  const preview = await readProjectInfo(root) ?? await readLegacyModtoolProject(root)
  if (!preview) return null
  if (!preview.draft) studios().require(preview)
  return (await convertLegacyModtoolProject(root)).project ?? preview
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

const studioInspectionCache = new AsyncLocalStorage<Map<string, ReturnType<typeof analyzeExistingProject>>>()
async function inspectBuiltinStudio(kind: string, sourcePath: string): Promise<ExistingProjectAnalysis | null> {
  const cache = studioInspectionCache.getStore()
  let pending = cache?.get(sourcePath)
  if (!pending) { pending = analyzeExistingProject(sourcePath); cache?.set(sourcePath, pending) }
  const { analysis } = await pending
  return (analysis.inferred.kind ?? 'mod') === kind ? analysis : null
}
async function inspectStudioSource(sourcePath: string): Promise<ExistingProjectAnalysis> {
  return studioInspectionCache.run(new Map(), () => studios().inspectExisting(sourcePath))
}
const studioAdoptionBackground = new AsyncLocalStorage<boolean>()
async function isExtractedProjectSource(sourcePath: string): Promise<boolean> {
  const temporaryRoot = await fs.realpath(app.getPath('temp'))
  const relative = path.relative(temporaryRoot, await fs.realpath(sourcePath))
  return !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep)[0].startsWith('modmind-import-')
}
async function adoptStudioProject(input: ExistingProjectAdoptInput): Promise<ProjectInfo | null> {
  if (!studioAdoptionBackground.getStore()) assertProjectSwitchAllowed()
  if (!input || typeof input.sourcePath !== 'string') throw new Error('接管参数无效')
  const sourcePath = await fs.realpath(input.sourcePath)
  const legacy = await readLegacyModtoolProject(sourcePath)
  if (legacy) {
    const record = studios().require(legacy)
    const converted = (await convertLegacyModtoolProject(sourcePath)).project!
    converted.studioId = record.definition.id
    converted.studioName = record.definition.name
    await fs.writeFile(path.join(sourcePath, currentProjectManifest), JSON.stringify(converted, null, 2), 'utf8')
    if (!studioAdoptionBackground.getStore()) currentProject = converted
    await rememberRecentProject(converted)
    return converted
  }
  if (await readProjectInfo(sourcePath)) throw new Error('此目录已是 ModMind 项目，请直接打开')
  const analysis = await inspectStudioSource(sourcePath)
  const selected = studios().select({ ...input, studioId: input.studioId ?? analysis.inferred.studioId, kind: input.kind ?? analysis.inferred.kind })
  const name = validateProjectNameInput(input.name)
  const checked = { ...input, sourcePath: analysis.sourcePath, studioId: selected.definition.id, kind: selected.definition.projectKind,
    name, namespace: slugify(input.namespace), studioValues: selected.definition.creation ? studioFormValues(selected.definition, { ...input, name }) : input.studioValues }
  const builtin = featurePluginService.list().find(entry => entry.id === selected.pluginId)?.builtin
  if (!builtin && (analysis.kind !== 'complete' || await isExtractedProjectSource(sourcePath))) throw new Error('此工作台仅支持直接接管完整项目文件夹')
  const plan = await studios().adoptExisting(checked, analysis)
  let project: ProjectInfo
  if (plan.mode === 'host-managed') {
    if (!builtin) throw new Error('自定义工作台应返回 in-place 接管计划')
    if (!plan.project) return null
    project = plan.project
  } else {
    project = { ...checked, studioName: selected.definition.name, path: analysis.sourcePath, createdAt: new Date().toISOString(), toolDataDirectory: '.modmind', projectVersion: CURRENT_PROJECT_VERSION }
    await fs.writeFile(path.join(project.path, currentProjectManifest), JSON.stringify(project, null, 2), { encoding: 'utf8', flag: 'wx' })
  }
  project.studioId = selected.definition.id
  project.studioName = selected.definition.name
  project.studioValues = checked.studioValues
  studios().require(project)
  await fs.writeFile(path.join(project.path, currentProjectManifest), JSON.stringify(project, null, 2), 'utf8')
  const verified = await readProjectInfo(project.path)
  if (!verified || verified.studioId !== selected.definition.id) throw new Error('接管项目信息回读失败')
  if (!studioAdoptionBackground.getStore()) currentProject = verified
  await rememberRecentProject(verified)
  return verified
}

async function adoptBuiltinStudio(input: ExistingProjectAdoptInput): Promise<ProjectInfo | null> {
    if (!studioAdoptionBackground.getStore()) assertProjectSwitchAllowed()
    if (!input || typeof input.sourcePath !== 'string') throw new Error('导入参数无效')
    const legacyConversion = await convertLegacyModtoolProject(input.sourcePath)
    if (legacyConversion.project) {
      if (!studioAdoptionBackground.getStore()) currentProject = legacyConversion.project
      await rememberRecentProject(legacyConversion.project)
      return legacyConversion.project
    }
    if (!isJavaLoader(input.loader) && !isServerPluginPlatform(input.loader)) throw new Error('现有项目识别支持 Java 模组和服务端插件工程')
    const { analysis, files } = await analyzeExistingProject(input.sourcePath)
    const name = validateProjectNameInput(input.name)
    const namespace = slugify(input.namespace)
    const minecraftVersion = input.minecraftVersion.trim()
    if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?(?:-SNAPSHOT)?$/.test(minecraftVersion)) throw new Error('目标版本格式无效')
    if (analysis.kind === 'modpack') {
      let projectPath = analysis.sourcePath
      const isTemporaryImport = await isExtractedProjectSource(analysis.sourcePath)
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
    const isTemporaryImport = await isExtractedProjectSource(analysis.sourcePath)
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
      kind: isServerPluginPlatform(input.loader) ? 'server-plugin' : 'mod',
      studioId: input.studioId,
      studioName: studios().select(input).definition.name,
      studioValues: input.studioValues,
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
    if (!studioAdoptionBackground.getStore()) currentProject = project
    await rememberRecentProject(project)
    return project

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
      ...(externalModpack.remoteFiles.length ? [`清单另含 ${externalModpack.remoteFiles.length} 个远程文件（其中 ${externalModpack.remoteFiles.filter(entry => /^mods\/[^/]+\.jar$/i.test(entry.path)).length} 个 Mod），接管时将按原清单下载并校验`] : []),
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
  const pluginFile = files.find(file => /(?:^|\/)(?:plugin\.yml|paper-plugin\.yml|velocity-plugin\.json)$/.test(file))
  const pluginBuildFiles = files.filter(file => ['build.gradle', 'build.gradle.kts', 'pom.xml', 'gradle.properties'].includes(file))
  const buildText = (await Promise.all(pluginBuildFiles.map(file => fs.readFile(path.join(root, file), 'utf8')))).join('\n')
  if (pluginFile || /(?:paper-api|spigot-api|folia-api|velocity-api)/.test(buildText)) {
    const descriptor = pluginFile ? parsePluginDescriptor(await fs.readFile(path.join(root, pluginFile), 'utf8'), path.basename(pluginFile)) : null
    const platform = /velocity-api/.test(buildText) || descriptor?.platform === 'velocity' ? 'velocity' : /folia-api/.test(buildText) ? 'folia' : /paper-api/.test(buildText) || descriptor?.platform === 'paper' ? 'paper' : 'spigot'
    const version = buildText.match(/(?:paper-api|spigot-api|folia-api)[:'"\s]+(\d+\.\d+(?:\.\d+)?)/)?.[1]
      ?? (platform === 'velocity' ? buildText.match(/velocity-api[:'"\s]+(3\.\d+\.\d+(?:-SNAPSHOT)?)/)?.[1] : undefined)
      ?? (platform === 'velocity' ? '3.4.0-SNAPSHOT' : descriptor?.apiVersion || '1.21.1')
    const name = descriptor?.name ?? path.basename(root)
    return { files, analysis: { sourcePath: root, sourceName: path.basename(root), kind: pluginBuildFiles.length ? 'complete' : 'partial', fileCount: files.length, sourceFileCount: files.filter(file => /\.(java|kt)$/.test(file)).length, documentCount: 0, detectedFiles: [...pluginBuildFiles, ...(pluginFile ? [pluginFile] : [])], reasons: ['识别为服务端插件工程，保留原构建脚本；请核对推断的平台/API 版本。'], inferred: { name, namespace: slugify(name), loader: platform, kind: 'server-plugin', minecraftVersion: version } } }
  }
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
  const versionFiles = files.filter(file => /(?:^|\/)(?:gradle\.properties|build\.gradle(?:\.kts)?|fabric\.mod\.json|quilt\.mod\.json|mods\.toml|neoforge\.mods\.toml|\.build-target-props\.json)$/i.test(file))
  const importantTextFiles = [...new Set([...buildFiles, ...versionFiles])]
  const importantContents: Array<{ path: string; content: string }> = []
  let incompleteVersionMetadata = false
  for (const relative of importantTextFiles) {
    const absolute = path.join(root, ...relative.split('/'))
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat?.isFile() || stat.size > 1024 * 1024) { incompleteVersionMetadata = true; continue }
    const content = await fs.readFile(absolute, 'utf8').catch(() => { incompleteVersionMetadata = true; return '' })
    if (content) importantContents.push({ path: relative, content })
  }
  const gradlePropertiesFile = importantContents.find((entry) => /(?:^|\/)gradle\.properties$/i.test(entry.path))
  const properties = gradlePropertiesFile ? parseGradleProperties(gradlePropertiesFile.content) : {}
  const detectedLoader = inferGradleLoader(importantContents.filter(entry => buildFiles.includes(entry.path) || entry.path === descriptor), descriptor)
  loader = detectedLoader.loader
  if (properties.mod_name && !properties.mod_name.includes('${')) name = properties.mod_name.trim()
  if (properties.mod_id && !properties.mod_id.includes('${')) namespace = slugify(properties.mod_id)
  for (const { path: relative, content } of importantContents) {
    if (!content || relative !== descriptor) continue
    if (/fabric\.mod\.json$/i.test(relative)) {
      try {
        const manifest = JSON.parse(content) as { id?: unknown; name?: unknown; depends?: { minecraft?: unknown } }
        if (typeof manifest.id === 'string') namespace = slugify(manifest.id)
        if (typeof manifest.name === 'string' && manifest.name.trim()) name = manifest.name.trim()
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

  const minecraftVersions = inferMinecraftVersions(importantContents)
  const minecraftVersion = !incompleteVersionMetadata && minecraftVersions.length === 1 ? minecraftVersions[0] : ''
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
      minecraftVersions,
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
      curseForge: { resolve: curseForgePackResolver(curseForgeProviderKey, path.join(app.getPath('userData'), 'pack-metadata-cache')), cacheDirectory: path.join(app.getPath('userData'), 'pack-download-cache') },
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
    await auditImportedPackArtifacts(project)
  } catch (error) {
    if (context.isTemporaryImport && createdTemporaryDestination) {
      await fs.rm(context.projectPath, { recursive: true, force: true }).catch(() => undefined)
    } else if (!context.isTemporaryImport) {
      await fs.rm(path.join(context.projectPath, currentProjectManifest), { force: true }).catch(() => undefined)
    }
    throw error
  }

  if (!studioAdoptionBackground.getStore()) currentProject = project
  await rememberRecentProject(project)
  if (!studioAdoptionBackground.getStore()) emitProjectChanged()
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
    const manifest = await readModpackManifest(project)
    downloadActivities.complete(activityId, manifest.source?.unresolvedDependencies
      ? `工作区已接管，仍有 ${manifest.source.unresolvedDependencies} 个必需文件待安装；请在模组列表继续安装`
      : '整合包下载、校验与接管已完成')
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

async function resolveExistingProjectSource(inputPath: string, onProgress?: (percent?: number) => void): Promise<string> {
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
      let processedEntries = 0
      let lastPercent = -1
      await extractZip(resolved, {
        dir: extractionRoot,
        onEntry: (entry, zipfile) => {
          recordZipExpansion(expansion, entry)
          processedEntries += 1
          const percent = Math.min(99, Math.floor((processedEntries - 1) / zipfile.entryCount * 100))
          if (percent !== lastPercent) {
            lastPercent = percent
            onProgress?.(percent)
          }
        }
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
  const selectedRoot = directories.length === 1 && entries.every((entry) => entry.isDirectory() || entry.name.startsWith('.'))
    ? path.join(extractionRoot, directories[0].name) : extractionRoot
  if ((await Promise.all(['manifest.json', 'modrinth.index.json'].map(file => fs.access(path.join(selectedRoot, file)).then(() => true, () => false)))).some(Boolean)) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(resolved)) hash.update(chunk as Buffer)
    const provenance = path.join(selectedRoot, '.modmind', 'import')
    await fs.mkdir(provenance, { recursive: true })
    await fs.writeFile(path.join(provenance, 'source-archive.json'), JSON.stringify({ fileName: path.basename(resolved), size: stat.size, sha256: hash.digest('hex') }, null, 2), 'utf8')
  }
  onProgress?.(100)
  return selectedRoot
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

async function listDirectory(root: string, relative = '', excludeToolData = false): Promise<FileNode[]> {
  const absolute = path.join(root, relative)
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    // Atomic conversation writes remove transient directories while the file tree is refreshing.
    if (relative && error.code === 'ENOENT') return []
    throw error
  })
  const nodes: FileNode[] = []

  for (const entry of entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })) {
    if (entry.isSymbolicLink()) continue
    // The file browser hides tool data; skip it before traversing its caches and histories.
    if (excludeToolData && !relative && isToolDataDirectory(entry.name)) continue
    if (isToolDataDirectory(relative) && entry.name.endsWith('.lock')) continue
    if (ignoredDirectories.has(entry.name) || (isToolDataDirectory(relative) && entry.name === 'snapshots')) continue
    const childPath = path.posix.join(relative.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: childPath, type: 'directory', children: await listDirectory(root, childPath, excludeToolData) })
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
  options?: Pick<PipelineEvent, 'terminal' | 'recoverable' | 'notice'>
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
    ...(options?.notice ? { notice: options.notice } : {}),
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

async function copySnapshotFiles(source: string, destination: string, ignoreDirectory: (name: string) => boolean = (name) => ignoredDirectories.has(name) || isToolDataDirectory(name)): Promise<number> {
  let count = 0
  const entries = await fs.readdir(source, { withFileTypes: true })
  await fs.mkdir(destination, { recursive: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (ignoreDirectory(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) count += await copySnapshotFiles(from, to, ignoreDirectory)
    else {
      await fs.copyFile(from, to)
      count += 1
    }
  }
  return count
}

async function latestSnapshotBaseline(project: ProjectInfo): Promise<{ root: string; hashes: Record<string, string>; metadata?: Record<string, SnapshotFileMetadata> } | undefined> {
  const snapshotsRoot = path.join(project.path, projectDataDirectory(project), 'snapshots')
  let latest: { root: string; manifest: SnapshotManifest } | undefined
  for (const info of await listSnapshotSummaries(project.path)) {
    const directory = path.join(snapshotsRoot, info.id)
    const manifest = await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8')
      .then((value) => JSON.parse(value) as SnapshotManifest)
      .catch(() => null)
    const root = path.join(directory, 'files')
    const rootStat = await fs.lstat(root).catch(() => null)
    if (!manifest || typeof manifest.createdAt !== 'string' || !snapshotManifestBelongsToProject(manifest, info.id, project.path) || !rootStat?.isDirectory() || rootStat.isSymbolicLink()) continue
    latest = { root, manifest }
    break
  }
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

async function scanConfiguredJavaHomes(): Promise<Awaited<ReturnType<typeof detectInstalledJavaHomes>>> {
  return detectInstalledJavaHomes(Object.values((await readSettings()).javaPreferences))
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
  await writeSettingsFile(settingsFile(), stored)
}

async function saveAgentSettings(input: AgentSettingsPatch | ((current: AgentSettings) => AgentSettings), validatePreferences = true): Promise<AgentSettings> {
  let resolveWrite!: (settings: AgentSettings) => void
  let rejectWrite!: (error: unknown) => void
  const result = new Promise<AgentSettings>((resolve, reject) => {
    resolveWrite = resolve
    rejectWrite = reject
  })
  agentSettingsWriteTail = agentSettingsWriteTail.catch(() => undefined).then(async () => {
    try {
  const current = await readSettings(true)
  const value = typeof input === 'function' ? input(current) : mergeAgentSettingsPatch(current, input)
  const kinds = ['codex'] as const
  const normalized: AgentSettings = {
    ...value,
    allowLongerContext: value.allowLongerContext === true,
    codingBackend: ['quota', ...kinds].includes(value.codingBackend) ? value.codingBackend : 'quota',
    codexApprovalMode: normalizeAgentApprovalMode(value.codexApprovalMode),
    allowBuildScriptChanges: true,
    preferLocalGradle: false,
    gradleExecutable: typeof value.gradleExecutable === 'string' ? value.gradleExecutable.trim().slice(0, 4096) : '',
    gradleDownloadSource: value.gradleDownloadSource === 'china' || value.gradleDownloadSource === 'official' ? value.gradleDownloadSource : 'auto',
    networkProxyUrl: normalizeNetworkProxyUrl(value.networkProxyUrl),
    javaPreferences: normalizeJavaPreferences(value.javaPreferences),
    ...normalizeAppearance(value),
    closeBehavior: value.closeBehavior === 'tray' || value.closeBehavior === 'quit' ? value.closeBehavior : 'ask',
    notificationsEnabled: value.notificationsEnabled !== false
  }
  let existingAgentKeys: Partial<Record<ExternalAgentKind, string>> = {}
  let existingAgentEntries: AgentSettings['externalAgents'] = {}
  try {
    const existing = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as { externalAgents?: AgentSettings['externalAgents']; encryptedKey?: string; externalAgentProvider?: ExternalAgentKind; encryptedAgentKeys?: Partial<Record<ExternalAgentKind, string>> }
    existingAgentEntries = existing.externalAgents ?? {}
    existingAgentKeys = existing.encryptedAgentKeys ?? {}
    if (existing.encryptedKey && existing.externalAgentProvider && !existingAgentKeys[existing.externalAgentProvider]) {
      existingAgentKeys[existing.externalAgentProvider] = existing.encryptedKey
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('原配置当前无法读取，已保留原文件；请重试保存', { cause: error })
  }
  const agentEntries: NonNullable<AgentSettings['externalAgents']> = {}
  const encryptedAgentKeys: Partial<Record<ExternalAgentKind, string>> = {}
  for (const kind of kinds) {
    const entry = normalized.externalAgents?.[kind]
    if (!entry) continue
    if (kind === 'codex' && validatePreferences) {
      const existing = existingAgentEntries[kind]
      const model = entry.model?.trim() ?? ''
      const contextFields = (configuration?: ExternalAgentConfiguration) => JSON.stringify([
        configuration?.model, configuration?.modelContextWindows, configuration?.modelAutoCompactTokenLimits
      ])
      const existingContext = { ...existing, modelContextWindows: normalizeModelContextWindows(existing?.modelContextWindows), modelAutoCompactTokenLimits: normalizeModelAutoCompactTokenLimits(existing?.modelAutoCompactTokenLimits) }
      if (contextFields(entry) !== contextFields(existingContext)) {
        validateCodexAutoCompactTokenLimit(model, { baseUrl: entry.baseUrl, contextWindow: entry.modelContextWindows?.[model] }, entry.modelAutoCompactTokenLimits?.[model])
      }
      const existingOptions = normalizeReasoningEffortOptions(existing?.reasoningEffortOptions)
      const existingEffort = isReasoningEffort(existing?.reasoningEffort) && selectedReasoningEfforts(existing?.model ?? '', existingOptions).includes(existing.reasoningEffort) ? existing.reasoningEffort : undefined
      if (entry.model !== existing?.model || entry.reasoningEffort !== existingEffort || JSON.stringify(entry.reasoningEffortOptions) !== JSON.stringify(existingOptions)) {
        reasoningSelectionEffort(entry.reasoningEffort ?? 'auto', undefined, selectedReasoningEfforts(model, entry.reasoningEffortOptions))
      }
    }
    if (!entry.clearApiKey && entry.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法保存 API Key')
    agentEntries[kind] = {...entry, modelContextWindows: normalizeModelContextWindows(entry.modelContextWindows), modelAutoCompactTokenLimits: normalizeModelAutoCompactTokenLimits(entry.modelAutoCompactTokenLimits), reasoningEffortOptions: kind === 'codex' ? normalizeReasoningEffortOptions(entry.reasoningEffortOptions) : undefined, mode: entry.mode === 'hosted' ? 'hosted' : 'local', apiKey: undefined, clearApiKey: undefined, hasStoredKey: undefined}
    if (!entry.clearApiKey && entry.apiKey && safeStorage.isEncryptionAvailable()) encryptedAgentKeys[kind] = safeStorage.encryptString(entry.apiKey).toString('base64')
    else if (!entry.clearApiKey && existingAgentKeys[kind]) encryptedAgentKeys[kind] = existingAgentKeys[kind]
  }
  const stored: Record<string, unknown> = { ...normalized, externalAgents: agentEntries }
  delete stored.encryptedAgentKeys
  delete stored.encryptedKey
  if (Object.keys(encryptedAgentKeys).length) stored.encryptedAgentKeys = encryptedAgentKeys
      await writeAgentSettingsAtomically(stored)
      void pruneSavedBackgroundMedia(app.getPath('userData')).catch(error => console.warn('背景素材清理失败', error))
      const savedSettings = await readSettings(true)
      const appearance = normalizeAppearance(savedSettings)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('settings:appearance', appearance)
      }
      resolveWrite(savedSettings)
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

async function exportDiagnosticLogs(pageSnapshots: DiagnosticPageSnapshot[] = [], exportInput?: DiagnosticExportOptions, owner = mainWindow?.webContents.id ?? 0): Promise<string | null> {
  const options = diagnosticExportOptions(exportInput)
  const exportProject = currentProject
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
  // Reserve archive space for core evidence before verbose project and AI logs.
  for (const name of ['diagnostic-session.json', 'diagnostic-critical.jsonl', 'diagnostic-critical.previous.jsonl', 'diagnostic-events.jsonl', 'diagnostic-events.previous.jsonl']) {
    await collector.addFile(path.join(app.getPath('logs'), name), `app-logs/${name}`)
  }
  collector.addJson('diagnostic-operations-pending.json', diagnosticIpcOperations.snapshot())
  collector.addJson('support-request.json', { ...options, attachmentIds: undefined, exportedAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  collector.addJson('plugins/diagnostics.json', pluginDiagnosticSnapshot())
  collector.addJson('downloads/state.json', downloadActivities.snapshot())
  collector.addJson('app-runtime/update-state.json', appUpdateService?.snapshot() ?? null)
  await diagnosticAttachments.collect(collector, owner, options.attachmentIds ?? [])
  await collector.addDirectory(path.join(app.getPath('logs'), 'diagnostic-history'), 'incident-history', { maxEntries: 40 })

  const project = exportProject
  const runtimeState = optionalTestingService()?.minecraftRuntime?.getState()
  const userData = app.getPath('userData')
  await collectDiagnosticEvidence(collector, { projectPath: project?.path, userData, dataDirectory: project ? projectDataDirectory(project) : undefined, includeProjectFiles: options.includeProjectFiles })
  if (diagnosticSession?.previous.outcome === 'unconfirmed-exit') collector.addJson('native-crashes/os-events.json', await osCrashEvidence(process.execPath))
  collector.addJson('native-crashes/index.json', await summarizeDiagnosticDirectory(app.getPath('crashDumps'), 1000))
  if (options.includeCrashDumps) await collector.addDirectory(app.getPath('crashDumps'), 'native-crashes/dumps', { include: file => /\.dmp$/i.test(file), maxEntries: 100, maxBinaryBytes: 128 * 1024 * 1024 })
  if (options.includeScreenshot && mainWindow && !mainWindow.isDestroyed()) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const screenshot = await Promise.race([mainWindow.webContents.capturePage(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000) })]).finally(() => clearTimeout(timer))
    if (screenshot) collector.addBuffer('pages/current-window.png', screenshot.toPNG())
    else collector.addJson('pages/screenshot-status.json', { status: 'timeout', message: 'The unresponsive renderer did not provide a screenshot in 5 seconds.' })
  }
  await collectBuildDiagnostics(collector, { projectPath: project?.path, dataRoot: project ? path.join(project.path, projectDataDirectory(project)) : undefined, gradleUserHome: path.join(userData, 'gradle-runtime', 'cache') }).catch(error => {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'build-evidence', phase: 'error', level: 'warning', message: 'Unable to collect build evidence', error })
  })
  const appSettings = await readSettings().catch((error) => {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'settings-summary', phase: 'error', level: 'warning', message: 'Unable to read settings for diagnostics', error })
    return null
  })
  const imageSettings = !featurePluginService.enabled('image-studio') ? null : await requireImageStudio().getSettings().catch(() => null)
  const disk = await fs.statfs(userData).catch(() => null)
  const summary = {
    exportedAt,
    appVersion: app.getVersion(),
    nativeTools: await nativeToolDiagnostics(userData, app.isPackaged, process.execPath),
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
    settingsState: diagnosticValue(appSettings),
    settings: appSettings ? {
      codingBackend: appSettings.codingBackend,
      gradleDownloadSource: appSettings.gradleDownloadSource,
      preferLocalGradle: appSettings.preferLocalGradle,
      externalAgents: Object.fromEntries(Object.entries(appSettings.externalAgents ?? {}).map(([kind, value]) => [kind, value ? { configured: true, model: value.model, executableConfigured: Boolean(value.executable), baseUrl: diagnosticValue(value.baseUrl, 'baseUrl'), executable: value.executable, hasApiKey: Boolean(value.apiKey || value.hasStoredKey) } : { configured: false }])),
      imageService: imageSettings ? { baseUrl: imageSettings.baseUrl, model: imageSettings.model, hasApiKey: imageSettings.hasStoredKey } : null
    } : null,
    diagnosticJournal: diagnosticJournal.status(),
    previousSession: diagnosticSession?.previous,
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
    localServer: optionalTestingService()?.localServerManager?.getState() ?? null,
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
    if (page.state) collector.addJson(`pages/${view}.state.json`, page.state)
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
      [path.join(dataRoot, 'external-agents', 'agent-context.md'), 'project/ai/agent-context.md']
    ] as const) await collector.addFile(source, archiveName)
  }
  collector.addJson('app-runtime/minecraft-cache-summary.json', await summarizeDiagnosticDirectory(path.join(userData, 'minecraft-runtime')))
  collector.addJson('app-runtime/server-pack-creator-summary.json', await summarizeDiagnosticDirectory(path.join(userData, 'server-pack-creator')))
  await collector.addDirectory(path.join(userData, 'server-pack-creator'), 'app-runtime/server-pack-creator', { include: (relative) => /\.(?:log|json)$/i.test(relative) })
  await collector.addDirectory(app.getPath('logs'), 'app-logs', { include: relative => !/^diagnostic-(?:session\.json|(?:critical|events)(?:\.previous)?\.jsonl)$/.test(relative) && !relative.startsWith('diagnostic-history/'), descend: relative => relative !== 'diagnostic-history' })
  const entries = collector.finalize({ journal: diagnosticJournal.status() })
  await writeDiagnosticArchive(result.filePath, entries)
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

async function removeProjectAssociation(projectPath: string): Promise<ProjectInfo[]> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
  const resolved = path.resolve(projectPath)
  assertProjectMutationAllowed(resolved, '移除关联')
  const active = currentProject && sameProjectPath(currentProject.path, resolved)
  if (active) {
    assertProjectSwitchAllowed()
    if (optionalTestingService()?.minecraftRuntime?.getState().running) throw new Error('Minecraft 测试实例正在运行，请先停止后再移除关联')
  }
  // Stop accepting external operations without removing bridge files in the
  // user's original instance. A future open replaces its stale bridge config.
  if (publicMcpBridge && sameProjectPath(publicMcpBridgeProjectPath, resolved)) await stopPublicMcpBridge(true)
  const remaining = (await readRecentProjects()).filter(entry => !sameProjectPath(entry.path, resolved))
  await writeRecentProjects(remaining)
  if (currentProject && sameProjectPath(currentProject.path, resolved)) {
    currentProject = null
    emitProjectChanged()
  }
  return remaining
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
  if (optionalTestingService()?.minecraftRuntime?.getState().running) throw new Error('Minecraft 测试实例正在运行，请先停止后再删除项目')
  const recent = await readRecentProjects()
  const key = resolved.toLowerCase()
  if (!recent.some((entry) => path.resolve(entry.path).toLowerCase() === key)) throw new Error('项目不在最近项目列表中')

  try {
    await shell.trashItem(resolved)
  } catch (error) {
    const failure = new Error('项目无法放入系统回收站，需要再次确认后永久删除') as Error & { code?: string; cause?: unknown }
    failure.code = 'TRASH_UNAVAILABLE'
    failure.cause = error
    throw failure
  }
  const remaining = recent.filter((entry) => path.resolve(entry.path).toLowerCase() !== key)
  await writeRecentProjects(remaining)
  if (currentProject && sameProjectPath(currentProject.path, resolved)) currentProject = null
  await workbenchDataStore.clearProjectMirror(resolved)
  await projectKnowledgeStore().clearProject(resolved)
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

async function readSettings(strict = false): Promise<AgentSettings> {
  const defaults: AgentSettings = {
    codingBackend: 'quota',
    allowLongerContext: false,
    codexApprovalMode: 'yolo',
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
      baseUrl?: string
      model?: string
      reasoningEffort?: unknown
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('配置内容需要对象值')
    let legacyApiKey = ''
    if (stored.encryptedKey && safeStorage.isEncryptionAvailable()) {
      try { legacyApiKey = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')) } catch { /* Ignore an unreadable legacy credential. */ }
    }
    const storedReasoning = stored.reasoningEffort
    const storedAgents = stored.externalAgents && typeof stored.externalAgents === 'object' ? stored.externalAgents : {}
    const externalAgents: AgentSettings['externalAgents'] = {}
    for (const kind of ['codex'] as const) {
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
        mode: entry.mode === 'hosted' ? 'hosted' : 'local',
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.slice(0, 4096) : undefined,
        model: typeof entry.model === 'string' ? entry.model.slice(0, 512) : undefined,
        modelContextWindows: normalizeModelContextWindows(entry.modelContextWindows),
        modelAutoCompactTokenLimits: normalizeModelAutoCompactTokenLimits(entry.modelAutoCompactTokenLimits),
        reasoningEffortOptions: normalizeReasoningEffortOptions(entry.reasoningEffortOptions),
        reasoningEffort: isReasoningEffort(entry.reasoningEffort) && selectedReasoningEfforts(entry.model ?? '', normalizeReasoningEffortOptions(entry.reasoningEffortOptions)).includes(entry.reasoningEffort) ? entry.reasoningEffort : undefined,
        apiKey: agentApiKey,
        hasStoredKey: Boolean(encrypted)
      }
    }
    // Keep the former shared setting usable after the per-Agent update.
    if (!externalAgents.codex && (stored.codexExecutable || stored.externalAgentProvider === 'codex')) {
      externalAgents.codex = {executable: stored.codexExecutable, mode: 'hosted', baseUrl: stored.baseUrl, model: stored.model, reasoningEffort: storedReasoning as ExternalAgentConfiguration['reasoningEffort'], apiKey: stored.externalAgentProvider === 'codex' ? legacyApiKey : '', hasStoredKey: stored.externalAgentProvider === 'codex' && Boolean(stored.encryptedKey)}
    }
    settings = {
      externalAgents,
      allowLongerContext: stored.allowLongerContext === true,
      codexApprovalMode: normalizeAgentApprovalMode(stored.codexApprovalMode),
      codingBackend: ['quota', 'codex'].includes(String(stored.codingBackend))
        ? stored.codingBackend as AgentSettings['codingBackend']
        : 'quota',
      allowBuildScriptChanges: true,
      preferLocalGradle: false,
      gradleExecutable: typeof stored.gradleExecutable === 'string' ? stored.gradleExecutable.slice(0, 4096) : '',
      gradleDownloadSource: stored.gradleDownloadSource === 'china' || stored.gradleDownloadSource === 'official'
        ? stored.gradleDownloadSource
        : 'auto',
      networkProxyUrl: normalizeNetworkProxyUrl(stored.networkProxyUrl),
      javaPreferences: normalizeJavaPreferences(stored.javaPreferences),
      ...normalizeAppearance(stored),
      closeBehavior: stored.closeBehavior === 'tray' || stored.closeBehavior === 'quit' ? stored.closeBehavior : 'ask',
      notificationsEnabled: stored.notificationsEnabled !== false
    }
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('原配置当前无法读取，已保留原文件；请重试保存', { cause: error })
    settings = defaults
  }
  if (settings.externalAgents?.codex?.mode !== 'hosted' && !settings.externalAgents?.codex?.model) {
    const local = await readLocalCodexConfig().catch(() => null)
    if (local?.model) settings.externalAgents = { ...settings.externalAgents, codex: { ...settings.externalAgents?.codex, mode: 'local', model: local.model } }
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
  if (kind === 'codex' && input.mode !== 'hosted') {
    const local = await readLocalCodexConfig()
    // A custom provider's /models is authoritative. The CLI catalog contains
    // OpenAI defaults even when config.toml points at a different provider.
    if (local.baseUrl) {
      const apiKey = await readLocalCodexApiKey()
      return fetchAvailableModels(normalizeApiBaseUrl(local.baseUrl), apiKey, '无法读取当前服务的模型列表')
    }
    const detected = await detectInstalledCodex(input)
    const models = detected.installed ? await listLocalCodexModels(detected.executable).catch(() => []) : []
    return modelReasoningCatalog.enrich([...new Set([...models, ...local.models, ...(input.model ? [input.model] : [])])].map(id => ({ id })), '')
  }
  const stored = await readSettings()
  const baseUrl = normalizeApiBaseUrl(input.baseUrl ?? '')
  const storedEntry = stored.externalAgents?.[kind]
  const native = await readLocalCodexConfig().catch(() => null)
  const apiKey = input.apiKey?.trim() || (sameApiBaseUrl(baseUrl, storedEntry?.baseUrl) ? storedEntry?.apiKey?.trim() ?? '' : '') || (sameApiBaseUrl(baseUrl, native?.baseUrl) ? await readLocalCodexApiKey() : '')
  if (!apiKey) throw new Error('Please enter an API Key before scanning models')

  return fetchAvailableModels(baseUrl, apiKey, 'Please enter a valid Base URL and API Key')
}

async function configureExternalAgentConnection(kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) {
  if (kind !== 'codex') throw new Error('不支持的外部代理')
  const settings = await readSettings()
  const existingConfiguration = settings.externalAgents?.[kind]
  const targetBaseUrl = configuration?.mode === 'hosted' ? normalizeApiBaseUrl(configuration.baseUrl ?? '') : ''
  const sameConnection = sameApiBaseUrl(targetBaseUrl, existingConfiguration?.baseUrl)
  const native = configuration?.mode === 'hosted' && !configuration.apiKey?.trim() && !sameConnection ? await readLocalCodexConfig().catch(() => null) : null
  const apiKey = configuration?.apiKey?.trim()
    || (sameConnection ? existingConfiguration?.apiKey?.trim() : '')
    || (sameApiBaseUrl(targetBaseUrl, native?.baseUrl) ? await readLocalCodexApiKey().catch(() => '') : '')
  const nextConfiguration = {
    ...existingConfiguration,
    ...configuration,
    executable: configuration?.mode === 'hosted' ? undefined : configuration?.executable,
    apiKey: apiKey || '',
    clearApiKey: !apiKey && !sameConnection
  }
  if (nextConfiguration.mode === 'hosted') {
    nextConfiguration.baseUrl = targetBaseUrl
  }
  const next: AgentSettingsPatch = {
    codingBackend: kind,
    externalAgents: { [kind]: nextConfiguration }
  }
  // Persist first; availability, model discovery and CLI detection belong to refresh/run.
  const saved = await saveAgentSettings(next, false)
  return { kind, detail: '连接已保存到本地设置', settings: publicAgentSettings(saved) }
}

async function scanConfiguredCodex(): Promise<import('../shared/types').LocalCodexScan> {
  const configured = (await readSettings()).externalAgents?.codex ?? {}
  const status = await detectInstalledCodex(configured)
  const local = configured.mode === 'hosted' ? null : await readLocalCodexConfig()
  const connection = local ?? {
    home: app.getPath('userData'), model: configured.model ?? '',
    baseUrl: configured.baseUrl, hasApiKey: Boolean(configured.apiKey),
    contextWindow: configured.modelContextWindows?.[configured.model ?? ''],
    autoCompactTokenLimit: configured.modelAutoCompactTokenLimits?.[configured.model ?? ''],
    reasoningEffort: configured.reasoningEffort
  }
  try {
    if (configured.mode === 'hosted') {
      if (!configured.apiKey?.trim()) throw new Error('无法读取已保存的 API Key，请重新填写并保存')
      const discovered = await discoverAvailableModels(configured.baseUrl ?? '', configured.apiKey, '无法读取当前服务的模型列表')
      return { ...connection, status, baseUrl: discovered.baseUrl, models: discovered.models.map(model => model.id) }
    }
    const models = await listAvailableAgentModels('codex', configured)
    return { ...connection, status, models: models.map(model => model.id) }
  } catch (error) {
    // Detection and editing stay available offline. Never disguise a failed
    // provider lookup by falling back to the unrelated built-in GPT catalog.
    return { ...connection, status, models: [], modelsError: error instanceof Error ? error.message : '无法读取模型列表' }
  }
}

async function permanentlyDeleteProjectDirectory(projectPath: string): Promise<ProjectInfo[]> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
  const resolved = path.resolve(projectPath)
  const info = await readProjectInfo(resolved)
  if (!info) throw new Error('项目不存在或已经不是有效的 ModMind 项目')
  assertProjectMutationAllowed(info.path, '永久删除')
  assertProjectSwitchAllowed()
  if (optionalTestingService()?.minecraftRuntime?.getState().running) throw new Error('Minecraft 测试实例正在运行，请先停止后再删除项目')
  const recent = await readRecentProjects()
  if (!recent.some((entry) => sameProjectPath(entry.path, resolved))) throw new Error('项目不在最近项目列表中')
  await fs.rm(resolved, { recursive: true, force: true })
  const remaining = recent.filter((entry) => !sameProjectPath(entry.path, resolved))
  await writeRecentProjects(remaining)
  if (currentProject && sameProjectPath(currentProject.path, resolved)) currentProject = null
  await workbenchDataStore.clearProjectMirror(resolved)
  await projectKnowledgeStore().clearProject(resolved)
  return remaining
}

async function listBeginnerModels(force = false): Promise<AiModelInfo[]> {
  const revision = quotaConfiguration.current()
  const credentials = await readDeviceCredentials()
  if (!credentials) throw new Error('请先连接账号后读取模型')
  if (credentials.sync) return (await providerSync().catalog(force)).models
  await modelReasoningCatalog.refresh(force)
  let models: AiModelInfo[]
  if (credentials.provider === 'custom') {
    try { models = await quotaModelsForCredentials(credentials, force) }
    catch { models = [] }
    if (!models.some((entry) => entry.id === credentials.model)) models = [{ id: credentials.model! }, ...models]
  } else {
    const catalog = await getQuotaModelCatalog(force)
    if (catalog.stale) throw new Error(catalog.message || '无法读取模型目录')
    return modelReasoningCatalog.enrich(catalog.models, openAiV1BaseUrl(credentials.baseUrl))
  }
  if (models.length && !await quotaRouter().recoveryRequired()) await reconcileQuotaModelPreferences(credentials, false, models, revision)
  return models
}

async function discoverAvailableModels(baseUrl: string, apiKey: string, errorMessage: string): Promise<{ baseUrl: string; models: AiModelInfo[] }> {
  const revision = quotaConfiguration.current()
  await modelReasoningCatalog.refresh()
  const normalized = normalizeApiBaseUrl(baseUrl)
  const url = new URL(normalized)
  const bases = [normalized]
  if (!/\/v\d+(?:beta\d*)?$/i.test(url.pathname.replace(/\/$/, ''))) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1`
    bases.push(url.toString().replace(/\/$/, ''))
  }
  let empty: { baseUrl: string; models: AiModelInfo[] } | undefined
  let invalidPayload = false
  for (const candidate of bases) {
    for (const suffix of ['models', 'model']) {
      const endpoint = new URL(candidate)
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${suffix}`
      let response: Response
      try {
        response = await networkFetch(endpoint.toString(), {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(20_000)
        })
      } catch (error) {
        const failure = error as { name?: string; code?: string; cause?: { code?: string } } | null
        const code = failure?.cause?.code ?? failure?.code ?? ''
        const reason = failure?.name === 'TimeoutError' || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)
          ? '网络请求超时'
          : /^(?:ENOTFOUND|EAI_AGAIN)$/.test(code) ? '无法解析供应商地址'
          : /^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code) ? '供应商证书校验失败'
          : '网络连接失败'
        throw new Error(`${errorMessage}（${reason}），请检查网络后重试`)
      }
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) continue
        // Authentication, quota and server failures are not missing route errors.
        throw new Error(`${errorMessage}（HTTP ${response.status}）`)
      }
      let payload: unknown
      try { payload = await response.json() as unknown } catch { invalidPayload = true; continue }
      const models = orderModelsForAgent(modelReasoningCatalog.enrich(parseModelPayload(payload), candidate))
      if (!models.length) { empty ??= { baseUrl: candidate, models }; continue }
      for (const keyBase of new Set([normalized, candidate])) {
        if (revision === quotaConfiguration.current()) scannedModelCapabilities.set(quotaPreferenceKey(keyBase, apiKey), { checkedAt: Date.now(), models })
      }
      return { baseUrl: candidate, models }
    }
  }
  if (empty) return empty
  throw new Error(invalidPayload ? `${errorMessage}（模型服务返回了无效数据）` : `${errorMessage}（模型列表接口不存在或不支持访问），请检查供应商 API 地址或重新同步连接`)
}

async function fetchAvailableModels(baseUrl: string, apiKey: string, errorMessage: string): Promise<AiModelInfo[]> {
  return (await discoverAvailableModels(baseUrl, apiKey, errorMessage)).models
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
  assertAgentWriteAllowed(project.path, relativePath)
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
  return withProjectMutation(project.path, async () => {
    const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
    const snapshotPath = path.join(project.path, projectDataDirectory(project), 'snapshots', id, 'files')
    const copied = await copySnapshotFilesIncremental(
      project.path,
      snapshotPath,
      ignoreSnapshotDirectory,
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
    invalidateSnapshotCatalog(project.path, id)
    invalidateSnapshotStorage(project.path, id)
    void publishSnapshotStorage(project.path).catch(() => undefined)
    return info
  })
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
  return await fs.readFile(target, 'utf8').then((value) => {
    const manifest = JSON.parse(value) as SnapshotInfo
    return { id: manifest.id, label: manifest.label, createdAt: manifest.createdAt, fileCount: manifest.fileCount }
  }).catch(() => null)
}

function sendAiProgress(event: Electron.IpcMainInvokeEvent, item: PipelineEvent, sessionId?: string, projectPath?: string, runId?: string): void {
  const run = runId ? activeAiRuns.get(runId) ?? recentAiRunRoutes.get(runId) : undefined
  const actualBackend = run?.backend
  const routedItem: PipelineEvent = {
    ...item,
    ...(run?.conversationId ? { conversationId: run.conversationId } : {}),
    ...(run?.generation !== undefined ? { generation: run.generation } : {}),
    ...(run?.turnId ? { turnId: run.turnId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(actualBackend ? { backend: actualBackend } : {})
  }
  diagnosticJournal.record({
    subsystem: 'ai',
    operation: item.stage,
    phase: item.status === 'error' && item.terminal !== false ? 'error' : item.status,
    level: item.status === 'error' && item.terminal !== false ? 'error' : item.status === 'warning' || item.status === 'error' ? 'warning' : 'info',
    message: item.title,
    data: { detail: item.detail, sessionId, projectPath, runId, conversationId: routedItem.conversationId, turnId: routedItem.turnId, todo: item.todo }
  })
  const publish = (value: PipelineEvent): void => {
    const payload = { ...value, title: value.status === 'error' ? '任务未完成' : sanitizeAiUserText(value.title), detail: value.status === 'error' ? describeAiFailureForUser(value.detail || value.title) : sanitizeAiUserText(value.detail) }
    const windows = BrowserWindow.getAllWindows()
    if (windows.length) {
      for (const window of windows) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('ai:progress', payload)
    } else if (!event.sender.isDestroyed()) event.sender.send('ai:progress', payload)
  }
  if (projectPath && routedItem.conversationId && routedItem.turnId && routedItem.generation !== undefined) {
    void conversationStore.appendProgress(projectPath, routedItem).then(publish).catch(() => publish(routedItem))
  } else publish(routedItem)
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
  }).catch((error) => {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'ai-audit-write', phase: 'error', message: 'Unable to persist AI attempt audit', error })
  })
}

function sendAiOutput(
  event: Electron.IpcMainInvokeEvent,
  kind: AiOutputEvent['kind'],
  content: string,
  sessionId?: string,
  projectPath?: string,
  runId?: string,
  options?: Pick<AiOutputEvent, 'terminal' | 'recoverable' | 'usage' | 'backend' | 'itemId' | 'streamId' | 'notice' | 'reasoning' | 'activity' | 'inspirationArtifact'>
): void {
  const time = new Date().toISOString()
  const safeContent = kind === 'error' ? describeAiFailureForUser(content) : sanitizeAiUserText(content)
  const run = runId ? activeAiRuns.get(runId) ?? recentAiRunRoutes.get(runId) : undefined
  const actualBackend = options?.backend ?? run?.backend
  const terminalError = kind === 'error' && options?.terminal !== false
  const notice = options?.notice ?? ((kind === 'error' || kind === 'warning') && options?.terminal === true ? aiNoticeDetails(kind, safeContent) : undefined)
  const payload: AiOutputEvent = { ...(run?.surface === 'inspiration' ? { inspirationFeatures: run.inspirationFeatures } : {}), kind, content: safeContent, time, ...(sessionId ? { sessionId } : {}), ...(projectPath ? { projectPath } : {}), ...(runId ? { runId } : {}), ...(actualBackend ? { backend: actualBackend } : {}), ...(run?.conversationId ? { conversationId: run.conversationId } : {}), ...(run?.generation !== undefined ? { generation: run.generation } : {}), ...(run?.turnId ? { turnId: run.turnId } : {}), ...(options?.itemId ? { itemId: options.itemId } : {}), ...(options?.streamId ? { streamId: options.streamId } : {}), ...(options?.usage ? { usage: options.usage } : {}), ...(options?.terminal !== undefined ? { terminal: options.terminal } : {}), ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}) }
  if (options?.inspirationArtifact) payload.inspirationArtifact = options.inspirationArtifact
  if (options?.reasoning) payload.reasoning = options.reasoning
  if (options?.activity) payload.activity = options.activity
  const streaming = kind === 'delta' || kind === 'reasoning' && options?.reasoning?.phase === 'delta'
  if (!streaming) {
    if (notice) payload.notice = notice
    diagnosticJournal.record({
      subsystem: 'ai',
      operation: 'output',
      phase: terminalError ? 'error' : kind,
      level: terminalError ? 'error' : kind === 'warning' || kind === 'error' ? 'warning' : 'info',
      message: kind === 'error' || kind === 'warning' ? safeContent : `AI output event: ${kind}`,
      data: { kind, sessionId, runId, itemId: options?.itemId, streamId: options?.streamId, projectPath, contentLength: content.length, contentLog: 'ai-output-events.jsonl', ...(kind === 'error' || kind === 'warning' ? { originalContent: content } : {}) }
    })
  }
  if (!streaming) {
    const logPayload = { ...payload, content: safeContent.slice(-64_000) }
    aiOutputLogWrite = aiOutputLogWrite.then(async () => {
      await fs.mkdir(app.getPath('logs'), { recursive: true })
      await fs.appendFile(path.join(app.getPath('logs'), 'ai-output-events.jsonl'), `${redactDiagnosticText(JSON.stringify(logPayload))}\n`, 'utf8')
    }).catch((error) => {
      diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'ai-output-write', phase: 'error', message: 'Unable to persist AI output log', error })
    })
  }
  const publish = (value: AiOutputEvent): void => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length) {
      for (const window of windows) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('ai:output', value)
    } else if (!event.sender.isDestroyed()) event.sender.send('ai:output', value)
  }
  if (projectPath && payload.conversationId && payload.turnId && payload.generation !== undefined) {
    void conversationStore.appendOutput(projectPath, payload).then(publish).catch(() => publish(payload))
  } else publish(payload)
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
  inspirationFeatures?: import('../shared/inspirationFeatures').InspirationFeatures
  id: string
  senderId: number
  startedAt: string
  sessionId?: string
  sessionScope?: string
  projectPath: string
  executionProfile: AiExecutionProfile
  backend: AgentSettings['codingBackend']
  surface: AiSurface
  workbenchPhase?: 'discussion'
  conversationId?: string
  generation?: number
  turnId?: string
  quotaAccount?: string
}

const aiAbortControllers = new Map<string | number, AbortController>()
const aiCancelRequests = new Set<string | number>()
const activeAiRuns = new Map<string, ActiveAiRun>()
const recentAiRunRoutes = new Map<string, ActiveAiRun>()
const aiBackendSwitchCoordinator = new BackendSwitchCoordinator<AgentSettings, { backend: AgentSettings['codingBackend']; switchId?: number }>()
const activeAiBackendSwitches = new Map<string, { sequence: number; controller: AbortController }>()
const REMOTE_SENDER_ID = -1
const AI_CANCEL_CONFIRM_TIMEOUT_MS = 8_000
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
    if (!await readDeviceCredentials()) throw new Error('请先连接 ModMind 账号，再切换到 ModMind')
    return
  }

  const configured = settings.externalAgents?.[backend] ?? {}
  if (backend === 'codex') {
    const usesConfiguredService = configured.mode === 'hosted'
    if (usesConfiguredService) {
      await configuredCodexServerConfig(configured)
      return
    }
    const detected = await detectInstalledCodex(configured)
    if (!detected.installed) throw new Error('未检测到本机 Codex，请先安装 Codex CLI')
    return
  }

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
  recentAiRunRoutes.set(run.id, run)
}

async function withAiRun<T>(run: ActiveAiRun, controller: AbortController, operation: () => Promise<T>): Promise<T> {
  if (quitRequested) throw new Error('应用正在退出，不能开始新任务')
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
    if (run.surface === 'workspace') {
      void publishSnapshotStorage(run.projectPath).catch(() => undefined)
    }
    const route = recentAiRunRoutes.get(run.id)
    const timer = setTimeout(() => { if (recentAiRunRoutes.get(run.id) === route) recentAiRunRoutes.delete(run.id) }, 60_000)
    timer.unref?.()
  }
}

async function resolveAiProject(options?: AiCreateCodeOptions): Promise<ProjectInfo> {
  const requestedPath = options?.projectPath?.trim()
  const project = requestedPath ? await readProjectInfo(path.resolve(requestedPath)) : requireProject()
  if (!project) throw new Error('AI 任务指定的项目不存在或不是有效 ModMind 项目')
  if (!project.draft) studios().require(project)
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

async function runModpackModuleWorkbench(
  pack: ProjectInfo, input: Record<string, unknown>, backend: AgentSettings['codingBackend'], signal: AbortSignal,
  callbacks: { beforeRun?: (module: ProjectInfo) => Promise<void>; onActivity?: (text: string) => void; workbenchFeatures?: WorkbenchFeatures } = {}
) {
  return delegateModpackModule(pack, input, {
    signal,
    beforeRun: async module => {
      assertProjectMutationAllowed(module.path, '委派自制 Mod 开发')
      await callbacks.beforeRun?.(module)
    },
    run: async (module, request, parentSignal) => {
      const controller = new AbortController()
      const abort = (): void => controller.abort(parentSignal.reason)
      parentSignal.addEventListener('abort', abort, { once: true })
      if (parentSignal.aborted) abort()
      const conversationId = `ws-delegated-${randomUUID()}`
      const turnId = `turn-${randomUUID()}`
      const sessionId = `delegated-${randomUUID()}`
      const run: ActiveAiRun = {
        id: aiRunId(REMOTE_SENDER_ID, module.path, sessionId), senderId: REMOTE_SENDER_ID,
        startedAt: new Date().toISOString(), sessionId, sessionScope: `workspace/${conversationId}`,
        projectPath: module.path, executionProfile: 'standard', backend, surface: 'workspace',
        conversationId, generation: 0, turnId
      }
      try {
        callbacks.onActivity?.(`已将需求交给「${module.name}」的独立工作台`)
        const result = await withAiRun(run, controller, async () => {
          throwIfAborted(controller.signal)
          const prepared = await prepareConversationRequest(module, request, 'workspace', {
            runId: run.id, conversationId, turnId, sessionScope: run.sessionScope, projectPath: module.path
          })
          return runExternalCodingAgent(
            remoteInvokeEvent(text => callbacks.onActivity?.(`[${module.name}] ${text}`)),
            request, sessionId, backend, 'standard', undefined,
            { ...prepared.options, runId: run.id, surface: 'workspace', workbenchFeatures: callbacks.workbenchFeatures }, controller.signal,
            { onProgress: item => callbacks.onActivity?.(`[${module.name}] ${item.title}${item.detail ? `：${item.detail}` : ''}`) }
          )
        })
        // A child answer is separate from build evidence and pack integration.
        await resolveAgentModpackModule(pack, module.namespace)
        const feedback = new CreationFeedbackService(module)
        const state = await feedback.state()
        const delivery = state.tasks.find(task => task.id === turnId)?.delivery
        return {
          status: delivery?.status ?? 'completed', namespace: module.namespace, projectPath: module.path, conversationId,
          summary: result.finalResponse ?? result.summary, changedFiles: result.changedFiles,
          tests: result.tests, warnings: result.warnings, remaining: delivery?.remaining ?? [],
          buildVerified: await feedback.verifyLatestBuild(), packIntegrationVerified: false,
          nextStep: '检查委派结果和未完成事项。完成源码任务后调用 modmind_build_project 编译并同步整合包；再按改动进行整合包运行验证。'
        }
      } finally { parentSignal.removeEventListener('abort', abort) }
    }
  })
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
  const credentials = await readDeviceCredentials()
  if (credentials?.provider === 'custom') return { status: 'disabled', enabled: false, lastError: '自定义 API 模式暂不支持远程工作台' }
  if (force) await writeRemoteEnabled(true)
  if (!credentials) return { status: 'disabled', enabled: false, lastError: '请先连接 ModMind 账号' }
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
    onCommand: (command, context) => diagnosticIpcOperations.run('remote', 'command', { remoteRequestId: command.requestId, input: diagnosticValue(command) }, () => controller.handle(command.text, { signal: context.signal, onActivity: context.activity })),
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
  if (featurePluginService.hasBusyRuntime()) throw new Error('功能测试会话正在准备或运行，请先停止后再切换项目')
  if (optionalTestingService()?.isolatedServerScenarios?.isBusy()) throw new Error('隔离服务端测试正在运行，请先取消后再切换项目')
  if (optionalTestingService()?.localTestService?.isBusy()) throw new Error('本机测试正在准备或运行，请先停止后再切换项目')
  if (optionalTestingService()?.localServerManager?.isBusy()) throw new Error('本机服务端正在准备或运行，请先停止后再切换项目')
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

async function prepareConversationRequest(project: ProjectInfo, prompt: string, surface: AiSurface, options: AiCreateCodeOptions, recovery?: ActiveAiTask): Promise<{ options: AiCreateCodeOptions; document: Awaited<ReturnType<typeof conversationStore.read> >; turnId: string }> {
  const conversationId = options.conversationId?.trim() || recovery?.conversationId || `${surface === 'workspace' ? 'ws' : 'idea'}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const created = await conversationStore.readContext(project.path, conversationId) ?? await conversationStore.create(project.path, { id: conversationId, surface, agentMode: options.agentMode ?? recovery?.agentMode })
  const generation = options.generation ?? created.generation
  const turnId = options.turnId?.trim() || `turn-${randomUUID()}`
  const nextOptions = { ...options, ...(created.agentMode ? { agentMode: created.agentMode } : {}), conversationId, generation, turnId }
  // The user turn is the recovery boundary. Native provider output is appended
  // later, but the request itself is durable before the provider is spawned.
  const existing = Boolean(options.turnId) && await conversationStore.hasUserTurn(project.path, conversationId, generation, turnId)
  if (!existing) await conversationStore.appendUser(project.path, conversationId, generation, turnId, { prompt }, options.runId)
  return { options: nextOptions, document: await conversationStore.readContext(project.path, conversationId), turnId }
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

interface ActiveAiTask {
  agentMode?: 'beginner'
  modelSelection?: AiModelSelection
  workbenchFeatures?: WorkbenchFeatures
  taskId: string
  runId?: string
  projectPath: string
  snapshotId: string
  startedAt: string
  changedFiles: string[]
  prompt: string
  fallbackPrompt?: string
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
  return listManagedFiles(root, ignoreSnapshotDirectory)
}

async function restoreSnapshotFilesExact(snapshotRoot: string, destinationRoot: string, expectedFiles: string[], hashes?: Record<string, string>): Promise<void> {
  await restoreManagedTreeExact(
    snapshotRoot,
    destinationRoot,
    expectedFiles,
    ignoreSnapshotDirectory,
    (source, destination) => copySnapshotFiles(source, destination, ignoreSnapshotDirectory),
    hashes
  )
}

async function readSnapshotManifest(project: ProjectInfo, id: string): Promise<{ manifest: SnapshotManifest; root: string }> {
  const validId = validateSnapshotId(id)
  const directory = path.join(project.path, projectDataDirectory(project), 'snapshots', validId)
  const root = path.join(directory, 'files')
  assertAgentWriteAllowed(project.path, path.relative(project.path, root))
  await migrateSelectedSnapshotMetadata(project, validId)
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
  await restoreSnapshotFilesExact(snapshot.root, project.path, expectedFiles, snapshot.manifest.hashes)
}

async function restoreProjectSnapshot(id: string, projectPath?: string): Promise<SnapshotRestoreResult> {
  assertProjectSwitchAllowed()
  const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
  if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
  return withProjectMutation(project.path, async () => {
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
      const { id: snapshotId, label, createdAt, fileCount } = selected.manifest
      return { snapshot: { id: snapshotId, label, createdAt, fileCount }, backup, project: restoredProject }
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
  })
}

function modpackMigrationDirectory(project: ProjectInfo, migrationId?: string): string {
  const root = path.join(project.path, projectDataDirectory(project), 'migrations')
  return migrationId ? path.join(root, migrationId) : root
}

function validateMigrationId(value: unknown): string {
  if (typeof value !== 'string' || !/^migration-[0-9A-Za-z._-]{1,120}$/.test(value)) throw new Error('迁移记录 ID 无效')
  return value
}
async function writeModpackMigrationRecord(project: ProjectInfo, record: ModpackMigrationRecord): Promise<void> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').writeModpackMigrationRecord(project, record) }


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
async function preserveDirectMigrationSources(project: ProjectInfo, migrationId: string): Promise<void> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').preserveDirectMigrationSources(project, migrationId) }

async function applyModpackMigrationInPlace(
  project: ProjectInfo,
  target: Awaited<ReturnType<LoaderCatalog['resolve']>>,
  input: ModpackMigrationCreateInput
): Promise<ModpackMigrationCreateResult> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').applyModpackMigrationInPlace(project, target, input) }

async function undoModpackMigration(project: ProjectInfo, migrationId: string): Promise<ModpackMigrationUndoResult> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').undoModpackMigration(project, migrationId) }


async function deleteProjectSnapshots(ids: unknown, projectPath?: string): Promise<SnapshotBatchDeleteResult> {
  const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
  if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
  return withProjectMutation(project.path, async () => {
    assertProjectMutationAllowed(project.path, '删除快照')
    const migrations = await listModpackMigrationRecords(project)
    const active = await readActiveAiTask(project)
    const result = await deleteSnapshotSelection(project.path, ids, {
      read: async id => { const selected = await readSnapshotManifest(project, id); return { id: selected.manifest.id, directory: path.dirname(selected.root) } },
      protectedReason: id => {
        const migration = migrations.find(record => (record.status !== 'undone' && record.sourceSnapshotId === id) || record.preUndoSnapshotId === id)
        if (migration) return '该快照是迁移 ' + migration.id + ' 的恢复依据，不能从普通快照列表删除'
        if (active?.snapshotId === id) return '不能删除当前 AI 恢复任务依赖的快照'
        return undefined
      },
      onDeleted: id => { invalidateSnapshotCatalog(project.path, id); invalidateSnapshotStorage(project.path, id) }
    })
    if (result.deletedIds.length) void publishSnapshotStorage(project.path).catch(() => undefined)
    return { ...result, snapshots: await listSnapshotSummaries(project.path) }
  })
}

async function deleteProjectSnapshot(id: string, projectPath?: string): Promise<SnapshotInfo[]> {
  const result = await deleteProjectSnapshots([id], projectPath)
  if (result.failed.length) throw new Error(result.failed[0].message)
  return result.snapshots
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
async function resolveAddonImportPaths(project: ProjectInfo, values: string[]): Promise<string[]> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').resolveAddonImportPaths(project, values) }

function normalizeAddonPrepareInput(input: Record<string, unknown> | AddonPrepareInput): AddonPrepareInput { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').normalizeAddonPrepareInput(input) }
async function linkAddonProject(project: ProjectInfo, projectPath: string, signal?: AbortSignal): Promise<unknown> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/relationships/main').activate>>('relationships').linkAddonProject(project, projectPath, signal) }

async function resolveModpackMigrationTarget(input: Record<string, unknown>): Promise<Awaited<ReturnType<LoaderCatalog['resolve']>>> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').resolveModpackMigrationTarget(input) }

function normalizeMcpMigrationInput(project: ProjectInfo, input: Record<string, unknown>): ModpackMigrationCreateInput { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').normalizeMcpMigrationInput(project, input) }

async function previewModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').previewModpackMigrationForAgent(project, input) }

async function applyModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<ModpackMigrationCreateResult> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-migration/main').activate>>('modpack-migration').applyModpackMigrationForAgent(project, input) }


function featureAgentHandlers(project: ProjectInfo, signal: AbortSignal, event?: import('electron').IpcMainInvokeEvent, automaticFeatures = false): Pick<ExternalAgentBridgeHandlers, 'featureCatalog' | 'featureTools' | 'featureInvoke' | 'featureRecommend' | 'featureInstallMode' | 'studioInspect' | 'studioAdopt'> {
  const source = async (input: Record<string, unknown>): Promise<string> => {
    signal.throwIfAborted()
    if (typeof input.sourcePath !== 'string' || !input.sourcePath.trim() || path.isAbsolute(input.sourcePath)) throw new Error('请提供当前项目内的相对目录')
    const root = await fs.realpath(project.path), target = await fs.realpath(resolveProjectPathFor(project, input.sourcePath))
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(target)).isDirectory()) throw new Error('接管源必须是当前项目内的子目录，不能越过项目边界')
    return target
  }
  return {
    studioInspect: async input => inspectStudioSource(await source(input)),
    studioAdopt: async input => {
      const sourcePath = await source(input)
      assertProjectMutationAllowed(project.path, '接管项目子目录')
      assertAgentWriteAllowed(project.path, path.relative(await fs.realpath(project.path), path.join(sourcePath, currentProjectManifest)))
      const analysis = await inspectStudioSource(sourcePath)
      if (analysis.kind !== 'complete') throw new Error('MCP 接管只支持完整项目文件夹；压缩包、整合包和参考资料请使用项目页接管入口')
      const selected = studios().select({ ...analysis.inferred, ...input } as ProjectCreateInput)
      if (analysis.studio?.id !== selected.definition.id) throw new Error('工作台与识别结果不匹配')
      const projectInfo = await studioAdoptionBackground.run(true, () => adoptStudioProject({ ...analysis.inferred, ...input, sourcePath } as ExistingProjectAdoptInput))
      return { status: 'verified', project: projectInfo, activeProjectPath: project.path }
    },
    featureCatalog: async () => (featureStoreService?.agentCatalog() ?? featurePluginService.catalog()).filter(entry => featureDefinitionApplies(entry.manifest, project)),
    featureInstallMode: automaticFeatures ? 'automatic' : 'manual',
    featureRecommend: input => featureStoreService.recommend(input, automaticFeatures, signal),
    featureTools: async surface => featurePluginService.tools(surface, project),
    featureInvoke: (id, action, input, context) => aiProjectContext.run(project, async () => {
      signal.throwIfAborted()
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents === event?.sender) ?? mainWindow
      const invoke = () => featurePluginService.invoke(id, action, input, { ...context, signal, windowId: window?.id })
      return event ? nativeFeatureEvent.run(event, invoke) : invoke()
    })
  }
}

async function createPublicMcpBridgeHandlers(project: ProjectInfo, signal: AbortSignal): Promise<ExternalAgentBridgeHandlers> {
  const moduleTasks = new ModpackModuleTasks(signal, async (input, childSignal) => runModpackModuleWorkbench(project, input, (await readSettings()).codingBackend, childSignal))
  const testOwnerSignal = signal
  const buildTasks = new ManagedBuildTasks(signal, async buildSignal => {
    moduleTasks.assertCollected()
    const artifact = await aiProjectContext.run(project, () => buildProjectWithLock(buildSignal))
    return { success: true, artifact }
  }, () => ({ ...requireMinecraftRuntime().buildRecoveryState(), buildDiagnostics: gradleDiagnosticState(project.path) }))
  const localReviewConfig: AiReviewerConfig = {
    reviewMode: 'codex-auto',
    codexExecutable: managedCodexExecutablePath(app.getPath('userData')),
    projectPath: project.path
  }
  const handlers: ExternalAgentBridgeHandlers = {
    ...featureAgentHandlers(project, signal),
    modpackModules: input => inspectModpackModules(project, input),
    modpackDelegateModule: async input => moduleTasks.start(input),
    modpackModuleTask: input => moduleTasks.read(input),
    get projectInfo() { return { ...project, studio: studios().context(project, 'workbench'), integrationDirectory: path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents') } },
    serverOperation: input => localServerAgentOperation(project, input, signal),
    creationContext: input => creationContextOperation(project, input),
    projectKnowledgeRead: () => projectKnowledgeStore().read(project.path),
    snapshotQuery: async input => snapshotListPage(project.path, await listSnapshotSummaries(project.path), input),
    snapshotDelete: async input => { if (input.operation !== 'deleteSnapshots' || input.confirmed !== true || Object.keys(input).some(key => !['operation', 'ids', 'confirmed'].includes(key))) throw new Error('请确认删除所选快照'); const result = await deleteProjectSnapshots(input.ids, project.path); return { projectPath: project.path, deletedIds: result.deletedIds, failed: result.failed, remainingCount: result.snapshots.length } },
    projectKnowledgeSave: input => projectKnowledgeStore().save(project.path, input),
    playerTest: (category, input) => requireTestingService().playerTestService.execute(project, category, input, signal),
    projectSearch: (query, limit) => searchProjectText(project, query, limit),
    projectFiles: async () => {
      return projectSearchFiles(project)
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
    testOwnerSignal,
    testMatrix: (targets, taskSignal) => { moduleTasks.assertCollected(); buildTasks.assertCollected(); return runProjectTestMatrix(targets.filter((target): target is TestTarget => ['build', 'client', 'server', 'gametest'].includes(target)), taskSignal ? AbortSignal.any([signal, taskSignal]) : signal) },
    testRendered: (taskSignal) => { moduleTasks.assertCollected(); buildTasks.assertCollected(); return runManagedRenderedTest(project, taskSignal ? AbortSignal.any([signal, taskSignal]) : signal) },
    build: input => buildTasks.invoke(input),
    testMinecraft: async (taskSignal) => {
          const signal = taskSignal ? AbortSignal.any([taskSignal, testOwnerSignal]) : testOwnerSignal
      moduleTasks.assertCollected()
      buildTasks.assertCollected()
      if (project.kind === 'server-plugin') return localServerAgentOperation(project, { operation: 'start' }, signal)
      const result = await runHeadlessMinecraftSmoke(project, signal, { stableWindowMs: 20_000, offline: true })
      if (!result.success) throw new Error(result.message || 'HeadlessMC smoke test failed')
      return result
    },
    runtimeState: async () => ({ buildDiagnostics: gradleDiagnosticState(project.path), ...requireMinecraftRuntime().getState(), ...(isModpackProject(project) ? { modpackImport: await readModpackImportStatus(project) } : {}) }),
    javaHomeScan: () => scanConfiguredJavaHomes(),
    javaHomeProbe: (home) => probeJavaHomeInfo(home),
    appSettingsRead: async () => publicAgentSettings(await readSettings()),
        diagnosticsRead: input => Promise.resolve(readDiagnosticState(project.path, input)),
        modpackLock: input => manageModpackLock(project, input),
    quotaModelsRead: (force) => getQuotaModelCatalog(force),
    quotaModelsDiscover: () => {
      if (!currentProject || !sameProjectPath(currentProject.path, project.path)) throw new Error('项目已切换，请从当前项目重新操作')
      return discoverQuotaModels()
    },
    quotaModelSelect: (model, selection) => {
      if (!currentProject || !sameProjectPath(currentProject.path, project.path)) throw new Error('项目已切换，请从当前项目重新操作')
      return selectQuotaModel(model, selection)
    },
    appSettingsWrite: (input) => applyAppSettingWrite(input),
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
      return withMinecraftResourceLock(() => managedServerJoin({ project, outputDirectory, port, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, headless: requireHeadlessMc(), gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'server-join'), managedMinecraftDirectory: requireMinecraftRuntime().managedMinecraftDirectory(), onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
    },
    modpackRunServerScenario: async (input) => {
      if (input.fixture || input.operation) return requireTestingService().isolatedServerScenarioOperation(project, input, signal)
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
      return withMinecraftResourceLock(() => managedServerScenario({ project, outputDirectory, port, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, steps, onEvent: (value) => mainWindow?.webContents.send('minecraft:event', value) }))
    },
    imageProjectAssets: async () => {
      const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap((node) => node.type === 'directory' ? flatten(node.children ?? []) : [node])
      return flatten(await listDirectory(project.path)).filter((node) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(node.path)).slice(0, 500).map((node) => node.path)
    },
    imageReadProjectAsset: async (relativePath) => {
      return { path: relativePath, dataUrl: await readProjectImage(project.path, relativePath) }
    }
  }
  return handlers
}

async function startPublicMcpBridge(projectPath?: string): Promise<{ projectPath: string; bridgeConfigPath: string; mcpConfigPath: string; serverPath: string }> {
  const requestedPath = projectPath?.trim() ? path.resolve(projectPath.trim()) : undefined
  const project = requestedPath ? await readProjectInfo(requestedPath) : currentProject
  if (!project) throw new Error('a ModMind project is required; pass --project <path>')
  if (!project.draft) studios().require(project)
  if (publicMcpBridge && sameProjectPath(publicMcpBridgeProjectPath, project.path)) {
    const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents')
    return { projectPath: project.path, bridgeConfigPath: path.join(directory, 'bridge.json'), mcpConfigPath: path.join(directory, 'mcp-config.json'), serverPath: path.join(directory, 'modmind-mcp-server.mjs') }
  }
  await stopPublicMcpBridge()
  currentProject = project
  await rememberRecentProject(project)
  await refreshExternalAgentContext(project, featurePluginService.enabled('image-studio')).catch(() => undefined)
  const controller = new AbortController()
  const handlers = await createPublicMcpBridgeHandlers(project, controller.signal)
  const bridge = new ModMindBridge(project, handlers, app.getVersion(), bundledCodexSkillsDirectory(), false, undefined, createPluginBridgeTarget(project.path), undefined, undefined, userSkillStore)
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

async function stopPublicMcpBridge(preserveFiles = false): Promise<void> {
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
  await bridge.stop(preserveFiles)
  if (projectPath && !preserveFiles) {
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
  const selected = await readSnapshotManifest(project, active.snapshotId)
  if (!selected.manifest.files) throw new Error('恢复快照缺少文件清单，当前项目和恢复点已保留')
  const backup = await createProjectSnapshot('Recovery backup before restoring interrupted AI task')
  const snapshotRoot = path.join(project.path, projectDataDirectory(project), 'snapshots', recovery.snapshot.id, 'files')
  await restoreManagedPathsFromSnapshot(snapshotRoot, project.path, active.changedFiles ?? [], { files: selected.manifest.files, hashes: selected.manifest.hashes })
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
  if (error instanceof Error && error.name === 'ExternalAgentContextStallError') return error.message
  diagnosticJournal.record({ subsystem: 'ai', operation: 'task-error', phase: 'error', level: 'error', message: 'AI task failed before user-facing translation', error })
  if (error instanceof Error && error.name === 'AbortError') return 'Agent 任务已停止，停止前完成的修改已保留'
  if (error instanceof Error && error.name === 'TimeoutError') return describeAiFailureForUser('上游模型响应超时')
  return describeAiFailureForUser(sanitizeAiUserText(error instanceof Error ? error.message : String(error)))
}

function isRecoverableAgentRunError(error: unknown, message: string): boolean {
  if (error instanceof Error && ['AbortError', 'ExternalAgentContextStallError', 'ExternalAgentTransientFailureError', 'ExternalAgentNoOutputTimeoutError', 'ExternalAgentEmptyResponseError', 'ResumedPromptRejectionError'].includes(error.name)) return true
  return /Review Agent rejected completion|Mandatory workflow incomplete|ModMind 完成检查未通过|recovery snapshot|recovery point|session.{0,40}reject|no-output-timeout|timed out|timeout|stream disconnected|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|ENOTFOUND|(?:^|\D)(?:401|402|403|404|429|500|502|503|504)(?:\D|$)|API Key|审计|工作流未完成|恢复(?:点|快照)|线路繁忙|连接中断|响应超时|没有返回任何内容|会话.{0,20}拒绝|凭证已失效|额度不足|模型接口或所选模型不存在/i.test(message)
}

async function managedCodingHashes(project: ProjectInfo): Promise<Map<string, string>> {
  return managedCodingHashesAt(project.path)
}

async function managedCodingHashesAt(root: string): Promise<Map<string, string>> {
  const files = await listManagedFiles(root, ignoreSnapshotDirectory)
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
      ...(projectPath ? { reviewMode: 'codex-auto' as const, codexExecutable: managedCodexExecutablePath(app.getPath('userData')), projectPath } : {})
    }
  }
  const configured = settings.externalAgents?.[backend]
  if (backend === 'codex' && projectPath) {
    const local = configured?.mode !== 'hosted'
    return {
      ...(!local && configured?.baseUrl?.trim() ? { baseUrl: normalizeApiBaseUrl(configured.baseUrl) } : {}),
      ...(!local && configured?.apiKey?.trim() ? { apiKey: configured.apiKey.trim() } : {}),
      ...(configured?.model?.trim() ? { model: configured.model.trim() } : {}),
      reasoningEffort: configured?.reasoningEffort,
      reviewMode: 'codex-auto',
      codexExecutable: local ? (await detectInstalledCodex(configured)).executable : managedCodexExecutablePath(app.getPath('userData')),
      projectPath,
      ...(!local && configured?.apiKey?.trim() ? { environment: { MODMIND_THIRD_PARTY_API_KEY: configured.apiKey.trim() } } : {})
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
function parseReleaseSummary(content: string, fallback: ReleaseSummaryDraft): ReleaseSummaryDraft { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/publishing/main').activate>>('publishing').parseReleaseSummary(content, fallback) }

async function requestProjectAiName(project: ProjectInfo, prompt: string, sessionScope: string, backend?: AgentSettings['codingBackend'], modelSelection?: AiModelSelection): Promise<string> {
  const settings = await readSettings()
  const selected = backend === 'quota' || backend === 'codex' ? backend : settings.codingBackend
  const config = selected === 'quota'
    ? await readBeginnerAgentServerConfig(modelSelection).catch(() => null)
    : await getAiReviewerConfig(false, selected, settings).catch(() => null)
  return requestAiName({ prompt, config, model: modelSelection?.model, ...(selected !== 'quota' ? { runLocal: async () => {
    const unavailable = async (): Promise<never> => { throw new Error('AI naming cannot modify the project') }
    const bridge: ExternalAgentBridgeHandlers = {
      projectInfo: { name: project.name },
      projectFiles: async () => ({ files: [], truncated: false }),
      projectSearch: async () => ({ matches: [], truncated: false }),
      setIntent: unavailable, applyEdits: unavailable, updateTodo: unavailable,
      mappingsSearch: unavailable, mappingsClass: unavailable, dependencySearch: unavailable,
      dependencyInstall: unavailable, contentValidate: unavailable, testMatrix: unavailable,
      releasePreflight: unavailable, build: unavailable, testMinecraft: unavailable,
      blockbenchActions: unavailable, runtimeState: unavailable
    }
    const result = await runExternalAgent({
      kind: selected, project, prompt, readOnly: true, resumeSession: false,
      sessionScope, signal: AbortSignal.timeout(45_000),
      onOutput: () => undefined, onProgress: () => undefined, bridge
    })
    if (result.sessionId) await deleteExternalAgentSession(project, selected, result.sessionId).catch(() => undefined)
    return result.finalAnswer?.text ?? ''
  } } : {}) })
}

function suggestProjectNamespace(project: ProjectInfo, backend?: AgentSettings['codingBackend'], modelSelection?: AiModelSelection): Promise<string> {
  return requestProjectAiName(project, projectNamespacePrompt(project), `project-namespace/${randomUUID()}`, backend, modelSelection)
}

async function generateAiReleaseSummary(): Promise<ReleaseSummaryDraft> { return featurePluginService.service<ReturnType<typeof import('../../feature-plugins/publishing/main').activate>>('publishing').generateAiReleaseSummary() }


function codingHashesEqual(left: Map<string, string> | null, right: Map<string, string>): boolean {
  if (!left || left.size !== right.size) return false
  for (const [file, hash] of right) if (left.get(file) !== hash) return false
  return true
}

const MANDATORY_CODING_WORKFLOW = `${MANAGED_DOWNLOAD_POLICY}

MODMIND WORKFLOW GUIDANCE. Choose the smallest workflow that reliably satisfies the user's request. Project info, intent classification, Todo, validation, managed builds, runtime tests, and independent review are available helpers, not completion gates. Do not repeat work merely to satisfy a process checklist.

For engineering changes, implement the requested behavior and use the most relevant enabled validation. Prefer a managed build when compilation or packaging matters. Respect the current turn's feature checklist even when a skill recommends testing. When enabled, the headless smoke-test path uses HeadlessMC in an isolated, hidden, offline instance; real-interface testing uses modmind_test_rendered or a supported rendered player session and may open its own visible game window. Do not take over the user's existing game. If a useful check is unchecked or unsupported, state that plainly instead of bypassing the choice or claiming verification.

Native Agent tools, terminal commands, and file tools remain available for uncovered work. Never run Gradle build, assemble, compileJava, runClient, runServer, or runGameTestServer directly; use modmind_build_project, modmind_test_matrix, or modmind_test_minecraft so ModMind owns serialization, cancellation, and process cleanup. Never use Stop-Process -Force, taskkill /f, kill -9, or delete Gradle daemon registry files. On Windows, commands run in Windows PowerShell 5.1, so do not use Bash-only operators such as || or &&. Do not waste tokens replaying optional planning or verification steps.

Treat completion review as advice. Never start another implementation turn only because an optional review or checklist recommends more work.`

function codingWorkflowPrompt(project: ProjectInfo): string {
  const profile = studios().context(project, 'workbench')
  return `${MANDATORY_CODING_WORKFLOW}\n\n${profile.instructions || '领域工作台未启用；保留项目文件并在功能页恢复工作台。不得将其按其他领域处理。'}`
}

async function resourcePackAgentOperation(project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> {
  const id = typeof input.id === 'string' ? input.id : ''
  switch (input.operation) {
    case 'list': return listResourcePacks(project)
    case 'create': return createResourcePack(project, { name: String(input.name ?? ''), description: String(input.description ?? ''), packFormat: Number(input.packFormat) })
    case 'validate': return validateResourcePack(project, id)
    case 'deploy': return deployResourcePack(project, id)
    case 'export': {
      const bytes = await resourcePackArchive(project, id)
      const file = path.join(project.path, 'build', 'resource-packs', `${id}.zip`)
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes)
      return { path: file, bytes: bytes.length }
    }
    default: throw new Error('不支持的资源包操作')
  }
}

async function creationContextOperation(project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> {
  const service = new CreationFeedbackService(project)
  if (input.operation === 'delivery') return service.delivery(String(input.taskId), input.delivery as import('../shared/creationFeedback').CreationTaskRecord['delivery'])
  if (input.operation === 'target') {
    if (typeof input.path !== 'string' || input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.length > 30 || input.artifacts.some(item => typeof item !== 'string'))) throw new Error('目标或产物列表无效')
    return service.target(String(input.taskId), input.path, input.artifacts as string[] | undefined)
  }
  if (input.operation === 'read') return service.read(String(input.id), Number(input.start ?? 1), Number(input.count ?? 100))
  if (input.operation === 'requirement') return service.requirement(Number(input.revision), { ...input.requirement as import('../shared/creationFeedback').CreationRequirement, author: 'assistant' })
  if (input.operation === 'hypothesis') return service.mutate(state => {
    const task = state.tasks.find(item => item.id === input.taskId)
    if (!task || typeof input.text !== 'string' || input.text.length > 4000) throw new Error('任务或假设无效')
    task.hypothesis = input.text
  })
  return service.view()
}


function requiredWorkflowStages(project: ProjectInfo, intent: 'engineering' | 'informational' | null): AiWorkflowStage[] {
  void project
  void intent
  return []
}

function markWorkflowStage(workflow: AiWorkflowState, stage: AiWorkflowStage, evidence: string): void {
  if (!workflow.completed.includes(stage)) workflow.completed.push(stage)
  workflow.evidence[stage] = evidence.slice(0, 500)
}

function auditWorkflow(workflow: AiWorkflowState, changedFiles: string[], buildUsed: boolean, runtimeUsed: boolean, todo?: AgentTodoItem[]): { required: AiWorkflowStage[]; completed: AiWorkflowStage[]; missing: AiWorkflowStage[]; evidence: Partial<Record<AiWorkflowStage, string>> } {
  const completed = new Set(workflow.completed)
  const evidence = { ...workflow.evidence }
  if (!buildUsed) { completed.delete('build'); delete evidence.build }
  if (!runtimeUsed) { completed.delete('runtime_test'); delete evidence.runtime_test }
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
  lifecycle: { onBackendReady?: () => void; onProgress?: (item: PipelineEvent) => void } = {}
): Promise<CodingResult> {
  const project = requireProject()
  const signal = taskSignal ?? new AbortController().signal
  throwIfAborted(signal, 'Agent 任务已停止')
  const surface: AiSurface = context.surface === 'inspiration' ? 'inspiration' : 'workspace'
  const beginnerAgent = surface === 'workspace' && (context.agentMode === 'beginner' || recovery?.agentMode === 'beginner')
  const isInspiration = usesInspirationWorkflow({ ...context, ...(beginnerAgent ? { agentMode: 'beginner' } : {}) })
  if (!project.draft && !isInspiration) studios().require(project)
  const initialCredentials = backend === 'quota' ? await readDeviceCredentials() : null
  const modelSelection = normalizeAiModelSelection(context.modelSelection ?? recovery?.modelSelection ?? initialCredentials?.sync?.bindings?.[surface])
  const frozenQuotaConfig = initialCredentials?.sync ? await readBeginnerAgentServerConfig(modelSelection) : undefined
  const quotaRunConfig = (): Promise<CodexServerConfig> => frozenQuotaConfig ? Promise.resolve(frozenQuotaConfig) : readBeginnerAgentServerConfig(modelSelection)
  if (initialCredentials?.sync) {
    const run = context.runId ? activeAiRuns.get(context.runId) : [...activeAiRuns.values()].find(r => r.sessionId === sessionId && r.projectPath === project.path)
    if (run) run.quotaAccount = modelSelection?.account ?? (await readBeginnerAiPreferences()).account ?? initialCredentials.sync.defaultAccount
  }
  const selectedFeatures = beginnerAgent ? undefined : context.workbenchFeatures ?? recovery?.workbenchFeatures
  const workbenchFeatures = selectedFeatures === undefined ? undefined : normalizeWorkbenchFeatures(selectedFeatures)
  if (project.draft && !isInspiration && !beginnerAgent) throw new Error('当前项目仅用于对话，请先补齐版本和平台信息，再开始制作')
  const recoveryBackend = recovery?.backend
  const backendChanged = Boolean(recoveryBackend && recoveryBackend !== backend)
  const storedConversation = context.conversationId ? await conversationStore.readContext(project.path, context.conversationId).catch(() => null) : null
  const nativeSessionId = (recovery?.nativeSessions?.[backend]
    ?? (!backendChanged && recoveryBackend === backend ? recovery?.sessionId : undefined)
    ?? storedConversation?.native[backend]?.sessionId)
  // Resumed checkpoints keep their original conversation scope so the CLI
  // session continues inside the same workbench thread.
  const sessionScope = recovery ? aiRecoverySessionScope(recovery) : normalizeAiSessionScope(context.sessionScope)
  // The beginner-unlimited profile belongs exclusively to the quota engine.
  // Never carry it across a hot switch into a user-configured Codex
  // process, otherwise the target backend would silently use the old account.
  const executionProfile: AiExecutionProfile = backend === 'quota'
    ? (recovery?.executionProfile === 'beginner-unlimited' || requestedExecutionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard')
    : 'standard'
  const usesQuota = backend === 'quota'
  const externalBackend: ExternalAgentKind = backend === 'quota' ? 'codex' : backend
  const agentLabel = externalAgentLabel(externalBackend)
  const creation = new CreationFeedbackService(project)
  const creationTaskId = context.turnId ?? `turn-${sessionId ?? Date.now()}`
  if (!isInspiration) {
    prompt = await creation.begin(creationTaskId, prompt, context.conversationId)
    context = { ...context, fallbackPrompt: await creation.recover(prompt, context.conversationId, context.fallbackPrompt) }
  }
  const settings = settingsForAiSelection(await awaitWithAbort(readSettings(), signal, 'Agent 任务已停止'), backend, modelSelection)
  const sendCodingProgress = (item: PipelineEvent): void => {
    sendAiProgress(event, item, sessionId, project.path, context.runId)
    lifecycle.onProgress?.(item)
  }
  const activitySnapshots = new Map<string, { activity: import('../shared/aiActivity').AiActivity; identity: { itemId: string; streamId: string } }>()
  const publishActivity: NonNullable<ExternalAgentRunOptions['onActivity']> = (activity, identity) => {
    if (signal.aborted) return
    const previous = activitySnapshots.get(identity.streamId)?.activity
    const merged = { ...activity, ...(previous?.output && !activity.output ? { output: previous.output } : {}), ...(previous?.detail && !activity.detail ? { detail: previous.detail } : {}) }
    activitySnapshots.set(identity.streamId, { activity: merged, identity })
    if (activitySnapshots.size > 512) {
      const oldest = [...activitySnapshots].find(([, entry]) => entry.activity.status !== 'running')
      if (oldest) activitySnapshots.delete(oldest[0])
    }
    sendAiOutput(event, 'tool', merged.title, sessionId, project.path, context.runId, { ...identity, activity: merged })
  }
  let lastRuntimeActivityAt = 0
  const reportRuntimeActivity = (runtimeEvent: MinecraftRuntimeEvent): void => {
    if (signal.aborted || runtimeEvent.projectPath && !sameProjectPath(runtimeEvent.projectPath, project.path)) return
    const candidates = [...activitySnapshots.values()].reverse().filter(entry => entry.activity.status === 'running')
    const active = candidates.find(entry => ['build', 'test'].includes(entry.activity.kind)) ?? candidates.find(entry => entry.activity.kind === 'tool')
    if (!active) return
    const message = runtimeEvent.message.replace(/\u001b\[[0-9;]*m/g, '').trim()
    const snapshot = { ...active.activity, detail: message.slice(-1000), output: `${active.activity.output ?? ''}${message}\n`.slice(-12000),
      progress: runtimeEvent.total && runtimeEvent.progress !== undefined ? { current: runtimeEvent.progress, total: runtimeEvent.total } : undefined }
    activitySnapshots.set(active.identity.streamId, { ...active, activity: snapshot })
    if (Date.now() - lastRuntimeActivityAt >= 180 || runtimeEvent.level === 'error') {
      lastRuntimeActivityAt = Date.now()
      publishActivity(snapshot, active.identity)
    }
  }
  const inspirationFeatures = surface === 'inspiration' ? normalizeInspirationFeatures(context.inspirationFeatures) : undefined
  const inspirationKnowledgeBaseline = inspirationFeatures?.knowledgeOrganization ? await projectKnowledgeStore().read(project.path) : []
  const savedExternalConfiguration = settings.externalAgents?.[externalBackend] ?? {}
  const runExternalConfiguration = savedExternalConfiguration
  const localCodexConfig = !usesQuota && runExternalConfiguration.mode !== 'hosted'
    ? await readLocalCodexConfig().catch(() => null) : null
  const localCodexModel = !usesQuota && runExternalConfiguration.mode !== 'hosted'
    ? runExternalConfiguration.model || localCodexConfig?.model : undefined
  const localCodexContextWindow = runExternalConfiguration.modelContextWindows?.[localCodexModel ?? '']
    ?? (localCodexConfig && localCodexConfig.model === localCodexModel ? localCodexConfig.contextWindow : undefined)
  const localCodexManualCompactLimit = runExternalConfiguration.modelAutoCompactTokenLimits?.[localCodexModel ?? '']
    ?? (localCodexConfig && localCodexConfig.model === localCodexModel ? localCodexConfig.autoCompactTokenLimit : undefined)
  const localCodexAutoCompactLimit = localCodexModel
    ? resolveCodexAutoCompactTokenLimit(localCodexModel, { baseUrl: localCodexConfig?.baseUrl, contextWindow: localCodexContextWindow, allowLongerContext: settings.allowLongerContext }, localCodexManualCompactLimit)
    : undefined
  let executionUsage: import('../shared/types').AiTokenUsage | undefined
  const safetyReviewerConfig: AiReviewerConfig = { reviewMode: 'codex-auto' }
  let codexSetup: Awaited<ReturnType<typeof prepareCodex>> | undefined
  if (usesQuota) {
    for (;;) {
      const revision = await quotaConfiguration.acquire(signal)
      const preparingSignal = AbortSignal.any([signal, revision.signal])
      try {
        await awaitWithAbort(ensureQuotaAccountReady(), preparingSignal, 'Agent 任务已停止')
        codexSetup = await prepareQuotaCodex(project, sessionScope, (progress) => {
          if (!preparingSignal.aborted) sendCodingProgress(pipelineEvent('planning', progress.title, progress.detail, progress.status))
        }, preparingSignal, frozenQuotaConfig ?? (modelSelection ? await quotaRunConfig() : undefined), isInspiration ? 'inspiration' : 'workbench')
        throwIfAborted(preparingSignal)
        break
      } catch (error) {
        throwIfAborted(signal)
        if (!revision.signal.aborted) throw error
      }
    }
  } else if (externalBackend === 'codex') {
    const configured = runExternalConfiguration
    if (configured.mode === 'hosted') {
      codexSetup = await prepareConfiguredCodex(project, sessionScope, configured, (progress) => {
        sendCodingProgress(pipelineEvent('planning', progress.title, progress.detail, progress.status))
      }, signal, isInspiration ? 'inspiration' : 'workbench')
    }
  }
  throwIfAborted(signal, 'Agent 任务已停止')
  let configuredExecutable = codexSetup?.executable
  if (!configuredExecutable) {
    const detected = await awaitWithAbort(detectInstalledCodex(runExternalConfiguration), signal, 'Agent 任务已停止')
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
  let buildUsed = false
  let runtimeUsed = false
  let buildCount = recovery?.state.buildCount ?? 0
  let declaredIntent: 'engineering' | 'informational' | null = recovery?.state.intent ?? null
  let lastBuildHashes: Map<string, string> | null = null
  let lastRuntimeHashes: Map<string, string> | null = null
  const runtime = requireMinecraftRuntime()
  const conversationId = context.conversationId ?? aiConversationIdForSession(recovery ?? { sessionScope })
  const generation = context.generation ?? storedConversation?.generation ?? 0
  const turnId = context.turnId ?? `turn-${taskId}`
  const activeTask: ActiveAiTask = {
    ...(beginnerAgent ? { agentMode: 'beginner' as const } : {}),
    workbenchFeatures,
    taskId,
    runId: context.runId ?? recovery?.runId ?? taskId,
    projectPath: project.path,
    snapshotId: snapshot.id,
    startedAt: recovery?.startedAt ?? new Date().toISOString(),
    changedFiles: recovery?.changedFiles ?? [],
    prompt,
    ...(modelSelection ? { modelSelection } : {}),
    ...(context.fallbackPrompt || recovery?.fallbackPrompt ? { fallbackPrompt: context.fallbackPrompt ?? recovery?.fallbackPrompt } : {}),
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
      required: isInspiration ? [] : requiredWorkflowStages(project, declaredIntent),
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
    required: isInspiration ? [] : requiredWorkflowStages(project, declaredIntent)
  }
  activeTask.workflow = workflow
  const writeTask = (): Promise<void> => isInspiration ? Promise.resolve() : writeActiveAiTask(activeTask, project)
  updateManagedDownloadAudit(workflow, project, prompt, activeTask.changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
  const missingRecoveryStages = recovery
    ? auditWorkflow(workflow, recovery.changedFiles, buildUsed, runtimeUsed, recovery.state.todo).missing
    : []
  let workflowWrite = Promise.resolve()
  let bufferedFinalResponse: string | undefined
  let bufferedFinalIdentity: { itemId?: string; streamId?: string } | undefined
  const deliveredResponseContents = new Set<string>()
  const flushBufferedProgress = (): void => {
    if (!bufferedFinalResponse) return
    const content = bufferedFinalResponse
    const identity = bufferedFinalIdentity
    bufferedFinalResponse = undefined
    bufferedFinalIdentity = undefined
    const key = content.trim()
    if (!key || deliveredResponseContents.has(key)) return
    deliveredResponseContents.add(key)
    sendAiOutput(event, 'response', content, sessionId, project.path, context.runId, identity)
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
      workflow.required = isInspiration ? [] : requiredWorkflowStages(project, 'engineering')
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
  const moduleTasks = new ModpackModuleTasks(signal, (input, childSignal) => runModpackModuleWorkbench(project, input, backend, childSignal, {
    workbenchFeatures,
    beforeRun: async module => { await creation.target(creationTaskId, module.path) },
    onActivity: text => sendCodingProgress(pipelineEvent('writing', '自制模组工作台正在处理委派', text, 'running'))
  }))
  const testOwnerSignal = signal
  const buildTasks = new ManagedBuildTasks(signal, async buildSignal => {
    moduleTasks.assertCollected()
    buildCount += 1
    activeTask.state.buildCount = buildCount
    await writeTask()
    buildUsed = false
    runtimeUsed = false
    lastBuildHashes = null
    activeTask.state.lastBuildSucceeded = false
    const artifact = await aiProjectContext.run(project, () => buildProjectWithLock(buildSignal))
    buildUsed = await creation.verifyLatestBuild()
    recordWorkflow('build', 'modmind_build_project completed successfully')
    lastBuildHashes = await managedCodingHashes(project)
    activeTask.state.lastBuildSucceeded = buildUsed
    await writeTask()
    return { success: true, artifact }
  }, () => ({ ...requireMinecraftRuntime().buildRecoveryState(), buildDiagnostics: gradleDiagnosticState(project.path) }))
  try {
    let managedExternalEnvironment = usesQuota
      ? codexSetup?.environment
      : codexSetup?.environment ?? await awaitWithAbort(externalAgentRunEnvironment(externalBackend, {
          ...settings,
          externalAgents: { ...settings.externalAgents, [externalBackend]: runExternalConfiguration }
        }), signal, 'Agent 任务已停止')
    const providerRouteIdentity = usesQuota
      ? await awaitWithAbort(quotaRunConfig(), signal, 'Agent 任务已停止').then((config) => `${config.baseUrl}\n${config.model}\n${codexProviderIdentity(config)}\n${codexSetup?.version ?? ''}`)
      : `${runExternalConfiguration.baseUrl ?? 'local'}\n${runExternalConfiguration.model ?? 'local'}\n${configuredExecutable ?? 'detected'}`
    const retryScope = createHash('sha256').update(`${backend}\n${providerRouteIdentity}`).digest('hex').slice(0, 24)
    const sessionFingerprint = createHash('sha256').update(`${backend}\n${externalBackend}`).digest('hex').slice(0, 24)
    throwIfAborted(signal, 'Agent 任务已停止')
    const unifiedHandoff = recovery && backendChanged
      ? `\n\nUNIFIED CONTEXT HANDOFF (revision ${activeTask.contextRevision ?? 0}). The user switched the execution backend from ${recoveryBackend} to ${backend}. This is the same conversation and the same task, not a new request.\nOriginal request: ${recovery.prompt}\nLast summary: ${recovery.state.summary || '(none)'}\nTodo: ${JSON.stringify(recovery.state.todo ?? [])}\nChanged files: ${JSON.stringify(recovery.changedFiles ?? [])}\nCompleted workflow stages: ${JSON.stringify(recovery.workflow?.completed ?? [])}\nTests: ${JSON.stringify(recovery.state.tests ?? [])}\nWarnings: ${JSON.stringify(recovery.state.warnings ?? [])}\nContinue from this unified state. Inspect current project files before editing and do not repeat completed work.`
      : ''
    const initialExternalPrompt = recovery
      ? `${prompt}${unifiedHandoff}\n\nContinue the unfinished action from the unified conversation context. Do not recap context or announce preparation; proceed with the next substantive action.${missingRecoveryStages.length ? ` Suggested unfinished checks: ${missingRecoveryStages.join(', ')}.` : ''} Do not repeat completed work.`
      : prompt
    const studioProfile = studios().context(project, isInspiration ? 'inspiration' : 'workbench')
    const platformPrompt = `${initialExternalPrompt}\n\n${studioProfile.instructions}`
    const externalRunOptions: ExternalAgentRunOptions = {
      inspirationFeatures,
      workbenchFeatures,
      kind: externalBackend,
      approvalMode: isInspiration ? 'yolo' : normalizeAgentApprovalMode(settings.codexApprovalMode),
      onReasoning: (reasoning, content, identity) => sendAiOutput(event, 'reasoning', content, sessionId, project.path, activeTask.runId, { ...identity, reasoning }),
      onUserInput: (questions, signal, interaction) => {
        if (isInspiration && !inspirationFeatures?.autoQuestions) return false
        const sender = event.sender.id === REMOTE_SENDER_ID ? mainWindow?.webContents : event.sender
        if (!sender || sender.isDestroyed()) return false
        const owner = sender.id
        if (!questionOwners.has(owner)) {
          questionOwners.add(owner)
          sender.once('destroyed', () => { questionOwners.delete(owner); workbenchQuestions.cancelOwner(owner) })
        }
        return workbenchQuestions.add(owner, { projectPath: project.path, conversationId: activeTask.conversationId, runId: activeTask.runId ?? sessionId ?? randomUUID(), surface: isInspiration ? 'inspiration' : 'workspace' }, questions, signal, interaction)
      },
      ...(!isInspiration ? { onApproval: async (request, approvalSignal) => {
        const sender = event.sender.id === REMOTE_SENDER_ID ? mainWindow?.webContents : event.sender
        if (!sender || sender.isDestroyed()) return 'deny' as const
        const owner = sender.id
        const onDestroyed = (): void => workbenchApprovals.cancelOwner(owner)
        sender.once('destroyed', onDestroyed)
        try {
          return await workbenchApprovals.request(owner, { projectPath: project.path, conversationId: activeTask.conversationId, runId: activeTask.runId ?? sessionId ?? randomUUID() }, request, approvalSignal)
        } finally { if (!sender.isDestroyed()) sender.removeListener('destroyed', onDestroyed) }
      } } satisfies Pick<ExternalAgentRunOptions, 'onApproval'> : {}),
      runId: activeTask.runId,
      appVersion: app.getVersion(),
      executable: configuredExecutable,
      env: managedExternalEnvironment,
      sessionHome: codexSetup?.home,
      adapterRouteId: codexSetup?.adapterRouteId,
      ...(frozenQuotaConfig ? { model: frozenQuotaConfig.model, modelProvider: 'thirdparty', reasoningEffort: frozenQuotaConfig.reasoningEffort } : {}),
      ...(!usesQuota && runExternalConfiguration.model ? { model: runExternalConfiguration.model, reasoningEffort: runExternalConfiguration.reasoningEffort, ...(runExternalConfiguration.mode === 'hosted' ? { modelProvider: 'thirdparty' } : {}) } : {}),
      ...(!usesQuota && runExternalConfiguration.mode !== 'hosted' ? { providerConfig: {
        ...(runExternalConfiguration.modelContextWindows?.[runExternalConfiguration.model ?? ''] ? { model_context_window: runExternalConfiguration.modelContextWindows[runExternalConfiguration.model ?? ''] } : {}),
        ...(localCodexAutoCompactLimit !== undefined ? { model_auto_compact_token_limit: localCodexAutoCompactLimit } : {})
      } } : {}),
      ...(usesQuota ? {
        ...(!frozenQuotaConfig ? { liveConfiguration: quotaConfiguration } : {}),
        refreshConfiguration: async (configurationSignal: AbortSignal) => {
          const revision = quotaConfiguration.current()
          const config = await awaitWithAbort(quotaRunConfig(), configurationSignal)
          const prepared = await prepareQuotaCodex(project, sessionScope, undefined, configurationSignal, config, isInspiration ? 'inspiration' : 'workbench')
          codexSetup = prepared
          throwIfAborted(configurationSignal)
          const adapterUrl = await chatCompletionsAdapter.baseUrl(config.baseUrl, `${codexProviderIdentity(config)}:${revision.sequence}`, revision.signal, config.model, config.model, config.reasoningEffort ?? null)
          diagnosticJournal.record({ subsystem: 'ai', operation: 'execution-configuration', phase: 'prepared', message: `执行模型 ${config.model}`, data: { runId: activeTask.runId, revision: revision.sequence, baseUrl: config.baseUrl, model: config.model } })
          return {
            executable: prepared.executable, env: prepared.environment, sessionHome: prepared.home, adapterRouteId: prepared.adapterRouteId,
            model: config.model, modelProvider: 'thirdparty', reasoningEffort: config.reasoningEffort,
            providerConfig: {
              'model_providers.thirdparty.base_url': adapterUrl,
              'model_providers.thirdparty.env_key': 'MODMIND_THIRD_PARTY_API_KEY',
              'model_providers.thirdparty.wire_api': 'responses',
              'model_providers.thirdparty.requires_openai_auth': false
            },
            retryScope: createHash('sha256').update(`${config.baseUrl}\n${codexProviderIdentity(config)}\n${revision.sequence}`).digest('hex').slice(0, 24)
          }
        }
      } : {}),
      project,
      workflowSourceDirectory: bundledCodexSkillsDirectory(),
      userSkillStore: isInspiration ? undefined : userSkillStore,
      pluginTarget: createPluginBridgeTarget(project.path),
      systemPrompt: isInspiration
        ? `你处于灵感台讨论与研究模式，使用本次对话选择的模型及推理设置。不得修改项目源码、安装项目依赖、构建或测试。${context.onboarding === 'moko-inspiration' ? mokoInspirationSystemPrompt(codexSetup?.model ?? runExternalConfiguration.model ?? '') : ''}${inspirationFeatures ? inspirationFeaturePrompt(inspirationFeatures, featurePluginService.enabled('image-studio')) + '\n' + inspirationWorkflowInstruction() : ''}${project.draft ? `\n${draftProjectContext(project)}` : ''}`
        : `${WORKBENCH_REQUEST_GUIDANCE}\n\n${beginnerAgent ? BEGINNER_AGENT_WORKFLOW_GUIDANCE : ''}\n\n${project.draft ? `当前工程尚未创建。已记录的选择：${JSON.stringify(project.draft.target)}。结合本次对话补齐必要信息后使用 modmind_project_setup；不要手写模板或修改占位项目配置。` : codingWorkflowPrompt(project)}`,
      sessionScope,
      sessionLane: backend,
      // A conversation owns its native CLI thread. Inspiration may resume
      // that thread for context, but never gets workspace recovery sessions.
      resumeSession: context.resumeSession === true || (!isInspiration && Boolean(nativeSessionId)),
      ...(context.fallbackPrompt || recovery?.fallbackPrompt ? { fallbackPrompt: context.fallbackPrompt ?? recovery?.fallbackPrompt } : {}),
      readOnly: isInspiration,
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
      ...(context.forkFrom ? { forkFrom: context.forkFrom } : {}),
      prompt: platformPrompt,
      signal: signal ?? new AbortController().signal,
      persistentRetry: true,
      onStarted: () => {
        const configuredContextWindow = codexSetup?.contextWindow ?? (!usesQuota ? runExternalConfiguration.modelContextWindows?.[runExternalConfiguration.model ?? ''] : undefined)
        if (configuredContextWindow) {
          executionUsage = { contextWindow: configuredContextWindow, contextWindowSource: 'configuration', model: codexSetup?.model ?? runExternalConfiguration.model, backend }
          sendAiOutput(event, 'usage', '', sessionId, project.path, context.runId, { usage: executionUsage })
        }
        activeTask.lifecycle = 'running'
        delete activeTask.recovery
        workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
        lifecycle.onBackendReady?.()
      },
      onUsage: usage => {
        executionUsage = { ...usage, contextTokens: usage.contextTokens ?? (usage.cumulative ? executionUsage?.contextTokens : usage.inputTokens),
          contextWindow: codexSetup?.contextWindow ?? (!usesQuota ? runExternalConfiguration.modelContextWindows?.[runExternalConfiguration.model ?? ''] : undefined) ?? usage.contextWindow ?? executionUsage?.contextWindow,
          contextWindowSource: codexSetup?.contextWindow || !usesQuota && runExternalConfiguration.modelContextWindows?.[runExternalConfiguration.model ?? ''] ? 'configuration' : 'runtime',
          model: usage.model ?? codexSetup?.model ?? runExternalConfiguration.model, backend }
        sendAiOutput(event, 'usage', '', sessionId, project.path, context.runId, { usage: executionUsage })
        if (!isInspiration) void creation.mutate(state => {
          const task = state.tasks.find(item => item.id === creationTaskId)
          if (task) task.usage = { input: usage.inputTokens ?? 0, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens ?? 0 }
        }).catch(() => undefined)
      },
      onNativeTurn: async (externalSessionId, nativeTurnId) => {
        if (activeTask.conversationId) {
          await conversationStore.setNativeState(project.path, activeTask.conversationId, generation, backend, externalSessionId, nativeTurnId, turnId, codexSetup?.home)
        }
      },
      onSessionId: (externalSessionId) => {
        activeTask.sessionId = externalSessionId
        activeTask.nativeSessions = { ...activeTask.nativeSessions, [backend]: externalSessionId }
        externalRunOptions.sessionId = externalSessionId
        externalRunOptions.resumeSession = true
        if (activeTask.conversationId) {
          void conversationStore.setNativeState(project.path, activeTask.conversationId, generation, backend, externalSessionId, undefined, undefined, externalRunOptions.sessionHome).catch(() => undefined)
        }
        workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
      },
      onAttemptAudit: (audit) => writeAiAttemptAudit(audit, sessionId, project.path),
      onContextRecovery: recovery => diagnosticJournal.record({ subsystem: 'ai', operation: 'native-context-recovery', phase: recovery.phase, level: recovery.phase.endsWith('failure') ? 'warning' : 'info', message: recovery.reason ?? recovery.phase, data: { ...recovery, runId: context.runId, conversationId: context.conversationId } }),
      retryScope,
      sessionFingerprint,
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
      onActivity: (activity, identity) => {
        flushBufferedProgress()
        publishActivity(activity, identity)
      },
      onOutput: (kind, content, identity) => {
        if (kind === 'response') {
          if (identity?.phase === 'commentary') {
            flushBufferedProgress()
            deliveredResponseContents.add(content.trim())
            sendAiOutput(event, 'response', content, sessionId, project.path, context.runId, identity)
            return
          }
          // A newer reply proves the previous one was progress narration, so
          // it is safe to show before the final completion audit.
          const key = content.trim()
          if (!key || key === bufferedFinalResponse?.trim() || deliveredResponseContents.has(key)) return
          flushBufferedProgress()
          bufferedFinalResponse = content
          bufferedFinalIdentity = identity
          activeTask.state.summary = content.slice(-4_000)
          workflowWrite = workflowWrite.then(writeTask).catch(() => undefined)
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
          kind === 'error' ? { terminal: false, recoverable: true, ...(identity ?? {}) } : identity
        )
      },
      onProgress: (title, detail, status, notice) => sendCodingProgress(pipelineEvent(
        status === 'error' ? 'error' : status === 'success' ? 'checking' : 'writing', title, detail, status,
        undefined,
        { ...(status === 'error' ? { terminal: false, recoverable: true } : {}), ...(notice ? { notice } : {}) }
      )),
      bridge: {
        ...featureAgentHandlers(project, signal, event, beginnerAgent && !isInspiration),
        research: input => runInspirationResearch(project, input, {
          backend: () => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile'),
          cacheRoot: path.join(app.getPath('userData'), 'decompile'), signal,
          ensureJava: () => requireMinecraftRuntime().ensureJavaRuntimeForTools(decompileMinimumJava(), undefined, undefined, signal),
          onProgress: detail => { sendCodingProgress(pipelineEvent('planning', '分析材料', detail, 'running')); if (isInspiration) sendAiOutput(event, 'tool', detail, sessionId, project.path, context.runId) }
        }),
        modpackModules: input => inspectModpackModules(project, input),
        modpackDelegateModule: async input => {
          buildUsed = false
          runtimeUsed = false
          lastBuildHashes = null
          lastRuntimeHashes = null
          activeTask.state.lastBuildSucceeded = false
          const result = moduleTasks.start(input)
          await writeTask()
          return result
        },
        modpackModuleTask: async input => {
          const task = await moduleTasks.read(input)
          if (task.result?.changedFiles.length) recordWorkflow('implementation', `Module workbench completed edits for ${task.namespace}`)
          return task
        },
        get projectInfo() { return { ...project, studio: studios().context(project, isInspiration ? 'inspiration' : 'workbench'), integrationDirectory: path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents') } },
        projectSetup: async input => {
          signal.throwIfAborted()
          const wasDraft = Boolean(project.draft)
          const updated = await initializeDraftProject(project.path, {
            suggestNamespace: candidate => suggestProjectNamespace(candidate, backend, modelSelection),
            resolve: (loader, version) => requireLoaderCatalog().resolve(loader, version),
            scaffold: async candidate => {
              signal.throwIfAborted()
              await scaffoldStudioProject(candidate)
            }
          }, input as Pick<Required<ProjectCreateInput>, 'kind' | 'loader' | 'minecraftVersion'>)
          // Every bridge closure and runtime operation keeps this live project
          // identity; no second agent or phase handoff is needed after setup.
          Object.assign(project, updated)
          delete project.draft
          if (currentProject && sameProjectPath(currentProject.path, project.path)) {
            currentProject = project
            if (!event.sender.isDestroyed()) event.sender.send('project:changed', project)
          }
          await rememberRecentProject(project)
          if (wasDraft) {
            declaredIntent = 'engineering'
            activeTask.state.intent = 'engineering'
            recordWorkflow('implementation', 'Created the project from confirmed user selections')
            await writeTask()
          }
          sendCodingProgress(pipelineEvent('writing', '项目已创建', `${project.name} · ${project.loader} ${project.minecraftVersion}`, 'success'))
          return { project: { ...project }, guidance: codingWorkflowPrompt(project), next: '项目已创建。需求明确就直接继续制作；否则询问一个必要问题并给出选项和推荐。无需再次确认开始，也不要重建工程。' }
        },
        serverOperation: input => localServerAgentOperation(project, input, signal),
        creationContext: input => creationContextOperation(project, input),
        projectKnowledgeRead: () => projectKnowledgeStore().read(project.path),
        snapshotQuery: async input => snapshotListPage(project.path, await listSnapshotSummaries(project.path), input),
        snapshotDelete: async input => { if (input.operation !== 'deleteSnapshots' || input.confirmed !== true || Object.keys(input).some(key => !['operation', 'ids', 'confirmed'].includes(key))) throw new Error('请确认删除所选快照'); const result = await deleteProjectSnapshots(input.ids, project.path); return { projectPath: project.path, deletedIds: result.deletedIds, failed: result.failed, remainingCount: result.snapshots.length } },
        projectKnowledgeSave: input => projectKnowledgeStore().save(project.path, input),
        ...(isInspiration && inspirationFeatures && context.conversationId && context.turnId ? {
          inspirationSubmit: async (input: Record<string, unknown>) => {
            throwIfAborted(signal, '灵感任务已停止')
            const current = await conversationStore.readContext(project.path, context.conversationId!)
            if (current?.surface !== 'inspiration' || current.generation !== (context.generation ?? 0)) throw new Error('灵感会话版本已变化，请重新提交')
            const record = await projectInspirationWorkflowStore().submit(project.path,
              { conversationId: context.conversationId!, turnId: context.turnId!, generation: context.generation ?? 0 },
              input, inspirationFeatures, context.inspirationQuestion ?? '', inspirationKnowledgeBaseline, signal)
            sendAiOutput(event, 'tool', '', sessionId, project.path, context.runId, {
              inspirationArtifact: { workflow: record.workflow!, finalized: record.status !== 'staged' }
            })
            return { status: record.status, promptState: record.workflow?.prompt?.state ?? null, knowledgeCount: record.changes.length,
              guidance: record.status === 'staged' ? '产物已登记为草稿；正常完成本轮后，宿主按设置保存或等待用户确认。不要宣称已经保存。' : '本轮产物已定稿，请勿重复提交。' }
          }
        } : {}),
        playerTest: (category, input) => requireTestingService().playerTestService.execute(project, category, input, signal),
        projectSearch: (query, limit) => searchProjectText(project, query, limit),
        projectFiles: async () => {
          return projectSearchFiles(project)
        },
        toolCalled: (action) => {
          if (action === 'project_info') recordWorkflow('project_info', 'modmind_project_info returned active project metadata')
          if (action === 'set_intent') recordWorkflow('intent', 'modmind_set_intent recorded task intent')
          if (action === 'update_todo') recordWorkflow('plan', 'modmind_update_todo published the ordered plan')
        },
        reviewAction: async (action, input) => {
          const decision = await reviewAiAction(safetyReviewerConfig, { project, request: prompt, action, input }, signal)
          if (!decision.approved) {
            sendCodingProgress(pipelineEvent('checking', '安全策略已阻止操作', decision.feedback || `${action} 风险：${decision.risk}`, 'warning'))
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
          runtimeUsed = false
          lastRuntimeHashes = null
          if (!isModpackProject(project)) throw new Error('current project is not a modpack')
          const javaPath = await runtime.ensureJavaRuntime()
          const port = typeof input.port === 'number' ? input.port : 25565
          const outputDirectory = typeof input.outputDirectory === 'string' && input.outputDirectory.trim() ? input.outputDirectory : path.join(project.path, projectDataDirectory(project), 'server-pack')
          const result = await withMinecraftResourceLock(() => managedServerJoin({ project, outputDirectory, port, acceptEula: true, onlineMode: input.onlineMode === true, javaPath, headless: requireHeadlessMc(), gameDirectory: path.join(project.path, projectDataDirectory(project), 'headlessmc', 'server-join'), onEvent: forwardMinecraftRuntimeEvent }))
           runtimeUsed = result.success
           if (result.success) lastRuntimeHashes = await managedCodingHashes(project)
           if (result.success) recordWorkflow('runtime_test', 'modmind_modpack_verify_server_join completed successfully')
           return result
        },
        modpackRunServerScenario: async (input) => {
          if (input.fixture || input.operation) return requireTestingService().isolatedServerScenarioOperation(project, input, signal)
          runtimeUsed = false
          lastRuntimeHashes = null
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
          const result = await withMinecraftResourceLock(() => managedServerScenario({ project, outputDirectory, port, acceptEula: true, onlineMode: input.onlineMode === true, javaPath, steps, onEvent: forwardMinecraftRuntimeEvent }))
           runtimeUsed = result.success
           if (result.success) lastRuntimeHashes = await managedCodingHashes(project)
           if (result.success) recordWorkflow('runtime_test', 'modmind_modpack_run_server_scenario completed successfully')
           return result
        },
        testOwnerSignal,
    testMatrix: async (targets, taskSignal) => {
          const signal = taskSignal ? AbortSignal.any([taskSignal, testOwnerSignal]) : testOwnerSignal
          moduleTasks.assertCollected()
          buildTasks.assertCollected()
          const selected = [...new Set(targets)].filter((target): target is TestTarget => ['build', 'client', 'server', 'gametest'].includes(target))
          if (selected.includes('build') || selected.includes('client')) { buildUsed = false; lastBuildHashes = null; activeTask.state.lastBuildSucceeded = false }
          if (selected.some(target => target !== 'build')) { runtimeUsed = false; lastRuntimeHashes = null }
          const matrix = await runProjectTestMatrix(selected, signal, (target, completed, total) => reportRuntimeActivity({ stage: 'building-mod', message: `测试 ${target} · 已完成 ${completed}/${total} 项`, progress: completed, total, time: new Date().toISOString(), level: 'info', projectPath: project.path }))
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
        build: input => buildTasks.invoke(input),
        testRendered: async (taskSignal) => {
          const signal = taskSignal ? AbortSignal.any([taskSignal, testOwnerSignal]) : testOwnerSignal
          moduleTasks.assertCollected()
          buildTasks.assertCollected()
          const result = await runManagedRenderedTest(project, signal)
          buildUsed = await creation.verifyLatestBuild()
          if (buildUsed) { lastBuildHashes = await managedCodingHashes(project); recordWorkflow('build', 'Visible client test completed the managed build') }
          runtimeUsed = result.success
          if (runtimeUsed) { lastRuntimeHashes = await managedCodingHashes(project); recordWorkflow('runtime_test', 'Visible client startup test passed; visual/gameplay behavior remains unverified') }
          activeTask.state.lastBuildSucceeded = buildUsed
          await writeTask()
          return result
        },
        testMinecraft: async (taskSignal) => {
          const signal = taskSignal ? AbortSignal.any([taskSignal, testOwnerSignal]) : testOwnerSignal
          moduleTasks.assertCollected()
          buildTasks.assertCollected()
          runtimeUsed = false
          lastRuntimeHashes = null
          if (project.kind === 'server-plugin') return localServerAgentOperation(project, { operation: 'start' }, signal)
          const currentHashes = await managedCodingHashes(project)
          if (!buildUsed || !codingHashesEqual(lastBuildHashes, currentHashes)) {
            buildCount += 1
            activeTask.state.buildCount = buildCount
            await writeTask()
            buildUsed = false
            runtimeUsed = false
            lastBuildHashes = null
            activeTask.state.lastBuildSucceeded = false
            await buildProjectWithLock(signal)
            buildUsed = await creation.verifyLatestBuild()
            recordWorkflow('build', 'modmind_test_minecraft completed the managed build')
            lastBuildHashes = await managedCodingHashes(project)
            activeTask.state.lastBuildSucceeded = buildUsed
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
        runtimeState: async () => ({ buildDiagnostics: gradleDiagnosticState(project.path), ...runtime.getState(), ...(isModpackProject(project) ? { modpackImport: await readModpackImportStatus(project) } : {}) }),
        javaHomeScan: () => scanConfiguredJavaHomes(),
        javaHomeProbe: (home) => probeJavaHomeInfo(home),
        appSettingsRead: async () => publicAgentSettings(await readSettings()),
        diagnosticsRead: input => Promise.resolve(readDiagnosticState(project.path, input)),
        modpackLock: input => manageModpackLock(project, input),
        quotaModelsRead: (force) => getQuotaModelCatalog(force),
        quotaModelsDiscover: () => {
          if (!currentProject || !sameProjectPath(currentProject.path, project.path)) throw new Error('项目已切换，请从当前项目重新操作')
          return discoverQuotaModels()
        },
        quotaModelSelect: (model, selection) => {
          if (!currentProject || !sameProjectPath(currentProject.path, project.path)) throw new Error('项目已切换，请从当前项目重新操作')
          return selectQuotaModel(model, selection)
        },
        appSettingsWrite: (input) => applyAppSettingWrite(input)
        ,
        imageProjectAssets: async () => {
          const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap((node) => node.type === 'directory' ? flatten(node.children ?? []) : [node])
          return flatten(await listDirectory(project.path)).filter((node) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(node.path)).slice(0, 500).map((node) => node.path)
        },
        imageReadProjectAsset: async (relativePath) => {
          return { path: relativePath, dataUrl: await readProjectImage(project.path, relativePath) }
        }
      }
    }
    const completedAnswer = (candidate: Awaited<ReturnType<typeof runExternalAgent>>): string => candidate.finalAnswer?.text
      ?? selectFinalAiAnswer(bufferedFinalResponse, candidate.summary, deliveredResponseContents)
    const result = await aiRuntimeActivityContext.run(reportRuntimeActivity, () => runExternalAgent(externalRunOptions))
    if (!completedAnswer(result)) {
      throw Object.assign(new Error('本轮已结束，但未收到完整回复。已保留当前修改和会话，请检查后再继续。'), { name: 'ExternalAgentOutputError' })
    }
    moduleTasks.assertCollected()
    buildTasks.assertCollected()
    optionalTestingService()?.playerTestService?.assertReadyForSignal(signal)
    const targetChanges = isInspiration ? [] : await creation.finishTargets(creationTaskId)
    if (!isInspiration) await creation.mutate(state => {
      const task = state.tasks.find(item => item.id === creationTaskId)
      if (task) { task.answer = result.summary.slice(0, 4000); task.elapsedMs = Date.now() - new Date(task.createdAt).getTime() }
    })
    if (activeTask.conversationId && result.sessionId) {
      await conversationStore.setNativeState(project.path, activeTask.conversationId, generation, backend, result.sessionId, result.nativeTurnId, turnId, externalRunOptions.sessionHome).catch(() => undefined)
    }
    updateManagedDownloadAudit(workflow, project, prompt, activeTask.changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
    let finalWorkflowAudit = auditWorkflow(workflow, [], buildUsed, runtimeUsed, activeTask.state.todo)
    if (isInspiration) finalWorkflowAudit = { ...finalWorkflowAudit, missing: [] }
    const after = isInspiration ? before : await managedCodingHashes(project)
    buildUsed = !isInspiration && currentVerification(buildUsed, lastBuildHashes, after) && await creation.verifyLatestBuild()
    runtimeUsed = !isInspiration && currentVerification(runtimeUsed, lastRuntimeHashes, after)
    const changedFiles = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file))
    ensureEngineeringRequirements(changedFiles)
    updateManagedDownloadAudit(workflow, project, prompt, changedFiles, activeTask.state.managedDownloads ?? [], activeTask.state.managedDownloadFailures ?? [], activeTask.state.nativeCoveredDownloads ?? [])
    finalWorkflowAudit = auditWorkflow(workflow, changedFiles, buildUsed, runtimeUsed, activeTask.state.todo)
    const hasTargetChanges = targetChanges.some(target => target.changedFiles?.length)
    const finalIntent = hasTargetChanges ? 'engineering' : declaredIntent ?? (changedFiles.length ? 'engineering' : 'informational')
    activeTask.changedFiles = changedFiles
    const finalResponse = completedAnswer(result).slice(-120_000)
    if (surface === 'inspiration' && inspirationFeatures && context.conversationId && context.turnId) {
      try {
        throwIfAborted(signal, '灵感任务已停止')
        const currentConversation = await conversationStore.readContext(project.path, context.conversationId)
        if (currentConversation?.generation !== (context.generation ?? 0)) throw new Error('对话已回退或删除，知识变更未保存')
        const identity = { conversationId: context.conversationId, turnId: context.turnId, generation: context.generation ?? 0 }
        const record = await projectInspirationWorkflowStore().finalize(project.path, identity, signal)
        if (record?.workflow) sendAiOutput(event, 'tool', '', sessionId, project.path, context.runId, {
          inspirationArtifact: { workflow: record.workflow, finalized: true }
        })
        else {
          // Old native threads may still emit the legacy envelope. Ordinary Markdown is valid.
          const parsed = parseInspirationWorkflow(finalResponse, inspirationFeatures)
          if (parsed.complete) await projectInspirationWorkflowStore().register(project.path, identity,
            finalResponse, inspirationFeatures, context.inspirationQuestion ?? '', inspirationKnowledgeBaseline, signal)
          else if (parsed.protocol) activeTask.state.warnings.push(parsed.error ?? '旧格式回答未完整生成，请重新整理')
        }
      } catch (error) {
        if (signal?.aborted) throw error
        activeTask.state.warnings.push('灵感产物未完成同步：' + (error instanceof Error ? error.message : String(error)))
      }
    }

    const summary = finalResponse.slice(0, 4_000)
    const tests = [
      ...(buildUsed ? ['已使用 ModMind 托管构建'] : []),
      ...(runtimeUsed ? ['已使用 ModMind Minecraft 测试'] : [])
    ]
    const creationState = isInspiration ? undefined : await creation.state()
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
      ...(targetChanges.length ? { projects: targetChanges } : {}),
      tests,
      warnings: activeTask.state.warnings,
      ...(changedFiles.length ? { snapshotId: snapshot.id } : {}),
      buildVerified: buildUsed,
      runtimeVerified: runtimeUsed,
      buildEvidence: creationState?.builds.at(-1),
      delivery: creationState?.tasks.find(task => task.id === creationTaskId)?.delivery,
      workflow: finalWorkflowAudit
    }
    // Guided questions stay in conversation storage instead of changing the
    // project's docs on every clarification or informational reply.
    const saveProjectReport = !isInspiration && (!beginnerAgent || changedFiles.length > 0)
    if (saveProjectReport) {
      await fs.mkdir(path.join(project.path, 'docs'), { recursive: true })
      await fs.writeFile(resolveProjectPath('docs/last-ai-change.json'), JSON.stringify(report, null, 2), 'utf8')
    }
    if (!changedFiles.length) {
      await fs.rm(path.join(project.path, projectDataDirectory(project), 'snapshots', snapshot.id), { recursive: true, force: true }).catch(() => undefined)
    }
    if (saveProjectReport) await fs.writeFile(resolveProjectPath('docs/last-ai-response.txt'), sanitizeAiUserText(finalResponse), 'utf8')
    if (!isInspiration) await clearActiveAiTask(project, taskId)
    // Publish the completed task result as one dedicated event. The last
    // candidate response is intentionally withheld from the ordinary stream
    // so consumers cannot render it once as progress and once as the answer.
    bufferedFinalResponse = undefined
    const finalIdentity = result.finalAnswer
      ? { itemId: result.finalAnswer.itemId, streamId: result.finalAnswer.streamId }
      : bufferedFinalIdentity
    const finalUsage = executionUsage ?? result.usage
    const answerOptions = finalUsage ? { usage: finalUsage, ...(finalIdentity ?? {}) } : finalIdentity
    bufferedFinalIdentity = undefined
    sendAiOutput(event, 'answer', finalResponse, sessionId, project.path, context.runId, answerOptions)
    sendCodingProgress({ ...pipelineEvent('complete', `${agentLabel} 本轮结束`, changedFiles.length ? `检测到 ${changedFiles.length} 个文件变化` : '已回复，本轮未检测到文件变化', 'success'), changedFiles })
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
    // Stop managed writers before hashing the parent's failure checkpoint.
    await buildTasks.close()
    await moduleTasks.close()
    if (!isInspiration) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = error instanceof Error && error.name === 'AbortError'
      const actionRequired = error instanceof Error && ['AutomaticApprovalUnavailableError', 'ExternalAgentContextStallError'].includes(error.name)
        || /(?:401|402|403|API Key|凭证|额度|余额|权限|模型.*不存在|CLI 未安装)/i.test(message)
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
  } finally {
    await buildTasks.close()
    await moduleTasks.close()
    await optionalTestingService()?.playerTestService?.stopNativeForSignal(signal)
    await featurePluginService.stopForSignal(signal)
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
  const contributionFor = (sender: Electron.WebContents): ContributionService => {
    if (sender !== mainWindow?.webContents || !contributionService) throw new Error('请在 ModMind 主窗口的设置中操作。')
    return contributionService
  }
  ipcMain.handle('contributions:getState', async event => {
    const service = contributionFor(event.sender)
    const account = await readDeviceCredentials()
    service.setUsername(account?.username)
    return service.state()
  })
  ipcMain.handle('contributions:beginConsent', event => contributionFor(event.sender).challenge(event.sender.id))
  ipcMain.handle('contributions:enable', (event, token: unknown, version: unknown) => contributionFor(event.sender).enable(event.sender.id, token, version))
  ipcMain.handle('contributions:disable', event => contributionFor(event.sender).disable())
  ipcMain.handle('contributions:preview', event => contributionFor(event.sender).preview())
  registerDeveloperIpc({ appearance: async () => normalizeAppearance(await readSettings()), run: async (options, backend, sender, selection) => {
    const settings = settingsForAiSelection(await readSettings(), backend, normalizeAiModelSelection(selection))
    const scope = options.sessionScope!, configured = settings.externalAgents?.codex ?? {}
    const onProgress = (progress: CodexSetupProgress): void => options.onProgress(progress.title, progress.detail, progress.status)
    let prepared: Awaited<ReturnType<typeof prepareCodex>> | undefined
    if (backend === 'quota') {
      await ensureQuotaAccountReady()
      prepared = await prepareQuotaCodex(options.project, scope, onProgress, options.signal, await readBeginnerAgentServerConfig(selection))
    } else if (configured.mode === 'hosted') prepared = await prepareConfiguredCodex(options.project, scope, configured, onProgress, options.signal)
    const executable = prepared?.executable ?? (await detectInstalledCodex(configured)).executable
    if (!executable) throw new Error('Codex CLI 不可用，请在 AI 设置中配置开发引擎')
    return runExternalAgent({ ...options, executable,
      approvalMode: normalizeAgentApprovalMode(settings.codexApprovalMode),
      onApproval: (request, signal) => workbenchApprovals.request(sender.id, { projectPath: options.project.path, conversationId: scope.slice('developer/'.length), runId: options.runId! }, request, signal),
      ...(prepared ? { env: prepared.environment, sessionHome: prepared.home, adapterRouteId: prepared.adapterRouteId, model: prepared.model, modelProvider: 'thirdparty' } : configured.model ? { model: configured.model } : {}),
      ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {})
    })
  } })
  diagnosticHandle('skills:list', () => userSkillStore.list())
  diagnosticHandle('skills:read', (_event, name: string) => userSkillStore.read(name))
  diagnosticHandle('skills:save', (_event, input: import('../shared/userSkills').UserSkillSaveInput) => userSkillStore.save(input))
  diagnosticHandle('skills:setEnabled', (_event, name: string, enabled: boolean) => userSkillStore.setEnabled(name, enabled))
  diagnosticHandle('skills:remove', (_event, name: string, revision: string) => userSkillStore.remove(name, revision))
  diagnosticHandle('skills:import', async (event, kind: 'folder' | 'file') => {
    if (kind !== 'folder' && kind !== 'file') throw new Error('请选择导入目录或 SKILL.md')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = kind === 'folder'
      ? { title: '导入 Skill 目录', properties: ['openDirectory'] }
      : { title: '导入 SKILL.md', properties: ['openFile'], filters: [{ name: 'SKILL.md', extensions: ['md'] }] }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return selected.canceled || !selected.filePaths[0] ? null : userSkillStore.import(selected.filePaths[0])
  })
  ipcMain.on('app:platformInfo', (event) => { event.returnValue = runtimePlatformInfo(process.platform, process.arch, app.isPackaged) })
  diagnosticHandle('app:version', () => app.getVersion())
  diagnosticHandle('app:getChangelog', (event) => {
    const snapshot = appChangelogService?.snapshot() ?? { currentVersion: app.getVersion(), automatic: false, releases: [] }
    return { ...snapshot, automatic: event.sender === mainWindow?.webContents && snapshot.automatic }
  })
  diagnosticHandle('app:markChangelogPresented', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    return appChangelogService?.markPresented()
  })
  diagnosticHandle('app:checkForUpdates', () => {
    if (!appUpdateService) throw new Error('自动更新服务尚未就绪')
    return appUpdateService.checkForUpdates(checkForAppUpdates)
  })
  diagnosticHandle('app:getUpdateState', () => appUpdateService?.snapshot() ?? { phase: 'idle', currentVersion: app.getVersion() })
  diagnosticHandle('app:downloadUpdate', () => {
    if (!appUpdateService) throw new Error('自动更新服务尚未就绪')
    return appUpdateService.downloadUpdate()
  })
  diagnosticHandle('app:installUpdate', () => appUpdateService?.installDownloadedUpdate() ?? false)
  diagnosticHandle('app:updateNow', () => {
    if (!appUpdateService) throw new Error('自动更新服务尚未就绪')
    return appUpdateService.updateNow(checkForAppUpdates)
  })
  diagnosticHandle('app:reinstallLatest', async (_event, confirmed: unknown) => {
    if (app.getVersion().endsWith('-plugintest')) throw new Error('插件测试版请使用 1.5.0-plugintest 安装包重装，不接入正式版更新通道')
    if (confirmed !== true) throw new Error('请先确认重装')
    if (!appUpdateService) throw new Error('自动更新服务尚未就绪')
    const options = {
      executablePath: process.execPath,
      userDataPath: app.getPath('userData'), appDataPath: app.getPath('appData'),
      localAppDataPath: process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
      homePath: app.getPath('home'), tempPath: app.getPath('temp'),
      protectedPaths: [...(await readRecentProjects()).map(project => project.path), ...(currentProject ? [currentProject.path] : []), app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads')],
      updateUrl: configuredAppUpdateUrl(), helperScriptPath: path.join(process.resourcesPath, 'reinstall-app.ps1')
    }
    return appUpdateService.reinstallLatest(async () => confirmed === true,
      report => prepareCleanReinstall({ ...options, report }),
      report => prepareOverwriteReinstall({ ...options, report }))
  })
  diagnosticHandle('app:resolveDialog', (event, requestId: unknown, confirmed: unknown) => {
    resolveRendererDialog(event.sender, requestId, confirmed)
  })
  diagnosticHandle('downloads:list', () => downloadActivities.snapshot())
  diagnosticHandle('downloads:retry', (_event, id: unknown) => downloadActivities.retry(typeof id === 'string' ? id : ''))
  diagnosticHandle('downloads:cancel', (_event, id: unknown) => downloadActivities.cancel(typeof id === 'string' ? id : ''))
  diagnosticHandle('downloads:restart', (_event, id: unknown) => downloadActivities.restart(typeof id === 'string' ? id : ''))
  diagnosticHandle('downloads:dismiss', (_event, id: unknown) => downloadActivities.dismiss(typeof id === 'string' ? id : ''))
  diagnosticHandle('downloads:clearFinished', () => downloadActivities.clearFinished())
  diagnosticHandle('device:getState', () => readDeviceState())
  diagnosticHandle('device:authorize', () => beginDeviceAuthorization())
  diagnosticHandle('device:cancelAuthorization', () => cancelDeviceAuthorization())
  diagnosticHandle('device:disconnectLocal', () => disconnectDeviceLocally())
  diagnosticHandle('device:refreshUsage', (_event, options?: { force?: boolean; account?: string }) => refreshDeviceUsage(options))
  diagnosticHandle('device:getAiPreferences', () => readBeginnerAiPreferences())
  diagnosticHandle('device:saveAiPreferences', (_event, preferences: BeginnerAiPreferences) => saveBeginnerAiPreferences(preferences))
  diagnosticHandle('device:listModels', (_event, force?: boolean) => listBeginnerModels(force === true))
  diagnosticHandle('device:getModelCatalog', (_event, force?: boolean, cached?: boolean) => getQuotaModelCatalog(force === true, cached === true))
  diagnosticHandle('device:discoverModels', () => discoverQuotaModels())
  diagnosticHandle('device:refreshConnections', async () => {
    await providerSync().refresh()
    await updateDeviceState(null)
    return providerSync().catalog()
  })
  diagnosticHandle('device:resetModelSelection', async (_event, surface: unknown) => {
    if (surface !== 'workspace' && surface !== 'inspiration') throw new Error('模型选择范围无效')
    if ((await readDeviceCredentials())?.sync) await providerSync().resetBinding(surface)
    emitAiSelection(surface)
  })
  diagnosticHandle('device:selectModel', (_event, model: unknown, selection?: unknown) => selectQuotaModel(model, selection))
  diagnosticHandle('device:openSite', (_event, relativePath?: string) => openConfiguredDeviceSite(relativePath))
  diagnosticHandle('remote:getState', () => remoteClient?.getState() ?? { status: 'disabled', enabled: false })
  diagnosticHandle('remote:start', () => startRemoteClientIfPossible(true))
  diagnosticHandle('remote:stop', () => stopRemoteClient(true))
  diagnosticHandle('mcp-bridge:getState', () => mcpBridgeState())
  diagnosticHandle('mcp-bridge:setEnabled', (_event, enabled: unknown) => setMcpBridgeEnabledFromSettings(enabled === true))
  diagnosticHandle('feature-plugins:list', () => featurePluginService.list())
  diagnosticHandle('studios:list', () => studios().list())
  diagnosticHandle('studios:context', (_event, surface: unknown, projectPath: unknown) => {
    if (surface !== 'workbench' && surface !== 'inspiration') throw new Error('工作台页面无效')
    const project = requireProject()
    if (typeof projectPath !== 'string' || !sameProjectPath(project.path, projectPath)) throw new Error('项目已切换，请重新读取工作台')
    return studios().context(project, surface)
  })
  diagnosticHandle('feature-plugins:catalog', () => featurePluginService.catalog())
  diagnosticHandle('feature-plugins:store', () => featureStoreService.snapshot())
  diagnosticHandle('feature-plugins:refreshStore', () => featureStoreService.refresh(true))
  diagnosticHandle('feature-plugins:installOfficial', (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string') throw new Error('请在主窗口安装功能')
    return featureStoreService.installOfficial(id)
  })
  diagnosticHandle('feature-plugins:cancelDownload', event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('请在主窗口管理下载')
    featureStoreService.cancel()
  })
  diagnosticHandle('feature-plugins:invoke', (event, id: unknown, action: unknown, input: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || window !== mainWindow && !isDetachedWindow(window)) throw new Error('请在应用窗口调用功能插件')
    if (typeof id !== 'string' || typeof action !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('功能插件调用参数无效')
    return nativeFeatureEvent.run(event, () => featurePluginService.invoke(id, action, input as Record<string, unknown>, { projectPath: currentProject?.path, windowId: window.id }))
  })
  diagnosticHandle('feature-plugins:install', async (event, expectedId?: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('请在主窗口安装应用功能插件')
    if (expectedId !== undefined && (typeof expectedId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(expectedId))) throw new Error('待更新的功能标识无效')
    const selected = await dialog.showOpenDialog(mainWindow!, { title: '安装工作台或功能组件', properties: ['openFile'], filters: [{ name: 'ModMind 工作台与功能组件', extensions: ['mmstudio', 'mmfeature'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const prepared = await prepareFeaturePlugin(selected.filePaths[0])
    if (expectedId !== undefined && prepared.manifest.id !== expectedId) throw new Error('所选安装包不是当前功能，请选择相同功能 ID 的更新包')
    const trusted = await requestWindowConfirmation(event.sender, randomUUID(), {
      name: prepared.manifest.name, version: prepared.manifest.version, fileName: path.basename(selected.filePaths[0])
    }, 'feature-plugins:installPreview', 'feature-plugins:confirmInstall')
    if (!trusted) return null
    return importLocalFeaturePlugin(featurePluginService, prepared, expectedId as string | undefined)
  })
  diagnosticHandle('feature-plugins:setEnabled', (event, id: unknown, enabled: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('插件参数或窗口无效')
    return featurePluginService.setEnabled(id, enabled)
  })
  diagnosticHandle('feature-plugins:uninstall', (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string') throw new Error('插件参数或窗口无效')
    return featurePluginService.uninstall(id)
  })
  diagnosticHandle('window:minimize', (event) => (BrowserWindow.fromWebContents(event.sender) ?? mainWindow)?.minimize())
  diagnosticHandle('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  diagnosticHandle('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && window !== mainWindow) return window.close()
    return handleWindowClose()
  })
  diagnosticHandle('window:resolveClose', (event, choice: unknown, remember: unknown) => {
    if (event.sender !== mainWindow?.webContents || !resolveCloseChoice) return
    if (choice !== 'tray' && choice !== 'quit' && choice !== 'cancel') return
    resolveCloseChoice({ behavior: choice, remember: remember === true })
    resolveCloseChoice = null
  })
  diagnosticHandle('window:openDetached', (_event, view: unknown, title: unknown) => {
    const target = typeof view === 'string' ? view : ''
    const pluginView = featurePluginService.list().some(plugin => featurePluginService.enabled(plugin.id) && plugin.manifest?.views?.some(view => view.id === target))
    if (!sidebarViewIds.has(target as SidebarViewId) && !pluginView && !/^group:(?:\d{1,3}|custom-[a-z0-9-]{1,64}|ungrouped)$/.test(target)) throw new Error('Unsupported detached window target')
    const window = createDetachedWindow(target as DetachedWindowTarget, typeof title === 'string' ? title : '')
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })
  diagnosticHandle('window:getDetachedState', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isDetachedWindow(window)) return null
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })
  diagnosticHandle('window:setDetachedAlwaysOnTop', (event, alwaysOnTop: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isDetachedWindow(window)) throw new Error('This window cannot be pinned')
    window.setAlwaysOnTop(alwaysOnTop === true, 'floating')
    return { alwaysOnTop: window.isAlwaysOnTop() }
  })


  diagnosticHandle('minecraft:buildProject', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return invokeMinecraftOperation(() => aiProjectContext.run(project, () => requireMinecraftRuntime().buildProject()))
  })


  diagnosticHandle('project:inspectExisting', async (event, sourceType: 'folder' | 'zip' = 'folder') => {
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
    const selectedPath = result.filePaths[0]
    const sourceName = path.basename(selectedPath)
    const report = (progress: ExistingProjectInspectionProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send('project:inspectionProgress', progress)
    }
    if (sourceType === 'zip') report({ phase: 'extracting', sourceName })
    const sourcePath = await resolveExistingProjectSource(selectedPath, (percent) => report({ phase: 'extracting', sourceName, percent }))
    report({ phase: 'analyzing', sourceName })
    const existingProject = await readProjectInfo(sourcePath).catch(() => null)
    if (existingProject) return { existingProject, archive: sourceType === 'zip' }
    return inspectStudioSource(sourcePath)
  })

  diagnosticHandle('project:listLoaderVersions', (_event, refresh = false) =>
    Promise.all([requireLoaderCatalog().list(Boolean(refresh)), requireLoaderCatalog().listPlugins(Boolean(refresh))]).then(options => options.flat())
  )

  diagnosticHandle('project:adoptExisting', (_event, input: ExistingProjectAdoptInput) => adoptStudioProject(input))

  diagnosticHandle('project:createDraft', async (_event, message: string) => {
    assertProjectSwitchAllowed()
    if (typeof message !== 'string' || !message.trim() || message.length > 100_000) throw new Error('请先描述你的想法')
    const project = await createDraftProject(app.getPath('documents'), message)
    currentProject = project
    await rememberRecentProject(project)
    return project
  })
  diagnosticHandle('project:recordDraftMessage', async (_event, message: string, projectPath: string) => {
    if (typeof message !== 'string' || message.length > 100_000 || typeof projectPath !== 'string') throw new Error('项目需求无效')
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在')
    assertProjectMutationAllowed(project.path, '完善项目信息')
    const updated = await recordDraftMessage(project.path, message)
    if (currentProject && sameProjectPath(currentProject.path, project.path)) currentProject = updated
    await rememberRecentProject(updated)
    return updated
  })
  diagnosticHandle('project:initializeDraft', async (_event, projectPath: string, backend?: AgentSettings['codingBackend'], modelSelection?: AiModelSelection) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在')
    assertProjectMutationAllowed(project.path, '创建完整工程')
    const updated = await initializeDraftProject(project.path, {
      suggestNamespace: candidate => suggestProjectNamespace(candidate, backend, modelSelection),
      resolve: (loader, version) => requireLoaderCatalog().resolve(loader, version),
      scaffold: async project => {
        await scaffoldStudioProject(project)
      }
    })
    if (currentProject && sameProjectPath(currentProject.path, project.path)) currentProject = updated
    await rememberRecentProject(updated)
    return updated
  })

  diagnosticHandle('project:create', async (_event, input: ProjectCreateInput) => {
    assertProjectSwitchAllowed()
    if (!input || typeof input.loader !== 'string') throw new Error('项目平台无效')
    const kind = input.kind ?? (isServerPluginPlatform(input.loader) ? 'server-plugin' : 'mod')
    const selectedStudio = studios().select({ ...input, kind })
    if (kind === 'modpack' && !isJavaLoader(input.loader)) throw new Error('整合包目前仅支持 Java 版的 Fabric、Quilt、Forge 和 NeoForge')
    const name = validateProjectNameInput(input.name)
    const minecraftVersion = input.minecraftVersion.trim()
    const compatibility: Partial<import('../shared/types').LoaderVersionOption> = (PROJECT_PLATFORMS as readonly string[]).includes(input.loader) ? await requireLoaderCatalog().resolve(input.loader, minecraftVersion) : {}
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const namespace = slugify(name)
    const projectPath = path.join(result.filePaths[0], namespace)
    if (await pathExists(projectPath)) throw new Error('项目目录已经存在，请修改项目名称或选择其他位置')
    const project: ProjectInfo = {
      ...input,
      kind,
      studioId: selectedStudio.definition.id,
      studioName: selectedStudio.definition.name,
      name,
      minecraftVersion,
      namespace,
      namespaceSource: 'generated',
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
      await projectKnowledgeStore().clearProject(projectPath)
      Object.assign(project, await assignDefaultProjectNamespace(project, candidate => suggestProjectNamespace(candidate)))
      await scaffoldStudioProject(project)
      await fs.mkdir(path.join(projectPath, '.modmind'), { recursive: true })
    } catch (error) {
      await fs.rm(projectPath, { recursive: true, force: true })
      throw error
    }
    currentProject = project
    await rememberRecentProject(project)
    return project
  })

  diagnosticHandle('project:rename', async (_event, input: ProjectRenameInput) => {
    const requestedPath = typeof input?.projectPath === 'string' ? input.projectPath.trim() : ''
    const project = requestedPath ? await readProjectInfo(path.resolve(requestedPath)) : currentProject
    if (!project) throw new Error('未找到要重命名的 ModMind 项目')
    if (currentProject && sameProjectPath(currentProject.path, project.path)) assertProjectSwitchAllowed()
    return renameProjectRecord(project, input)
  })

  diagnosticHandle('project:open', async () => {
    assertProjectSwitchAllowed()
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const info = await readAvailableProjectForOpening(result.filePaths[0])
      if (!info) throw new Error('所选目录不是 ModMind 项目，缺少 modmind.project.json')
      if (!info.draft) studios().require(info)
      currentProject = await offerProjectVersionMigration(info)
      await rememberRecentProject(currentProject)
      emitProjectChanged()
      return currentProject
  })

  diagnosticHandle('project:openRecent', async (_event, projectPath: string) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目路径无效')
    const resolvedProjectPath = path.resolve(projectPath)
    assertProjectSwitchAllowed()
    const info = await readAvailableProjectForOpening(resolvedProjectPath)
      if (!info) throw new Error('最近项目不存在或已经不再是有效的 ModMind 项目')
      if (!info.draft) studios().require(info)
      currentProject = await offerProjectVersionMigration(info)
      await rememberRecentProject(currentProject)
      emitProjectChanged()
      return currentProject
  })

  diagnosticHandle('project:listRecent', () => readRecentProjects())
  diagnosticHandle('project:removeRecent', (_event, projectPath: string) => removeProjectAssociation(projectPath))
  diagnosticHandle('project:delete', (_event, projectPath: string) => deleteProjectDirectory(projectPath))
  diagnosticHandle('project:deletePermanent', (_event, projectPath: string) => permanentlyDeleteProjectDirectory(projectPath))

  diagnosticHandle('project:current', () => currentProject)
  const packImportControllers = new Map<string, AbortController>()


  const ftbProject = (expected: unknown): ProjectInfo => {
    const project = requireProject()
    if (expected !== undefined && (typeof expected !== 'string' || path.resolve(expected).toLowerCase() !== path.resolve(project.path).toLowerCase())) throw new Error('FTB request belongs to a different project')
    return { ...project }
  }
  onModpackManifestChanged(projectPath => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('modpack:modsChanged', projectPath)
    }
  })


  registerServerPluginIpc({ project: requireProject, window: () => mainWindow!, busy: () => Boolean(optionalTestingService()?.localServerManager?.isBusy() || runsForProject(requireProject().path).length) })


  diagnosticHandle('project:listFiles', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return listDirectory(project.path, '', true)
  })
  diagnosticHandle('project:listImageAssets', async (): Promise<ProjectImageAsset[]> => {
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
  diagnosticHandle('project:readImageAsset', async (_event, relativePath: string, projectPath?: string): Promise<string> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return readProjectImage(project.path, relativePath)
  })
  diagnosticHandle('project:readModelAsset', async (_event, relativePath: string, projectPath: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return readProjectModel(project.path, relativePath)
  })
  diagnosticHandle('project:readFile', async (_event, relativePath: string, projectPath?: string) => {
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
  diagnosticHandle('project:readWorkbenchData', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return workbenchDataStore.read(project.path, relativePath)
  })
  diagnosticHandle('project:writeWorkbenchData', async (_event, relativePath: string, content: string, projectPath?: string) => {
    if (typeof content !== 'string') throw new Error('工作台对话数据无效')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return workbenchDataStore.write(project.path, relativePath, content)
  })
  diagnosticHandle('conversations:list', async (_event, projectPath: string, surface?: AiSurface, includeArchived?: boolean) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.list(project.path, surface, includeArchived === true)
  })
  diagnosticHandle('conversations:read', async (_event, projectPath: string, conversationId: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.read(project.path, conversationId)
  })
  diagnosticHandle('conversations:create', async (_event, projectPath: string, input) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.create(project.path, input)
  })
  diagnosticHandle('conversations:readProjection', async (_event, projectPath: string, conversationId: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.readProjection(project.path, conversationId)
  })
  diagnosticHandle('conversations:historyPage', async (_event, projectPath: string, conversationId: string, input?: import('../shared/types').ConversationHistoryPageInput) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.historyPage(project.path, conversationId, input)
  })
  diagnosticHandle('conversations:saveHistoryWindow', async (_event, projectPath: string, conversationId: string, generation: number, token: string, start: number, items: unknown[]) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (!Array.isArray(items) || typeof token !== 'string' || !Number.isSafeInteger(start) || start < 0) throw new Error('历史保存范围无效')
    return conversationStore.saveHistoryWindow(project.path, conversationId, generation, token, start, items)
  })
  diagnosticHandle('conversations:deleteHistoryItem', async (_event, projectPath: string, conversationId: string, generation: number, itemId: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (runsForProject(project.path).some(run => run.conversationId === conversationId)) throw new Error('请先停止当前任务，再删除对话内容')
    return conversationStore.deleteHistoryItem(project.path, conversationId, generation, itemId)
  })
  diagnosticHandle('conversations:ensureProjection', async (_event, projectPath: string, input) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.ensureProjection(project.path, input)
  })
  diagnosticHandle('conversations:saveProjection', async (_event, projectPath: string, conversationId: string, generation: number, view, title?: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.saveProjection(project.path, conversationId, generation, view, title)
  })
  diagnosticHandle('conversations:saveView', async (_event, projectPath: string, conversationId: string, generation: number, view, title?: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.saveView(project.path, conversationId, generation, view, title)
  })
  diagnosticHandle('conversations:eventsSince', async (_event, projectPath: string, conversationId: string, generation: number, afterSequence?: number, limit?: number) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.eventsSince(project.path, conversationId, generation, afterSequence, limit)
  })
  diagnosticHandle('conversations:replaceView', async (_event, projectPath: string, conversationId: string, generation: number, view) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (runsForProject(project.path).some(run => run.conversationId === conversationId)) throw new Error('请先停止当前任务，再删除对话内容')
    return conversationStore.replaceView(project.path, conversationId, generation, view)
  })
  diagnosticHandle('conversations:fork', async (_event, projectPath: string, input) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.fork(project.path, input)
  })
  diagnosticHandle('conversations:archive', async (_event, projectPath: string, conversationId: string, archived: boolean) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.archive(project.path, conversationId, archived === true)
  })
  diagnosticHandle('conversations:rename', async (_event, projectPath: string, conversationId: string, title: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.rename(project.path, conversationId, title)
  })
  diagnosticHandle('conversations:pin', async (_event, projectPath: string, conversationId: string, pinned: boolean) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    return conversationStore.pin(project.path, conversationId, pinned === true)
  })
  diagnosticHandle('conversations:generateTitle', async (_event, projectPath: string, conversationId: string, userText: string, answer: string, backend: AgentSettings['codingBackend'], modelSelection?: AiModelSelection) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const document = await conversationStore.read(project.path, conversationId)
    if (!document) throw new Error('对话不存在')
    if (document.titleSource) return document
    if (typeof userText !== 'string' || !userText.trim() || typeof answer !== 'string' || !answer.trim()) throw new Error('首轮问答内容不完整')
    const selected = backend === 'quota' || backend === 'codex' ? backend : (await readSettings()).codingBackend
    const titlePrompt = `根据首轮对话给这段聊天起一个简短、具体的中文标题，最多 20 个汉字。只输出标题，不要引号、解释或标点。\n用户：${userText.slice(0, 1200)}\nAI：${answer.slice(0, 1800)}`
    let title = selected === 'quota' ? '' : answer.replaceAll(/```[\s\S]*?```/gu, '').replaceAll(/[#>*`_]/gu, '').split(/\r?\n|[。！？!?]/u).map(item => item.trim()).find(Boolean) ?? ''
    try {
      title = await requestProjectAiName(project, titlePrompt, `conversation-title/${conversationId}`, selected, modelSelection)
    } catch (error) { if (selected === 'quota') throw error }
    const clean = title.replaceAll(/<[^>]*>/gu, '').replaceAll(/^[\s"'“”「」《》#*`]+|[\s"'“”「」《》。.!！?？#*`]+$/gu, '').split(/\r?\n/u)[0]?.trim() ?? ''
    if (!clean) throw new Error('AI 未返回有效对话名称')
    return conversationStore.setGeneratedTitle(project.path, conversationId, clean)
  })
  diagnosticHandle('conversations:delete', async (_event, projectPath: string, conversationId: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (runsForProject(project.path).some(run => run.conversationId === conversationId)) throw new Error('请先停止当前任务，再删除对话')
    return conversationStore.delete(project.path, conversationId, async (sessions) => {
      await Promise.allSettled(Object.entries(sessions).map(([backend, state]) => state?.sessionId
        ? deleteExternalAgentSession(project, backend === 'quota' ? 'codex' : backend as ExternalAgentKind, state.sessionId, state.sessionHome, backend === 'quota' || backend === 'codex' ? managedCodexExecutablePath(app.getPath('userData')) : undefined)
        : Promise.resolve()))
    })
  })
  diagnosticHandle('conversations:flush', () => conversationStore.flush())
  diagnosticHandle('project:writeFile', async (_event, relativePath: string, content: string, projectPath?: string) => {
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) throw new Error('文件内容超过 2 MB 编辑上限')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeCodingPath(relativePath, true, true, project)
    const target = await resolveSafeCodingTarget(normalized, project)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await verifiedDiagnosticWrite(project.path, normalized, target, content)
  })
  diagnosticHandle('project:captureIdea', async (_event, prompt: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('鎸囧畾鐨勯」鐩笉瀛樺湪鎴栨棤鏁')
    await captureCreationRequest(project, prompt)
  })
  diagnosticHandle('project:createFile', async (_event, relativePath: string, content = '', projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    const target = await resolveSafeCodingTarget(normalized, project)
    if (await pathExists(target)) throw new Error('目标路径已存在')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    return { project, path: normalized }
  })
  diagnosticHandle('project:createDirectory', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    const target = await resolveSafeCodingTarget(normalized, project)
    if (await pathExists(target)) throw new Error('目标路径已存在')
    await fs.mkdir(target, { recursive: true })
    return { project, path: normalized }
  })
  diagnosticHandle('project:renamePath', async (_event, from: string, to: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const source = await resolveSafeCodingTarget(normalizeReadablePath(from, project), project)
    const destination = await resolveSafeCodingTarget(normalizeReadablePath(to, project), project)
    if (!(await pathExists(source))) throw new Error('源路径不存在')
    if (await pathExists(destination)) throw new Error('目标路径已存在')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(source, destination)
    return { project, path: path.relative(project.path, destination).replaceAll('\\', '/') }
  })
  diagnosticHandle('project:deletePath', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    if (isToolDataDirectory(normalized.split('/')[0]) || ignoredDirectories.has(normalized.split('/')[0])) throw new Error('不能删除受保护的项目目录')
    const target = await resolveSafeCodingTarget(normalized, project)
    try { await shell.trashItem(target) } catch (error) {
      const failure = new Error('文件无法放入系统回收站，需要再次确认后永久删除') as Error & { code?: string; cause?: unknown }
      failure.code = 'TRASH_UNAVAILABLE'; failure.cause = error; throw failure
    }
  })
  diagnosticHandle('project:deletePathPermanent', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project)
    if (isToolDataDirectory(normalized.split('/')[0]) || ignoredDirectories.has(normalized.split('/')[0])) throw new Error('不能删除受保护的项目目录')
    await fs.rm(await resolveSafeCodingTarget(normalized, project), { recursive: true, force: true })
  })
  // The generic delete path refuses everything under .modmind; workbench data
  // cleanup needs a narrow exception for exactly the files ModMind owns.
  diagnosticHandle('project:deleteWorkbenchData', async (_event, relativePath: string, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = normalizeReadablePath(relativePath, project).replaceAll('\\', '/')
    // The renderer sends '.modmind/'-prefixed paths; accept both forms so the
    // whitelist cannot silently reject every cleanup call again.
    const scoped = normalized.replace(/^\.modmind\//u, '')
    const workbenchDocument = /^(?:workbench-conversations|workbench-timeline(?:-[\w-]+)?)\.json$/u.test(scoped)
    if (scoped !== 'external-agents/session-codex.json'
      && !workbenchDocument
      && !/^external-agents\/sessions\/workspace\/[\w.-]+$/u.test(scoped)) {
      throw new Error('只能删除工作台对话数据文件')
    }
    if (workbenchDocument) return workbenchDataStore.delete(project.path, `.modmind/${scoped}`)
    await fs.rm(resolveProjectPathFor(project, `.modmind/${scoped}`), { recursive: true, force: true })
  })
  diagnosticHandle('project:reveal', async (_event, relativePath = '', projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    const normalized = relativePath ? normalizeReadablePath(relativePath, project) : ''
    shell.showItemInFolder(resolveProjectPathFor(project, normalized))
  })
  diagnosticHandle('project:hasExportArtifact', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效的 ModMind 项目')
    if (project.kind === 'server-plugin') return findPluginArtifact(project).then(() => true).catch(() => false)
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
  diagnosticHandle('project:exportArtifact', async () => {
    const project = requireProject()
    if (studios().resolve(project)?.definition.tasks?.export) {
      const result = await studios().invokeTask(project, 'export', {}, { projectPath: project.path, surface: 'workbench', windowId: mainWindow?.id }) as { path?: string } | null
      return result?.path ?? null
    }
    if (project.kind === 'server-plugin') {
      await buildProjectWithLock()
      const artifact = await findPluginArtifact(project)
      const result = await dialog.showSaveDialog(mainWindow!, { title: '导出服务端插件', defaultPath: path.join(app.getPath('downloads'), artifact.name), filters: [{ name: 'Minecraft Server Plugin', extensions: ['jar'] }] })
      if (result.canceled || !result.filePath) return null
      if (!sameProjectPath(result.filePath, artifact.path)) await fs.copyFile(artifact.path, result.filePath)
      return result.filePath
    }
    if (isModpackProject(project)) {
      const releaseService = featurePluginService.enabled('publishing') ? requireReleaseService() : null
      const release = releaseService ? await releaseService.prepareExport(project) : { version: '1.0.0', summary: '', modpackExportMode: 'bundled' as const }
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出 Modrinth 整合包',
        defaultPath: path.join(app.getPath('downloads'), `${project.namespace}-${release.version}.mrpack`),
        filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeModrinthPackArchive(project, result.filePath, { version: release.version, summary: release.summary, mode: release.modpackExportMode })
      if (releaseService) await releaseService.markExported(project)
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
    if (featurePluginService.enabled('publishing')) await requireReleaseService().prepareExport()
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
    if (featurePluginService.enabled('publishing')) await requireReleaseService().markExported()
    return result.filePath
  })
  diagnosticHandle('project:prepareIde', () => prepareProjectIde(requireProject()))
  diagnosticHandle('project:openIde', async () => {
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
  diagnosticHandle('project:previewMigration', (_event, input: ProjectMigrationInput) => previewProjectMigration(input))
  diagnosticHandle('project:migrate', (_event, input: ProjectMigrationInput) => migrateProject(input))

  diagnosticHandle('build:preflight', async (event, projectPath?: string): Promise<PreflightResult> => {
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


  const inspirationKnowledge = projectKnowledgeStore()
  diagnosticHandle('inspiration:readEvidence', async (_event, projectPath: string, input: InspirationEvidenceRequest) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project || !input || typeof input !== 'object') throw new Error('来源请求无效')
    if (input.file) return runInspirationResearch(project, { operation: input.kind === 'resource' ? 'resource' : 'read', path: input.path, relativePath: input.file, startLine: input.line, limit: 100 }, {
      backend: () => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile'),
      cacheRoot: path.join(app.getPath('userData'), 'decompile'), signal: AbortSignal.timeout(30000), ensureJava: async () => { throw new Error('查看来源不会启动反编译') }
    })
    try {
      const result = await readProjectTextFile(project, input.path, input.line, 100)
      return { source: result.path, totalLines: result.totalLines, nextStartLine: result.nextStartLine, lines: result.content.split('\n').map((text, index) => ({ line: result.startLine + index, text })) }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('1 MiB')) throw error
      return runInspirationResearch(project, { operation: 'text', path: input.path, startLine: input.line, limit: 100 }, {
        backend: () => featurePluginService.service<ReturnType<typeof import('../../feature-plugins/decompile/main').activate>>('decompile'),
        cacheRoot: path.join(app.getPath('userData'), 'decompile'), signal: AbortSignal.timeout(30000), ensureJava: async () => { throw new Error('文本读取不会启动 Java') }
      })
    }
  })
  diagnosticHandle('inspiration:listModels', async (_event, backend: AgentSettings['codingBackend']) => {
    if (backend === 'quota') return listBeginnerModels(true)
    if (backend !== 'codex') throw new Error('不支持的 AI 引擎')
    const settings = await readSettings()
    const configuration = settings.externalAgents?.[backend] ?? {}
    return listAvailableAgentModels(backend, configuration)
  })
  diagnosticHandle('inspiration:readKnowledge', async (_event, projectPath: string) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在')
    return inspirationKnowledge.read(project.path)
  })
  const resolveInspirationRecord = async (projectPath: string, identity: InspirationWorkflowIdentity): Promise<ProjectInfo> => {
    if (!identity || typeof identity.conversationId !== 'string' || typeof identity.turnId !== 'string' || !Number.isInteger(identity.generation)) throw new Error('灵感会话身份无效')
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!project) throw new Error('项目不存在')
    const conversation = await conversationStore.read(project.path, identity.conversationId)
    if (!conversation || conversation.surface !== 'inspiration' || conversation.generation !== identity.generation) throw new Error('灵感会话版本已变化，请重新整理')
    return project
  }
  diagnosticHandle('inspiration:readWorkflow', async (_event, projectPath: string, identity: InspirationWorkflowIdentity) => {
    const project = await resolveInspirationRecord(projectPath, identity)
    return projectInspirationWorkflowStore().read(project.path, identity)
  })
  diagnosticHandle('inspiration:commitWorkflow', async (_event, projectPath: string, identity: InspirationWorkflowIdentity, edits: Array<{ index: number; title: string; content: string }>, undo = false) => {
    const project = await resolveInspirationRecord(projectPath, identity)
    if (!Array.isArray(edits) || edits.length > 8 || typeof undo !== 'boolean') throw new Error('知识变更参数无效')
    return projectInspirationWorkflowStore().commit(project.path, identity, edits, undo)
  })
  diagnosticHandle('inspiration:updateKnowledge', async (_event, projectPath: string, input: { id?: string; title?: string; content?: string; remove?: boolean }) => {
    const project = await readProjectInfo(path.resolve(projectPath))
    if (!input || typeof input !== 'object') throw new Error('知识条目无效')
    if (!project) throw new Error('项目不存在')
    return inspirationKnowledge.update(project.path, input)
  })

  // Controlled JAR decompilation (受控反编译): results live in the userData cache, never in project sources.
  const decompileCacheRoot = (): string => path.join(app.getPath('userData'), 'decompile')
  const activeDecompileRuns = new Map<string, AbortController>()

  diagnosticHandle('settings:revealSecret', async (_event, key: string) => {
    switch (key) {
      case 'codex': {
        const configured = (await readSettings()).externalAgents?.codex
        return configured?.mode === 'hosted' ? configured.apiKey || await readLocalCodexApiKey() : await readLocalCodexApiKey() || configured?.apiKey || ''
      }
      case 'image': return requireImageStudio().revealApiKey()
      case 'gitee': return (await readGiteeBuildSettings()).token
      case 'modrinthToken': case 'curseForgeToken': case 'githubToken': return (await readReleaseSecrets())[key]
      default: throw new Error('未知凭证类型')
    }
  })
  diagnosticHandle('settings:getAgent', async () => {
    const settings = await readSettings()
    return publicAgentSettings(settings)
  })
  diagnosticHandle('settings:pickBackground', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow!
    const result = await dialog.showOpenDialog(owner, { title: '选择背景图片或视频', properties: ['openFile'], filters: [
      { name: '图片或视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }, { name: '视频', extensions: ['mp4', 'webm'] }
    ] })
    if (result.canceled || !result.filePaths[0]) return null
    return importBackgroundMedia(result.filePaths[0], path.join(app.getPath('userData'), 'appearance-media'))
  })
  diagnosticHandle('settings:saveAgent', async (_event, settings: AgentSettingsPatch) => {
    const saved = await saveAgentSettings(settings)
    setNetworkProxy(saved.networkProxyUrl ?? '')
    return publicAgentSettings(saved)
  })
  diagnosticHandle('settings:listAgentModels', (_event, kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) => listAvailableAgentModels(kind, configuration))
  diagnosticHandle('settings:scanGradle', () => scanGradleInstallations())
  diagnosticHandle('settings:scanJavaHomes', () => scanConfiguredJavaHomes())
  diagnosticHandle('settings:probeJavaHome', (_event, home: unknown) => {
    if (typeof home !== 'string' || !home.trim()) throw new Error('缺少要检测的 Java 路径')
    return probeJavaHomeInfo(home)
  })
  diagnosticHandle('settings:pickJavaHome', async () => {
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
      if (typeof errorValue.componentStack === 'string') Object.assign(rendererError, { componentStack: errorValue.componentStack })
      if (errorValue.details !== undefined) Object.assign(rendererError, { details: errorValue.details })
    }
    diagnosticJournal.record({
      subsystem,
      operation,
      phase,
      level,
      message,
      ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
      data: { detail: value.data, ...(value.data && typeof value.data === 'object' && 'projectPath' in value.data && typeof value.data.projectPath === 'string' ? { projectPath: value.data.projectPath } : {}), webContentsId: _event.sender.id, osProcessId: _event.sender.getOSProcessId() },
      ...(rendererError ? { error: rendererError } : {})
    })
  })
  diagnosticHandle('modpack:manageLock', async (_event, input: Record<string, unknown>, expectedProjectPath: unknown) => {
    const project = requireProject()
    if (typeof expectedProjectPath !== 'string' || !sameProjectPath(project.path, expectedProjectPath)) throw new Error('当前项目已切换，请重新打开模组列表')
    if (input?.operation === 'repair') assertProjectMutationAllowed(project.path, '修复模组锁')
    return manageModpackLock(project, input)
  })
  diagnosticHandle('diagnostics:readState', (_event, limit: unknown) => readDiagnosticState(currentProject?.path, { limit }))
  diagnosticHandle('diagnostics:pickAttachments', async event => {
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow!, { title: '选择日志、账单或现场附件', properties: ['openFile', 'multiSelections'] })
    return selected.canceled ? [] : diagnosticAttachments.register(event.sender.id, selected.filePaths)
  })
  diagnosticHandle('diagnostics:exportLogs', (event, input: unknown, options: unknown) => {
    const pages = Array.isArray(input) ? input as DiagnosticPageSnapshot[] : []
    return exportDiagnosticLogs(pages, diagnosticExportOptions(options), event.sender.id)
  })
  diagnosticHandle('remote-build:gitee:getSettings', () => readGiteeBuildSettings().then((settings) => ({ ...settings, token: '' })))
  diagnosticHandle('remote-build:gitee:saveSettings', (_event, settings: GiteeBuildSettings) => saveGiteeBuildSettings(settings))
  diagnosticHandle('remote-build:gitee:validate', async (_event, settings?: GiteeBuildSettings) => runDiagnosticOperation('gitee', 'validate', 'Gitee connection validation', async () => {
    const stored = await readGiteeBuildSettings()
    const input = settings ? { ...stored, ...settings, token: settings.token?.trim() || stored.token } : stored
    return requireGiteeBuildService().validate(input)
  }))
  diagnosticHandle('remote-build:gitee:trigger', () => runDiagnosticOperation('gitee', 'trigger', 'Gitee remote build', () => requireGiteeBuildService().trigger()))
  diagnosticHandle('external-agents:detect', async () => {
    const configured = (await readSettings()).externalAgents?.codex
    return Promise.all([
      detectInstalledCodex(configured)
    ])
  })
  diagnosticHandle('external-agents:scanLocal', () => scanConfiguredCodex())
  diagnosticHandle('external-agents:configure', (_event, kind: ExternalAgentKind, configuration: ExternalAgentConfiguration) => configureExternalAgentConnection(kind, configuration))
  diagnosticHandle('external-agents:history', async (_event, kind: ExternalAgentKind) => {
    if (kind !== 'codex') throw new Error('不支持的外部代理')
    const project = aiProjectContext.getStore() ?? currentProject
    if (!project) return ''
    return readExternalAgentHistory(project, kind, 'workspace')
  })
  diagnosticHandle('external-agents:install', async (_event, kind: ExternalAgentKind) => {
    if (kind !== 'codex') throw new Error('不支持的外部代理')
    const executable = await ensureManagedCodexRuntime({rootDir: app.getPath('userData')})
    const status = await detectExternalAgent('codex', {executables: [executable], includeDefaults: false})
    if (!status.installed || !isManagedCodexVersion(status.version)) throw new Error('Codex 托管运行时版本校验失败')
    await saveAgentSettings({
      externalAgents: { codex: { executable } }
    })
    return status
  })
  diagnosticHandle('external-agents:openDocs', (_event, kind: ExternalAgentKind) => {
    if (kind !== 'codex') throw new Error('不支持的外部代理')
    return shell.openExternal(externalAgentDocsUrl(kind))
  })
  diagnosticHandle('external-agents:launch', async (_event, kind: ExternalAgentKind) => {
    if (kind !== 'codex') throw new Error('不支持的外部代理')
    const project = requireProject()
    const settings = await readSettings()
    const configured = settings.externalAgents?.[kind] ?? {}
    const configuredCodex = kind === 'codex' && configured.mode === 'hosted'
      ? await prepareConfiguredCodex(project, 'manual', configured)
      : undefined
    const env = configuredCodex?.environment ?? await externalAgentRunEnvironment(kind, settings)
    const executable = kind === 'codex'
      ? configuredCodex?.executable ?? (configured.mode === 'hosted' ? await ensureManagedCodexRuntime({ rootDir: app.getPath('userData') }) : (await detectInstalledCodex(configured)).executable)
      : configured.executable
    await launchExternalAgent(kind, project, executable, env, undefined, featurePluginService.enabled('image-studio'))
  })
  diagnosticHandle('beginner-codex:prepare', async (event, projectPath?: string, selection?: AiModelSelection) => {
    const routedProjectPath = typeof projectPath === 'string' && projectPath.trim() ? path.resolve(projectPath) : undefined
    const project = routedProjectPath ? await readProjectInfo(routedProjectPath) : currentProject
    if (!project) throw new Error('请先创建或打开项目')
    try {
      const serverConfig = await readBeginnerAgentServerConfig(normalizeAiModelSelection(selection))
      const result = await prepareQuotaCodex(project, 'workspace', (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('beginner-codex:progress', {...progress, ...(routedProjectPath ? {projectPath: routedProjectPath} : {})})
      }, undefined, serverConfig)
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
  diagnosticHandle('ai:listApprovals', event => workbenchApprovals.list(event.sender.id))
  diagnosticHandle('ai:listQuestions', event => workbenchQuestions.list(event.sender.id))
  diagnosticHandle('ai:answerQuestion', (event, context: WorkbenchQuestionContext, answers: unknown) => workbenchQuestions.answer(event.sender.id, context, answers))
  diagnosticHandle('ai:dismissQuestion', (event, context: WorkbenchQuestionContext) => workbenchQuestions.dismiss(event.sender.id, context))
  diagnosticHandle('ai:respondApproval', (event, id: string, decision: unknown) => workbenchApprovals.respond(event.sender.id, id, decision))
  diagnosticHandle('ai:pickAttachments', (_event, kind: AiAttachmentSelectionKind, projectPath?: string) => {
    if (kind !== 'files' && kind !== 'directory') throw new Error('附件选择类型无效')
    return pickAiAttachments(kind, projectPath)
  })
  diagnosticHandle('ai:importAttachments', async (_event, sources: AiAttachmentSource[], projectPath?: string) => {
    const project = await attachmentProject(projectPath)
    const copied = await importAiAttachmentSources(project.path, sources)
    return validateAiAttachments(copied, project.path)
  })
  diagnosticHandle('ai:validateAttachments', (_event, attachments: AiAttachment[], projectPath?: string) => validateAiAttachments(attachments, projectPath))
  diagnosticHandle('ai:createCode', async (event, prompt: string, sessionId?: string, backend?: AgentSettings['codingBackend'], executionProfile?: AiExecutionProfile, options?: AiCreateCodeOptions) => {
    if (false) {
      aiCancelRequests.delete(event.sender.id)
      const error = new Error('AI 编程已停止')
      error.name = 'AbortError'
      throw error
    }
    const requestedSurface: AiSurface = options?.surface === 'inspiration' ? 'inspiration' : 'workspace'
    const project = await resolveAiProject(options)
    if (requestedSurface === 'workspace' && !usesInspirationWorkflow(options ?? {}) && isAiAbandonmentRequest(prompt)) {
      const recovery = await readActiveAiTask(project)
      const ownsRecovery = Boolean(recovery && aiRecoveryMatchesSessionScope(recovery, options?.sessionScope))
      if (recovery && ownsRecovery) await clearActiveAiTask(project, recovery.taskId)
      const response = recovery && !ownsRecovery
        ? '当前对话没有可放弃的恢复任务，其他对话的任务未受影响。'
        : '已放弃当前恢复任务。'
      return { summary: response, finalResponse: response, tasks: [], files: [], tests: [], warnings: [], snapshot: { id: '', label: '', createdAt: new Date().toISOString(), fileCount: 0 }, changedFiles: [], intent: 'informational' }
    }
    const recoveryCandidate = requestedSurface === 'workspace' && !usesInspirationWorkflow(options ?? {}) && isAiContinuationRequest(prompt)
      ? await readActiveAiTask(project)
      : undefined
    const recovery = recoveryCandidate && aiRecoveryMatchesSessionScope(recoveryCandidate, options?.sessionScope)
      ? recoveryCandidate
      : undefined
    const selectedBackend = backend === 'quota' || backend === 'codex'
      ? backend
      : recovery?.backend === 'quota' || recovery?.backend === 'codex'
        ? recovery.backend
        : (await readSettings()).codingBackend
    const preparedConversation = await prepareConversationRequest(project, prompt, requestedSurface, options ?? {}, recovery)
    pluginChatBridge.syncRecords(getPluginService()?.getSnapshot().plugins ?? [])
    const pluginContext = !recovery && requestedSurface === 'workspace' && preparedConversation.options.conversationId
      ? pluginChatBridge.contextFor({ projectPath: project.path, conversationId: preparedConversation.options.conversationId }) : ''
    if (pluginContext) {
      prompt += pluginContext
      if (preparedConversation.options.fallbackPrompt) preparedConversation.options.fallbackPrompt += pluginContext
    }
    const branchNative = preparedConversation.document?.native[selectedBackend]
    const conversationOptions: AiCreateCodeOptions = branchNative && preparedConversation.document?.parent && preparedConversation.document.nativeForkPending
      ? { ...preparedConversation.options, forkFrom: { sessionId: branchNative.sessionId, ...(preparedConversation.document.parent.nativeTurnId ? preparedConversation.document.parent.boundary === 'before' ? { beforeTurnId: preparedConversation.document.parent.nativeTurnId } : { lastTurnId: preparedConversation.document.parent.nativeTurnId } : branchNative.lastTurnId ? { lastTurnId: branchNative.lastTurnId } : {}), nativeMode: preparedConversation.document.parent.nativeMode } }
      : preparedConversation.options
    const normalizedExecutionProfile: AiExecutionProfile = recovery?.executionProfile === 'beginner-unlimited' || executionProfile === 'beginner-unlimited'
      ? 'beginner-unlimited'
      : 'standard'
    const run: ActiveAiRun = {
      id: aiRunId(event.sender.id, project.path, sessionId), senderId: event.sender.id, startedAt: recovery?.startedAt ?? new Date().toISOString(), sessionId, sessionScope: conversationOptions.sessionScope, projectPath: project.path,
      executionProfile: normalizedExecutionProfile, backend: selectedBackend, surface: requestedSurface,
      ...(requestedSurface === 'inspiration' ? { inspirationFeatures: normalizeInspirationFeatures(conversationOptions.inspirationFeatures) } : {}),
      ...(conversationOptions.agentMode !== 'beginner' && options?.workbenchPhase === 'discussion' ? { workbenchPhase: 'discussion' as const } : {}),
      conversationId: conversationOptions.conversationId,
      generation: conversationOptions.generation,
      turnId: conversationOptions.turnId
    }
    const controller = new AbortController()
    try {
      return await withAiRun(run, controller, () => recovery
        ? runExternalCodingAgent(event, recovery.prompt, sessionId, selectedBackend, normalizedExecutionProfile, recovery, { ...conversationOptions, runId: run.id, surface: 'workspace', projectPath: project.path }, controller.signal)
        : createAiCode(event, prompt, sessionId, selectedBackend, normalizedExecutionProfile, { ...conversationOptions, runId: run.id, surface: requestedSurface, projectPath: project.path }, controller.signal))
    } catch (error) {
      const message = describeAgentRunError(error)
      const cancellation = error instanceof Error && error.name === 'AbortError'
      const recoverable = cancellation || isRecoverableAgentRunError(error, message)
      // This execution has ended, even when its saved task can be resumed later.
      sendAiOutput(event, cancellation || message.includes('连续整理上下文') ? 'warning' : 'error', message, sessionId, project.path, run.id, { terminal: true, recoverable, backend: run.backend })
      throw new Error(message)
    }

  })
  diagnosticHandle('ai:cancelCode', async (event, sessionId?: string, projectPath?: string): Promise<AiCancellationResult> => {
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
    const result: AiCancellationResult = { status: stopped ? 'stopped' : 'timed_out', matched, remaining }
    diagnosticJournal.record({
      subsystem: 'ai',
      operation: 'cancel',
      phase: stopped ? 'success' : 'timeout',
      level: stopped ? 'info' : 'warning',
      message: stopped ? `Stopped ${matched} Agent run(s)` : `Agent cancellation timed out with ${remaining} run(s) still registered`,
      data: { projectPath, sessionId, matched, remaining }
    })
    return result
  })
  diagnosticHandle('ai:clearQuotaCredentials', () => clearPreparedCodexCredentials())
  diagnosticHandle('ai:getRecovery', (_event, projectPath?: string) => getAiRecoveryInfo(projectPath))
  diagnosticHandle('ai:getProjectTaskState', async (_event, projectPath?: string): Promise<AiProjectTaskState> => {
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或不是有效 ModMind 项目')
    return aiProjectTaskState(project.path)
  })
  diagnosticHandle('ai:resumeRecovery', async (event, projectPath?: string, conversationId?: string, features?: WorkbenchFeatures) => {
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
    if (features !== undefined) recovery.workbenchFeatures = normalizeWorkbenchFeatures(features)
    if (conversationId !== undefined && aiConversationIdForSession(recovery) !== conversationId) throw new Error('该未完成任务属于另一个对话，请切换到原对话继续')
    const executionProfile = recovery.executionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard'
    const backend = recovery.backend === 'quota' || recovery.backend === 'codex' ? recovery.backend : 'codex'
    const recoveryConversation = recovery.conversationId ? await conversationStore.readContext(project.path, recovery.conversationId).catch(() => null) : null
    const recoveryTurnId = `turn-${recovery.taskId}`
    const run: ActiveAiRun = { id: aiRunId(event.sender.id, project.path, recovery.sessionId), senderId: event.sender.id, startedAt: recovery.startedAt, sessionId: recovery.sessionId, sessionScope: recovery.sessionScope, projectPath: project.path, executionProfile, backend, surface: 'workspace', ...(recovery.conversationId ? { conversationId: recovery.conversationId } : {}), ...(recoveryConversation ? { generation: recoveryConversation.generation } : {}), turnId: recoveryTurnId }
    const controller = new AbortController()
    try {
      return await withAiRun(run, controller, () => runExternalCodingAgent(event, recovery.prompt, recovery.sessionId, backend, executionProfile, recovery, { runId: run.id, surface: 'workspace', projectPath: project.path, fallbackPrompt: recovery.fallbackPrompt ?? recovery.prompt, ...(recovery.conversationId ? { conversationId: recovery.conversationId } : {}), ...(recoveryConversation ? { generation: recoveryConversation.generation } : {}), turnId: recoveryTurnId }, controller.signal))
    } catch (error) {
      const message = describeAgentRunError(error)
      const cancellation = error instanceof Error && error.name === 'AbortError'
      const recoverable = cancellation || isRecoverableAgentRunError(error, message)
      sendAiOutput(event, cancellation || message.includes('连续整理上下文') ? 'warning' : 'error', message, recovery.sessionId, project.path, run.id, { terminal: true, recoverable, backend: run.backend })
      throw new Error(message)
    }

  })
  diagnosticHandle('ai:switchBackend', async (event, requestedBackend: AgentSettings['codingBackend'], projectPath?: string, sessionScope?: string, switchId?: number): Promise<AiBackendSwitchResult> => {
    if (!['quota', 'codex'].includes(requestedBackend)) throw new Error('不支持的 AI 内核')
    const project = projectPath?.trim() ? await readProjectInfo(path.resolve(projectPath)) : requireProject()
    if (!project) throw new Error('项目不存在或无效')
    if (activeWorkspaceRun(project.path)?.workbenchPhase === 'discussion') throw new Error('请先停止快速问答或等待回答完成后再切换引擎')
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
        await awaitWithAbort(saveAgentSettings(current => ({ ...current, codingBackend: requestedBackend })), controller.signal, 'Agent 切换已停止')
      }
      if (!recovery) {
        if (!aiBackendSwitchCoordinator.markReady(switchState)) return { status: 'superseded', backend: requestedBackend }
        return { status: 'idle', backend: requestedBackend }
      }
      const scope = sessionScope?.trim() || recovery.sessionScope
      const recoveryConversation = recovery.conversationId ? await conversationStore.readContext(project.path, recovery.conversationId).catch(() => null) : null
      const recoveryTurnId = `turn-${recovery.taskId}`
      run = {
        id: aiRunId(event.sender.id, project.path, recovery.sessionId ?? `switch-${generation}`),
        senderId: event.sender.id,
        startedAt: recovery.startedAt,
        sessionId: recovery.sessionId,
        sessionScope: scope,
        projectPath: project.path,
        executionProfile: requestedBackend === 'quota' && recovery.executionProfile === 'beginner-unlimited' ? 'beginner-unlimited' : 'standard',
        backend: requestedBackend,
        surface: 'workspace',
        ...(recovery.conversationId ? { conversationId: recovery.conversationId } : {}),
        ...(recoveryConversation ? { generation: recoveryConversation.generation } : {}),
        turnId: recoveryTurnId
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
        { runId: activeRun.id, surface: 'workspace', projectPath: project.path, sessionScope: scope, resumeSession: true, fallbackPrompt: activeRecovery.fallbackPrompt ?? activeRecovery.prompt, ...(activeRecovery.conversationId ? { conversationId: activeRecovery.conversationId } : {}), ...(recoveryConversation ? { generation: recoveryConversation.generation } : {}), turnId: recoveryTurnId },
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
          await awaitWithAbort(saveAgentSettings(current => current.codingBackend === requestedBackend
            ? { ...current, codingBackend: switchState.rollbackValue.codingBackend } : current), AbortSignal.timeout(10_000)).catch(() => undefined)
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
      if (recovery && run) sendAiOutput(event, cancellation || message.includes('连续整理上下文') ? 'warning' : 'error', message, recovery.sessionId, project.path, run.id, { terminal: true, recoverable, backend: run.backend })
      throw new Error(message)
    } finally {
      if (startupTimer) clearTimeout(startupTimer)
      if (activeAiBackendSwitches.get(key) === activeSwitch) activeAiBackendSwitches.delete(key)
    }
  })
  diagnosticHandle('ai:restoreRecovery', () => restoreAiRecovery())

  // --- 用户插件系统 ---------------------------------------------------------
  diagnosticHandle('plugins:list', async () => {
    const service = getPluginService()
    if (!service) return { plugins: [] }
    await waitForPluginRegistry()
    return service.getSnapshot()
  })
  diagnosticHandle('plugins:setEnabled', (_event, pluginId: string, enabled: boolean) => {
    const service = getPluginService()
    if (!service) throw new Error('插件系统未初始化')
    service.setEnabled(String(pluginId), Boolean(enabled))
    getPluginRuntime()?.syncRecords(new Map(service.getSnapshot().plugins.map((record) => [record.manifest.id, record])))
    broadcastPluginSnapshot(service.getSnapshot())
    return service.getSnapshot()
  })
  diagnosticHandle('plugins:importZip', async (event, scope: 'global' | 'project', requestId: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('无效的插件导入请求')
    if (scope === 'project' && !currentProject) throw new Error('请先打开项目')
    return importPluginZipInteractive(scope === 'project' ? 'project' : 'global', window, requestId, () => currentProject?.path ?? null)
  })
  diagnosticHandle('plugins:reload', async () => refreshPluginRegistry(true))
  diagnosticHandle('plugins:openDirectory', async () => {
    const target = path.join(app.getPath('userData'), 'plugins')
    await fs.mkdir(target, { recursive: true })
    await shell.openPath(target)
  })
  diagnosticHandle('plugins:exportDoc', async (_event, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('文档内容为空')
    const target = path.join(app.getPath('downloads'), 'ModMind插件开发文档.md')
    await fs.writeFile(target, content, 'utf8')
    return target
  })
  diagnosticHandle('plugins:invokeTool', async (_event, pluginId: string, toolName: string, input: unknown) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.callTool(String(pluginId), String(toolName), input)
  })
  diagnosticHandle('plugins:activate', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.activate(String(pluginId))
  })
  diagnosticHandle('plugins:restart', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.restart(String(pluginId))
  })
  diagnosticHandle('plugins:diagnostics', (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.getDiagnostics(String(pluginId))
  })
  diagnosticHandle('plugins:clearDiagnostics', (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.clearDiagnostics(String(pluginId))
  })
  diagnosticHandle('plugins:recordLog', (_event, pluginId: string, source: unknown, level: unknown, message: unknown) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    const normalizedSource = source === 'panel' || source === 'overlay' ? source : 'host'
    const normalizedLevel = level === 'warn' || level === 'error' ? level : 'info'
    runtime.recordLog(String(pluginId), normalizedSource, normalizedLevel, String(message ?? '').slice(0, 10_000))
  })
  diagnosticHandle('plugins:handleContextOp', async (_event, pluginId: string, op: string, args: Record<string, unknown>) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), String(op), args ?? {})
  })
  diagnosticHandle('plugins:getProjectInfo', async (_event, pluginId: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), 'projectInfo', {})
  })
  diagnosticHandle('plugins:copyToClipboard', async (_event, pluginId: string, text: string) => {
    const runtime = getPluginRuntime()
    if (!runtime) throw new Error('插件系统未初始化')
    return runtime.handleContextOp(String(pluginId), 'clipboardWrite', { text })
  })
  diagnosticHandle('plugins:export', async (_event, pluginId: string) => {
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
  diagnosticHandle('plugins:delete', async (_event, pluginId: string) => {
    const service = getPluginService()
    if (!service) throw new Error('插件系统未初始化')
    await service.deletePlugin(String(pluginId))
    await refreshPluginRegistry()
    return service.getSnapshot()
  })
  diagnosticHandle('plugins:getOverlayWindows', () => pluginOverlayWindowStates())
  diagnosticHandle('plugins:setOverlayVisible', (_event, pluginId: string, visible: boolean) => setPluginOverlayVisibility(String(pluginId), visible === true))
  ipcMain.on('plugins:workbenchResult', (event, response: import('../shared/plugins').PluginWorkbenchResult) => {
    pluginChatBridge.respond(event.sender.id, response)
  })
  diagnosticHandle('plugins:openOverlayWindow', (_event, pluginId: string) => {
    const normalizedId = String(pluginId)
    createPluginOverlayWindow(normalizedId)
    return pluginOverlayWindowState(normalizedId)
  })
  diagnosticHandle('plugins:closeOverlayWindow', (_event, pluginId: string) => {
    return setPluginOverlayVisibility(String(pluginId), true)
  })
  diagnosticHandle('plugins:setOverlayAlwaysOnTop', (_event, pluginId: string, alwaysOnTop: unknown) => {
    const normalizedId = String(pluginId)
    const window = pluginOverlayWindows.get(normalizedId)
    if (!window || window.isDestroyed()) throw new Error('悬浮窗口未打开')
    window.setAlwaysOnTop(alwaysOnTop === true, 'floating')
    broadcastPluginOverlayWindows()
    return pluginOverlayWindowState(normalizedId)
  })
}

protocol.registerSchemesAsPrivileged([{ scheme: 'modmind-feature', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }, { scheme: 'modmind-dev-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

app.whenReady().then(async () => {
  if (diagnosticRecoveryTarget) {
    try { await exportRecoveryDiagnostics({ logs: app.getPath('logs'), userData: app.getPath('userData'), target: diagnosticRecoveryTarget }); app.exit(0) }
    catch (error) { console.error('诊断恢复导出失败', error); app.exit(1) }
    return
  }
  if (!hasSingleInstanceLock) return
  contributionService = new ContributionService(path.join(app.getPath('userData'), 'contributions.json'), {
    appVersion: app.getVersion(), platform: process.platform, arch: process.arch,
    fetch: (url, options) => networkFetch(url, options)
  })
  const contributionAccount = await readDeviceCredentials()
  contributionService.setUsername(contributionAccount?.username)
  await contributionService.initialize()
  diagnosticIpcOperations.subscribeMetrics(metric => contributionService?.recordOperation(metric))
  setContributionDiagnosticProvider(() => ({ state: contributionService?.state(), preview: contributionService?.preview(),
    controlPolicy: '只读；开启须由用户在设置中阅读条例并等待 3 秒确认，AI 无法代为同意。' }))
  featurePluginService = new FeaturePluginService(path.join(app.getPath('userData'), 'feature-plugins'), {
    requireFrom: path.join(app.getAppPath(), 'package.json'),
    projectRoot: () => (aiProjectContext.getStore() ?? currentProject)?.path ?? null,
    project: () => aiProjectContext.getStore() ?? currentProject,
    capabilities: { downloadActivities, runtime: featureHostRuntime, diagnosticsV1: true, testingV1: true, testingV2: true, studioV1: true, modpackExportV2: true, snapshotBatchDeleteV1: true },
    busy: () => activeAiRuns.size > 0 || Boolean(buildRuntime?.isBusy() || optionalTestingService()?.isBusy()),
    changed: () => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('feature-plugins:changed'); featureStoreService?.publish() },
    event: (id, event, value, windowId) => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && (window === mainWindow || isDetachedWindow(window)) && (windowId === undefined || window.id === windowId)) window.webContents.send('feature-plugins:event', id, event, value)
    },
    options: () => ({
      host: nativeFeatureHost(),
      userDataDir: app.getPath('userData'),
      projectRoot: () => (aiProjectContext.getStore() ?? currentProject)?.path ?? null,
      getHostedLease: createHostedImageLease,
      getHostedImageProvider: async () => {
        const { credentials, routingToken } = await hostedImageAuthorization()
        const service = await queryDeviceImageProvider(credentials.siteUrl, routingToken, AbortSignal.timeout(12_000), undefined, [credentials.apiKey])
        if (!sameDeviceCredentials(await readDeviceCredentials(), credentials)) throw new Error('账号已切换，请刷新生图配置')
        return service
      },
      getSyncedImageApi: async () => {
        const credentials = await readDeviceCredentials()
        return { customMode: credentials?.provider === 'custom', imageApi: credentials?.provider === 'custom' ? credentials.localImageApi ?? null : null }
      }
    })
  })
  await featurePluginService.initialize(await builtinStudioDirectories(
    app.isPackaged ? path.join(process.resourcesPath, 'bundled-studios') : path.join(app.getAppPath(), 'resources', 'bundled-studios')
  ).then(entries => entries.filter(entry => entry.id !== developerHostConfig?.pluginId)))
  if (featureDevelopment) {
    featureDevelopmentLoader = new FeatureDevelopmentLoader(featureDevelopment.root, featurePluginService)
    await featureDevelopmentLoader.start()
    app.once('quit', () => featureDevelopmentLoader?.stop())
  }
  configureStudios(new StudioRegistry(() => featurePluginService.catalog(), id => featurePluginService.service(id), (id, group) => featurePluginService.assetDirectory(id, group), (id, action, input, context) => featurePluginService.invoke(id, action, input, context)))
  if (developerHostConfig) {
    configureNativeFeatureServices(id => featurePluginService.service<Record<string, unknown>>(id))
    mainWindow = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true } })
    configureDeveloperHost(developerHostConfig.kit, featurePluginService, nativeFeatureHost())
    return
  }
  featureStoreService = new FeatureStoreService(path.join(app.getPath('userData'), 'feature-store'), featurePluginService, snapshot => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('feature-plugins:storeChanged', snapshot)
  })
  await featureStoreService.initialize()
  void featureStoreService.refresh()
  configureNativeFeatureServices(id => featurePluginService.service<Record<string, unknown>>(id))
  protocol.handle('modmind-feature', request => featurePluginService.serve(request))
  await pruneSavedBackgroundMedia(app.getPath('userData')).catch(error => console.warn('背景素材清理失败', error))
  protocol.handle('modmind-media', request => serveBackgroundMedia(request, path.join(app.getPath('userData'), 'appearance-media')))
  let expectedSampleAt = Date.now() + 30_000
  const metricsTimer = setInterval(() => {
    const now = Date.now()
    try {
      diagnosticJournal.record({ subsystem: 'process', operation: 'metrics', message: 'Process resource sample', data: {
        eventLoopDelayMs: Math.max(0, now - expectedSampleAt), memory: process.memoryUsage(),
        freeSystemMemory: os.freemem(), processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu, memory: metric.memory }))
      } })
    } catch (error) {
      diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'metrics', message: 'Process metrics unavailable', error })
    }
    expectedSampleAt = now + 30_000
  }, 30_000)
  metricsTimer.unref()
  app.once('quit', () => clearInterval(metricsTimer))
  if (process.platform === 'darwin') process.env.PATH = desktopProcessEnvironment().PATH
  installConsoleDiagnosticCapture()
  diagnosticJournal.recordCritical({
    subsystem: 'app',
    operation: 'startup',
    phase: 'ready',
    message: `ModMind ${app.getVersion()} is starting`,
    data: { platform: process.platform, arch: process.arch, packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node }
  })
  const providerSecrets = await diagnosticIpcOperations.run('startup', 'release-credentials', {}, () => readReleaseSecrets())
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
  if (!app.getVersion().endsWith('-plugintest')) {
    if (await appUpdateService.installPendingUpdateOnStartup()) return
    await migrateLegacyUserData()
  }
  appChangelogService = new AppChangelogService({
    currentVersion: app.getVersion(),
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    installMarkerPath: process.platform === 'win32' ? path.join(process.resourcesPath, 'modmind-install-versions.txt') : undefined
  })
  await appChangelogService.initialize()
  if (process.platform === 'win32') app.setAppUserModelId(applicationUserModelId())
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
  await diagnosticIpcOperations.run('startup', 'terminal-session-cleanup', {}, () => cleanupTerminalScripts(path.join(app.getPath('userData'), 'terminal-sessions')))
  installApplicationMenu(() => { showMainWindow(); mainWindow?.webContents.send('app:openSettings') }, is.dev)
  // 用户插件系统初始化（零插件时无副作用）
  initializePlugins({
    userDataDirectory: app.getPath('userData'),
    projectRoot: () => currentProject?.path ?? null,
    projectInfo: () => currentProject ? { name: currentProject.name, path: currentProject.path, kind: currentProject.kind ?? 'mod' } : null,
    hostContextOp: async (plugin, op, args) => {
      const pluginId = plugin.manifest.id
      switch (op) {
        case 'minecraftSyncModpack': {
          const project = requireProject()
          if (project.kind !== 'modpack') throw new Error('实例同步仅适用于当前整合包项目')
          return withMinecraftResourceLock(() => {
            if (!currentProject || !sameProjectPath(project.path, currentProject.path)) throw new Error('项目已切换，请在当前整合包重新同步')
            return requireMinecraftRuntime().syncModpack()
          })
        }
        case 'minecraftSyncKubeJsServerScripts': return syncCurrentKubeJsServerScripts()
        case 'overlayGetState': return pluginOverlayWindowState(pluginId)
        case 'overlayClose': return setPluginOverlayVisibility(pluginId, false)
        case 'overlayShow':
        case 'overlayDock': return setPluginOverlayVisibility(pluginId, true)
        case 'overlayPopOut':
          createPluginOverlayWindow(pluginId)
          return pluginOverlayWindowState(pluginId)
        case 'overlaySetAlwaysOnTop': {
          if (typeof args.alwaysOnTop !== 'boolean') throw new Error('alwaysOnTop 必须是布尔值')
          const window = pluginOverlayWindows.get(pluginId)
          if (!window || window.isDestroyed()) throw new Error('悬浮窗口未打开')
          window.setAlwaysOnTop(args.alwaysOnTop, 'floating')
          broadcastPluginOverlayWindows()
          return pluginOverlayWindowState(pluginId)
        }
        default: {
          const result = await pluginChatBridge.handle(plugin, op, args)
          pluginChatBridge.syncRecords(getPluginService()?.getSnapshot().plugins ?? [])
          return result
        }
      }
    },
    onSnapshotChanged: (snapshot) => {
      pluginChatBridge.syncRecords(snapshot.plugins)
      getPluginRuntime()?.syncRecords(new Map(snapshot.plugins.map((record) => [record.manifest.id, record])))
      reconcilePluginOverlayWindows(snapshot)
      broadcastPluginSnapshot(snapshot)
    },
    onDiagnosticsChanged: broadcastPluginDiagnostics
  })
  const initialPluginRegistry = diagnosticIpcOperations.run('startup', 'plugin-registry', {}, () => refreshPluginRegistry())
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
  pendingDeviceDeepLinks.setReady()
  if (process.argv.includes('--macos-smoke-check') && process.env.MODMIND_SMOKE_ROOT && mainWindow) {
    void import('./packagedNativeSmoke').then(({ runPackagedNativeSmoke }) => runPackagedNativeSmoke(mainWindow!, process.env.MODMIND_SMOKE_ROOT!))
      .then(() => shutdownApplication())
      .catch((error) => { console.error('[macos-smoke]', error); app.exit(1) })
  }
  if ((process.env.MODMIND_E2E ?? process.env.MODTOOL_E2E) === '1') void runAutomatedE2E()
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  diagnosticJournal.record({ subsystem: 'app', operation: 'windows', phase: 'closed', message: 'All application windows closed' })
  if (process.platform !== 'darwin') app.quit()
})

const nativeFeatureEvent = new AsyncLocalStorage<import('electron').IpcMainInvokeEvent>()
export function nativeFeatureHost() { return {
get publicMcpOutputDirectory() { return publicMcpOutputDirectory },
get aiProjectContext() { return aiProjectContext },
get forwardMinecraftRuntimeEvent() { return forwardMinecraftRuntimeEvent },
get ensureProjectBuildTrusted() { return ensureProjectBuildTrusted },
get requireAddonRelationshipService() { return requireAddonRelationshipService },
get buildProjectWithLock() { return buildProjectWithLock },
get cancelTrackedMinecraftPreparation() { return cancelTrackedMinecraftPreparation },
get restartTrackedMinecraftPreparation() { return restartTrackedMinecraftPreparation },
get minecraftDownloadActivityIds() { return minecraftDownloadActivityIds },
get forwardMinecraftEventsToServerPanel() { return forwardMinecraftEventsToServerPanel }, set forwardMinecraftEventsToServerPanel(value: boolean) { forwardMinecraftEventsToServerPanel = value },
get modpackMigrationDirectory() { return modpackMigrationDirectory },
get readSnapshotManifest() { return readSnapshotManifest },
get copySnapshotFiles() { return copySnapshotFiles },
get listSnapshotManagedFiles() { return listSnapshotManagedFiles },
get copyBundledGradleWrapper() { return copyBundledGradleWrapper },
get restoreSnapshotFilesExact() { return restoreSnapshotFilesExact },
get restoreSnapshotTree() { return restoreSnapshotTree },
get readModpackMigrationRecord() { return readModpackMigrationRecord },

get resolveAddonImportPaths() { return resolveAddonImportPaths },
get linkAddonProject() { return linkAddonProject },
get previewModpackMigrationForAgent() { return previewModpackMigrationForAgent },
get applyModpackMigrationForAgent() { return applyModpackMigrationForAgent },
get analyzeExistingProject() { return analyzeExistingProject },
get inspectBuiltinStudio() { return inspectBuiltinStudio },
get adoptBuiltinStudio() { return adoptBuiltinStudio },
get applyModpackMigrationInPlace() { return applyModpackMigrationInPlace },
get assertProjectMutationAllowed() { return assertProjectMutationAllowed },
get assertProjectSwitchAllowed() { return assertProjectSwitchAllowed },
get buildLinkedProjectTree() { return buildLinkedProjectTree },
get createProjectSnapshot() { return createProjectSnapshot },
get currentProject() { return currentProject }, set currentProject(value: typeof currentProject) { currentProject = value },
get currentProjectManifest() { return currentProjectManifest },
get curseForgeProviderKey() { return curseForgeProviderKey }, set curseForgeProviderKey(value: typeof curseForgeProviderKey) { curseForgeProviderKey = value },
get deleteProjectSnapshot() { return deleteProjectSnapshot },
get deleteProjectSnapshots() { return deleteProjectSnapshots },
get snapshotListPage() { return snapshotListPage },
get describeRuntimeError() { return describeRuntimeError },
get emitProjectChanged() { return emitProjectChanged },
get featurePluginService() { return featurePluginService },
get getAiReviewerConfig() { return getAiReviewerConfig },
get invokeMinecraftOperation() { return invokeMinecraftOperation },
get listModpackMigrationRecords() { return listModpackMigrationRecords },
get localServerManager() { return optionalTestingService()?.localServerManager },
get mainWindow() { const sender = nativeFeatureEvent.getStore()?.sender; return BrowserWindow.getAllWindows().find(window => window.webContents === sender) ?? mainWindow },
get mcmodService() { return mcmodService },
get modProviderRegistry() { return modProviderRegistry }, set modProviderRegistry(value: typeof modProviderRegistry) { modProviderRegistry = value },
get modpackAdoptionProgressDetail() { return modpackAdoptionProgressDetail },
get parseReleaseSummary() { return parseReleaseSummary },
get pathExists() { return pathExists },
get projectDataDirectory() { return projectDataDirectory },
get readProjectInfo() { return readProjectInfo },
get readReleaseSecrets() { return readReleaseSecrets },
get readSettings() { return readSettings },
get readSnapshotStorage() { return readSnapshotStorage },
get listSnapshotSummaries() { return listSnapshotSummaries },
get scheduleSnapshotStorageMaintenance() { return scheduleSnapshotStorageMaintenance },
get rememberRecentProject() { return rememberRecentProject },
get requireLoaderCatalog() { return requireLoaderCatalog },
get requireMinecraftRuntime() { return requireMinecraftRuntime },
get requireModProviderRegistry() { return requireModProviderRegistry },
get requireProject() { return requireProject },
get restoreProjectSnapshot() { return restoreProjectSnapshot },
get runDiagnosticOperation() { return runDiagnosticOperation },
get runsForProject() { return runsForProject },
get sendDecompileEvent() { return sendDecompileEvent },
get slugify() { return slugify },
get undoModpackMigration() { return undoModpackMigration },
get validateMigrationId() { return validateMigrationId },
get withMinecraftResourceLock() { return withMinecraftResourceLock },
get writeProjectTemplate() { return writeProjectTemplate },
get writeReleaseSecrets() { return writeReleaseSecrets },
event: (): import('electron').IpcMainInvokeEvent => { const event = nativeFeatureEvent.getStore(); if (event) return event; if (mainWindow && !mainWindow.isDestroyed()) return { sender: mainWindow.webContents } as import('electron').IpcMainInvokeEvent; throw new Error('Native plugin action requires a window invocation') }
} }
export type NativeFeatureHost = ReturnType<typeof nativeFeatureHost>

function syncCurrentKubeJsServerScripts(): ReturnType<MinecraftRuntimeManager['syncKubeJsServerScripts']> { return requireTestingService().syncCurrentKubeJsServerScripts() }

function requireHeadlessMc(): HeadlessMcService { return requireTestingService().requireHeadlessMc() }

async function runHeadlessMinecraftSmoke(
  project: ProjectInfo,
  signal?: AbortSignal,
  options: { artifact?: MinecraftManagedMod; stableWindowMs?: number; offline?: boolean } = {}
): Promise<HeadlessSmokeTestResult> { return requireTestingService().runHeadlessMinecraftSmoke(project, signal, options) }

async function runManagedRenderedTest(project: ProjectInfo, signal?: AbortSignal): Promise<any> { return requireTestingService().runManagedRenderedTest(project, signal) }

async function runProjectTestMatrix(
  targets: TestTarget[],
  signal?: AbortSignal,
  onProgress?: (target: TestTarget, completed: number, total: number) => void
): Promise<TestMatrixResult> { return requireTestingService().runProjectTestMatrix(targets, signal, onProgress) }

async function localServerAgentOperation(project: ProjectInfo, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> { return requireTestingService().localServerAgentOperation(project, input, signal) }

async function managedServerJoin(options: Parameters<typeof buildAndJoinServer>[0]): Promise<ServerJoinVerificationResult> { return requireTestingService().managedServerJoin(options) }

async function managedServerScenario(options: Parameters<typeof runServerScenario>[0]): Promise<Awaited<ReturnType<typeof runServerScenario>>> { return requireTestingService().managedServerScenario(options) }
