import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyWinNative } from './verify-win-native.mjs'

const directory = path.resolve(process.argv[2] || 'release/1.5.0-plugintest/win-unpacked')
const work = path.resolve('test-results/win-executable', String(Date.now()))
await mkdir(work, { recursive: true })
const native = await verifyWinNative(directory)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const executablePath = path.join(directory, 'ModMind Plugin Test.exe')
const app = await electron.launch({ executablePath, args: ['--user-data-dir=' + path.join(work, 'profile')], cwd: directory, env, timeout: 30000 })
try {
  const errors = []
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app-shell').waitFor({ timeout: 30000 })
  await page.locator('#app-loading').waitFor({ state: 'hidden', timeout: 30000 })
  const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), isPackaged: app.isPackaged }))
  if (path.resolve(runtime.executable) !== executablePath || !runtime.isPackaged) throw new Error('Smoke test did not launch the shipped executable')
  if (errors.length) throw new Error(errors.join('\n'))
  await page.screenshot({ path: path.join(work, 'launched.png') })
  const report = { success: true, native, runtime, errors }
  await writeFile(path.join(work, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ work, ...report }))
} finally { await app.close() }
