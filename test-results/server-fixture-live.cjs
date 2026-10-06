const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const ts = require('typescript')
const { pathToFileURL } = require('node:url')
const Module = require('node:module')
const { spawn } = require('node:child_process')
const root = path.resolve('test-results/server-fixture-live', String(Date.now()))
const userData = path.join(root, 'host')
const originalLoad = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => userData, isPackaged: false, getVersion: () => '1.4.19', getAppPath: () => process.cwd() }, net: { fetch }, session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } }
  return originalLoad.call(this, name, ...args)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
const { createStoredZip } = require('../src/main/bedrockAddon.ts')
const { ServerFixtureService, fixtureJarHash } = require('../src/main/serverFixtureService.ts')
const { IsolatedServerScenarioService } = require('../src/main/isolatedServerScenarioService.ts')
const { installFixtureRuntime } = require('../src/main/serverFixtureRuntime.ts')
const { ModMindBridge } = require('../src/main/externalAgents.ts')
const { setNetworkProxy, shutdownNetwork } = require('../src/main/networkRequest.ts')
const { diagnosticJournal } = require('../src/main/diagnosticLog.ts')

function rpc(child, id, method, params) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { clear(); reject(new Error('MCP response exceeded 25 seconds')) }, 25000)
    const data = chunk => {
      buffer += chunk; const newline = buffer.indexOf('\n'); if (newline < 0) return
      clear(); try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    const close = () => { clear(); reject(new Error('MCP exited')) }
    const clear = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('close', close) }
    child.stdout.on('data', data); child.once('close', close)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
async function main() {
  await fsp.mkdir(userData, { recursive: true })
  const project = { path: path.join(root, 'project'), kind: 'modpack', name: 'Forge fixture smoke', namespace: 'fixture', loader: 'forge', loaderVersion: '47.4.23', minecraftVersion: '1.20.1', createdAt: '' }
  await fsp.mkdir(project.path)
  const jars = []
  for (const id of ['fixture', 'fixture_api_one', 'fixture_api_two']) {
    let descriptor = `modLoader="lowcodefml"\nloaderVersion="[47,)"\nlicense="CC0-1.0"\n[[mods]]\nmodId="${id}"\nversion="1.0.0"\ndisplayName="${id}"\n`
    if (id === 'fixture') for (const dep of ['fixture_api_one', 'fixture_api_two']) descriptor += `[[dependencies.fixture]]\nmodId="${dep}"\nmandatory=true\nversionRange="[1.0.0]"\nordering="NONE"\nside="SERVER"\n`
    const file = path.join(project.path, `${id}.jar`)
    await fsp.writeFile(file, createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from(descriptor) }, { name: 'pack.mcmeta', data: Buffer.from(JSON.stringify({ pack: { description: id, pack_format: 15 } })) }, { name: `data/${id}/fixture.txt`, data: Buffer.alloc(2048) }]))
    jars.push({ path: file, sha256: (await fixtureJarHash(file)).sha256 })
  }
  const javaPath = process.env.MODMIND_FIXTURE_JAVA
  if (!javaPath || !fs.existsSync(javaPath)) throw new Error('MODMIND_FIXTURE_JAVA must name Java 17')
  setNetworkProxy('http://127.0.0.1:7897')
  const fixtures = new ServerFixtureService()
  const service = new IsolatedServerScenarioService({ fixtures, java: async () => ({ path: javaPath, version: '17' }), install: (options, target) => installFixtureRuntime(process.env.MODMIND_FIXTURE_CACHE || path.join(userData, 'runtimes'), options, target) })
  const bridge = new ModMindBridge(project, { modpackRunServerScenario: input => input.operation === 'state' ? service.read(project, input.taskId, input.waitSeconds || 0) : input.operation === 'cancel' ? service.cancel(project, input.taskId) : service.start(project, input) }, '1.4.19')
  let child
  let id = 0
  try {
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fsp.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    const call = async input => {
      const reply = await rpc(child, ++id, 'tools/call', { name: 'modmind_modpack_run_server_scenario', arguments: input })
      if (reply.result?.isError) throw new Error(JSON.stringify(reply.result))
      return JSON.parse(reply.result.content[0].text)
    }
    await rpc(child, ++id, 'tools/list')
    const started = await call({ operation: 'start', acceptEula: true, timeoutMs: 600000, fixture: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', jars }, steps: [
      { command: 'execute unless data storage modmind:fixture persisted run say FIXTURE_FRESH', expect: ['FIXTURE_FRESH'] },
      { command: 'data modify storage modmind:fixture persisted set value 1', expect: ['Modified storage'] },
      { operation: 'restart' },
      { command: 'execute if data storage modmind:fixture persisted run say FIXTURE_RESTART_OK', expect: ['FIXTURE_RESTART_OK'] }
    ] })
    console.log(JSON.stringify({ root, taskId: started.taskId, status: started.status }))
    let result
    do {
      result = await call({ operation: 'state', taskId: started.taskId, waitSeconds: 10 })
      console.log(JSON.stringify({ status: result.status, phase: result.phase, message: result.message, lastLogs: result.recentLogs.slice(-3) }))
    } while (result.status === 'running')
    await fsp.writeFile(path.join(root, 'smoke-result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ root, status: result.status, result: result.result, error: result.error }))
    if (result.status !== 'completed') process.exitCode = 1
  } finally {
    await service.stop()
    if (child && child.exitCode === null) { const close = new Promise(resolve => child.once('close', resolve)); child.kill(); await close }
    await bridge.stop(); await shutdownNetwork(); await diagnosticJournal.flush()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
