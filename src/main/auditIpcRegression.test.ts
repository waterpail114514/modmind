import { readFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitWithAbort } from './asyncControl'
import { BackendSwitchCoordinator } from './backendSwitchCoordinator'
import { restoreManagedPathsFromSnapshot } from './agentCore'
import { scopedFilePath } from './scopedFilePath'

// Extract the actual declaration/callback without importing Electron's startup
// module. Only its external collaborators are replaced; its control flow stays
// exactly as shipped. Running this file in the baseline copy tests old code.
const source = ts.createSourceFile('index.ts', readFileSync(path.resolve('src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
function original(name: string, dependencies: Record<string, unknown>, channel: boolean | 'property' = false): { call: (...args: any[]) => any; state: Record<string, any> } {
  let selected: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (!channel && ts.isFunctionDeclaration(node) && node.name?.text === name) selected = node
    if (channel && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'diagnosticHandle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) selected = node.arguments[1]
    if (channel === 'property' && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) selected = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!selected) throw new Error(`Missing production entry: ${name}`)
  const state = vm.createContext({ Buffer, AbortController, AbortSignal, Error, AggregateError, URL, setTimeout, clearTimeout, process: { platform: process.platform }, path, os, createHash, randomUUID, awaitWithAbort, ...dependencies })
  const code = ts.transpileModule(`(${selected.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return { call: vm.runInContext(code, state, { filename: `production-${name}.js` }), state }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const roots: string[] = []
async function temporary() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ipc-audit-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); vi.restoreAllMocks() })

describe('production IPC audit regressions', () => {
  function preparation(prepareCodex: (...args: any[]) => Promise<unknown>) {
    return original('prepareManagedCodex', {
      managedCodexHome: () => 'isolated-codex-home', migrateLegacyManagedCodexSessions: async () => {}, quotaConfiguration: { current: () => ({ sequence: 1 }) },
      managedCodexPreparations: new Map(), managedCodexPreparationUsers: new Map(), managedCodexPreparationListeners: new Map(), managedCodexPreparationTail: Promise.resolve(),
      resolveModelContextBudget: () => ({ source: 'known' }), diagnosticJournal: { record: vi.fn() }, prepareCodex,
      app: { getPath: () => 'isolated-user-data' }, chatCompletionsAdapter: { baseUrl: async () => 'http://127.0.0.1/adapter' },
      codexProviderIdentity: () => 'fixture', bundledCodexSkillsDirectory: () => undefined, workbenchSkillNames: () => []
    })
  }
  const config = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'fixture' }

  it('AUD005 stops the underlying preparation only after the last shared caller cancels', async () => {
    const started = deferred<any>(), finished = deferred<any>()
    const prepare = vi.fn(async options => { started.resolve(options); return finished.promise })
    const { call, state } = preparation(prepare)
    const first = new AbortController(), second = new AbortController()
    const a = call({}, 'scope', config, 'device', undefined, undefined, first.signal)
    const b = call({}, 'scope', config, 'device', undefined, undefined, second.signal)
    const aFailure = expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const bFailure = expect(b).rejects.toMatchObject({ name: 'AbortError' })
    const options = await started.promise
    try {
      first.abort(); await aFailure
      const afterFirst = options.signal?.aborted
      second.abort(); await bFailure
      expect(afterFirst).toBe(false)
      expect(options.signal?.aborted).toBe(true)
      expect(prepare).toHaveBeenCalledOnce()
    } finally { finished.resolve({ executable: 'fixture' }); await finished.promise }
    await vi.waitFor(() => expect(state.managedCodexPreparations.size).toBe(0))
  })

  it('AUD005 keeps another subscriber alive when one caller stops', async () => {
    const started = deferred<any>(), finished = deferred<any>()
    const prepare = vi.fn(async options => { started.resolve(options); return finished.promise })
    const { call } = preparation(prepare)
    const controller = new AbortController()
    const a = call({}, 'scope', config, 'device', undefined, undefined, controller.signal)
    const aFailure = expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const b = call({}, 'scope', config, 'device')
    const options = await started.promise; controller.abort(); await aFailure
    try { expect(options.signal?.aborted).toBe(false) }
    finally { finished.resolve({ executable: 'fixture' }) }
    await expect(b).resolves.toMatchObject({ executable: 'fixture' }); expect(prepare).toHaveBeenCalledOnce()
  })

  function switchBackend(recovery: boolean) {
    const ready = deferred(), entered = deferred()
    let settings: any = { codingBackend: 'quota', notificationsEnabled: false, marker: 'before' }
    const deps = {
      requireProject: () => ({ path: '/isolated/project' }), activeWorkspaceRun: () => null, aiProjectKey: (value: string) => value,
      aiBackendSwitchCoordinator: new BackendSwitchCoordinator(), activeAiBackendSwitches: new Map(), AI_BACKEND_START_TIMEOUT_MS: 60_000,
      readSettings: async () => structuredClone(settings), assertBackendSwitchTargetReady: async () => { entered.resolve(); await ready.promise },
      abortWorkspaceRuns: vi.fn(), waitForWorkspaceRunsToStop: async () => {},
      readActiveAiTask: async () => recovery ? { taskId: 'task', sessionScope: 'scope', prompt: 'continue', startedAt: 'now' } : null,
      saveAgentSettings: vi.fn(async (input: any) => { settings = typeof input === 'function' ? input(settings) : input; return settings }),
      aiRunId: () => 'run', withAiRun: async (_run: unknown, _controller: unknown, run: () => Promise<unknown>) => run(),
      runExternalCodingAgent: async () => { settings = { ...settings, notificationsEnabled: true, marker: 'concurrent' }; throw new Error('fixture startup failure') },
      writeActiveAiTask: vi.fn(), describeAgentRunError: (error: Error) => error.message, isRecoverableAgentRunError: () => true, sendAiOutput: vi.fn()
    }
    const { call } = original('ai:switchBackend', deps, true)
    return { call, ready, entered, settings: () => settings, edit: () => { settings = { ...settings, notificationsEnabled: true, marker: 'concurrent' } } }
  }

  it('AUD034 preserves a concurrent setting while an idle backend switch waits for readiness', async () => {
    const fixture = switchBackend(false)
    const result = fixture.call({ sender: { id: 1 } }, 'codex')
    await fixture.entered.promise; fixture.edit(); fixture.ready.resolve()
    await expect(result).resolves.toMatchObject({ status: 'idle' })
    expect(fixture.settings()).toMatchObject({ codingBackend: 'codex', notificationsEnabled: true, marker: 'concurrent' })
  })

  it('AUD034 rolls back only the backend if startup fails after another setting changes', async () => {
    const fixture = switchBackend(true)
    const result = fixture.call({ sender: { id: 1 } }, 'codex')
    const failure = expect(result).rejects.toThrow('fixture startup failure')
    await fixture.entered.promise; fixture.ready.resolve(); await failure
    expect(fixture.settings()).toMatchObject({ codingBackend: 'quota', notificationsEnabled: true, marker: 'concurrent' })
  })

  it.each(['app-setting', 'remote-agent', 'remote-model'])('AUD034 preserves queued concurrent changes at the %s entry', async entry => {
    let settings: any = { codingBackend: 'codex', notificationsEnabled: false, darkMode: false, marker: 'old', externalAgents: { codex: { model: 'old', apiKey: 'old' } } }
    const deps = {
      activeAiRuns: new Map(), readSettings: async () => structuredClone(settings), APP_SETTING_KEYS: ['darkMode', 'notificationsEnabled'],
      saveAgentSettings: async (input: any) => {
        // Another accepted write finishes while this operation is queued.
        settings = { ...settings, marker: 'new', externalAgents: { codex: { model: 'old', apiKey: 'new' } } }
        settings = typeof input === 'function' ? input(settings) : input
        return settings
      }
    }
    if (entry === 'app-setting') await original('applyAppSettingWrite', deps).call({ key: 'darkMode', value: true })
    else await original('executeRemoteAppAction', deps).call(entry === 'remote-agent' ? { type: 'set_workbench_agent', agent: 'quota' } : { type: 'set_workbench_model', model: 'chosen' })
    expect(settings.marker).toBe('new')
    expect(settings.externalAgents.codex.apiKey).toBe('new')
    if (entry === 'remote-model') expect(settings.externalAgents.codex.model).toBe('chosen')
  })

  it.each(['missing', 'hash'] as const)('AUD017 leaves current files and the AI checkpoint intact when backup validation fails: %s', async fault => {
    const root = await temporary(), snapshotRoot = path.join(root, '.modmind/snapshots/checkpoint/files')
    await fs.mkdir(snapshotRoot, { recursive: true }); await fs.writeFile(path.join(root, 'keep.txt'), 'current user data')
    if (fault === 'hash') await fs.writeFile(path.join(snapshotRoot, 'keep.txt'), 'damaged backup')
    const project = { path: root }, active = { taskId: 'task', snapshotId: 'checkpoint', changedFiles: ['keep.txt'] }
    const clear = vi.fn()
    const { call } = original('restoreAiRecovery', {
      requireProject: () => project, readActiveAiTask: async () => active, getAiRecoveryInfo: async () => ({ snapshot: { id: 'checkpoint' } }),
      readSnapshotManifest: async () => ({ manifest: { files: ['keep.txt'], hashes: { 'keep.txt': createHash('sha256').update('good backup').digest('hex') } } }),
      createProjectSnapshot: async () => ({ id: 'automatic-backup' }), projectDataDirectory: () => '.modmind', restoreManagedPathsFromSnapshot,
      clearActiveAiTask: clear, diagnosticJournal: { record: vi.fn() }
    })
    await expect(call()).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('current user data')
    expect(clear).not.toHaveBeenCalled()
  })

  it('AUD017 retains direct-migration rollback files after both commit and rollback fail', async () => {
    const root = await temporary(), target = path.join(root, 'project'), staging = path.join(root, 'staging')
    await fs.mkdir(target); await fs.mkdir(staging); await fs.writeFile(path.join(target, 'keep.txt'), 'before')
    const project = { path: target, kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1' }
    const rollbackRoot = path.join(staging, 'rollback')
    const { call } = original('applyModpackMigrationInPlace', {
      assertProjectSwitchAllowed: () => {}, assertProjectMutationAllowed: () => {}, currentProjectManifest: 'modmind.project.json', currentProject: project,
      fs: { ...fs, mkdtemp: async () => staging }, ignoreSnapshotDirectory: () => false,
      copySnapshotFiles: async (_from: string, to: string) => { await fs.mkdir(to); await fs.copyFile(path.join(target, 'keep.txt'), path.join(to, 'keep.txt')) },
      listSnapshotManagedFiles: async (directory: string) => directory === rollbackRoot ? ['keep.txt'] : ['modmind.project.json', 'modmind.pack.json'],
      preserveDirectMigrationSources: async () => {}, requireModProviderRegistry: () => ({}), copyBundledGradleWrapper: () => {}, mcmodService: {},
      createModpackMigration: async (_registry: unknown, _project: unknown, _target: unknown, _input: unknown, destination: string) => { await fs.mkdir(destination); return { project, reportPath: path.join(destination, 'report.md') } },
      restoreSnapshotFilesExact: vi.fn(async () => { throw new Error('fixture disk failure') }), modpackMigrationDirectory: () => path.join(root, 'migration-record'), emitProjectChanged: () => {}
    })
    const failure = await call(project, { loader: 'fabric', minecraftVersion: '1.21.1' }, { mode: 'direct' }).catch((error: Error) => error)
    expect(await fs.readFile(path.join(rollbackRoot, 'keep.txt'), 'utf8').catch(() => null)).toBe('before')
    expect(failure.message).toContain('恢复文件已保留')
  })

  it('keeps existing cleanup behavior when decompiled project seeding fails', async () => {
    const destination = await temporary(), projectPath = path.join(destination, 'created-project')
    const { call, state } = original('decompile:createProjectFromJar', {
      runDiagnosticOperation: (_subsystem: unknown, _operation: unknown, _label: unknown, work: () => unknown) => work(), assertProjectSwitchAllowed: () => {},
      DECOMPILE_TERMS_VERSION: 'fixture', isJavaLoader: () => true, isServerPluginPlatform: () => false,
      readDecompileProvenanceForExport: async () => ({ sourceFileName: 'fixture.jar', sourceSha256: 'a'.repeat(64) }), decompileCacheRoot: () => path.join(destination, 'cache'),
      validateDecompiledProjectTarget: () => {}, validateProjectNameInput: (name: string) => name, requireLoaderCatalog: () => ({ resolve: async () => ({ javaVersion: 21 }) }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [destination] }) }, mainWindow: {}, slugify: () => 'created-project', pathExists: async () => false,
      CURRENT_PROJECT_VERSION: '1.4.19', fs, currentProject: { path: 'previous-project' }, writeProjectTemplate: async () => { await fs.mkdir(projectPath, { recursive: true }); await fs.writeFile(path.join(projectPath, 'partial.txt'), 'partial') },
      seedProjectFromDecompiledSources: async () => { throw new Error('fixture seed failure') }, rememberRecentProject: vi.fn(), refreshExternalAgentContext: async () => {}, emitProjectChanged: vi.fn()
    }, true)
    await expect(call({}, { sourceSha256: 'a'.repeat(64), termsAcknowledgement: { termsVersion: 'fixture', acknowledged: true }, loader: 'fabric', name: 'Created', minecraftVersion: '1.21.1' })).rejects.toThrow('fixture seed failure')
    expect(await fs.stat(projectPath).catch(() => null)).toBeNull()
    expect(state.currentProject.path).toBe('previous-project')
  })

  it('AUD066 rejects duplicate JAR starts while cancellation still reaches the active controller', async () => {
    const root = await temporary(), jar = path.join(root, 'fixture.jar'), calls: Array<{ signal: AbortSignal; done: ReturnType<typeof deferred<void>> }> = []
    const activeDecompileRuns = new Map()
    const deps = {
      activeDecompileRuns, runDiagnosticOperation: (_domain: string, _operation: string, _label: string, work: () => unknown) => work(),
      requireMinecraftRuntime: () => ({ ensureJavaRuntimeForTools: async () => 'fixture-java' }), DECOMPILE_MIN_JAVA: 21,
      decompileCacheRoot: () => path.join(root, 'cache'), sendDecompileEvent: vi.fn(), diagnosticJournal: { record: vi.fn() }, redactDiagnosticText: (text: string) => text,
      runDecompilation: async (_request: unknown, options: { signal: AbortSignal }) => { const done = deferred(); calls.push({ signal: options.signal, done }); return done.promise }
    }
    const start = original('decompile:start', deps, true).call, cancel = original('decompile:cancel', deps, true).call
    const first = start({}, { jarPath: jar })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const duplicate = start({}, { jarPath: path.join(root, '.', 'fixture.jar') })
    const observedDuplicate = duplicate.then(() => 'completed', (error: Error) => error.message)
    try {
      const result = await Promise.race([observedDuplicate, new Promise<string>(resolve => setTimeout(() => resolve('still-running'), 50))])
      expect(cancel({}, jar)).toBe(true)
      expect(calls[0].signal.aborted).toBe(true)
      expect(result).toContain('正在反编译')
      expect(calls).toHaveLength(1)
    } finally { for (const item of calls) item.done.resolve(); await first; await observedDuplicate }
    expect(activeDecompileRuns.size).toBe(0)
    expect(cancel({}, jar)).toBe(false)
  })

  it('AUD033 forwards image cancellation into the generation service and hosted lease request', async () => {
    const controller = new AbortController(), started = deferred<AbortSignal>()
    const generate = vi.fn(async (_input, _source, signal) => { expect(signal).toBe(controller.signal); return { assets: [] } })
    const { call } = original('generateStudioImage', { requireImageStudio: () => ({ generate }), runDiagnosticOperation: (_domain: string, _op: string, _label: string, work: () => unknown) => work() })
    await call({ prompt: 'fixture' }, 'agent', controller.signal)
    const lease = original('createHostedImageLease', {
      readDeviceCredentials: async () => ({ provider: 'hosted', fixture: true }), sameDeviceCredentials: () => true,
      requestDeviceImageLease: async (_credentials: unknown, signal: AbortSignal) => { started.resolve(signal); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return {} }
    })
    const pending = lease.call({ count: 2 }, controller.signal), failure = expect(pending).rejects.toThrow()
    const actualSignal = await started.promise; controller.abort(); await failure; expect(actualSignal.aborted).toBe(true)
  })

  it('AUD033/041 saves already paid images when a later batch is cancelled', async () => {
    const root = await temporary(), controller = new AbortController()
    const data = Buffer.from('completed paid image bytes')
    const generateStudioImage = vi.fn(async (_input, _source, signal) => {
      expect(signal).toBe(controller.signal); controller.abort()
      return { jobId: 'paid-job', assets: [{ dataUrl: `data:image/png;base64,${data.toString('base64')}` }], credits: 1, error: 'second image cancelled' }
    })
    const { call } = original('imageGenerate', { project: { path: root }, signal: controller.signal, generateStudioImage, fs, scopedFilePath }, 'property')
    const result = await call({ count: 2 })
    expect(result).toMatchObject({ success: false, cancelled: true, credits: 1, error: 'second image cancelled', files: ['.modmind/image-studio/generated/paid-job-1.png'] })
    expect(await fs.readFile(path.join(root, result.files[0]))).toEqual(data)
    expect(generateStudioImage).toHaveBeenCalledTimes(1)
  })

  it('AUD033 rejects pre-cancelled image work before any remote generation', async () => {
    const root = await temporary(), controller = new AbortController(); controller.abort()
    const generateStudioImage = vi.fn(async () => ({ jobId: 'unused', assets: [] }))
    const { call } = original('imageGenerate', { project: { path: root }, signal: controller.signal, generateStudioImage, fs, scopedFilePath }, 'property')
    await expect(call({})).rejects.toThrow()
    expect(generateStudioImage).not.toHaveBeenCalled()
  })

  it('image result rejects escaped project metadata before paid generation', async () => {
    const root = await temporary(), projectRoot = path.join(root, 'project'), generateStudioImage = vi.fn(async () => ({ jobId: 'unused', assets: [] }))
    await fs.mkdir(projectRoot)
    const { call } = original('imageGenerate', { project: { path: projectRoot, toolDataDirectory: '../outside' }, signal: undefined, generateStudioImage, fs, scopedFilePath }, 'property')
    await expect(call({})).rejects.toThrow('Unsafe scoped path')
    expect(generateStudioImage).not.toHaveBeenCalled()
  })

  it('image result preserves a linked output leaf without writing its outside target', async () => {
    const root = await temporary(), projectRoot = path.join(root, 'project'), outside = path.join(root, 'outside.png')
    const directory = path.join(projectRoot, '.modmind/image-studio/generated')
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(outside, 'retained outside')
    await fs.link(outside, path.join(directory, 'paid-job-1.png'))
    const generateStudioImage = async () => ({ jobId: 'paid-job', assets: [{ dataUrl: 'data:image/png;base64,bmV3' }] })
    const { call } = original('imageGenerate', { project: { path: projectRoot }, signal: undefined, generateStudioImage, fs, scopedFilePath }, 'property')
    await expect(call({})).rejects.toThrow('Scoped path crosses a link')
    expect(await fs.readFile(outside, 'utf8')).toBe('retained outside')
  })
})
