import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { pathToFileURL } from 'node:url'
import { findTitlePlayButton, findExperimentalWorldConfirmation } from './game-control-visual.mjs'

// Uses existing resources and an isolated COPY of an existing test world.
// The only substituted runtime stages are installation/Java selection, so this
// harness cannot silently download clients/assets or modify a player install.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = path.resolve(arg('directory') || `test-results/game-control-mcp/${Date.now()}`)
const version = arg('version') || '1.20.1', minecraftVersion = arg('minecraft-version') || version.split('-')[0]
const resources = path.resolve(arg('resources') || path.join(process.env.APPDATA, 'modmind/minecraft-runtime/game'))
const java = arg('java'); if (!java) throw new Error('An absolute real JVM executable is required')
const graphicsApi = arg('graphics-api'), rawMouse = arg('raw-mouse')
if (graphicsApi && (!['opengl', 'vulkan'].includes(graphicsApi) || minecraftVersion !== '26.3')) throw new Error('Explicit graphics API probe requires 26.3 and opengl/vulkan')
if (rawMouse !== undefined && !['true', 'false'].includes(rawMouse)) throw new Error('raw-mouse must be true or false')
const agentArtifact = path.resolve(arg('agent-artifact') || 'feature-plugins/testing/src/main/gameControlAgent.json')
const agentBytes = await fs.readFile(agentArtifact, 'utf8'), agentSha256 = JSON.parse(agentBytes).jarSha256
await fs.access(java); await fs.access(path.join(resources, 'versions', version, version + '.json'))
await fs.mkdir(directory, { recursive: true })
globalThis.__gameMcpData = path.join(directory, 'host')
const archiveModule = await fs.access('src/main/archiveInspection.ts').then(() => 'archiveInspection', () => 'ftbResourceArchive')
await build({ stdin: { contents: `import { configureStudios, StudioRegistry } from './src/main/studioRegistry'; import manifest from './feature-plugins/studio-mod/manifest.json'; configureStudios(new StudioRegistry(()=>[{...manifest,manifest,enabled:true,installed:true,available:true,state:'ready',installHint:''}],()=>({}))); export { gameControlMcpFixture } from './src/main/__fixtures__/gameControlMcp'; export { BackgroundMinecraftTestService } from './feature-plugins/testing/src/main/backgroundMinecraftTestService'; export { MinecraftRuntimeManager } from './feature-plugins/testing/src/main/minecraftRuntime'; export { archiveRead } from './src/main/${archiveModule}';`, resolveDir: process.cwd(), loader: 'ts' }, outfile: path.join(directory, 'harness.cjs'), platform: 'node', format: 'cjs', bundle: true, packages: 'external', logLevel: 'silent',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(directory, 'harness.cjs')).href) },
  plugins: [{ name: 'candidate-agent', setup(builder) { builder.onResolve({ filter: /gameControlAgent\.json$/ }, () => ({ path: agentArtifact, namespace: 'candidate-agent' })); builder.onLoad({ filter: /.*/, namespace: 'candidate-agent' }, () => ({ contents: agentBytes, loader: 'json' })); } }, { name: 'owned-electron-paths', setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'owned-electron' })); builder.onLoad({ filter: /.*/, namespace: 'owned-electron' }, () => ({ contents: `export const app={getPath:()=>globalThis.__gameMcpData,getVersion:()=> '1.5.0-plugintest',isPackaged:false}; export const dialog={}; export const BrowserWindow={getAllWindows:()=>[]}; export const shell={}; export const ipcMain={}; export const nativeTheme={}; export const net={fetch:globalThis.fetch}; export const session={};`, loader: 'js' })) } }] })
