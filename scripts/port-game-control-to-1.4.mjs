import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import ts from 'typescript'

// Narrow backport, preserving the target branch's unrelated working changes.
const sourceRoot = process.cwd(), target = path.resolve(process.argv[2] || 'D:/Codex/UserData/worktrees/modmind-1-4-14/modmind')
if (execFileSync('git', ['branch', '--show-current'], { cwd: target, encoding: 'utf8' }).trim() !== '1.4') throw new Error('Expected the existing 1.4 checkout')
const backup = path.join(target, 'test-results/game-control-port-baseline', String(Date.now())); await fs.mkdir(backup, { recursive: true })
const manifest = []
async function save(relative, content) {
  const file = path.resolve(target, relative)
  if (!file.startsWith(target + path.sep)) throw new Error('Backport target escaped checkout')
  const previous = await fs.readFile(file).catch(() => undefined)
  if (previous?.equals(Buffer.isBuffer(content) ? content : Buffer.from(content))) return
  if (previous) { const saved = path.join(backup, relative); await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.writeFile(saved, previous) }
  manifest.push({ path: relative, before: previous ? createHash('sha256').update(previous).digest('hex') : null, after: createHash('sha256').update(content).digest('hex') })
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' })
    for (let attempt = 0;; attempt++) {
      try { await fs.rename(temporary, file); break }
      catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 50)) }
    }
  } finally { await fs.rm(temporary, { force: true }) }
}
const read = relative => fs.readFile(path.join(target, relative), 'utf8').then(text => text.replaceAll('\r\n', '\n'))
function once(text, before, after) { if (text.split(before).length !== 2) throw new Error('Ambiguous/missing backport anchor: ' + before.slice(0, 100)); return text.replace(before, after) }
function method(text, className, memberName, change) {
  const file = ts.createSourceFile('backport.ts', text, ts.ScriptTarget.Latest, true)
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const member = declaration?.members.find(node => node.name?.getText(file) === memberName)
  if (!member) throw new Error('Missing backport method ' + memberName)
  return text.slice(0, member.getStart(file)) + change(member.getText(file)) + text.slice(member.getEnd())
}
const flatten = text => text.replaceAll('../../../../src/shared/', '../shared/').replaceAll('../../../../src/main/', './')
for (const name of ['gameControlSession', 'gameControlActions', 'backgroundMinecraftTestService', 'legacyForgeJavaCompatibility']) await save(`src/main/${name}.ts`, flatten(await fs.readFile(`feature-plugins/testing/src/main/${name}.ts`, 'utf8')))
await save('src/main/legacyForgeJavaCompatibilityArtifact.json', await fs.readFile('feature-plugins/testing/src/main/legacyForgeJavaCompatibilityArtifact.json'))
await save('src/main/gameControlAgent.json', await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json'))
await save('src/shared/gameControl.ts', await fs.readFile('src/shared/gameControl.ts'))
await save('src/shared/gameControlValidation.test.ts', await fs.readFile('src/shared/gameControlValidation.test.ts'))
for (const entry of await fs.readdir('resources/game-control')) await save('resources/game-control/' + entry, await fs.readFile(path.join('resources/game-control', entry)))
await save('scripts/compile-game-control-agent.mjs', (await fs.readFile('scripts/compile-game-control-agent.mjs', 'utf8')).replaceAll('feature-plugins/testing/src/main/gameControlAgent.json', 'src/main/gameControlAgent.json'))
for (const name of ['gameControlSession.test.ts', 'gameControlActions.test.ts', 'backgroundMinecraftTestService.test.ts', 'minecraftBackgroundControl.test.ts', 'legacyForgeJavaCompatibility.test.ts']) await save('src/main/' + name, (await fs.readFile('src/main/' + name, 'utf8')).replaceAll('../../feature-plugins/testing/src/main/', './'))
await save('scripts/prepare-legacy-forge-java-compatibility.mjs', (await fs.readFile('scripts/prepare-legacy-forge-java-compatibility.mjs', 'utf8')).replaceAll('feature-plugins/testing/src/main/legacyForgeJavaCompatibilityArtifact.json', 'src/main/legacyForgeJavaCompatibilityArtifact.json'))
async function fixtureTree(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await fixtureTree(file); else await save(path.relative(sourceRoot, file).replaceAll('\\', '/'), await fs.readFile(file)) } }
await fixtureTree(path.resolve('src/main/__fixtures__/game-control'))
await save('src/main/xmclUndiciCompatibility.ts', await fs.readFile('src/main/xmclUndiciCompatibility.ts'))
await save('src/main/xmclUndiciCompatibility.test.ts', await fs.readFile('src/main/xmclUndiciCompatibility.test.ts'))
await save('src/main/javaEnvironment.ts', await fs.readFile('src/main/javaEnvironment.ts'))
await save('src/main/javaEnvironment.test.ts', await fs.readFile('src/main/javaEnvironment.test.ts'))

