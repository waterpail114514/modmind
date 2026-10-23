import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'modpack-mod-refresh', String(Date.now()))
await mkdir(work, { recursive: true })
await build({ stdin: { contents: "export * from './src/main/modpackService'; export * from './src/main/modpackLockService'; export { createStoredZip } from './src/main/bedrockAddon';", resolveDir: root, loader: 'ts' }, outfile: path.join(work, 'backend.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const service = createRequire(import.meta.url)(path.join(work, 'backend.cjs'))
const project = { kind: 'modpack', path: path.join(work, 'project'), name: 'Refresh fixture', namespace: 'pack', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
await mkdir(project.path)
await service.createModpackTemplate(project)
const directory = path.join(project.path, 'mods')
const add = index => writeFile(path.join(directory, `mod-${index}.jar`), service.createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: `mod_${index}`, version: '1' })) }, { name: 'padding.bin', data: Buffer.alloc(2048) }]))
await Promise.all(Array.from({ length: 60 }, (_, index) => add(index)))
await service.refreshModpackMods(project)
const fixtureApi = async (request, response) => {
  const operation = request.url?.slice(1)
  try {
    const result = operation === 'project' ? project : operation === 'refresh' ? await service.refreshModpackMods(project) : operation === 'get' ? await service.readModpackManifest(project) : operation === 'lock' ? await service.readModpackLock(project) : operation === 'audit' ? await service.auditModpackLock(project) : await service.readModpackImportStatus(project)
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result))
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })) }
}
const server = await createServer({ configFile: false, root, plugins: [react(), { name: 'fixture-api', configureServer(server) { server.middlewares.use('/__mod-refresh', fixtureApi) } }], optimizeDeps: { entries: ['scripts/fixtures/modpack-mod-refresh.html'] }, server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  const url = server.resolvedUrls.local[0] + 'scripts/fixtures/modpack-mod-refresh.html'
  const rows = page.locator('.modpack-mod-row')
  const count = async expected => { await page.waitForFunction(value => document.querySelectorAll('.modpack-mod-row').length === value, expected) }
  const refresh = async () => {
    await page.locator('summary[aria-label="模组列表更多操作"]').click()
    await page.getByRole('button', { name: '刷新模组列表', exact: true }).click()
  }
  await page.goto(url)
  await count(60)
  await Promise.all(Array.from({ length: 58 }, (_, index) => add(index + 60)))
  await refresh(); await count(118)
  assert.equal(JSON.parse(await readFile(path.join(project.path, 'modmind.pack.json'), 'utf8')).mods.length, 118)
  await page.reload(); await count(118)
  await unlink(path.join(directory, 'mod-117.jar'))
  await page.reload(); await count(117)
  await writeFile(path.join(directory, 'broken.jar'), '')
  await refresh()
  await page.getByRole('status').filter({ hasText: 'broken.jar' }).waitFor()
  assert.equal(await rows.count(), 117)
  await unlink(path.join(directory, 'broken.jar'))
  await refresh(); await count(117)
  await page.getByRole('status').filter({ hasText: 'broken.jar' }).waitFor({ state: 'detached' })
  await page.getByRole('textbox', { name: '搜索第三方模组' }).fill('mod-116.jar')
  await count(1)
  await page.getByRole('textbox', { name: '搜索第三方模组' }).fill('')
  await count(117)
  for (const dark of [false, true]) for (const width of [1280, 1080]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(url + (dark ? '?dark' : ''))
    await count(117)
    assert.ok(await page.locator('.modpack-mod-list-page').evaluate(node => node.scrollWidth <= node.clientWidth + 1))
    await page.screenshot({ path: path.join(work, `${width}-${dark ? 'dark' : 'light'}.png`) })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, verified: ['60 to 118', 'reopen', 'initial rescan', 'remove', 'failure and retry', 'search', '1280 and 1080 light/dark'], artifacts: work }))
} finally { await browser?.close(); await server.close() }
