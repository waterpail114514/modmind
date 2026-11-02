import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { promises as fs, readFileSync, createReadStream } from "node:fs"
import path from "node:path"
import { modpackModsRoot, modpackOverridesRoot } from "../../src/main/modpackPaths"
import { LoaderCatalog } from "../../src/main/loaderCatalog"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import { ignoreSnapshotDirectory, repairLegacySnapshotCaches, snapshotStorageInfo } from "../../src/main/snapshotStorage"
import { assessModpackMigration, createModpackMigration, inspectModpackMigrationJar } from "./src/main/modpackMigrationService"
import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import { isAddonPlatform, isJavaLoader, isServerPluginPlatform, platformLabel, PROJECT_PLATFORMS } from "../../src/shared/projectPlatform"
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
async function writeModpackMigrationRecord(project: ProjectInfo, record: ModpackMigrationRecord): Promise<void> {
    const directory = host.modpackMigrationDirectory(project, record.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'migration.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
async function preserveDirectMigrationSources(project: ProjectInfo, migrationId: string): Promise<void> {
    const manifest = await readModpackManifest(project);
    const modsRoot = modpackModsRoot(project, manifest);
    const destination = path.join(host.modpackMigrationDirectory(project, migrationId), 'evidence', 'source-jars');
    await fs.mkdir(destination, { recursive: true });
    for (const mod of manifest.mods) {
        const source = path.join(modsRoot, mod.fileName);
        const stat = await fs.stat(source).catch(() => null);
        if (stat?.isFile())
            await fs.copyFile(source, path.join(destination, mod.fileName));
    }
}
async function applyModpackMigrationInPlace(project: ProjectInfo, target: Awaited<ReturnType<LoaderCatalog['resolve']>>, input: ModpackMigrationCreateInput): Promise<ModpackMigrationCreateResult> {
    host.assertProjectSwitchAllowed();
    host.assertProjectMutationAllowed(project.path, '迁移版本');
    const mode: ModpackMigrationMode = input.mode === 'direct' ? 'direct' : 'backup';
    const migrationId = `migration-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-modpack-migration-'));
    const stagedRoot = path.join(temporaryRoot, 'target');
    const rollbackRoot = path.join(temporaryRoot, 'rollback');
    let sourceSnapshot: SnapshotInfo | undefined;
    let sourceSnapshotTree: Awaited<ReturnType<typeof host.readSnapshotManifest>> | undefined;
    let rollbackFiles: string[] = [];
    let commitStarted = false;
    let preserveRecoveryFiles = false;
    try {
        if (mode === 'backup') {
            sourceSnapshot = await host.createProjectSnapshot(`整合包迁移前：${project.loader} ${project.minecraftVersion} -> ${target.loader} ${target.minecraftVersion}`);
            sourceSnapshotTree = await host.readSnapshotManifest(project, sourceSnapshot.id);
        }
        else {
            await host.copySnapshotFiles(project.path, rollbackRoot, ignoreSnapshotDirectory);
            rollbackFiles = await host.listSnapshotManagedFiles(rollbackRoot);
            await preserveDirectMigrationSources(project, migrationId);
        }
        const generated = await createModpackMigration(host.requireModProviderRegistry(), project, target, { ...input, mode }, stagedRoot, host.copyBundledGradleWrapper, host.mcmodService);
        const migratedProject: ProjectInfo = { ...generated.project, path: project.path };
        await fs.writeFile(path.join(stagedRoot, host.currentProjectManifest), `${JSON.stringify(migratedProject, null, 2)}\n`, 'utf8');
        const expectedFiles = await host.listSnapshotManagedFiles(stagedRoot);
        if (!expectedFiles.includes(host.currentProjectManifest) || !expectedFiles.includes('modmind.pack.json')) {
            throw new Error('暂存迁移项目缺少必要清单，未修改原项目');
        }
        commitStarted = true;
        await host.restoreSnapshotFilesExact(stagedRoot, project.path, expectedFiles);
        const committed = await host.readProjectInfo(project.path);
        if (!committed || committed.kind !== 'modpack' || committed.loader !== target.loader || committed.minecraftVersion !== target.minecraftVersion) {
            throw new Error('迁移提交后的项目清单无效');
        }
        const reportPath = path.join(project.path, path.relative(stagedRoot, generated.reportPath));
        const archivedReportPath = path.join(host.modpackMigrationDirectory(project, migrationId), 'reports', 'modpack-migration-report.md');
        await fs.mkdir(path.dirname(archivedReportPath), { recursive: true });
        await fs.copyFile(reportPath, archivedReportPath);
        const createdAt = new Date().toISOString();
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
        };
        const generatedEvidence = path.join(project.path, 'docs', 'migration-evidence');
        const storedEvidence = path.join(host.modpackMigrationDirectory(project, migrationId), 'evidence');
        if (await fs.stat(generatedEvidence).then((stat) => stat.isDirectory()).catch(() => false)) {
            await fs.mkdir(storedEvidence, { recursive: true });
            await fs.cp(generatedEvidence, storedEvidence, { recursive: true });
        }
        const recordDirectory = host.modpackMigrationDirectory(project, migrationId);
        await fs.writeFile(path.join(recordDirectory, 'decisions.json'), `${JSON.stringify({ mods: input.mods, modules: input.modules, content: input.content }, null, 2)}\n`, 'utf8');
        await fs.writeFile(path.join(recordDirectory, 'result.json'), `${JSON.stringify({
            status: generated.status,
            installed: generated.installed,
            manualFiles: generated.manualFiles,
            removed: generated.removed,
            deferred: generated.deferred,
            portedModules: generated.portedModules,
            copiedContent: generated.copiedContent,
            warnings: generated.warnings
        }, null, 2)}\n`, 'utf8');
        await writeModpackMigrationRecord(committed, record);
        host.currentProject = committed;
        await host.rememberRecentProject(committed);
        host.emitProjectChanged();
        return {
            ...generated,
            project: committed,
            migrationId,
            mode,
            sourceSnapshotId: sourceSnapshot?.id,
            canUndo: Boolean(sourceSnapshot),
            reportPath
        };
    }
    catch (error) {
        if (commitStarted) {
            try {
                if (sourceSnapshotTree)
                    await host.restoreSnapshotTree(project, sourceSnapshotTree);
                else if (rollbackFiles.length)
                    await host.restoreSnapshotFilesExact(rollbackRoot, project.path, rollbackFiles);
                host.currentProject = project;
                host.emitProjectChanged();
            }
            catch (rollbackError) {
                preserveRecoveryFiles = true;
                const backupPath = sourceSnapshotTree?.root ?? rollbackRoot;
                throw new Error(`整合包迁移失败，自动回滚也失败。恢复文件已保留在：${backupPath}\n迁移错误：${error instanceof Error ? error.message : String(error)}\n回滚错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        if (mode === 'direct')
            await fs.rm(host.modpackMigrationDirectory(project, migrationId), { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    finally {
        if (!preserveRecoveryFiles) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
async function undoModpackMigration(project: ProjectInfo, migrationId: string): Promise<ModpackMigrationUndoResult> {
    const record = await host.readModpackMigrationRecord(project, migrationId);
    if (record.status === 'undone')
        throw new Error('该迁移已经撤销');
    if (!record.sourceSnapshotId)
        throw new Error('直接迁移没有迁移前备份，不能一键撤销');
    const restored = await host.restoreProjectSnapshot(record.sourceSnapshotId, project.path);
    const updated: ModpackMigrationRecord = {
        ...record,
        status: 'undone',
        preUndoSnapshotId: restored.backup.id,
        undoneAt: new Date().toISOString()
    };
    await writeModpackMigrationRecord(restored.project, updated);
    host.currentProject = restored.project;
    host.emitProjectChanged();
    return { migration: updated, restoredProject: restored.project, preUndoSnapshot: restored.backup };
}
async function resolveModpackMigrationTarget(input: Record<string, unknown>): Promise<Awaited<ReturnType<LoaderCatalog['resolve']>>> {
    if (!isJavaLoader(input.loader) || typeof input.minecraftVersion !== 'string' || !input.minecraftVersion.trim()) {
        throw new Error('migration target requires a Java loader and Minecraft version');
    }
    return host.requireLoaderCatalog().resolve(input.loader, input.minecraftVersion.trim());
}
function normalizeMcpMigrationInput(project: ProjectInfo, input: Record<string, unknown>): ModpackMigrationCreateInput {
    if (!isJavaLoader(input.loader) || typeof input.minecraftVersion !== 'string' || !Array.isArray(input.mods) || !Array.isArray(input.modules) || !Array.isArray(input.content)) {
        throw new Error('migration apply requires loader, minecraftVersion, mods, modules, and content');
    }
    const root = path.resolve(project.path);
    const mods = input.mods.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('migration mod decision is invalid');
        const decision = { ...(value as Record<string, unknown>) };
        if (decision.action === 'manual-file') {
            if (typeof decision.filePath !== 'string' || path.isAbsolute(decision.filePath))
                throw new Error('Agent manual migration JAR paths must be project-relative');
            const resolved = path.resolve(project.path, ...decision.filePath.replaceAll('\\', '/').split('/'));
            if (!resolved.startsWith(`${root}${path.sep}`))
                throw new Error('Agent manual migration JAR path must stay inside the project');
            decision.filePath = resolved;
        }
        return decision;
    }) as unknown as ModpackMigrationCreateInput['mods'];
    return {
        loader: input.loader,
        minecraftVersion: input.minecraftVersion.trim(),
        mode: input.mode === 'direct' ? 'direct' : 'backup',
        mods,
        modules: input.modules as ModpackMigrationCreateInput['modules'],
        content: input.content as ModpackMigrationCreateInput['content']
    };
}
async function previewModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const target = await resolveModpackMigrationTarget(input);
    return assessModpackMigration(host.requireModProviderRegistry(), project, target, undefined, host.mcmodService);
}
async function applyModpackMigrationForAgent(project: ProjectInfo, input: Record<string, unknown>): Promise<ModpackMigrationCreateResult> {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const normalized = normalizeMcpMigrationInput(project, input);
    const target = await resolveModpackMigrationTarget(normalized as unknown as Record<string, unknown>);
    const result = await host.withMinecraftResourceLock(() => applyModpackMigrationInPlace(project, target, normalized));
    Object.assign(project, result.project);
    return result;
}
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "modpack-migration" }, () => handler(host.event(), ...(input.args as any[]))) }
diagnosticHandle('modpack:previewMigration', async (event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    if (!input || typeof input !== 'object')
        throw new Error('迁移目标无效');
    const value = input as {
        loader?: unknown;
        minecraftVersion?: unknown;
    };
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string')
        throw new Error('迁移目标必须是 Java Loader 和 Minecraft 版本');
    const target = await host.requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim());
    return assessModpackMigration(host.requireModProviderRegistry(), project, target, (progress) => {
        if (!event.sender.isDestroyed())
            event.sender.send('modpack:migrationProgress', progress);
    }, host.mcmodService);
});
diagnosticHandle('modpack:selectMigrationJar', async (_event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    if (!input || typeof input !== 'object')
        throw new Error('迁移目标无效');
    const value = input as {
        loader?: unknown;
        minecraftVersion?: unknown;
    };
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string')
        throw new Error('迁移目标必须是 Java Loader 和 Minecraft 版本');
    await host.requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim());
    const selected = await dialog.showOpenDialog(host.mainWindow!, { properties: ['openFile'], filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }] });
    if (selected.canceled || !selected.filePaths[0])
        return null;
    return inspectModpackMigrationJar(selected.filePaths[0], value.loader);
});
diagnosticHandle('modpack:createMigration', async (_event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    if (!input || typeof input !== 'object')
        throw new Error('迁移方案无效');
    const value = input as Partial<ModpackMigrationCreateInput>;
    if (!isJavaLoader(value.loader) || typeof value.minecraftVersion !== 'string' || !Array.isArray(value.mods) || !Array.isArray(value.modules) || !Array.isArray(value.content)) {
        throw new Error('迁移方案缺少目标版本或取舍记录');
    }
    if (value.mode !== undefined && value.mode !== 'backup' && value.mode !== 'direct')
        throw new Error('迁移模式无效');
    const target = await host.requireLoaderCatalog().resolve(value.loader, value.minecraftVersion.trim());
    return host.withMinecraftResourceLock(() => applyModpackMigrationInPlace(project, target, { ...(value as ModpackMigrationCreateInput), mode: value.mode === 'direct' ? 'direct' : 'backup' }));
});
diagnosticHandle('modpack:migrationHistory', () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    return host.listModpackMigrationRecords(project);
});
diagnosticHandle('modpack:undoMigration', async (_event, migrationId: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('当前项目不是整合包');
    host.assertProjectMutationAllowed(project.path, '撤销迁移');
    return host.withMinecraftResourceLock(() => undoModpackMigration(project, host.validateMigrationId(migrationId)));
});


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackMigrationTargets" | "modpackMigrationPreview" | "modpackMigrationApply" | "modpackMigrationHistory" | "modpackMigrationUndo"> => {
return { modpackMigrationTargets: async () => (await host.requireLoaderCatalog().list()).filter((option) => ['fabric', 'quilt', 'forge', 'neoforge'].includes(option.loader)),
modpackMigrationPreview: (input) => previewModpackMigrationForAgent(project, input),
modpackMigrationApply: (input) => applyModpackMigrationForAgent(project, input),
modpackMigrationHistory: () => host.listModpackMigrationRecords(project),
modpackMigrationUndo: async (migrationId) => {
    const result = await host.withMinecraftResourceLock(() => undoModpackMigration(project, migrationId));
    Object.assign(project, result.restoredProject);
    return result;
} }
}
actions["modpack_migration_targets"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackMigrationTargets!()
actions["modpack_migration_preview"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackMigrationPreview!(input)
actions["modpack_migration_apply"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackMigrationApply!(input)
actions["modpack_migration_history"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackMigrationHistory!()
actions["modpack_migration_undo"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackMigrationUndo!(String(input.migrationId ?? ''))
return { actions, writeModpackMigrationRecord, preserveDirectMigrationSources, applyModpackMigrationInPlace, undoModpackMigration, resolveModpackMigrationTarget, normalizeMcpMigrationInput, previewModpackMigrationForAgent, applyModpackMigrationForAgent, createMcpHandlers, assessModpackMigration, createModpackMigration, inspectModpackMigrationJar,  }
}
