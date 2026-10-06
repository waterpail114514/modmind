import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

// Real Electron settings, encrypted persistence and HTTP requests. The local
// fixture deliberately serves models only under /v1.
const root = path.resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'modmind-api-restart-'))
const profile = path.join(temporary, 'profile')
const nativeHome = path.join(temporary, 'native')
const work = path.join(root, 'test-results', 'custom-api-restart', String(Date.now()))
await mkdir(profile, { recursive: true })
await mkdir(nativeHome, { recursive: true })
await mkdir(work, { recursive: true })
let offline = false
const requests = []
const key = 'local-test-fixture-key'
const ids = ['a-provider-first', 'z-provider-second']
const server = createServer((request, response) => {
  requests.push(request.url)
  if (offline) return response.writeHead(503).end()
  if (request.url !== '/v1/models') return response.writeHead(404).end()
  if (request.headers.authorization !== `Bearer ${key}`) return response.writeHead(401).end()
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: ids.map(id => ({ id })) }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
await writeFile(path.join(nativeHome, 'config.toml'), `model = "gpt-native-unrelated"\nmodel_provider = "native"\n[model_providers.native]\nbase_url = "${base}/native"\n`)
const bootstrap = path.join(temporary, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-api-restart'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env, CODEX_HOME: nativeHome }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app, page
const checks = []
async function launch() {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let i = 0; i < 150; i++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(30000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.hide(); window.webContents.setBackgroundThrottling(false) }))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile))
  await waitFor(() => Boolean(window.modmind))
}
async function waitFor(predicate, argument) {
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(predicate, argument)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for actual app state')
}
async function openSettings() {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
}
async function settings() { return page.evaluate(() => window.modmind.settings.getAgent()) }
try {
  await launch()
  await page.evaluate(async () => window.modmind.settings.saveAgent({ ...await window.modmind.settings.getAgent(), codingBackend: 'quota', externalAgents: { codex: { mode: 'hosted', model: '' } } }))
  await page.reload()
  await page.locator('.expert-mode-toggle').click()
  await openSettings()
  let section = page.locator('#settings-ai')
  await section.getByRole('button', { name: '本机 Codex', exact: true }).click()
  await waitFor(() => document.querySelector('#settings-ai fieldset:not(:disabled)'))
  await section.getByRole('textbox', { name: 'Base URL', exact: true }).fill(base)
  await section.locator('input[data-secret]').fill(key)
  await section.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByText('连接已保存到本地设置', { exact: true }).waitFor()
  await waitFor(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')?.value === 'a-provider-first')
  // Workbench discovery can overlap the post-save settings refresh.
  const missingRoute = requests.indexOf('/model', requests.indexOf('/models'))
  assert.ok(missingRoute >= 0 && requests.indexOf('/v1/models', missingRoute) > missingRoute)
  assert.equal((await settings()).externalAgents.codex.baseUrl, `${base}/v1`)
  assert.equal((await settings()).codingBackend, 'codex')
  assert.equal((await settings()).externalAgents.codex.model, ids[0])
  checks.push('unversioned URL falls back to /v1; first returned model auto-selected and persisted')
  const stored = await readFile(path.join(profile, 'settings.json'), 'utf8')
  assert.ok(!stored.includes(key))
  assert.ok(JSON.parse(stored).encryptedAgentKeys.codex)
  await app.close()
  page = undefined
  await launch()
  await openSettings()
  section = page.locator('#settings-ai')
  assert.equal(await section.getByRole('button', { name: '本机 Codex', exact: true }).getAttribute('aria-pressed'), 'true')
  await waitFor(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')?.value === 'a-provider-first')
  assert.equal((await settings()).externalAgents.codex.hasStoredKey, true)
  checks.push('full app exit and relaunch restores custom backend, resolved URL, encrypted key and first model')
  await section.getByRole('combobox', { name: '模型', exact: true }).selectOption(ids[1])
  await waitFor(() => window.modmind.settings.getAgent().then(s => s.externalAgents.codex.model === 'z-provider-second'))
  await section.getByRole('button', { name: '刷新当前服务的模型' }).click()
  await waitFor(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')?.value === 'z-provider-second')
  checks.push('manual model selection survives refresh')
  offline = true
  await app.close()
  page = undefined
  await launch()
  await openSettings()
  section = page.locator('#settings-ai')
  await section.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor()
  assert.equal((await settings()).externalAgents.codex.mode, 'hosted')
  assert.equal((await settings()).externalAgents.codex.baseUrl, `${base}/v1`)
  assert.equal((await settings()).externalAgents.codex.model, ids[1])
  assert.ok(!requests.some(url => url.startsWith('/native')))
  checks.push('offline restart keeps saved custom connection and model; no native provider scan')
  offline = false
  await section.getByRole('button', { name: '重试', exact: true }).click()
  await waitFor(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')?.value === 'z-provider-second')
  checks.push('retry reconnects using stored credentials and preserves model')
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 1000 })
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(work, `restart-${width}.png`) })
  }
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ success: true, checks, requests, models: ids }, null, 2))
  console.log(JSON.stringify({ success: true, checks, artifacts: work }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close()
  await new Promise(resolve => server.close(resolve))
  assert.ok(path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('modmind-api-restart-'))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
