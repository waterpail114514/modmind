import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual settings page with isolated storage and deterministic IPC responses.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'settings-redesign', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-settings-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const server = await createServer({
  configFile: false, root: path.join(root, 'src/renderer'),
  publicDir: path.join(root, 'resources/renderer-public'), plugins: [react()],
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } },
  server: { host: '127.0.0.1', port: 0 }
})
let app
try {
  await server.listen()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(env.ELECTRON_RENDERER_URL))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'main renderer window must be available')
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile), path.resolve(profile))
  await page.waitForFunction(() => Boolean(window.modmind)).catch(async error => {
    console.error('Initialization:', page.url(), await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), preferences: window.webContents.getLastWebPreferences() }))))
    await page.screenshot({ path: path.join(work, 'initialization-error.png') })
    throw error
  })
  const originalSettings = await page.evaluate(() => window.modmind.settings.getAgent())
  assert.equal(originalSettings.allowLongerContext, false)
  await page.evaluate(async () => window.modmind.settings.saveAgent({ ...await window.modmind.settings.getAgent(), allowLongerContext: true }))
  assert.equal((await page.evaluate(() => window.modmind.settings.getAgent())).allowLongerContext, true)
  await page.evaluate(async () => window.modmind.settings.saveAgent({ ...await window.modmind.settings.getAgent(), allowLongerContext: false }))
  assert.equal((await page.evaluate(() => window.modmind.settings.getAgent())).allowLongerContext, false)
  await app.evaluate(({ ipcMain }, initial) => {
    const state = globalThis.settingsSmoke = {
      settings: initial, failSettings: false, failImage: false, writes: [],
      image: { baseUrl: 'https://saved.example/v1', model: 'image-a', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true }
    }
    const handle = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn) }
    state.settings.externalAgents = { codex: { mode: 'hosted', baseUrl: 'https://api.deepseek.com/v1', model: 'gpt-stale', hasStoredKey: true } }
    state.failModels = false
    state.modelScans = 0
    const codexStatus = { kind: 'codex', label: 'Codex', installed: true, executable: 'fixture-codex', detail: '' }
    handle('external-agents:detect', () => [codexStatus])
    handle('external-agents:scanLocal', () => {
      state.modelScans++
      return { status: codexStatus, home: '/fixture', ...state.settings.externalAgents.codex, hasApiKey: true,
        models: state.failModels ? [] : ['deepseek-chat', 'deepseek-reasoner'], modelsError: state.failModels ? '模型服务暂时不可用' : undefined }
    })
    handle('external-agents:configure', (_, kind, configuration) => {
      state.settings.externalAgents[kind] = { ...configuration, apiKey: '', hasStoredKey: true }
      return { kind, detail: 'saved locally' }
    })
    handle('settings:getAgent', () => state.settings)
    handle('settings:saveAgent', async (_, input) => {
      if (state.failSettings) throw new Error('模拟保存失败')
      state.settings = input
      return state.settings
    })
    handle('image-studio:getSettings', () => state.image)
    handle('image-studio:capabilities', () => ({ models: ['image-a', 'image-b'], sizes: [], qualities: [], moderations: [] }))
    handle('image-studio:saveSettings', async (_, input) => {
      state.writes.push(input)
      if (state.failImage) throw new Error('模拟图像保存失败')
      state.image = { ...state.image, ...input, hasStoredKey: Boolean(input.apiKey) || state.image.hasStoredKey }
      return state.image
    })
  }, originalSettings)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.reload()
  await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '设置', exact: true }).click().catch(async error => {
    console.error('Page:', page.url(), await page.locator('body').innerText(), errors)
    await page.screenshot({ path: path.join(work, 'page-error.png') })
    throw error
  })
  const nav = page.getByRole('navigation', { name: '设置分类' })
  const category = name => nav.getByRole('button', { name, exact: true }).click()
  const visibleIds = () => page.locator('.settings-section:visible').evaluateAll(nodes => nodes.map(node => node.id))
  for (const button of await page.locator('.sidebar-nav-item:visible').all()) {
    assert.ok(await button.evaluate(node => Math.abs(node.getBoundingClientRect().width - node.parentElement.getBoundingClientRect().width) <= 1), 'expanded sidebar buttons must fill their group')
  }
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  for (const button of await page.locator('.sidebar-nav-item:visible').all()) {
    const bounds = await button.boundingBox()
    assert.ok(Math.abs(bounds.width - 40) < 0.1)
    assert.ok(Math.abs(bounds.height - 40) < 0.1)
  }
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  assert.deepEqual(await visibleIds(), ['settings-appearance', 'settings-sidebar-order', 'settings-notifications'])
  assert.equal(await nav.locator('[aria-current="page"]').innerText(), '通用')

  const search = page.getByRole('searchbox', { name: '搜索设置' })
  await search.fill('模型')
  assert.deepEqual(await visibleIds(), ['settings-ai', 'settings-image', 'settings-agent-info'])
  assert.equal(await nav.locator('[aria-current]').count(), 0)
  await search.fill('JAVA jdk')
  assert.deepEqual(await visibleIds(), ['settings-java'])
  await search.fill('深色模式')
  assert.deepEqual(await visibleIds(), ['settings-appearance'])
  await search.fill('HTTP 代理地址')
  assert.deepEqual(await visibleIds(), ['settings-network'])
  await search.fill('不存在的设置')
  await page.getByText('没有找到相关设置', { exact: true }).waitFor()
  await search.press('Escape')
  assert.equal(await search.inputValue(), '')
  assert.equal(await search.evaluate(node => node === document.activeElement), true)

  await category('集成')
  const proxy = page.getByRole('textbox', { name: 'HTTP 代理地址' })
  await proxy.fill('http://127.0.0.1:8899')
  await category('通用')
  await category('集成')
  assert.equal(await proxy.inputValue(), 'http://127.0.0.1:8899')
  assert.notEqual(await page.evaluate(async () => (await window.modmind.settings.getAgent()).networkProxyUrl), 'http://127.0.0.1:8899')
  await app.evaluate(() => { globalThis.settingsSmoke.failSettings = true })
  await proxy.press('Enter')
  await page.getByText('保存失败，输入已保留，请重试', { exact: true }).waitFor()
  assert.equal(await proxy.inputValue(), 'http://127.0.0.1:8899')
  await app.evaluate(() => { globalThis.settingsSmoke.failSettings = false })
  await page.getByRole('button', { name: '保存代理配置', exact: true }).click()
  await page.getByText('代理配置已保存', { exact: true }).waitFor()
  assert.equal(await page.evaluate(async () => (await window.modmind.settings.getAgent()).networkProxyUrl), 'http://127.0.0.1:8899')

  await category('AI 与图像')
  const longerContext = page.getByRole('switch', { name: '允许更长上下文（可能造成更多消费）' })
  assert.equal(await longerContext.evaluate(node => Boolean(node.closest('.model-context-setting')?.querySelector('input[id$="-compact"]'))), true)
  assert.equal(await longerContext.getAttribute('aria-checked'), 'false')
  await longerContext.click()
  assert.equal(await page.evaluate(async () => (await window.modmind.settings.getAgent()).allowLongerContext), true)
  await longerContext.click()
  assert.equal(await page.evaluate(async () => (await window.modmind.settings.getAgent()).allowLongerContext), false)
  const imageSection = page.locator('#settings-image')
  await imageSection.locator('summary').click()
  const url = imageSection.getByRole('textbox', { name: 'Base URL', exact: true })
  await url.fill('https://draft.example/v1')
  await imageSection.getByLabel('图片 API Key', { exact: true }).fill('test-only-key')
  const model = imageSection.getByRole('combobox', { name: '图片模型' })
  await model.selectOption('image-b')
  await imageSection.getByText('图片模型已自动保存；自定义 API 尚未保存', { exact: true }).waitFor()
  const write = await app.evaluate(() => globalThis.settingsSmoke.writes.at(-1))
  assert.equal(write.model, 'image-b')
  assert.equal(write.baseUrl, 'https://saved.example/v1')
  assert.equal(write.apiKey, '')
  await category('通用')
  await category('AI 与图像')
  assert.equal(await url.inputValue(), 'https://draft.example/v1')
  assert.equal(await imageSection.getByLabel('图片 API Key', { exact: true }).inputValue(), 'test-only-key')
  assert.equal(await imageSection.locator('details').getAttribute('open'), '')
  await imageSection.getByRole('button', { name: '保存自定义 API', exact: true }).click()
  await page.getByText('图像服务配置已保存', { exact: true }).first().waitFor()
  assert.equal((await app.evaluate(() => globalThis.settingsSmoke.writes.at(-1))).baseUrl, 'https://draft.example/v1')
  await app.evaluate(() => { globalThis.settingsSmoke.failImage = true })
  await model.selectOption('image-a')
  await page.getByText('保存失败，请重试；当前设置未更改', { exact: true }).waitFor()
  assert.equal(await model.inputValue(), 'image-b')
  await app.evaluate(() => { globalThis.settingsSmoke.failImage = false })

  const aiSection = page.locator('#settings-ai')
  await aiSection.getByRole('button', { name: '本机 Codex', exact: true }).click()
  const codexModel = aiSection.getByRole('combobox', { name: '模型', exact: true })
  await codexModel.waitFor()
  await page.waitForFunction(() => document.querySelector('#settings-ai .beginner-model-control select')?.value === 'deepseek-chat')
  assert.equal(await codexModel.inputValue(), 'deepseek-chat', 'first provider model must replace a stale GPT selection')
  assert.deepEqual(await codexModel.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'deepseek-chat', 'deepseek-reasoner'])
  assert.equal(await aiSection.getByText('使用本机配置', { exact: true }).count(), 0)
  assert.equal(await aiSection.getByText('当前使用 ModMind 配置的模型服务', { exact: true }).count(), 0)
  await codexModel.selectOption('deepseek-chat')
  await page.waitForFunction(() => window.modmind.settings.getAgent().then(settings => settings.externalAgents.codex.model === 'deepseek-chat'))
  await app.evaluate(() => { globalThis.settingsSmoke.failModels = true })
  await aiSection.getByRole('button', { name: '刷新当前服务的模型' }).click()
  await aiSection.getByRole('alert').filter({ hasText: '模型服务暂时不可用' }).waitFor()
  const manualModel = aiSection.getByRole('textbox', { name: '模型', exact: true })
  assert.equal(await manualModel.isEnabled(), true)
  await manualModel.fill('deepseek-reasoner')
  await manualModel.press('Enter')
  await page.waitForFunction(() => window.modmind.settings.getAgent().then(settings => settings.externalAgents.codex.model === 'deepseek-reasoner'))
  await app.evaluate(() => { globalThis.settingsSmoke.failModels = false })
  await aiSection.getByRole('button', { name: '重试', exact: true }).click()
  await codexModel.waitFor()
  assert.equal(await codexModel.inputValue(), 'deepseek-reasoner')
  const scansBeforeSave = await app.evaluate(() => globalThis.settingsSmoke.modelScans)
  await aiSection.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://new-provider.example/v1')
  await aiSection.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByText('连接已保存到本地设置', { exact: true }).waitFor()
  await page.waitForFunction(count => window.modmind.settings.getAgent().then(settings => settings.externalAgents.codex.baseUrl === 'https://new-provider.example/v1'), scansBeforeSave)
  await page.waitForFunction(() => document.querySelector('#settings-ai .beginner-model-control select:not(:disabled)'))
  for (let attempt = 0; attempt < 50 && !await app.evaluate((_, count) => globalThis.settingsSmoke.modelScans > count, scansBeforeSave); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await app.evaluate((_, count) => globalThis.settingsSmoke.modelScans > count, scansBeforeSave), 'saving a connection must refresh its models')
  const modelPanelWidth = await aiSection.locator('.local-codex-settings').evaluate(node => ({ panel: node.clientWidth, controls: node.querySelector('.beginner-ai-preferences').getBoundingClientRect().width }))
  assert.ok(modelPanelWidth.panel - modelPanelWidth.controls < 2, 'model controls must fill the panel without a reserved side column')

  const allIds = new Set()
  for (const name of ['通用', 'AI 与图像', '开发与构建', '集成', '关于']) {
    await category(name)
    for (const id of await visibleIds()) allIds.add(id)
  }
  assert.equal(allIds.size, 16, 'all existing sections must remain reachable')
  for (const dark of [false, true]) {
    await category('通用')
    if (dark) {
      await page.getByRole('switch', { name: '深色模式', exact: true }).click()
      await page.locator('.app-shell.dark-mode').waitFor()
    }
    for (const width of [1440, 800, 640, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const name of ['通用', 'AI 与图像', '开发与构建', '集成', '关于']) {
        await category(name)
        const overflow = await page.locator('.main-content').evaluate(node => node.scrollWidth - node.clientWidth)
        if (overflow > 1) {
          console.error('Overflowing elements:', await page.locator('.main-content').evaluate(container => [...container.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > container.getBoundingClientRect().right + 1).map(node => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 90), width: node.getBoundingClientRect().width }))))
          await page.screenshot({ path: path.join(work, 'overflow.png') })
        }
        assert.ok(overflow <= 1, `${name} overflow: ${width}px, dark=${dark}, extra=${overflow}`)
      }
      await category('通用')
      await page.screenshot({ path: path.join(work, `${dark ? 'dark' : 'light'}-${width}.png`) })
      if (width === 390 || width === 1440) {
        await category('AI 与图像')
        await longerContext.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(work, `ai-context-${dark ? 'dark' : 'light'}-${width}.png`) })
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await category('通用')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await category('AI 与图像')
  await imageSection.locator('summary').click()
  await page.screenshot({ path: path.join(work, 'ai-desktop.png') })
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ work, checked: ['five categories / all 16 sections', 'cross-category search and empty state', 'Escape and focus', 'drafts preserved across categories', 'proxy explicit save and failure retry', 'long-context switch persistence', 'image autosave excludes API drafts', 'image failure preserves selected model', 'provider models exclude stale GPT selection', 'model lookup failure, manual entry and retry', 'connection save refreshes models', 'no provider switch notice or reserved column', '40 category/theme/width overflow checks'], errors }, null, 2))
  console.log(`PASS: settings navigation, search, save semantics and responsive layouts. Artifacts: ${work}`)
} finally {
  await app?.close()
  await server.close()
}