let runtime = await read('src/main/minecraftRuntime.ts')
if (!runtime.includes('private backgroundGameControl:')) {
  runtime = "import { BackgroundGameControlSession, backgroundGameWindowsHide } from './gameControlSession'\n" + runtime
  runtime = once(runtime, 'export class MinecraftRuntimeManager {', `export class MinecraftRuntimeManager {
  private backgroundGameControl: BackgroundGameControlSession | null = null
  getBackgroundGameControl(): BackgroundGameControlSession {
    const project = this.requireProject()
    if (!this.backgroundGameControl || !this.process) throw new Error('当前测试实例未启用后台控制')
    this.backgroundGameControl.assertProject(project.path)
    return this.backgroundGameControl
  }`)
  runtime = method(runtime, 'MinecraftRuntimeManager', 'launch', code => {
    code = once(code, 'const extraJVMArgs = validateJvmArguments(options.extraJVMArgs)', "const extraJVMArgs = validateJvmArguments(options.extraJVMArgs)\n    if (options.backgroundControl !== undefined && typeof options.backgroundControl !== 'boolean') throw new Error('后台控制选项无效')")
    code = once(code, 'let child: ChildProcess\n    try {', "let child: ChildProcess\n    const backgroundControl = options.backgroundControl === true ? await BackgroundGameControlSession.prepare(project.path, gameDirectory) : null\n    const launchJVMArgs = [...extraJVMArgs, ...(backgroundControl ? [backgroundControl.jvmArgument] : [])]\n    try {")
    const begin = code.indexOf('          return spawnManaged('), end = code.indexOf('\n        },', begin)
    if (begin < 0 || end < begin) throw new Error('Missing owned launch spawn block')
    code = code.slice(0, begin) + `          if (!backgroundControl && !this.minecraftMcpPort) return spawnManaged(command, [...(args ?? [])], options ?? {})
          const environment = managedJavaEnvironment(options?.env ?? process.env)
          if (this.minecraftMcpPort) environment.MC_MCP_PORT = String(this.minecraftMcpPort)
          return spawnManaged(command, [...(args ?? [])], { ...options, env: backgroundControl ? backgroundControl.environment(environment) : environment })` + code.slice(end)
    code = once(code, '...(extraJVMArgs.length ? { extraJVMArgs } : {})', '...(launchJVMArgs.length ? { extraJVMArgs: launchJVMArgs } : {})')
    code = once(code, 'extraExecOption: { cwd: gameDirectory, windowsHide: false }', 'extraExecOption: { cwd: gameDirectory, windowsHide: backgroundControl ? backgroundGameWindowsHide(project.minecraftVersion) : false }')
    code = once(code, '} catch (error) {\n      const message', '} catch (error) {\n      await backgroundControl?.dispose()\n      const message')
    code = once(code, 'this.process = child', `this.process = child
    if (backgroundControl) {
      try { backgroundControl.bind(child); this.backgroundGameControl = backgroundControl }
      catch (error) { this.killProcessTree(child); await backgroundControl.dispose(); throw error }
      const clear = (): void => { if (this.backgroundGameControl === backgroundControl) this.backgroundGameControl = null }
      child.once('exit', clear); child.once('error', clear)
    }`)
    return code
  })
  runtime = method(runtime, 'MinecraftRuntimeManager', 'stop', code => once(code, 'const active = this.process', 'await this.backgroundGameControl?.release().catch(() => undefined)\n    const active = this.process'))
  await save('src/main/minecraftRuntime.ts', runtime)
}
runtime = await read('src/main/minecraftRuntime.ts')
if (!runtime.includes('backgroundControl.jvmArguments(extraJVMArgs, project.loader)')) {
  runtime = once(runtime, 'const launchJVMArgs = [...extraJVMArgs, ...(backgroundControl ? [backgroundControl.jvmArgument] : [])]', 'const launchJVMArgs = backgroundControl ? backgroundControl.jvmArguments(extraJVMArgs, project.loader) : extraJVMArgs')
  await save('src/main/minecraftRuntime.ts', runtime)
}
const forgeOptions = "{ java: javaPath, side: 'client', mavenHost: attempt % 2 === 1 ? FORGE_MAVEN_HOSTS"
if (runtime.includes(forgeOptions)) {
  runtime = once(runtime, forgeOptions, "{ java: javaPath, side: 'client', inheritsFrom: project.minecraftVersion, mavenHost: attempt % 2 === 1 ? FORGE_MAVEN_HOSTS")
  await save('src/main/minecraftRuntime.ts', runtime)
}
if (!runtime.includes("from './legacyForgeJavaCompatibility'")) {
  runtime = "import { prepareLegacyForgeJavaCompatibility } from './legacyForgeJavaCompatibility'\n" + runtime
  runtime = once(runtime, '    await applyNarratorPreference(gameDirectory, options.disableNarrator !== false)', '    if (!this.vanillaClient) await prepareLegacyForgeJavaCompatibility(project.loader, project.minecraftVersion, gameDirectory)\n    await applyNarratorPreference(gameDirectory, options.disableNarrator !== false)')
  await save('src/main/minecraftRuntime.ts', runtime)
}

