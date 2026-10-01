import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const work = path.join(root, 'test-results/testing-feature', String(Date.now())), profile = path.join(work, 'profile'), project = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-testing-feature-'))
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project, { recursive: true })
await fs.writeFile(path.join(profile, 'service-config.json'), '{}')
await fs.writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: 'Testing Feature QA', namespace: 'testing_qa', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', path: project, createdAt: '', projectVersion: '1.5.0-plugintest' }))
await fs.writeFile(path.join(project, 'modmind.pack.json'), JSON.stringify({ version: 1, name: 'Testing Feature QA', loader: 'fabric', minecraftVersion: '1.21.1', mods: [], modules: [] }))
const catalog = JSON.parse(await fs.readFile(path.join(root, 'feature-release/features/stable/catalog.json'), 'utf8'))
const requests = [], errors = [], results = [], pending = new Map()
let offline = false, app, page, mcp, sequence = 0
const server = createServer(async (req, res) => {
  requests.push({ method: req.method, path: req.url })
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (offline) { res.writeHead(503); res.end('QA offline'); return }
  if (req.url === '/features/stable/catalog.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(catalog)); return }
  const release = catalog.features.find(feature => '/' + feature.path === req.url)
  if (!release) { res.writeHead(404); res.end(); return }
  const bytes = await fs.readFile(path.join(root, 'feature-release', release.path))
  res.setHeader('content-length', bytes.length); res.end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port, bootstrap = path.join(work, 'bootstrap.cjs')
await fs.writeFile(bootstrap, `const {app,session,dialog}=require('electron');app.setName('ModMind Testing Feature QA');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});app.getVersion=()=>'1.5.0-plugintest';Object.defineProperty(app,'isPackaged',{get:()=>true});
const undici=require(${JSON.stringify(require.resolve('undici'))}),request=undici.request;undici.request=(url,options)=>{const p=new URL(String(url));return p.hostname==='mmdesktop.cn-nb1.rains3.com'?request('http://127.0.0.1:${port}'+p.pathname,{...options,dispatcher:undefined}):Promise.reject(new Error('Offline testing QA'))};
const fetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=String(input?.url||input);return /^https?:/.test(url)&&!url.startsWith('http://127.0.0.1:')?Promise.reject(new Error('Offline testing QA')):fetch(input,options)};
dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_request,done)=>done({cancel:true})));
globalThis.__testingHost=require(${JSON.stringify(path.join(root,'out/main/index.js'))}).nativeFeatureHost;`)
async function until(check) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('QA state did not settle') }
async function select(label) {
  const button = page.locator('#main-sidebar').getByRole('button', { name: label, exact: true, includeHidden: true })
  const caption = button.locator('..').locator('..').locator('.nav-caption')
  if (await caption.count() && await caption.getAttribute('aria-expanded') === 'false') await caption.click()
  await button.click()
}
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)) }, 30000)
  pending.set(id, value => { clearTimeout(timer); resolve(value) }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const call = async (name, args = {}, succeeds = true) => {
  const response = await rpc('tools/call', { name, arguments: args })
  assert.equal(Boolean(response.result?.isError || response.error), !succeeds, JSON.stringify(response))
  return response.result
}
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app-shell').waitFor(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.evaluate(directory => window.modmind.project.openRecent(directory), project)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced')); await page.reload()
  await page.locator('#app-loading').waitFor({ state: 'hidden' }); await page.locator('.app-shell').waitFor()
  assert.equal(await page.locator('#main-sidebar').getByRole('button', { name: '游戏测试', exact: true }).count(), 0)
  assert.equal(await page.locator('#main-sidebar').getByRole('button', { name: '服务端测试', exact: true }).count(), 0)
  const build = await page.evaluate(directory => window.modmind.minecraft.buildProject(directory), project)
  assert.equal(build.projectArtifact, true)
  assert.equal(await app.evaluate(() => Boolean(globalThis.__testingHost().featurePluginService.activeService('testing'))), false)
  results.push({ check: 'core build works without test code or installed test plugins', artifact: build })
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  const bridge = await page.evaluate(() => window.modmind.mcpBridge.getState())
  const config = JSON.parse(await fs.readFile(bridge.mcpConfigPath, 'utf8')).mcpServers.modmind
  mcp = spawn(config.command, config.args, { cwd: root, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  mcp.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1); pending.get(value.id)?.(value); pending.delete(value.id) } })
  const toolNames = new Set(JSON.parse(await fs.readFile(path.join(root,'feature-plugin-dist/testing/manifest.json'),'utf8')).tools.map(tool => tool.name))
  assert.ok((await rpc('tools/list')).result.tools.every(tool => !toolNames.has(tool.name)))
  const discovery = JSON.parse((await call('modmind_feature_catalog')).content[0].text)
  assert.equal(discovery.features.find(feature => feature.id === 'testing').state, 'not-installed')
  await call('modmind_test_matrix', { targets: ['server'] }, false)
  await page.evaluate(() => window.modmind.featurePlugins.installOfficial('testing'))
  await until(() => page.locator('#main-sidebar').getByRole('button', { name: '游戏测试', exact: true, includeHidden: true }).count())
  assert.ok((await page.evaluate(() => window.modmind.featurePlugins.list())).some(feature => feature.id === 'server-pack-runtime' && feature.enabled))
  const listed = (await rpc('tools/list')).result.tools.map(tool => tool.name)
  assert.ok([...toolNames].every(name => listed.includes(name)))
  const restrictions = await app.evaluate(async directory => {
    const service = globalThis.__testingHost().featurePluginService
    const denied = async context => {
      try { await service.invoke('testing', 'test_matrix', { targets: ['build'] }, { projectPath: directory, ...context }); return false }
      catch (error) { return String(error) }
    }
    return { inspirationTools: service.tools('inspiration').filter(tool => tool.pluginId === 'testing').length, readOnly: await denied({ readOnly: true }), inspiration: await denied({ surface: 'inspiration' }) }
  }, project)
  assert.equal(restrictions.inspirationTools, 0)
  assert.match(restrictions.readOnly, /READ_ONLY/)
  assert.match(restrictions.inspiration, /SURFACE_DENIED/)
  await call('modmind_runtime_state')
  await call('modmind_test_session', { operation: 'capabilities' })
  await call('modmind_test_matrix', { targets: ['invalid'] }, false)
  await call('modmind_modpack_build_server', { outputDirectory: '../outside' }, false)
  const matrix = await call('modmind_test_matrix', { targets: ['build', 'server'] })
  const matrixResult = JSON.parse(matrix.content[0].text)
  assert.equal(matrixResult.success, true, JSON.stringify(matrixResult))
  assert.ok(matrixResult.results.every(result => result.status === 'passed'), JSON.stringify(matrixResult))
  for (const result of matrixResult.results) if (result.logPath) assert.ok((await fs.stat(result.logPath)).isFile())
  results.push({ check: 'real MCP discovery, schema/project checks, build and server-pack matrix', result: matrixResult })
  const resource = await app.evaluate(() => globalThis.__testingHost().featurePluginService.service('server-pack-runtime').resource('ServerPackCreator-8.1.2.jar'))
  assert.ok(resource.startsWith(profile))
  assert.equal(createHash('sha256').update(await fs.readFile(resource)).digest('hex'), '6ecb5f604326a8cb74ede15f667d170e2001cd968ab7f99592a0045ff27b0fca')
  // A damaged local cache must be rebuilt from the installed, verified chunks.
  await fs.writeFile(resource, 'damaged cache')
  const repaired = await app.evaluate(() => globalThis.__testingHost().featurePluginService.service('server-pack-runtime').resource('ServerPackCreator-8.1.2.jar'))
  assert.equal(createHash('sha256').update(await fs.readFile(repaired)).digest('hex'), '6ecb5f604326a8cb74ede15f667d170e2001cd968ab7f99592a0045ff27b0fca')
  for (const [width, dark] of [[1440,false],[780,true],[390,true]]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(darkMode => window.dispatchEvent(new StorageEvent('storage', { key: 'modmind-appearance:v1', newValue: JSON.stringify({ themePreset: 'modmind', darkMode }) })), dark)
    for (const label of ['游戏测试','服务端测试']) {
      const expand = page.getByRole('button', { name: '展开侧栏', exact: true })
      if (await expand.count()) await expand.click()
      await select(label)
      if (width < 700) await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: path.join(work, `${label}-${width}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  offline = true
  await call('modmind_runtime_state')
  await call('modmind_local_server', { operation: 'state' })
  await page.evaluate(async () => { try { await window.modmind.featurePlugins.setEnabled('server-pack-runtime', false); throw new Error('Dependency was disabled') } catch (error) { if (String(error).includes('Dependency was disabled')) throw error } })
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('testing', false))
  await until(async () => !(await page.locator('#main-sidebar').getByRole('button', { name: '游戏测试', exact: true, includeHidden: true }).count()))
  await call('modmind_runtime_state', {}, false)
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('testing', true))
  await call('modmind_local_server', { operation: 'state' })
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('testing'))
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('server-pack-runtime'))
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('server-pack-runtime-data'))
  assert.ok((await fs.stat(path.join(project,'.modmind','test-server-pack'))).isDirectory())
  assert.ok((await rpc('tools/list')).result.tools.every(tool => !toolNames.has(tool.name)))
  await page.locator('.expert-mode-toggle').click()
  assert.equal(await page.getByRole('checkbox', { name: '专业模式' }).isChecked(), false)
  const testButton = page.locator('.titlebar').getByRole('button', { name: '测试', exact: true })
  // The beginner entry must surface a download failure, then recover on retry.
  await testButton.click()
  await until(() => testButton.isEnabled())
  assert.equal(await page.getByRole('dialog', { name: '游戏测试', exact: true }).count(), 0)
  assert.ok(!(await page.evaluate(() => window.modmind.featurePlugins.list())).some(feature => feature.id === 'testing'))
  offline = false
  await testButton.click()
  const quick = page.getByRole('dialog', { name: '游戏测试', exact: true })
  await quick.waitFor()
  // Cancel the real preparation task before downloading the complete game.
  const cancel = quick.getByRole('button', { name: '取消测试', exact: true })
  await cancel.waitFor()
  await app.evaluate(async () => {
    const service = globalThis.__testingHost().featurePluginService
    try { await service.setEnabled('testing', false); throw new Error('Running testing feature was disabled') }
    catch (error) { if (!String(error).includes('请等待当前插件任务或工作台任务完成')) throw error }
  })
  await cancel.click()
  await quick.getByRole('button', { name: '重新测试', exact: true }).waitFor()
  await page.screenshot({ path: path.join(work, 'quick-test-cancelled.png'), animations: 'disabled' })
  await quick.getByRole('button', { name: '返回创作', exact: true }).last().click()
  await quick.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('testing'))
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('server-pack-runtime'))
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('server-pack-runtime-data'))
  assert.ok(requests.every(request => request.method === 'GET'))
  assert.deepEqual(errors, [])
  results.push({ check: 'offline state, dependency protection, disable/re-enable/uninstall, preserved project results, repaired JAR cache, beginner automatic installation, failed download retry and cancelled game preparation', passed: true })
  await fs.writeFile(path.join(work,'report.json'),JSON.stringify({results,requests,errors},null,2))
  console.log(JSON.stringify({work,results},null,2))
} catch(error) {
  await page?.screenshot({path:path.join(work,'failure.png')}).catch(()=>undefined)
  await fs.writeFile(path.join(work,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors,requests,results},null,2))
  console.error('Testing feature QA failed:',work,error);process.exitCode=1
} finally { mcp?.kill(); await app?.close(); await new Promise(resolve=>server.close(resolve)) }
