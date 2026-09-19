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
  await app.evaluate(({ ipcMain }, initial) => {
    const state = globalThis.settingsSmoke = {
      settings: initial, failSettings: false, failImage: false, writes: [],
      image: { baseUrl: 'https://saved.example/v1', model: 'image-a', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true }
    }
    const handle = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn) }
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
  assert.deepEqual(await visibleIds(), ['settings-ai', 'settings-image', 'settings-agents'])
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

  const allIds = new Set()
  for (const name of ['通用', 'AI 与图像', '开发与构建', '集成', '关于']) {
    await category(name)
    for (const id of await visibleIds()) allIds.add(id)
  }
  assert.equal(allIds.size, 14, 'all existing sections must remain reachable')
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
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await category('通用')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await category('AI 与图像')
  await imageSection.locator('summary').click()
  await page.screenshot({ path: path.join(work, 'ai-desktop.png') })
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ work, checked: ['five categories / all 14 sections', 'cross-category search and empty state', 'Escape and focus', 'drafts preserved across categories', 'proxy explicit save and failure retry', 'image autosave excludes API drafts', 'image failure preserves selected model', '40 category/theme/width overflow checks'], errors }, null, 2))
  console.log(`PASS: settings navigation, search, save semantics and responsive layouts. Artifacts: ${work}`)
} finally {
  await app?.close()
  await server.close()
}
