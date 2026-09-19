import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual settings page with isolated storage and deterministic IPC responses.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'workspace-simplification', String(Date.now()))
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
  await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '精简界面验证', namespace: 'minimal_ui', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.6', toolDataDirectory: '.modmind' }))
  await writeFile(path.join(projectPath, 'modmind.pack.json'), JSON.stringify({ version: 1, name: '精简界面验证', loader: 'fabric', minecraftVersion: '1.21.1', mods: [], modules: [], source: { format: 'modrinth', layout: 'archive', importedAt: '' } }))
  for (const [file, content] of Object.entries({
    'config/gameplay.toml': 'difficulty = 2\n', 'kubejs/server_scripts/startup.js': '// Recipes\n',
    'datapacks/starter/pack.mcmeta': '{"pack":{"pack_format":48,"description":"Starter"}}',
    'fancymenu_data/layouts/menu.txt': 'title=Welcome', 'serverconfig/server.toml': 'spawnProtection = 16\n',
    'config/ftbquests/quests/chapters/start.snbt': '{ id: "0000000000000001", title: "入门", quests: [] }'
  })) {
    const target = path.join(projectPath, 'overrides', file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await app.evaluate(({ ipcMain, BrowserWindow }, projectPath) => {
    const state = globalThis.minimalUiServer = { stage: 'idle', running: false, minecraftVersion: '1.21.1', loader: 'fabric', projectPath, recentLogs: [], message: '尚未启动', port: 25565, commands: [] }
    const handle = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    const emit = () => BrowserWindow.getAllWindows().forEach(window => window.webContents.send('local-server:state', state))
    handle('modpack:getServerState', () => state)
    handle('modpack:getServerPackManifest', () => null)
    handle('modpack:startServer', () => { Object.assign(state, { stage: 'running', running: true, pid: 1234, message: '测试实例已启动', recentLogs: [{ time: new Date().toISOString(), message: 'Done! Local UI fixture ready.' }] }); emit(); return state })
    handle('modpack:stopServer', () => { Object.assign(state, { stage: 'stopped', running: false, message: '已停止' }); emit(); return state })
    handle('modpack:sendServerCommand', (_, command) => { state.commands.push(command); return true })
    handle('image-studio:capabilities', () => ({ models: ['gpt-image-2'], sizes: ['1024x1024'], qualities: ['medium'], moderations: ['auto'] }))
  }, projectPath)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  const sidebar = page.locator('#main-sidebar')
  const navigate = async name => {
    const button = sidebar.getByRole('button', { name, exact: true, includeHidden: true })
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await sidebar.getByRole('button', { name: '切换项目：精简界面验证', exact: true }).waitFor()
  await sidebar.locator('.nav-caption').first().waitFor()
  assert.equal(await sidebar.getByRole('button', { name: '灵感台', exact: true, includeHidden: true }).count(), 1)
  const contentGroup = sidebar.getByRole('button', { name: '内容', exact: true })
  assert.equal(await contentGroup.getAttribute('aria-expanded'), 'false')
  await contentGroup.focus()
  await page.keyboard.press('Enter')
  assert.equal(await contentGroup.getAttribute('aria-expanded'), 'true')
  await contentGroup.click()
  await page.reload()
  assert.equal(await contentGroup.getAttribute('aria-expanded'), 'false', 'collapsed groups persist across reloads')
  await navigate('工作台')
  await page.getByRole('button', { name: '切换对话', exact: true }).waitFor()
  assert.equal(await page.locator('.agent-workbench-title').count(), 0)
  await page.locator('.more-actions > summary[aria-label="工作台更多操作"]').click()
  await page.getByRole('button', { name: '重命名项目', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.more-actions[open]').count(), 0)
  await page.screenshot({ path: path.join(work, 'workbench.png') })

  await navigate('配置与默认项')
  await page.locator('.pack-content-file').first().waitFor()
  assert.equal(await page.locator('.pack-content-workspace > .content-toolbar').count(), 0)
  await page.locator('.pack-content-text-preview .monaco-editor').waitFor()
  await page.locator('.pack-content-text-preview .view-lines').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('difficulty = 3\n')
  await page.getByText('未保存 · 切换页面保留草稿', { exact: true }).waitFor()
  await navigate('脚本与 KubeJS')
  await page.locator('.pack-content-file').first().waitFor()
  await navigate('配置与默认项')
  await page.getByText('未保存 · 切换页面保留草稿', { exact: true }).waitFor()
  await page.getByRole('button', { name: '从链接添加', exact: true }).click()
  await page.getByLabel('下载地址', { exact: true }).waitFor()
  await page.getByRole('button', { name: '从链接添加', exact: true }).click()
  await page.screenshot({ path: path.join(work, 'content.png') })

  await navigate('服务端测试')
  await page.locator('.server-console-output').waitFor()
  assert.equal(await page.locator('.server-panel-hero, .server-stat-grid').count(), 0)
  const consoleBounds = await page.locator('.server-console-output').boundingBox()
  assert.ok(consoleBounds.y < 240, 'console should appear near the top')
  await page.getByRole('button', { name: '启动', exact: true }).click()
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  await page.getByLabel('服务器命令', { exact: true }).fill('list')
  await page.getByLabel('服务器命令', { exact: true }).press('Enter')
  assert.deepEqual(await app.evaluate(() => globalThis.minimalUiServer.commands), ['list'])
  await page.locator('.server-runtime-details > summary').click()
  await page.getByText('1234', { exact: true }).waitFor()
  await page.locator('.server-runtime-details > summary').click()
  await page.locator('.server-side-panel > summary').click()
  await page.getByRole('button', { name: /^同步服务端包/ }).waitFor()
  await page.locator('.server-side-panel > summary').click()
  await page.screenshot({ path: path.join(work, 'server.png') })
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.getByRole('button', { name: '启动', exact: true }).waitFor()

  await navigate('图像工坊')
  await page.locator('.react-flow__node').first().waitFor()
  assert.equal(await page.locator('.image-workflow-sidebar').count(), 0)
  await page.locator('.more-actions > summary[aria-label="添加节点"]').click()
  await page.getByRole('button', { name: '参考图', exact: true }).click()
  await page.locator('.image-workflow-sidebar').waitFor()
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
  assert.equal(await page.locator('.image-workflow-sidebar').count(), 0)
  await page.screenshot({ path: path.join(work, 'image.png') })

  await navigate('模组列表')
  const menu = page.locator('.more-actions > summary[aria-label="模组列表更多操作"]')
  await menu.click()
  await page.getByRole('button', { name: '审计锁定', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await menu.evaluate(element => element === document.activeElement), true)
  await menu.click()
  await page.getByRole('button', { name: '刷新模组列表', exact: true }).click()
  assert.equal(await page.locator('.more-actions[open]').count(), 0)

  await navigate('资源包')
  await page.locator('.more-actions > summary[aria-label="资源包管理"]').click()
  await page.getByRole('button', { name: '导入资源包目录', exact: true }).waitFor()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByRole('dialog', { name: '新建资源包' }).waitFor()
  await page.getByRole('dialog', { name: '新建资源包' }).getByTitle('关闭', { exact: true }).click()
  await navigate('FTB 任务书')
  await page.locator('.more-actions > summary[aria-label="任务书更多操作"]').click()
  await page.getByRole('button', { name: '备份恢复', exact: true }).waitFor()
  await page.getByRole('button', { name: /^奖励表/ }).waitFor()
  await page.keyboard.press('Escape')

  const layouts = []
  const focusChecks = []
  for (const dark of [false, true]) {
    if (dark) {
      await navigate('设置')
      await page.getByRole('switch', { name: '深色模式', exact: true }).click()
      await page.locator('.app-shell.dark-mode').waitFor()
    }
    for (const width of [1440, 900, 640]) {
      await page.setViewportSize({ width, height: 900 })
      for (const name of ['设置', '配置与默认项', '脚本与 KubeJS', '数据包', '界面资源', '服务端配置', '图像工坊', '服务端测试', '模组列表', '资源包', 'FTB 任务书', '管理插件', '发布']) {
        await navigate(name)
        if (['配置与默认项', '脚本与 KubeJS', '数据包', '界面资源', '服务端配置'].includes(name)) {
          await page.locator('.pack-content-workspace .monaco-editor').waitFor()
          const backgrounds = await page.locator('.pack-content-workspace').evaluate(workspace => {
            const color = selector => getComputedStyle(workspace.querySelector(selector)).backgroundColor
            return { toolbar: color('.resource-pack-toolbar'), files: color('.resource-pack-files'), editor: color('.monaco-editor'), gutter: color('.monaco-editor .margin') }
          })
          const canvas = dark ? 'rgb(28, 29, 32)' : 'rgb(247, 247, 248)'
          assert.deepEqual(backgrounds, { toolbar: canvas, files: dark ? 'rgb(32, 34, 38)' : 'rgb(240, 241, 243)', editor: canvas, gutter: canvas }, `${name}: rendered backgrounds must share the workspace palette`)
          if (name === '数据包' && width === 1440) await page.screenshot({ path: path.join(work, `datapacks-${dark ? 'dark' : 'light'}.png`) })
        }
        const overflow = await page.locator('.main-content').evaluate(node => node.scrollWidth - node.clientWidth)
        if (overflow > 1) {
          await page.screenshot({ path: path.join(work, 'overflow.png') })
          console.error(name, width, await page.locator('.main-content').evaluate(container => [...container.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > container.getBoundingClientRect().right + 1).slice(0, 12).map(node => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 80) }))))
        }
        assert.ok(overflow <= 1, `${name} overflow at ${width}px, dark=${dark}: ${overflow}`)
        for (const button of await sidebar.locator('.sidebar-nav-item:visible').all()) {
          assert.ok(await button.evaluate(node => Math.abs(node.getBoundingClientRect().width - node.parentElement.getBoundingClientRect().width) <= 1), 'sidebar row must fill group')
        }
        layouts.push({ name, width, dark })
        if (width === 1440) {
          await page.keyboard.press('Tab')
          const focused = await page.locator('.main-content').evaluate(container => {
            const controls = [...container.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')]
              .filter(node => !node.disabled && node.getBoundingClientRect().width > 3 && node.getBoundingClientRect().height > 3).slice(0, 24)
            return controls.map(node => {
              node.focus({ preventScroll: true })
              const style = getComputedStyle(node)
              const coloredShadow = [...style.boxShadow.matchAll(/rgba?\((\d+), (\d+), (\d+)/g)].some(match => Math.max(...match.slice(1).map(Number)) - Math.min(...match.slice(1).map(Number)) > 30)
              return { tag: node.tagName, label: node.getAttribute('aria-label') || node.textContent?.slice(0, 30), outline: style.outlineWidth, coloredShadow }
            })
          })
          assert.deepEqual(focused.filter(item => item.outline !== '0px' || item.coloredShadow), [], `${name}: focus frames should be removed`)
          focusChecks.push({ name, dark, controls: focused.length })
          const colors = await page.locator('.app-shell').evaluate(node => {
            const style = getComputedStyle(node)
            return { surface: style.getPropertyValue('--surface').trim(), text: style.getPropertyValue('--text').trim(), sidebar: style.getPropertyValue('--mm-sidebar').trim() }
          })
          assert.deepEqual(colors, dark ? { surface: '#24262b', text: '#e7e7eb', sidebar: '#202226' } : { surface: '#fafafb', text: '#242529', sidebar: '#f0f1f3' })
          assert.equal(await sidebar.locator('.sidebar-nav-item[aria-current="page"]').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'selected sidebar row has no colored border or glow')
          if (name === '设置') {
            await page.getByRole('searchbox', { name: '搜索设置' }).focus()
            await page.screenshot({ path: path.join(work, `palette-focus-${dark ? 'dark' : 'light'}.png`) })
          }
        }
        if (width === 640 || (dark && width === 1440)) await page.screenshot({ path: path.join(work, `${name}-${width}-${dark ? 'dark' : 'light'}.png`) })
      }
    }
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ work, layouts, focusChecks, checked: ['sidebar folding, keyboard and persistence', 'full-width sidebar rows', 'workbench conversation identity', 'secondary action menu keyboard/focus', 'content drafts survive navigation', 'server start/stop/command via stub IPC', 'conditional image inspector and add-node action', 'consistent palette in both themes', 'no focus outlines or colored focus shadows'], errors }, null, 2))
  console.log(`PASS: workspace simplification, preserved actions and ${layouts.length} layouts. Artifacts: ${work}`)
} finally {
  await app?.close()
  await server.close()
}
