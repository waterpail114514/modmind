import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/feature-plugins', String(Date.now()))
const profile = path.join(work, 'profile'), project = path.join(os.tmpdir(), 'modmind-feature-project-' + Date.now())
const archive = path.join(root, 'feature-plugin-dist/image-studio.mmfeature')
const packagedRoot = process.env.MODMIND_FEATURE_PACKAGED
await mkdir(profile, { recursive: true }); await mkdir(project, { recursive: true })
await writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: '插件验收', namespace: 'feature_test', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: project, createdAt: '', projectVersion: '1.5.0-plugintest' }))
await writeFile(path.join(profile, 'service-config.json'), '{}')
const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#33aa99' } }).png().toBuffer()
const dataUrl = 'data:image/png;base64,' + png.toString('base64')
const fixturePath = path.join(work, 'sample.png'); await writeFile(fixturePath, png)
const requests = []
let failNext = false
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'plugin-test-model' }] })); return }
  if (req.url === '/v1/images/generations') {
    if (failNext) { failNext = false; res.writeHead(503); res.end('fixture retry'); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks)))
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return
  }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
let app, page, mcp, rpcId = 0, previewTested = false
const errors = [], pending = new Map()
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++rpcId, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)) }, 20000)
  pending.set(id, value => { clearTimeout(timeout); resolve(value) }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
async function launch() {
  const bootstrap = path.join(work, 'bootstrap.cjs')
  const appRoot = packagedRoot ? path.join(packagedRoot, 'resources/app.asar') : root
  await writeFile(bootstrap, `const { app, session } = require('electron');
app.setName('modmind-feature-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(appRoot)});
const realFetch = globalThis.fetch; globalThis.fetch = (input, options) => { const url = String(input?.url || input); if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:')) return Promise.reject(new Error('Offline smoke test')); return realFetch(input, options) };
app.getVersion = () => '1.5.0-plugintest'; Object.defineProperty(app, 'isPackaged', { get: () => true });
${packagedRoot ? `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(path.join(packagedRoot, 'resources'))} });` : ''}
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (request, done) => done({ cancel: !request.url.startsWith('http://127.0.0.1:') })));
require(${JSON.stringify(path.join(appRoot, 'out/main/index.js'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => void dialog.dismiss().catch(() => {}))
  await page.locator('.app-shell').waitFor(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)))
}
async function settings() { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:openSettings')); await page.getByRole('button', { name: '集成', exact: true }).click(); await page.locator('#settings-feature-plugins').waitFor() }
async function install() {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }, archive)
  await settings(); await page.getByRole('button', { name: '安装功能插件', exact: true }).click()
  let confirmation = page.getByRole('dialog', { name: '安装应用功能插件', exact: true })
  await confirmation.waitFor()
  if (!previewTested) {
    assert.deepEqual(await page.evaluate(() => window.modmind.featurePlugins.list()), [])
    await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.modmind.featurePlugins.list()), [])
    await page.getByRole('button', { name: '安装功能插件', exact: true }).click(); await confirmation.waitFor()
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      await page.evaluate(darkMode => window.dispatchEvent(new StorageEvent('storage', { key: 'modmind-appearance:v1', newValue: JSON.stringify({ themePreset: 'modmind', darkMode }) })), dark)
      await page.setViewportSize({ width, height: 800 })
      assert.ok(await confirmation.evaluate(e => e.scrollWidth <= e.clientWidth + 1))
      const box = await confirmation.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width)
      await page.screenshot({ path: path.join(work, `install-dialog-${dark ? 'dark' : 'light'}-${width}.png`) })
    }
    for (let index=0; index<6; index++) { await page.keyboard.press('Tab'); assert.ok(await confirmation.evaluate(e => e.contains(document.activeElement))) }
    await page.setViewportSize({width:1280,height:800}); previewTested = true
  }
  await confirmation.getByRole('button', { name: '信任并安装' }).click()
  await page.locator('#settings-feature-plugins').getByText(/已启用/).waitFor()
  await page.waitForFunction(() => document.querySelector('script[src="modmind-feature://image-studio/renderer.js"]'))
}
async function studio() {
  const button = page.locator('#main-sidebar').getByRole('button', { name: '图像工坊', exact: true, includeHidden: true })
  const caption = button.locator('..').locator('..').locator('.nav-caption')
  if (await caption.count() && await caption.getAttribute('aria-expanded') === 'false') await caption.click()
  await button.click(); await page.getByRole('tablist', { name: '图像工坊模式' }).waitFor()
}
try {
  await launch()
  assert.deepEqual(await page.evaluate(() => window.modmind.featurePlugins.list()), [])
  assert.equal(await page.locator('#main-sidebar').getByRole('button', { name: '图像工坊', exact: true, includeHidden: true }).count(), 0)
  await page.evaluate(target => window.modmind.project.openRecent(target), project)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced')); await page.reload(); await page.locator('.app-shell').waitFor()
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false))
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  let state
  for (let attempt = 0; attempt < 80; attempt++) { state = await page.evaluate(() => window.modmind.mcpBridge.getState()); if (state?.mcpConfigPath) break; await new Promise(resolve => setTimeout(resolve, 250)) }
  assert.ok(state?.mcpConfigPath, 'MCP state: ' + JSON.stringify(state))
  const config = JSON.parse(await readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  mcp = spawn(config.command, config.args, { cwd: root, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''; mcp.stdout.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id) } catch {} } })
  const list = await rpc('tools/list')
  assert.ok(!list.result.tools.some(tool => tool.name === 'modmind_image_generate'))
  await settings(); await page.screenshot({ path: path.join(work, 'without-plugin.png') })
  await install()
  await page.evaluate(async baseUrl => { const saved = await window.modmind.imageStudio.getSettings(); await window.modmind.imageStudio.saveSettings({ ...saved, apiKey: 'local-fixture-key', baseUrl, model: 'plugin-test-model' }) }, baseUrl)
  assert.ok((await rpc('tools/list')).result.tools.some(tool => tool.name === 'modmind_image_generate'))
  const info = await rpc('tools/call', { name: 'modmind_image_studio_info', arguments: { includeModels: true } })
  assert.equal(info.result.isError, undefined); assert.ok(info.result.content[0].text.includes('plugin-test-model'))
  assert.ok(!info.result.content[0].text.includes('local-fixture-key'))
  const generated = await page.evaluate(() => window.modmind.imageStudio.generate({ prompt: 'fixture image', style: 'free', size: '1024x1024', quality: 'low', moderation: 'auto', count: 1, background: 'auto', backgroundColor: '#ffffff', removeBackground: false, source: 'manual' }))
  assert.equal(generated.assets.length, 1); assert.equal(requests.length, 1)
  const processed = await page.evaluate(data => window.modmind.imageStudio.process('perfect-pixel', data, { perfectPixel: { gridSize: [16,16] } }), dataUrl)
  assert.ok(processed.dataUrl.startsWith('data:image/png;base64,'))
  const saved = await page.evaluate(data => window.modmind.imageStudio.saveToProject(data, 'plugin-smoke'), dataUrl)
  assert.deepEqual(await readFile(path.join(project, saved)), png)
  const readback = await rpc('tools/call', { name: 'modmind_image_read_project_asset', arguments: { path: saved } })
  assert.equal(readback.result.isError, undefined)
  await studio()
  await page.getByRole('button', { name: '运行工作流', exact: true }).click()
  await page.locator('.image-workflow-node-output[data-output-status=done]').waitFor()
  await page.locator('.image-workflow-library-actions').getByRole('button', { name: '保存', exact: true }).click()
  const storedWorkflows = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('modmind-image-workflows', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { const db = request.result, get = db.transaction('library').objectStore('library').get('current'); get.onsuccess = () => { resolve(get.result); db.close() } }
  }))
  assert.ok(storedWorkflows.workflows.length > 0)
  assert.equal(requests.length, 2)
  for (const dark of [false, true]) for (const width of [1280, 760]) {
    await page.evaluate(darkMode => window.dispatchEvent(new StorageEvent('storage', { key: 'modmind-appearance:v1', newValue: JSON.stringify({ themePreset: 'modmind', darkMode }) })), dark)
    await page.setViewportSize({ width, height: 800 })
    await page.screenshot({ path: path.join(work, `studio-${dark ? 'dark' : 'light'}-${width}.png`) })
    assert.ok(await page.locator('.main-content').evaluate(e => e.scrollWidth <= e.clientWidth + 2))
  }
  await page.getByRole('tab', { name: '处理', exact: true }).click()
  await page.locator('#image-panel-process input[type=file]').setInputFiles(fixturePath)
  await page.locator('.image-process-preview img').waitFor()
  await page.getByRole('button', { name: '纯色去背', exact: true }).click()
  await page.getByRole('button', { name: '撤销上一步', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '在编辑器中打开', exact: true }).click()
  await page.locator('.image-edit-layout iframe').waitFor()
  await page.locator('.minipaint-loading').waitFor({ state: 'hidden' })
  await page.screenshot({ path: path.join(work, 'editor.png') })
  await settings(); await page.getByRole('button', { name: '停用', exact: true }).click(); await page.getByRole('button', { name: '停用插件', exact: true }).click()
  await page.locator('#settings-feature-plugins').getByText(/已停用/).waitFor()
  assert.ok(!(await rpc('tools/list')).result.tools.some(tool => tool.name === 'modmind_image_generate'))
  const unavailable = await rpc('tools/call', { name: 'modmind_image_studio_info', arguments: {} }); assert.equal(unavailable.result.isError, true)
  await page.getByRole('button', { name: '启用', exact: true }).click(); await page.locator('#settings-feature-plugins').getByText(/已启用/).waitFor()
  await studio()
  mcp.kill(); mcp = null; await app.close(); app = null
  await launch(); await studio()
  assert.equal((await page.evaluate(() => window.modmind.imageStudio.getSettings())).model, 'plugin-test-model')
  await settings(); await page.getByRole('button', { name: '卸载', exact: true }).click(); await page.getByRole('button', { name: '卸载插件', exact: true }).click()
  await page.getByText('尚未安装应用功能插件', { exact: true }).waitFor()
  await install(); await studio()
  assert.equal((await page.evaluate(() => window.modmind.imageStudio.getSettings())).model, 'plugin-test-model')
  assert.equal((await page.evaluate(() => window.modmind.imageStudio.history())).length, 2)
  await page.locator('.image-workflow-node-output[data-output-status=done]').waitFor()
  failNext = true
  const failed = await page.evaluate(async () => { try { await window.modmind.imageStudio.generate({ prompt: 'retry', model: 'plugin-test-model', style: 'free', count: 1 }); return '' } catch (error) { return String(error) } })
  assert.ok(failed.includes('503'))
  const retried = await page.evaluate(() => window.modmind.imageStudio.generate({ prompt: 'retry', model: 'plugin-test-model', style: 'free', count: 1 }))
  assert.equal(retried.assets.length, 1)
  await settings()
  await page.locator('#settings-feature-plugins').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(work, 'plugin-settings.png') })
  await page.locator('.settings-categories').getByRole('button', { name: 'AI 与图像', exact: true }).click()
  await page.locator('#settings-image').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(work, 'image-settings.png') })
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ result: 'PASS', packagedRoot, cases: ['fresh offline host', 'install without restart', 'native renderer and settings', 'generation against local API fixture', 'PerfectPixel', 'save and MCP readback', 'dynamic MCP discovery', 'UI import/process/editor', 'themes and narrow window', 'disable/enable', 'restart', 'uninstall/reinstall preserves data'] }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', work }))
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(-7000)) }
  console.error({ work, errors }); throw error
} finally { mcp?.kill(); if (app) await app.close(); server.close() }