let native = await read('src/main/nativeMinecraftTestService.ts')
if (!native.includes('isBusy(): boolean')) { native = once(native, 'export class NativeMinecraftTestService {', "export class NativeMinecraftTestService {\n  isBusy(): boolean { return Boolean(this.startup?.status === 'running' || this.session || this.stopping) }"); await save('src/main/nativeMinecraftTestService.ts', native) }
let player = await read('src/main/playerTestService.ts')
if (!player.includes("from './backgroundMinecraftTestService'")) {
  player = "import type { BackgroundMinecraftTestService } from './backgroundMinecraftTestService'\n" + player
  player = once(player, 'private preparation = new OwnedTestPreparation()', 'private preparation = new OwnedTestPreparation()\n  isBusy(): boolean { return Boolean(this.preparation.running || this.session || this.controller || this.stopping || this.dependencies.native?.isBusy() || this.dependencies.background?.isBusy()) }')
  player = once(player, 'this.dependencies.native?.assertReadyForSignal(signal) }', 'this.dependencies.native?.assertReadyForSignal(signal); this.dependencies.background?.assertReadyForSignal(signal) }')
  player = once(player, 'await this.dependencies.native?.stopForSignal(signal);', 'await this.dependencies.native?.stopForSignal(signal); await this.dependencies.background?.stopForSignal(signal);')
  player = once(player, 'await this.dependencies.native?.projectChanged(projectPath)', 'await this.dependencies.native?.projectChanged(projectPath)\n    await this.dependencies.background?.projectChanged(projectPath)')
  player = once(player, 'native?: NativeMinecraftTestService })', 'native?: NativeMinecraftTestService; background?: BackgroundMinecraftTestService })')
  player = once(player, 'const nativeStop = this.dependencies.native?.stop()', 'const backgroundStop = this.dependencies.background?.stop().then(() => undefined, error => error as Error)\n    const nativeStop = this.dependencies.native?.stop()')
  player = once(player, 'const failure = await nativeStop; await this.cleanup(); if (failure) throw failure', 'const failures = await Promise.all([nativeStop, backgroundStop]); await this.cleanup(); const failure = failures.find(Boolean); if (failure) throw failure')
  player = once(player, 'await this.client.stop()\n    const session', 'await this.client.stop()\n    this.controller = undefined\n    const session')
  const source = flatten(await fs.readFile('feature-plugins/testing/src/main/playerTestService.ts', 'utf8'))
  const start = source.indexOf("    if (category === 'session' && input.operation === 'start' && input.backend === 'legacy'"), end = source.indexOf("    if ((project.kind ?? 'mod') === 'mod' && this.dependencies.native)", start)
  if (start < 0 || end < start) throw new Error('Missing source routing block')
  player = once(player, "    if ((project.kind ?? 'mod') === 'mod' && this.dependencies.native)", source.slice(start, end) + "    if ((project.kind ?? 'mod') === 'mod' && this.dependencies.native)")
  await save('src/main/playerTestService.ts', player)
}