const { gameControlMcpFixture, BackgroundMinecraftTestService, MinecraftRuntimeManager, archiveRead } = createRequire(import.meta.url)(path.join(directory, 'harness.cjs'))
const project = { name: 'Background MCP acceptance', path: path.join(directory, 'project'), loader: arg('loader') || 'fabric', minecraftVersion, kind: 'mod' }
await fs.mkdir(project.path, { recursive: true })
// Loader-matrix Fabric runs also prove that the shared service copies and loads
// an owned project artifact. Vanilla runs keep the clean-client path.
const fixtureMod = process.argv.includes('--fixture-mod') || arg('loader') === 'fabric'
const resizeProbe = process.argv.includes('--resize') || ['1.12.2', '1.20.1', '26.3'].includes(minecraftVersion)
let builtFixture, projectModMarkerLog
async function buildFixtureMod() {
  if (!fixtureMod) throw new Error('No builds in local-only acceptance')
  if (builtFixture) return builtFixture
  const { Version } = await import('@xmcl/core')
  const resolved = await Version.parse(resources, version)
  let dependency, fixtureSource, release = '8', descriptor, metadata
  const fixtureId = 'modmind_acceptance_fixture'
  if (project.loader === 'fabric') {
    const loader = resolved.libraries.find(library => library.groupId === 'net.fabricmc' && library.artifactId === 'fabric-loader')
    if (!loader) throw new Error('Fabric loader library missing for fixture compilation')
    dependency = path.join(resources, 'libraries', loader.path)
    fixtureSource = 'public final class ModMindFixture implements net.fabricmc.api.ClientModInitializer { public void onInitializeClient() { System.out.println("MODMIND_PROJECT_MOD_LOADED"); } }'
    descriptor = 'fabric.mod.json'
    metadata = JSON.stringify({ schemaVersion: 1, id: fixtureId, version: '1.0.0', name: 'Owned acceptance fixture', environment: 'client', entrypoints: { client: ['ModMindFixture'] }, license: 'AGPL-3.0-only' })
  } else {
    const profile = JSON.parse(await fs.readFile(path.join(resources, 'versions', version, version + '.json'), 'utf8'))
    let annotation
    if (project.loader === 'forge' && minecraftVersion === '1.20.1') {
      const loaderVersion = version.match(/forge-?([\d.]+)$/)?.[1]
      if (!loaderVersion) throw new Error('Explicit Forge fixture profile required')
      const coordinate = `${minecraftVersion}-${loaderVersion}`
      dependency = path.join(resources, 'libraries/net/minecraftforge/javafmllanguage', coordinate, `javafmllanguage-${coordinate}.jar`)
      annotation = 'net.minecraftforge.fml.common.Mod'; release = '17'; descriptor = 'META-INF/mods.toml'
    } else if (project.loader === 'neoforge' && minecraftVersion === '1.21.1') {
      const loader = profile.libraries.find(library => library.name.startsWith('net.neoforged.fancymodloader:loader:'))
      if (!loader?.downloads?.artifact?.path) throw new Error('NeoForge annotation library missing')
      dependency = path.join(resources, 'libraries', loader.downloads.artifact.path)
      annotation = 'net.neoforged.fml.common.Mod'; release = '21'; descriptor = 'META-INF/neoforge.mods.toml'
    } else throw new Error('Project-Mod fixture is supported for Fabric, Forge 1.20.1 and NeoForge 1.21.1 only')
    await archiveRead(dependency, annotation.replaceAll('.', '/') + '.class')
    fixtureSource = `package dev.modmind.acceptance; @${annotation}("${fixtureId}") public final class ModMindFixture { public ModMindFixture() { System.out.println("MODMIND_PROJECT_MOD_LOADED"); } }`
    metadata = `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="AGPL-3.0-only"\n[[mods]]\nmodId="${fixtureId}"\nversion="1.0.0"\ndisplayName="Owned acceptance fixture"\n`
  }
  const source = path.join(project.path, '.modmind/minecraft/fixture'), classes = path.join(source, project.loader === 'fabric' ? 'classes' : 'fml-classes'), mods = path.join(source, 'mods')
  await fs.mkdir(classes, { recursive: true }); await fs.mkdir(mods, { recursive: true })
  const file = path.join(source, 'ModMindFixture.java'), jar = path.join(mods, 'modmind-current-project.jar')
  await fs.writeFile(file, fixtureSource)
  const adjacentJavac = path.join(path.dirname(java), 'javac.exe')
  const javac = await fs.access(adjacentJavac).then(() => adjacentJavac, () => 'javac')
  await promisify(execFile)(javac, ['--release', release, '-encoding', 'UTF-8', '-cp', dependency, '-d', classes, file], { windowsHide: true, timeout: 30000 })
  await fs.mkdir(path.dirname(path.join(classes, descriptor)), { recursive: true })
  await fs.writeFile(path.join(classes, descriptor), metadata)
  if (project.loader !== 'fabric') {
    const client = JSON.parse((await archiveRead(path.join(resources, 'versions', minecraftVersion, minecraftVersion + '.jar'), 'version.json')).toString('utf8'))
    if (!Number.isSafeInteger(client.pack_version?.resource)) throw new Error('Client resource-pack format missing')
    await fs.writeFile(path.join(classes, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: client.pack_version.resource, description: 'Owned acceptance project fixture' } }))
  }
  await promisify(execFile)('jar', ['--create', '--file', jar, '-C', classes, '.'], { windowsHide: true, timeout: 30000 })
  builtFixture = { path: jar, name: path.basename(jar), size: (await fs.stat(jar)).size, modifiedAt: new Date().toISOString(), projectArtifact: true }
  return builtFixture
}
if (process.argv.includes('--compile-fixture-only')) {
  console.log(JSON.stringify({ compiledFixture: await buildFixtureMod() }))
  process.exit(0)
}
let runtime, mcp, observer, observerDone
const service = new BackgroundMinecraftTestService({ currentProject: () => project, build: buildFixtureMod,
  createRuntime: (_project, instanceDirectory) => {
    runtime = new MinecraftRuntimeManager({ getProject: () => project, instanceDirectory, getJavaPreference: async () => ({ game: java, build: java, tools: java }), onState: () => {}, onEvent: () => {} })
    Object.assign(runtime, { prepare: async () => {}, readMetadata: async () => ({ loaderVersionId: version, javaPath: java }), resolveLaunchJava: async () => java, resourceRoot: () => resources })
    const launch = runtime.launch.bind(runtime)
    runtime.launch = async (options, signal) => {
      const game = options.withoutProjectMod ? path.join(instanceDirectory, 'clean-game') : instanceDirectory
      if (arg('world')) await fs.cp(path.resolve(arg('world')), path.join(game, 'saves', path.basename(arg('world'))), { recursive: true })
      let optionVersion = ''
      if (graphicsApi || rawMouse !== undefined) {
        const metadata = JSON.parse((await archiveRead(path.join(resources, 'versions', minecraftVersion, minecraftVersion + '.jar'), 'version.json')).toString('utf8'))
        if (!Number.isSafeInteger(metadata.world_version)) throw new Error('Client data version missing for explicit options probe')
        optionVersion = `version:${metadata.world_version}\n`
      }
      await fs.writeFile(path.join(game, 'options.txt'), optionVersion + 'lang:en_us\nnarrator:0\nonboardAccessibility:false\npauseOnLostFocus:false\nguiScale:2\nrenderDistance:4\nsimulationDistance:5\nsoundCategory_master:0.0\n' + (graphicsApi ? `preferredGraphicsBackend:${JSON.stringify(graphicsApi)}\n` : '') + (rawMouse === undefined ? '' : `rawMouseInput:${rawMouse}\n`))
      // Exercise the production managedJavaEnvironment socket-directory policy;
      // no harness-only JVM workaround may hide an actual launch failure.
      return launch(options, signal)
    }
    return runtime
  } })
