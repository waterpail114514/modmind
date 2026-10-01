import { app,dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CreationFeedbackService } from '../../src/main/creationFeedbackService'
import { diagnosticJournal } from '../../src/main/diagnosticLog'
import { downloadActivities } from '../../src/main/downloadActivityService'
import type { NativeFeatureHost } from '../../src/main/index'
import { requireManagedRuntimePreparation } from '../../src/main/managedRuntimePreparation'
import { isModpackProject,readModpackManifest } from '../../src/main/modpackService'
import { sameProjectPath } from '../../src/main/projectPath'
import { generateGithubWorkflow } from '../../src/main/workflowService'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'
import type { HeadlessSmokeTestResult,LocalTestOptions,MinecraftLaunchOptions,MinecraftManagedMod } from '../../src/shared/minecraft'
import type { TestMatrixResult,TestTarget } from '../../src/shared/production'
import { isJavaLoader,platformLabel } from '../../src/shared/projectPlatform'
import type {
ProjectInfo
} from '../../src/shared/types'
import { HeadlessMcService,supportsHeadlessMc } from "./src/main/headlessMcService"
import { LocalServerManager } from "./src/main/localServerService"
import { LocalTestService } from "./src/main/localTestService"
import { MinecraftRuntimeManager } from "./src/main/minecraftRuntime"
import { nativeMcpFor } from "./src/main/nativeMinecraftMcp"
import { NativeMinecraftTestService } from "./src/main/nativeMinecraftTestService"
import { PlayerTestService } from "./src/main/playerTestService"
import { runRenderedMinecraftTest } from "./src/main/renderedMinecraftTest"
import { readServerProfile, saveServerProfile, serverCoreVersions, serverCoreBuilds, importLocalServerCore } from "./src/main/serverCoreService"
import { SERVER_PACK_CREATOR_MIN_JAVA } from "./src/main/serverPackCreatorService"
import { addServerPackMods,buildServerPack,createServerPackArchive,installServerRuntime,readExistingServerPack,readServerPackManifest,removeServerPackMod,serverRuntimeDownloadDescription } from "./src/main/serverPackService"
import type { buildAndJoinServer,runServerScenario,ServerJoinVerificationResult } from "./src/main/serverVerificationService"
import type { ServerCore, ServerProfile } from '../../src/shared/serverPlugin'
export function activate(options: { host: NativeFeatureHost; pluginDirectory: string }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = input => handler(host.event(), ...(input.args as any[])) }
const requireMinecraftRuntime = (): MinecraftRuntimeManager => minecraftRuntime!
let minecraftRuntime: MinecraftRuntimeManager | null = null
let localServerManager: LocalServerManager | null = null
let playerTestService: PlayerTestService | null = null
let localTestService: LocalTestService | null = null
let headlessMcService: HeadlessMcService | null = null
const serverEvidenceCursors = new Map<string, number>()
minecraftRuntime = new MinecraftRuntimeManager({
    getProject: () => host.aiProjectContext.getStore() ?? host.currentProject,
    onState: (state) => host.mainWindow?.webContents.send('minecraft:state', state),
    onEvent: host.forwardMinecraftRuntimeEvent,
    authorizeBuild: host.ensureProjectBuildTrusted,
    getGradleDownloadSource: async () => (await host.readSettings()).gradleDownloadSource ?? 'auto',
    getJavaPreference: async () => (await host.readSettings()).javaPreferences,
    prepareProjectDependencies: async (project, signal) => {
        if (project.kind === 'modpack' || !isJavaLoader(project.loader) || !host.featurePluginService.enabled('relationships'))
            return;
        await host.requireAddonRelationshipService().refreshLinkedProjects((linked) => host.buildLinkedProjectTree(linked, signal, [project.path]), [project.path]);
    }
});
localServerManager = new LocalServerManager({
    getProject: () => host.currentProject,
    getJavaPath: (project, major) => project ? host.aiProjectContext.run(project, () => requireMinecraftRuntime().ensureJavaRuntime(undefined, major)) : requireMinecraftRuntime().ensureJavaRuntime(undefined, major),
    cacheDirectory: path.join(app.getPath('userData'), 'server-cores'),
    buildPlugin: (project, signal) => host.aiProjectContext.run(project, () => host.buildProjectWithLock(signal)),
    onState: (state) => {
        host.mainWindow?.webContents.send('local-server:state', state);
        localTestService?.serverChanged(state);
    },
    onEvent: (event) => {
        diagnosticJournal.record({ subsystem: 'local-server', operation: event.stage, phase: event.level === 'error' ? 'error' : 'event', level: event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'info', message: event.message });
        host.mainWindow?.webContents.send('local-server:event', event);
    }
});
localTestService = new LocalTestService({
    project: host.requireProject,
    server: localServerManager,
    createClient: async (project, onState, onEvent) => {
        const profile = project.kind === 'server-plugin' ? await readServerProfile(project) : undefined;
        if (profile?.core === 'velocity')
            throw new Error('Velocity 需要后端世界服，请使用单独启动服务端');
        const clientProject = profile ? { ...project, minecraftVersion: profile.version } : project;
        return new MinecraftRuntimeManager({
            getProject: () => clientProject,
            vanillaClient: project.kind === 'server-plugin',
            instanceDirectory: path.join(project.path, '.modmind', 'local-test-client'),
            getJavaPreference: async () => (await host.readSettings()).javaPreferences,
            onState,
            onEvent
        });
    },
    onState: state => host.mainWindow?.webContents.send('local-test:state', state)
});
headlessMcService = new HeadlessMcService({
    userDataDirectory: app.getPath('userData'),
    onEvent: host.forwardMinecraftRuntimeEvent
});
playerTestService = new PlayerTestService({ server: () => {
        if (!localServerManager)
            throw new Error('本机测试服务不可用');
        return localServerManager;
    }, currentProject: () => host.currentProject, headless: requireHeadlessMc, javaPreferences: async () => (await host.readSettings()).javaPreferences, onEvent: host.forwardMinecraftRuntimeEvent,
    native: new NativeMinecraftTestService({
        currentProject: () => host.currentProject,
        build: (project, signal) => host.aiProjectContext.run(project, () => host.buildProjectWithLock(signal)),
        createRuntime: (project, directory, port) => new MinecraftRuntimeManager({
            getProject: () => project, instanceDirectory: directory, minecraftMcpPort: port,
            getJavaPreference: async () => (await host.readSettings()).javaPreferences,
            onState: () => undefined, onEvent: host.forwardMinecraftRuntimeEvent
        })
    })
});
function syncCurrentKubeJsServerScripts(): ReturnType<MinecraftRuntimeManager['syncKubeJsServerScripts']> {
    const project = host.requireProject();
    if (project.kind !== 'modpack')
        throw new Error('KubeJS 脚本同步仅适用于当前整合包项目');
    return host.withMinecraftResourceLock(() => {
        if (!host.currentProject || !sameProjectPath(project.path, host.currentProject.path))
            throw new Error('项目已切换，请在当前整合包重新同步');
        return requireMinecraftRuntime().syncKubeJsServerScripts();
    });
}

