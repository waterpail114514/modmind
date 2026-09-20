import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/project-loading', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron'); app.setName('modmind-loading-smoke'); app.setPath('userData',${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], cwd: root, env })
try {
  const page = await app.firstWindow()
  const waitForPage = async predicate => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await page.evaluate(predicate)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Page condition timed out: ${predicate}`)
  }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await waitForPage(() => Boolean(window.modmind))
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.loadingSmoke = { failFiles: false, failHistory: false, coverViolations: [], historyCoverChecks: 0 }
    const checkCover = async operation => {
      const opacity = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('getComputedStyle(document.getElementById("app-loading")).opacity')
      if (opacity !== '1') globalThis.loadingSmoke.coverViolations.push({ operation, opacity })
    }
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    replace('project:listFiles', async () => {
      await checkCover('files')
      await new Promise(resolve => setTimeout(resolve, 1800))
      if (globalThis.loadingSmoke.failFiles) throw new Error('File load fixture failure')
      return []
    })
    replace('conversations:read', async (_, projectPath, conversationId) => {
      // Hidden inspiration panes also preload recent projects. Check the active workspace.
      if (conversationId === 'workspace') {
        globalThis.loadingSmoke.historyCoverChecks++
        await checkCover('history:workspace')
      }
      await new Promise(resolve => setTimeout(resolve, 900))
      if (globalThis.loadingSmoke.failHistory) throw new Error('History load fixture failure')
      return null
    })
    replace('project:readWorkbenchData', async (_, key) => {
      if (globalThis.loadingSmoke.failHistory) throw new Error('History index fixture failure')
      return { status: 'missing' }
    })
  })
  const fixture = async name => {
    const projectPath = path.join(work, name)
    await mkdir(projectPath, { recursive: true })
    await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ path: projectPath, name, namespace: name, kind: 'mod', loader: 'fabric', loaderVersion: '0.19.3', minecraftVersion: '1.21.11', createdAt: new Date().toISOString(), projectVersion: '1.4.7' }))
    return projectPath
  }
  const projectPath = await fixture('loading_fixture')
  await page.evaluate(() => {
    window.loadingFadeSamples = []
    const sample = () => {
      const splash = document.getElementById('app-loading')
      if (!splash.hidden) window.loadingFadeSamples.push({ phase: splash.dataset.loading, opacity: Number(getComputedStyle(splash).opacity) })
      window.loadingFadeFrame = requestAnimationFrame(sample)
    }
    sample()
  })
  await page.evaluate(projectPath => window.modmind.project.openRecent(projectPath), projectPath)
  await page.locator('#app-loading').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#app-loading').innerText(), '')
  assert.equal(await page.locator('#app-loading img:visible').count(), 1)
  assert.equal(await page.locator('#root').evaluate(root => root.inert), true)
  assert.equal(await page.locator('#app-loading').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
  await waitForPage(() => getComputedStyle(document.getElementById('app-loading')).opacity === '1')
  await page.screenshot({ path: path.join(work, 'white-logo-loading.png') })
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#root').evaluate(root => root.inert), false)
  const samples = await page.evaluate(() => { cancelAnimationFrame(window.loadingFadeFrame); return window.loadingFadeSamples })
  assert.ok(samples.some(sample => sample.phase === 'true' && sample.opacity > 0 && sample.opacity < 1), 'loading fades in')
  assert.ok(samples.some(sample => sample.phase === 'false' && sample.opacity > 0 && sample.opacity < 1), 'loading fades out')
  await page.evaluate(async () => {
    const settings = await window.modmind.settings.getAgent()
    await window.modmind.settings.saveAgent({ ...settings, darkMode: true })
  })
  await page.reload()
  await page.locator('#app-loading').waitFor({ state: 'visible' })
  await waitForPage(() => document.documentElement.dataset.themeMode === 'dark' && getComputedStyle(document.getElementById('app-loading')).opacity === '1')
  assert.equal(await page.locator('#app-loading .loading-logo-dark').isVisible(), true)
  assert.equal(await page.locator('#app-loading .loading-logo-light').isVisible(), false)
  assert.notEqual(await page.locator('#app-loading').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
  await page.screenshot({ path: path.join(work, 'dark-logo-loading.png') })
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    window.returnSplashCount = 0
    window.returnSplashObserver = new MutationObserver(records => {
      for (const record of records) if (record.attributeName === 'hidden' && !record.target.hidden) window.returnSplashCount++
    })
    window.returnSplashObserver.observe(document.getElementById('app-loading'), { attributes: true })
  })
  await page.locator('.minimal-project-trigger').click()
  await page.locator('.minimal-project-dropdown').getByRole('button', { name: '新建作品', exact: true }).click()
  await page.locator('.minimal-project-trigger').click()
  await page.locator('.minimal-project-dropdown').getByRole('button', { name: 'loading_fixture', exact: true }).click()
  await page.locator('.agent-workbench').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => { window.returnSplashObserver.disconnect(); return window.returnSplashCount }), 0, 'returning to the current project does not show the splash')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('#app-loading').evaluate(el => getComputedStyle(el).transitionDuration), '0.12s')
  await app.evaluate(() => { globalThis.loadingSmoke.failFiles = true; globalThis.loadingSmoke.failHistory = true })
  const failedProject = await fixture('failed_fixture')
  await page.evaluate(projectPath => window.modmind.project.openRecent(projectPath), failedProject)
  await page.locator('#app-loading').waitFor({ state: 'visible' })
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#root').evaluate(root => root.inert), false)
  assert.deepEqual(errors, [])
  const violations = await app.evaluate(() => globalThis.loadingSmoke.coverViolations)
  assert.ok(await app.evaluate(() => globalThis.loadingSmoke.historyCoverChecks > 0))
  assert.deepEqual([...new Map(violations.map(entry => [entry.operation, entry])).values()], [], 'project content loads only behind the opaque cover')
  console.log(JSON.stringify({ passed: true, checks: ['empty startup', 'fade in and out', 'light and dark logo', 'keyboard blocked while loading', 'reload current project', 'return without loading animation', 'reduced motion', 'file and history failure exit', 'content loads behind opaque cover'], work }))
} finally {
  await app.close()
}
