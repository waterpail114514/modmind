import { _electron as electron } from 'playwright'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'appearance-live', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const picture = path.join(work, 'local-background.png'), movie = path.join(work, 'local-background.mp4')
await sharp(path.join(root, 'resources/readme-logo.png')).resize(1440, 900, { fit: 'contain', background: '#d4e5df' }).flatten({ background: '#d4e5df' }).png().toFile(picture)
execFileSync(require('ffmpeg-static'), ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie], { stdio: 'ignore', windowsHide: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app, dialog } = require('electron'); app.setName('modmind-appearance-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); dialog.showOpenDialog = async () => globalThis.nextBackground ? { canceled: false, filePaths: [globalThis.nextBackground] } : { canceled: true, filePaths: [] }; require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
const checks = [], errors = []
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  const page = await app.firstWindow()
  // Poll through evaluate so document reloads do not trip Playwright's injected
  // waitForFunction evaluator under the production page's strict CSP.
  const wait = async (predicate, target = page) => {
    for (let n = 0; n < 200; n++) {
      if (await target.evaluate(predicate).catch(() => false)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await page.screenshot({ path: path.join(work, 'wait-failure.png') })
    assert.fail('Timed out: ' + predicate.toString())
  }
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await wait(() => Boolean(window.modmind))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.hide(); window.webContents.setBackgroundThrottling(false) }))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 960 })
  const openSettings = async () => {
    const button = page.locator('#main-sidebar [data-sidebar-drag-key="item:settings"]')
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
    await page.getByRole('heading', { name: '外观', exact: true }).waitFor()
  }
  const saved = async predicate => {
    for (let n = 0; n < 100; n++) {
      if (predicate(await page.evaluate(() => window.modmind.settings.getAgent()))) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('Settings did not persist: ' + predicate.toString())
  }
  const shot = async name => page.screenshot({ path: path.join(work, `${name}.png`) })
  await openSettings()
  await page.getByRole('button', { name: '默认', exact: true }).waitFor()
  await page.getByRole('button', { name: 'ModMind', exact: true }).click()
  await wait(() => document.documentElement.dataset.themePreset === 'modmind')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-action').trim()), '#1e5a60')
  await shot('modmind-light')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await saved(s => s.darkMode === true)
  await shot('modmind-dark')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await saved(s => s.darkMode === false)
  await page.locator('.appearance-custom-colors summary').click()
  await page.getByLabel('背景色', { exact: true }).fill('#edf4f1')
  await page.getByLabel('强调色', { exact: true }).fill('#825124')
  await page.getByRole('button', { name: '应用颜色', exact: true }).click()
  await saved(s => s.customThemeColors?.light?.accent === '#825124')
  await shot('manual-colors')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim()), '#edf4f1')
  checks.push('Logo preset, visible appearance heading, light/dark switch, custom color save')
  await app.evaluate((_electron, file) => { globalThis.nextBackground = file }, picture)
  await page.getByRole('button', { name: '选择图片或视频', exact: true }).click()
  await wait(() => document.querySelector('.app-background img')?.naturalWidth > 0)
  await wait(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim() === 'transparent')
  const imageSettings = await page.evaluate(() => window.modmind.settings.getAgent())
  assert.equal(imageSettings.background.media.kind, 'image')
  await rm(picture)
  await page.reload()
  await wait(() => document.querySelector('.app-background img')?.naturalWidth > 0)
  await openSettings()
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-action').trim()), '#825124')
  await shot('custom-image')
  await page.getByLabel('背景可见度', { exact: true }).fill('46')
  await page.getByLabel('背景可见度', { exact: true }).press('ArrowRight')
  await saved(s => s.background.opacity === .47)
  await page.getByLabel('背景模糊', { exact: true }).fill('5')
  await page.getByLabel('背景模糊', { exact: true }).press('ArrowRight')
  await saved(s => s.background.blur === 6)
  await page.getByLabel('背景适配', { exact: true }).selectOption('contain')
  await saved(s => s.background.fit === 'contain')
  checks.push('Imported image renders after source removal and reload; opacity, blur and fit persist')
  await page.setViewportSize({ width: 1000, height: 600 })
  const main = page.locator('.settings-scroll-area')
  await main.evaluate(el => { el.scrollTop = 0 })
  const bounds = await main.boundingBox()
  const track = await main.evaluate(el => ({ start: parseFloat(getComputedStyle(el).getPropertyValue('--scrollbar-start')), headerBottom: document.querySelector('.settings-navigation').getBoundingClientRect().bottom,
    width: getComputedStyle(el, '::-webkit-scrollbar').width, arrows: getComputedStyle(el, '::-webkit-scrollbar-button').display }))
  assert.ok(bounds.y >= track.headerBottom, 'Settings scrollbar gutter begins below the search/category header')
  assert.equal(track.start, 12)
  assert.ok(await page.locator('.settings-navigation').evaluate(el => Math.abs(el.getBoundingClientRect().right - el.closest('.main-content').getBoundingClientRect().right) < 1), 'Header covers the entire right edge without an exposed background strip')
  assert.equal(track.width, '10px')
  assert.equal(track.arrows, 'none')
  await shot('scrollbar-settings-top')
  await page.mouse.move(bounds.x + 30, bounds.y + track.start + 40)
  await page.mouse.wheel(0, 300)
  await wait(() => document.querySelector('.settings-scroll-area').scrollTop > 100)
  await main.evaluate(el => { el.scrollTop = 0 })
  await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + track.start + 10)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + track.start + 105, { steps: 8 })
  await page.mouse.up()
  await wait(() => document.querySelector('.settings-scroll-area').scrollTop > 40)
  await shot('scrollbar-settings-dragged')
  await main.evaluate(el => { el.scrollTop = 0 })
  await page.getByRole('heading', { name: '外观', exact: true }).click()
  await page.keyboard.press('PageDown')
  await wait(() => document.querySelector('.settings-scroll-area').scrollTop > 40)
  checks.push('Shared inset scrollbar stays below settings header; native wheel, thumb dragging and PageDown work')
  for (const width of [1440, 780, 420]) {
    if (width === 420) await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await page.setViewportSize({ width, height: 960 })
    await page.locator('#settings-appearance').scrollIntoViewIfNeeded()
    await shot(`image-${width}`)
    const overflow = await page.locator('.settings-scroll-area').evaluate(el => ({ excess: el.scrollWidth - el.clientWidth, nodes: [...el.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > el.getBoundingClientRect().right + 2).map(n => ({ tag: n.tagName, class: n.className, text: n.textContent?.slice(0, 50) })).slice(0, 15) }))
    assert.ok(overflow.excess < 3, `No horizontal overflow at ${width}: ${JSON.stringify(overflow)}`)
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await app.evaluate((_electron, file) => { globalThis.nextBackground = file }, movie)
  await page.getByRole('button', { name: '更换背景', exact: true }).click()
  await wait(() => { const v = document.querySelector('.app-background video'); return v && v.videoWidth > 0 && v.currentTime > .1 && !v.paused })
  const video = page.locator('.app-background video')
  assert.equal(await video.evaluate(v => v.muted && v.loop), true)
  assert.ok(await page.locator('.titlebar').evaluate(el => {
    const color = getComputedStyle(el).backgroundColor
    return color !== 'rgba(0, 0, 0, 0)' && (color.includes('0.92') || color.includes('/ 0.92'))
  }), 'Titlebar has a separate theme-colored veil over the video')
  await page.getByRole('switch', { name: '播放背景视频', exact: true }).click()
  await wait(() => document.querySelector('.app-background video')?.paused === true)
  await saved(s => s.background.paused === true)
  await page.reload()
  await openSettings()
  await wait(() => { const v = document.querySelector('.app-background video'); return v && v.readyState >= 2 && v.paused })
  await page.getByRole('switch', { name: '播放背景视频', exact: true }).click()
  await wait(() => document.querySelector('.app-background video')?.paused === false)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await wait(() => document.querySelector('.app-background video')?.paused === true)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await wait(() => document.querySelector('.app-background video')?.paused === false)
  await shot('custom-video')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await saved(s => s.darkMode === true)
  await shot('custom-video-dark')
  assert.ok(await page.locator('.titlebar').evaluate(el => getComputedStyle(el).backgroundColor.includes('0.92')), 'Dark titlebar retains its video veil')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await saved(s => s.darkMode === false)
  checks.push('MP4 decodes and plays muted in loop; pause survives reload; reduced motion pauses')
  // A second real renderer receives both color and local media updates.
  await app.evaluate(({ BrowserWindow }, options) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: options.preload, sandbox: true, contextIsolation: true } })
    globalThis.appearanceTestWindow = win
    void win.loadFile(options.file, { query: { appearanceSecondary: '1' } })
  }, { preload: path.join(root, 'out/preload/index.js'), file: path.join(root, 'out/renderer/index.html') })
  let secondary
  for (let n = 0; n < 100; n++) { secondary = app.windows().find(p => p.url().includes('appearanceSecondary')); if (secondary) break; await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(secondary)
  await wait(() => document.querySelector('.app-background video')?.videoWidth > 0, secondary)
  await page.getByRole('button', { name: '移除背景', exact: true }).click()
  await wait(() => !document.querySelector('.app-background'), secondary)
  await page.getByRole('button', { name: 'ModMind', exact: true }).click()
  await wait(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-action').trim() === '#1e5a60', secondary)
  await saved(s => !s.background.media && Object.keys(s.customThemeColors).length === 0)
  await app.evaluate(() => globalThis.appearanceTestWindow.destroy())
  checks.push('Second window synchronizes custom colors, media, removal and preset reset')
  await page.evaluate(async () => {
    const settings = await window.modmind.settings.getAgent()
    await window.modmind.settings.saveAgent({ ...settings, background: { ...settings.background, media: { file: '12345678-1234-1234-1234-123456789012.png', name: 'missing.png', kind: 'image' } } })
  })
  await page.getByText('背景无法读取或格式不受支持，请更换文件。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim()), '#f5f6f7')
  await page.getByRole('button', { name: '移除背景', exact: true }).click()
  await app.evaluate(() => { globalThis.nextBackground = null })
  await page.getByRole('button', { name: '选择图片或视频', exact: true }).click()
  assert.equal((await page.evaluate(() => window.modmind.settings.getAgent())).background.media, null)
  checks.push('Missing media falls back to solid palette; canceled picker leaves settings unchanged')
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ work, checks, errors }, null, 2))
  console.log(`PASS ${checks.length} workflows. ${work}`)
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app?.close().catch(() => undefined)
}
