import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createDeveloperAgent } from './developer-agent-fixture.mjs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const require = createRequire(import.meta.url)
const workspace = path.resolve(import.meta.dirname, '..')
const output = path.join(workspace, 'test-results/developer-workbench', String(Date.now()))
const profile = path.join(output, 'profile'), projects = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-developer-ui-'))
await fs.mkdir(profile, { recursive: true })
const agent = await createDeveloperAgent(path.join(output, 'agent-fixture'))
const bootstrap = path.join(output, 'bootstrap.cjs')
const offline = path.join(output, 'offline.cjs')
await fs.writeFile(offline, `
const local=host=>['localhost','127.0.0.1','::1','[::1]'].includes(host);
const allowed=value=>{try{if(typeof value==='string'||value instanceof URL)return local(new URL(value).hostname);return local(value?.hostname||value?.host||'localhost')}catch{return false}};
for(const name of ['node:http','node:https']){const api=require(name);for(const method of ['request','get']){const original=api[method];api[method]=function(...args){if(!allowed(args[0]))throw Error('Offline developer QA');return original.apply(this,args)}}}
if(global.fetch){const original=global.fetch;global.fetch=(url,...args)=>{if(!allowed(url))return Promise.reject(Error('Offline developer QA'));return original(url,...args)}}
`)
await fs.writeFile(bootstrap, `const {app}=require('electron');app.setName('modmind-developer-smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});require(${JSON.stringify(require.resolve('undici'))}).request=async()=>{throw Error('Developer QA offline')};global.fetch=async()=>{throw Error('Developer QA offline')};require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
env.NODE_OPTIONS = `--require="${offline.replaceAll('\\', '/')}"`
let app, page, processLog = ''
const errors = [], scenarios = []
async function chooseDirectory(directory) { await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }) }, directory) }
async function enterDeveloper() { await page.getByRole('button', { name: 'ModMind开发者工作台', exact: true }).click(); await page.getByRole('button', { name: '新建开发工程', exact: true }).waitFor() }
async function importPackage(archive, parent = projects) {
  await app.evaluate(({ dialog }, { archive, parent }) => {
    let call = 0
    dialog.showOpenDialog = async () => { const file = call++ ? parent : archive; return { canceled: !file, filePaths: file ? [file] : [] } }
  }, { archive, parent })
  await page.getByRole('button', { name: '导入功能或工作台', exact: true }).click()
}
async function editCss() {
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.css', exact: true }).click()
  const editor = page.locator('.developer-editor .view-lines').filter({ hasText: '.authoring-page' })
  await editor.click({ position: { x: 30, y: 10 } }); await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n.imported-ui-change { opacity: .95 }\n')
  await page.locator('.developer-toolbar').getByRole('button', { name: '保存', exact: true }).click()
}
async function create(kind, name, id) {
  await page.getByRole('button', { name: '新建开发工程', exact: true }).click()
  const form = page.locator('.developer-create-dialog')
  await form.getByLabel('包类型', { exact: true }).selectOption(kind)
  await form.getByLabel('名称', { exact: true }).fill(name)
  await form.getByLabel('包 ID', { exact: true }).fill(id)
  await chooseDirectory(projects)
  await form.getByRole('button', { name: '选择位置并创建', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await page.locator('.developer-files').waitFor()
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.tsx', exact: true }).waitFor()
}
async function screenshot(name, width = 1440, height = 900, darkMode = false) {
  await page.evaluate(dark => window.modmind.settings.saveAgent({ darkMode: dark }), darkMode)
  await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/index.html')); window.setSize(size.width, size.height) }, { width, height })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(output, name) })
  const bounds = await page.locator('.developer-workbench').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }))
  assert.ok(bounds.scroll <= bounds.width + 1, 'developer shell does not overflow')
}
async function runPreview() {
  await page.getByRole('button', { name: '运行预览', exact: true }).first().click()
  const frame = page.frameLocator('iframe[title="开发包页面预览"]')
  try { await frame.getByLabel('文稿', { exact: true }).waitFor({ timeout: 60000 }) }
  catch (error) { console.error('Preview body: ' + await page.locator('body').innerText()); throw error }
  return frame
}
async function exportPackage(name) {
  const target = path.join(output, name)
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, target)
  await page.locator('.developer-toolbar').getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.developer-feedback').filter({ hasText: '已导出' }).waitFor({ timeout: 60000 })
  await page.locator('.developer-feedback summary[aria-label="查看操作结果"]').click()
  await page.locator('.developer-feedback-details').filter({ hasText: target }).waitFor()
  await page.keyboard.press('Escape')
  assert.ok((await fs.stat(target)).size > 1000)
  return target
}
async function leave() { await page.getByRole('button', { name: '返回项目选择', exact: true }).click(); await page.locator('.project-launcher').waitFor() }
async function install(file) {
  await chooseDirectory(file)
  const pending = page.evaluate(() => window.modmind.featurePlugins.install())
  await page.getByRole('button', { name: '信任并安装', exact: true }).click()
  return pending
}
async function verifyInstalledMcp() {
  const state = await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  assert.ok(state.mcpConfigPath)
  const config = JSON.parse(await fs.readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, config.args, { env: { ...env, ...config.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const reader = createInterface({ input: child.stdout })
  let sequence = 0
  const pending = new Map()
  reader.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id) })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Installed MCP timeout')) }, 30000)
    pending.set(id, response => { clearTimeout(timer); resolve(response) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installed-developer-package-qa', version: '1' } })
    const list = await rpc('tools/list')
    for (const [name, characters] of [['modmind_qa_document_authoring_check', 2], ['modmind_qa_text_authoring_check', 6]]) {
      assert.ok(list.result.tools.some(tool => tool.name === name), 'installed tool discovered: ' + name)
      const called = await rpc('tools/call', { name, arguments: { text: '你好' } })
      assert.ok(!called.result.isError, JSON.stringify(called))
      assert.equal(JSON.parse(called.result.content[0].text).characters, characters)
    }
    assert.ok(!list.result.tools.some(tool => tool.name === 'modmind_dev_write'))
  } finally { child.kill(); reader.close(); await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false)) }
}
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 60000 })
  app.process().stdout?.on('data', chunk => { processLog += chunk }); app.process().stderr?.on('data', chunk => { processLog += chunk })
  await app.firstWindow({ timeout: 60000 })
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
  await page.context().setOffline(true)
  page.on('console', value => { if (['error', 'warning'].includes(value.type())) processLog += '\nrenderer: ' + value.text() })
  page.on('framenavigated', frame => { processLog += '\nframe: ' + frame.url() })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await page.waitForFunction(() => !!window.modmind?.developer)
  await page.evaluate(executable => window.modmind.settings.saveAgent({ codingBackend: 'codex', externalAgents: { codex: { mode: 'local', executable, model: 'test-model' } } }), agent.executable)
  await page.evaluate(() => { localStorage.setItem('modmind-ui-mode', 'advanced'); localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, phase: 'experience', fieldIndex: 0, status: 'skipped' })) })
  await page.reload()
  const closeChangelog = page.getByRole('button', { name: '关闭更新日志' })
  if (await closeChangelog.isVisible().catch(() => false)) await closeChangelog.click()
  const skipTutorial = page.getByRole('button', { name: /我是老手，直接进入/ })
  if (await skipTutorial.isVisible().catch(() => false)) await skipTutorial.click()
  await page.locator('.project-launcher').waitFor()
  const originalProject = await page.evaluate(() => window.modmind.project.current())
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('developer:recent')
    globalThis.developerLoadingFixture = { delay: 1500, fail: false }
    ipcMain.removeHandler('developer:recent')
    ipcMain.handle('developer:recent', async (...args) => {
      await new Promise(resolve => setTimeout(resolve, globalThis.developerLoadingFixture.delay))
      if (globalThis.developerLoadingFixture.fail) throw Error('Recent projects fixture failed')
      return original(...args)
    })
  })
  await page.getByRole('button', { name: 'ModMind开发者工作台', exact: true }).click()
  await page.locator('#app-loading').waitFor({ state: 'visible' })
  await page.waitForFunction(() => getComputedStyle(document.getElementById('app-loading')).opacity === '1')
  assert.equal(await page.locator('#root').evaluate(node => node.inert), true)
  assert.equal(await page.locator('#app-loading').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)')
  assert.equal(await page.locator('#app-loading img:visible').count(), 1)
  await page.screenshot({ path: path.join(output, 'developer-white-logo-loading.png') })
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(() => { globalThis.developerLoadingFixture.delay = 0 })
  await page.getByRole('button', { name: '新建开发工程', exact: true }).waitFor()
  scenarios.push('developer entry displays the shared white logo loading cover and blocks input until the workspace is ready')
  assert.equal(await page.locator('.developer-status').count(), 0)
  assert.equal(await page.locator('.developer-feedback').count(), 0)
  await page.screenshot({ path: path.join(output, 'developer-start-without-status-row.png') })
  await importPackage(null)
  await page.getByRole('button', { name: '新建开发工程', exact: true }).waitFor()
  const corrupt = path.join(output, 'corrupt.mmfeature'); await fs.writeFile(corrupt, 'invalid archive')
  await importPackage(corrupt)
  await page.locator('.developer-feedback[role="alert"]').waitFor()
  await page.locator('.developer-feedback summary[aria-label="查看错误详情"]').click()
  await page.locator('.developer-feedback-details').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '收起错误', exact: true }).click()
  assert.equal(await page.locator('#root').evaluate(node => node.inert), false)
  await create('feature', '文本开发验收', 'qa-text-authoring')
  assert.equal(await fs.stat(path.join(projects, 'qa-text-authoring/modmind.project.json')).catch(() => null), null)
  assert.equal(await page.getByText('本地开发工程', { exact: true }).count(), 0)
  const adjoining = await page.evaluate(() => { const header = document.querySelector('.developer-toolbar').getBoundingClientRect(), content = document.querySelector('.developer-layout').getBoundingClientRect(); return Math.abs(header.bottom - content.top) < 1 }); assert.ok(adjoining, 'no status row or reserved space between toolbar and workspace')
  const frame = await runPreview()
  await frame.getByLabel('文稿', { exact: true }).fill('你好\nModMind')
  await frame.getByRole('button', { name: '检查文本', exact: true }).click()
  await frame.getByRole('status').filter({ hasText: '10 个字符 · 2 行' }).waitFor()
  assert.ok((await page.locator('.developer-preview-status').innerText()).includes('页面已加载'))
  scenarios.push('fresh offline profile: create a standalone feature, local compile, isolated preview and actual action result')
  await page.getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).fill('验证开发闭环，修改文本动作并检查预览和 MCP。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.developer-ai').getByText(/开发闭环验证完成/).waitFor({ timeout: 90000 })
  const calls = (await fs.readFile(agent.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.some(call => call.name === 'modmind_dev_write'))
  assert.ok(calls.some(call => call.name === 'modmind_dev_preview'))
  assert.ok(calls.every(call => !call.isError))
  scenarios.push('real existing AI runner and generated MCP chain exercised by deterministic model transport fixture: edit, build, tool debug, screenshot, export')
  await runPreview()
  await screenshot('feature-preview-light-1440.png')
  await screenshot('feature-preview-dark-1080.png', 1080, 680, true)
  await page.getByRole('tab', { name: '调试', exact: true }).click()
  await page.getByLabel('调试类型', { exact: true }).selectOption('tool')
  await page.getByRole('button', { name: '运行调试', exact: true }).click()
  await page.locator('.developer-debug-result').filter({ hasText: 'characters' }).waitFor()
  await screenshot('feature-debug-dark-1080.png', 1080, 680, true)
  let exportedFeature = await exportPackage('qa-text-authoring.mmfeature')
  // Actual invalid source -> build failure -> repair -> successful preview, preserving the editor's file context.
  const data = await page.evaluate(() => window.modmind.developer.recent())
  const featureRoot = data[0].root
  await page.locator('.developer-file-list').getByRole('button', { name: 'main.ts', exact: true }).click()
  const originalMain = await fs.readFile(path.join(featureRoot, 'main.ts'), 'utf8')
  await fs.writeFile(path.join(featureRoot, 'main.ts'), originalMain + '\nconst broken: number = "text"\n')
  await page.getByRole('button', { name: '刷新开发文件', exact: true }).click()
  await page.locator('.developer-toolbar').getByRole('button', { name: '运行预览', exact: true }).click()
  await page.locator('.developer-feedback[role="alert"]').filter({ hasText: 'main.ts' }).waitFor({ timeout: 60000 })
  await fs.writeFile(path.join(featureRoot, 'main.ts'), originalMain)
  await page.getByRole('button', { name: '刷新开发文件', exact: true }).click()
  await runPreview()
  scenarios.push('MCP tool debug; type error retains source and can be repaired/retried; portable archive export')
  assert.deepEqual(await page.evaluate(() => window.modmind.project.current()), originalProject)
  await leave(); await enterDeveloper()
  await importPackage(exportedFeature, null)
  await page.getByRole('button', { name: '新建开发工程', exact: true }).waitFor()
  const originalFeatureBytes = await fs.readFile(exportedFeature)
  await importPackage(exportedFeature)
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.js', exact: true }).waitFor()
  await editCss()
  await page.getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).fill('修改导入包里的 JavaScript，验证预览和 MCP 后重新导出。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.developer-ai').getByText(/开发闭环验证完成/).waitFor({ timeout: 90000 })
  const importedFrame = await runPreview()
  await importedFrame.getByLabel('文稿', { exact: true }).fill('你好')
  await importedFrame.getByRole('button', { name: '检查文本', exact: true }).click()
  await importedFrame.getByRole('status').filter({ hasText: '6 个字符' }).waitFor()
  await screenshot('imported-feature-light-1080.png', 1080, 680, false)
  assert.deepEqual(await fs.readFile(exportedFeature), originalFeatureBytes)
  exportedFeature = await exportPackage('qa-imported-text-authoring.mmfeature')
  scenarios.push('cancelled and corrupt imports recover; imported feature edits CSS in the editor and compiled JavaScript through the real AI/MCP chain, previews and re-exports without changing the original')
  await leave()
  await app.evaluate(() => { globalThis.developerLoadingFixture.fail = true })
  await enterDeveloper()
  await page.locator('.developer-feedback[role="alert"]').filter({ hasText: 'Recent projects fixture failed' }).waitFor()
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#root').evaluate(node => node.inert), false)
  await leave()
  await app.evaluate(() => { globalThis.developerLoadingFixture.fail = false })
  await enterDeveloper()
  scenarios.push('developer loading failure releases the cover and allows returning and retrying')
  await create('studio', '文稿开发验收', 'qa-document-authoring')
  await page.locator('.developer-file-list').getByRole('button', { name: 'manifest.json', exact: true }).click()
  await page.locator('.developer-configuration').getByLabel('工作台名称', { exact: true }).fill('文稿开发验收')
  await screenshot('studio-config-light-1440.png', 1440, 900, false)
  await page.getByRole('tab', { name: '调试', exact: true }).click()
  await page.getByLabel('调试类型', { exact: true }).selectOption('create-studio')
  await page.getByLabel('调试参数', { exact: true }).fill(JSON.stringify({ name: '生成文稿', style: 'essay' }, null, 2))
  await page.getByRole('button', { name: '创建测试项目', exact: true }).click()
  await page.locator('.developer-debug-result').filter({ hasText: 'verified' }).waitFor({ timeout: 60000 })
  assert.match(await page.locator('.developer-debug-result').innerText(), /draft\.md/)
  await screenshot('studio-created-light-1080.png', 1080, 680, false)
  const studioFrame = await runPreview()
  await studioFrame.getByText('生成文稿', { exact: true }).waitFor()
  let exportedStudio = await exportPackage('qa-document-authoring.mmstudio')
  scenarios.push('studio configuration, actual template creation and file/AI-profile readback; preview uses created test project; mmstudio export')
  await leave(); await enterDeveloper()
  await importPackage(exportedStudio)
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.js', exact: true }).waitFor()
  await editCss()
  await runPreview()
  await page.getByRole('tab', { name: '调试', exact: true }).click()
  await page.getByLabel('调试类型', { exact: true }).selectOption('create-studio')
  await page.getByRole('button', { name: '创建测试项目', exact: true }).click()
  await page.locator('.developer-debug-result').filter({ hasText: 'verified' }).waitFor({ timeout: 60000 })
  await screenshot('imported-studio-dark-1080.png', 1080, 680, true)
  exportedStudio = await exportPackage('qa-imported-document-authoring.mmstudio')
  scenarios.push('imported studio preserves creation provider and AI profiles, supports editor changes, preview, test-project creation and re-export')
  await leave()
  await install(exportedFeature); await install(exportedStudio)
  const installed = await page.evaluate(() => window.modmind.featurePlugins.catalog())
  assert.ok(installed.find(item => item.id === 'qa-text-authoring')?.available)
  assert.ok(installed.find(item => item.id === 'qa-document-authoring')?.available)
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await createDialog.getByRole('button', { name: /文稿开发验收/ }).click()
  await createDialog.getByLabel('项目名称', { exact: true }).fill('真实宿主文稿')
  await createDialog.getByLabel('文稿类型', { exact: true }).selectOption('essay')
  await chooseDirectory(projects)
  await createDialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await createDialog.waitFor({ state: 'hidden' })
  const actual = await page.evaluate(() => window.modmind.project.current())
  assert.equal(actual.studioId, 'qa-document-authoring-domain')
  assert.equal(await fs.readFile(path.join(actual.path, 'draft.md'), 'utf8'), '# 真实宿主文稿\n\n')
  for (const [label, expected] of [['文稿开发验收', '2 个字符'], ['文本开发验收', '6 个字符']]) {
    await page.locator('.sidebar-nav').getByRole('button', { name: label, exact: true }).click()
    const actualPage = page.locator('.authoring-page:visible')
    await actualPage.getByLabel('文稿', { exact: true }).fill('你好')
    await actualPage.getByRole('button', { name: '检查文本', exact: true }).click()
    await actualPage.getByRole('status').filter({ hasText: expected }).waitFor()
  }
  scenarios.push('both exported archives install in the real host; exported mmstudio creates a real project with provider files')
  scenarios.push('both installed native pages render and invoke their actual host actions, including the AI-generated change')
  await verifyInstalledMcp()
  scenarios.push('both installed package tools discovered and invoked over the actual public stdio MCP bridge; developer tools stay isolated')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ scenarios, errors, feature: exportedFeature, studio: exportedStudio, offline: true }, null, 2))
  console.log(JSON.stringify({ output, scenarios }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined)
  console.error('Developer smoke failed; artifacts: ' + output)
  console.error(error)
  throw error
} finally {
  await fs.writeFile(path.join(output, 'process.log'), processLog)
  await app?.close().catch(() => undefined)
}