const results = [], captures = {}
const progress = setInterval(() => {
  console.log(JSON.stringify({ event: 'acceptance-progress', version, calls: results.length, images: Object.keys(captures).length }))
  if (arg('agent-artifact') && runtime) void runtime.getBackgroundGameControl()?.status().then(state => console.log(JSON.stringify({ event: 'candidate-agent-state', state })), () => {})
}, 10000)
const plain = response => {
  if (response.error) throw new Error(JSON.stringify(response.error))
  const content = response.result?.content || [], text = content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  let parsed; try { parsed = JSON.parse(text) } catch { throw new Error(text) }
  if (response.result.isError) throw new Error(text)
  return parsed
}
async function call(category, input) { const response = await mcp.call(category, input); const result = plain(response); results.push({ category, input, result }); return { result, response } }
async function capture(name) {
  const { result, response } = await call('capture', { sessionId })
  const image = response.result.content.find(item => item.type === 'image')
  if (!image || image.mimeType !== 'image/png') throw new Error('MCP did not return image content')
  const png = Buffer.from(image.data, 'base64'), file = `${name}.png`; await fs.writeFile(path.join(directory, file), png)
  captures[name] = { ...result.captures[0], path: file, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length }
  return result.captures[0]
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, test, timeout = 90000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await read().catch(() => undefined); if (value && test(value)) return value; await sleep(250) } throw new Error('Acceptance condition timed out') }
let sessionId
const observationReady = path.join(directory, 'desktop.ready'), observationStop = path.join(directory, 'desktop.stop'), observationPid = path.join(directory, 'desktop.pid')
const action = async input => { const { result } = await call('action', { sessionId, requestId: randomUUID(), ...input }); if (result.status !== 'completed') throw new Error(JSON.stringify(result)); return result }
try {
  mcp = await gameControlMcpFixture(() => project, service, { standalone: process.argv.includes('--standalone') })
  const tools = (await mcp.list()).result.tools
  if (!tools.find(tool => tool.name === 'modmind_test_action')?.inputSchema.properties.operation.enum.includes('drag')) throw new Error('Feature discovery missing background schema')
  for (const file of [observationReady, observationStop, observationPid]) await fs.rm(file, { force: true })
  observer = spawn('powershell.exe', ['-NoProfile', '-File', 'scripts/observe-game-control-desktop.ps1', '-DurationMs', '330000', '-ReadyFile', observationReady, '-StopFile', observationStop, '-GameProcessIdFile', observationPid, '-Output', path.join(directory, 'desktop.json')], { windowsHide: true, stdio: 'ignore' })
  observerDone = new Promise((resolve, reject) => { observer.once('exit', code => code === 0 ? resolve() : reject(new Error('Desktop observation failed'))); observer.once('error', reject) })
  // Observe before launch, including early Loader windows. A readiness barrier
  // prevents PowerShell startup time from leaving an unobserved interval.
  await until(() => fs.stat(observationReady), () => true, 15000)
  sessionId = (await call('session', { operation: 'start', mode: 'rendered', backend: 'background', withoutProjectMod: !fixtureMod, width: 960, height: 540, maxMemoryMb: 2048 })).result.sessionId
  const ready = await until(async () => (await call('session', { operation: 'state', sessionId, waitSeconds: 1 })).result, state => { if (state.error) throw new Error(state.error); return state.ready })
  await fs.writeFile(observationPid, String(ready.pid))
  const game = runtime.getState().instancePath
  const clientLog = /^1\.[0-6](?:\.|$)/.test(project.minecraftVersion) ? path.join(game, 'launcher-console.log') : path.join(game, 'logs/latest.log')
  const waitForWorld = timeout => until(async () => ({
    log: await fs.readFile(clientLog, 'utf8'),
    state: await Promise.resolve().then(() => runtime.getBackgroundGameControl().status()).catch(error => ({ error: error.message }))
  }), value => { if (value.state.error) throw new Error(value.state.error); return value.log.includes('joined the game') }, timeout)
  const placed = await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', 'scripts/prepare-game-control-test-window.ps1', '-GameProcessId', String(ready.pid), '-OwnedSessionDirectory', path.join(game, '.modmind-game-control')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const placement = JSON.parse(placed.stdout)
  await fs.writeFile(path.join(directory, 'placement.json'), JSON.stringify(placement, null, 2))
  if (!placement.foregroundUnchanged) throw new Error('Game placement changed foreground')
  await until(() => fs.stat(clientLog), stat => stat.size > 0)
  if (fixtureMod) projectModMarkerLog = await until(async () => {
    for (const file of new Set([clientLog, path.join(game, 'launcher-console.log')])) {
      const content = await fs.readFile(file, 'utf8').catch(() => '')
      if (content.includes('MODMIND_PROJECT_MOD_LOADED')) return file
    }
  }, file => Boolean(file))
  await sleep(['forge', 'neoforge'].includes(arg('loader')) ? 20000 : 7000)
  const graphicsBackend = /Using graphics backend (\w+)/.exec(await fs.readFile(clientLog, 'utf8'))?.[1]
  if (graphicsApi && graphicsBackend?.toLowerCase() !== graphicsApi) throw new Error(`Requested ${graphicsApi}, actual graphics backend: ${graphicsBackend || 'unreported'}`)
  if (rawMouse !== undefined && !(await fs.readFile(path.join(game, 'options.txt'), 'utf8')).split(/\r?\n/).includes(`rawMouseInput:${rawMouse}`)) throw new Error('Explicit raw-mouse option was not retained by Minecraft')
  await capture('title')
  // A render-ready framebuffer can still show the startup overlay. Wait for
  // that bounded visual transition before sending menu coordinates.
  for (let attempt = 0; attempt < 30; attempt++) {
    // libvips caches filename loaders; the same evidence path is overwritten
    // for each fresh frame, so classify fresh bytes instead of a cached loader.
    const stats = await sharp(await fs.readFile(path.join(directory, 'title.png'))).stats()
    const [red, green, blue] = stats.channels
    const loading = red.mean > green.mean * 1.3 && red.mean > blue.mean * 1.3 || Math.min(red.mean, green.mean, blue.mean) > 215 || Math.max(red.stdev, green.stdev, blue.stdev) < 3
    if (!loading) break
    if (attempt === 29) throw new Error('Startup overlay did not finish before menu input')
    await sleep(2000); await capture('title')
  }
  let titlePlayButton
  // Quilt can report render-ready during the title's initial fade. Wait for
  // an actually visible button instead of classifying that transient as a
  // control failure or sending an unobserved fixed coordinate.
  for (let attempt = 0; attempt < 20; attempt++) {
    titlePlayButton = await findTitlePlayButton(await fs.readFile(path.join(directory, 'title.png')))
    if (titlePlayButton) break
    await sleep(500); await capture('title')
  }
  if (!titlePlayButton) throw new Error('Cannot recognize the title-menu Singleplayer button in the actual frame')
  if (arg('world')) {
    for (const [x, y] of [[titlePlayButton.x, titlePlayButton.y], [390, 130], [320, 455]]) { const image = await capture('menu-' + y); await action({ operation: 'click', x, y, revision: image.revision }); await sleep(500) }
    await waitForWorld(90000)
  } else if (process.argv.includes('--create-world')) {
    let image = await capture('new-world-title')
    await action({ operation: 'click', x: titlePlayButton.x, y: titlePlayButton.y, revision: image.revision })
    await sleep(2500)
    image = await capture('new-world-form')
    // Older clients keep an empty Select World list instead of opening the
    // creation form. This is its Create New World button; newer forms have no
    // control at this point. Use only ordinary screenshot-bound mouse input.
    await action({ operation: 'click', x: 640, y: 455, revision: image.revision })
    await sleep(1000)
    image = await capture('new-world-options')
    await action({ operation: 'click', x: 320, y: 500, revision: image.revision })
    await sleep(750); const starting = await capture('world-starting')
    if (project.loader === 'neoforge' && minecraftVersion === '1.20.5') {
      const confirmation = await findExperimentalWorldConfirmation(await fs.readFile(path.join(directory, 'world-starting.png')))
      if (!confirmation) throw new Error('Expected NeoForge 1.20.5 experimental-world confirmation was not visible')
      await action({ operation: 'click', x: confirmation.x, y: confirmation.y, revision: starting.revision })
      await capture('world-confirmed')
    }
    try { await waitForWorld(150000) }
    catch (error) { await capture('world-load-timeout').catch(() => undefined); throw error }
    await sleep(1500)
  }
  await action({ operation: 'key', key: 'F3' }); await capture('before')
  const requestId = randomUUID(), batch = { sessionId, requestId, operation: 'batch', steps: [{ operation: 'key_down', key: 'S', durationMs: 1800 }, { operation: 'look', dx: 120, dy: -20 }, { operation: 'wait', durationMs: 800 }], capture: true }
  const completed = (await call('action', batch)).result
  if (completed.status !== 'completed' || !completed.acknowledged || completed.gameplayVerified) throw new Error('Incorrect completion semantics')
  const replay = (await call('action', batch)).result
  if (replay.frameId !== completed.frameId) throw new Error('Request replayed')
  await capture('after')
  await action({ operation: 'inventory' }); const inventory = await capture('inventory')
  // Creative/survival container slot positions differ; this demonstrates the
  // actual drag input and records images for inspection, not item semantics.
  await action({ operation: 'drag', x: 480, y: 270, toX: 500, toY: 280, revision: inventory.revision, durationMs: 250 })
  await action({ operation: 'scroll', clicks: 1 }); await action({ operation: 'close' }); await action({ operation: 'key', key: 'F3' }); await action({ operation: 'key', key: 'T' })
  await action({ operation: 'text', text: 'ModMind 中文 123' }); await capture('text')
  await action({ operation: 'combo', keys: ['Control', 'A'], durationMs: 70 }); await action({ operation: 'text', text: 'replacement 替换' }); await capture('replaced')
  await action({ operation: 'close' })
  await call('session', { operation: 'pause', sessionId }); await capture('paused')
  const paused = plain(await mcp.call('action', { operation: 'key', key: 'W', sessionId }))
  if (paused.status !== 'failed') throw new Error('Paused input was not rejected')
  await call('session', { operation: 'takeover', sessionId }); await capture('human')
  await call('session', { operation: 'resume', sessionId }); await action({ operation: 'key', key: 'E' }); await capture('resumed')
  const sharedView = await capture('shared-view')
  await capture('preview-refresh')
  await action({ operation: 'click', x: 5, y: 5, revision: sharedView.revision })
  let resize
  if (resizeProbe) {
    const before = await capture('before-resize')
    const resizeWindow = async (width, height) => {
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', 'scripts/prepare-game-control-test-window.ps1', '-GameProcessId', String(ready.pid), '-OwnedSessionDirectory', path.join(game, '.modmind-game-control'), '-ResizeWidth', String(width), '-ResizeHeight', String(height)], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      const placement = JSON.parse(result.stdout); if (!placement.foregroundUnchanged) throw new Error('Owned resize changed foreground'); return placement
    }
    await resizeWindow(800, 450)
    const resized = await until(() => capture('resized'), view => view.width !== before.width || view.height !== before.height, 15000)
    const stale = plain(await mcp.call('action', { sessionId, requestId: randomUUID(), operation: 'click', x: 5, y: 5, revision: before.revision }))
    if (stale.status !== 'failed' || !stale.error.includes('坐标已过期')) throw new Error('Resized game accepted stale coordinates')
    const fresh = await capture('resized-after-rejection'); await action({ operation: 'click', x: 5, y: 5, revision: fresh.revision })
    await resizeWindow(placement.clientWidth, placement.clientHeight)
    const restored = await until(() => capture('restored'), view => view.width === before.width && view.height === before.height, 15000)
    resize = { before: [before.width, before.height], resized: [resized.width, resized.height], restored: [restored.width, restored.height], staleRejected: true, foregroundUnchanged: true }
  }
  const current = (await call('session', { operation: 'state', sessionId })).result
  if (current.keysDown.length || current.buttonsDown.length || !current.physicalCallbacksFiltered || current.error) throw new Error('Input isolation/cleanup failed')
  await fs.writeFile(observationStop, 'stop'); await observerDone
  const desktop = JSON.parse(await fs.readFile(path.join(directory, 'desktop.json'), 'utf8'))
  if (desktop.gameEverForeground) throw new Error('Game became foreground')
  let projectModArtifact
  if (builtFixture) {
    const copiedJar = path.join(game, 'mods', builtFixture.name)
    const sourceHash = createHash('sha256').update(await fs.readFile(builtFixture.path)).digest('hex')
    if (createHash('sha256').update(await fs.readFile(copiedJar)).digest('hex') !== sourceHash) throw new Error('Loaded fixture differs from current project artifact')
    projectModArtifact = { loader: project.loader, bytes: builtFixture.size, sha256: sourceHash, copiedJar: path.relative(directory, copiedJar), markerLog: path.relative(directory, projectModMarkerLog) }
  }
  const report = { version, minecraftVersion, loader: arg('loader') || 'vanilla', worldLoaded: Boolean(arg('world') || process.argv.includes('--create-world')), projectModLoaded: fixtureMod, projectModArtifact, titlePlayButton, graphicsBackend, rawMouseInput: rawMouse === undefined ? undefined : rawMouse === 'true', resize, ready, placement, current, captures, desktop: { scope: 'before-launch-through-actions', gameEverForeground: desktop.gameEverForeground, samples: desktop.samples.length, clips: [...new Set(desktop.samples.map(sample => sample.clip.join(',')))] },
    toolNames: tools.filter(tool => tool.name.startsWith('modmind_test_')).map(tool => tool.name), assertions: { imageContent: true, duplicateNotReplayed: true, pauseRejected: true, takeoverResume: true, sharedViewerRevision: true, finalInputReleased: true, foregroundUnchanged: true },
    runtimeSubstitutions: ['existing resource directory', 'skip resource installation', 'explicit existing Java', ...(arg('world') ? ['pre-copied isolated test world'] : []), ...(fixtureMod ? ['compiled acceptance fixture replaces the project Gradle build'] : [])], routing: 'real stdio MCP/HTTP/FeaturePluginService, routing fixture invokes production service', agentSha256 }
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ directory, version, assertions: report.assertions }))
} catch (error) { await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, results }, null, 2)); throw error }
finally { clearInterval(progress); if (observer && observer.exitCode === null) await fs.writeFile(observationStop, 'stop'); await observerDone?.catch(() => {}); await mcp?.close(); await service.stop(); await fs.writeFile(path.join(directory, 'calls.json'), JSON.stringify(results, null, 2)) }

