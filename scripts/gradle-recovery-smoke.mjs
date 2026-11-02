import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const coreMode = process.argv.includes('--core')
const work = path.join(root, 'test-results/gradle-recovery', String(Date.now()))
const project = path.join(work, 'project'), profile = path.join(work, 'profile')
await fs.mkdir(project, { recursive: true }); await fs.mkdir(profile, { recursive: true })
await fs.writeFile(path.join(profile, 'service-config.json'), '{}')
const metadata = { name: 'Build recovery QA', namespace: 'build_recovery', kind: 'mod', loader: 'forge', minecraftVersion: '1.20.1', path: project, createdAt: '' }
await fs.writeFile(path.join(project, 'modmind.project.json'), JSON.stringify(metadata))
await fs.writeFile(path.join(project, 'build.gradle'), '// Isolated process-lifecycle fixture; no Minecraft download or compilation.')
const validator = path.join(work, 'validator.cjs')
await build({ stdin: { contents: "export { prepareFeaturePlugin } from './src/main/featurePluginService'", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: validator })
const packageRoot = path.resolve(process.env.MODMIND_FEATURE_PACKAGED ?? path.join(root, 'release/win-unpacked'))
const executablePath = path.join(packageRoot, 'ModMind.exe')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let application, child, server
const pending = new Map(); let id = 0
const rpc = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP timeout: ' + method)) }, 25_000)
  pending.set(requestId, value => { clearTimeout(timer); resolve(value) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
})
const call = async (name, args = {}) => {
  const reply = await rpc('tools/call', { name, arguments: args })
  assert.ok(!reply.error && !reply.result?.isError, JSON.stringify(reply))
  return JSON.parse(reply.result.content[0].text)
}
try {
  application = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile], cwd: packageRoot, env, timeout: 30_000 })
  const page = await application.firstWindow()
  await page.locator('.app-shell').waitFor({ timeout: 30_000 })
  const fixture = path.join(project, 'wrapper-fixture.cjs'), started = path.join(project, 'started.json')
  await fs.writeFile(fixture, `if(process.argv.includes('--stop')) process.exit(0); require('fs').writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid,options:process.env.JAVA_TOOL_OPTIONS})); console.log('QA managed build is waiting'); setInterval(()=>{},1000);`)
  const wrapper = path.join(project, 'gradlew.bat')
  await fs.writeFile(wrapper, `@echo off\r\nchcp 65001 >nul\r\n"${process.execPath}" "wrapper-fixture.cjs" %*\r\n`)
  const runtime = await application.evaluate(async ({ app, dialog, session }, { validator, metadata, root, wrapper, coreMode }) => {
    const require = process.mainModule.require.bind(process.mainModule), path = require('node:path')
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: true })
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
    const host = require(path.join(app.getAppPath(), 'out/main/index.js')).nativeFeatureHost()
    host.currentProject = metadata
    const service = host.featurePluginService, prepare = require(validator).prepareFeaturePlugin
    if (!coreMode) for (const id of ['server-pack-runtime-data', 'server-pack-runtime', 'testing']) await service.install(await prepare(path.join(root, 'feature-plugin-dist', id + '.mmfeature')))
    const runtime = coreMode ? host.requireMinecraftRuntime() : service.service('testing').minecraftRuntime
    const environment = runtime.gradleEnvironment({ javaHome: 'fixture-java', executable: wrapper, usesWrapper: true, source: 'wrapper' })
    runtime.gradleRuntime = async () => ({ javaHome: 'fixture-java', executable: wrapper, usesWrapper: true, source: 'wrapper' })
    globalThis.__buildRecoveryQA = { host, runtime, prepare }
    return { version: app.getVersion(), options: environment.JAVA_TOOL_OPTIONS, testingVersion: service.list().find(record => record.id === 'testing')?.version ?? null }
  }, { validator, metadata, root, wrapper, coreMode })
  assert.equal(runtime.testingVersion, coreMode ? null : '1.0.5')
  assert.equal(runtime.version, coreMode ? '1.5.0-preview.5' : '1.5.0-preview.4')
  assert.match(runtime.options, /-Dsun.net.client.defaultReadTimeout=60000/)
  assert.match(runtime.options, /-Dorg.gradle.internal.http.socketTimeout=60000/)
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  const bridge = await page.evaluate(() => window.modmind.mcpBridge.getState())
  const configuration = JSON.parse(await fs.readFile(bridge.mcpConfigPath, 'utf8')).mcpServers.modmind
  child = spawn(configuration.command, configuration.args, { env: { ...process.env, ...configuration.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(value.id)?.(value); pending.delete(value.id) } })
  const names = (await rpc('tools/list')).result.tools.map(tool => tool.name)
  for (const name of coreMode ? ['modmind_build_project'] : ['modmind_build_status', 'modmind_cancel_build']) assert.ok(names.includes(name), name)
  assert.equal((await call(coreMode ? 'modmind_build_project' : 'modmind_build_status', coreMode ? { operation: 'state' } : {})).status, 'idle')
  let buildTask
  if (coreMode) {
    buildTask = await call('modmind_build_project', { operation: 'start', waitSeconds: 0 })
    assert.equal(buildTask.status, 'running')
    assert.ok(buildTask.taskId)
  } else await page.evaluate(directory => { globalThis.__buildResult = window.modmind.minecraft.buildProject(directory).then(value => ({ value }), error => ({ error: String(error) })); return true }, project)
  for (let count = 0; count < 150 && !await fs.stat(started).catch(() => null); count++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await fs.stat(started).catch(() => null), JSON.stringify(await page.evaluate(() => Promise.race([globalThis.__buildResult, new Promise(resolve => setTimeout(() => resolve('build pending'), 1000))]))))
  const processRecord = JSON.parse(await fs.readFile(started, 'utf8'))
  assert.match(processRecord.options, /-Dsun.net.client.defaultReadTimeout=60000/)
  const running = coreMode ? await call('modmind_build_project', { operation: 'state', taskId: buildTask.taskId }) : await call('modmind_build_status')
  assert.equal(running.status, 'running')
  if (coreMode) {
    const busy = await application.evaluate(async ({}, archive) => {
      const { host, prepare } = globalThis.__buildRecoveryQA
      try { await host.featurePluginService.install(await prepare(archive)); return false }
      catch (error) { return String(error) }
    }, path.join(root, 'feature-plugin-dist/server-pack-runtime-data.mmfeature'))
    assert.match(busy, /任务完成后再更改插件/)
  }
  if (!coreMode) {
    const denied = await application.evaluate(async () => {
      const { host } = globalThis.__buildRecoveryQA
      try { await host.featurePluginService.invoke('testing', 'cancel_build', {}, { projectPath: host.currentProject.path, surface: 'workbench', readOnly: true }); return false }
      catch (error) { return String(error) }
    })
    assert.match(denied, /READ_ONLY/)
  }
  const cancelled = coreMode ? await call('modmind_build_project', { operation: 'cancel', taskId: buildTask.taskId, waitSeconds: 10 }) : await call('modmind_cancel_build')
  assert.equal(cancelled.status, 'cancelled')
  const idle = coreMode ? await application.evaluate(() => globalThis.__buildRecoveryQA.runtime.buildRecoveryState()) : await call('modmind_build_status')
  assert.equal(idle.status, 'idle')
  assert.match(coreMode ? cancelled.error : (await page.evaluate(() => globalThis.__buildResult)).error, /取消|cancel/i)
  assert.throws(() => process.kill(processRecord.pid, 0), /ESRCH/)
  if (coreMode) {
    await application.evaluate(() => {
      const { host } = globalThis.__buildRecoveryQA
      globalThis.__queueHold = host.withMinecraftResourceLock(() => new Promise(resolve => { globalThis.__releaseQueueHold = resolve }))
      return true
    })
    const queued = await call('modmind_build_project', { waitSeconds: 0 })
    assert.equal(queued.status, 'running')
    const cancelledQueue = await call('modmind_build_project', { operation: 'cancel', taskId: queued.taskId, waitSeconds: 1 })
    assert.equal(cancelledQueue.status, 'cancelled')
    await application.evaluate(async () => { globalThis.__releaseQueueHold(); await globalThis.__queueHold })
    assert.deepEqual(JSON.parse(await fs.readFile(started, 'utf8')), processRecord)
  }
  const sockets = new Set()
  server = createServer((_request, _response) => {})
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const java = path.join(work, 'DownloadTimeoutProbe.java')
  await fs.writeFile(java, `import java.net.*; public class DownloadTimeoutProbe { public static void main(String[] args) throws Exception { try { new URL(args[0]).openConnection().getInputStream().read(); throw new RuntimeException("No timeout"); } catch (SocketTimeoutException expected) { System.out.println("SOCKET_TIMEOUT_VERIFIED"); } } }`)
  const output = await new Promise((resolve, reject) => {
    const probe = spawn('java', [java, 'http://127.0.0.1:' + server.address().port], { env: { ...process.env, JAVA_TOOL_OPTIONS: runtime.options.replace('defaultReadTimeout=60000', 'defaultReadTimeout=1000') }, windowsHide: true })
    let text = ''; probe.stdout.on('data', chunk => { text += chunk }); probe.stderr.on('data', chunk => { text += chunk })
    probe.once('error', reject); probe.once('close', code => code === 0 ? resolve(text) : reject(new Error(text)))
  })
  assert.match(output, /SOCKET_TIMEOUT_VERIFIED/)
  for (const socket of sockets) socket.destroy()
  const report = { success: true, runtime, realWorkbenchMcp: true, cancellationRoute: coreMode ? 'core-build-task-mcp' : 'testing-feature-mcp', processCancelledAndReaped: true, queuedBuildCancelledWithoutSpawn: coreMode, featureChangesBlockedDuringCoreBuild: coreMode, readOnlyCancellationDenied: coreMode ? null : true, realJavaSocketTimeout: true, actualMinecraftCompilation: false }
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, report: path.join(work, 'report.json') }, null, 2))
} finally {
  child?.kill()
  await application?.close()
  server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve())
}
