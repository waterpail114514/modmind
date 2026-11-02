import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'))
const isFeature = await access(path.join(root, 'feature-plugins/versions/main.ts')).then(() => true, () => false)
const work = path.join(root, 'test-results/snapshot-batch', String(Date.now()))
const profile = path.join(work, 'profile'), project = path.join(os.tmpdir(), 'modmind-snapshot-batch-' + path.basename(work), 'project'), other = path.join(os.tmpdir(), 'modmind-snapshot-batch-' + path.basename(work), 'other')
await mkdir(profile, { recursive: true })
await writeFile(path.join(profile, 'service-config.json'), '{}')
for (const directory of [project, other]) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'modmind.project.json'), JSON.stringify({ name: '快照批量删除验证', namespace: 'snapshot_qa', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1', path: directory, createdAt: new Date().toISOString(), projectVersion: '0.1.0' }))
  await writeFile(path.join(directory, 'keep.txt'), 'current project must remain unchanged')
}
const output = path.join(work, 'build')
await cp(path.join(root, 'out'), output, { recursive: true })
// Expose a test-only bridge factory in this isolated copy. All snapshot handlers and feature routing remain production code.
const mainFile = path.join(output, 'main/index.js')
const source = await readFile(mainFile, 'utf8')
await writeFile(mainFile, source + `\nexports.__snapshotQa = { openBridge: async (readOnly) => {
  if (globalThis.snapshotQaBridge) await globalThis.snapshotQaBridge.stop();
  const project = requireProject();
  const handlers = ${isFeature ? 'featureAgentHandlers(project, new AbortController().signal)' : `{
    snapshotQuery: async input => snapshotListPage(project.path, await listSnapshotSummaries(project.path), input),
    snapshotDelete: async input => { const result = await deleteProjectSnapshots(input.ids, project.path); return { projectPath: project.path, deletedIds: result.deletedIds, failed: result.failed, remainingCount: result.snapshots.length } }
  }`};
  handlers.reviewAction = async () => { globalThis.snapshotQaReviews = (globalThis.snapshotQaReviews || 0) + 1; return { approved: true }; };
  const bridge = globalThis.snapshotQaBridge = new ModMindBridge(project, handlers, 'snapshot-qa', undefined, readOnly);
  const result = await bridge.start(); await bridge.writeMcpConfig(result.mcpConfigPath); return result.mcpConfigPath;
}};\n`)
const validator = path.join(work, 'validator.cjs')
if (isFeature) await build({ stdin: { contents: "export { prepareFeaturePlugin } from './src/main/featurePluginService'", resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: validator })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const native = require('electron'); const {app, session} = native;
app.setName('ModMind Snapshot QA'); app.setPath('userData',${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)});
const Module = require('node:module'), original = Module._load;
native.BrowserWindow.prototype.show = function() {};
const QuietWindow = new Proxy(native.BrowserWindow, { construct: (target, args) => Reflect.construct(target, [{...args[0], show:false}]) });
Module._load = function(n,...args) { return n === 'electron' ? new Proxy(native,{get:(t,k)=>k==='BrowserWindow'?QuietWindow:Reflect.get(t,k)}) : original.call(this,n,...args); };
const realFetch=globalThis.fetch;globalThis.fetch=(input,options)=> /^https?:/.test(String(input?.url||input))&&!String(input?.url||input).startsWith('http://127.0.0.1:') ? Promise.reject(new Error('Offline snapshot QA')) : realFetch(input,options);
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>done({cancel:!request.url.startsWith('http://127.0.0.1:')})));
globalThis.snapshotQaModule = require(${JSON.stringify(mainFile)});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let app, page, child, sequence = 0
const pending = new Map(), errors = [], checks = []
async function connect(readOnly = false, standalone = false) {
  if (child) { child.stdin.end(); child.kill(); child = undefined }
  const configPath = await app.evaluate(async (_, readOnly) => globalThis.snapshotQaModule.__snapshotQa.openBridge(readOnly), readOnly)
  const config = JSON.parse(await readFile(configPath, 'utf8')).mcpServers.modmind
  child = spawn(config.command, standalone ? [path.join(root, 'modmind-mcp-open-source/src/mcp-server.mjs')] : config.args, { cwd: root, env: { ...env, ...config.env, MODMIND_BRIDGE_CONFIG: path.join(path.dirname(configPath), 'bridge.json') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(value.id)?.(value); pending.delete(value.id) } })
}
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)) }, 15000)
  pending.set(id, value => { clearTimeout(timer); resolve(value) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const call = (name, args) => rpc('tools/call', { name, arguments: args })
const decode = response => { assert.ok(!response.result?.isError, JSON.stringify(response)); return JSON.parse(response.result.content[0].text) }
try {
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  await page.context().addInitScript(() => { localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, status: 'done', phase: 'experience', fieldIndex: 0 })); localStorage.setItem('modmind-ui-mode', 'advanced') })
  await page.reload(); await page.locator('.app-shell').waitFor(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.evaluate(directory => window.modmind.project.openRecent(directory), project)
  if (isFeature) {
    await app.evaluate(async (_, { validator, archive }) => { const require = process.mainModule.require.bind(process.mainModule); const prepared = await require(validator).prepareFeaturePlugin(archive); await globalThis.snapshotQaModule.nativeFeatureHost().featurePluginService.install(prepared) }, { validator, archive: path.join(root, 'feature-plugin-dist/versions.mmfeature') })
  }
  await page.reload(); await page.locator('.app-shell').waitFor(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  const snapshots = await page.evaluate(async directory => {
    const result = []
    for (const label of ['保留手动快照', '清理迁移备份', '清理AI恢复备份', ...Array.from({ length: 24 }, (_, n) => `清理临时 ${n}`)]) result.push(await window.modmind.snapshots.create(label, directory))
    return result
  }, project)
  const protectedMigration = snapshots[1], protectedAi = snapshots[2]
  const migration = path.join(project, '.modmind/migrations/migration-protect'); await mkdir(migration, { recursive: true })
  await writeFile(path.join(migration, 'migration.json'), JSON.stringify({ id: 'migration-protect', mode: 'backup', status: 'complete', createdAt: '', sourceSnapshotId: protectedMigration.id }))
  await writeFile(path.join(project, '.modmind/active-ai-task.json'), JSON.stringify({ taskId: 'qa-task', projectPath: project, snapshotId: protectedAi.id, prompt: 'temporary QA protection', state: {} }))
  if (!await page.getByRole('checkbox', { name: '专业模式', exact: true }).isChecked()) await page.locator('.expert-mode-toggle').click()
  const nav = page.getByRole('button', { name: '版本记录', exact: true }).first()
  await nav.waitFor({ state: 'attached' })
  if (!await nav.isVisible()) { const caption = nav.locator('..').locator('..').locator('button[aria-expanded]').first(); if (await caption.count()) await caption.click() }
  await nav.click(); await page.locator('.snapshot-selection-bar').waitFor()
  await page.getByRole('textbox', { name: '搜索版本' }).fill('清理')
  await page.getByRole('checkbox', { name: '全选筛选结果', exact: true }).check()
  await page.getByRole('button', { name: '删除所选（26）', exact: true }).waitFor()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1080, 680); window.webContents.setBackgroundThrottling(false) })
  await page.screenshot({ path: path.join(work, 'light-1080-selection.png'), fullPage: true })
  await page.getByRole('button', { name: '删除所选（26）', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await page.evaluate(directory => window.modmind.snapshots.list(directory), project)).length, 27)
  checks.push('cancel leaves all selected snapshots intact')
  await page.getByRole('button', { name: '删除所选（26）', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '永久删除 26 个快照', exact: true }).click()
  await page.getByText('已删除 24 个快照，2 个未删除', { exact: true }).first().waitFor()
  assert.equal((await page.evaluate(directory => window.modmind.snapshots.list(directory), project)).length, 3)
  assert.ok((await page.locator('.snapshot-batch-result.error').innerText()).includes('恢复'))
  await page.screenshot({ path: path.join(work, 'light-1080-partial.png'), fullPage: true })
  await page.evaluate(async () => { const settings = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({ ...settings, darkMode: true }) })
  await page.locator('.app-shell.dark-mode').waitFor()
  await page.screenshot({ path: path.join(work, 'dark-1080-partial.png'), fullPage: true })
  assert.equal(await readFile(path.join(project, 'keep.txt'), 'utf8'), 'current project must remain unchanged')
  checks.push('all filtered rows selected across virtualized pages; protected migration/AI snapshots retained; current files intact')
  const mcpSnapshots = await page.evaluate(async directory => [await window.modmind.snapshots.create('MCP A', directory), await window.modmind.snapshots.create('MCP B', directory)], project)
  await connect()
  const tools = (await rpc('tools/list')).result.tools
  assert.ok(tools.some(tool => tool.name === 'modmind_version_query')); assert.ok(tools.some(tool => tool.name === 'modmind_version_manage'))
  const first = decode(await call('modmind_version_query', { operation: 'snapshots', limit: 1 }))
  assert.equal(first.snapshots.length, 1); assert.equal(first.total, 5); assert.equal(first.nextOffset, 1)
  for (const args of [{ operation: 'deleteSnapshots', ids: [mcpSnapshots[0].id], confirmed: false }, { operation: 'deleteSnapshots', ids: ['..'], confirmed: true }, { operation: 'deleteSnapshots', ids: [mcpSnapshots[0].id], confirmed: true, projectPath: other }]) assert.equal((await call('modmind_version_manage', args)).result.isError, true)
  const removed = decode(await call('modmind_version_manage', { operation: 'deleteSnapshots', ids: [mcpSnapshots[0].id, protectedMigration.id], confirmed: true }))
  assert.deepEqual(removed.deletedIds, [mcpSnapshots[0].id]); assert.equal(removed.failed[0].id, protectedMigration.id)
  checks.push('embedded stdio MCP discovery, pagination, confirmation, validation, project boundary and partial result')
  await connect(true)
  decode(await call('modmind_version_query', { operation: 'snapshots' }))
  assert.equal((await call('modmind_version_manage', { operation: 'deleteSnapshots', ids: [mcpSnapshots[1].id], confirmed: true })).result.isError, true)
  checks.push('read-only MCP allows queries and denies deletion')
  await connect(false, true)
  await page.evaluate(directory => window.modmind.project.openRecent(directory), other)
  assert.equal(decode(await call('modmind_version_query', { operation: 'snapshots' })).projectPath, project)
  assert.deepEqual(decode(await call('modmind_version_manage', { operation: 'deleteSnapshots', ids: [mcpSnapshots[1].id], confirmed: true })).deletedIds, [mcpSnapshots[1].id])
  assert.equal(await readFile(path.join(other, 'keep.txt'), 'utf8'), 'current project must remain unchanged')
  checks.push('standalone stdio MCP keeps original project scope after foreground project switches')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ status: 'passed', root, work, checks, errors }, null, 2))
  console.log(JSON.stringify({ status: 'passed', work, checks }))
} catch (error) {
  await page?.screenshot({ path: path.join(work, 'failure.png'), fullPage: true }).catch(() => {})
  const features = isFeature ? await page?.evaluate(() => window.modmind.featurePlugins.catalog()).catch(() => null) : undefined
  await writeFile(path.join(work, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, features }, null, 2)); throw error
} finally {
  if (child) { child.stdin.end(); child.kill() }
  await app?.evaluate(async () => globalThis.snapshotQaBridge?.stop()).catch(() => {})
  await app?.close()
}
