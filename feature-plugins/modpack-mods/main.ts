import { applyModpackPlan, planModpack } from "./src/main/modpackPlanner"
import { curseForgePackResolver, installCurseForgePack, readCurseForgePackState } from "./src/main/curseForgePackService"
import { promises as fs, readFileSync, createReadStream } from "node:fs"
import path from "node:path"
import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, readModpackImportStatus, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import { refreshModpackMods } from '../../src/main/modpackService'
import { downloadActivities } from "../../src/main/downloadActivityService"
import { modpackModsRoot, modpackOverridesRoot } from "../../src/main/modpackPaths"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import { importModpackModule } from "../../src/main/modpackModuleImport"
import { normalizeProjectName, validateProjectNameInput } from "../../src/shared/projectName"
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
import { CURRENT_PROJECT_VERSION, MIGRATABLE_PROJECT_VERSION } from "../../src/main/projectVersion"
import { readModpackModuleProject } from "../../src/main/modpackService"
import { auditModpackLock, lockedModFromFile, readModpackLock, writeModpackLock } from "../../src/main/modpackLockService"
import { isAddonPlatform, isJavaLoader, isServerPluginPlatform, platformLabel, PROJECT_PLATFORMS } from "../../src/shared/projectPlatform"
import { createHash, randomUUID } from "node:crypto"
import { McmodService, readManualModRequirements, saveManualModRequirements } from "../../src/main/mcmodService"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const packImportControllers = new Map<string, AbortController>()
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }

