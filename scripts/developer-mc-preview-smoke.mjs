import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const workspace = path.resolve(import.meta.dirname, '..')
if (!process.argv[2]) throw Error('Usage: node scripts/developer-mc-preview-smoke.mjs <mc-preview.mmfeature>')
const archive = path.resolve(process.argv[2])
const output = path.join(workspace, 'test-results/developer-workbench', 'native-registration-' + Date.now())
const profile = path.join(output, 'profile'), projects = path.join(output, 'projects')
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(projects)
const validatorFile = path.join(output, 'package-validator.cjs')
await build({ entryPoints: [path.join(workspace, 'src/main/featurePluginPackage.ts')], outfile: validatorFile, platform: 'node', bundle: true, format: 'cjs', logLevel: 'silent' })
const { prepareFeaturePlugin } = require(validatorFile)
const original = await prepareFeaturePlugin(archive)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const originalHash = sha(await fs.readFile(archive))
const bootstrap = path.join(output, 'bootstrap.cjs')
await fs.writeFile(bootstrap, `const {app}=require('electron');app.setName('modmind-native-registration-qa');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});require(${JSON.stringify(require.resolve('undici'))}).request=async()=>{throw Error('Registration QA offline')};global.fetch=async()=>{throw Error('Registration QA offline')};require(${JSON.stringify(path.join(workspace,'out/main/index.js'))});`)
const env = { ...process.env, MODMIND_UI_QA_OFFSCREEN: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let app, page, log = ''
const errors = []
try {
  app = await electron.launch({ args: [bootstrap], env, cwd: workspace, timeout: 60000 })
  app.process().stdout?.on('data', chunk => { log += chunk }); app.process().stderr?.on('data', chunk => { log += chunk })
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.context().setOffline(true)
  await page.waitForFunction(() => !!window.modmind)
  await page.evaluate(() => { localStorage.setItem('modmind-ui-mode', 'advanced'); localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, phase: 'experience', fieldIndex: 0, status: 'skipped' })) })
  await page.reload()
  const changelog = page.getByRole('button', { name: '关闭更新日志' })
  if (await changelog.isVisible().catch(() => false)) await changelog.click()
  await page.locator('.project-launcher').waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await page.getByRole('button', { name: 'ModMind开发者工作台', exact: true }).click()
  await page.getByRole('button', { name: '新建开发工程', exact: true }).waitFor()
  await app.evaluate(({ dialog }, files) => { let index = 0; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[index++]] }) }, [archive, projects])
  await page.getByRole('button', { name: '导入功能或工作台', exact: true }).click()
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.js', exact: true }).waitFor()
  await page.locator('.developer-toolbar').getByRole('button', { name: '运行预览', exact: true }).click()
  const frame = page.frameLocator('iframe[title="开发包页面预览"]')
  await frame.locator('.mcp-host').waitFor({ timeout: 60000 })
  await frame.locator('canvas').first().waitFor({ state: 'attached' })
  await page.waitForTimeout(1200)
  const rendered = await frame.locator('.mcp-host').evaluate(node => ({ booted: node.dataset.mcpBooted, canvasCount: node.shadowRoot?.querySelectorAll('canvas').length, error: node.shadowRoot?.getElementById('err')?.textContent?.trim() || '', text: node.shadowRoot?.textContent?.slice(-1200) }))
  assert.equal(rendered.booted, '1')
  assert.ok(rendered.canvasCount > 0)
  // This distributed package does not include its external item capture data.
  // Keep that limitation visible; it must not be confused with registration.
  const limitations = []
  if (rendered.error) {
    assert.match(rendered.error, /^ERROR\[物品栏\].*(?:ENOENT.*items\.json|当前项目还没有采集数据)/s)
    limitations.push('Package requires external items.json data that is not present in the archive or the independent sample project.')
  }
  assert.deepEqual(errors, [])
  assert.match(await page.locator('.developer-preview-status').innerText(), /页面已加载/)
  const negatives = await frame.locator('body').evaluate(() => {
    const g = window, invoke = (id, module) => { try { g.__modmindRegisterFeature(id, module); return '' } catch (error) { return error.message } }
    return [invoke('wrong-package-id', {}), invoke(g.__devManifest.id, { apiVersion: 1 }), invoke(g.__devManifest.id, {})]
  })
  assert.match(negatives[0], /包 ID 不匹配/); assert.match(negatives[1], /API 版本不匹配/); assert.match(negatives[2], /页面未导出/)
  for (const [dark, name] of [[false, 'light'], [true, 'dark']]) {
    await page.evaluate(darkMode => window.modmind.settings.saveAgent({ darkMode }), dark)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/index.html')).setSize(1080, 680))
    const png=await app.evaluate(({BrowserWindow})=>{const c=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/renderer/index.html')).webContents;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Paint timeout')),10000);c.once('paint',(_e,_r,image)=>{clearTimeout(timer);resolve(image.toPNG().toString('base64'))});c.invalidate()})});await fs.writeFile(path.join(output,`native-preview-${name}-1080.png`),Buffer.from(png,'base64'))
  }
  await page.getByRole('tab', { name: '调试', exact: true }).click()
  await page.getByLabel('调试对象', { exact: true }).selectOption('preview:open')
  await page.getByLabel('调试参数', { exact: true }).fill('{}')
  await page.getByRole('button', { name: '运行调试', exact: true }).click()
  await page.locator('.developer-debug-result').filter({ hasText: 'build' }).waitFor()
  const exported = path.join(output, 'mc-preview-reexport.mmfeature')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
  await page.locator('.developer-toolbar').getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.developer-feedback').filter({ hasText: '已导出' }).waitFor()
  const checked = await prepareFeaturePlugin(exported)
  assert.equal(checked.manifest.id, original.manifest.id)
  assert.deepEqual(checked.files.get('renderer.js'), original.files.get('renderer.js'))
  assert.equal(sha(await fs.readFile(archive)), originalHash)
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ archive, originalHash, output, rendered, negatives, exported, errors, limitations, offline: true }, null, 2))
  console.log(JSON.stringify({ output, registered: true, canvases: rendered.canvasCount, actionVerified: true, exported, originalUnchanged: true, limitations }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined)
  console.error('Native renderer verification failed: ' + output); throw error
} finally { await fs.writeFile(path.join(output, 'process.log'), log); await app?.close().catch(() => undefined) }
