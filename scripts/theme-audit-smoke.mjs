import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual settings page with isolated storage and deterministic IPC responses.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'theme-audit-live', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-theme-audit-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
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
  const shots = [], checks = [], errors = []
  let activeView = 'launcher'
  page.on('pageerror', error => errors.push({ view: activeView, message: error.message }))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  const sidebar = page.locator('#main-sidebar')
  const navigate = async id => {
    const button = sidebar.locator(`.sidebar-nav-item[data-sidebar-drag-key="item:${id}"]`)
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
    if (id !== 'workspace') await page.locator(`.main-content[data-view="${id}"]`).waitFor()
    activeView = id
  }
  const settle = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const shot = async name => {
    await settle()
    const file = name.replace(/[^a-zA-Z0-9_-]/g, '-') + '.png'
    await page.screenshot({ path: path.join(work, file) })
    shots.push({ name, file })
  }
  const appearance = async (preset, dark) => {
    await page.evaluate(async value => { const settings = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({ ...settings, themePreset: value.preset, darkMode: value.dark }) }, { preset, dark })
    await page.waitForFunction(({ preset, dark }) => document.documentElement.dataset.themePreset === preset && document.documentElement.dataset.themeMode === (dark ? 'dark' : 'light'), { preset, dark })
    await settle()
  }
  const checkSurface = async (preset, dark, scope) => {
    const result = await page.evaluate(() => {
      const palette = getComputedStyle(document.documentElement)
      const shell = document.querySelector('.app-shell')
      const main = document.querySelector('.main-content')
      const scrollbars = [...shell.querySelectorAll('*'), shell].filter(el => {
        const s = getComputedStyle(el)
        return el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && ['auto', 'scroll'].includes(s.overflowY) && s.scrollbarWidth !== 'none'
      }).map(el => ({ element: el.className, width: getComputedStyle(el, '::-webkit-scrollbar').width, arrows: getComputedStyle(el, '::-webkit-scrollbar-button').display, track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor }))
      const unresolved = [...shell.querySelectorAll('button, input, select, textarea')].filter(el => !el.closest('.monaco-editor') && el.getBoundingClientRect().width > 2).filter(el => {
        const s = getComputedStyle(el); return s.color === 'rgba(0, 0, 0, 0)'
      }).map(el => el.getAttribute('aria-label') || el.textContent?.slice(0, 24))
      return { preset: document.documentElement.dataset.themePreset, mode: document.documentElement.dataset.themeMode,
        canvas: palette.getPropertyValue('--theme-canvas').trim(), action: palette.getPropertyValue('--theme-action').trim(),
        overflow: main ? main.scrollWidth - main.clientWidth : 0, unresolved, scrollbars }
    })
    assert.equal(result.preset, preset)
    assert.equal(result.mode, dark ? 'dark' : 'light')
    assert.equal(result.canvas.startsWith('#'), true)
    assert.ok(result.overflow <= 2, `${scope}: horizontal overflow ${result.overflow}`)
    assert.deepEqual(result.unresolved, [], `${scope}: invisible text`)
    for (const scrollbar of result.scrollbars) {
      assert.equal(scrollbar.width, '10px', `${scope}: shared scrollbar width on ${scrollbar.element}`)
      assert.equal(scrollbar.arrows, 'none', `${scope}: scrollbar arrows removed`)
      assert.equal(scrollbar.track, 'rgba(0, 0, 0, 0)', `${scope}: transparent track`)
    }
    checks.push({ scope, preset, dark, ...result })
  }
  await sidebar.locator('.sidebar-nav-item').first().waitFor()
  await shot('launcher-light')
  await appearance('neutral', true)
  await shot('launcher-dark')
  await appearance('neutral', false)

  const fixture = async (kind, loader) => {
    const target = path.join(work, kind)
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'modmind.project.json'), JSON.stringify({ name: `主题检查-${kind}`, namespace: 'theme_audit', kind, loader, minecraftVersion: '1.21.1', path: target, createdAt: '', projectVersion: '1.4.6', toolDataDirectory: '.modmind' }))
    const files = kind === 'modpack' ? {
      'modmind.pack.json': JSON.stringify({ version: 1, name: '主题检查', loader, minecraftVersion: '1.21.1', mods: [], modules: [], source: { format: 'modrinth', layout: 'archive', importedAt: '' } }),
      'overrides/config/gameplay.toml': 'difficulty = 2\n', 'overrides/kubejs/server_scripts/startup.js': '// Recipes\n',
      'overrides/datapacks/starter/pack.mcmeta': '{"pack":{"pack_format":48,"description":"Starter"}}',
      'overrides/fancymenu_data/layouts/menu.txt': 'title=Welcome', 'overrides/serverconfig/server.toml': 'spawnProtection = 16\n',
      'overrides/options.txt': 'key_key.forward:key.keyboard.w\n', 'overrides/misc/notes.txt': 'Project notes\n',
      'overrides/config/ftbquests/quests/chapters/start.snbt': '{ id: "0000000000000001", title: "入门", quests: [] }',
      'overrides/patchouli_books/guide/book.json': '{"name":"指南","landing_text":"欢迎","version":1}',
      'overrides/patchouli_books/guide/zh_cn/categories/start.json': '{"name":"入门","icon":"minecraft:book"}'
    } : { 'build.gradle': '// theme fixture\n', 'src/main/java/example/Example.java': 'package example;\npublic class Example {}\n' }
    for (const [file, content] of Object.entries(files)) { const dest = path.join(target, file); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, content) }
    return target
  }
  await app.evaluate(({ ipcMain }) => {
    const handle = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn) }
    // Catalog lookups are unrelated to theme rendering and must not delay the audit.
    handle('image-studio:capabilities', () => ({ models: ['gpt-image-2'], sizes: ['1024x1024'], qualities: ['medium'], moderations: ['auto'] }))
    handle('modpack:contentFeatures', () => ({ ftbQuests: true, patchouli: true }))
  })
  const allPages = []
  const migrationPagesOnly = process.argv.includes('--migration-pages')
  for (const [kind, loader] of [['modpack','fabric'], ['mod','fabric'], ['server-plugin','paper'], ['mod','bedrock'], ['mod','netease']]) {
    if (migrationPagesOnly && kind === 'modpack') continue
    const projectPath = await fixture(kind === 'mod' && loader !== 'fabric' ? 'mod' : kind, loader)
    await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
    await page.reload()
    await sidebar.getByRole('button', { name: `切换项目：主题检查-${kind}`, exact: true }).waitFor()
    if (kind === 'modpack') await sidebar.locator('[data-sidebar-drag-key="item:patchouli"]').waitFor({ state: 'attached' })
    const routes = await sidebar.locator('.sidebar-nav-item').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.sidebarDragKey.slice(5), label: node.getAttribute('aria-label') })))
    const seen = new Set()
    for (const route of routes) {
      if (seen.has(route.id)) continue
      seen.add(route.id)
      if (migrationPagesOnly && route.id !== 'snapshots') continue
      // Shared utility pages already audited in the modpack context.
      if (kind !== 'modpack' && ['settings','plugins','image-studio','inspiration','modpack-resourcepacks','decompile','minecraft'].includes(route.id)) continue
      if (loader !== 'fabric' && kind === 'mod' && !['workspace','build','snapshots'].includes(route.id)) continue
      for (const dark of [false, true]) {
        await appearance('neutral', dark)
        await navigate(route.id)
        await settle()
        if (['modpack-config','modpack-scripts','modpack-datapacks','modpack-ui','modpack-server-content'].includes(route.id)) await page.locator('.pack-content-workspace .monaco-editor').waitFor()
        await checkSurface('neutral', dark, `${kind}-${loader}/${route.id}`)
        await shot(`${kind}-${loader}-${route.id}-${dark ? 'dark' : 'light'}`)
      }
      allPages.push({ kind, loader, ...route })
      console.log(`Reviewed ${kind}/${loader}: ${route.label}`)
    }
    if (kind !== 'modpack') continue
    // Every top-level page must react to every preset, without reloading the app.
    for (const preset of ['sand','sage','graphite','modmind']) for (const dark of [false,true]) {
      await appearance(preset, dark)
      for (const route of routes) {
        await navigate(route.id)
        await checkSurface(preset, dark, `modpack/${route.id}`)
        if (['workspace','settings','modpack-datapacks','ftb-quests','image-studio','minecraft','production'].includes(route.id)) await shot(`${preset}-${route.id}-${dark ? 'dark' : 'light'}`)
      }
      console.log(`Checked all modpack pages: ${preset}/${dark ? 'dark' : 'light'}`)
    }
    await navigate('settings')
    await page.getByRole('button', { name: '暖砂', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.themePreset === 'sand')
    await page.waitForFunction(async () => (await window.modmind.settings.getAgent()).themePreset === 'sand')
    await page.reload()
    await page.waitForFunction(() => document.documentElement.dataset.themePreset === 'sand')
    assert.equal(await page.evaluate(async () => (await window.modmind.settings.getAgent()).themePreset), 'sand')
    await navigate('settings')
    await shot('theme-picker')
    // A second renderer must receive the persisted appearance and later changes.
    await app.evaluate(({ BrowserWindow }, options) => {
      const win = new BrowserWindow({ show: false, webPreferences: { preload: options.preload, sandbox: true, contextIsolation: true } })
      globalThis.themeAuditWindow = win
      void win.loadURL(options.url)
    }, { preload: path.join(root, 'out/preload/index.js'), url: env.ELECTRON_RENDERER_URL + '?theme-audit-secondary=1' })
    let secondary
    for (let n=0;n<100;n++) { secondary=app.windows().find(candidate=>candidate.url().includes('theme-audit-secondary')); if(secondary)break; await new Promise(resolve=>setTimeout(resolve,100)) }
    assert.ok(secondary)
    await secondary.locator('html[data-theme-preset="sand"]').waitFor()
    await page.getByRole('button', { name: '青绿', exact: true }).click()
    await secondary.locator('html[data-theme-preset="sage"]').waitFor()
    await app.evaluate(() => globalThis.themeAuditWindow.destroy())
    await appearance('neutral', false)
  }
  await writeFile(path.join(work,'report.json'),JSON.stringify({work,allPages,checks,shots,errors},null,2))
  assert.deepEqual(errors, [])
  console.log(`PASS: ${allPages.length} page variants, ${checks.length} theme/page combinations, persistent picker and cross-window sync. ${work}`)
} finally { await app?.close(); await server.close() }
