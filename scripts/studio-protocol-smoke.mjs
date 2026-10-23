import { _electron as electron } from 'playwright'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { customStudioFixture } from './custom-studio-fixture.mjs'
import { spawn } from 'node:child_process'

const workspace = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-studio-ui-'))
const profile = path.join(root, 'profile'), projects = path.join(root, 'projects')
const output = path.join(workspace, 'test-results/studio-protocol', String(Date.now()))
let app, page
const errors = [], scenarios = []
let processLog = ''
async function waitFor(predicate, argument) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await page.evaluate(predicate, argument)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Studio UI state did not become ready')
}
async function zipDirectory(source, destination) {
  await new Promise((resolve, reject) => {
    const zip = require('archiver')('zip'), stream = createWriteStream(destination)
    stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject)
    zip.pipe(stream); zip.directory(source, false); void zip.finalize().catch(reject)
  })
}
async function documentStudioScenario() {
  const studio = {
    apiVersion: 1, id: 'qa-document', name: '文稿工作台', projectKind: 'document', loaders: ['markdown'],
    defaultTarget: { loader: 'markdown', version: '1' }, templateHandler: 'document',
    creation: { fields: [
      { id: 'title', title: '文稿名称', type: 'input', bind: 'name', required: true },
      { id: 'language', title: '写作语言', type: 'options', default: 'zh', options: [{ value: 'zh', title: '中文' }, { value: 'en', title: '英文' }] },
      { id: 'format', title: '排版方式', type: 'select', default: 'essay', options: [{ value: 'essay', title: '文章' }, { value: 'novel', title: '小说' }] }
    ] },
    ai: { workbench: { instructions: 'Write documents', skills: [] }, inspiration: { instructions: 'Discuss ideas', skills: [] } }
  }
  const archive = await customStudioFixture(path.join(root, 'document-fixture'), studio, 'qa-document-studio', 'document.json')
  await page.locator('.project-switcher').click()
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  const install = page.evaluate(() => window.modmind.featurePlugins.install())
  const trust = page.getByRole('dialog', { name: '安装工作台', exact: true })
  await trust.waitFor(); await trust.getByRole('button', { name: '信任并安装', exact: true }).click()
  await install
  await dialog.getByRole('button', { name: '文稿', exact: true }).click()
  await dialog.getByLabel('文稿名称', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '自定义 +', exact: true }).count(), 0)
  assert.deepEqual(await dialog.locator('.studio-declared-field > label').allTextContents(), ['文稿名称', '写作语言', '排版方式'])
  assert.doesNotMatch(await dialog.innerText(), /Minecraft|Java|Iris|游戏版本|目标平台/)
  await dialog.getByLabel('文稿名称', { exact: true }).fill('Document QA')
  await dialog.getByRole('button', { name: '英文', exact: true }).click()
  await dialog.getByLabel('排版方式', { exact: true }).selectOption('novel')
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.screenshot({ path: path.join(output, 'document-form-desktop.png') })
  await page.setViewportSize({ width: 1080, height: 780 })
  await page.screenshot({ path: path.join(output, 'document-form-narrow.png') })
  const selectorBounds = await dialog.locator('.studio-selector').boundingBox()
  const selectedBounds = await dialog.getByRole('button', { name: '文稿', exact: true }).boundingBox()
  assert.ok(selectedBounds.x >= selectorBounds.x && selectedBounds.x + selectedBounds.width <= selectorBounds.x + selectorBounds.width, 'Selected installed workbench stays visible')
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, projects)
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  const project = await page.evaluate(() => window.modmind.project.current())
  assert.equal(project.kind, 'document'); assert.equal(project.loader, 'markdown')
  assert.equal(project.studioId, 'qa-document')
  const content = JSON.parse(await fs.readFile(path.join(project.path, 'document.json'), 'utf8'))
  assert.equal(content.language, 'en'); assert.equal(content.format, 'novel')
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('qa-document-studio'))
  await page.locator('.project-switcher').click()
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  await dialog.waitFor()
  assert.equal(await dialog.getByRole('button', { name: '文稿', exact: true }).count(), 0)
  assert.equal(await dialog.getByLabel('文稿名称', { exact: true }).count(), 0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  scenarios.push('installed non-Minecraft document module appears in creation without a custom install entry; selected option stays visible; actual create/readback and uninstall; desktop/1080px')
}
async function customStudioScenario() {
  const archive = await customStudioFixture(path.join(root, 'fixture'))
  const install = async (cancel = false) => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
    const pending = page.evaluate(() => window.modmind.featurePlugins.install()).catch(error => String(error))
    const dialog = page.getByRole('dialog', { name: '安装工作台', exact: true })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: cancel ? '取消' : '信任并安装', exact: true }).click()
    await pending
  }
  await install(true); await install()
  await waitFor(async () => (await window.modmind.studios.list()).find(record => record.definition.id === 'qa-shader-domain')?.available)
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.locator('.project-switcher').click()
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await dialog.getByRole('button', { name: '测试光影', exact: true }).click()
  await dialog.getByLabel('项目名称', { exact: true }).fill('QA Shader')
  await dialog.getByRole('button', { name: '夜间', exact: true }).click()
  await dialog.getByLabel('品质', { exact: true }).selectOption('cinematic')
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('qa-shader-studio', false))
  await dialog.getByRole('button', { name: '测试光影', exact: true }).waitFor({ state: 'hidden' })
  await page.evaluate(() => window.modmind.featurePlugins.setEnabled('qa-shader-studio', true))
  await waitFor(async () => (await window.modmind.studios.list()).find(record => record.definition.id === 'qa-shader-domain')?.available)
  await dialog.getByRole('button', { name: '测试光影', exact: true }).waitFor()
  assert.equal(await dialog.getByLabel('项目名称', { exact: true }).inputValue(), 'QA Shader')
  assert.equal(await dialog.getByLabel('品质', { exact: true }).inputValue(), 'cinematic')
  await page.screenshot({ path: path.join(output, 'custom-form-desktop.png') })
  await page.setViewportSize({ width: 1080, height: 780 })
  await page.screenshot({ path: path.join(output, 'custom-form-narrow.png') })
  const bounds = await dialog.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth + 1))
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, projects)
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const custom = await page.evaluate(() => window.modmind.project.current())
  assert.equal(custom.studioId, 'qa-shader-domain'); assert.equal(custom.loader, 'glsl')
  assert.equal(custom.studioName, '测试光影工作台')
  const content = JSON.parse(await fs.readFile(path.join(custom.path, 'shader-project.json'), 'utf8'))
  assert.equal(content.quality, 'cinematic'); assert.equal(content.lighting, 'night')
  const external = path.join(root, 'existing-shader')
  await fs.mkdir(external); await fs.writeFile(path.join(external, 'shader-project.json'), '{"preserve":true}')
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, external)
  const inspection = await page.evaluate(() => window.modmind.project.inspectExisting('folder'))
  assert.equal(inspection.studio.id, 'qa-shader-domain')
  const zippedShader = path.join(root, 'existing-shader.zip')
  await zipDirectory(external, zippedShader)
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, zippedShader)
  const archiveInspection = await page.evaluate(() => window.modmind.project.inspectExisting('zip'))
  await assert.rejects(page.evaluate(input => window.modmind.project.adoptExisting(input), { ...archiveInspection.inferred, sourcePath: archiveInspection.sourcePath }), /完整项目文件夹/)
  const adopted = await page.evaluate(input => window.modmind.project.adoptExisting(input), { ...inspection.inferred, sourcePath: external })
  assert.equal(adopted.studioId, 'qa-shader-domain')
  assert.equal(await fs.readFile(path.join(external, 'shader-project.json'), 'utf8'), '{"preserve":true}')
  await page.evaluate(folder => window.modmind.project.openRecent(folder), custom.path)
  await verifyStudioMcp(custom)
  await page.evaluate(() => window.modmind.featurePlugins.uninstall('qa-shader-studio'))
  await assert.rejects(page.evaluate(folder => window.modmind.project.openRecent(folder), custom.path), /工作台/)
  assert.equal((JSON.parse(await fs.readFile(path.join(custom.path, 'modmind.project.json'), 'utf8'))).studioName, '测试光影工作台')
  await page.reload()
  await page.locator('.project-launcher').waitFor()
  const row = page.locator('.recent-project-row').filter({ has: page.getByText('QA Shader', { exact: true }) })
  await row.getByText('需要下载测试光影工作台', { exact: true }).waitFor()
  await row.scrollIntoViewIfNeeded()
  assert.equal(await row.locator('.recent-project-main').isDisabled(), true)
  await page.screenshot({ path: path.join(output, 'missing-custom-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '切换深色模式', exact: true }).click()
  await page.locator('.app-shell.dark-mode').waitFor()
  await page.setViewportSize({ width: 1080, height: 780 })
  await page.screenshot({ path: path.join(output, 'missing-custom-dark-narrow.png') })
  await row.getByRole('button', { name: '下载或启用测试光影工作台', exact: true }).click()
  await page.locator('.features-page').waitFor()
  await install()
  await waitFor(async () => (await window.modmind.studios.list()).find(record => record.definition.id === 'qa-shader-domain')?.available)
  await page.evaluate(folder => window.modmind.project.openRecent(folder), custom.path)
  scenarios.push('custom domain with input/options/select, target outside Minecraft, trust cancel/retry, preserved form values, in-place adoption, unavailable gray rows and recovery; light/dark 1080px/1280px')
}

async function verifyStudioMcp(project) {
  const relative = 'docs/mcp-existing-shader', folder = path.join(project.path, relative)
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'shader-project.json'), '{"mcp":true}')
  const state = await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  assert.ok(state.mcpConfigPath)
  const config = JSON.parse(await fs.readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let sequence = 0, buffer = ''
  const pending = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      pending.get(value.id)?.(value); pending.delete(value.id)
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Studio MCP smoke timeout')) }, 30000)
    pending.set(id, value => { clearTimeout(timer); resolve(value) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = (name, args) => rpc('tools/call', { name, arguments: args })
  try {
    const tools = await rpc('tools/list', {})
    assert.ok(tools.result.tools.some(tool => tool.name === 'modmind_studio_adopt'))
    const catalog = await call('modmind_feature_catalog', {})
    assert.match(JSON.stringify(catalog), /loader-versions|cinematic/)
    const inspected = await call('modmind_studio_inspect', { sourcePath: relative })
    assert.ok(!inspected.result.isError, JSON.stringify(inspected))
    const analysis = JSON.parse(inspected.result.content[0].text)
    const adopted = await call('modmind_studio_adopt', { ...analysis.inferred, name: `  ${analysis.inferred.name}  `, sourcePath: relative })
    assert.ok(!adopted.result.isError, JSON.stringify(adopted))
    assert.equal(JSON.parse(adopted.result.content[0].text).status, 'verified')
    const adoptedInfo = JSON.parse(await fs.readFile(path.join(folder, 'modmind.project.json'), 'utf8'))
    assert.equal(adoptedInfo.studioId, 'qa-shader-domain')
    assert.equal(adoptedInfo.studioValues.quality, 'balanced')
    assert.equal(adoptedInfo.studioValues['project-title'], analysis.inferred.name)
    assert.equal(await fs.readFile(path.join(folder, 'shader-project.json'), 'utf8'), '{"mcp":true}')
    const denied = await call('modmind_studio_inspect', { sourcePath: '../outside' })
    assert.equal(denied.result.isError, true)
    const active = await page.evaluate(() => window.modmind.project.current())
    assert.equal(active.path, project.path)
    scenarios.push('real MCP discovery, declarative catalog, custom adapter inspect/adopt/readback, project boundary rejection and preserved active project')
  } finally {
    child.kill()
    await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false))
  }
}
try {
  await fs.mkdir(projects); await fs.mkdir(output, { recursive: true }); await fs.mkdir(profile)
  const bootstrap = path.join(root, 'bootstrap.cjs')
  await fs.writeFile(bootstrap, `const {app}=require('electron');app.setName('modmind-studio-smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});require(${JSON.stringify(require.resolve('undici'))}).request=async()=>{throw Error('Studio QA offline')};global.fetch=async()=>{throw Error('Studio QA offline')};require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 60000 })
  app.process().stdout?.on('data', chunk => { processLog += chunk })
  app.process().stderr?.on('data', chunk => { processLog += chunk })
  await app.firstWindow({ timeout: 60000 })
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await waitFor(() => Boolean(window.modmind?.studios))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  const closeChangelog = page.getByRole('button', { name: '关闭更新日志' })
  if (await closeChangelog.isVisible().catch(() => false)) await closeChangelog.click()
  await waitFor(async () => (await window.modmind.studios.list()).filter(record => record.available).length === 3)
  scenarios.push('fresh offline profile receives all three bundled studios without manual installation')
  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await createDialog.waitFor()
  assert.equal(await createDialog.getByRole('button', { name: '光影', exact: true }).count(), 0)
  assert.equal(await createDialog.getByText('色彩预设', { exact: true }).count(), 0)
  assert.equal(await createDialog.getByRole('group', { name: '工作台', exact: true }).getByRole('button').count(), 3)
  assert.equal(await createDialog.getByRole('button', { name: '自定义 +', exact: true }).count(), 0)
  assert.equal(await createDialog.getByText('工作台', { exact: true }).count(), 0)
  await createDialog.getByLabel('项目名称', { exact: true }).fill('保留草稿')
  await createDialog.getByRole('button', { name: '整合包', exact: true }).click()
  await createDialog.getByRole('button', { name: '模组', exact: true }).click()
  assert.equal(await createDialog.getByLabel('项目名称', { exact: true }).inputValue(), '保留草稿')
  await createDialog.getByLabel('项目名称', { exact: true }).fill('')
  await waitFor(() => !document.querySelector('.studio-create-dialog button.primary-button')?.disabled && document.querySelector('.studio-create-dialog').getAnimations().every(animation => animation.playState !== 'running'))
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.screenshot({ path: path.join(output, 'create-desktop.png') })
  await page.setViewportSize({ width: 1080, height: 780 })
  await page.screenshot({ path: path.join(output, 'create-narrow.png') })
  const logo = await page.locator('.titlebar-name > img').boundingBox()
  const actions = await page.locator('.titlebar-actions').boundingBox()
  assert.ok(logo.x + logo.width <= actions.x + 1, 'Titlebar controls do not overlap the wordmark')
  const bounds = await createDialog.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth + 1), 'Create dialog fits the narrow window')
  await createDialog.getByRole('button', { name: '服务端插件', exact: true }).click()
  assert.equal(await createDialog.getByRole('button', { name: 'Java 版', exact: true }).isDisabled(), true)
  await createDialog.getByRole('button', { name: 'Velocity', exact: true }).click()
  await waitFor(() => /^(3|4)\./.test(document.querySelector('.studio-create-dialog select')?.value ?? ''))
  await page.screenshot({ path: path.join(output, 'velocity-narrow.png') })
  await createDialog.getByRole('button', { name: '整合包', exact: true }).click()
  assert.equal(await createDialog.getByRole('button', { name: 'Java 版', exact: true }).isDisabled(), true)
  await page.screenshot({ path: path.join(output, 'modpack-java-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.screenshot({ path: path.join(output, 'modpack-java-desktop.png') })
  await createDialog.getByRole('button', { name: '取消', exact: true }).click()
  scenarios.push('declaration-driven creation and Velocity target; 1080px')

  await page.locator('.project-launcher').getByRole('button', { name: '新建项目', exact: true }).click()
  await createDialog.locator('input').first().fill('Studio Mod QA')
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }) }, projects)
  await createDialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await createDialog.waitFor({ state: 'hidden' })
  const mod = await page.evaluate(() => window.modmind.project.current())
  assert.equal(mod.studioId, 'minecraft-mod')
  assert.match(await fs.readFile(path.join(mod.path, 'src/main/resources/fabric.mod.json'), 'utf8'), /fabricloader/)
  assert.deepEqual(await fs.readdir(path.join(profile, 'feature-plugins')), [])
  const records = await page.evaluate(() => window.modmind.featurePlugins.list())
  assert.equal(records.filter(record => record.builtin).length, 3)
  await assert.rejects(page.evaluate(() => window.modmind.featurePlugins.uninstall('studio-mod')), /内置工作台/)
  scenarios.push('builtins load directly offline; no user copies; uninstall rejected; actual Mod creation')

  const createdProjects = []
  for (const [id, kind, loader] of [['minecraft-server-plugin', 'server-plugin', 'paper'], ['minecraft-modpack', 'modpack', 'fabric']]) {
    const created = await page.evaluate(async target => window.modmind.project.create(target), { name: `QA ${kind}`, kind, loader, minecraftVersion: '1.21.1', studioId: id })
    assert.equal(created.studioId, id)
    createdProjects.push(created)
    await page.evaluate(projectPath => window.modmind.project.openRecent(projectPath), created.path)
    await page.reload()
    await page.setViewportSize({ width: 1280, height: 850 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '工作台', exact: true }).click()
    await page.locator('.agent-workbench textarea').waitFor()
    const workbench = await page.evaluate(projectPath => window.modmind.studios.context('workbench', projectPath), created.path)
    const inspiration = await page.evaluate(projectPath => window.modmind.studios.context('inspiration', projectPath), created.path)
    assert.notEqual(workbench.instructions, inspiration.instructions)
    assert.equal(workbench.id, id)
    if (kind === 'server-plugin') assert.deepEqual((await page.locator('.agent-workbench .chat-welcome-options button > span:visible').allTextContents()).sort(), ['每日签到与奖励', '家与传送', '插件联动与兼容'].sort())
    await page.screenshot({ path: path.join(output, `${kind}-workbench.png`) })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '灵感台', exact: true }).click()
    await page.locator('.inspiration-page:not([hidden]) textarea').waitFor()
    await page.screenshot({ path: path.join(output, `${kind}-inspiration.png`) })
    await page.setViewportSize({ width: 1080, height: 780 })
    await page.screenshot({ path: path.join(output, `${kind}-inspiration-narrow.png`) })
    const textarea = await page.locator('.inspiration-page:not([hidden]) textarea').boundingBox()
    assert.ok(textarea.y + textarea.height <= 781)
    scenarios.push(`${kind} workbench and inspiration profiles; 1280px/1080px`)
  }

  for (const original of [mod, createdProjects.find(project => project.kind === 'server-plugin')]) {
    const external = path.join(root, `external-${original.kind}`)
    await fs.cp(original.path, external, { recursive: true, filter: source => path.basename(source) !== '.modmind' && path.basename(source) !== 'modmind.project.json' })
    const originalBuild = await fs.readFile(path.join(external, 'build.gradle'), 'utf8')
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, external)
    const analysis = await page.evaluate(() => window.modmind.project.inspectExisting('folder'))
    assert.equal(analysis.kind, 'complete')
    const adopted = await page.evaluate(async input => window.modmind.project.adoptExisting(input), {
      sourcePath: external, name: original.name, namespace: original.namespace, loader: original.loader, minecraftVersion: original.minecraftVersion, kind: original.kind, studioId: original.studioId
    })
    assert.equal(await fs.realpath(adopted.path), await fs.realpath(external))
    const context = await page.evaluate(projectPath => window.modmind.studios.context('workbench', projectPath), adopted.path)
    assert.equal(context.id, original.studioId)
    assert.equal(context.available, true)
    assert.equal(await fs.readFile(path.join(external, 'build.gradle'), 'utf8'), originalBuild)
    scenarios.push(`adopts an existing ${original.kind} project in place and preserves its build`)
    if (original.kind === 'mod') {
      const archiveSource = path.join(root, 'mod-archive-source'), archiveFile = path.join(root, 'existing-mod.zip')
      await fs.cp(original.path, archiveSource, { recursive: true, filter: source => !['.modmind', 'modmind.project.json'].includes(path.basename(source)) })
      await zipDirectory(archiveSource, archiveFile)
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archiveFile)
      const archiveAnalysis = await page.evaluate(() => window.modmind.project.inspectExisting('zip'))
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, projects)
      const imported = await page.evaluate(input => window.modmind.project.adoptExisting(input), { ...archiveAnalysis.inferred, sourcePath: archiveAnalysis.sourcePath, namespace: 'archive_import' })
      assert.equal(await fs.realpath(imported.path), await fs.realpath(path.join(projects, 'archive_import')))
      assert.equal(await fs.readFile(path.join(imported.path, 'build.gradle'), 'utf8'), originalBuild)
      scenarios.push('ZIP Mod adoption publishes to chosen persistent destination, preserves build and handles Windows path aliases')
    }
  }

  const legacy = path.join(root, 'legacy-mod')
  await fs.cp(mod.path, legacy, { recursive: true, filter: source => !['.modmind', 'modmind.project.json'].includes(path.basename(source)) })
  await fs.mkdir(path.join(legacy, '.modtool'))
  await fs.writeFile(path.join(legacy, '.modtool', 'preserved.txt'), 'legacy data')
  await fs.writeFile(path.join(legacy, 'modtool.project.json'), JSON.stringify({ ...mod, path: legacy }))
  const converted = await page.evaluate(input => window.modmind.project.adoptExisting(input), { sourcePath: legacy })
  assert.equal(converted.studioId, 'minecraft-mod')
  assert.equal(await fs.readFile(path.join(legacy, '.modmind', 'preserved.txt'), 'utf8'), 'legacy data')
  assert.equal(await fs.readFile(path.join(legacy, 'build.gradle'), 'utf8'), await fs.readFile(path.join(mod.path, 'build.gradle'), 'utf8'))
  scenarios.push('legacy modtool adoption preserves data and build while adding studio identity')
  await customStudioScenario()
  await documentStudioScenario()
  assert.deepEqual(errors, [])
  const result = { success: true, output, scenarios, errors }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await fs.writeFile(path.join(output, 'process.log'), processLog)
  await fs.cp(path.join(profile, 'diagnostics'), path.join(output, 'diagnostics'), { recursive: true }).catch(() => undefined)
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close().catch(() => undefined)
  assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
}
