import { _electron as electron } from 'playwright'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url), workspace = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-shader-ui-'))
const output = path.join(workspace, 'test-results/shader-studio', String(Date.now()))
const profile = path.join(root, 'profile'), projects = path.join(root, 'projects')
let app, page, processLog = ''
const errors = [], scenarios = []
const modules = [
  { id: 'shader-source', page: 'shader-source', label: '光影源码', tools: ['modmind_shader_query', 'modmind_shader_edit'], query: 'modmind_shader_query' },
  { id: 'shader-options', page: 'shader-options', label: '光影选项', tools: ['modmind_shader_options_query', 'modmind_shader_options_edit'], query: 'modmind_shader_options_query' },
  { id: 'shader-preview', page: 'shader-preview', label: '效果预览', tools: ['modmind_shader_preview'], query: 'modmind_shader_preview' },
  { id: 'shader-testing', page: 'shader-test', label: '游戏验证', tools: ['modmind_shader_test_query', 'modmind_shader_test', 'modmind_shader_session'], query: 'modmind_shader_test_query' },
  { id: 'shader-export', page: 'shader-export', label: '检查与导出', tools: ['modmind_shader_validate', 'modmind_shader_export'], query: 'modmind_shader_validate' }
]
let mcp
async function waitFor(predicate, argument) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await page.evaluate(predicate, argument)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Shader UI state did not become ready')
}
async function invoke(id, action, input = {}) { return page.evaluate(({ id, action, input }) => window.modmind.featurePlugins.invoke(id, action, input), { id, action, input }) }
async function navigate(label) { await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: label, exact: true }).click() }
async function installModule(id, extension = 'mmfeature') {
  await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }) }, path.join(workspace, `feature-plugin-dist/${id}.${extension}`))
  const install = page.evaluate(() => window.modmind.featurePlugins.install()).catch(error => ({ error }))
  const trust = page.getByRole('dialog', { name: extension === 'mmstudio' ? '安装工作台' : '安装应用功能插件', exact: true })
  await trust.waitFor(); await trust.getByRole('button', { name: '信任并安装', exact: true }).click()
  const installed = await install
  assert.ok(!installed?.error, installed?.error?.message)
}
async function setModule(id, enabled) { await page.evaluate(({ id, enabled }) => window.modmind.featurePlugins.setEnabled(id, enabled), { id, enabled }) }
async function assertPages(activeIds) {
  for (const module of modules) {
    const button = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: module.label, exact: true })
    await button.waitFor({ state: activeIds.includes(module.id) ? 'attached' : 'detached' })
  }
}
async function connectMcp() {
  const state = await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  const config = JSON.parse(await fs.readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = '', sequence = 0
  const pending = new Map()
  child.stdout.on('data', chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); pending.get(value.id)?.(value); pending.delete(value.id) } })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Shader preview MCP timeout')) }, 10000)
    pending.set(id, value => { clearTimeout(timer); resolve(value) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return {
    names: async () => (await rpc('tools/list', {})).result.tools.map(tool => tool.name).filter(name => name.startsWith('modmind_shader_')).sort(),
    call: async (name, input = {}) => (await rpc('tools/call', { name, arguments: input })).result,
    close: async () => { child.kill(); await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false)) }
  }
}
function readMcp(result) { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text) }
async function verifyPreviewMcp() {
  assert.ok((await mcp.names()).includes('modmind_shader_preview'))
  const image = await mcp.call('modmind_shader_preview', { operation: 'preview-image' })
  assert.ok(image.content.some(content => content.type === 'image'))
  assert.equal(readMcp(image).gameVerified, false)
  scenarios.push('actual application MCP tool discovery and source-matched final preview image content block')
}
async function zipIris(file) {
  await new Promise((resolve, reject) => { const zip = require('archiver')('zip'), stream = createWriteStream(file); stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); zip.pipe(stream); zip.append('{"id":"iris","version":"qa-fixture"}', { name: 'fabric.mod.json' }); void zip.finalize().catch(reject) })
}
async function canvasPixels(name) {
  const canvas = page.locator('.shader-scene canvas')
  await canvas.waitFor()
  await page.waitForTimeout(400)
  const dataUrl = await canvas.evaluate(node => node.toDataURL('image/png'))
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
  const stats = await require('sharp')(buffer).stats()
  await fs.writeFile(path.join(output, `${name}-canvas.png`), buffer)
  assert.ok(stats.channels.slice(0, 3).some(channel => channel.stdev > 15), `${name}: scene is nonblank and has visible geometry ${stats.channels.map(channel => channel.stdev)}`)
  await page.screenshot({ path: path.join(output, `${name}.png`) })
  return buffer
}
try {
  await fs.mkdir(profile); await fs.mkdir(projects); await fs.mkdir(output, { recursive: true })
  const bootstrap = path.join(root, 'bootstrap.cjs')
  await fs.writeFile(bootstrap, `const {app,ipcMain}=require('electron');const originalHandle=ipcMain.handle;ipcMain.handle=function(channel,handler){return originalHandle.call(this,channel,async(...args)=>{try{return await handler(...args)}catch(error){if(channel==='feature-plugins:invoke')console.error('[Shader QA invocation]',args[1],args[2]);throw error}})};app.setName('modmind-shader-qa');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});require(${JSON.stringify(require.resolve('undici'))}).request=async()=>{throw Error('Shader QA offline')};global.fetch=async()=>{throw Error('Shader QA offline')};require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 60000 })
  app.process().stdout?.on('data', value => { processLog += value }); app.process().stderr?.on('data', value => { processLog += value })
  await app.firstWindow({ timeout: 60000 })
  for (let i = 0; i < 100; i++) { page = app.windows().find(window => window.url().includes('/renderer/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(page); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await waitFor(() => Boolean(window.modmind?.studios))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced')); await page.reload()
  const close = page.getByRole('button', { name: '关闭更新日志' }); if (await close.isVisible().catch(() => false)) await close.click()
  await waitFor(async () => (await window.modmind.studios.list()).filter(record => record.available).length === 3)
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const initialCreate = page.getByRole('dialog', { name: '新建项目', exact: true })
  await initialCreate.getByRole('button', { name: '模组', exact: true }).waitFor()
  assert.equal(await initialCreate.getByRole('button', { name: '自定义 +', exact: true }).count(), 0)
  assert.equal(await initialCreate.getByRole('button', { name: '光影', exact: true }).count(), 0)
  assert.equal(await initialCreate.getByText('色彩预设', { exact: true }).count(), 0)
  await initialCreate.getByRole('button', { name: '取消', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }) }, path.join(workspace, 'feature-plugin-dist/studio-shader.mmstudio'))
  const install = page.evaluate(() => window.modmind.featurePlugins.install())
  const trust = page.getByRole('dialog', { name: '安装工作台', exact: true }); await trust.waitFor(); await trust.getByRole('button', { name: '信任并安装', exact: true }).click(); await install
  await waitFor(async () => (await window.modmind.studios.list()).find(record => record.definition.id === 'minecraft-shader')?.available)
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新建项目', exact: true })
  await create.getByRole('button', { name: '光影', exact: true }).click(); await create.getByLabel('项目名称', { exact: true }).fill('Shader Studio QA')
  await page.screenshot({ path: path.join(output, 'create.png') })
  await page.setViewportSize({ width: 1080, height: 780 })
  const createBounds = await create.boundingBox()
  assert.ok(createBounds.x >= 0 && createBounds.x + createBounds.width <= await page.evaluate(() => innerWidth + 1))
  assert.equal(await create.getByRole('button', { name: '自定义 +', exact: true }).count(), 0)
  await page.screenshot({ path: path.join(output, 'create-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 850 })
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, projects)
  await create.getByRole('button', { name: '创建项目', exact: true }).click(); await create.waitFor({ state: 'hidden' })
  const project = await page.evaluate(() => window.modmind.project.current())
  assert.equal(project.studioId, 'minecraft-shader'); assert.equal(project.loader, 'iris')
  const context = await page.evaluate(folder => window.modmind.studios.context('workbench', folder), project.path)
  const inspiration = await page.evaluate(folder => window.modmind.studios.context('inspiration', folder), project.path)
  assert.notEqual(context.instructions, inspiration.instructions)
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '构建与导出', exact: true }).count(), 0)
  scenarios.push('offline module install, declaration-driven shader creation, independent profiles and shader-specific navigation')
  mcp = await connectMcp()
  assert.deepEqual(await mcp.names(), [])
  await assertPages([])
  for (const module of modules) {
    await installModule(module.id)
    await assertPages([module.id])
    assert.deepEqual(await mcp.names(), [...module.tools].sort())
    const inventory = readMcp(await mcp.call(module.query, { operation: 'inventory' }))
    assert.ok(inventory.files.some(file => file.path === 'shaders/final.fsh'))
    await setModule(module.id, false)
    await assertPages([])
    assert.deepEqual(await mcp.names(), [])
    assert.equal((await mcp.call(module.query, { operation: 'inventory' })).isError, true)
  }
  for (const module of modules) await setModule(module.id, true)
  await assertPages(modules.map(module => module.id))
  assert.deepEqual(await mcp.names(), modules.flatMap(module => module.tools).sort())
  scenarios.push('each of five optional packages installs independently with only its own page and actual MCP tools; disable removes both; enable restores all')
  await navigate('光影源码'); await page.locator('.shader-file-list').getByRole('button', { name: 'final.fsh', exact: true }).click()
  await page.locator('.shader-editor .monaco-editor').waitFor()
  await page.waitForTimeout(800)
  await page.locator('.shader-editor .monaco-editor .view-lines').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n// shader studio QA edit\n')
  await page.locator('.shader-toolbar').getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('文件已保存', { exact: true }).waitFor()
  assert.match(await fs.readFile(path.join(project.path, 'shaders/final.fsh'), 'utf8'), /shader studio QA edit/)
  await page.screenshot({ path: path.join(output, 'source.png') })
  await navigate('光影选项'); await page.getByLabel('曝光', { exact: true }).focus(); await page.keyboard.press('Home'); for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); await page.getByRole('button', { name: '保存选项', exact: true }).click()
  await page.getByText('选项已保存到源码', { exact: true }).waitFor()
  assert.match(await fs.readFile(path.join(project.path, 'shaders/lib/options.glsl'), 'utf8'), /#define EXPOSURE 1.5/)
  await page.getByRole('button', { name: '撤销上次保存', exact: true }).click()
  await page.getByText('上次保存已撤销', { exact: true }).waitFor(); assert.equal(await page.locator('[data-option="EXPOSURE"] output').textContent(), '1.0')
  await page.getByLabel('画质预设', { exact: true }).selectOption('VIVID'); await page.getByRole('button', { name: '保存选项', exact: true }).click(); await page.getByText('选项已保存到源码', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'options.png') }); scenarios.push('real Monaco edits, option presets, source readback and undo')
  const optionFile = path.join(project.path, 'shaders/lib/options.glsl'), propertyFile = path.join(project.path, 'shaders/shaders.properties'), languageFile = path.join(project.path, 'shaders/lang/zh_cn.lang')
  const savedOptions = await fs.readFile(optionFile, 'utf8'), savedProperties = await fs.readFile(propertyFile, 'utf8'), savedLanguage = await fs.readFile(languageFile, 'utf8')
  const advancedOptions = savedOptions + '\n#ifndef TEST_OPTIONS_GUARD\n#define TEST_OPTIONS_GUARD\n#define TAA\nconst int shadowMapResolution = 3072; // [1024 3072 4096]\nconst float shadowDistance = 112.0; // [48.0 112.0 224.0]\n#ifdef TAA\n#endif\n#endif\n'
  await fs.writeFile(optionFile, advancedOptions)
  await fs.writeFile(propertyFile, 'screen=[LIGHT] [POST]\nscreen.LIGHT=TAA shadowMapResolution shadowDistance\nscreen.POST=EXPOSURE SATURATION CONTRAST\nsliders=EXPOSURE SATURATION CONTRAST shadowDistance\nprofile.BASE=TAA EXPOSURE=1.0\nprofile.QUALITY=profile.BASE !TAA shadowMapResolution=4096 shadowDistance=224.0 !program.final\nprofile.INVALID=EXPOSURE=9\n')
  await fs.writeFile(languageFile, savedLanguage + '\noption.TAA=时间抗锯齿\noption.shadowMapResolution=阴影分辨率\noption.shadowDistance=阴影距离\nscreen.LIGHT=光照与阴影\nscreen.POST=后期处理\n')
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByLabel('阴影分辨率', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-option="TEST_OPTIONS_GUARD"]').count(), 0)
  await page.getByLabel('搜索光影选项').fill('阴影距离')
  assert.equal(await page.locator('.shader-option-row').count(), 1)
  await page.getByLabel('搜索光影选项').fill('not-found'); await page.getByText('没有匹配的选项', { exact: true }).waitFor()
  await page.getByLabel('搜索光影选项').fill(''); await page.getByLabel('选项分组').selectOption('screen.LIGHT')
  assert.equal(await page.locator('.shader-option-row').count(), 3)
  await page.getByLabel('选项分组').selectOption('')
  await page.getByLabel('画质预设', { exact: true }).selectOption('QUALITY')
  await page.getByRole('heading', { name: '程序修改', exact: true }).waitFor()
  assert.equal(await page.getByLabel('阴影分辨率', { exact: true }).inputValue(), '4096')
  assert.equal(await page.getByLabel('时间抗锯齿', { exact: true }).isChecked(), false)
  await page.locator('.shader-option-diagnostics summary').click(); await page.getByText(/INVALID：/).waitFor()
  await page.screenshot({ path: path.join(output, 'options-inherited-desktop.png') })
  await page.setViewportSize({ width: 1080, height: 780 }); await page.screenshot({ path: path.join(output, 'options-inherited-narrow.png') })
  const optionsOverflow = await page.locator('.shader-view-options').evaluate(node => node.scrollWidth > node.clientWidth + 1)
  assert.equal(optionsOverflow, false)
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await page.screenshot({ path: path.join(output, 'options-inherited-dark-narrow.png') })
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.getByRole('button', { name: '保存选项', exact: true }).click(); await page.getByText('选项已保存到源码', { exact: true }).waitFor()
  assert.match(await fs.readFile(optionFile, 'utf8'), /const int shadowMapResolution = 4096;/)
  assert.match(await fs.readFile(propertyFile, 'utf8'), /program.final.enabled=false/)
  const actualOptions = readMcp(await mcp.call('modmind_shader_options_query', { operation: 'inventory' }))
  assert.equal(actualOptions.options.find(option => option.name === 'shadowDistance').value, '224.0')
  assert.equal(actualOptions.programConditions.final, 'false')
  await page.getByRole('button', { name: '撤销上次保存', exact: true }).click(); await page.getByText('上次保存已撤销', { exact: true }).waitFor()
  assert.equal(await fs.readFile(optionFile, 'utf8'), advancedOptions)
  assert.doesNotMatch(await fs.readFile(propertyFile, 'utf8'), /program.final.enabled/)
  await fs.writeFile(optionFile, savedOptions); await fs.writeFile(propertyFile, savedProperties); await fs.writeFile(languageFile, savedLanguage)
  scenarios.push('inherited equals/boolean/const preset, internal guard exclusion, localized groups/search/empty results, invalid preset feedback, program save, actual MCP readback and multi-file undo at desktop/1080px')
  await navigate('效果预览')
  const day = await canvasPixels('preview-day')
  await waitFor(() => Boolean(document.querySelector('.shader-scene canvas')?.dataset.shaderSourceHash))
  const previewImage = await invoke('shader-preview', 'query', { operation: 'preview-image' })
  assert.match(previewImage.dataUrl, /^data:image\/png;base64,/); assert.equal(previewImage.gameVerified, false)
  await verifyPreviewMcp()
  const finalFile = await invoke('shader-source', 'query', { operation: 'read', path: 'shaders/final.fsh' })
  await invoke('shader-source', 'edit', { operation: 'save', path: finalFile.path, content: finalFile.content + '\n// changed after preview\n', revision: finalFile.revision })
  await assert.rejects(invoke('shader-preview', 'query', { operation: 'preview-image' }), /旧源码/)
  const changedFinal = await invoke('shader-source', 'query', { operation: 'read', path: finalFile.path })
  await invoke('shader-source', 'edit', { operation: 'save', path: finalFile.path, content: finalFile.content, revision: changedFinal.revision })
  const canvas = page.locator('.shader-scene canvas'), box = await canvas.boundingBox()
  assert.ok(box.width > 500 && box.height > 300)
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 15 }); await page.mouse.up()
  const moved = await canvasPixels('preview-orbit'); assert.notDeepEqual(day, moved)
  await page.getByRole('button', { name: '夜间', exact: true }).click(); const night = await canvasPixels('preview-night'); assert.notDeepEqual(day, night)
  await page.setViewportSize({ width: 1080, height: 780 }); await canvasPixels('preview-narrow')
  assert.equal(await page.locator('.shader-preview-error').count(), 0)
  await page.setViewportSize({ width: 1280, height: 850 }); scenarios.push('actual project final shader rendering, source-matched image readback, stale preview rejection, nonblank canvas pixels, orbit interaction, day/night and 1080px preview')
  await navigate('检查与导出'); await page.getByRole('button', { name: '检查光影', exact: true }).click(); await page.getByText(/静态检查通过/).waitFor()
  const destination = path.join(root, 'exported.zip')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, destination)
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click(); await page.getByText(`已导出：${destination}`, { exact: true }).waitFor(); assert.ok((await fs.stat(destination)).size > 500)
  await page.screenshot({ path: path.join(output, 'export.png') }); scenarios.push('syntax check and user-chosen ZIP export with source metadata excluded')
  const instance = path.join(root, 'game-instance'); await fs.mkdir(path.join(instance, 'mods'), { recursive: true }); await fs.mkdir(path.join(instance, 'logs')); await fs.mkdir(path.join(instance, 'screenshots'))
  await zipIris(path.join(instance, 'mods', 'iris.jar')); await fs.writeFile(path.join(instance, 'logs/latest.log'), 'old unrelated log\n')
  await fs.writeFile(path.join(instance, 'screenshots', '2026-10-05_qa-scene.png'), day)
  await navigate('游戏验证')
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, instance)
  await page.getByRole('button', { name: '选择实例', exact: true }).click(); await waitFor(() => !document.querySelector('.shader-game-controls .primary-button')?.disabled)
  await page.getByRole('button', { name: '部署光影', exact: true }).click(); await page.getByText(/光影包已部署/).waitFor()
  const state = await invoke('shader-testing', 'query', { operation: 'test-state' }); assert.equal(state.log.packMentioned, false)
  await fs.appendFile(path.join(instance, 'logs/latest.log'), `QA fixture selected ${path.basename(state.deployed.path)}\nIris shader error QA fixture\n`)
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByText(/日志包含包名称/).waitFor()
  assert.equal((await invoke('shader-testing', 'query', { operation: 'test-state' })).log.issues.length, 1)
  await page.screenshot({ path: path.join(output, 'test-evidence-fixture.png') })
  scenarios.push('fixture Iris metadata, user-selected instance deployment, new log evidence and real image rendering; no actual game launch claimed')
  await page.getByRole('button', { name: '隔离测试', exact: true }).click()
  await page.getByText(/隔离会话暂适配 Minecraft 26.2/).waitFor()
  assert.equal(await page.getByRole('button', { name: '启动测试', exact: true }).isDisabled(), true)
  const missingRuntime = path.join(root, 'incomplete-runtime-fixture')
  for (const directory of ['versions', 'libraries', 'assets']) await fs.mkdir(path.join(missingRuntime, directory), { recursive: true })
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, missingRuntime)
  await page.getByRole('button', { name: '选择运行库', exact: true }).click()
  await page.getByText(/没有完整的 Minecraft 1.21.1/).waitFor()
  const capability = readMcp(await mcp.call('modmind_shader_test_query', { operation: 'capabilities' }))
  assert.equal(capability.ready, false); assert.equal(capability.runtimeVerified, false)
  assert.equal((await mcp.call('modmind_shader_test', { operation: 'bind-runtime' })).isError, true)
  assert.equal((await mcp.call('modmind_shader_test', { operation: 'bind-runtime', runtimeRoot: missingRuntime })).isError, true)
  assert.ok((await mcp.call('modmind_shader_test_query', { operation: 'test-state' })).content.some(content => content.type === 'image'))
  await page.screenshot({ path: path.join(output, 'session-unavailable-desktop.png') })
  await page.setViewportSize({ width: 1080, height: 780 }); await page.screenshot({ path: path.join(output, 'session-unavailable-narrow.png') })
  assert.equal(await page.locator('.shader-view-test').evaluate(node => node.scrollWidth > node.clientWidth + 1), false)
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await page.screenshot({ path: path.join(output, 'session-unavailable-dark-narrow.png') })
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 850 }); await page.getByRole('button', { name: '手动部署', exact: true }).click()
  scenarios.push('isolated session UI, explicit unsupported version/dependency feedback, interactive runtime binding, actual MCP capabilities and external-path refusal, light/dark desktop/1080px without horizontal overflow')
  const persistedFinal = await fs.readFile(path.join(project.path, 'shaders/final.fsh'), 'utf8')
  for (const module of modules) {
    await setModule(module.id, false)
    const active = modules.filter(other => other.id !== module.id).map(other => other.id)
    await assertPages(active)
    assert.deepEqual(await mcp.names(), modules.filter(other => other.id !== module.id).flatMap(other => other.tools).sort())
    await page.evaluate(id => window.modmind.featurePlugins.uninstall(id), module.id)
    await assertPages(active)
    assert.equal((await mcp.call(module.query, { operation: 'inventory' })).isError, true)
    assert.equal(await fs.readFile(path.join(project.path, 'shaders/final.fsh'), 'utf8'), persistedFinal)
    await installModule(module.id)
    await assertPages(modules.map(other => other.id))
  }
  scenarios.push('each optional package disables and uninstalls without affecting other pages/tools or source files; reinstall restores it')
  await mcp.close(); mcp = undefined
  const external = path.join(root, 'external-shader'); await fs.cp(project.path, external, { recursive: true, filter: source => !['.modmind', 'build', 'modmind.project.json'].includes(path.basename(source)) })
  const original = await fs.readFile(path.join(external, 'shaders/final.fsh'), 'utf8')
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, external)
  const analysis = await page.evaluate(() => window.modmind.project.inspectExisting('folder')); assert.equal(analysis.studio.id, 'minecraft-shader')
  const adopted = await page.evaluate(input => window.modmind.project.adoptExisting(input), { ...analysis.inferred, sourcePath: external }); assert.equal(adopted.studioId, 'minecraft-shader')
  assert.equal(await fs.readFile(path.join(external, 'shaders/final.fsh'), 'utf8'), original)
  await page.evaluate(folder => window.modmind.project.openRecent(folder), project.path)
  for (const module of modules) await setModule(module.id, false)
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('studio-shader', false)); await page.reload(); await page.locator('.project-launcher').waitFor()
  const row = page.locator('.recent-project-row').filter({ has: page.getByText('Shader Studio QA', { exact: true }) })
  assert.equal(await row.locator('.recent-project-main').isDisabled(), true); await row.getByText('需要下载光影工作台', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'unavailable.png') })
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('studio-shader', true))
  for (const module of modules) await setModule(module.id, true)
  await page.evaluate(folder => window.modmind.project.openRecent(folder), project.path); await page.reload()
  await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await navigate('效果预览'); await page.setViewportSize({ width: 1080, height: 780 }); await canvasPixels('preview-dark-narrow')
  await navigate('光影选项'); await page.locator('[data-option="EXPOSURE"] output').waitFor(); await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ state: 'visible' }); await page.waitForTimeout(250); await page.screenshot({ path: path.join(output, 'options-dark-narrow.png') })
  const sidebarPreference = await page.evaluate(() => localStorage.getItem('modmind-sidebar-collapsed'))
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click(); assert.equal(await page.locator('.sidebar.collapsed').count(), 0)
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click(); await page.locator('.sidebar.collapsed').waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('modmind-sidebar-collapsed')), sidebarPreference)
  scenarios.push('in-place source adoption preserves GLSL; missing domain gray state/recovery; dark narrow viewport')
  assert.deepEqual(errors, [])
  const result = { success: true, output, scenarios, errors, actualGameVerified: false }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await fs.writeFile(path.join(output, 'process.log'), processLog)
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await mcp?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
}
