import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'workbench-features', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-features-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'main renderer must be available')
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.modmind))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile))
  const projectPath = path.join(work, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '制作功能验证', namespace: 'feature_check', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.6', toolDataDirectory: '.modmind' }))
  await writeFile(path.join(projectPath, 'modmind.pack.json'), JSON.stringify({ version: 1, name: '制作功能验证', loader: 'fabric', minecraftVersion: '1.21.1', mods: [], modules: [], source: { format: 'modrinth', layout: 'archive', importedAt: '' } }))
  const settings = await page.evaluate(() => window.modmind.settings.getAgent())
  await app.evaluate(({ ipcMain }, settings) => {
    const state = globalThis.featureSmoke = { calls: [], release: undefined }
    ipcMain.removeHandler('settings:getAgent')
    ipcMain.handle('settings:getAgent', () => ({ ...settings, codingBackend: 'codex' }))
    ipcMain.removeHandler('ai:createCode')
    ipcMain.handle('ai:createCode', (_event, prompt, sessionId, backend, executionProfile, options) => {
      state.calls.push({ prompt, backend, options })
      return new Promise(resolve => { state.release = () => resolve({ intent: 'informational', summary: '界面验证完成', tasks: [], files: [], changedFiles: [], tests: [], warnings: [] }) })
    })
  }, settings)
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  const controls = page.getByRole('group', { name: '制作功能' })
  const trigger = page.getByRole('button', { name: '制作功能', exact: true })
  await trigger.click()
  await controls.waitFor()
  for (const label of ['真实界面测试', '无头测试', 'AI 生图', 'Blockbench 建模']) assert.equal(await controls.getByRole('checkbox', { name: label, exact: true }).isChecked(), true)
  await page.screenshot({ path: path.join(work, 'desktop-default.png') })
  await controls.getByRole('checkbox', { name: '无头测试', exact: true }).uncheck()
  await controls.getByRole('checkbox', { name: 'AI 生图', exact: true }).uncheck()
  await page.reload()
  await trigger.click()
  await controls.waitFor()
  assert.equal(await controls.getByRole('checkbox', { name: '无头测试', exact: true }).isChecked(), false)
  assert.equal(await controls.getByRole('checkbox', { name: 'AI 生图', exact: true }).isChecked(), false)
  await page.keyboard.press('Escape')
  await controls.waitFor({ state: 'hidden' })
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Enter')
  await controls.waitFor()
  await controls.getByRole('checkbox', { name: 'AI 生图', exact: true }).focus()
  await page.keyboard.press('Space')
  assert.equal(await controls.getByRole('checkbox', { name: 'AI 生图', exact: true }).isChecked(), true)
  await page.keyboard.press('Space')
  await page.getByRole('textbox', { name: '发送给 AI 的消息' }).fill('检查当前功能选择')
  await controls.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.workbench-feature-trigger[disabled]').waitFor()
  let calls
  for (let attempt = 0; attempt < 100; attempt++) {
    calls = await app.evaluate(() => globalThis.featureSmoke.calls)
    if (calls.length) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options.workbenchFeatures, { renderedTesting: true, headlessTesting: false, imageGeneration: false, modeling: true })
  await app.evaluate(() => globalThis.featureSmoke.release())
  await page.locator('.workbench-feature-trigger:not([disabled])').waitFor()
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 850 })
    await trigger.click()
    await controls.waitFor()
    const bounds = await controls.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const anchor = document.querySelector('.workbench-feature-trigger').getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1,
        above: rect.bottom <= anchor.top - 4,
        textOverflow: [...element.querySelectorAll('button > span')].some(label => label.scrollWidth > label.clientWidth + 1),
        brokenWords: [...element.querySelectorAll('button > span')].some(label => label.textContent.includes('Blockbench') && label.clientWidth < 64) }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, JSON.stringify(bounds))
    assert.equal(bounds.overflow, false)
    assert.equal(bounds.textOverflow, false)
    assert.equal(bounds.brokenWords, false)
    assert.equal(bounds.above, true)
    await page.screenshot({ path: path.join(work, `width-${width}.png`) })
    await page.keyboard.press('Escape')
  }
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'beginner'))
  await page.reload()
  await page.getByRole('textbox', { name: '发送给 AI 的消息' }).waitFor()
  assert.equal(await controls.count(), 0)
  assert.equal(await trigger.count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, work, sentFeatures: calls[0].options.workbenchFeatures }, null, 2))
} finally {
  await app?.close()
}
