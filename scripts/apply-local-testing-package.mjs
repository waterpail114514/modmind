import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

// Local repair only: retain the installed package, then use the same validated
// atomic update as the application. The running app reloads it on next start.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = process.cwd(), userData = path.resolve(arg('user-data') || '')
assert(arg('user-data'), 'Explicit ModMind user-data directory required')
const pluginsRoot = path.join(userData, 'feature-plugins')
assert.equal(await fs.realpath(pluginsRoot), pluginsRoot)
const installed = path.join(pluginsRoot, 'testing'), previous = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'))
assert.equal(previous.id, 'testing')
const proofRoot = path.resolve(arg('proof') || '')
assert(proofRoot.startsWith(path.join(root, 'test-results/game-control-package') + path.sep), 'Completed local activation proof required')
const proof = JSON.parse(await fs.readFile(path.join(proofRoot, 'verification.json'), 'utf8'))
assert(proof.screenshotVmCompatible && proof.actualCapture?.backend === 'background-agent')
const backup = path.join(root, 'test-results/game-control-dynamic-import-repair', String(Date.now()))
await fs.mkdir(backup, { recursive: true })
await fs.cp(installed, path.join(backup, 'testing-before'), { recursive: true, errorOnExist: true, force: false })
globalThis.__gamePackageData = path.join(backup, 'activation-data')
const { FeaturePluginService, prepareFeaturePlugin, runtime } = createRequire(import.meta.url)(path.join(proofRoot, 'host.cjs'))
const hostRequire = createRequire(path.join(root, 'package.json')), electronId = hostRequire.resolve('electron'), original = hostRequire.cache[electronId]
hostRequire.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { app: { getPath: () => globalThis.__gamePackageData, getAppPath: () => root, getVersion: () => '1.5.0-preview.6', isPackaged: false }, net: { fetch: () => Promise.reject(new Error('No repair downloads')) }, BrowserWindow: { getAllWindows: () => [] } } }
const project = { name: 'Local update validation', path: path.join(backup, 'project'), namespace: 'repair_check', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1' }
await fs.mkdir(project.path, { recursive: true })
let plugins
const host = { currentProject: project, requireProject: () => project, aiProjectContext: { getStore: () => undefined, run: (_project, run) => run() }, withMinecraftResourceLock: run => run(), readSettings: async () => ({ javaPreferences: {} }), ensureProjectBuildTrusted: async () => true, forwardMinecraftRuntimeEvent: () => {}, projectDataDirectory: () => '.modmind', get featurePluginService() { return plugins } }
plugins = new FeaturePluginService(pluginsRoot, { requireFrom: path.join(root, 'package.json'), capabilities: { runtime, testingV1: true, testingV2: true }, options: () => ({ host }), project: () => project, projectRoot: () => project.path, busy: () => false, changed: () => {}, authorize: async () => true })
try {
  await plugins.initialize()
  await plugins.update(await prepareFeaturePlugin(path.join(root, 'feature-plugin-dist/testing.mmfeature')))
  const capabilities = await plugins.invoke('testing', 'test_session', { operation: 'capabilities' }, { projectPath: project.path, surface: 'workbench' })
  assert.equal(capabilities.backend, 'background-agent')
  const current = plugins.list().find(row => row.id === 'testing')
  assert.equal(current.version, proof.actualCapture.packageVersion)
  const result = { userData, backup, previousVersion: previous.version, installedVersion: current.version, capabilities, runningAppReloadRequired: true, otherPackagesChanged: false }
  await fs.writeFile(path.join(backup, 'verification.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await plugins.shutdown()
  if (original) hostRequire.cache[electronId] = original; else delete hostRequire.cache[electronId]
}
