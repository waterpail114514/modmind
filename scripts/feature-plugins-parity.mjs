import { _electron as electron } from 'playwright'
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import sharp from 'sharp'
const root = path.resolve(import.meta.dirname, '..'), work = path.join(root, 'test-results/feature-parity', String(Date.now()))
await mkdir(work, { recursive: true })
const project = path.join(os.tmpdir(), 'modmind-feature-parity-' + Date.now())
await mkdir(project, { recursive: true })
await writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: '界面对照', namespace: 'parity', path: project, kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }))
const geometries = {}
for (const [label, directory] of [['original', 'release/win-unpacked'], ['plugin', null]]) {
  const profile = path.join(work, label), resources = directory ? path.join(root, directory, 'resources') : path.join(root, 'resources'), appRoot = directory ? path.join(resources, 'app.asar') : root
  await mkdir(profile, { recursive: true })
  if (label === 'plugin') await cp(path.join(root, 'feature-plugin-dist/image-studio'), path.join(profile, 'feature-plugins/image-studio'), { recursive: true })
  const bootstrap = path.join(work, label + '.cjs')
  await writeFile(bootstrap, `const { app, session } = require('electron');
app.setName('parity-${label}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(appRoot)});
app.setAsDefaultProtocolClient = () => false; globalThis.fetch = () => Promise.reject(new Error('Offline comparison'));
app.getVersion = () => '1.5.0-plugintest'; Object.defineProperty(app, 'isPackaged', { get: () => true }); Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} });
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_, done) => done({ cancel: true })));
require(${JSON.stringify(path.join(appRoot, 'out/main/index.js'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], env })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000)
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}))
    await page.locator('.app-shell').waitFor()
    await page.evaluate(target => window.modmind.project.openRecent(target), project)
    await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced')); await page.reload()
    await page.locator('#app-loading').waitFor({ state: 'hidden' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)))
    const nav = page.locator('#main-sidebar').getByRole('button', { name: '图像工坊', exact: true, includeHidden: true })
    const caption = nav.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await nav.click()
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 800 })
      for (const tab of ['工作流', '处理', '编辑']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        const dismiss = page.getByRole('button', { name: '关闭提示', exact: true }); if (await dismiss.isVisible()) await dismiss.click()
        if (tab === '工作流') await page.getByRole('button', { name: 'fit view' }).click()
        await page.waitForTimeout(300)
        const key = `${width}-${tab}`
        geometries[label + '-' + key] = await page.locator('.image-studio-page').evaluate(element => [...element.querySelectorAll('.image-studio-tabs button, .image-process-drop, .image-process-preview, .image-process-tools, .image-editor-empty-actions button')].map(node => { const b = node.getBoundingClientRect(), s = getComputedStyle(node); return { text: node.textContent, x: b.x, y: b.y, width: b.width, height: b.height, fontSize: s.fontSize, background: s.backgroundColor } }))
        await page.locator('.image-studio-host').screenshot({ path: path.join(work, `${label}-${key}.png`), animations: 'disabled' })
      }
    }
  } finally { await app.close() }
}
const comparisons = []
for (const width of [1280, 760]) for (const tab of ['工作流', '处理', '编辑']) {
  const key = `${width}-${tab}`
  assert.deepEqual(geometries['original-' + key], geometries['plugin-' + key], 'Control geometry/style changed: ' + key)
  const a = await sharp(await readFile(path.join(work, `original-${key}.png`))).raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(await readFile(path.join(work, `plugin-${key}.png`))).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual(a.info, b.info)
  let changed = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++
  const difference = changed / a.data.length
  assert.ok(difference <= 0.0001, `Image Studio pixels changed: ${key} (${difference})`)
  comparisons.push({ width, tab, differentChannelFraction: difference })
}
await writeFile(path.join(work, 'result.json'), JSON.stringify({ result: 'PASS', comparisons }, null, 2))
console.log(JSON.stringify({ work, comparisons }))