function requireHeadlessMc(): HeadlessMcService {
    if (!headlessMcService)
        throw new Error('HeadlessMC 服务不可用');
    return headlessMcService;
}

async function stageHeadlessMinecraftMods(project: ProjectInfo, artifact: MinecraftManagedMod): Promise<string> {
    const sourceDirectory = path.join(project.path, host.projectDataDirectory(project), 'headlessmc', 'source-mods');
    await fs.rm(sourceDirectory, { recursive: true, force: true });
    await fs.mkdir(sourceDirectory, { recursive: true });
    if (project.kind === 'modpack') {
        const runtimeModsDirectory = path.join(project.path, host.projectDataDirectory(project), 'minecraft', 'mods');
        const entries = await fs.readdir(runtimeModsDirectory, { withFileTypes: true }).catch(() => []);
        const jars = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'));
        await Promise.all(jars.map((entry) => fs.copyFile(path.join(runtimeModsDirectory, entry.name), path.join(sourceDirectory, entry.name))));
    }
    else {
        const stat = await fs.stat(artifact.path).catch(() => null);
        if (!stat?.isFile() || !artifact.path.toLowerCase().endsWith('.jar'))
            throw new Error('构建产物不是可用于 HeadlessMC 的 Mod JAR');
        await fs.copyFile(artifact.path, path.join(sourceDirectory, path.basename(artifact.path)));
    }
    const staged = await fs.readdir(sourceDirectory, { withFileTypes: true });
    if (!staged.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))) {
        throw new Error('没有可用于 HeadlessMC 冒烟测试的 Mod JAR');
    }
    return sourceDirectory;
}