let shared = await read('src/shared/minecraft.ts')
if (!shared.includes('backgroundControl?:')) shared = once(shared, '  extraJVMArgs?: string[]', '  extraJVMArgs?: string[]\n  backgroundControl?: boolean')
if (!shared.includes('  playerTest:')) shared = once(shared, 'export interface MinecraftApi {', "export interface MinecraftApi {\n  playerTest: (projectPath: string, category: 'session' | 'observe' | 'action' | 'capture' | 'scenario', input: Record<string, unknown>) => Promise<unknown>")
await save('src/shared/minecraft.ts', shared)
let preload = await read('src/preload/index.ts')
if (!preload.includes("invoke('minecraft:playerTest'")) { preload = once(preload, '  minecraft: {', "  minecraft: {\n    playerTest: (projectPath: string, category: 'session' | 'observe' | 'action' | 'capture' | 'scenario', input: Record<string, unknown>) => invoke('minecraft:playerTest', projectPath, category, input),"); await save('src/preload/index.ts', preload) }
let index = await read('src/main/index.ts')
if (!index.includes("from './backgroundMinecraftTestService'")) {
  index = "import { BackgroundMinecraftTestService } from './backgroundMinecraftTestService'\n" + index
  index = once(index, '    native: new NativeMinecraftTestService({', `    background: new BackgroundMinecraftTestService({
      currentProject: () => currentProject,
      build: (project, signal) => aiProjectContext.run(project, () => buildProjectWithLock(signal)),
      launch: operation => withMinecraftResourceLock(operation),
      server: () => localServerManager!,
      createRuntime: (project, directory, vanilla) => new MinecraftRuntimeManager({
        getProject: () => project, instanceDirectory: directory, vanillaClient: vanilla,
        getJavaPreference: async () => (await readSettings()).javaPreferences,
        onState: () => undefined, onEvent: forwardMinecraftRuntimeEvent
      })
    }),
    native: new NativeMinecraftTestService({`)
  index = once(index, "if ((project.kind ?? 'mod') === 'mod' && nativeMcpFor(project.minecraftVersion, project.loader)) {", 'if (isJavaLoader(project.loader)) {')
  index = once(index, "backend: 'minecraft-mod-mcp', observation: session.observation", "backend: 'background-agent', observation: session.observation")
  index = once(index, "  diagnosticHandle('minecraft:getState',", `  diagnosticHandle('minecraft:playerTest', async (_event, projectPath: string, category: string, input: Record<string, unknown>) => {
    const project = requireProject()
    if (!sameProjectPath(project.path, projectPath)) throw new Error('测试项目已切换，请重新打开当前项目')
    if (!['session', 'observe', 'action', 'capture', 'scenario'].includes(category) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('后台测试参数无效')
    if (!playerTestService) throw new Error('玩家测试服务不可用')
    return playerTestService.execute(project, category, input)
  })
  diagnosticHandle('minecraft:getState',`)
  await save('src/main/index.ts', index)
}

