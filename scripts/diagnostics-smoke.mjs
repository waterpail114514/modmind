import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import extractZip from 'extract-zip'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'diagnostics-live', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
let application
let logs
const launch = async () => {
  application = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, timeout: 30_000 })
  logs = await application.evaluate(({ app }) => app.getPath('logs'))
  assert.equal(path.resolve(logs).startsWith(path.resolve(work) + path.sep), true, 'diagnostics must use an isolated profile')
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.modmind))
  return page
}
const quit = async () => {
  const closed = application.waitForEvent('close', { timeout: 30_000 })
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  await closed
  application = undefined
}
try {
  let page = await launch()
  await page.evaluate(() => {
    window.modmind.diagnostics.reportError({ name: 'Error', message: 'diagnostic-smoke-renderer', componentStack: 'SmokeComponent > App' }, 'react-root-error')
  })
  await page.evaluate(() => Promise.allSettled([
    window.modmind.resourcePacks.list('invalid-root'),
    window.modmind.resourcePacks.list('invalid-root')
  ]))
  await page.evaluate(() => window.modmind.blockbench.getState())
  await application.evaluate(async ({ webContents }) => {
    const embedded = webContents.getAllWebContents().find(contents => contents.getURL().includes('blockbench'))
    assertEmbedded(embedded)
    function assertEmbedded(value) { if (!value) throw new Error('Blockbench webContents not found') }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await embedded.executeJavaScript('Boolean(globalThis.__modmindDiagnosticsInstalled)')) break
      if (attempt === 99) throw new Error('Blockbench diagnostic hooks did not initialize')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await embedded.executeJavaScript(`window.dispatchEvent(new ErrorEvent('error', { message: 'diagnostic-smoke-blockbench' }))`)
  })
  const zip = path.join(work, 'diagnostics.zip')
  await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, zip)
  assert.equal(await page.evaluate(() => window.modmind.diagnostics.exportLogs()), zip)
  const extracted = path.join(work, 'export')
  await extractZip(zip, { dir: extracted })
  const critical = (await readFile(path.join(extracted, 'app-logs', 'diagnostic-critical.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert(critical.some(event => event.error?.componentStack === 'SmokeComponent > App'))
  assert(critical.some(event => event.subsystem === 'blockbench' && event.message.includes('diagnostic-smoke-blockbench')))
  const failures = critical.filter(event => event.operation === 'resource-packs-list' && event.phase === 'error')
  assert.equal(new Set(failures.map(event => event.data.requestId)).size, 2)
  await quit()
  assert.equal(JSON.parse(await readFile(path.join(logs, 'diagnostic-session.json'), 'utf8')).state, 'clean-exit')
  page = await launch()
  const restarted = (await readFile(path.join(logs, 'diagnostic-critical.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(restarted.filter(event => event.operation === 'session' && event.phase === 'start').at(-1).data.outcome, 'clean-exit')
  // Simulate abrupt interruption only in this isolated application process.
  const closed = application.waitForEvent('close', { timeout: 30_000 })
  await application.evaluate(({ app }) => { setTimeout(() => app.exit(1), 0) })
  await closed
  application = undefined
  await launch()
  const interrupted = (await readFile(path.join(logs, 'diagnostic-critical.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(interrupted.filter(event => event.operation === 'session' && event.phase === 'start').at(-1).data.outcome, 'unconfirmed-exit')
  await quit()
  const report = { work, checked: ['renderer component stack', 'Blockbench page error', 'concurrent IPC IDs in separate module', 'archive export', 'normal quit and restart', 'abrupt exit and restart'] }
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await application?.close() }