async function runHeadlessMinecraftSmokeUnlocked(project: ProjectInfo, signal?: AbortSignal, options: {
    artifact?: MinecraftManagedMod;
    stableWindowMs?: number;
    offline?: boolean;
} = {}): Promise<HeadlessSmokeTestResult> {
    if (!supportsHeadlessMc(project.loader))
        throw new Error(`HeadlessMC 当前仅支持 Fabric、Forge 和 NeoForge，当前项目为 ${project.loader}`);
    const runtime = requireMinecraftRuntime();
    const artifact = options.artifact
        ?? (runtime.getState().running
            ? (await runtime.listMods()).find((mod) => mod.projectArtifact)
            : await host.buildProjectWithLock(signal));
    if (!artifact) {
        throw new Error(runtime.getState().running
            ? 'Minecraft 测试实例正在运行，但没有找到已同步的项目 JAR；请停止实例并重新构建'
            : '构建未生成可用于 HeadlessMC 的 Mod JAR');
    }
    const sourceDirectory = await stageHeadlessMinecraftMods(project, artifact);
    try {
        const javaPath = await runtime.ensureJavaRuntime();
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
            });
        });
        const preparedState = runtime.getState();
        if (!preparedState.loaderVersionId)
            throw new Error('Minecraft 运行时已准备，但缺少精确 Loader profile');
        return await requireHeadlessMc().run({
            project,
            gameDirectory: path.join(project.path, host.projectDataDirectory(project), 'headlessmc', 'game'),
            sourceModsDirectory: sourceDirectory,
            javaPath,
            managedMinecraftDirectory: runtime.managedMinecraftDirectory(),
            loaderVersionId: preparedState.loaderVersionId,
            stableWindowMs: options.stableWindowMs ?? 20000,
            offline: options.offline !== false
        }, signal);
    }
    finally {
        await fs.rm(sourceDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function runHeadlessMinecraftSmoke(project: ProjectInfo, signal?: AbortSignal, options: {
    artifact?: MinecraftManagedMod;
    stableWindowMs?: number;
    offline?: boolean;
} = {}): Promise<HeadlessSmokeTestResult> {
    return host.withMinecraftResourceLock(() => runHeadlessMinecraftSmokeUnlocked(project, signal, options));
}

async function runManagedRenderedTest(project: ProjectInfo, signal?: AbortSignal) {
    if (project.kind === 'server-plugin' || !isJavaLoader(project.loader))
        throw new Error('此入口支持 Java Mod 和整合包；服务端插件请使用玩家测试的 rendered 模式，基岩版和网易版使用其官方测试工具');
    if ((project.kind ?? 'mod') === 'mod' && nativeMcpFor(project.minecraftVersion, project.loader)) {
        if (!playerTestService)
            throw new Error('玩家测试服务不可用');
        const session = await playerTestService.execute(project, 'session', { operation: 'start', mode: 'rendered' }, signal) as {
            sessionId: string;
            observation: unknown;
        };
        try {
            const capture = await playerTestService.execute(project, 'capture', { sessionId: session.sessionId }, signal) as {
                captures: Array<{
                    path: string;
                    dataUrl: string;
                }>;
            };
            return { success: true, backend: 'minecraft-mod-mcp', observation: session.observation, captures: capture.captures, visualVerified: false as const, gameplayVerified: false as const, clientStopped: true as const };
        }
        finally {
            await playerTestService.execute(project, 'session', { operation: 'stop', sessionId: session.sessionId });
        }
    }
    return host.withMinecraftResourceLock(() => {
        const runtime = requireMinecraftRuntime();
        return runRenderedMinecraftTest({
            isRunning: () => runtime.getState().running,
            build: () => host.buildProjectWithLock(signal),
            launch: (options, window, taskSignal) => runtime.testLaunch(options, window, taskSignal),
            stop: () => runtime.stop()
        }, signal);
    });
}

async function runProjectTestMatrixUnlocked(targets: TestTarget[], signal?: AbortSignal, onProgress?: (target: TestTarget, completed: number, total: number) => void): Promise<TestMatrixResult> {
    const activeProject = host.requireProject();
    const selectedInput = new Set(Array.isArray(targets) ? targets : []);
    const selected = (['build', 'client', 'server', 'gametest'] as TestTarget[]).filter((target) => selectedInput.has(target));
    const startedAt = new Date().toISOString();
    const results: TestMatrixResult['results'] = [];
    let buildPassed = false;
    const runtime = requireMinecraftRuntime();
    const runGradleTarget = async (target: TestTarget, tasks: string[], stableWindowMs = 0): Promise<void> => {
        const started = Date.now();
        try {
            const result = await runtime.testGradleTask(tasks, stableWindowMs, signal);
            results.push({
                target,
                status: result.skipped ? 'skipped' : result.success ? 'passed' : 'failed',
                summary: result.summary,
                durationMs: Date.now() - started,
                logPath: result.logPath
            });
        }
        catch (error) {
            results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
        }
        finally {
            await runtime.stop().catch(() => undefined);
        }
    };
    for (const target of selected) {
        if (signal?.aborted)
            throw Object.assign(new Error('测试矩阵已取消'), { name: 'AbortError' });
        if (activeProject.kind === 'server-plugin' && target !== 'build') {
            if (target !== 'server')
                results.push({ target, status: 'skipped', summary: '服务端插件不使用模组客户端/GameTest；请运行服务端与具体场景', durationMs: 0 });
            else {
                const started = Date.now();
                try {
                    const state = await localServerAgentOperation(activeProject, { operation: 'start' }, signal) as import('../../src/shared/minecraft').LocalServerState;
                    results.push({ target, status: state.running ? 'passed' : 'failed', summary: '核心启动检查；插件业务行为仍需场景验证', durationMs: Date.now() - started, logPath: state.logPath });
                }
                catch (error) {
                    results.push({ target, status: 'failed', summary: String(error), durationMs: Date.now() - started });
                }
            }
            onProgress?.(target, results.length, selected.length);
            continue;
        }
        if (target === 'build') {
            const started = Date.now();
            try {
                const artifact = await host.buildProjectWithLock(signal);
                buildPassed = true;
                results.push({ target, status: 'passed', summary: `${artifact.name} · ${(artifact.size / 1024).toFixed(1)} KB`, durationMs: Date.now() - started });
            }
            catch (error) {
                results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
            }
        }
        else if (target === 'client') {
            const started = Date.now();
            try {
                const artifact: MinecraftManagedMod | undefined = buildPassed
                    ? (await runtime.listMods()).find((mod) => mod.projectArtifact) ?? await host.buildProjectWithLock(signal)
                    : await host.buildProjectWithLock(signal);
                buildPassed = Boolean(artifact);
                if (!artifact)
                    throw new Error('构建未生成可用于 HeadlessMC 的 Mod JAR');
                const result = await runHeadlessMinecraftSmokeUnlocked(activeProject, signal, { artifact, stableWindowMs: 20000, offline: true });
                results.push({ target, status: result.success ? 'passed' : 'failed', summary: result.message, durationMs: Date.now() - started });
            }
            catch (error) {
                results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
            }
            finally {
                await runtime.stop().catch(() => undefined);
            }
        }
        else if (target === 'server') {
            if (isModpackProject(activeProject)) {
                const started = Date.now();
                try {
                    const pack = await buildServerPack(activeProject, { outputDirectory: path.join(activeProject.path, host.projectDataDirectory(activeProject), 'test-server-pack'), acceptEula: true, port: 25565 });
                    results.push({ target, status: 'passed', summary: `server pack generated (${pack.copiedMods.length} mods)`, durationMs: Date.now() - started, logPath: pack.manifestPath });
                }
                catch (error) {
                    results.push({ target, status: 'failed', summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
                }
            }
            else {
                await runGradleTarget(target, ['runServer'], 15000);
            }
        }
        else {
            if (isModpackProject(activeProject))
                results.push({ target, status: 'skipped', summary: '整合包 GameTest 需要显式场景适配器；当前仅完成客户端启动和服务端包验收', durationMs: 0 });
            else
                await runGradleTarget(target, ['runGameTestServer', 'runGametest', 'runGameTest', 'gameTestServer']);
        }
        onProgress?.(target, results.length, selected.length);
    }
    return { success: results.every((result) => result.status !== 'failed'), startedAt, completedAt: new Date().toISOString(), results };
}

async function runProjectTestMatrix(targets: TestTarget[], signal?: AbortSignal, onProgress?: (target: TestTarget, completed: number, total: number) => void): Promise<TestMatrixResult> {
    return host.withMinecraftResourceLock(() => runProjectTestMatrixUnlocked(targets, signal, onProgress));
}

async function localServerAgentOperation(project: ProjectInfo, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!localServerManager || !host.currentProject || !sameProjectPath(project.path, host.currentProject.path))
        throw new Error('本机服务端操作需要当前项目');
    const manager = localServerManager;
    const feedback = new CreationFeedbackService(project);
    let result: unknown;
    let operationError: unknown;
    try {
        if (input.operation === 'state')
            result = manager.getState();
        else if (input.operation === 'stop') {
            await playerTestService?.stop();
            await localTestService?.stop();
            result = await manager.stop();
        }
        else if (input.operation === 'command')
            result = { ...await manager.sendCommand(String(input.command ?? '')), commandSent: true, commandVerified: false };
        else if (input.operation === 'scenario') {
            if (!Array.isArray(input.steps))
                throw new Error('场景步骤无效');
            result = await manager.runScenario(input.steps as Parameters<LocalServerManager['runScenario']>[0], signal);
        }
        else if (input.operation === 'start') {
            if (localTestService?.isBusy())
                throw new Error('请先停止页面中的本机测试');
            const cancel = (): void => { void manager.stop().catch(() => undefined); };
            signal?.throwIfAborted();
            signal?.addEventListener('abort', cancel, { once: true });
            try {
                result = await manager.start();
            }
            finally {
                signal?.removeEventListener('abort', cancel);
            }
        }
        else
            throw new Error('不支持的服务端操作');
    }
    catch (error) {
        operationError = error;
    }
    const state = manager.getState();
    let text = '';
    if (state.logPath) {
        const cursorKey = `${project.path}:${state.sessionId}`;
        const start = serverEvidenceCursors.get(cursorKey) ?? 0;
        const handle = await fs.open(state.logPath, 'r').catch(() => null);
        if (handle)
            try {
                const stat = await handle.stat();
                const offset = stat.size < start ? 0 : start;
                const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, stat.size - offset)));
                const read = await handle.read(buffer, 0, buffer.length, offset);
                text = buffer.subarray(0, read.bytesRead).toString('utf8');
                serverEvidenceCursors.set(cursorKey, offset + read.bytesRead);
                while (serverEvidenceCursors.size > 100)
                    serverEvidenceCursors.delete(serverEvidenceCursors.keys().next().value!);
            }
            finally {
                await handle.close();
            }
    }
    const evidence = text || operationError ? await feedback.evidence(`${operationError ? `${String(operationError)}\n` : ''}${text}`, 'managed-server') : undefined;
    if (input.operation === 'start')
        await feedback.check({ stage: 'startup', passed: !operationError && state.running, detail: state.message, sessionId: state.sessionId, buildId: project.kind === 'server-plugin' ? (await feedback.state()).builds.at(-1)?.id : undefined, evidenceId: evidence?.id });
    if (operationError)
        throw new Error(`${String(operationError)}${evidence ? `\n日志证据：${evidence.id}\n${evidence.prompt}` : ''}`);
    const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const { recentLogs: _logs, ...rest } = value;
    return { ...rest, ...(evidence ? { logSummary: evidence.prompt, evidenceId: evidence.id } : {}), logPath: state.logPath, logsAreIncremental: true };
}

