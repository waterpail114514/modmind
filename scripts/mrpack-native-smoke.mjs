import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import extractZip from 'extract-zip'

// Drive the shipping import UI. Only file-picker answers are automated;
// the archive, network, renderer, IPC and import services are real.
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results/mrpack-native')
const run = path.join(output, process.argv[2] || String(Date.now()))
const profile = path.join(run, 'profile')
const destination = path.join(run, 'projects')
const archive = path.join(output, 'downloads/Fabulously.Optimized-v6.5.0.mrpack')
await mkdir(profile, { recursive: true })
await mkdir(destination, { recursive: true })
const upstream = JSON.parse(await readFile(path.join(output, 'downloads/version.json'), 'utf8'))
const bytes = await readFile(archive)
assert.equal(createHash('sha512').update(bytes).digest('hex'), upstream.files[0].hashes.sha512)
const original = path.join(run, 'original')
await extractZip(archive, { dir: original })
const index = JSON.parse(await readFile(path.join(original, 'modrinth.index.json'), 'utf8'))
const bootstrap = path.join(run, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-mrpack-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app, page
const errors = [], progress = []
let poll
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.modmind))
  page.setDefaultTimeout(30000)
  page.on('pageerror', e => errors.push(e.message))
  await app.evaluate(({ dialog }, { archive, destination }) => {
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1).properties.includes('openDirectory') ? destination : archive] })
  }, { archive, destination })
  await page.getByRole('button', { name: /^接管现有项目/ }).click()
  await page.getByRole('button', { name: /^压缩包/ }).click()
  await page.getByRole('button', { name: '接管此整合包', exact: true }).waitFor()
  assert.match(await page.getByRole('dialog').innerText(), /50 个远程文件（其中 48 个 Mod）/)
  await page.screenshot({ path: path.join(run, 'detected.png') })
  console.log('Detected:', await page.getByRole('dialog').innerText())
  await page.getByRole('button', { name: '接管此整合包', exact: true }).click()
  poll = setInterval(async () => {
    const text = await page.locator('body').innerText().catch(() => '')
    const detail = text.slice(-2200)
    if (detail !== progress.at(-1)) { progress.push(detail); console.log(detail.slice(-800)) }
  }, 10000)
  const deadline = Date.now() + 900000
  while (await page.locator('.adopt-dialog').count() && !await page.locator('.adopt-dialog .inline-error').count()) {
    assert.ok(Date.now() < deadline, 'import did not finish within 15 minutes')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const failure = await page.locator('.adopt-dialog .inline-error').count() ? await page.locator('.adopt-dialog .inline-error').textContent() : null
  if (failure) throw new Error(failure)
  const project = await page.evaluate(() => window.modmind.project.current())
  assert.ok(project)
  assert.equal(project.loaderVersion, index.dependencies['fabric-loader'])
  assert.equal(project.minecraftVersion, index.dependencies.minecraft)
  const manifest = await page.evaluate(() => window.modmind.modpack.get())
  const checks = []
  for (const file of index.files) {
    const installed = await readFile(path.join(project.path, 'overrides', file.path))
    assert.equal(installed.length, file.fileSize)
    for (const [algorithm, hash] of Object.entries(file.hashes)) assert.equal(createHash(algorithm).update(installed).digest('hex'), hash, file.path)
    checks.push(file.path)
  }
  async function checkOverrides(directory, prefix = '') {
    const checked = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) checked.push(...await checkOverrides(path.join(directory, entry.name), relative))
      else { assert.deepEqual(await readFile(path.join(project.path, 'overrides', relative)), await readFile(path.join(directory, entry.name)), relative); checked.push(relative) }
    }
    return checked
  }
  const overrides = await checkOverrides(path.join(original, 'overrides'))
  assert.deepEqual(JSON.parse(await readFile(path.join(project.path, '.modmind/import/modrinth.index.json'), 'utf8')), index)
  const archiveIdentity = JSON.parse(await readFile(path.join(project.path, '.modmind/import/source-archive.json'), 'utf8'))
  assert.equal(archiveIdentity.sha256, createHash('sha256').update(bytes).digest('hex'))
  const lock = await page.evaluate(() => window.modmind.modpack.readLock())
  const audit = await page.evaluate(() => window.modmind.modpack.auditLock())
  assert.equal(lock.mods.length, 48)
  assert.deepEqual(audit, { success: true, checked: 48, errors: [] })
  const sync = await page.evaluate(() => window.modmind.modpack.sync())
  const runtime = path.join(project.path, '.modmind/minecraft')
  for (const file of [...index.files.map(file => file.path), ...overrides]) {
    assert.deepEqual(await readFile(path.join(runtime, file)), await readFile(path.join(project.path, 'overrides', file)), `runtime: ${file}`)
  }
  await page.getByRole('button', { name: '模组列表', exact: true }).click()
  await page.locator('.modpack-mod-list-page').waitFor()
  await page.screenshot({ path: path.join(run, 'import-complete.png') })
  const exportedPath = path.join(run, 'roundtrip.mrpack')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exportedPath)
  assert.equal(await page.evaluate(() => window.modmind.project.exportArtifact()), exportedPath)
  const exportedRoot = path.join(run, 'roundtrip')
  await extractZip(exportedPath, { dir: exportedRoot })
  const exportedIndex = JSON.parse(await readFile(path.join(exportedRoot, 'modrinth.index.json'), 'utf8'))
  assert.equal(exportedIndex.files.length, 50)
  for (const file of index.files) {
    const exportedFile = exportedIndex.files.find(item => item.path === file.path)
    assert.deepEqual(exportedFile, file, file.path)
  }
  for (const file of overrides) assert.deepEqual(await readFile(path.join(exportedRoot, 'overrides', file)), await readFile(path.join(original, 'overrides', file)), file)
  const report = { project, manifest, verifiedRemoteFiles: checks, verifiedOverrides: overrides, archiveIdentity, audit, sync, exportedPath, exportedRemoteFiles: exportedIndex.files.length, errors, progress }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ project, remoteFiles: checks.length, overrides: overrides.length, manifestMods: manifest.mods.length, errors }, null, 2))
  assert.deepEqual(errors, [])
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {})
  await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), errors, progress }, null, 2))
  throw error
} finally { clearInterval(poll); await app?.close() }
