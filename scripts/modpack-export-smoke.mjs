import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import extractZip from 'extract-zip'

// Real renderer, IPC, settings and ZIP writer. Only native save-dialog answers are supplied.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/modpack-export', String(Date.now()))
const profile = path.join(work, 'profile')
const packPath = path.join(work, 'pack')
for (const folder of [profile, path.join(packPath, 'mods'), path.join(packPath, 'overrides/config'), path.join(packPath, 'overrides/resourcepacks')]) await mkdir(folder, { recursive: true })
const project = { path: packPath, name: '整合包导出验证', namespace: 'export_check', kind: 'modpack', studioId: 'minecraft-modpack', loader: 'fabric', loaderVersion: '0.16.5', minecraftVersion: '1.21.1', projectVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, createdAt: '' }
const mod = Buffer.alloc(2048, 5)
const resource = Buffer.from('resource pack fixture')
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const modRecord = { fileName: 'fixture.jar', sha256: digest('sha256', mod), size: mod.length, addedAt: '' }
await writeFile(path.join(packPath, 'modmind.project.json'), JSON.stringify(project))
await writeFile(path.join(packPath, 'modmind.pack.json'), JSON.stringify({ version: 1, name: project.name, loader: project.loader, minecraftVersion: project.minecraftVersion, mods: [modRecord], modules: [] }))
await writeFile(path.join(packPath, 'modmind.modpack.lock.json'), JSON.stringify({ version: 1, minecraftVersion: project.minecraftVersion, loader: project.loader, mods: [{ ...modRecord, provider: 'modrinth', projectId: 'p', versionId: 'v', versionName: '1', side: 'both', installedAt: '', sources: ['https://cdn.modrinth.com/fixture.jar'] }] }))
await writeFile(path.join(packPath, 'mods/fixture.jar'), mod)
await writeFile(path.join(packPath, 'overrides/resourcepacks/visuals.zip'), resource)
await writeFile(path.join(packPath, 'overrides/config/settings.json'), '{"enabled":true}')
await writeFile(path.join(packPath, 'modmind.pack-content.json'), JSON.stringify({ version: 1, items: [{ id: 'content:resourcepacks/visuals.zip', kind: 'resourcepacks', path: 'resourcepacks/visuals.zip', scope: 'client', delivery: 'remote', sourceUrl: 'https://cdn.modrinth.com/visuals.zip', sha1: digest('sha1', resource), sha512: digest('sha512', resource), size: resource.length, addedAt: '' }] }))
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app, session } = require('electron'); app.setName('modmind-export-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); const originalFetch = globalThis.fetch; globalThis.fetch = (input, options) => /^https?:/.test(String(input?.url || input)) && !String(input?.url || input).startsWith('http://127.0.0.1:') ? Promise.reject(new Error('Offline MRPack export smoke')) : originalFetch(input, options); app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*'] }, (_, cb) => cb({ cancel: true }))); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app, page
const errors = []
const checks = []
try {
  app = await electron.launch({ ...(process.env.MODMIND_ELECTRON_EXECUTABLE ? { executablePath: process.env.MODMIND_ELECTRON_EXECUTABLE } : {}), args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let i = 0; i < 100; i++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => { localStorage.setItem('modmind-ui-mode', 'advanced'); localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, status: 'skipped', phase: 'experience', fieldIndex: 0 })) })
  await page.reload()
  await page.locator('.app-shell').waitFor()
  for (const id of ['media-runtime', 'publishing']) {
    await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }) }, path.join(root, 'feature-plugin-dist', `${id}.mmfeature`))
    const installing = page.evaluate(() => window.modmind.featurePlugins.install())
    const confirmation = page.getByRole('dialog', { name: '安装应用功能插件', exact: true })
    await confirmation.waitFor()
    await confirmation.getByRole('button', { name: '信任并安装', exact: true }).click()
    await installing
    checks.push({ installed: id })
  }
  await page.evaluate(target => window.modmind.project.openRecent(target), packPath)
  await page.reload()
  const navigate = async () => {
    const button = page.locator('#main-sidebar [data-sidebar-drag-key="item:production"]')
    await button.waitFor({ state: 'attached' })
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
  }
  await navigate()
  const mode = page.getByLabel('导出方式', { exact: true })
  await mode.waitFor()
  assert.equal(await mode.inputValue(), 'bundled')
  await page.getByLabel('导出成功后自动递增', { exact: true }).uncheck()
  const exportButton = page.getByRole('button', { name: '导出 .mrpack', exact: true })
  const pick = async (target, canceled = false) => app.evaluate(({ dialog }, { target, canceled }) => { dialog.showSaveDialog = async () => ({ filePath: target, canceled }) }, { target, canceled })
  for (const value of ['bundled', 'download']) {
    await mode.selectOption(value)
    const target = path.join(work, `${value}.mrpack`)
    await pick(target)
    await exportButton.click()
    await page.getByText(`整合包已导出到 ${target}`, { exact: true }).waitFor()
    const extracted = path.join(work, value)
    await extractZip(target, { dir: extracted })
    const index = JSON.parse(await readFile(path.join(extracted, 'modrinth.index.json'), 'utf8'))
    assert.equal(index.files.length, value === 'bundled' ? 0 : 2)
    if (value === 'bundled') {
      assert.deepEqual(await readFile(path.join(extracted, 'overrides/mods/fixture.jar')), mod)
      assert.deepEqual(await readFile(path.join(extracted, 'client-overrides/resourcepacks/visuals.zip')), resource)
    }
    assert.equal(await readFile(path.join(extracted, 'overrides/config/settings.json'), 'utf8'), '{"enabled":true}')
    checks.push({ mode: value, remoteFiles: index.files.length })
  }
  await page.reload()
  await navigate()
  await mode.waitFor()
  assert.equal(await mode.inputValue(), 'download', 'saved export preference survives reload')
  await pick(path.join(work, 'canceled.mrpack'), true)
  await exportButton.click()
  await exportButton.waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('.modpack-delivery-actions .primary-button')?.disabled)
  await assert.rejects(readFile(path.join(work, 'canceled.mrpack')))
  const failed = path.join(work, 'retry.mrpack')
  await pick(failed)
  await unlink(path.join(packPath, 'mods/fixture.jar'))
  await exportButton.click()
  await page.locator('.production-notice').filter({ hasText: '导出失败' }).waitFor()
  await page.screenshot({ path: path.join(work, 'failure.png') })
  await writeFile(path.join(packPath, 'mods/fixture.jar'), mod)
  await exportButton.click()
  await page.getByText(`整合包已导出到 ${failed}`, { exact: true }).waitFor()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async darkMode => window.modmind.settings.saveAgent({ ...await window.modmind.settings.getAgent(), darkMode }), theme === 'dark')
    await page.reload()
    await navigate()
    await page.waitForFunction(darkMode => document.querySelector('.app-shell')?.classList.contains('dark-mode') === darkMode, theme === 'dark')
    for (const [width, height] of [[1440, 920], [1080, 680]]) {
      await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/index.html'))?.setSize(width, height), { width, height })
      await mode.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(work, `${theme}-${width}.png`), fullPage: true })
      const overflow = await page.locator('.modpack-delivery-pane').evaluate(element => element.scrollWidth - element.clientWidth)
      assert.ok(overflow <= 2, `${theme}/${width}: horizontal overflow ${overflow}`)
      const bounds = await mode.boundingBox()
      assert.ok(bounds && bounds.width > 180)
      checks.push({ theme, width, height, overflow, selectWidth: bounds.width })
      if (width === 1080) {
        await exportButton.scrollIntoViewIfNeeded()
        const action = await exportButton.boundingBox()
        assert.ok(action && action.y >= 0 && action.y + action.height <= (await page.viewportSize()?.height ?? height))
        assert.equal(await exportButton.isEnabled(), true)
        await page.screenshot({ path: path.join(work, `${theme}-${width}-actions.png`) })
        checks.push({ theme, width, exportActionReachable: true })
      }
    }
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ checks, errors, work }, null, 2))
  console.log(JSON.stringify({ work, checks, errors }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {})
  await writeFile(path.join(work, 'failure.json'), JSON.stringify({ error: String(error), errors, checks }, null, 2))
  throw error
} finally { await app?.close() }
