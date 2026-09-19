import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// Real upstream releases, real decompiler and real project-creation IPC. Only the
// native file picker is automated; all application handlers remain unchanged.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/plugin-jar-adoption')
const run = path.join(work, String(Date.now()))
const profile = path.join(run, 'profile')
const destination = path.join(run, 'projects')
await mkdir(profile, { recursive: true })
await mkdir(destination, { recursive: true })
await mkdir(path.join(work, 'downloads'), { recursive: true })
const toolsJava = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' }).stderr.match(/java.home = (.+)/)?.[1].trim()
assert.ok(toolsJava, 'a local JDK is required')
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ javaPreferences: { game: '', build: toolsJava, tools: toolsJava } }))
const samples = [
  { slug: 'chunky', versionId: 'P3y2MXnd', loader: 'spigot', minecraftVersion: '1.21.1' },
  { slug: 'freedomchat', versionId: '37l08D01', loader: 'paper', minecraftVersion: '1.21.8' },
  { slug: 'minimotd', versionId: '70syJfBo', loader: 'velocity', minecraftVersion: '3.4.0-SNAPSHOT' }
]
async function download(url) {
  let failure
  for (const candidate of [url, url.replace('cdn-alt.modrinth.com', 'cdn.modrinth.com'), url]) {
    try { const response = await fetch(candidate, { signal: AbortSignal.timeout(30000) }); assert.ok(response.ok); return Buffer.from(await response.arrayBuffer()) }
    catch (error) { failure = error }
  }
  throw failure
}
for (const sample of samples) {
  const version = await fetch(`https://api.modrinth.com/v2/version/${sample.versionId}`).then(r => { assert.ok(r.ok); return r.json() })
  const file = version.files.find(file => file.primary) ?? version.files[0]
  const jarPath = path.join(work, 'downloads', file.filename)
  let bytes = await readFile(jarPath).catch(() => null)
  if (!bytes || createHash('sha512').update(bytes).digest('hex') !== file.hashes.sha512) {
    bytes = await download(file.url)
    assert.equal(createHash('sha512').update(bytes).digest('hex'), file.hashes.sha512)
    await writeFile(jarPath, bytes)
  }
  Object.assign(sample, { version: version.version_number, url: file.url, jarPath, sha512: file.hashes.sha512 })
}
await writeFile(path.join(work, 'downloads.json'), JSON.stringify(samples, null, 2))
const bootstrap = path.join(run, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-plugin-adoption-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
const results = []
async function tree(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await tree(full))
    else result.push(full)
  }
  return result
}
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  let page = await app.firstWindow()
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (candidate) { page = candidate; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  page.setDefaultTimeout(30000)
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.modmind))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const sample of samples) {
    console.log(`Testing ${sample.slug} ${sample.version}`)
    await app.evaluate(({ dialog }, { jarPath, destination }) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1)
        return { canceled: false, filePaths: [options.properties?.includes('openDirectory') ? destination : jarPath] }
      }
    }, { jarPath: sample.jarPath, destination })
    const inspected = await page.evaluate(jarPath => window.modmind.decompile.inspect(jarPath), sample.jarPath)
    assert.ok(inspected.plugin, 'must identify as a server plugin')
    assert.equal(inspected.remapRecommended, false)
    console.log(`Detected ${inspected.loader}, ${inspected.classCount} classes, ${inspected.plugin.file}`)
    // The launcher opens this same adoption dialog for mods and server plugins.
    const takeover = page.getByRole('button').filter({ hasText: '接管模组或插件' })
    if (!await takeover.isVisible()) await page.getByRole('button', { name: /^切换项目：/ }).click()
    await takeover.click()
    const dialog = page.locator('.mod-jar-adopt-dialog')
    await dialog.waitFor()
    await dialog.getByText('JAR 服务端插件', { exact: true }).waitFor()
    await dialog.locator('select').selectOption(sample.loader)
    const versionInput = dialog.locator('input[list]')
    await versionInput.fill(sample.minecraftVersion)
    await page.screenshot({ path: path.join(run, `${sample.slug}-inspect.png`) })
    await dialog.getByRole('button', { name: '反编译并接管', exact: true }).click()
    await dialog.getByRole('button', { name: '我已阅读并同意，创建项目', exact: true }).waitFor({ timeout: 240000 })
    console.log(`Decompiled ${sample.slug}; creating project`)
    await dialog.getByRole('button', { name: '我已阅读并同意，创建项目', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 180000 })
    const projectDirs = await readdir(destination)
    const projects = await Promise.all(projectDirs.map(async directory => JSON.parse(await readFile(path.join(destination, directory, 'modmind.project.json'), 'utf8'))))
    const project = projects.find(project => project.loader === sample.loader)
    assert.ok(project)
    assert.equal(project.kind, 'server-plugin')
    assert.equal(project.minecraftVersion, sample.minecraftVersion)
    const resources = path.join(project.path, 'src/main/resources')
    const source = path.join(project.path, 'src/main/java', `${inspected.plugin.main.replaceAll('.', '/')}.java`)
    assert.ok((await readFile(source, 'utf8')).includes('class '))
    const cachedResources = path.join(profile, 'decompile/jars', inspected.sha256, 'resources')
    let checkedResources = 0
    for (const file of await tree(cachedResources)) {
      const relative = path.relative(cachedResources, file).replaceAll('\\', '/')
      if (/^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i.test(relative)) continue
      assert.deepEqual(await readFile(path.join(resources, relative)), await readFile(file), `resource mismatch: ${relative}`)
      checkedResources++
    }
    const provenance = JSON.parse(await readFile(path.join(project.path, 'docs/decompiled-source-provenance.json'), 'utf8'))
    assert.equal(provenance.plugin.main, inspected.plugin.main)
    assert.equal(provenance.sourceSha256, inspected.sha256)
    const files = await page.evaluate(sha => window.modmind.decompile.listFiles(sha), inspected.sha256)
    const repeated = await page.evaluate(input => window.modmind.decompile.start(input), { jarPath: sample.jarPath, minecraftVersion: sample.minecraftVersion })
    assert.equal(repeated.reused, true)
    await page.screenshot({ path: path.join(run, `${sample.slug}-project.png`) })
    const result = { ...sample, detectedPlatform: inspected.loader, descriptor: inspected.plugin.file, classCount: inspected.classCount, sourceFiles: files.length, checkedResources, errorFiles: files.filter(file => file.hasErrors).length, projectPath: project.path, cacheReused: repeated.reused }
    results.push(result)
    console.log(JSON.stringify(result))
    await writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2))
  }
  assert.deepEqual(errors, [])
  console.log(`PASS: ${results.length} real plugin JARs. Evidence: ${run}`)
} catch (error) {
  const page = app?.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
  if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(-7000)) }
  throw error
} finally { await app?.close() }
