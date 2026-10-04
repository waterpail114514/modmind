// Real provider + real Electron IPC + real settings UI. No model-list mocks.
// MODMIND_DEEPSEEK_TEST_KEY must be supplied only for this process.
import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import tls from 'node:tls'
import path from 'node:path'
import assert from 'node:assert/strict'

const apiKey = process.env.MODMIND_DEEPSEEK_TEST_KEY?.trim()
delete process.env.MODMIND_DEEPSEEK_TEST_KEY
assert.ok(apiKey, 'A temporary DeepSeek API key is required')
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'deepseek-settings-live', String(Date.now()))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'modmind-deepseek-test-'))
const profile = path.join(temporary, 'profile')
await mkdir(work, { recursive: true })
await mkdir(profile, { recursive: true })
const bootstrap = path.join(temporary, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-deepseek-live-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
let app
let page
const report = { baseUrl: 'https://api.deepseek.com', mocks: false, models: [], checks: [] }
try {
  const response = await fetch(`${report.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200, 'DeepSeek model endpoint must accept the temporary key')
  report.models = (await response.json()).data.map(entry => entry.id).sort()
  assert.ok(report.models.length > 0, 'Provider must return models')
  report.checks.push('live provider /models HTTP 200')
  const env = { ...process.env }
  // Electron's bundled Node is older; give it the same OS-trusted roots as
  // this runner (node --use-system-ca). Certificate verification stays enabled.
  const caFile = path.join(temporary, 'system-ca.pem')
  await writeFile(caFile, tls.getCACertificates('system').join('\n'))
  env.NODE_EXTRA_CA_CERTS = caFile
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let attempt = 0; attempt < 150; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Main app window must open')
  // Poll via DevTools evaluate; Playwright's injected waitForFunction uses eval,
  // which the production renderer's CSP intentionally disallows.
  const waitFor = async (predicate, value) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await page.evaluate(predicate, value)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for real settings-window state')
  }
  page.setDefaultTimeout(60000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile), path.resolve(profile), 'Use an isolated test profile')
  await waitFor(() => Boolean(window.modmind))
  // Reproduce the reported stale selection using real local persistence.
  // No API key or provider response is seeded; both come through the UI below.
  await page.evaluate(async () => window.modmind.settings.saveAgent({
    ...await window.modmind.settings.getAgent(),
    codingBackend: 'quota', externalAgents: { codex: { mode: 'hosted', model: 'gpt-stale', baseUrl: 'https://api.deepseek.com' } }
  }))
  await page.reload()
  await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
  const section = page.locator('#settings-ai')
  await section.getByRole('button', { name: '本机 Codex', exact: true }).click()
  await waitFor(() => document.querySelector('#settings-ai fieldset:not(:disabled)'))
  await section.getByRole('textbox', { name: 'Base URL', exact: true }).fill(report.baseUrl)
  await section.locator('input[data-secret]').fill(apiKey)
  // Keep a selected ID while saving; the refresh must replace the native catalog.
  const selection = section.getByRole('combobox', { name: '模型', exact: true })
  if (await selection.count() && !await selection.inputValue()) {
    const candidate = await selection.locator('option').evaluateAll(nodes => nodes.find(node => node.value)?.value)
    if (candidate) await selection.selectOption(candidate)
  }
  await section.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByText('连接已保存到本地设置', { exact: true }).waitFor()
  await waitFor(expected => {
    const select = document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')
    return select && JSON.stringify([...select.options].map(option => option.value).filter(Boolean).sort()) === JSON.stringify(expected)
  }, report.models)
  report.checks.push('credentials entered in actual settings window; save triggered real IPC and provider refresh')
  assert.equal(await section.getByText('使用本机配置', { exact: true }).count(), 0)
  for (let i = 0; i < 2; i++) {
    await section.getByRole('button', { name: '刷新当前服务的模型' }).click()
    await waitFor(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)'))
    const models = await selection.locator('option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean).sort())
    assert.deepEqual(models, report.models, 'Dropdown must exactly match live provider results after refresh')
  }
  report.checks.push('two refresh button clicks returned exactly the live provider models; no GPT entries')
  await selection.selectOption(report.models.includes('deepseek-chat') ? 'deepseek-chat' : report.models[0])
  await waitFor(() => window.modmind.settings.getAgent().then(settings => settings.externalAgents.codex.model.startsWith('deepseek')))
  const stored = await readFile(path.join(profile, 'settings.json'), 'utf8')
  assert.ok(!stored.includes(apiKey), 'Settings must not store a plaintext key')
  assert.ok(Boolean(JSON.parse(stored).encryptedAgentKeys?.codex), 'Key must use encrypted local storage')
  report.checks.push('selected model persisted locally; API key encrypted on disk')
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
  await section.getByRole('button', { name: '本机 Codex', exact: true }).click()
  await waitFor(expected => {
    const select = document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)')
    return select && JSON.stringify([...select.options].map(option => option.value).filter(Boolean).sort()) === JSON.stringify(expected)
  }, report.models)
  report.checks.push('reloaded window fetched provider list with stored credentials')
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 1000 })
    await section.scrollIntoViewIfNeeded()
    assert.ok(await page.locator('.main-content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'No horizontal overflow')
    await page.screenshot({ path: path.join(work, `deepseek-${width}.png`) })
  }
  report.checks.push('desktop and narrow actual-window screenshots; no horizontal overflow')
  await selection.evaluate(node => { node.size = node.options.length })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: path.join(work, 'deepseek-model-options.png') })
  report.success = true
} catch (error) {
  await page?.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  report.success = false
  report.error = String(error?.message ?? error).replaceAll(apiKey, '[REDACTED]')
  process.exitCode = 1
} finally {
  await app?.close()
  // Only our freshly-created temporary profile is deleted, including encrypted credentials.
  assert.ok(path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('modmind-deepseek-test-'))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  report.credentialsCleaned = true
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, artifacts: work }, null, 2))
}
