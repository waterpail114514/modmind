import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import sharp from 'sharp'

// Install actual built packages in an isolated host. No game/resource installer,
// Electron window or network request is permitted by this activation probe.
const root = process.cwd(), directory = path.resolve('test-results/game-control-package', String(Date.now()))
const captureProof = process.argv.includes('--capture-proof')
await fs.mkdir(directory, { recursive: true }); globalThis.__gamePackageData = path.join(directory, 'userData')
const names = ['buildRuntime', 'creationFeedbackService', 'diagnosticLog', 'downloadActivityService', 'downloadService', 'modpackService', 'modpackContentMetadata', 'curseForgePackMetadata', 'agentProtection', 'nativeFeatureServices', 'networkRequest', 'processTree', 'documentRead', 'projectTextRead', 'inspirationResearch', 'studioRegistry', 'projectTemplates', 'projectMutation']
const contents = names.map((name, index) => `import * as m${index} from './src/main/${name}';`).join('\n') + `
export const runtime={${names.map((name, index) => `${name}:m${index}`).join(',')}};
export { FeaturePluginService, prepareFeaturePlugin } from './src/main/featurePluginService';
export { gameControlMcpFixture } from './src/main/__fixtures__/gameControlMcp';
import { configureStudios, StudioRegistry } from './src/main/studioRegistry';
import studio from './feature-plugins/studio-mod/manifest.json';
configureStudios(new StudioRegistry(()=>[{...studio,manifest:studio,enabled:true,installed:true,available:true,state:'ready',installHint:''}],()=>({})));
`
const harness = path.join(directory, 'host.cjs')
await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: harness, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(harness).href) },
  plugins: [{ name: 'isolated-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'isolated-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'isolated-electron' }, () => ({ loader: 'js', contents: `module.exports={app:{getPath:()=>globalThis.__gamePackageData,getAppPath:()=>${JSON.stringify(root)},getVersion:()=> '1.5.0-preview.6',isPackaged:false},net:{fetch:()=>Promise.reject(new Error('Unexpected package activation network'))},BrowserWindow:{getAllWindows:()=>[]},dialog:{},shell:{},ipcMain:{},nativeTheme:{}}` }))
  } }] })
