import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'
import { StudioRegistry, configureStudios } from './studioRegistry'
import { featureHostRuntime } from './featureHostRuntime'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { archiveEntries } from './archiveInspection'
import { createStoredZip } from './bedrockAddon'
import { bindShaderInstance } from '../../feature-plugins/studio-shader/src/main/shaderService'
import sharp from 'sharp'
import type { ProjectInfo } from '../shared/types'
import type { ShaderDocument, ShaderInventory, ShaderTestState } from '../shared/shaderStudio'
import { shaderRuntimeFixture } from './__fixtures__/shaderRuntimeFixture'
import { saveRuntimeBinding } from '../../feature-plugins/shader-shared/src/main/shaderRuntimeEnvironment'
import studioManifest from '../../feature-plugins/studio-shader/manifest.json'
import type { ShaderRuntimeSession } from '../shared/shaderStudio'

const modules = [
  { id: 'shader-source', page: 'shader-source', tools: ['modmind_shader_query', 'modmind_shader_edit'], query: 'modmind_shader_query' },
  { id: 'shader-options', page: 'shader-options', tools: ['modmind_shader_options_query', 'modmind_shader_options_edit'], query: 'modmind_shader_options_query' },
  { id: 'shader-preview', page: 'shader-preview', tools: ['modmind_shader_preview'], query: 'modmind_shader_preview' },
  { id: 'shader-testing', page: 'shader-test', tools: ['modmind_shader_test_query', 'modmind_shader_test', 'modmind_shader_session'], query: 'modmind_shader_test_query' },
  { id: 'shader-export', page: 'shader-export', tools: ['modmind_shader_validate', 'modmind_shader_export'], query: 'modmind_shader_validate' }
]
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

