import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { downloadModpackContent, importModpackContent, listModpackContent, modpackContentProjectPath, removeModpackContent } from "./src/main/modpackContentInventoryService"
import { applyKeybindPreset, readKeybindState, writeFtbQuestChapter, writePatchouliBook } from "./src/main/modpackContentService"
import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import { sameProjectPath } from "../../src/main/projectPath"
import { modpackConfigIdentities } from "../../src/main/modpackConfigIdentities"
import path from "node:path"
import { promises as fs, readFileSync, createReadStream } from "node:fs"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "modpack-content" }, () => handler(host.event(), ...(input.args as any[]))) }
diagnosticHandle('modpack:get', () => readModpackManifest(host.requireProject()));
diagnosticHandle('modpack:removeMod', (_event, fileName: string) => removeModpackFile(host.requireProject(), fileName));
diagnosticHandle('modpack:sync', () => host.requireMinecraftRuntime().syncModpack());
diagnosticHandle('modpack:listContent', (_event, refresh?: unknown) => listModpackContent(host.requireProject(), refresh === true));
diagnosticHandle('modpack:importContent', async (_event, kind: ModpackContentKind, scope?: ModpackContentScope) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    const world = kind === 'worlds';
    const result = await dialog.showOpenDialog(host.mainWindow!, {
        title: world ? '选择世界存档目录' : '导入整合包内容',
        properties: world ? ['openDirectory'] : ['openFile', 'multiSelections']
    });
    if (result.canceled)
        return null;
    return importModpackContent(project, kind, result.filePaths, scope);
});
diagnosticHandle('modpack:downloadContent', (_event, input: ModpackContentDownloadInput) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    return downloadModpackContent(project, input);
});
diagnosticHandle('modpack:removeContent', (_event, id: string) => removeModpackContent(host.requireProject(), id));
diagnosticHandle('modpack:configModIdentities', (_event, projectPath: string) => {
    const project = host.requireProject();
    if (project.kind !== 'modpack' || typeof projectPath !== 'string' || !sameProjectPath(project.path, projectPath))
        throw new Error('整合包项目已切换，请重新打开页面');
    return modpackConfigIdentities(project);
});
diagnosticHandle('modpack:contentProjectPath', (_event, contentPath: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    if (typeof contentPath !== 'string')
        throw new Error('content path must be a string');
    return modpackContentProjectPath(project, contentPath);
});
diagnosticHandle('modpack:getKeybinds', () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    return readKeybindState(project);
});
diagnosticHandle('modpack:applyKeybindPreset', (_event, input: unknown, allowConflicts?: boolean) => applyKeybindPreset(host.requireProject(), input as Parameters<typeof applyKeybindPreset>[1], Boolean(allowConflicts)));


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackDownloadContent" | "modpackApplyKeybindPreset"> => {
return { modpackDownloadContent: (input) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    return downloadModpackContent(project, input as unknown as ModpackContentDownloadInput, signal);
},
modpackApplyKeybindPreset: async (input, allowConflicts) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    return applyKeybindPreset(project, input as unknown as Parameters<typeof applyKeybindPreset>[1], allowConflicts);
} }
}
actions["modpack_download_content"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackDownloadContent!(input)
actions["modpack_apply_keybinds"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackApplyKeybindPreset!((input.preset && typeof input.preset === 'object' ? input.preset : input) as Record<string, unknown>, input.allowConflicts === true)
return { actions, createMcpHandlers, downloadModpackContent, importModpackContent, listModpackContent, modpackContentProjectPath, removeModpackContent, applyKeybindPreset, readKeybindState, writeFtbQuestChapter, writePatchouliBook,  }
}
