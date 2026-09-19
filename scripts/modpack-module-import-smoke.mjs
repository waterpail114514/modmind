import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/modpack-module-import', String(Date.now()))
const profile = path.join(work, 'profile')
const packPath = path.join(work, 'pack')
await mkdir(profile, { recursive: true })
await mkdir(packPath, { recursive: true })
const pack = { name: 'Module Import Check', namespace: 'pack', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', path: packPath, createdAt: new Date().toISOString(), projectVersion: '1.4.6' }
await writeFile(path.join(packPath, 'modmind.project.json'), JSON.stringify(pack))
await writeFile(path.join(packPath, 'modmind.pack.json'), JSON.stringify({ version: 1, name: pack.name, loader: pack.loader, minecraftVersion: pack.minecraftVersion, mods: [], modules: [] }))
const sources = {}
for (const namespace of ['copied', 'linked', 'external']) {
  const source = path.join(work, namespace)
  await mkdir(path.join(source, 'src/main/java'), { recursive: true })
  await mkdir(path.join(source, 'src/main/resources'), { recursive: true })
  await writeFile(path.join(source, 'build.gradle'), "plugins { id 'fabric-loom' version '1.7.4' }\n")
  await writeFile(path.join(source, 'gradle.properties'), `minecraft_version=1.21.1\nmod_id=${namespace}\n`)
  await writeFile(path.join(source, 'src/main/java/Example.java'), 'class Example {}')
  await writeFile(path.join(source, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: namespace, name: namespace, version: '1.0.0', depends: { minecraft: '1.21.1' } }))
  if (namespace !== 'external') await writeFile(path.join(source, 'modmind.project.json'), JSON.stringify({ ...pack, path: source, kind: 'mod', name: namespace, namespace }))
  sources[namespace] = source
}
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-module-import-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.evaluate(target => window.modmind.project.openRecent(target), packPath)
  await page.reload()
  const navigate = async () => {
    const button = page.locator('#main-sidebar [data-sidebar-drag-key="item:modpack-mod-list"]')
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
    await page.locator('.modpack-mod-list-page').waitFor()
  }
  await navigate()
  const pick = async source => app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: !target, filePaths: target ? [target] : [] })
  }, source)
  const importViaMenu = async (source, label) => {
    await pick(source)
    await page.locator('summary[aria-label="导入已有模组项目"]').click()
    await page.getByRole('button', { name: label, exact: true }).click()
  }
  await importViaMenu(sources.copied, '复制到整合包')
  await page.getByRole('status').filter({ hasText: '已复制模组项目到整合包' }).waitFor()
  await importViaMenu(sources.linked, '直接使用原项目')
  await page.getByRole('status').filter({ hasText: '已添加原项目引用' }).waitFor()
  await importViaMenu(sources.external, '直接使用原项目')
  await page.locator('.modpack-local-module-row').filter({ hasText: 'external' }).waitFor()
  const manifestFile = path.join(packPath, 'modmind.pack.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  assert.equal(manifest.modules.length, 3)
  assert.equal(manifest.modules.find(module => module.namespace === 'copied').path, 'modules/copied')
  assert.equal(manifest.modules.find(module => module.namespace === 'linked').linked, true)
  await access(path.join(packPath, 'modules/copied/src/main/java/Example.java'))
  await assert.rejects(access(path.join(packPath, 'modules/linked')))
  await importViaMenu(null, '直接使用原项目')
  await page.waitForFunction(async () => (await window.modmind.modpack.get()).modules.length === 3)
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 })
    await page.locator('summary[aria-label="导入已有模组项目"]').click()
    await page.getByRole('button', { name: '直接使用原项目', exact: true }).waitFor()
    await page.screenshot({ path: path.join(work, `modules-${width}.png`), fullPage: true })
    const overflow = await page.locator('.modpack-mod-list-page').evaluate(element => element.scrollWidth - element.clientWidth)
    assert.ok(overflow <= 2, `module page overflow: ${overflow}`)
    await page.keyboard.press('Escape')
  }
  await page.locator('.modpack-local-module-row').filter({ hasText: 'linked' }).getByRole('button', { name: '打开', exact: true }).click()
  const opened = await page.evaluate(() => window.modmind.project.current())
  assert.equal(path.resolve(opened.path), path.resolve(sources.linked))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, modules: manifest.modules, screenshots: work }, null, 2))
} finally {
  if (app) await app.close()
}