it('independently installs optional shader modules and verifies their actual MCP operations, removal, project scope and recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-shader-mcp-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  let current: ProjectInfo = { path: path.join(root, 'project'), name: 'Shader', kind: 'shader', studioId: 'minecraft-shader', loader: 'iris', minecraftVersion: '1.21.1', namespace: 'shader', createdAt: '' }
  let runtimeFixture: Awaited<ReturnType<typeof shaderRuntimeFixture>> | undefined
  const service = new FeaturePluginService(path.join(root, 'plugins'), {
    requireFrom: path.resolve('package.json'), capabilities: { runtime: featureHostRuntime, diagnosticsV1: true, studioV1: true },
    busy: () => false, changed: () => undefined, projectRoot: () => current.path, project: () => current,
    options: () => ({ stateDirectory: path.join(root, 'application-state'), sessionDependencies: { javaHomes: async () => runtimeFixture ? [{ home: runtimeFixture.javaHome, major: 25 }] : [] }, host: { requireProject: () => current, assertProjectMutationAllowed: () => undefined } })
  })
  await service.initialize(); cleanup.push(() => service.shutdown())
  const install = async (id: string, extension = 'mmfeature') => service.install(await prepareFeaturePlugin(path.resolve(`feature-plugin-dist/${id}.${extension}`)))
  await install('studio-shader', 'mmstudio')
  const registry = new StudioRegistry(() => service.catalog(), id => service.service(id), undefined, (id, action, input, context) => service.invoke(id, action, input, context)); configureStudios(registry)
  expect(registry.select(current).definition.name).toBe('光影工作台')
  expect(service.manifest('studio-shader')).toMatchObject({ version: studioManifest.version, views: [], actions: [], tools: [] })
  expect(service.tools('workbench', current)).toHaveLength(0)
  await fs.mkdir(current.path)
  await registry.scaffold(current, async files => { for (const [file, content] of Object.entries(files)) { const target = path.join(current.path, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content) } })
  const original = current
  const originalFinal = await fs.readFile(path.join(original.path, 'shaders/final.fsh'), 'utf8')
  const originalOptions = await fs.readFile(path.join(original.path, 'shaders/lib/options.glsl'), 'utf8')
  const unsupported = async () => { throw new Error('Not used by shader test') }
  const handlers: ExternalAgentBridgeHandlers = {
    setIntent: unsupported, applyEdits: unsupported, updateTodo: unsupported, testMatrix: unsupported, build: unsupported, testMinecraft: unsupported, runtimeState: unsupported,
    projectInfo: { ...current },
    featureCatalog: async () => service.catalog(), featureTools: async (surface: 'workbench' | 'inspiration') => service.tools(surface, current),
    featureInvoke: (id: string, action: string, input: Record<string, unknown>, context: object) => service.invoke(id, action, input, context),
    reviewAction: async () => ({ approved: true, complete: true, risk: 'low', feedback: 'QA fixture', dangerousOperations: [] })
  }
  const connect = async (readOnly: boolean) => {
    const bridge = new ModMindBridge(original, handlers, 'test', undefined, readOnly); cleanup.push(() => bridge.stop())
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child: ChildProcessWithoutNullStreams = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    cleanup.push(async () => { if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() }) })
    let sequence = 0, buffer = ''
    const pending = new Map<number, (value: any) => void>()
    child.stdout.on('data', chunk => { buffer += chunk; let newline: number; while ((newline = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); pending.get(value.id)?.(value); pending.delete(value.id) } })
    return (method: string, params?: object): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Shader MCP timeout')) }, 10000)
      pending.set(id, value => { clearTimeout(timer); resolve(value) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const rpc = await connect(false)
  const toolNames = async () => (await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('modmind_shader_')).sort()
  const call = async (name: string, input: object = {}) => (await rpc('tools/call', { name, arguments: input })).result
  const readResult = <T>(result: any): T => { expect(result.isError, JSON.stringify(result)).toBeUndefined(); return JSON.parse(result.content[0].text) as T }
  expect(await toolNames()).toEqual([])
  for (const module of modules) expect((await call(module.query, { operation: 'inventory' })).isError).toBe(true)
  await expect(registry.invokeTask(original, 'check', {}, { projectPath: original.path, surface: 'workbench' })).rejects.toThrow()

  const game = path.join(root, 'game')
  await fs.mkdir(path.join(game, 'mods'), { recursive: true }); await fs.mkdir(path.join(game, 'screenshots')); await fs.mkdir(path.join(game, 'logs'))
  await fs.writeFile(path.join(game, 'mods/iris.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"id":"iris"}') }]))
  await fs.writeFile(path.join(game, 'logs/latest.log'), 'old unrelated log\n')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#447755' } }).png().toFile(path.join(game, 'screenshots/qa-fixture.png'))
  // This fixture represents the user's instance selection. MCP cannot choose an arbitrary game directory.
  await bindShaderInstance(original, game)

  for (const module of modules) {
    await install(module.id)
    expect(service.manifest(module.id)?.dependencies).toEqual(['studio-shader'])
    expect(service.manifest(module.id)?.views?.map(view => view.id)).toEqual([module.page])
    expect(await toolNames()).toEqual([...module.tools].sort())
    const inventory = readResult<ShaderInventory>(await call(module.query, { operation: 'inventory' }))
    expect(inventory.files.some(file => file.path === 'shaders/final.fsh')).toBe(true)
    if (module.id === 'shader-source') {
      const document = readResult<ShaderDocument>(await call(module.query, { operation: 'read', path: 'shaders/final.fsh' }))
      const edited = readResult<ShaderDocument>(await call('modmind_shader_edit', { operation: 'save', path: document.path, content: document.content + '\n// MCP independent source module\n', revision: document.revision }))
      expect(edited.content).toContain('MCP independent source module')
      expect(readResult<ShaderDocument>(await call(module.query, { operation: 'read', path: document.path })).content).toBe(edited.content)
      expect((await call('modmind_shader_edit', { operation: 'save', path: document.path, content: document.content, revision: document.revision })).isError).toBe(true)
      readResult(await call('modmind_shader_edit', { operation: 'undo' }))
      expect(await fs.readFile(path.join(original.path, document.path), 'utf8')).toBe(originalFinal)
      expect((await call(module.query, { operation: 'read', path: 'shaders/../../outside.glsl' })).isError).toBe(true)
      expect((await call(module.query, { operation: 'validate' })).isError).toBe(true)
      expect((await call('modmind_shader_edit', { operation: 'options', revision: inventory.revision, values: { EXPOSURE: '1.5' } })).isError).toBe(true)
    } else if (module.id === 'shader-options') {
      const edited = readResult<ShaderInventory>(await call('modmind_shader_options_edit', { operation: 'options', revision: inventory.revision, values: { EXPOSURE: '1.5' } }))
      expect(edited.options.find(option => option.name === 'EXPOSURE')?.value).toBe('1.5')
      expect(readResult<ShaderInventory>(await call(module.query, { operation: 'inventory' })).options.find(option => option.name === 'EXPOSURE')?.value).toBe('1.5')
      expect(await fs.readFile(path.join(original.path, 'shaders/lib/options.glsl'), 'utf8')).toContain('#define EXPOSURE 1.5')
      expect((await call('modmind_shader_options_edit', { operation: 'options', revision: inventory.revision, values: { EXPOSURE: '1.0' } })).isError).toBe(true)
      readResult(await call('modmind_shader_options_edit', { operation: 'undo' }))
      expect(await fs.readFile(path.join(original.path, 'shaders/lib/options.glsl'), 'utf8')).toBe(originalOptions)
      expect((await call(module.query, { operation: 'read', path: 'shaders/final.fsh' })).isError).toBe(true)
      const propertiesFile = path.join(original.path, 'shaders/shaders.properties'), savedProperties = await fs.readFile(propertiesFile, 'utf8')
      const extended = originalOptions + '\n#ifndef MCP_GUARD\n#define MCP_GUARD\n#define TAA\nconst int shadowMapResolution = 3072; // [1024 3072 4096]\n#ifdef TAA\n#endif\n#endif\n'
      await fs.writeFile(path.join(original.path, 'shaders/lib/options.glsl'), extended)
      await fs.writeFile(propertiesFile, savedProperties + '\nprofile.BASE=TAA EXPOSURE=1.0\nprofile.QUALITY=profile.BASE !TAA shadowMapResolution=4096 !program.final\n')
      const profile = readResult<ShaderInventory>(await call(module.query, { operation: 'inventory' }))
      expect(profile.profiles.QUALITY).toMatchObject({ TAA: 'false', shadowMapResolution: '4096' })
      expect(profile.options.some(option => option.name === 'MCP_GUARD')).toBe(false)
      const applied = readResult<ShaderInventory>(await call('modmind_shader_options_edit', { operation: 'options', revision: profile.revision, values: profile.profiles.QUALITY, programValues: profile.profilePrograms.QUALITY }))
      expect(applied.programConditions.final).toBe('false')
      const readback = readResult<ShaderInventory>(await call(module.query, { operation: 'inventory' }))
      expect(readback.options.find(option => option.name === 'shadowMapResolution')?.value).toBe('4096')
      expect(await fs.readFile(propertiesFile, 'utf8')).toContain('program.final.enabled=false')
      expect((await call('modmind_shader_options_edit', { operation: 'options', revision: applied.revision, values: {}, programValues: { '../escape': false } })).isError).toBe(true)
      readResult(await call('modmind_shader_options_edit', { operation: 'undo' }))
      expect(await fs.readFile(path.join(original.path, 'shaders/lib/options.glsl'), 'utf8')).toBe(extended)
      await fs.writeFile(path.join(original.path, 'shaders/lib/options.glsl'), originalOptions)
      await fs.writeFile(propertiesFile, savedProperties)
    } else if (module.id === 'shader-preview') {
      const preview = readResult<{ source: string; files: string[]; gameVerified: boolean }>(await call(module.query, { operation: 'preview' }))
      expect(preview.source).toContain('void main'); expect(preview.files).toContain('shaders/final.fsh'); expect(preview.gameVerified).toBe(false)
      expect((await call(module.query, { operation: 'preview-image' })).isError).toBe(true)
    } else if (module.id === 'shader-testing') {
      expect((await call('modmind_shader_test', { operation: 'bind' })).isError).toBe(true)
      expect((await call('modmind_shader_test', { operation: 'bind-runtime' })).isError).toBe(true)
      expect(readResult(await call(module.query, { operation: 'capabilities' }))).toMatchObject({ supported: false, ready: false, runtimeVerified: false })
      expect(readResult(await call(module.query, { operation: 'session-state' }))).toBeNull()
      expect((await call('modmind_shader_session', { operation: 'start', versionId: '../escape' })).isError).toBe(true)
      const deployed = readResult<ShaderTestState>(await call('modmind_shader_test', { operation: 'deploy' }))
      expect(deployed.irisDetected).toBe(true); expect(deployed.log?.packMentioned).toBe(false)
      expect(await archiveEntries(deployed.deployed!.path)).toContain('shaders/final.fsh')
      await fs.appendFile(path.join(game, 'logs/latest.log'), `QA fixture selected ${path.basename(deployed.deployed!.path)}\nIris shader error QA fixture\n`)
      const evidence = await call(module.query, { operation: 'test-state' })
      expect(readResult<ShaderTestState>(evidence).log).toMatchObject({ fresh: true, packMentioned: true, issues: ['Iris shader error QA fixture'] })
      expect(evidence.content.some((item: { type: string }) => item.type === 'image')).toBe(true)
      expect(evidence.content[0].text).toContain('qa-fixture.png')
      runtimeFixture = await shaderRuntimeFixture(path.join(root, 'jvm-fixture'))
      current = { ...original, minecraftVersion: '26.2' }
      await saveRuntimeBinding(path.join(root, 'application-state/shader-testing/bindings'), current, runtimeFixture)
      expect(readResult(await call(module.query, { operation: 'capabilities' }))).toMatchObject({ ready: true, runtimeVerified: false })
      const started = readResult<ShaderRuntimeSession>(await call('modmind_shader_session', { operation: 'start', versionId: runtimeFixture.versionId }))
      expect(started.status).toBe('preparing')
      let owned: ShaderRuntimeSession = started
      for (let attempt = 0; attempt < 150 && !['ready', 'failed', 'stopped'].includes(owned.status); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        owned = readResult<ShaderRuntimeSession>(await call(module.query, { operation: 'session-state', sessionId: started.sessionId }))
      }
      expect(owned, JSON.stringify(owned)).toMatchObject({ status: 'ready', gameVerified: false })
      const observed = readResult<ShaderRuntimeSession>(await call(module.query, { operation: 'observe', sessionId: started.sessionId }))
      expect(observed.observation?.packName).toBe(observed.artifact?.name)
      expect(observed.observation?.effectiveOptions.TAA).toBe('true')
      const reloaded = readResult<ShaderRuntimeSession>(await call('modmind_shader_session', { operation: 'reload', sessionId: started.sessionId }))
      expect(reloaded.observation?.profile).toBe('jvm-fixture')
      expect((await call('modmind_shader_session', { operation: 'stop', sessionId: '0'.repeat(36) })).isError).toBe(true)
      expect(readResult(await call('modmind_shader_session', { operation: 'stop', sessionId: started.sessionId }))).toMatchObject({ status: 'stopped', shutdown: 'graceful' })
      current = original
    } else {
      expect(readResult(await call(module.query, { operation: 'validate' }))).toMatchObject({ status: 'syntax-checked', gameVerified: false })
      const artifact = readResult<{ path: string; status: string }>(await call('modmind_shader_export'))
      expect(artifact.status).toBe('exported')
      const entries = await archiveEntries(artifact.path)
      expect(entries).toContain('shaders/final.fsh'); expect(entries.some(entry => entry.startsWith('.modmind/') || entry === 'modmind.project.json')).toBe(false)
      expect(await registry.invokeTask(original, 'check', {}, { projectPath: original.path, surface: 'workbench' })).toMatchObject({ status: 'syntax-checked', gameVerified: false })
    }
    await service.setEnabled(module.id, false)
    expect(await toolNames()).toEqual([])
    expect((await call(module.query, { operation: 'inventory' })).isError).toBe(true)
    await expect(service.invoke(module.id, 'query', { operation: 'inventory' }, { projectPath: current.path })).rejects.toThrow('UNAVAILABLE')
  }

  for (const module of modules) await service.setEnabled(module.id, true)
  expect(await toolNames()).toEqual(modules.flatMap(module => module.tools).sort())
  const inspiration = await connect(true)
  const readonlyTools = (await inspiration('tools/list')).result.tools.map((tool: { name: string }) => tool.name)
  for (const module of modules) expect(readonlyTools).toContain(module.query)
  for (const name of ['modmind_shader_edit', 'modmind_shader_options_edit', 'modmind_shader_test', 'modmind_shader_session', 'modmind_shader_export']) {
    expect(readonlyTools).not.toContain(name)
    const readonly = await inspiration('tools/call', { name, arguments: name.endsWith('_test') ? { operation: 'deploy' } : name.endsWith('_session') ? { operation: 'start', versionId: 'fixture' } : name.endsWith('_export') ? {} : { operation: 'undo' } })
    expect(readonly.result.isError).toBe(true)
  }
  await expect(service.invoke('shader-options', 'edit', { operation: 'undo' }, { readOnly: true, projectPath: current.path })).rejects.toThrow('READ_ONLY')
  await expect(service.invoke('shader-source', 'query', { operation: 'inventory', projectPath: 'wrong' }, { projectPath: current.path })).rejects.toThrow('已切换')
  const persisted = await fs.readFile(path.join(original.path, 'shaders/final.fsh'), 'utf8')
  for (const target of [
    { kind: 'mod', studioId: 'minecraft-mod', loader: 'fabric' },
    { kind: 'modpack', studioId: 'minecraft-modpack', loader: 'fabric' },
    { kind: 'server-plugin', studioId: 'minecraft-server-plugin', loader: 'paper' }
  ] as const) {
    current = { ...original, ...target, path: path.join(root, target.kind) }
    expect(await toolNames()).toEqual([])
    for (const module of modules) await expect(service.invoke(module.id, 'query', { operation: 'inventory' }, { projectPath: current.path })).rejects.toThrow('STUDIO_MISMATCH')
  }
  current = original
  for (const module of modules) {
    const otherNames = (await toolNames()).filter((name: string) => !module.tools.includes(name))
    await service.setEnabled(module.id, false)
    expect(await toolNames()).toEqual(otherNames)
    expect((await call(module.query, { operation: 'inventory' })).isError).toBe(true)
    await service.uninstall(module.id)
    expect(await toolNames()).toEqual(otherNames)
    expect((await call(module.query, { operation: 'inventory' })).isError).toBe(true)
    expect(await fs.readFile(path.join(original.path, 'shaders/final.fsh'), 'utf8')).toBe(persisted)
    expect(await fs.readFile(path.join(original.path, 'shaders/lib/options.glsl'), 'utf8')).toBe(originalOptions)
  }
  await service.setEnabled('studio-shader', false)
  expect(registry.resolve(original)?.available).toBe(false)
  expect(await fs.readFile(path.join(original.path, 'shaders/final.fsh'), 'utf8')).toBe(persisted)
  await service.setEnabled('studio-shader', true)
  expect(registry.select(original).definition.name).toBe('光影工作台')
  await install('shader-source')
  expect(readResult<ShaderDocument>(await call('modmind_shader_query', { operation: 'read', path: 'shaders/final.fsh' })).content).toBe(persisted)
}, 60000)