const { FeaturePluginService, prepareFeaturePlugin, runtime, gameControlMcpFixture } = createRequire(import.meta.url)(harness)
const hostRequire = createRequire(path.join(root, 'package.json')), electronId = hostRequire.resolve('electron'), previousElectron = hostRequire.cache[electronId]
hostRequire.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { app: { getPath: () => globalThis.__gamePackageData, getAppPath: () => root, getVersion: () => '1.5.0-preview.6', isPackaged: false }, net: { fetch: () => Promise.reject(new Error('Unexpected package activation network')) }, BrowserWindow: { getAllWindows: () => [] } } }
const originalFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url || args[0].href)
  return captureProof && url.hostname === '127.0.0.1' ? originalFetch(...args) : Promise.reject(new Error('Unexpected package activation network'))
}
const project = { name: 'Actual testing package', path: path.join(directory, 'project'), namespace: 'package_probe', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1' }
await fs.mkdir(project.path, { recursive: true })
let plugins
const host = { currentProject: project, requireProject: () => project, aiProjectContext: { getStore: () => undefined, run: (_project, run) => run() },
  withMinecraftResourceLock: run => run(), readSettings: async () => ({ javaPreferences: {} }), ensureProjectBuildTrusted: async () => true,
  forwardMinecraftRuntimeEvent: () => {}, projectDataDirectory: () => '.modmind', buildProjectWithLock: async () => { throw new Error('Package capability probe must not build') },
  get featurePluginService() { return plugins } }
plugins = new FeaturePluginService(path.join(directory, 'plugins'), { requireFrom: path.join(root, 'package.json'), capabilities: { runtime, testingV1: true, testingV2: true }, options: () => ({ host }), project: () => project, projectRoot: () => project.path, busy: () => false, changed: () => {}, authorize: async () => true })
try {
  await plugins.initialize()
  for (const id of ['server-pack-runtime-data', 'server-pack-runtime', 'testing']) await plugins.install(await prepareFeaturePlugin(path.join(root, 'feature-plugin-dist', id + '.mmfeature')))
  const artifact = JSON.parse(await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json', 'utf8'))
  const compatibility = JSON.parse(await fs.readFile('feature-plugins/testing/src/main/legacyForgeJavaCompatibilityArtifact.json', 'utf8'))
  const installedCode = await fs.readFile(path.join(directory, 'plugins/testing/main.cjs'), 'utf8')
  assert(installedCode.includes(artifact.jarSha256), 'Built package must carry the currently verified Agent')
  assert(installedCode.includes(compatibility.upstream.sha256) && installedCode.includes(compatibility.data), 'Built package must carry the exact offline legacy Java compatibility artifact')
  assert(installedCode.includes('this.observations.set(') && installedCode.includes('this.observations.get('), 'Built package must carry the concurrent-viewer observation cache')
  assert(!/import\(["']sharp["']\)/.test(installedCode), 'Screenshot decoding must work in the native feature VM without dynamic import callbacks')
  const tools = await plugins.tools('workbench'), tool = tools.find(tool => tool.name === 'modmind_test_action')
  assert(tool); assert(tool.inputSchema.properties.operation.enum.includes('drag'))
  const capabilities = await plugins.invoke('testing', 'test_session', { operation: 'capabilities' }, { surface: 'workbench', projectPath: project.path })
  assert.equal(capabilities.backend, 'background-agent'); assert.equal(capabilities.requiresControlMod, false)
  await assert.rejects(() => plugins.invoke('testing', 'test_action', { operation: 'click', sessionId: 'invalid', x: -1, y: 0 }, { surface: 'workbench', projectPath: project.path }))
  const stopped = await plugins.invoke('testing', 'test_session', { operation: 'stop' }, { surface: 'workbench', projectPath: project.path })
  assert.equal(stopped.stopped, true)
  let actualCapture
  if (captureProof) {
    const resources = path.join(root, 'test-results/game-control-matrix-resources'), version = 'fabric-loader-0.20.1-1.21.1'
    const java = path.join(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64/bin/java.exe')
    await fs.access(java); await fs.access(path.join(resources, 'versions', version, version + '.json'))
    const players = plugins.service('testing').playerTestService
    const background = players.dependencies.background, createRuntime = background.dependencies.createRuntime
    background.dependencies.createRuntime = (...args) => {
      const game = createRuntime(...args)
      Object.assign(game, { prepare: async () => {}, readMetadata: async () => ({ loaderVersionId: version, javaPath: java }), resolveLaunchJava: async () => java, resourceRoot: () => resources })
      return game
    }
    const adapter = { execute: (_project, category, input, signal) => plugins.invoke('testing', 'test_' + category, input, { surface: 'workbench', projectPath: project.path, signal }), stop: () => players.stop() }
    const mcp = await gameControlMcpFixture(() => project, adapter, { standalone: true })
    const call = async (category, input) => {
      const response = (await mcp.call(category, input)).result
      const data = JSON.parse(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
      if (response.isError || data.error) throw new Error(JSON.stringify(data))
      return { response, data }
    }
    try {
      const start = await call('session', { operation: 'start', mode: 'rendered', withoutProjectMod: true, width: 960, height: 540, maxMemoryMb: 2048 })
      const sessionId = start.data.sessionId, deadline = Date.now() + 180000
      let state
      do {
        state = (await call('session', { operation: 'state', sessionId, waitSeconds: 1 })).data
        if (Date.now() > deadline) throw new Error('Actual installed-package game did not become ready')
      } while (!state.ready)
      await new Promise(resolve => setTimeout(resolve, 12000))
      const frame = await call('capture', { sessionId })
      const image = frame.response.content.find(item => item.type === 'image')
      assert(image && image.mimeType === 'image/png', 'Actual package must return MCP image content')
      const bytes = Buffer.from(image.data, 'base64'), meta = await sharp(bytes).metadata(), stats = await sharp(bytes).stats()
      assert.equal(meta.width, 960); assert.equal(meta.height, 540)
      assert(stats.channels.slice(0, 3).some(channel => channel.stdev > 1), 'Actual game frame must have visible content')
      await fs.writeFile(path.join(directory, 'actual-game.png'), bytes)
      actualCapture = { packageVersion: plugins.list().find(row => row.id === 'testing').version, backend: state.backend, minecraftVersion: project.minecraftVersion, frameId: frame.data.captures[0].frameId, imageBytes: bytes.length, width: meta.width, height: meta.height, imageSha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), routing: 'standalone stdio MCP -> HTTP -> installed actual testing.mmfeature -> production background service -> real game' }
      assert.equal(state.backend, 'background-agent')
      await call('session', { operation: 'stop', sessionId })
    } finally { await mcp.close() }
  }
  const result = { directory, agentSha256: artifact.jarSha256, legacyJavaCompatibilitySha256: compatibility.upstream.sha256, concurrentViewersIncluded: true, screenshotVmCompatible: true, actualCapture, packages: plugins.list().map(item => ({ id: item.id, version: item.version, enabled: item.enabled })), tools: tools.filter(tool => tool.name.startsWith('modmind_test_')).map(tool => tool.name), capabilities, stopped, networkAllowed: false }
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} finally { await plugins.shutdown(); globalThis.fetch = originalFetch; if (previousElectron) hostRequire.cache[electronId] = previousElectron; else delete hostRequire.cache[electronId] }