let bridge = await read('src/main/externalAgents.ts')
if (!bridge.includes("import { GAME_TEST_SCHEMAS")) {
  bridge = "import { GAME_TEST_SCHEMAS, GAME_TEST_DESCRIPTIONS } from '../shared/gameControl'\n" + bridge
  bridge = once(bridge, 'const tools = [', 'const gameTestSchemas = ${JSON.stringify(GAME_TEST_SCHEMAS)};\nconst gameTestDescriptions = ${JSON.stringify(GAME_TEST_DESCRIPTIONS)};\nconst tools = [')
  const lines = bridge.split('\n'), at = lines.findIndex(line => line.includes("name:'modmind_test_'+category"))
  if (at < 0) throw new Error('Missing embedded test tool definitions')
  lines[at] = "  ...['session','observe','action','capture','scenario'].map(category => ({name:'modmind_test_'+category, description:gameTestDescriptions[category], inputSchema:gameTestSchemas[category], annotations:managedAction})),"
  bridge = lines.join('\n')
  bridge = once(bridge, "      const testCancel = (testTask || body.action === 'test_session') && ['cancel', 'stop'].includes(String(input.operation))", "      const testCleanup = body.action === 'test_action' && ['release', 'cancel'].includes(String(input.operation)) || body.action === 'test_session' && ['pause', 'takeover'].includes(String(input.operation))\n      const testCancel = ((testTask || body.action === 'test_session') && ['cancel', 'stop'].includes(String(input.operation))) || testCleanup")
  bridge = once(bridge, "if (this.features && body.action !== 'test_session') {", "if (this.features && !testCleanup && (body.action !== 'test_session' || input.operation === 'resume')) {")
  bridge = bridge.replace('Supported Java mods use the pinned Minecraft Mod MCP integration and return an actual screenshot plus GUI/player/world observations, then stop. Other versions/modpacks use startup checks only.', 'Java mod/modpack clients use the bundled background Agent and return an actual framebuffer image, then stop. Input does not use the desktop keyboard or mouse.')
  await save('src/main/externalAgents.ts', bridge)
}
let sync = await read('scripts/sync-mcp-server.mjs')
if (!sync.includes("import { GAME_TEST_SCHEMAS")) { sync = once(sync, "import { INSPIRATION_SUBMISSION_SCHEMA } from '../shared/inspirationSubmission';", "import { GAME_TEST_SCHEMAS, GAME_TEST_DESCRIPTIONS } from '../shared/gameControl';\nimport { INSPIRATION_SUBMISSION_SCHEMA } from '../shared/inspirationSubmission';"); await save('scripts/sync-mcp-server.mjs', sync) }
let features = await read('src/shared/workbenchFeatures.ts')
if (!features.includes("'capabilities', 'pause', 'takeover'")) {
  features = once(features, "['stop', 'state', 'capabilities'].includes", "['stop', 'state', 'capabilities', 'pause', 'takeover'].includes")
  features = once(features, "  if (action === 'test_session' && input.operation === 'start') {", "  if (action === 'test_action' && ['release', 'cancel'].includes(String(input.operation))) return undefined\n  if (action === 'test_session' && ['start', 'resume'].includes(String(input.operation))) {")
  await save('src/shared/workbenchFeatures.ts', features)
}
let network = await read('src/main/minecraftDownloadNetwork.ts')
if (!network.includes('ensureXmclUndiciCompatibility')) { network = "import { ensureXmclUndiciCompatibility } from './xmclUndiciCompatibility'\n" + network; network = once(network, 'export function minecraftDownloadDispatcher(): Dispatcher.ComposedDispatcher {', 'export function minecraftDownloadDispatcher(): Dispatcher.ComposedDispatcher {\n  ensureXmclUndiciCompatibility()'); await save('src/main/minecraftDownloadNetwork.ts', network) }
let panel = await fs.readFile('feature-plugins/testing/components/BackgroundGamePanel.tsx', 'utf8')
panel = panel.replaceAll('../../../src/shared/', '../../../shared/')
panel = once(panel, "const invoke = (action: string, input: Record<string, unknown>) => window.modmind.featurePlugins.invoke('testing', 'test_' + action, input)", "const invoke = (action: 'session' | 'action' | 'capture', input: Record<string, unknown>) => window.modmind.minecraft.playerTest(project.path, action, input)")
await save('src/renderer/src/components/BackgroundGamePanel.tsx', panel)
await save('src/renderer/src/background-game.css', await fs.readFile('feature-plugins/testing/background-game.css'))
let app = await read('src/renderer/src/App.tsx')
if (!app.includes("import BackgroundGamePanel from './components/BackgroundGamePanel'")) {
  app = "import BackgroundGamePanel from './components/BackgroundGamePanel'\n" + app
  const start = app.indexOf("{project && project.kind !== 'server-plugin' ? <KeepAliveRoute key={`minecraft:"), end = app.indexOf('</KeepAliveRoute> : null}', start)
  if (start < 0 || end < start) throw new Error('Missing existing game testing page')
  app = app.slice(0, start) + `{project && project.kind !== 'server-plugin' ? <KeepAliveRoute key={\`minecraft:\${project.path}\`} active={view === 'minecraft'}>{isJavaLoader(project.loader) ? <WorkspaceTabs label="游戏测试" sections={[
                { id: 'play', label: '游戏测试', render: () => <MinecraftTestWorkspace projectPath={project.path} beginner={uiMode === 'beginner'} modpack={project.kind === 'modpack'} onManageRelationships={() => setView('relationships')} /> },
                { id: 'background', label: '后台测试', render: () => <BackgroundGamePanel project={project} /> },
                ...(project.kind !== 'modpack' ? [{ id: 'checks', label: '自动检查', render: () => <AutomatedTestsPane /> }] : [])
              ]} /> : <MinecraftTestWorkspace projectPath={project.path} beginner={uiMode === 'beginner'} modpack={project.kind === 'modpack'} onManageRelationships={() => setView('relationships')} />}</KeepAliveRoute> : null}` + app.slice(end + '</KeepAliveRoute> : null}'.length)
  const server = '<ModpackToolsWorkspace project={project} section="server" />'
  app = once(app, server, `{project.kind === 'server-plugin' && ['paper', 'spigot', 'folia'].includes(project.loader) ? <WorkspaceTabs label="本机测试" sections={[
                { id: 'server', label: '服务端', render: () => <ModpackToolsWorkspace project={project} section="server" /> },
                { id: 'background', label: '后台测试', render: () => <BackgroundGamePanel project={project} /> }
              ]} /> : <ModpackToolsWorkspace project={project} section="server" />}`)
  await save('src/renderer/src/App.tsx', app)
}
// The 1.4 host routes first-party tools directly, so its existing review gate
// replaces the feature-plugin process permission used by the modular host.
bridge = await read('src/main/externalAgents.ts')
if (!bridge.includes("  'test_session', 'test_action', 'test_scenario',")) {
  bridge = once(bridge, 'const REVIEWED_ACTIONS = new Set([', "const REVIEWED_ACTIONS = new Set([\n  'test_session', 'test_action', 'test_scenario',")
  await save('src/main/externalAgents.ts', bridge)
}
let fixture = await fs.readFile('src/main/__fixtures__/gameControlMcp.ts', 'utf8')
fixture = fixture.replace(/^import .*FeaturePlugin.*\r?\n/gm, '').replace(/^import .*GAME_TEST_.*\r?\n/gm, '')
fixture = fixture.replace('../../../feature-plugins/testing/src/main/backgroundMinecraftTestService', '../backgroundMinecraftTestService')
const pluginStart = fixture.indexOf('  const plugins = new FeaturePluginService('), pluginEnd = fixture.indexOf('  const noop =', pluginStart)
if (pluginStart < 0 || pluginEnd < 0) throw new Error('Missing MCP fixture plugin setup')
fixture = fixture.slice(0, pluginStart) + fixture.slice(pluginEnd)
fixture = fixture.replace(/    featureTools:.*\r?\n/, '')
fixture = fixture.replace(/    featureInvoke:.*playerTest:/, "    reviewAction: async () => ({ approved: authorized, complete: true, risk: 'low', dangerousOperations: [], feedback: authorized ? '' : 'Fixture denies process permission' }), playerTest:")
fixture = fixture.replace('return { plugins, bridge,', 'return { bridge,').replace(', manifest: manifest as FeaturePluginDefinition', '').replace('; await plugins.shutdown()', '')
fixture = fixture.replace('stdio -> HTTP bridge -> feature discovery/schema/permission/project', 'stdio -> HTTP bridge -> built-in discovery/schema/review/project')
await save('src/main/__fixtures__/gameControlMcp.ts', fixture)
let mcpTest = await fs.readFile('src/main/gameControlMcp.test.ts', 'utf8')
mcpTest = mcpTest.replace("'../../feature-plugins/testing/src/main/backgroundMinecraftTestService'", "'./backgroundMinecraftTestService'")
mcpTest = mcpTest.replace('workbench feature', '1.4 built-in tools')
await save('src/main/gameControlMcp.test.ts', mcpTest)
let harness = await fs.readFile('scripts/verify-game-control-mcp.mjs', 'utf8')
harness = harness.replace(/import \{ configureStudios.*?export \{ gameControlMcpFixture \}/, 'export { gameControlMcpFixture }')
harness = harness.replaceAll('feature-plugins/testing/src/main/', 'src/main/')
harness = harness.replace("path.join(process.env.APPDATA, 'modmind/minecraft-runtime/game')", "'test-results/game-control-matrix-resources'")
harness = harness.replace('real stdio MCP/HTTP/FeaturePluginService, routing fixture invokes production service', 'real 1.4 stdio MCP/HTTP/built-in routing invokes production service')
await save('scripts/verify-game-control-mcp.mjs', harness)
await save('scripts/prepare-game-control-test-window.ps1', await fs.readFile('scripts/prepare-game-control-test-window.ps1'))
await save('scripts/game-control-visual.mjs', await fs.readFile('scripts/game-control-visual.mjs'))
for (const file of ['observe-game-control-desktop.ps1', 'audit-game-control-versions.mjs', 'inspect-game-input-artifacts.mjs', 'inspect-game-loader-profiles.mjs', 'prepare-game-control-matrix.mjs', 'prepare-game-control-loaders.mjs', 'prepare-game-control-profile-variants.mjs', 'prepare-game-control-fonts.mjs', 'verify-game-control-loaders.mjs', 'verify-game-control-evidence.mjs', 'verify-game-control-runtime-libraries.mjs', 'render-game-control-runtime-summary.mjs', 'render-game-control-evidence-gallery.mjs']) {
  let script = await fs.readFile('scripts/' + file, 'utf8')
  script = script.replaceAll('feature-plugins/testing/src/main/gameControlAgent.json', 'src/main/gameControlAgent.json')
  if (file === 'inspect-game-input-artifacts.mjs') script = script.replace('src/main/archiveInspection.ts', 'src/main/ftbResourceArchive.ts')
  await save('scripts/' + file, script)
}
await save('scripts/render-game-control-audit.mjs', (await fs.readFile('scripts/render-game-control-audit.mjs', 'utf8')).replace('feature-plugins/testing/src/main/nativeMinecraftMcpCatalog.json', 'src/main/nativeMinecraftMcpCatalog.json'))
for (const file of ['scripts/verify-game-control-ui.mjs', 'docs/game-control-compatibility/ui.html', 'docs/game-control-compatibility/phase1-evidence/modern/after.png']) await save(file, await fs.readFile(file))
let ui = await fs.readFile('docs/game-control-compatibility/ui-fixture.tsx', 'utf8')
ui = ui.replace('../../feature-plugins/testing/components/BackgroundGamePanel', '../../src/renderer/src/components/BackgroundGamePanel')
ui = ui.replace("host.modmind = { featurePlugins: { invoke: async (_plugin: string, action: string, input: any) => {", "host.modmind = { minecraft: { playerTest: async (_projectPath: string, category: string, input: any) => {\n  const action = 'test_' + category")
await save('docs/game-control-compatibility/ui-fixture.tsx', ui)
let notices = await read('THIRD_PARTY_NOTICES.md')
if (!notices.includes('## Background Game Control Agent')) {
  notices += '\n' + (await fs.readFile('THIRD_PARTY_NOTICES.md', 'utf8')).split('## Background Game Control Agent')[1].replace(/^/, '## Background Game Control Agent').replace('The optional testing feature embeds', 'The application embeds')
  await save('THIRD_PARTY_NOTICES.md', notices)
}
if (!notices.includes('## Forge 1.7.2 Java Compatibility')) {
  notices += '\n\n## Forge 1.7.2 Java Compatibility' + (await fs.readFile('THIRD_PARTY_NOTICES.md', 'utf8')).split('## Forge 1.7.2 Java Compatibility')[1]
  await save('THIRD_PARTY_NOTICES.md', notices)
}
let integrationDoc = await read('docs/minecraft-mcp-integration.zh-CN.md')
if (!integrationDoc.includes('# 旧控制 Mod 后端记录')) {
  const current = await fs.readFile('docs/minecraft-mcp-integration.zh-CN.md', 'utf8')
  integrationDoc = current.split('# 旧控制 Mod 后端记录')[0] + integrationDoc.replace('# 模组真实交互测试', '# 旧控制 Mod 后端记录\n\n以下历史说明只适用于显式 `backend: legacy` 的保留路径；不再描述默认 rendered 链路。')
  await save('docs/minecraft-mcp-integration.zh-CN.md', integrationDoc)
}
await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify({ target, backup, files: manifest.length }))
