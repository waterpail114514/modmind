import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'minimal-creation', String(Date.now()))
await mkdir(work, { recursive: true })
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(work, 'profile')}`], cwd: root, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(async ({ app, ipcMain, BrowserWindow }, work) => {
    app.setPath('documents', work)
    const fs = process.getBuiltinModule('fs/promises')
    const path = process.getBuiltinModule('path')
    const smoke = globalThis.minimalSmoke = { calls: [], project: null, failBuild: false, holdBuild: false }
    let state = { stage: 'idle', running: false, installed: true, minecraftVersion: '1.21.1', mods: [], message: '' }
    const publish = patch => {
      state = { ...state, projectPath: smoke.project?.path, ...patch }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('minecraft:state', state)
      return state
    }
    const handle = (channel, callback) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, callback) }
    handle('device:getState', () => ({ status: 'connected', configured: true, username: 'smoke', keyStatus: 'ACTIVE' }))
    handle('beginner-codex:prepare', () => ({}))
    handle('project:initializeDraft', async (_event, root) => {
      smoke.calls.push('initialize')
      const file = path.join(root, 'modmind.project.json')
      const draft = JSON.parse(await fs.readFile(file, 'utf8'))
      smoke.project = { ...draft, ...draft.draft.target }
      delete smoke.project.draft
      await fs.writeFile(file, JSON.stringify(smoke.project))
      return smoke.project
    })
    handle('project:current', () => smoke.project)
    handle('ai:createCode', (_event, prompt, _sessionId, _backend, _profile, options) => {
      smoke.calls.push('create')
      smoke.prompt = prompt
      smoke.options = options
      return { summary: '制作完成', tasks: [], files: [], tests: [], warnings: [], intent: 'engineering', finalResponse: '制作完成' }
    })
    handle('minecraft:getState', () => state)
    handle('minecraft:buildProject', async () => {
      smoke.calls.push('build')
      publish({ stage: 'building-mod', running: false, message: '正在构建并同步' })
      if (smoke.failBuild) throw new Error('测试构建失败')
      if (smoke.holdBuild) await new Promise(resolve => { smoke.releaseBuild = resolve })
      return { name: 'test.jar', path: 'test.jar', size: 1, modifiedAt: '', projectArtifact: true }
    })
    handle('minecraft:launch', () => { smoke.calls.push('launch'); return publish({ stage: 'running', running: true, message: '游戏窗口已启动' }) })
    handle('minecraft:cancelPreparation', () => { smoke.releaseBuild?.(); return state })
    handle('minecraft:stop', () => { smoke.calls.push('stop'); return publish({ stage: 'stopped', running: false, message: '测试已停止' }) })
    smoke.setState = publish
  }, work)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '创作需求', exact: true }).fill('制作一个 Fabric 1.21.1 模组，加入一把闪电剑')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const resultButton = page.locator('.agent-result-actions button').first()
  await resultButton.waitFor()
  const handoff = await app.evaluate(() => ({ calls: globalThis.minimalSmoke.calls, prompt: globalThis.minimalSmoke.prompt, options: globalThis.minimalSmoke.options }))
  assert.deepEqual(handoff.calls, ['initialize', 'create'])
  assert.match(handoff.prompt, /闪电剑/)
  assert.equal(handoff.options.workbenchPhase, undefined)
  await resultButton.click()
  const dialog = page.getByRole('dialog', { name: '游戏测试', exact: true })
  await dialog.getByText('游戏窗口已启动', { exact: false }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.minimalSmoke.calls), ['initialize', 'create', 'build', 'launch'])
  assert.equal(await page.locator('.agent-workbench').isVisible(), true)
  assert.equal(await page.locator('.minecraft-test-workspace:visible').count(), 0)
  await page.screenshot({ path: path.join(work, 'desktop.png') })
  await page.setViewportSize({ width: 760, height: 800 })
  await page.screenshot({ path: path.join(work, 'narrow.png') })
  assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1), false)
  await dialog.getByRole('button', { name: '返回创作', exact: true }).last().click()
  await page.getByRole('button', { name: '测试', exact: true }).click()
  await dialog.getByRole('button', { name: '停止测试', exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.minimalSmoke.calls.filter(x => x === 'launch').length), 1)
  await dialog.getByRole('button', { name: '停止测试', exact: true }).click()
  await dialog.getByRole('button', { name: '重新测试', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.minimalSmoke.failBuild = true })
  await dialog.getByRole('button', { name: '重新测试', exact: true }).click()
  await dialog.getByRole('button', { name: '重试', exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.minimalSmoke.calls.filter(x => x === 'launch').length), 1)
  await app.evaluate(() => { globalThis.minimalSmoke.failBuild = false; globalThis.minimalSmoke.holdBuild = true })
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await dialog.getByText('正在构建并同步', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: '取消测试', exact: true }).click()
  await dialog.getByRole('button', { name: '重新测试', exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.minimalSmoke.calls.filter(x => x === 'launch').length), 1)
  await dialog.getByRole('button', { name: '返回创作', exact: true }).last().click()
  await app.evaluate(() => { globalThis.minimalSmoke.holdBuild = false })
  await page.getByRole('button', { name: '测试', exact: true }).click()
  await dialog.getByRole('button', { name: '停止测试', exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.minimalSmoke.calls.filter(x => x === 'launch').length), 2)
  assert.deepEqual(errors, [])
  const report = { work, mode: 'real Electron UI and IPC; mocked AI, scaffold and game processes', checks: ['确认信息后自动创建并制作', '制作完成直接测试', '标题栏直接测试', '构建后启动', '失败重试', '取消后不启动', '窄窗口无溢出'], errors }
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await app?.close() }