async function managedServerJoin(options: Parameters<typeof buildAndJoinServer>[0]): Promise<ServerJoinVerificationResult> {
    if (!localServerManager || !host.currentProject || !sameProjectPath(host.currentProject.path, options.project.path))
        throw new Error('联机验证需要当前项目');
    return localServerManager.verify({ port: options.port, onlineMode: options.onlineMode, acceptEula: options.acceptEula }, async (state, signal) => {
        const runtime = requireMinecraftRuntime();
        await runtime.prepare(signal);
        await runtime.syncModpack();
        const result = await options.headless.run({ project: options.project, gameDirectory: options.gameDirectory, sourceModsDirectory: path.join(options.project.path, '.modmind/minecraft/mods'), javaPath: options.javaPath, managedMinecraftDirectory: runtime.managedMinecraftDirectory(), stableWindowMs: options.stableWindowMs ?? 20000, joinTimeoutMs: options.joinTimeoutMs ?? 30000, serverAddress: state.address, offline: !options.onlineMode }, signal);
        return { success: Boolean(result.success && result.joinedServer), address: state.address ?? '', serverLogPath: state.logPath ?? '', headless: result, message: result.message };
    });
}

async function managedServerScenario(options: Parameters<typeof runServerScenario>[0]): Promise<Awaited<ReturnType<typeof runServerScenario>>> {
    if (!localServerManager || !host.currentProject || !sameProjectPath(host.currentProject.path, options.project.path))
        throw new Error('场景验证需要当前项目');
    return localServerManager.verify({ port: options.port, onlineMode: options.onlineMode, acceptEula: options.acceptEula }, (_state, signal) => localServerManager!.runScenario(options.steps, signal));
}
diagnosticHandle('minecraft:getState', () => requireMinecraftRuntime().refresh());
diagnosticHandle('minecraft:prepare', () => host.invokeMinecraftOperation(() => requireMinecraftRuntime().prepare()));
diagnosticHandle('minecraft:cancelPreparation', async () => {
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? host.requireProject().path;
    await host.cancelTrackedMinecraftPreparation(projectPath);
    return requireMinecraftRuntime().getState();
});
diagnosticHandle('minecraft:restartPreparation', async () => {
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? host.requireProject().path;
    await host.restartTrackedMinecraftPreparation(projectPath);
    return requireMinecraftRuntime().getState();
});
diagnosticHandle('minecraft:launch', (_event, options: MinecraftLaunchOptions) => host.invokeMinecraftOperation(() => requireMinecraftRuntime().launch(options)));
diagnosticHandle('minecraft:testLaunch', (_event, options: MinecraftLaunchOptions) => host.invokeMinecraftOperation(() => requireMinecraftRuntime().testLaunch(options)));
diagnosticHandle('minecraft:headlessSmokeTest', async () => {
    const project = host.requireProject();
    if (!isJavaLoader(project.loader))
        throw new Error(`${platformLabel(project.loader)} 不支持 HeadlessMC 无头冒烟测试`);
    return runHeadlessMinecraftSmoke(project, undefined, { stableWindowMs: 20000, offline: true });
});
diagnosticHandle('minecraft:openHeadlessMcLogin', async () => {
    const project = host.requireProject();
    if (!isJavaLoader(project.loader))
        throw new Error(`${platformLabel(project.loader)} 不支持 HeadlessMC 无头冒烟测试`);
    const javaPath = await requireMinecraftRuntime().ensureJavaRuntime();
    return requireHeadlessMc().openLoginConsole(javaPath);
});
diagnosticHandle('minecraft:stop', async () => {
    await playerTestService?.stop();
    await headlessMcService?.stop();
    const projectPath = requireMinecraftRuntime().getState().projectPath ?? host.currentProject?.path;
    const state = await requireMinecraftRuntime().stop();
    if (projectPath) {
        const tracked = [...host.minecraftDownloadActivityIds.values()].filter((activity) => activity.projectPath === projectPath);
        for (const activity of tracked)
            await downloadActivities.cancel(activity.id);
    }
    return state;
});
diagnosticHandle('minecraft:syncProjectMod', () => requireMinecraftRuntime().syncProjectMod());
diagnosticHandle('minecraft:syncModpack', () => requireMinecraftRuntime().syncModpack());
diagnosticHandle('minecraft:syncKubeJsServerScripts', () => syncCurrentKubeJsServerScripts());
diagnosticHandle('minecraft:listMods', () => requireMinecraftRuntime().listMods());
diagnosticHandle('minecraft:removeMod', (_event, name: string) => requireMinecraftRuntime().removeMod(name));
diagnosticHandle('minecraft:importMods', async () => {
    const result = await dialog.showOpenDialog(host.mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Minecraft Mods', extensions: ['jar'] }]
    });
    if (result.canceled)
        return requireMinecraftRuntime().listMods();
    return requireMinecraftRuntime().importMods(result.filePaths);
});
diagnosticHandle('modpack:buildServerPack', async (_event, input: unknown) => {
    if (localServerManager?.isBusy())
        throw new Error('请先停止服务端再同步服务端包');
    const project = host.requireProject();
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, host.projectDataDirectory(project), 'server-pack');
    const manifest = project.kind === 'modpack' ? await readModpackManifest(project) : null;
    const engine = value.engine === 'internal' || !manifest?.mods.length ? 'internal' as const : 'serverpackcreator' as const;
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info', logPath?: string): void => localServerManager?.recordOperation(message, level, logPath);
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total });
    log(`开始同步服务端包：${engine === 'serverpackcreator' ? 'ServerPackCreator' : 'ModMind 内置引擎'}`);
    progress('正在准备服务端包同步', 0.02);
    try {
        let javaPath: string | undefined;
        if (engine === 'serverpackcreator') {
            log('正在准备 ServerPackCreator 所需的托管 Java');
            javaPath = await requireMinecraftRuntime().ensureJavaRuntime((message) => {
                log(message);
                progress(message, 0.04);
            }, SERVER_PACK_CREATOR_MIN_JAVA, ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 ServerPackCreator 所需的 Java`, 0.04 + 0.32 * (total > 0 ? downloaded / total : 0), downloaded, total));
            log('托管 Java 已就绪，正在运行 ServerPackCreator');
            progress('正在启动 ServerPackCreator', 0.38);
        }
        let creatorOutputWasStreamed = false;
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
                creatorOutputWasStreamed = true;
                log(output);
                progress('ServerPackCreator 正在下载并筛选服务端文件', 0.42);
            }
        });
        if (result.logPath && !creatorOutputWasStreamed) {
            const creatorOutput = await fs.readFile(result.logPath, 'utf8').catch(() => '');
            if (creatorOutput.trim())
                log(creatorOutput);
        }
        progress('正在写入服务端包清单', 0.94);
        log(`服务端包同步完成：${result.copiedMods.length} 个服务端 Mod，跳过 ${result.skippedClientMods.length} 个客户端 Mod`, 'info', result.logPath);
        progress('服务端包同步完成', 1);
        return result;
    }
    catch (error) {
        const message = host.describeRuntimeError(error);
        log(`服务端包同步失败：${message}`, 'error');
        throw new Error(`服务端包同步失败：${message}`);
    }
    finally {
        localServerManager?.clearOperationProgress();
    }
});
diagnosticHandle('modpack:installServerRuntime', async (_event, input: unknown) => {
    if (localServerManager?.isBusy())
        throw new Error('请先停止服务端再安装运行时');
    const project = host.requireProject();
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const target = serverRuntimeDownloadDescription(project);
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info', logPath?: string): void => localServerManager?.recordOperation(message, level, logPath);
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total });
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, '.modmind', 'server-pack');
    const pack = await readExistingServerPack(project, outputDirectory);
    if (!pack) {
        const message = '请先同步服务端包，再检查服务端运行时';
        log(message, 'warning');
        throw new Error(message);
    }
    log(`开始检查服务端运行时：${target.label}`);
    log(`已找到同步的服务端包：${pack.copiedMods.length} 个服务端 Mod`);
    progress('正在准备服务端运行时', 0.02);
    try {
        log('正在准备 Minecraft 服务器所需的兼容 Java');
        const runtimeJavaPath = await requireMinecraftRuntime().ensureJavaRuntime((message) => {
            log(message);
            progress(message, 0.05);
        }, undefined, ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 Minecraft 兼容 Java`, 0.05 + 0.35 * (total > 0 ? downloaded / total : 0), downloaded, total));
        progress('正在下载并安装服务端 Loader', 0.42);
        const runtime = await installServerRuntime({
            serverPack: pack,
            javaPath: runtimeJavaPath,
            onDownloadProgress: ({ source, downloaded, total }) => progress(`正在从 ${source.label} 下载服务端 Loader`, total ? 0.42 + 0.5 * downloaded / total : undefined, downloaded, total)
        }, project);
        progress('正在验证服务端运行时', 0.96);
        log(`服务端运行时已就绪：${runtime.serverJar ? path.basename(runtime.serverJar) : '启动脚本'}`);
        progress('服务端运行时已就绪', 1);
        return runtime;
    }
    catch (error) {
        const sources = target.sources.length ? `Sources: ${target.sources.join('; ')}` : 'No valid download source was generated';
        const message = `检查服务端运行时失败：${sources}。${host.describeRuntimeError(error)}`;
        log(message, 'error');
        throw new Error(message);
    }
    finally {
        localServerManager?.clearOperationProgress();
    }
});
diagnosticHandle('modpack:getServerPackManifest', () => readServerPackManifest(host.requireProject()));
diagnosticHandle('modpack:addServerPackMods', async () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const selected = await dialog.showOpenDialog(host.mainWindow!, {
        title: '添加服务端 Mod',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }]
    });
    if (selected.canceled || !selected.filePaths.length)
        return null;
    return addServerPackMods(project, selected.filePaths);
});
diagnosticHandle('modpack:removeServerPackMod', async (_event, fileName: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    return removeServerPackMod(project, typeof fileName === 'string' ? fileName : '');
});
diagnosticHandle('modpack:exportServerPack', async () => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const selected = await dialog.showSaveDialog(host.mainWindow!, {
        title: '导出服务端包',
        defaultPath: path.join(app.getPath('downloads'), `${project.namespace}-server-${project.minecraftVersion}.zip`),
        filters: [{ name: 'Server Pack ZIP', extensions: ['zip'] }]
    });
    if (selected.canceled || !selected.filePath)
        return null;
    const archive = await createServerPackArchive(project);
    await fs.writeFile(selected.filePath, archive);
    return selected.filePath;
});
diagnosticHandle('modpack:verifyServerJoin', async (_event, input: unknown) => {
    if (localServerManager?.isBusy())
        throw new Error('请先停止现有服务端再运行隔离联机验证');
    const project = host.requireProject();
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const port = typeof value.port === 'number' ? value.port : 25565;
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, '.modmind', 'server-pack');
    const log = (message: string, level: 'info' | 'warning' | 'error' = 'info'): void => localServerManager?.recordOperation(message, level);
    const progress = (message: string, fraction?: number, downloaded?: number, total?: number): void => localServerManager?.setOperationProgress({ message, fraction, downloaded, total });
    log('开始启动并验证本机服务端');
    progress('正在准备验证环境', 0.02);
    host.forwardMinecraftEventsToServerPanel = true;
    try {
        const pack = await readExistingServerPack(project, outputDirectory);
        if (!pack)
            throw new Error('请先同步服务端包，再启动并验证');
        log(`已找到同步的服务端包：${pack.copiedMods.length} 个服务端 Mod`);
        log('正在准备 Minecraft 服务器所需的兼容 Java');
        const javaPath = await requireMinecraftRuntime().ensureJavaRuntime((message) => {
            log(message);
            progress(message, 0.05);
        }, undefined, ({ source, downloaded, total }) => progress(`正在从 ${source} 下载 Minecraft 兼容 Java`, 0.05 + 0.27 * (total > 0 ? downloaded / total : 0), downloaded, total));
        progress('正在读取验证用服务端包', 0.32);
        const result = await managedServerJoin({
            project,
            outputDirectory,
            port,
            acceptEula: true,
            onlineMode: value.onlineMode === true,
            javaPath,
            serverPack: pack,
            headless: requireHeadlessMc(),
            gameDirectory: path.join(project.path, host.projectDataDirectory(project), 'headlessmc', 'server-join'),
            onEvent: (event) => {
                log(event.message, event.level);
                progress(event.message, 0.66);
            },
            onProgress: ({ message, fraction, downloaded, total }) => progress(message, fraction, downloaded, total)
        });
        log(result.message, result.success ? 'info' : 'warning');
        progress(result.success ? '本机联机验证完成' : '本机联机验证未通过', 1);
        return result;
    }
    catch (error) {
        const message = `启动并验证失败：${host.describeRuntimeError(error)}`;
        log(message, 'error');
        throw new Error(message);
    }
    finally {
        host.forwardMinecraftEventsToServerPanel = false;
        localServerManager?.clearOperationProgress();
    }
});
diagnosticHandle('modpack:runServerScenario', async (_event, input: unknown) => {
    const project = host.requireProject();
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (!Array.isArray(value.steps) || !value.steps.length)
        throw new Error('server scenario requires at least one step');
    const steps = value.steps.map((step) => {
        if (!step || typeof step !== 'object')
            throw new Error('invalid server scenario step');
        const record = step as Record<string, unknown>;
        return { command: String(record.command ?? ''), expect: Array.isArray(record.expect) ? record.expect.map(String) : [], timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined };
    });
    if (localServerManager?.isRunning())
        return localServerManager.runScenario(steps);
    if (project.kind === 'server-plugin')
        throw new Error('请先启动本机服务端，再执行场景');
    const javaPath = await requireMinecraftRuntime().ensureJavaRuntime();
    const port = typeof value.port === 'number' ? value.port : 25565;
    const outputDirectory = typeof value.outputDirectory === 'string' && value.outputDirectory.trim() ? value.outputDirectory : path.join(project.path, host.projectDataDirectory(project), 'server-scenario');
    return managedServerScenario({ project, outputDirectory, port, acceptEula: true, onlineMode: value.onlineMode === true, javaPath, steps, onEvent: (event) => host.mainWindow?.webContents.send('minecraft:event', event) });
});
diagnosticHandle('local-test:getState', () => localTestService?.getState());
diagnosticHandle('local-test:start', (_event, options: LocalTestOptions) => {
    if (!localTestService)
        throw new Error('本机测试服务不可用');
    return localTestService.start(options);
});
diagnosticHandle('local-test:stop', () => localTestService?.stop());
diagnosticHandle('modpack:getServerState', () => {
    if (!localServerManager)
        throw new Error('本机服务端管理器不可用');
    return localServerManager.getState();
});
diagnosticHandle('modpack:startServer', async (_event, input: unknown) => {
    if (localTestService?.isBusy())
        throw new Error('请先停止当前测试');
    if (!localServerManager)
        throw new Error('本机服务端管理器不可用');
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    return localServerManager.start({ port: typeof value.port === 'number' ? value.port : undefined, acceptEula: true, onlineMode: value.onlineMode === true });
});
diagnosticHandle('modpack:stopServer', async () => {
    await localTestService?.stop();
    if (!localServerManager)
        throw new Error('本机服务端管理器不可用');
    return localServerManager.stop();
});
diagnosticHandle('modpack:restartServer', async (_event, input: unknown) => {
    if (localTestService?.isBusy())
        throw new Error('请先停止当前测试');
    if (!localServerManager)
        throw new Error('本机服务端管理器不可用');
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    return localServerManager.restart({ port: typeof value.port === 'number' ? value.port : undefined, acceptEula: true, onlineMode: value.onlineMode === true });
});
diagnosticHandle('modpack:sendServerCommand', (_event, command: unknown) => {
    if (!localServerManager)
        throw new Error('本机服务端管理器不可用');
    return localServerManager.sendCommand(typeof command === 'string' ? command : '');
});
diagnosticHandle('tests:runMatrix', async (event, targets: TestTarget[]): Promise<TestMatrixResult> => {
    host.requireProject();
    return host.runDiagnosticOperation('tests', 'matrix', 'Project test matrix', () => runProjectTestMatrix(targets, undefined, (target, completed, total) => {
        if (!event.sender.isDestroyed())
            event.sender.send('tests:progress', { target, completed, total });
    }), { targets });
});
diagnosticHandle('tests:generateWorkflow', () => generateGithubWorkflow(host.requireProject()));
const testingProject = (root: unknown, mutation = false): ProjectInfo => {
  const project = host.requireProject()
  if (typeof root !== 'string' || !sameProjectPath(root,project.path) || project.kind !== 'server-plugin') throw new Error('服务端插件项目已切换或不存在')
  if (mutation && (localServerManager?.isBusy() || host.runsForProject(project.path).length)) throw new Error('请先停止服务端和正在执行的任务')
  return project
}
diagnosticHandle('server-plugin:profile', (_, root) => readServerProfile(testingProject(root)))
diagnosticHandle('server-plugin:saveProfile', (_, root, profile: ServerProfile) => saveServerProfile(testingProject(root, true), profile))
diagnosticHandle('server-plugin:versions', (_, core: ServerCore) => serverCoreVersions(core))
diagnosticHandle('server-plugin:builds', (_, core: ServerCore, version: string) => serverCoreBuilds(core, version))
diagnosticHandle('server-plugin:importCore', async (_, root) => {
    testingProject(root, true)
    const result = await dialog.showOpenDialog(host.mainWindow!, { title: '导入本地服务端核心', properties: ['openFile'], filters: [{ name: 'Server JAR', extensions: ['jar'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return importLocalServerCore(testingProject(root, true), result.filePaths[0])
  })
actions.local_server = (input, context) => localServerAgentOperation(host.requireProject(), input, context.signal)
actions.runtime_state = () => requireMinecraftRuntime().refresh()
actions.test_rendered = (_input, context) => runManagedRenderedTest(host.requireProject(), context.signal)
actions.test_matrix = (input, context) => runProjectTestMatrix(input.targets as TestTarget[], context.signal)
actions.test_minecraft = async (_input, context) => {
  const project = host.requireProject()
  if (project.kind === 'server-plugin') return localServerAgentOperation(project, { operation: 'start' }, context.signal)
  const result = await runHeadlessMinecraftSmoke(project, context.signal, { stableWindowMs: 20_000, offline: true })
  if (!result.success) throw new Error(result.message || 'HeadlessMC smoke test failed')
  return result
}
for (const category of ['session', 'observe', 'action', 'capture', 'scenario']) {
  actions[`test_${category}`] = (input, context) => playerTestService!.execute(host.requireProject(), category, input, context.signal)
}
actions.modpack_build_server = async input => {
  const project = host.requireProject()
  if (!isModpackProject(project)) throw new Error('current project is not a modpack')
  const outputDirectory = host.publicMcpOutputDirectory(project, input, path.join(project.path, '.modmind', 'server-pack'))
  const engine = (await readModpackManifest(project)).mods.length ? 'serverpackcreator' : 'internal'
  const javaPath = engine === 'serverpackcreator' ? await requireMinecraftRuntime().ensureJavaRuntime(undefined, SERVER_PACK_CREATOR_MIN_JAVA) : undefined
  return host.withMinecraftResourceLock(() => buildServerPack(project, { outputDirectory, port: typeof input.port === 'number' ? input.port : undefined, acceptEula: input.acceptEula !== false, includeUnknownSideMods: false, onlineMode: input.onlineMode !== false, engine, ...(javaPath ? { javaPath, cacheDirectory: path.join(app.getPath('userData'), 'server-pack-creator') } : {}) }))
}
actions.modpack_verify_server_join = async (input, context) => {
  const project = host.requireProject()
  if (!isModpackProject(project)) throw new Error('current project is not a modpack')
  context.signal?.throwIfAborted()
  const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
  const outputDirectory = host.publicMcpOutputDirectory(project, input, path.join(project.path, '.modmind', 'server-pack'))
  return host.withMinecraftResourceLock(() => managedServerJoin({ project, outputDirectory, port: typeof input.port === 'number' ? input.port : 25565, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, headless: requireHeadlessMc(), gameDirectory: path.join(project.path, '.modmind', 'headlessmc', 'server-join'), managedMinecraftDirectory: requireMinecraftRuntime().managedMinecraftDirectory(), onEvent: host.forwardMinecraftRuntimeEvent }))
}
actions.modpack_run_server_scenario = async input => {
  const project = host.requireProject()
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('server scenario requires at least one step')
  const steps = input.steps.map(step => {
    if (!step || typeof step !== 'object') throw new Error('invalid server scenario step')
    const value = step as Record<string, unknown>
    return { command: String(value.command ?? ''), expect: Array.isArray(value.expect) ? value.expect.map(String) : [], timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined }
  })
  const javaPath = await requireMinecraftRuntime().ensureJavaRuntime()
  const outputDirectory = host.publicMcpOutputDirectory(project, input, path.join(project.path, '.modmind', 'server-scenario'))
  return host.withMinecraftResourceLock(() => managedServerScenario({ project, outputDirectory, port: typeof input.port === 'number' ? input.port : 25565, acceptEula: input.acceptEula !== false, onlineMode: input.onlineMode === true, javaPath, steps, onEvent: host.forwardMinecraftRuntimeEvent }))
}
return { actions, buildServerPack, minecraftRuntime: minecraftRuntime!, localServerManager: localServerManager!, playerTestService: playerTestService!, localTestService: localTestService!, headlessMcService: headlessMcService!, syncCurrentKubeJsServerScripts, requireHeadlessMc, runHeadlessMinecraftSmoke, runManagedRenderedTest, runProjectTestMatrix, localServerAgentOperation, managedServerJoin, managedServerScenario,
isBusy: () => Boolean(localTestService?.isBusy() || localServerManager?.isBusy() || minecraftRuntime?.isBusy() || playerTestService?.isBusy() || headlessMcService?.isBusy()),
async dispose() {
  const results = await Promise.allSettled([playerTestService?.stop(), localTestService?.stop(), headlessMcService?.stop(), localServerManager?.destroy(), minecraftRuntime?.stop()])
  minecraftRuntime?.destroy()
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
},
async projectChanged(projectPath: string | null) { await playerTestService?.projectChanged(projectPath ?? undefined); serverEvidenceCursors.clear() }
}
}
