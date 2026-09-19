import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual settings page with isolated storage and deterministic IPC responses.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'ai-attachments', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-workspace-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
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
  const projectPath = path.join(work, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '附件验证', namespace: 'attachment_test', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.6' }))
  await writeFile(path.join(projectPath, 'modmind.pack.json'), JSON.stringify({ version: 1, name: '附件验证', loader: 'fabric', minecraftVersion: '1.21.1', mods: [], modules: [] }))
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  const sidebar = page.locator('#main-sidebar')
  const navigate = async name => {
    const button = sidebar.getByRole('button', { name, exact: true, includeHidden: true })
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
  }
  const source = path.join(work, 'reference.txt')
  const folder = path.join(work, 'textures')
  await writeFile(source, 'attachment reference')
  await mkdir(folder)
  await writeFile(path.join(folder, 'tile.txt'), 'nested reference')
  const cdp = await page.context().newCDPSession(page)
  const dropPaths = async (composer, files) => {
    const bounds = await composer.boundingBox()
    const event = { x: bounds.x + 25, y: bounds.y + 25, data: { items: [], files, dragOperationsMask: 1 } }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...event })
    await composer.locator('.ai-attachment-drop-hint').waitFor()
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...event })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...event })
  }
  const paste = async (textarea, count = 1) => textarea.evaluate((node, count) => {
    const data = new DataTransfer()
    for (let index = 0; index < count; index++) data.items.add(new File([new Uint8Array([137, 80, 78, 71])], `screenshot-${index}.png`, { type: 'image/png' }))
    return !node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, count)
  for (const [name, selector] of [['工作台', '.agent-composer'], ['灵感台', '.inspiration-composer']]) {
    await navigate(name)
    const composer = page.locator(`${selector}:visible`)
    const textarea = composer.locator('textarea')
    await textarea.waitFor()
    await textarea.fill('保留原有文字')
    assert.equal(await paste(textarea), true)
    await composer.getByTitle('移除 screenshot-0.png', { exact: true }).waitFor()
    assert.equal(await textarea.inputValue(), '保留原有文字')
    await dropPaths(composer, [source, folder])
    await composer.getByTitle('移除 reference.txt', { exact: true }).waitFor()
    await composer.getByTitle('移除 textures', { exact: true }).waitFor()
    assert.equal(await composer.locator('.ai-attachment-chip').count(), 3)
    assert.equal(await textarea.evaluate(node => {
      const data = new DataTransfer(); data.setData('text/plain', '普通文字')
      return node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }), true, 'plain text keeps the default paste behavior')
    await paste(textarea, 6)
    await composer.getByRole('alert').filter({ hasText: '8' }).waitFor()
    assert.equal(await composer.locator('.ai-attachment-chip').count(), 3)
    await composer.getByTitle('移除 reference.txt', { exact: true }).click()
    assert.equal(await composer.locator('.ai-attachment-chip').count(), 2)
    await page.screenshot({ path: path.join(work, `${name}.png`) })
  }
  const { readdir, readFile } = await import('node:fs/promises')
  const stored = await readdir(path.join(projectPath, '.modmind', 'attachments'))
  assert.equal(stored.length, 6, 'both composers persist all three attachments through real preload and IPC')
  for (const file of stored.filter(file => file.endsWith('reference.txt'))) assert.equal(await readFile(path.join(projectPath, '.modmind', 'attachments', file), 'utf8'), 'attachment reference')
  for (const file of stored.filter(file => file.endsWith('textures'))) assert.equal(await readFile(path.join(projectPath, '.modmind', 'attachments', file, 'tile.txt'), 'utf8'), 'nested reference')
  // Keep imports pending to exercise keyboard submission, errors and conversation changes.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:importAttachments')
    ipcMain.handle('ai:importAttachments', () => new Promise((resolve, reject) => { globalThis.attachmentPending = { resolve, reject } }))
  })
  for (const [name, selector] of [['工作台', '.agent-composer'], ['灵感台', '.inspiration-composer']]) {
    await navigate(name)
    const composer = page.locator(`${selector}:visible`)
    const textarea = composer.locator('textarea')
    await paste(textarea)
    await composer.getByText('正在添加附件…', { exact: true }).waitFor()
    assert.equal(await composer.getByRole('button', { name: '发送', exact: true }).isDisabled(), true)
    await textarea.press('Enter')
    assert.equal(await textarea.inputValue(), '保留原有文字')
    await app.evaluate(() => globalThis.attachmentPending.reject(new Error('附件测试读取失败')))
    await composer.getByRole('alert').filter({ hasText: '附件测试读取失败' }).waitFor()
    await paste(textarea)
    await composer.getByText('正在添加附件…', { exact: true }).waitFor()
    if (name === '工作台') {
      await page.getByRole('button', { name: '切换对话', exact: true }).click()
      await page.getByRole('button', { name: '新建对话', exact: true }).click()
      await page.getByRole('button', { name: '切换对话', exact: true }).locator('small').filter({ hasText: '2' }).waitFor()
    } else await page.getByRole('button', { name: '新建灵感对话', exact: true }).click()
    if (name === '灵感台') assert.equal(await textarea.inputValue(), '')
    await app.evaluate(() => globalThis.attachmentPending.resolve([{ id: 'late', name: 'late.txt', path: '.modmind/attachments/late.txt', size: 1, isImage: false }]))
    await composer.getByText('正在添加附件…', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await composer.getByTitle('移除 late.txt', { exact: true }).count(), 0, 'late imports cannot attach to another conversation')
  }
  console.log('PASS: both composers paste images, drop native files/folders, preserve text, remove attachments and enforce limits through real IPC; pending imports block send and cannot cross conversations')
  console.log(work)
} finally {
  await app?.close().catch(() => undefined)
  await server.close()
}
