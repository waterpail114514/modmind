import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import assert from 'node:assert/strict'
import yauzl from 'yauzl'

const root = path.resolve(import.meta.dirname, '..')
const archive = path.resolve(process.argv[2])
const runId = process.argv[3] || String(Date.now())
assert.match(runId, /^\d+$/)
const run = path.join(root, 'test-results', 'modpack-connector-adoption', runId)
const profile = path.join(run, 'profile')
const destination = path.resolve(root, '..', 'modpack-connector-smoke', runId)
await mkdir(profile, { recursive: true })
await mkdir(destination, { recursive: true })
let resumedProject
if (process.argv[3]) {
  const previous = path.join(run, 'projects')
  const names = await readdir(previous).catch(() => [])
  for (const name of names) {
    await rename(path.join(previous, name), path.join(destination, name))
  }
  const projects = await readdir(destination)
  assert.equal(projects.length, 1)
  resumedProject = path.join(destination, projects[0])
}
const bootstrap = path.join(run, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-connector-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
// Compare every embedded file to the ZIP without creating another extracted copy.
async function verifyArchive(project) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)))
  const files = []
  await new Promise((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', entry => {
      if (!entry.fileName.startsWith('overrides/') || entry.fileName.endsWith('/')) { zip.readEntry(); return }
      zip.openReadStream(entry, async (error, stream) => {
        if (error) { reject(error); return }
        try {
          const hash = createHash('sha256')
          for await (const chunk of stream) hash.update(chunk)
          const expected = hash.digest('hex')
          const relative = entry.fileName.slice('overrides/'.length)
          assert.equal(await sha256(path.join(project.path, entry.fileName)), expected, `project: ${relative}`)
          assert.equal(await sha256(path.join(project.path, '.modmind', 'minecraft', relative)), expected, `runtime: ${relative}`)
          files.push(relative)
          if (files.length % 1000 === 0) console.log(`Verified ${files.length} embedded files`)
          zip.readEntry()
        } catch (error) { zip.close(); reject(error) }
      })
    })
    zip.readEntry()
  })
  return files
}
async function verifyMcp(page, project) {
  const state = await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  assert.equal(state.running, true)
  const config = JSON.parse(await readFile(state.mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, config.args, { cwd: project.path, env: { ...env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let nextId = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const response = JSON.parse(line)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response.result)
  })
  child.on('error', error => { for (const request of pending.values()) request.reject(error) })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'connector-smoke', version: '1' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
    const catalog = await call('tools/list', {})
    assert.ok(catalog.tools.some(tool => tool.name === 'modmind_runtime_state'))
    const response = await call('tools/call', { name: 'modmind_runtime_state', arguments: {} })
    assert.ok(!response.isError, JSON.stringify(response))
    const runtime = JSON.parse(response.content.find(item => item.type === 'text').text)
    assert.equal(runtime.modpackImport.installed, 237)
    assert.equal(runtime.modpackImport.compatibilityWarnings.length, 1)
    assert.match(runtime.modpackImport.compatibilityWarnings[0], /modefite-neoforge.*1\.21\.1/)
    const manifest = await call('tools/call', { name: 'modmind_read_project_file', arguments: { path: 'modmind.pack.json', startLine: 1, lineCount: 20 } })
    assert.ok(!manifest.isError, JSON.stringify(manifest))
    const forbidden = await call('tools/call', { name: 'modmind_read_project_file', arguments: { path: '../outside.json' } })
    assert.equal(forbidden.isError, true)
    return { runtime, projectReadSucceeded: true, outsideProjectRejected: true }
  } finally {
    lines.close()
    for (const request of pending.values()) clearTimeout(request.timer)
    child.stdin.end()
    child.kill()
    await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false))
  }
}
let app, page
const errors = []
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.modmind))
  if (resumedProject) {
    await page.evaluate(projectPath => window.modmind.project.openRecent(projectPath), resumedProject)
  } else {
    await app.evaluate(({ dialog }, { archive, destination }) => {
      dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1).properties.includes('openDirectory') ? destination : archive] })
    }, { archive, destination })
    await page.getByRole('button', { name: /^接管现有项目/ }).click()
    await page.getByRole('button', { name: /^压缩包/ }).click()
    await page.getByRole('button', { name: '接管此整合包', exact: true }).waitFor({ timeout: 240000 })
    await page.screenshot({ path: path.join(run, 'detected.png') })
    console.log('ZIP recognized')
    await page.getByRole('button', { name: '接管此整合包', exact: true }).click()
    const deadline = Date.now() + 240000
    while (await page.locator('.adopt-dialog').count() && !await page.locator('.adopt-dialog .inline-error').count()) {
      assert.ok(Date.now() < deadline, 'Adoption did not complete within four minutes')
      await page.waitForTimeout(1000)
    }
    const failure = await page.locator('.adopt-dialog .inline-error').count() ? await page.locator('.adopt-dialog .inline-error').textContent() : null
    assert.ok(!failure, failure)
  }
  const project = await page.evaluate(() => window.modmind.project.current())
  assert.equal(project.loader, 'forge')
  assert.equal(project.minecraftVersion, '1.20.1')
  assert.equal(project.loaderVersion, '47.4.20')
  const manifest = await page.evaluate(() => window.modmind.modpack.get())
  assert.equal(manifest.mods.length, 237)
  const status = await page.evaluate(() => window.modmind.modpack.importStatus())
  assert.equal(status.compatibilityWarnings.length, 1)
  assert.match(status.compatibilityWarnings[0], /modefite-neoforge.*1\.21\.1/)
  const artifactReport = JSON.parse(await readFile(path.join(project.path, '.modmind', 'import', 'artifact-report.json'), 'utf8'))
  assert.equal(artifactReport.connectorBridge, true)
  console.log('Adopted all 237 mods; Connector detected; one NeoForge compatibility warning')
  const sync = await page.evaluate(() => window.modmind.modpack.sync())
  console.log('Runtime sync completed')
  const files = await verifyArchive(project)
  const identity = JSON.parse(await readFile(path.join(project.path, '.modmind', 'import', 'source-archive.json'), 'utf8'))
  assert.equal(identity.sha256, await sha256(archive))
  const mcp = await verifyMcp(page, project)
  console.log('MCP runtime status and project boundary verified')
  await page.getByRole('button', { name: '模组列表', exact: true }).click()
  await page.locator('.modpack-mod-list-page').waitFor()
  const compatibility = page.locator('details').filter({ has: page.locator('summary', { hasText: '原包兼容性提示' }) })
  await compatibility.locator('summary').click()
  assert.match(await compatibility.innerText(), /modefite-neoforge.*1\.21\.1/)
  await page.screenshot({ path: path.join(run, 'complete-desktop.png') })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(680, 600); window.setSize(780, 760) })
  await page.screenshot({ path: path.join(run, 'complete-narrow.png') })
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('.modpack-mod-list-page')
    const row = panel.querySelector('.modpack-mod-row')
    const command = row.querySelector('.icon-button.danger')
    return { width: panel.clientWidth, scrollWidth: panel.scrollWidth, rowHeight: row.getBoundingClientRect().height, commandBottom: command.getBoundingClientRect().bottom, rowBottom: row.getBoundingClientRect().bottom }
  })
  assert.ok(overflow.scrollWidth <= overflow.width + 1, JSON.stringify(overflow))
  assert.ok(overflow.rowHeight <= 64 && overflow.commandBottom <= overflow.rowBottom, JSON.stringify(overflow))
  assert.equal((await readdir(path.join(project.path, '.modmind', 'minecraft', 'mods'))).filter(name => /\.jar$/i.test(name)).length, 237)
  assert.deepEqual(errors, [])
  await writeFile(path.join(run, 'result.json'), JSON.stringify({ project, modCount: manifest.mods.length, verifiedEmbeddedFiles: files.length, status, artifactReport, sync, mcp, errors, overflow }, null, 2))
  console.log(JSON.stringify({ run, project: project.path, verifiedEmbeddedFiles: files.length, mods: manifest.mods.length, warnings: status.compatibilityWarnings, errors }, null, 2))
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {})
  await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), errors }, null, 2))
  throw error
} finally { await app?.close() }
