import { promises as fs, readFileSync, createReadStream } from "node:fs"
import { DependencyService } from "./src/main/dependencyService"
import { AddonRelationshipService, readAddonRelationships } from "./src/main/addonRelationshipService"
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
import path from "node:path"
import type { AddonImportSelection, AddonPlatformInstallInput, AddonPrepareInput, AddonRelationshipRole, AudioImportInput, ContentCreateInput, GiteeBuildSettings, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, ReleaseSummaryDraft, TestMatrixResult, TestTarget } from "../../src/shared/production"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
async function buildLinkedProjectTree(project: ProjectInfo, signal: AbortSignal | undefined, stack: string[]): Promise<string> {
    const normalized = path.resolve(project.path);
    if (stack.map((entry) => path.resolve(entry)).includes(normalized))
        throw new Error(`检测到 ModMind 项目循环依赖：${[...stack, normalized].join(' -> ')}`);
    const service = createAddonRelationshipService(() => project, false);
    await service.refreshLinkedProjects((linked) => buildLinkedProjectTree(linked, signal, [...stack, normalized]), [...stack, normalized]);
    return host.requireMinecraftRuntime().buildDependencyProject(project, signal);
}
async function resolveAddonImportPaths(project: ProjectInfo, values: string[]): Promise<string[]> {
    if (!values.length || values.length > 100)
        throw new Error('add-on import requires between 1 and 100 project-relative JAR paths');
    const root = path.resolve(project.path);
    const resolved: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string' || path.isAbsolute(value))
            throw new Error('add-on import paths must be project-relative');
        const target = path.resolve(project.path, ...value.replaceAll('\\', '/').split('/'));
        if (!target.startsWith(`${root}${path.sep}`) || path.extname(target).toLowerCase() !== '.jar')
            throw new Error(`invalid add-on JAR path: ${value}`);
        const stat = await fs.stat(target).catch(() => null);
        if (!stat?.isFile())
            throw new Error(`add-on JAR does not exist: ${value}`);
        resolved.push(target);
    }
    return resolved;
}
async function linkAddonProject(project: ProjectInfo, projectPath: string, signal?: AbortSignal): Promise<unknown> {
    const targetPath = path.resolve(projectPath.trim());
    const target = await host.readProjectInfo(targetPath);
    if (!target)
        throw new Error('linked path is not a ModMind project');
    const service = createAddonRelationshipService(() => project);
    return host.withMinecraftResourceLock(async () => {
        const artifact = await buildLinkedProjectTree(target, signal, [project.path]);
        return service.linkProject(target, artifact);
    });
}
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
let dependencyService: DependencyService | null = null;
let addonRelationshipService: AddonRelationshipService | null = null;
function requireDependencyService(): DependencyService {
    if (!dependencyService) {
        dependencyService = new DependencyService(host.requireProject, (filePath) => host.requireMinecraftRuntime().importMods([filePath]), (fileName) => host.requireMinecraftRuntime().removeMod(fileName), app.getVersion());
    }
    return dependencyService;
}
function createAddonRelationshipService(getProject: () => ProjectInfo, runtimeIntegration = true): AddonRelationshipService {
    return new AddonRelationshipService({
        getProject,
        registry: host.requireModProviderRegistry,
        cacheRoot: path.join(app.getPath('userData'), 'addon-references'),
        importRuntime: runtimeIntegration ? (filePath) => host.requireMinecraftRuntime().importMods([filePath]) : async () => undefined,
        removeRuntime: runtimeIntegration ? (fileName) => host.requireMinecraftRuntime().removeMod(fileName) : async () => undefined,
        readProject: (projectPath) => host.readProjectInfo(projectPath),
        mcmod: host.mcmodService
    });
}
function requireAddonRelationshipService(): AddonRelationshipService {
    if (!addonRelationshipService)
        addonRelationshipService = createAddonRelationshipService(host.requireProject);
    return addonRelationshipService;
}
function normalizeAddonPrepareInput(input: Record<string, unknown> | AddonPrepareInput): AddonPrepareInput {
    const names = (value: unknown): string[] => Array.isArray(value)
        ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))].slice(0, 100)
        : [];
    const providers = Array.isArray(input.providers)
        ? input.providers.filter((entry): entry is 'modrinth' | 'curseforge' => entry === 'modrinth' || entry === 'curseforge')
        : undefined;
    const required = names(input.required);
    const optional = names(input.optional);
    if (!required.length && !optional.length)
        throw new Error('at least one required or optional add-on target is required');
    return { required, optional, ...(providers?.length ? { providers } : {}) };
}
diagnosticHandle('relationships:list', () => requireAddonRelationshipService().list());
diagnosticHandle('relationships:providers', () => requireAddonRelationshipService().providers());
diagnosticHandle('relationships:recommendations', () => requireAddonRelationshipService().recommendations());
diagnosticHandle('relationships:search', (_event, query: unknown, providers?: unknown) => {
    const selected = Array.isArray(providers) ? providers.filter((entry): entry is 'modrinth' | 'curseforge' | 'mcmod' => entry === 'modrinth' || entry === 'curseforge' || entry === 'mcmod') : undefined;
    return requireAddonRelationshipService().search(typeof query === 'string' ? query : '', selected);
});
diagnosticHandle('relationships:versions', (_event, provider: unknown, projectId: unknown) => {
    if (provider === 'mcmod' && typeof projectId === 'string')
        return requireAddonRelationshipService().versions(provider, projectId);
    if ((provider !== 'modrinth' && provider !== 'curseforge') || typeof projectId !== 'string')
        throw new Error('模组平台或项目 ID 无效');
    return requireAddonRelationshipService().versions(provider, projectId);
});
diagnosticHandle('relationships:installPlatform', (_event, input: AddonPlatformInstallInput) => {
    if (!input || (input.provider !== 'modrinth' && input.provider !== 'curseforge') || typeof input.projectId !== 'string' || !['required', 'optional', 'test'].includes(String(input.role)))
        throw new Error('平台目标参数无效');
    return requireAddonRelationshipService().installPlatform(input);
});
diagnosticHandle('relationships:beginMcmodDownload', (_event, projectId: unknown, fileKey: unknown) => {
    if (typeof projectId !== 'string' || typeof fileKey !== 'string')
        throw new Error('MC百科文件参数无效');
    return requireAddonRelationshipService().beginMcmodDownload(projectId, fileKey);
});
diagnosticHandle('relationships:refreshMcmodCaptcha', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string')
        throw new Error('MC百科验证码会话无效');
    return requireAddonRelationshipService().refreshMcmodCaptcha(sessionId);
});
diagnosticHandle('relationships:submitMcmodCaptcha', (_event, sessionId: unknown, captcha: unknown, role: unknown) => {
    if (typeof sessionId !== 'string' || typeof captcha !== 'string' || !['required', 'optional', 'test'].includes(String(role)))
        throw new Error('MC百科验证码参数无效');
    return requireAddonRelationshipService().submitMcmodCaptcha(sessionId, captcha, role as AddonRelationshipRole);
});
diagnosticHandle('relationships:prepare', (_event, input: AddonPrepareInput) => requireAddonRelationshipService().prepare(normalizeAddonPrepareInput(input && typeof input === 'object' ? input : {})));
diagnosticHandle('relationships:beginImport', async () => {
    const result = await dialog.showOpenDialog(host.mainWindow!, {
        title: '导入目标模组 JAR',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    });
    if (result.canceled || !result.filePaths.length)
        return null;
    return requireAddonRelationshipService().beginImport(result.filePaths);
});
diagnosticHandle('relationships:confirmImport', (_event, batchId: unknown, selections: unknown) => {
    if (typeof batchId !== 'string' || !Array.isArray(selections))
        throw new Error('批量导入确认无效');
    return requireAddonRelationshipService().confirmImport(batchId, selections as AddonImportSelection[]);
});
diagnosticHandle('relationships:cancelImport', (_event, batchId: unknown) => {
    if (typeof batchId === 'string')
        requireAddonRelationshipService().cancelImport(batchId);
});
diagnosticHandle('relationships:linkProject', async () => {
    const selected = await dialog.showOpenDialog(host.mainWindow!, { title: '选择另一个 ModMind 模组项目', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0])
        return null;
    const target = await host.readProjectInfo(selected.filePaths[0]);
    if (!target)
        throw new Error('所选目录不是 ModMind 项目');
    return host.invokeMinecraftOperation(() => host.withMinecraftResourceLock(async () => {
        const artifact = await buildLinkedProjectTree(target, undefined, [host.requireProject().path]);
        return requireAddonRelationshipService().linkProject(target, artifact);
    }));
});
diagnosticHandle('relationships:importSource', async (_event, relationshipId: unknown, sourceType: unknown) => {
    if (typeof relationshipId !== 'string' || (sourceType !== 'archive' && sourceType !== 'folder'))
        throw new Error('源码导入参数无效');
    const selected = await dialog.showOpenDialog(host.mainWindow!, sourceType === 'folder'
        ? { title: '选择目标模组源码目录', properties: ['openDirectory'] }
        : { title: '选择目标模组源码归档', properties: ['openFile'], filters: [{ name: 'Source Archive', extensions: ['jar', 'zip'] }] });
    if (selected.canceled || !selected.filePaths[0])
        return null;
    return requireAddonRelationshipService().importSource(relationshipId, selected.filePaths[0]);
});
diagnosticHandle('relationships:setRole', (_event, relationshipId: unknown, role: unknown) => {
    if (typeof relationshipId !== 'string' || !['required', 'optional', 'test'].includes(String(role)))
        throw new Error('联动关系参数无效');
    return requireAddonRelationshipService().setRole(relationshipId, role as AddonRelationshipRole);
});
diagnosticHandle('relationships:remove', (_event, relationshipId: unknown) => {
    if (typeof relationshipId !== 'string')
        throw new Error('联动关系 ID 无效');
    return requireAddonRelationshipService().remove(relationshipId);
});
diagnosticHandle('relationships:audit', () => requireAddonRelationshipService().audit());
diagnosticHandle('dependencies:search', (_event, query: string, offset?: number) => requireDependencyService().search(query, offset));
diagnosticHandle('dependencies:versions', (_event, projectId: string) => requireDependencyService().versions(projectId));
diagnosticHandle('dependencies:list', () => requireDependencyService().list());
diagnosticHandle('dependencies:install', (_event, input) => requireDependencyService().install(input));
diagnosticHandle('dependencies:installMaven', (_event, input) => requireDependencyService().installMaven(input));
diagnosticHandle('dependencies:audit', () => requireDependencyService().audit());
diagnosticHandle('dependencies:remove', (_event, projectId: string) => requireDependencyService().remove(projectId));


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "dependencySearch" | "dependencyInstall" | "mavenDependencyInstall" | "addonRelationships" | "addonPrepare" | "addonImport" | "addonLinkProject"> => {
const addonService = createAddonRelationshipService(() => project)
return { dependencySearch: (query, offset) => requireDependencyService().search(query, Math.min(Math.max(offset ?? 0, 0), 1000)),
dependencyInstall: (projectId, versionId) => requireDependencyService().install({ projectId, versionId }),
mavenDependencyInstall: (input) => requireDependencyService().installMaven(input as unknown as MavenDependencyInput),
addonRelationships: () => addonService.describeForAi(),
addonPrepare: (input) => addonService.prepare(normalizeAddonPrepareInput(input)),
addonImport: async (paths, role) => addonService.importExact(await resolveAddonImportPaths(project, paths), role === 'optional' || role === 'test' ? role : 'required'),
addonLinkProject: (projectPath) => linkAddonProject(project, projectPath, signal) }
}
actions["dependency_search"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).dependencySearch!(String(input.query ?? ''), Number(input.offset ?? 0))
actions["dependency_install"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).dependencyInstall!(String(input.projectId ?? ''), typeof input.versionId === 'string' ? input.versionId : undefined)
actions["maven_dependency_install"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).mavenDependencyInstall!(input)
actions["addon_relationships"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).addonRelationships!()
actions["addon_prepare"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).addonPrepare!(input)
actions["addon_import"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).addonImport!(Array.isArray(input.paths) ? input.paths.map(String) : [], typeof input.role === 'string' ? input.role : undefined)
actions["addon_link_project"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).addonLinkProject!(String(input.projectPath ?? ''))
return { actions, buildLinkedProjectTree, resolveAddonImportPaths, linkAddonProject, createMcpHandlers, requireDependencyService, createAddonRelationshipService, requireAddonRelationshipService, normalizeAddonPrepareInput, DependencyService, AddonRelationshipService, readAddonRelationships,  }
}