actions['modpack:refreshMods'] = () => refreshModpackMods(host.requireProject())
diagnosticHandle('modpack:importStatus', () => readModpackImportStatus(host.requireProject()));
diagnosticHandle('modpack:cancelImport', () => { packImportControllers.get(host.requireProject().path)?.abort(); return undefined; });
diagnosticHandle('modpack:resumeImport', async () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    if (packImportControllers.has(project.path))
        throw new Error('整合包依赖正在安装');
    const manifest = await readModpackManifest(project);
    const state = await readCurseForgePackState(project.path);
    if (!state || !manifest.source)
        throw new Error('缺少原始导入记录，请重新导入原整合包安装包');
    const controller = new AbortController();
    packImportControllers.set(project.path, controller);
    const activity = downloadActivities.start({ label: `补齐整合包 · ${project.name}`, detail: '正在核对原清单文件' });
    try {
        const result = await installCurseForgePack(project.path, modpackOverridesRoot(project, manifest), state.files, {
            resolve: curseForgePackResolver(host.curseForgeProviderKey, path.join(app.getPath('userData'), 'pack-metadata-cache')), cacheDirectory: path.join(app.getPath('userData'), 'pack-download-cache'), signal: controller.signal,
            trackDownloadActivities: false, onProgress: progress => downloadActivities.update(activity, { detail: host.modpackAdoptionProgressDetail(progress) })
        });
        const updated = await adoptExternalModpack(project, { ...manifest.source, unresolvedDependencies: result.unresolvedDependencyCount || undefined });
        await auditImportedPackArtifacts(project);
        if (result.unresolvedDependencyCount)
            downloadActivities.fail(activity, new Error(`${result.unresolvedDependencyCount} 个必需文件未完成：${result.warnings.slice(0, 3).join('；')}`));
        else
            downloadActivities.complete(activity, '所有必需文件已安装并校验');
        return updated;
    }
    catch (error) {
        await adoptExternalModpack(project, manifest.source);
        downloadActivities.fail(activity, error);
        throw error;
    }
    finally {
        packImportControllers.delete(project.path);
    }
});
diagnosticHandle('modpack:importMods', async () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    const result = await dialog.showOpenDialog(host.mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    });
    if (result.canceled || !result.filePaths.length)
        return readModpackManifest(project);
    return addModpackFiles(project, result.filePaths);
});
diagnosticHandle('modpack:importModule', async (_event, mode: 'copy' | 'link') => {
    const pack = host.requireProject();
    if (!isModpackProject(pack))
        throw new Error('当前项目不是整合包');
    if (mode !== 'copy' && mode !== 'link')
        throw new Error('请选择复制或直接使用原项目');
    const selected = await dialog.showOpenDialog(host.mainWindow!, { title: '导入已有模组项目', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths.length)
        return null;
    const root = selected.filePaths[0];
    let source = await host.readProjectInfo(root);
    if (!source) {
        const { analysis } = await host.analyzeExistingProject(root);
        if (analysis.kind !== 'complete')
            throw new Error('请选择完整的模组源码项目；已编译的 JAR 可通过“导入 Mod”添加');
        source = { ...analysis.inferred, path: root, createdAt: new Date().toISOString() };
    }
    return importModpackModule(pack, source, mode);
});
diagnosticHandle('modpack:createModule', async (_event, value: string) => {
    const pack = host.requireProject();
    if (!isModpackProject(pack))
        throw new Error('当前项目不是整合包');
    const name = validateProjectNameInput(value);
    const namespace = host.slugify(name);
    if ((await readModpackManifest(pack)).modules.some(module => module.namespace === namespace))
        throw new Error('同名自制 Mod 已存在');
    const relativePath = `modules/${namespace}`;
    const modulePath = path.join(pack.path, ...relativePath.split('/'));
    if (await host.pathExists(modulePath))
        throw new Error('同名自制 Mod 已存在');
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
    };
    await fs.mkdir(modulePath, { recursive: true });
    try {
        await host.writeProjectTemplate(module);
        await fs.mkdir(path.join(modulePath, '.modmind'), { recursive: true });
        return addModpackModule(pack, { name, namespace, path: relativePath, createdAt: module.createdAt });
    }
    catch (error) {
        await fs.rm(modulePath, { recursive: true, force: true });
        throw error;
    }
});
diagnosticHandle('modpack:updateModuleSide', async (_event, namespace: unknown, side: unknown) => {
    const pack = host.requireProject();
    if (!isModpackProject(pack))
        throw new Error('current project is not a modpack');
    if (typeof namespace !== 'string' || !['client', 'server', 'both', 'unknown'].includes(String(side)))
        throw new Error('invalid self-made mod side');
    return updateModpackModuleSide(pack, namespace, side as ModpackModuleSide);
});
diagnosticHandle('modpack:removeModule', (_event, namespace: string) => removeModpackModule(host.requireProject(), namespace, (target) => shell.trashItem(target)));
diagnosticHandle('modpack:openModule', async (_event, namespace: string) => {
    const pack = host.requireProject();
    const manifest = await readModpackManifest(pack);
    const module = manifest.modules.find((entry) => entry.namespace === namespace);
    if (!module)
        throw new Error('找不到自制 Mod');
    const project = await readModpackModuleProject(pack, module);
    if (!await host.pathExists(path.join(project.path, host.currentProjectManifest)))
        throw new Error('自制 Mod 工程文件已缺失');
    host.currentProject = project;
    await host.rememberRecentProject(project);
    return project;
});
diagnosticHandle('modpack:readLock', async () => readModpackLock(host.requireProject()));
diagnosticHandle('modpack:auditLock', async () => auditModpackLock(host.requireProject()));
diagnosticHandle('modpack:providers', () => host.requireModProviderRegistry().list().map((id) => ({ id, label: id === 'modrinth' ? 'Modrinth' : 'CurseForge', configured: true, supportsDependencies: true })));
diagnosticHandle('modpack:recommendProviders', async (): Promise<ModpackSearchResponse[]> => {
    const project = host.requireProject();
    if (!isModpackProject(project) || !isJavaLoader(project.loader))
        throw new Error('只有 Java 整合包支持第三方 Mod 平台搜索');
    const results = await host.requireModProviderRegistry().search({ query: '', minecraftVersion: project.minecraftVersion, loader: project.loader, limit: 12, index: 'downloads' });
    return results.map((result) => ({
        provider: result.provider,
        total: result.total,
        error: result.error,
        hits: result.hits.map((hit) => ({ provider: hit.provider, projectId: hit.projectId, slug: hit.slug, name: hit.name, summary: hit.summary, projectUrl: hit.projectUrl, downloads: hit.downloads, clientSide: hit.clientSide, serverSide: hit.serverSide, ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}), ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}) }))
    }));
});
diagnosticHandle('modpack:recommendMcmod', async () => {
    const project = host.requireProject();
    if (!isModpackProject(project) || !isJavaLoader(project.loader))
        throw new Error('只有 Java 整合包支持模组推荐');
    return host.mcmodService.recommendations(12);
});
diagnosticHandle('modpack:searchProviders', async (_event, rawQuery: unknown, rawProviders?: unknown): Promise<ModpackSearchResponse[]> => {
    const project = host.requireProject();
    if (!isModpackProject(project) || !isJavaLoader(project.loader))
        throw new Error('只有 Java 整合包支持第三方 Mod 平台搜索');
    const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 120) : '';
    if (!query)
        return [];
    const providers = Array.isArray(rawProviders)
        ? rawProviders.filter((value): value is 'modrinth' | 'curseforge' => value === 'modrinth' || value === 'curseforge')
        : undefined;
    const results = await host.requireModProviderRegistry().search({ query, minecraftVersion: project.minecraftVersion, loader: project.loader, limit: 30 }, providers);
    return results.map((result) => ({
        provider: result.provider,
        total: result.total,
        error: result.error,
        hits: result.hits.map((hit) => ({ provider: hit.provider, projectId: hit.projectId, slug: hit.slug, name: hit.name, summary: hit.summary, projectUrl: hit.projectUrl, downloads: hit.downloads, clientSide: hit.clientSide, serverSide: hit.serverSide, ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}), ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}) }))
    }));
});
diagnosticHandle('modpack:listProviderFiles', async (_event, rawProvider: unknown, rawProjectId: unknown): Promise<ModpackFileOption[]> => {
    const project = host.requireProject();
    if (!isModpackProject(project) || !isJavaLoader(project.loader))
        throw new Error('只有 Java 整合包支持第三方 Mod 平台下载');
    if (rawProvider !== 'modrinth' && rawProvider !== 'curseforge')
        throw new Error('不支持的 Mod 平台');
    if (typeof rawProjectId !== 'string' || !rawProjectId.trim())
        throw new Error('Mod 项目 ID 无效');
    const files = await host.requireModProviderRegistry().versions(rawProvider, rawProjectId, { minecraftVersion: project.minecraftVersion, loader: project.loader });
    return files.map((file) => ({ provider: file.provider, projectId: file.projectId, versionId: file.versionId, versionName: file.versionName, filename: file.filename, side: file.side, ...(file.size !== undefined ? { size: file.size } : {}), ...(file.publishedAt ? { publishedAt: file.publishedAt } : {}) }));
});
diagnosticHandle('modpack:installProviderFile', async (_event, rawProvider: unknown, rawProjectId: unknown, rawVersionId: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project) || !isJavaLoader(project.loader))
        throw new Error('只有 Java 整合包支持第三方 Mod 下载');
    if (rawProvider !== 'modrinth' && rawProvider !== 'curseforge')
        throw new Error('不支持的 Mod 平台');
    if (typeof rawProjectId !== 'string' || typeof rawVersionId !== 'string')
        throw new Error('Mod 版本信息无效');
    const files = await host.requireModProviderRegistry().versions(rawProvider, rawProjectId, { minecraftVersion: project.minecraftVersion, loader: project.loader });
    const file = files.find((candidate) => candidate.versionId === rawVersionId);
    if (!file)
        throw new Error('该 Mod 版本已不可用，请刷新后重试');
    const stagingRoot = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'provider-downloads', randomUUID());
    const staged = path.join(stagingRoot, file.filename);
    await fs.mkdir(stagingRoot, { recursive: true });
    try {
        const result = await host.requireModProviderRegistry().install(file, staged);
        const manifest = await addModpackFiles(project, [result.path]);
        const lock = await readModpackLock(project);
        const locked = lockedModFromFile(file, result, file.filename);
        await writeModpackLock(project, { ...lock, mods: [...lock.mods.filter((entry) => !(entry.provider === file.provider && entry.projectId === file.projectId) && entry.fileName.toLowerCase() !== file.filename.toLowerCase()), locked] });
        return manifest;
    }
    finally {
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
});
diagnosticHandle('modpack:plan', async (_event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    if (!input || typeof input !== 'object')
        throw new Error('modpack concept must be an object');
    const plan = await planModpack(host.requireModProviderRegistry(), project, input as Parameters<typeof planModpack>[2], host.mcmodService);
    await saveManualModRequirements(project, plan.manualRequired ?? []);
    return plan;
});
diagnosticHandle('modpack:applyPlan', async (_event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    if (!input || typeof input !== 'object')
        throw new Error('modpack plan must be an object');
    return applyModpackPlan(host.requireModProviderRegistry(), project, input as Parameters<typeof applyModpackPlan>[2]);
});
diagnosticHandle('modpack:listManualMods', () => readManualModRequirements(host.requireProject()));
diagnosticHandle('modpack:searchMcmod', (_event, query: string) => host.mcmodService.search(typeof query === 'string' ? query : '', 20));
diagnosticHandle('modpack:listMcmodFiles', (_event, projectId: string) => host.mcmodService.listFiles(typeof projectId === 'string' ? projectId : ''));
diagnosticHandle('modpack:beginMcmodDownload', (event, projectId: string, fileKey: string) => {
    if (!host.mainWindow || event.sender.id !== host.mainWindow.webContents.id)
        throw new Error('MC百科下载只能由当前客户端窗口发起');
    return host.mcmodService.beginDownload(host.requireProject(), projectId, fileKey);
});
diagnosticHandle('modpack:refreshMcmodCaptcha', (event, sessionId: string) => {
    if (!host.mainWindow || event.sender.id !== host.mainWindow.webContents.id)
        throw new Error('验证码只能由当前客户端窗口刷新');
    return host.mcmodService.refreshCaptcha(host.requireProject(), sessionId);
});
diagnosticHandle('modpack:submitMcmodCaptcha', (event, sessionId: string, captcha: string) => {
    if (!host.mainWindow || event.sender.id !== host.mainWindow.webContents.id)
        throw new Error('验证码只能由当前客户端窗口提交');
    return host.mcmodService.submitCaptcha(host.requireProject(), sessionId, captcha);
});


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackPlan" | "modpackApplyPlan" | "mcmodSearch" | "mcmodFiles"> => {
return { modpackPlan: async (concept) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const plan = await planModpack(host.requireModProviderRegistry(), project, concept as unknown as Parameters<typeof planModpack>[2], host.mcmodService, signal);
    await saveManualModRequirements(project, plan.manualRequired ?? []);
    return plan;
},
modpackApplyPlan: async (plan) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    return applyModpackPlan(host.requireModProviderRegistry(), project, plan as unknown as Parameters<typeof applyModpackPlan>[2], signal);
},
mcmodSearch: (query, limit) => host.mcmodService.search(query, Math.min(Math.max(limit ?? 10, 1), 20), signal),
mcmodFiles: async (projectId) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const files = await host.mcmodService.listFiles(projectId, signal);
    const loader = project.loader.toLowerCase();
    return files.filter((file) => file.minecraftVersion.split('/').includes(project.minecraftVersion)
        && (!file.loaders.length || file.loaders.some((value) => value.toLowerCase().includes(loader))));
} }
}
actions["modpack_plan"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackPlan!(input)
actions["modpack_apply_plan"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackApplyPlan!((input.plan && typeof input.plan === 'object' ? input.plan : input) as Record<string, unknown>)
actions["mcmod_search"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).mcmodSearch!(String(input.query ?? ''), Number(input.limit ?? 10))
actions["mcmod_files"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).mcmodFiles!(String(input.projectId ?? ''))
return { actions, createMcpHandlers, applyModpackPlan, planModpack, curseForgePackResolver, installCurseForgePack, readCurseForgePackState,  }
}
