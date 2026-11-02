import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { MappingService } from "./src/main/mappingService"
import path from "node:path"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
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
  ExistingProjectInspectionProgress,
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
  SnapshotStorageInfo,
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
} from "../../src/shared/types"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "mappings" }, () => handler(host.event(), ...(input.args as any[]))) }
let mappingService: MappingService | null = null;
function requireMappings(): MappingService {
    if (!mappingService)
        mappingService = new MappingService(path.join(app.getPath('userData'), 'mappings'), app.getVersion());
    return mappingService;
}
diagnosticHandle('mappings:search', (_event, version: string, query: string, limit?: number) => requireMappings().search(version, query, limit));
diagnosticHandle('mappings:getClass', (_event, version: string, className: string, memberQuery?: string) => requireMappings().getClass(version, className, memberQuery));
diagnosticHandle('mappings:openSource', (_event, version: string) => {
    if (!/^[0-9A-Za-z._-]{1,40}$/.test(version))
        throw new Error('无效的 Minecraft Mappings 版本');
    return shell.openExternal(`https://mappings.dev/${version}/index.html`);
});
diagnosticHandle('mappings:openLoaderDocs', (_event, loader: LoaderKind) => {
    const urls: Record<LoaderKind, string> = {
        paper: 'https://docs.papermc.io/paper/dev/',
        spigot: 'https://hub.spigotmc.org/javadocs/spigot/',
        folia: 'https://docs.papermc.io/folia/',
        velocity: 'https://docs.papermc.io/velocity/dev/',
        fabric: 'https://docs.fabricmc.net/develop/',
        quilt: 'https://wiki.quiltmc.org/en/modding/getting-started',
        forge: 'https://docs.minecraftforge.net/en/latest/',
        neoforge: 'https://docs.neoforged.net/docs/gettingstarted/',
        bedrock: 'https://learn.microsoft.com/minecraft/creator/',
        'netease-pc': 'https://mc.163.com/dev/',
        'netease-mobile': 'https://mc.163.com/dev/'
    };
    if (!urls[loader])
        throw new Error('无效的 Loader 文档类型');
    return shell.openExternal(urls[loader]);
});


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "mappingsSearch" | "mappingsClass"> => {
return { mappingsSearch: (query, limit) => requireMappings().search(project.minecraftVersion, query, Math.min(Math.max(limit ?? 20, 1), 50)),
mappingsClass: (className, memberQuery) => requireMappings().getClass(project.minecraftVersion, className, memberQuery) }
}
actions["mappings_search"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).mappingsSearch!(String(input.query ?? ''), Number(input.limit ?? 20))
actions["mappings_class"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).mappingsClass!(String(input.className ?? ''), typeof input.memberQuery === 'string' ? input.memberQuery : undefined)
return { actions, createMcpHandlers, requireMappings, MappingService,  }
}
