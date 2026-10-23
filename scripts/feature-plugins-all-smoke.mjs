import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..')
const packagedRoot = process.env.MODMIND_FEATURE_PACKAGED ? path.resolve(process.env.MODMIND_FEATURE_PACKAGED) : undefined
const appRoot = packagedRoot ? path.join(packagedRoot, 'resources/app.asar') : root
const pluginRoot = process.env.MODMIND_FEATURE_ARCHIVES ? path.resolve(process.env.MODMIND_FEATURE_ARCHIVES) : path.join(root, 'feature-plugin-dist')
const work = path.join(root, 'test-results/feature-plugins-all', String(Date.now()))
const profile = path.join(work, 'profile'), projectRoot = path.join(os.tmpdir(), 'modmind-all-features-' + Date.now())
await mkdir(profile, { recursive: true }); await mkdir(projectRoot, { recursive: true })
const catalog = JSON.parse(await readFile(path.join(root, 'feature-plugin-dist/catalog.json'), 'utf8'))
await writeFile(path.join(profile, 'service-config.json'), '{}')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app,session}=require('electron'); app.setName('ModMind All Feature QA'); app.setPath('userData',${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(appRoot)}); app.getVersion=()=> '1.5.0-plugintest'; ${packagedRoot ? `Object.defineProperty(app,'isPackaged',{get:()=>true}); Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(path.join(packagedRoot, 'resources'))}});` : ''} const realFetch=globalThis.fetch; globalThis.fetch=(input,options)=>{const url=String(input?.url||input); return /^https?:/.test(url)&&!url.startsWith('http://127.0.0.1:')?Promise.reject(new Error('Offline feature QA')):realFetch(input,options)}; app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>done({cancel:!request.url.startsWith('http://127.0.0.1:')}))); globalThis.__featureQaHost=require(${JSON.stringify(path.join(appRoot, 'out/main/index.js'))}).nativeFeatureHost;`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let app, page, mcp, sequence = 0
const errors = [], results = [], pending = new Map()
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)) }, 15000)
  pending.set(id, value => { clearTimeout(timer); resolve(value) }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
async function openProject(kind, loader = 'fabric') {
  const target = path.join(projectRoot, kind)
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'modmind.project.json'), JSON.stringify({ name: 'Feature QA ' + kind, namespace: 'feature_qa', kind, loader, minecraftVersion: '1.21.1', path: target, createdAt: '', projectVersion: '1.5.0-plugintest' }))
  if (kind === 'modpack') await writeFile(path.join(target, 'modmind.pack.json'), JSON.stringify({ version: 1, name: 'Feature QA modpack', loader, minecraftVersion: '1.21.1', mods: [], modules: [] }))
  await page.evaluate(directory => window.modmind.project.openRecent(directory), target)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' }); await page.locator('.app-shell').waitFor()
  return target
}
async function select(label) {
  const button = page.locator('#main-sidebar').getByRole('button', { name: label, exact: true, includeHidden: true })
  const caption = button.locator('..').locator('..').locator('.nav-caption')
  if (await caption.count() && await caption.getAttribute('aria-expanded') === 'false') await caption.click()
  await button.click()
  await page.waitForTimeout(150)
}
try {
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app-shell').waitFor(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.setTitle('ModMind All Feature QA'); window.webContents.setBackgroundThrottling(false) }))
  await app.evaluate(() => {
    const service = globalThis.__featureQaHost().featurePluginService
    const active = globalThis.__featureQaCalls = new Map()
    const invoke = service.invoke.bind(service)
    service.invoke = async (id, action, ...args) => {
      const key = Symbol(); active.set(key, { id, action, startedAt: Date.now() })
      try { return await invoke(id, action, ...args) } finally { active.delete(key) }
    }
  })
  const java = await openProject('mod')
  const absent = await page.evaluate(() => window.modmind.featurePlugins.catalog())
  assert.equal(absent.length, catalog.length); assert.ok(absent.every(feature => feature.state === 'not-installed'))
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  const state = await page.evaluate(() => window.modmind.mcpBridge.getState())
  assert.ok(state.mcpConfigPath, JSON.stringify(state))
  const config = JSON.parse(await readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  mcp = spawn(config.command, config.args, { cwd: root, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  mcp.stdout.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      pending.get(value.id)?.(value); pending.delete(value.id)
    }
  })
  const owned = new Set(catalog.flatMap(feature => feature.tools ?? []).map(tool => tool.name))
  assert.ok((await rpc('tools/list')).result.tools.every(tool => !owned.has(tool.name)))
  const discover = await rpc('tools/call', { name: 'modmind_feature_catalog', arguments: {} })
  assert.equal(JSON.parse(discover.result.content[0].text).features.length, catalog.length)
  await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: path.join(work, 'core-only.png') })
  await select('设置'); await page.getByRole('button', { name: '集成', exact: true }).click()
  for (const feature of catalog) {
    await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }) }, path.join(pluginRoot, feature.id + '.mmfeature'))
    await page.getByRole('button', { name: '安装功能插件', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '安装应用功能插件', exact: true })
    await dialog.waitFor(); await dialog.getByRole('button', { name: '信任并安装', exact: true }).click()
    await page.locator(`script[src="modmind-feature://${feature.id}/renderer.js"]`).waitFor({ state: 'attached' })
    await page.locator('#settings-feature-plugins .feature-plugin-row').filter({ has: page.getByText(feature.name, { exact: true }) }).getByText(/已启用/).waitFor()
    const installed = await page.evaluate(() => window.modmind.featurePlugins.list())
    assert.ok(installed.some(value => value.id === feature.id && !value.error), JSON.stringify(installed))
    results.push({ plugin: feature.id, install: 'passed' })
  }
  assert.equal((await page.evaluate(() => window.modmind.featurePlugins.list())).length, catalog.length)
  const listed = (await rpc('tools/list')).result.tools
  assert.ok([...owned].every(name => listed.some(tool => tool.name === name)))
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args })
    assert.ok(!result.result?.isError, JSON.stringify(result)); return JSON.parse(result.result.content[0].text)
  }
  await call('modmind_items_query', { operation: 'list' })
  await call('modmind_items_query', { operation: 'catalog' })
  await call('modmind_image_studio_info', {})
  await call('modmind_sound_library', { operation: 'list' })
  const studio = await call('modmind_sound_library', { operation: 'draft' })
  studio.draft.mode = 'music'; studio.draft.eventId = 'qa/plugin_music'
  studio.draft.music.bars = 1; studio.draft.music.drums = Array(16).fill(false)
  studio.draft.music.tracks[0].notes[0] = [0, 4, 8, 12]
  const music = await page.evaluate(draft => window.modmind.featurePlugins.invoke('sound-studio', 'create', { operation: 'export', draft }), studio.draft)
  assert.equal(music.exported, true)
  results.push({ plugin: 'sound-studio', backgroundMusicExport: 'passed' })
  for (const label of ['物品与装备', '资源包', '声音', '图像工坊', '模型', '前置与联动', 'Mappings', '反编译', '版本记录', '发布']) {
    const button = page.locator('#main-sidebar').getByRole('button', { name: label, exact: true, includeHidden: true })
    if (!await button.count()) continue
    await select(label)
    if (label === '声音') {
      await page.getByRole('tab', { name: '制作', exact: true }).click()
      await page.frameLocator('iframe[title="BeepBox 音乐编辑器"]').locator('.beepboxEditor').waitFor()
      await page.screenshot({ path: path.join(work, 'sound-music-editor.png') })
      results.push({ plugin: 'sound-studio', offlineBeepBoxEditor: 'passed' })
    }
    if (label === '模型') {
      let state
      for (let attempt = 0; attempt < 80; attempt++) { state = await page.evaluate(() => window.modmind.blockbench.getState()); if (state.status === 'ready' || state.phase === 'ready' || state.connected) break; await page.waitForTimeout(250) }
      assert.ok(state.connected || state.phase === 'ready' || state.status === 'ready', JSON.stringify(state))
      assert.equal(state.visible, true, 'Native model viewport is hidden')
      await page.evaluate(() => window.modmind.blockbench.executeActions([{ type: 'new-model', format: 'java_block', name: 'Plugin QA cube' }, { type: 'add-cube', name: 'Plugin QA cube', from: [0, 0, 0], to: [16, 16, 16] }]))
      const capture = await rpc('tools/call', { name: 'modmind_blockbench_capture_views', arguments: { views: ['north'], width: 512, height: 512 } })
      assert.ok(!capture.result.isError, JSON.stringify(capture))
      const picture = capture.result.content.find(value => value.type === 'image')
      assert.ok(picture, JSON.stringify(capture))
      const bytes = Buffer.from(picture.data, 'base64'), pixels = await sharp(bytes).removeAlpha().raw().toBuffer()
      await writeFile(path.join(work, 'model-capture.png'), bytes)
      const colors = new Map()
      for (let offset = 0; offset < pixels.length; offset += 3) { const color = pixels.subarray(offset, offset + 3).toString('hex'); colors.set(color, (colors.get(color) ?? 0) + 1) }
      const dominant = Math.max(...colors.values()) / (pixels.length / 3)
      assert.ok(colors.size >= 2 && dominant < .95, `Model capture is blank or badly framed: ${colors.size} colors, ${dominant} dominant`)
      results.push({ plugin: 'model-studio', editableModelAndCapture: 'passed' })
      const original = await page.evaluate(() => window.modmind.blockbench.projectState())
      for (const width of [1280, 1080]) {
        await page.setViewportSize({ width, height: 800 })
        void page.evaluate(() => window.modmind.app.close()).catch(() => {})
        const closeDialog = page.getByRole('dialog', { name: '关闭 ModMind', exact: true })
        await closeDialog.waitFor()
        await page.waitForFunction(async () => !(await window.modmind.blockbench.getState()).visible)
        await page.screenshot({ path: path.join(work, `model-close-dialog-${width}.png`) })
        await closeDialog.getByRole('button', { name: '取消', exact: true }).click()
        await closeDialog.waitFor({ state: 'hidden' })
        await page.waitForFunction(async () => (await window.modmind.blockbench.getState()).visible)
        assert.equal((await page.evaluate(() => window.modmind.blockbench.projectState())).revision, original.revision)
      }
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.locator('.hosted-titlebar-button').click()
      const accountDialog = page.getByRole('dialog', { name: 'ModMind 设备连接', exact: true })
      await accountDialog.waitFor()
      await page.waitForFunction(async () => !(await window.modmind.blockbench.getState()).visible)
      await page.setViewportSize({ width: 1080, height: 760 })
      assert.equal((await page.evaluate(() => window.modmind.blockbench.getState())).visible, false)
      await accountDialog.getByRole('button', { name: '关闭', exact: true }).click()
      await page.waitForFunction(async () => (await window.modmind.blockbench.getState()).visible)
      await page.setViewportSize({ width: 1280, height: 800 })
      results.push({ plugin: 'model-studio', nativeModalOcclusionAndRestore: 'passed' })
    }
    assert.ok(!(await page.locator('.main-content').innerText()).includes('插件界面加载失败'))
    await page.screenshot({ path: path.join(work, 'java-' + label + '.png') })
  }
  const imageWindow = app.waitForEvent('window')
  void imageWindow.catch(() => undefined)
  await page.evaluate(() => window.modmind.app.openDetachedWindow('image-studio', 'Image Studio Plugin QA'))
  const detachedImage = await imageWindow
  await detachedImage.getByRole('tablist', { name: '图像工坊模式' }).waitFor()
  assert.ok(await detachedImage.evaluate(() => window.modmind.imageStudio.getSettings()))
  await detachedImage.screenshot({ path: path.join(work, 'detached-image-studio.png') })
  await detachedImage.close()
  const mainModel = await page.evaluate(() => window.modmind.blockbench.projectState())
  const modelWindow = app.waitForEvent('window')
  void modelWindow.catch(() => undefined)
  await page.evaluate(() => window.modmind.app.openDetachedWindow('blockbench', 'Model Plugin QA'))
  const detachedModel = await modelWindow
  await detachedModel.locator('.bb-workspace').waitFor()
  for (let attempt = 0; attempt < 80; attempt++) { const status = await detachedModel.evaluate(() => window.modmind.blockbench.getState()); if (status.connected) break; await detachedModel.waitForTimeout(250) }
  await detachedModel.evaluate(() => window.modmind.blockbench.executeActions([{ type: 'new-model', format: 'java_block', name: 'Detached QA cube' }, { type: 'add-cube', name: 'Detached cube', from: [0, 0, 0], to: [8, 8, 8] }]))
  assert.equal((await page.evaluate(() => window.modmind.blockbench.projectState())).project.name, mainModel.project.name)
  await detachedModel.close()
  results.push({ detachedImageStudioAndIndependentModel: 'passed' })
  const pack = await openProject('modpack')
  await page.evaluate(() => window.modmind.modpack.get())
  for (const label of catalog.filter(feature => feature.id.startsWith('modpack-') || ['ftb-quests', 'patchouli'].includes(feature.id)).flatMap(feature => feature.views ?? []).map(view => view.label)) {
    const button = page.locator('#main-sidebar').getByRole('button', { name: label, exact: true, includeHidden: true })
    if (!await button.count()) continue
    await select(label)
    assert.ok(!(await page.locator('.main-content').innerText()).includes('插件界面加载失败'))
    results.push({ page: label, project: 'modpack', render: 'passed' })
  }
  await select('设置'); await page.getByRole('button', { name: '集成', exact: true }).click()
  for (const dark of [false, true]) for (const width of [1280, 1080]) {
    await page.evaluate(darkMode => window.dispatchEvent(new StorageEvent('storage', { key: 'modmind-appearance:v1', newValue: JSON.stringify({ themePreset: 'modmind', darkMode }) })), dark)
    await page.setViewportSize({ width, height: 800 })
    await page.screenshot({ path: path.join(work, `plugins-${dark ? 'dark' : 'light'}-${width}.png`) })
    assert.ok(await page.locator('.main-content').evaluate(element => element.scrollWidth <= element.clientWidth + 2))
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  for (const feature of [...catalog].reverse()) {
    for (let attempt = 0; ; attempt++) {
      try { await page.evaluate(id => window.modmind.featurePlugins.setEnabled(id, false), feature.id); break }
      catch (error) { if (attempt >= 240 || !String(error).includes('请等待')) throw error; await page.waitForTimeout(250) }
    }
  }
  assert.ok((await page.evaluate(() => window.modmind.featurePlugins.catalog())).every(feature => feature.state === 'disabled'))
  for (const feature of [...catalog].reverse()) await page.evaluate(id => window.modmind.featurePlugins.uninstall(id), feature.id)
  assert.deepEqual(await page.evaluate(() => window.modmind.featurePlugins.list()), [])
  await page.getByText('尚未安装应用功能插件', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ result: 'PASS', pluginCount: catalog.length, java, pack, results }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', work, pluginCount: catalog.length }))
} catch (error) {
  if (page) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {})
  const activeCalls = await app?.evaluate(() => [...(globalThis.__featureQaCalls?.values() ?? [])]).catch(() => [])
  console.error(JSON.stringify({ work, errors, results, activeCalls })); throw error
} finally { mcp?.kill(); await app?.close() }
