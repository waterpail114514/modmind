import path from "node:path"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import type { DecompileProvenance } from "../../src/shared/decompile"
import { readDecompileCacheEntry } from "./src/main/decompileCache"
import { inspectForDecompilation, listCachedSourceFiles, readCachedSourceFile, runDecompilation, scanReferencesForJar, type DecompileRunRequest } from "./src/main/decompilePipeline"
import { DECOMPILE_MIN_JAVA } from "./src/main/jarDecompileService"
import { diagnosticJournal, installConsoleDiagnosticCapture, installProcessDiagnosticHandlers, redactDiagnosticText } from "../../src/main/diagnosticLog"
import { createModuleFromDecompiledSources, DECOMPILE_TERMS_TITLE, DECOMPILE_TERMS_VERSION, DECOMPILE_TERMS_SECTIONS, plannedModulePaths, renderDecompileTerms, seedProjectFromDecompiledSources } from "./src/main/decompileModuleExport"
import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import { isAddonPlatform, isJavaLoader, isServerPluginPlatform, platformLabel, PROJECT_PLATFORMS } from "../../src/shared/projectPlatform"
import { restoreDecompiledPluginProject, validateDecompiledProjectTarget } from "./src/main/decompiledPluginProject"
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
import { promises as fs, readFileSync, createReadStream } from "node:fs"
import { deleteExternalAgentSession, detectExternalAgent, detectExternalAgents, externalAgentDocsUrl, externalAgentLabel, externalAgentSupportsHostedConfiguration, launchExternalAgent, listLocalCodexModels, ModMindBridge, readExternalAgentHistory, refreshExternalAgentContext, runExternalAgent, type ExternalAgentAttemptAudit, type ExternalAgentBridgeHandlers, type ExternalAgentKind, type ExternalAgentRetryState, type ExternalAgentRunOptions } from "../../src/main/externalAgents"
import type { NativeFeatureHost } from '../../src/main/index'
import { inspectDecompileJar } from './src/main/decompileJarInspection'
import { resolveReadablePath } from '../../src/main/projectTextRead'
import { configureNativeFeatureResources } from '../sdk/nativeResources'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost; pluginDirectory?: string }) {
const host = options.host
configureNativeFeatureResources(options.pluginDirectory)
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
actions.query = async input => {
  if (input.operation === 'terms') return { title: DECOMPILE_TERMS_TITLE, version: DECOMPILE_TERMS_VERSION, sections: DECOMPILE_TERMS_SECTIONS }
  const source = await resolveReadablePath(host.requireProject(), input.sourcePath)
  const inspected = await inspectDecompileJar(source.realTarget)
  if (input.sourceSha256 !== undefined && input.sourceSha256 !== inspected.sha256) throw new Error('反编译来源哈希与当前项目 JAR 不一致，请重新检查原始 JAR')
  if (input.operation === 'files') return listCachedSourceFiles(decompileCacheRoot(), inspected.sha256)
  if (input.operation === 'read') return readCachedSourceFile(decompileCacheRoot(), inspected.sha256, String(input.path))
  if (input.operation === 'inspect') return inspectForDecompilation(source.realTarget, { cacheRoot: decompileCacheRoot() })
  if (input.operation === 'references') return scanReferencesForJar(source.realTarget, Array.isArray(input.knownPackages) ? input.knownPackages as Parameters<typeof scanReferencesForJar>[1] : [])
  throw new Error('不支持的反编译查询操作')
}
actions.run = async (input, context) => {
  const source = await resolveReadablePath(host.requireProject(), input.path)
  if (input.termsVersionAcknowledged !== DECOMPILE_TERMS_VERSION) throw new Error('请先让用户阅读并确认当前反编译条款')
  const javaPath = await host.requireMinecraftRuntime().ensureJavaRuntime(undefined, DECOMPILE_MIN_JAVA)
  return runDecompilation({ jarPath: source.realTarget, skipRemap: input.skipRemap === true, minecraftVersion: typeof input.minecraftVersion === 'string' ? input.minecraftVersion : host.requireProject().minecraftVersion }, { cacheRoot: decompileCacheRoot(), javaPath, signal: (context as { signal?: AbortSignal }).signal ?? new AbortController().signal })
}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
// Controlled JAR decompilation (受控反编译): results live in the userData cache, never in project sources.
const decompileCacheRoot = (): string => path.join(app.getPath('userData'), 'decompile');
const activeDecompileRuns = new Map<string, AbortController>();
async function readDecompileProvenanceForExport(decompileCacheRoot: string, sourceSha256: string): Promise<DecompileProvenance> {
    if (!/^[a-f0-9]{64}$/i.test(sourceSha256))
        throw new Error('缺少有效的反编译缓存标识');
    const entry = await readDecompileCacheEntry(decompileCacheRoot, sourceSha256);
    if (!entry?.provenance)
        throw new Error('该 JAR 尚无反编译缓存，请先完成反编译');
    return entry.provenance;
}
diagnosticHandle('decompile:pickJar', async () => {
    const selected = await dialog.showOpenDialog(host.mainWindow!, { title: '选择模组或服务端插件 JAR', properties: ['openFile'], filters: [{ name: 'Minecraft Mod / Server Plugin JAR', extensions: ['jar'] }] });
    if (selected.canceled || !selected.filePaths[0])
        return null;
    return selected.filePaths[0];
});
diagnosticHandle('decompile:inspect', (_event, jarPath: unknown) => host.runDiagnosticOperation('decompile', 'inspect', 'JAR decompile inspection', async () => {
    if (typeof jarPath !== 'string' || !jarPath.trim())
        throw new Error('缺少 JAR 路径');
    return inspectForDecompilation(jarPath.trim(), { cacheRoot: decompileCacheRoot() });
}, { jarPath }));
diagnosticHandle('decompile:start', (_event, input: unknown) => host.runDiagnosticOperation('decompile', 'start', 'Controlled JAR decompilation', async () => {
    if (!input || typeof input !== 'object')
        throw new Error('反编译请求无效');
    const value = input as Partial<DecompileRunRequest>;
    if (typeof value.jarPath !== 'string' || !value.jarPath.trim())
        throw new Error('缺少 JAR 路径');
    const request: DecompileRunRequest = {
        jarPath: value.jarPath.trim(),
        skipRemap: value.skipRemap === true,
        ...(typeof value.minecraftVersion === 'string' && value.minecraftVersion.trim() ? { minecraftVersion: value.minecraftVersion.trim() } : {})
    };
    const runKey = process.platform === 'win32' ? path.resolve(request.jarPath).toLowerCase() : path.resolve(request.jarPath);
    if (activeDecompileRuns.has(runKey)) throw new Error('这个 JAR 正在反编译，请等待当前任务完成');
    const controller = new AbortController();
    activeDecompileRuns.set(runKey, controller);
    try {
        const javaPath = await host.requireMinecraftRuntime().ensureJavaRuntimeForTools(DECOMPILE_MIN_JAVA, (message) => host.sendDecompileEvent(controller.signal, { jarSha256: '', phase: 'inspecting', message }), ({ source, downloaded, total }) => host.sendDecompileEvent(controller.signal, { jarSha256: '', phase: 'downloading-mappings', message: `正在从 ${source} 下载托管 Java`, ...(total > 0 ? { ratio: Math.min(0.05, 0.05 * downloaded / total) } : {}) }), controller.signal);
        return await runDecompilation(request, {
            cacheRoot: decompileCacheRoot(),
            javaPath,
            signal: controller.signal,
            onProgress: (event) => host.sendDecompileEvent(controller.signal, event),
            onOutput: (output) => diagnosticJournal.record({ subsystem: 'decompile', operation: 'engine-output', phase: 'output', level: 'debug', message: redactDiagnosticText(output.slice(-2000)) })
        });
    }
    finally {
        if (activeDecompileRuns.get(runKey) === controller) activeDecompileRuns.delete(runKey);
    }
}));
diagnosticHandle('decompile:cancel', (_event, jarPath: unknown) => {
    if (typeof jarPath !== 'string')
        throw new Error('缺少 JAR 路径');
    const runKey = process.platform === 'win32' ? path.resolve(jarPath).toLowerCase() : path.resolve(jarPath);
    const controller = activeDecompileRuns.get(runKey);
    controller?.abort();
    return Boolean(controller);
});
diagnosticHandle('decompile:listFiles', (_event, sourceSha256: unknown) => host.runDiagnosticOperation('decompile', 'listFiles', 'List decompiled sources', async () => {
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256))
        throw new Error('非法的缓存键');
    return listCachedSourceFiles(decompileCacheRoot(), sourceSha256);
}));
diagnosticHandle('decompile:readFile', (_event, sourceSha256: unknown, relativePath: unknown) => host.runDiagnosticOperation('decompile', 'readFile', 'Read decompiled source', async () => {
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256))
        throw new Error('非法的缓存键');
    if (typeof relativePath !== 'string')
        throw new Error('缺少文件路径');
    return readCachedSourceFile(decompileCacheRoot(), sourceSha256, relativePath);
}));
diagnosticHandle('decompile:scanReferences', (_event, jarPath: unknown, knownPackages: unknown) => host.runDiagnosticOperation('decompile', 'scanReferences', 'Class reference scan', async () => {
    if (typeof jarPath !== 'string' || !jarPath.trim())
        throw new Error('缺少 JAR 路径');
    const known = Array.isArray(knownPackages)
        ? knownPackages.filter((entry): entry is {
            modId: string;
            packages: string[];
        } => Boolean(entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).modId === 'string' && Array.isArray((entry as Record<string, unknown>).packages)))
        : [];
    return scanReferencesForJar(jarPath.trim(), known);
}));
diagnosticHandle('decompile:getTerms', (_event, sourceFileName: unknown) => {
    return { version: DECOMPILE_TERMS_VERSION, title: DECOMPILE_TERMS_TITLE, sections: DECOMPILE_TERMS_SECTIONS, rendered: renderDecompileTerms(typeof sourceFileName === 'string' ? sourceFileName : 'mod.jar') };
});
diagnosticHandle('decompile:createModuleFromJar', (_event, input: unknown) => host.runDiagnosticOperation('decompile', 'createModuleFromJar', 'Export decompiled sources as self-made module', async () => {
    const pack = host.requireProject();
    if (!isModpackProject(pack))
        throw new Error('只有整合包项目可以把反编译结果转为自制模组');
    host.assertProjectMutationAllowed(pack.path, '从反编译源码创建自制模组');
    if (!input || typeof input !== 'object')
        throw new Error('导出请求无效');
    const value = input as Record<string, unknown>;
    // The terms acknowledgement is mandatory and must reference the current terms version.
    const terms = value.termsAcknowledgement && typeof value.termsAcknowledgement === 'object' ? value.termsAcknowledgement as Record<string, unknown> : null;
    if (!terms || terms.termsVersion !== DECOMPILE_TERMS_VERSION)
        throw new Error(`需要接受当前版本（${DECOMPILE_TERMS_VERSION}）的反编译源码使用条款后才能导出`);
    if (terms.acknowledged !== true)
        throw new Error('未确认使用条款');
    const origin = terms.origin === 'ai-action' ? 'ai-action' as const : 'user-workspace' as const;
    const moduleName = typeof value.moduleName === 'string' ? value.moduleName : '';
    const plan = plannedModulePaths(pack.path, moduleName);
    const provenance = await readDecompileProvenanceForExport(decompileCacheRoot(), String(value.sourceSha256 ?? ''));
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
    });
    await addModpackModule(pack, { name: created.name, namespace: created.namespace, path: created.relativePath, createdAt: new Date().toISOString() });
    diagnosticJournal.record({ subsystem: 'decompile', operation: 'create-module', phase: 'success', level: 'info', message: `已从反编译源码创建自制模组 ${created.namespace}（来源 ${provenance.sourceFileName}，条款 v${DECOMPILE_TERMS_VERSION}，${origin === 'ai-action' ? 'AI 发起' : '用户发起'}）`, data: { namespace: created.namespace, fileCount: created.fileCount } });
    return created;
}));
diagnosticHandle('decompile:createProjectFromJar', (_event, input: unknown) => host.runDiagnosticOperation('decompile', 'createProjectFromJar', 'Create ModMind project from decompiled sources', async () => {
    host.assertProjectSwitchAllowed();
    if (!input || typeof input !== 'object')
        throw new Error('项目创建请求无效');
    const value = input as Record<string, unknown>;
    const sourceSha256 = typeof value.sourceSha256 === 'string' ? value.sourceSha256.trim() : '';
    if (!/^[a-f0-9]{64}$/i.test(sourceSha256))
        throw new Error('缺少有效的反编译缓存标识');
    const terms = value.termsAcknowledgement && typeof value.termsAcknowledgement === 'object'
        ? value.termsAcknowledgement as Record<string, unknown>
        : null;
    if (!terms || terms.termsVersion !== DECOMPILE_TERMS_VERSION)
        throw new Error(`需要接受当前版本（${DECOMPILE_TERMS_VERSION}）的反编译源码使用条款后才能创建项目`);
    if (terms.acknowledged !== true)
        throw new Error('未确认使用条款');
    const loader = value.loader;
    if (!isJavaLoader(loader) && !isServerPluginPlatform(loader))
        throw new Error('反编译项目仅支持 Java 模组或服务端插件平台');
    const provenance = await readDecompileProvenanceForExport(decompileCacheRoot(), sourceSha256);
    validateDecompiledProjectTarget(provenance, loader);
    const name = validateProjectNameInput(typeof value.name === 'string' ? value.name : '');
    const minecraftVersion = typeof value.minecraftVersion === 'string' ? value.minecraftVersion.trim() : '';
    if (!(loader === 'velocity' ? /^[34]\.\d+\.\d+(?:-SNAPSHOT)?$/ : /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/).test(minecraftVersion))
        throw new Error('Minecraft 或代理 API 版本格式无效');
    const compatibility = await host.requireLoaderCatalog().resolve(loader, minecraftVersion);
    const destination = await dialog.showOpenDialog(host.mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    if (destination.canceled || !destination.filePaths[0])
        return null;
    const namespace = host.slugify(name);
    const projectPath = path.join(destination.filePaths[0], namespace);
    if (await host.pathExists(projectPath))
        throw new Error('目标项目目录已经存在，请选择其他位置或名称');
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
    };
    if (isServerPluginPlatform(loader))
        project.kind = 'server-plugin';
    let seededFileCount = 0;
    await fs.mkdir(projectPath);
    try {
        await host.writeProjectTemplate(project, false);
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
        });
        seededFileCount = seeded.fileCount;
        if (provenance.plugin)
            await restoreDecompiledPluginProject(project, provenance, path.join(decompileCacheRoot(), 'jars', sourceSha256, 'resources'));
    }
    catch (error) {
        await fs.rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    host.currentProject = project;
    await host.rememberRecentProject(project);
    await refreshExternalAgentContext(project, host.featurePluginService.enabled('image-studio')).catch(() => undefined);
    host.emitProjectChanged();
    diagnosticJournal.record({ subsystem: 'decompile', operation: 'create-project', phase: 'success', level: 'info', message: `已从反编译源码创建 ModMind 项目 ${project.namespace}（来源 ${provenance.sourceFileName}，条款 v${DECOMPILE_TERMS_VERSION}）`, data: { projectPath, fileCount: seededFileCount } });
    return project;
}));

return { actions, inspectDecompileJar, readDecompileProvenanceForExport, inspectForDecompilation, listCachedSourceFiles, readCachedSourceFile, runDecompilation, scanReferencesForJar, restoreDecompiledPluginProject, validateDecompiledProjectTarget, DECOMPILE_MIN_JAVA, createModuleFromDecompiledSources, DECOMPILE_TERMS_TITLE, DECOMPILE_TERMS_VERSION, DECOMPILE_TERMS_SECTIONS, plannedModulePaths, renderDecompileTerms, seedProjectFromDecompiledSources, readDecompileCacheEntry,  }
}
