import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Run after npm run build. Uses the actual main/preload/renderer with isolated
// profiles and packaged-mode startup; no installer runs or real user data changes.
const root = path.resolve(import.meta.dirname, '..')
const buildRoot = path.resolve(process.env.MODMIND_CHANGELOG_BUILD || path.join(root, 'out'))
const work = path.join(root, 'test-results', 'app-changelog', String(Date.now()))
const resources = path.join(work, 'resources')
const version = process.env.MODMIND_CHANGELOG_VERSION || JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
await mkdir(resources, { recursive: true })
await writeFile(path.join(resources, 'service-config.json'), '{}')
const errors = []
let app

async function launch(profileName) {
  const profile = path.join(work, profileName)
  await mkdir(profile, { recursive: true })
  const bootstrap = path.join(work, profileName + '.cjs')
  await writeFile(bootstrap, `const { app, session } = require('electron');
app.setName('modmind-changelog-${Date.now()}');
app.setPath('userData', ${JSON.stringify(profile)});
app.setAppPath(${JSON.stringify(root)});
app.getVersion = () => ${JSON.stringify(version)};
Object.defineProperty(app, 'isPackaged', { get: () => true });
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} });
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true })));
require(${JSON.stringify(path.join(buildRoot, 'main/index.js'))});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.MODMIND_SITE_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app-shell').waitFor()
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)))
  return { page, profile }
}
async function stop() { if (app) { await app.close(); app = null } }

try {
  let { page } = await launch('fresh')
  assert.equal(await page.getByRole('dialog', { name: '更新日志', exact: true }).count(), 0)
  assert.equal((await page.evaluate(() => window.modmind.app.getChangelog())).automatic, false)
  // Open the real settings route through its existing application menu event.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:openSettings'))
  await page.getByRole('button', { name: '关于', exact: true }).click()
  const open = page.getByRole('button', { name: '更新日志', exact: true })
  await open.click()
  const dialog = page.getByRole('dialog', { name: '更新日志', exact: true })
  await dialog.waitFor()
  await dialog.getByText(`当前版本 ModMind ${version}`, { exact: true }).waitFor()
  if (version === '1.4.14') {
    await dialog.getByText('新建项目或首次生成工程时，根据项目名自动为默认命名空间生成英文标识；保留手动命名，AI 不可用时使用原值。', { exact: true }).waitFor()
    await dialog.getByText('修复删除项目后在原位置重建时继承旧项目知识的问题，并清理新建项目路径上的遗留知识。', { exact: true }).waitFor()
  }
  await dialog.getByRole('button', { name: '查看历史版本', exact: true }).click()
  await dialog.getByText('1.4.12', { exact: true }).waitFor()
  for (const dark of [false, true]) {
    await page.evaluate(darkMode => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'modmind-appearance:v1', newValue: JSON.stringify({ themePreset: 'modmind', darkMode }) }))
    }, dark)
    for (const width of [1160, 390]) {
      await page.setViewportSize({ width, height: 700 })
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true)
      const box = await dialog.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 700)
      await page.screenshot({ path: path.join(work, `${dark ? 'dark' : 'light'}-${width}.png`) })
    }
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab')
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true)
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await open.evaluate(element => document.activeElement === element), true)
  await open.click()
  await dialog.getByRole('button', { name: '关闭更新日志', exact: true }).click()
  await stop()

  const upgradeProfile = path.join(work, 'upgrade')
  await mkdir(upgradeProfile, { recursive: true })
  await writeFile(path.join(upgradeProfile, 'app-changelog-state.json'), JSON.stringify({ schemaVersion: 1, highestVersion: '1.4.12', pendingVersion: null }))
  ;({ page } = await launch('upgrade'))
  const automatic = page.getByRole('dialog', { name: '更新日志', exact: true })
  await automatic.waitFor()
  await automatic.getByText(`已更新至 ModMind ${version}`, { exact: true }).waitFor()
  assert.equal(await page.locator('#root').evaluate(element => element.inert), true)
  assert.equal((await page.evaluate(() => window.modmind.app.getChangelog())).automatic, false)
  await automatic.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal(await page.locator('#root').evaluate(element => element.inert), false)
  await stop()
  ;({ page } = await launch('upgrade'))
  assert.equal(await page.getByRole('dialog', { name: '更新日志', exact: true }).count(), 0)
  assert.equal((await page.evaluate(() => window.modmind.app.getChangelog())).automatic, false)
  await stop()

  await writeFile(path.join(resources, 'modmind-install-versions.txt'), `${version}\r\n1.4.12\r\n`)
  ;({ page } = await launch('legacy-installer'))
  await page.getByRole('dialog', { name: '更新日志', exact: true }).waitFor()
  await stop()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', work, cases: ['fresh install', 'manual history', 'themes and narrow window', 'focus and dismissal', 'upgrade once', 'restart', 'legacy installer migration'] }))
} finally { await stop() }
