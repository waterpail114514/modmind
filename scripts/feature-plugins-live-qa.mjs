import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { createInterface } from 'node:readline'

const root = path.resolve(import.meta.dirname, '..')
const { _electron: electron } = createRequire(import.meta.url)('playwright')
export const work = path.join(root, 'test-results', 'feature-plugins-live')
export const profile = process.env.MODMIND_LIVE_PROFILE ? path.resolve(process.env.MODMIND_LIVE_PROFILE) : path.join(work, 'profile')
export const project = path.join(os.tmpdir(), 'modmind-feature-live-project')

export async function launchLiveQa(rendererUrl) {
  await mkdir(profile, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({
    name: 'Feature Plugin Live QA', namespace: 'plugin_live_qa', kind: 'mod',
    loader: 'fabric', minecraftVersion: '1.21.1', path: project,
    createdAt: new Date().toISOString(), projectVersion: '1.5.0-plugintest'
  }, null, 2))
  const bootstrap = path.join(work, 'bootstrap.cjs')
  await writeFile(bootstrap, `const { app } = require('electron');
app.setName('ModMind Feature Live QA');
app.setPath('userData', ${JSON.stringify(profile)});
app.setAppPath(${JSON.stringify(root)});
app.getVersion = () => '1.5.0-plugintest';
require(${JSON.stringify(path.join(root, 'out', 'main', 'index.js'))});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  if (rendererUrl) env.ELECTRON_RENDERER_URL = rendererUrl
  const app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app-shell').waitFor()
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => {
    window.setTitle('ModMind Feature Live QA')
    window.webContents.setBackgroundThrottling(false)
  }))
  return { app, page, errors, work, profile, project }
}

export async function sanitizedAccount(page) {
  return page.evaluate(async () => {
    const state = await window.modmind.device.getState()
    return {
      status: state.status, configured: state.configured, provider: state.provider,
      balanceCents: state.balanceCents, keyStatus: state.keyStatus, message: state.message
    }
  })
}

export async function connectAccount(page) {
  await page.locator('.hosted-titlebar-button').click()
  const dialog = page.getByRole('dialog', { name: 'ModMind 设备连接', exact: true })
  await dialog.waitFor()
  if (await dialog.getByRole('button', { name: '打开浏览器连接', exact: true }).count()) {
    await dialog.getByRole('button', { name: '打开浏览器连接', exact: true }).click()
  }
  return sanitizedAccount(page)
}

export async function screenshot(page, name) {
  await page.screenshot({ path: path.join(work, name + '.png') })
}

export async function openProject(page) {
  await page.evaluate(target => window.modmind.project.openRecent(target), project)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.locator('.app-shell').waitFor()
}

export async function record(name, result) {
  await writeFile(path.join(work, name + '.json'), JSON.stringify(result, null, 2))
}

if (process.argv.includes('--preview')) {
  const qa = await launchLiveQa(process.env.MODMIND_LIVE_RENDERER_URL)
  console.log(JSON.stringify({ ready: true, name: 'ModMind Feature Live QA', profile, pluginDirectory: path.join(root, 'feature-plugin-dist') }))
  await new Promise(resolve => qa.app.once('close', resolve))
} else if (process.argv.includes('--interactive')) {
  const qa = await launchLiveQa(process.env.MODMIND_LIVE_RENDERER_URL)
  console.log(JSON.stringify({ ready: true, work, account: await sanitizedAccount(qa.page) }))
  const lines = createInterface({ input: process.stdin, terminal: false })
  for await (const line of lines) {
    try {
      const request = JSON.parse(line)
      let result
      if (request.command === 'connect') result = await connectAccount(qa.page)
      else if (request.command === 'account') result = await sanitizedAccount(qa.page)
      else if (request.command === 'project') { await openProject(qa.page); result = { project } }
      else if (request.command === 'ui') result = await qa.page.locator('body').innerText()
      else if (request.command === 'screenshot') { await screenshot(qa.page, request.name); result = { name: request.name } }
      else if (request.command === 'click') { await qa.page.getByRole('button', { name: request.name, exact: true }).click(); result = { clicked: request.name } }
      else if (request.command === 'evaluate') result = await qa.page.evaluate(request.code, request.argument)
      else if (request.command === 'mainEvaluate') result = await qa.app.evaluate(request.code, request.argument)
      else if (request.command === 'reload') { await qa.page.reload(); await qa.page.locator('.app-shell').waitFor(); result = { reloaded: true } }
      else if (request.command === 'close') { await qa.app.close(); lines.close(); break }
      else throw new Error('Unknown QA command')
      console.log(JSON.stringify({ command: request.command, result }))
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }))
    }
  }
  await qa.app.close().catch(() => {})
}
