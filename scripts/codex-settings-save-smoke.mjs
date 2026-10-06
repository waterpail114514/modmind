import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'codex-settings-save', String(Date.now()))
const profile = path.join(work, 'profile')
const native = path.join(work, 'native')
await mkdir(profile, { recursive: true })
await mkdir(native, { recursive: true })
const initial = { codingBackend: 'codex', externalAgents: { codex: {
  mode: 'hosted', baseUrl: 'malformed-old-url', model: 'manual-id', modelAutoCompactTokenLimits: { 'manual-id': 99999999 }
} } }
await writeFile(path.join(profile, 'settings.json'), JSON.stringify(initial))
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-save-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env, CODEX_HOME: native }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const checks = []
let app, page
async function waitFor(predicate, argument) {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(predicate, argument)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for settings state')
}
async function launch() {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let i = 0; i < 150; i++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.hide(); window.webContents.setBackgroundThrottling(false) }))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  await waitFor(() => Boolean(window.modmind))
}
async function fixtures(installed) {
  // Only discovery/installation are controlled. Configuration IPC, encryption,
  // atomic disk writes, settings readback and renderer interaction stay real.
  await app.evaluate(({ ipcMain }, installed) => {
    const state = globalThis.codexSaveSmoke = { installed, installCalls: 0, scans: 0, holdNext: false }
    const status = () => ({ kind: 'codex', label: 'Codex', installed: state.installed, executable: 'fixture-codex', detail: '' })
    ipcMain.removeHandler('external-agents:detect')
    ipcMain.handle('external-agents:detect', () => [status()])
    ipcMain.removeHandler('external-agents:scanLocal')
    ipcMain.handle('external-agents:scanLocal', () => {
      state.scans++
      const result = { status: status(), home: '/fixture', model: 'manual-id', models: [], modelsError: state.installed ? '模型服务暂时不可用' : undefined }
      if (state.holdNext) {
        state.holdNext = false
        return new Promise(resolve => { state.release = () => resolve({ ...result, baseUrl: 'https://old.example/v1', models: ['stale-model'] }) })
      }
      return result
    })
    ipcMain.removeHandler('external-agents:install')
    ipcMain.handle('external-agents:install', (_, kind) => {
      if (kind !== 'codex') throw new Error('Unexpected installer')
      state.installCalls++
      state.installed = true
      return status()
    })
  }, installed)
}
async function openSettings() {
  const expert = page.locator('.expert-mode-toggle')
  if (await expert.count() && !await expert.locator('input').isChecked()) await expert.click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
  await page.locator('#settings-ai').getByRole('button', { name: '本机 Codex', exact: true }).click()
}
async function capture(name) {
  const section = page.locator('#settings-ai')
  for (const darkMode of [true, false]) {
    await page.evaluate(async darkMode => window.modmind.settings.saveAgent({ ...await window.modmind.settings.getAgent(), darkMode }), darkMode)
    for (const width of [1440, 640]) {
      await page.setViewportSize({ width, height: 1000 })
      await section.scrollIntoViewIfNeeded()
      assert.ok(await page.locator('.main-content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'No horizontal overflow')
      await page.screenshot({ path: path.join(work, `${name}-${width}-${darkMode ? 'dark' : 'light'}.png`) })
    }
  }
}
try {
  await launch()
  await fixtures(false)
  await page.reload()
  await openSettings()
  const section = page.locator('#settings-ai')
  await waitFor(() => document.querySelector('#settings-ai fieldset:disabled'))
  await section.getByText('未检测到 Codex', { exact: true }).waitFor()
  await capture('install-overlay')
  await section.getByRole('button', { name: '一键下载', exact: true }).click()
  await waitFor(() => document.querySelector('#settings-ai fieldset:not(:disabled)'))
  assert.equal(await app.evaluate(() => globalThis.codexSaveSmoke.installCalls), 1)
  checks.push('missing CLI keeps the settings mask; one-click download uses the same integration installer IPC')

  await app.evaluate(() => { globalThis.codexSaveSmoke.holdNext = true })
  await section.getByRole('button', { name: '刷新当前服务的模型' }).click()
  await waitFor(() => document.querySelector('#settings-ai .beginner-model-control .spin'))
  assert.ok(await section.getByRole('textbox', { name: '模型', exact: true }).isEnabled(), 'Model editing must remain available during discovery')
  const key = 'isolated-local-fixture-key'
  await section.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://new.example/v1')
  await section.locator('input[data-secret]').fill(key)
  const began = Date.now()
  await section.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByText('连接已保存到本地设置', { exact: true }).waitFor()
  assert.ok(Date.now() - began < 5000, 'Save must not wait for held old discovery')
  assert.ok(await section.getByRole('button', { name: '保存连接', exact: true }).isEnabled())
  let saved = await page.evaluate(() => window.modmind.settings.getAgent())
  assert.equal(saved.externalAgents.codex.baseUrl, 'https://new.example/v1')
  assert.equal(saved.externalAgents.codex.model, 'manual-id')
  assert.equal(saved.externalAgents.codex.hasStoredKey, true)
  assert.equal(await page.evaluate(() => window.modmind.settings.revealSecret('codex')), key)
  const disk = await readFile(path.join(profile, 'settings.json'), 'utf8')
  assert.ok(!disk.includes(key))
  checks.push('new connection overwrites malformed historical URL despite held old scan, invalid old threshold and unavailable models; key is encrypted')
  await app.evaluate(() => globalThis.codexSaveSmoke.release())
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await section.getByText('stale-model', { exact: true }).count(), 0)
  assert.equal((await page.evaluate(() => window.modmind.settings.getAgent())).externalAgents.codex.baseUrl, 'https://new.example/v1')
  checks.push('late old model result cannot replace the saved connection or model')
  await capture('saved-offline')

  await section.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://another.example/v1')
  assert.equal(await section.getByText('凭证已保存', { exact: true }).count(), 0)
  await section.getByRole('button', { name: '保存连接', exact: true }).click()
  await waitFor(() => window.modmind.settings.getAgent().then(value => value.externalAgents.codex.baseUrl === 'https://another.example/v1'))
  saved = await page.evaluate(() => window.modmind.settings.getAgent())
  assert.equal(saved.externalAgents.codex.hasStoredKey, false)
  assert.ok(!JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).encryptedAgentKeys)
  checks.push('new endpoint without a new key saves an incomplete configuration and never inherits the previous endpoint credential')
  await app.close()
  page = undefined
  await launch()
  await fixtures(true)
  await page.reload()
  saved = await page.evaluate(() => window.modmind.settings.getAgent())
  assert.equal(saved.externalAgents.codex.baseUrl, 'https://another.example/v1')
  assert.equal(saved.externalAgents.codex.hasStoredKey, false)
  await openSettings()
  await page.locator('#settings-ai').getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://repaired.example/v1')
  await page.locator('#settings-ai input[data-secret]').fill(key)
  await page.locator('#settings-ai').getByRole('button', { name: '保存连接', exact: true }).click()
  await waitFor(() => window.modmind.settings.getAgent().then(value => value.externalAgents.codex.baseUrl === 'https://repaired.example/v1'))
  checks.push('full app exit and restart retains the new connection and permits another repair save')
  console.log(JSON.stringify({ checks, screenshots: work }, null, 2))
} finally {
  await app?.close()
}
