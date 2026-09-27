import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'sidebar-editor', String(Date.now()))
const profile = path.join(work, 'profile')
const projectPath = path.join(work, 'project')
await mkdir(profile, { recursive: true })
await mkdir(path.join(projectPath, 'src/main/resources'), { recursive: true })
await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '侧栏编辑验证', namespace: 'sidebar_test', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.11' }))
await writeFile(path.join(projectPath, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'sidebar_test', version: '0.1.0', name: '侧栏编辑验证' }))
await writeFile(path.join(projectPath, 'build.gradle'), 'plugins { id "java" }\nrepositories { mavenCentral() }\ndependencies {}\n')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-sidebar-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), publicDir: path.join(root, 'resources/renderer-public'), plugins: [react()], resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 0 } })
const storageKey = 'modmind-sidebar-layout:v1:v3:advanced:mod:java'
let app
let page
try {
  await server.listen()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(env.ELECTRON_RENDERER_URL))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow, ipcMain, session }) => {
    BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() })
    // Fresh profile, no online renderer resources. Main service calls are unrelated to this local preference.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith('http://127.0.0.1:') }))
    ipcMain.removeHandler('image-studio:capabilities')
    ipcMain.handle('image-studio:capabilities', () => ({ models: [], sizes: [], qualities: [], moderations: [] }))
  })
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => {
    localStorage.setItem('modmind-ui-mode', 'advanced')
    localStorage.setItem('modmind-sidebar-order:v3:advanced:mod:java', JSON.stringify({ 0: ['inspiration', 'workspace'] }))
    localStorage.setItem('modmind-sidebar-order:v3:advanced:mod:java:groups', JSON.stringify(['1', '0', '2', '3', '4', '5']))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })
  const sidebar = page.locator('#main-sidebar')
  await sidebar.getByRole('button', { name: '切换项目：侧栏编辑验证', exact: true }).waitFor()
  const openEditor = async () => {
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开设置', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索设置' }).fill('侧边栏')
    await page.getByRole('button', { name: '编辑侧边栏', exact: true }).click()
  }
  const editor = page.locator('.sidebar-editor')
  const category = name => editor.getByRole('region', { name: `编辑分类：${name}`, exact: true })
  const navCategory = name => sidebar.getByRole('group', { name, exact: true })
  const navLabels = name => navCategory(name).locator('.sidebar-nav-item').allTextContents()
  const snapshot = async name => {
    await editor.scrollIntoViewIfNeeded()
    const overflow = await page.locator('.main-content').evaluate(node => node.scrollWidth - node.clientWidth)
    assert.ok(overflow <= 1, `${name} overflows by ${overflow}px`)
    await page.screenshot({ path: path.join(work, `${name}.png`) })
  }
  await openEditor()
  assert.deepEqual(await navLabels('创作'), ['灵感台', '工作台'])
  assert.equal(await sidebar.locator('.sidebar-nav-group').first().getAttribute('aria-label'), '资源')

  await editor.getByLabel('新分类名称', { exact: true }).fill('我的常用')
  await editor.getByRole('button', { name: '新建分类', exact: true }).click()
  assert.equal(await category('我的常用').count(), 1)
  assert.equal(await navCategory('我的常用').count(), 0)
  const customKey = await editor.getByLabel('声音所属分类').locator('option').filter({ hasText: '我的常用' }).getAttribute('value')
  await editor.getByLabel('声音所属分类').selectOption(customKey)
  await editor.getByLabel('图像工坊所属分类').selectOption(customKey)
  await category('我的常用').getByRole('button', { name: '上移图像工坊', exact: true }).click()
  assert.deepEqual(await navLabels('我的常用'), ['图像工坊', '声音'])
  await editor.getByRole('button', { name: '重命名分类：我的常用', exact: true }).click()
  await editor.getByLabel('分类名称：我的常用', { exact: true }).fill('常用工具')
  await editor.getByLabel('分类名称：我的常用', { exact: true }).press('Enter')
  await navCategory('常用工具').waitFor()
  assert.equal(await editor.getByRole('textbox', { name: /分类名称：/ }).count(), 0)
  await editor.getByRole('button', { name: '重命名分类：常用工具', exact: true }).click()
  await editor.getByLabel('分类名称：常用工具', { exact: true }).fill('取消的名称')
  await editor.getByLabel('分类名称：常用工具', { exact: true }).press('Escape')
  assert.equal(await editor.getByRole('button', { name: '重命名分类：常用工具', exact: true }).evaluate(node => node === document.activeElement), true)
  assert.equal(await editor.getByRole('textbox', { name: /分类名称：/ }).count(), 0)
  await editor.getByLabel('显示声音', { exact: true }).uncheck()
  assert.deepEqual(await navLabels('常用工具'), ['图像工坊'])
  await editor.getByRole('button', { name: '上移分类：常用工具', exact: true }).click()
  await editor.getByLabel('显示设置', { exact: true }).uncheck()
  assert.equal(await sidebar.locator('button.sidebar-nav-item').filter({ hasText: /^设置$/ }).count(), 0)
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey)
  assert.ok(saved.hiddenItems.includes('settings') && saved.hiddenItems.includes('sounds'))

  // Custom categories retain the existing detached-window path and live layout synchronization.
  const detachedPromise = app.waitForEvent('window')
  await page.evaluate(key => window.modmind.app.openDetachedWindow(`group:${key}`, '常用工具'), customKey)
  const detached = await detachedPromise
  await detached.locator('.detached-titlebar .titlebar-name').filter({ hasText: '常用工具' }).waitFor()
  const detachedSidebar = detached.locator('.sidebar-nav')
  assert.equal(await detachedSidebar.locator('.sidebar-nav-item').count(), 1)
  await editor.getByLabel('显示声音', { exact: true }).check()
  await detachedSidebar.getByRole('button', { name: '声音', exact: true }).waitFor()
  await editor.getByLabel('显示声音', { exact: true }).uncheck()
  await detachedSidebar.getByRole('button', { name: '声音', exact: true }).waitFor({ state: 'detached' })
  await detached.close()

  await page.reload()
  await openEditor()
  assert.deepEqual(await navLabels('常用工具'), ['图像工坊'])
  assert.equal(await editor.getByLabel('显示声音', { exact: true }).isChecked(), false)
  assert.equal(await page.locator('.expert-mode-toggle input').isChecked(), true)
  await category('常用工具').locator('summary').click()
  await category('常用工具').getByRole('button', { name: '删除分类', exact: true }).click()
  assert.equal(await category('常用工具').count(), 0)
  assert.deepEqual(await navLabels('未分类'), ['图像工坊'])
  assert.equal(await editor.getByLabel('显示声音', { exact: true }).isChecked(), false)
  await editor.getByRole('button', { name: '撤销上一步' }).click()
  assert.deepEqual(await navLabels('常用工具'), ['图像工坊'])
  assert.equal(await category('未分类').count(), 0)

  await editor.getByLabel('新分类名称').fill('创作')
  await editor.getByRole('button', { name: '新建分类', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: '已有同名分类' }).waitFor()
  await editor.getByLabel('新分类名称').fill('   ')
  await editor.getByRole('button', { name: '新建分类', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: '请输入分类名称' }).waitFor()
  await editor.getByLabel('新分类名称').fill('')

  // Failed writes preserve the applied layout, and retry commits the pending change.
  await page.evaluate(() => {
    window.originalSidebarStorageSet = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('modmind-sidebar-layout:')) throw new Error('fixture quota exceeded'); return window.originalSidebarStorageSet.call(this, key, value) }
  })
  await editor.getByLabel('显示声音', { exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: '侧边栏未保存' }).waitFor()
  assert.equal(await editor.getByLabel('显示声音', { exact: true }).isChecked(), false)
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSidebarStorageSet })
  await editor.getByRole('button', { name: '重试', exact: true }).click()
  assert.equal(await editor.getByLabel('显示声音', { exact: true }).isChecked(), true)
  assert.deepEqual(await navLabels('常用工具'), ['图像工坊', '声音'])

  // Bulk hiding must leave a recovery path even with an empty navigation.
  for (const group of await editor.locator('.sidebar-editor-group').all()) {
    await group.locator('summary').click()
    await group.getByRole('button', { name: '全部隐藏', exact: true }).click()
  }
  assert.equal(await sidebar.locator('.sidebar-nav-item').count(), 0)
  await editor.getByRole('button', { name: '收起编辑', exact: true }).click()
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '编辑侧边栏', exact: true }).click()
  await editor.locator('summary[aria-label="侧边栏选项"]').click()
  await editor.getByRole('button', { name: '恢复默认布局', exact: true }).click()
  assert.equal(await category('常用工具').count(), 0)
  assert.deepEqual(await navLabels('创作'), ['工作台', '灵感台'])
  assert.ok(await sidebar.locator('.sidebar-nav-item').count() > 10)
  await navCategory('创作').getByRole('button', { name: '灵感台', exact: true }).dragTo(navCategory('创作').getByRole('button', { name: '工作台', exact: true }))
  assert.deepEqual(await navLabels('创作'), ['灵感台', '工作台'])
  assert.equal(await category('创作').locator('.sidebar-editor-item-label').first().innerText(), '灵感台')

  for (const dark of [false, true]) {
    await page.evaluate(async darkMode => { const current = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({ ...current, darkMode }) }, dark)
    await page.reload()
    await openEditor()
    for (const width of [1440, 640, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width === 390) await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await snapshot(`${dark ? 'dark' : 'light'}-${width}`)
      if (width === 640 && !dark) {
        await editor.getByRole('button', { name: '重命名分类：创作', exact: true }).click()
        await page.screenshot({ path: path.join(work, 'rename-inline-640.png') })
        await editor.getByLabel('分类名称：创作', { exact: true }).press('Escape')
      }
      // Exercise a control at the actual narrow width, not only a screenshot.
      await editor.getByLabel('显示灵感台', { exact: true }).uncheck()
      assert.equal(await sidebar.locator('.sidebar-nav-item').filter({ hasText: '灵感台' }).count(), 0)
      await editor.getByLabel('显示灵感台', { exact: true }).check()
      if (width === 390) await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  // Corrupt storage is readable/recoverable without erasing the original until the user acts.
  await page.evaluate(key => localStorage.setItem(key, '{broken'), storageKey)
  await page.reload()
  await openEditor()
  await editor.getByRole('alert').filter({ hasText: '侧边栏布局无法读取' }).waitFor()
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), '{broken')
  await snapshot('corrupt-storage-recovery')
  await editor.locator('summary[aria-label="侧边栏选项"]').click()
  await editor.getByRole('button', { name: '恢复默认布局', exact: true }).click()
  assert.equal(await editor.getByRole('alert').count(), 0)

  // Basic-mode settings must not silently switch the mode or share its layout.
  await editor.getByLabel('显示灵感台', { exact: true }).uncheck()
  await page.locator('.expert-mode-toggle').click()
  await openEditor()
  assert.equal(await page.locator('.expert-mode-toggle input').isChecked(), false)
  assert.equal(await editor.getByLabel('显示灵感台', { exact: true }).isChecked(), true)
  await page.locator('.expert-mode-toggle').click()
  await openEditor()
  assert.equal(await editor.getByLabel('显示灵感台', { exact: true }).isChecked(), false)
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ work, checked: ['legacy migration', 'create / rename / reorder / delete categories', 'move and reorder entries', 'hide / show / bulk hide / recovery', 'reload persistence', 'delete undo', 'invalid names', 'failed storage write and retry', 'corrupt storage recovery', 'fresh profile without online renderer resources', 'six theme / width layouts with interaction', 'mode isolation', 'custom detached category and cross-window sync', 'main sidebar drag and editor sync', 'inline rename and Escape focus'], errors }, null, 2))
  console.log(`PASS: sidebar editor. Artifacts: ${work}`)
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(-6000)) }
  throw error
} finally {
  await app?.close()
  await server.close()
}
