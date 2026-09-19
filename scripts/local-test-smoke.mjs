import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'local-test-ui', String(Date.now()))
const projectPath = path.join(work, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '本机测试回归', namespace: 'local_test', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.20.1', path: projectPath, createdAt: '', toolDataDirectory: '.modmind' }))
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(work, 'profile')}`], cwd: root, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await app.evaluate(({ ipcMain, BrowserWindow }, projectPath) => {
    let state = { projectPath, stage: 'idle', active: false, message: '尚未开始测试', recentLogs: [] }
    let server = { projectPath, stage: 'idle', running: false, minecraftVersion: '1.20.1', recentLogs: [], message: '' }
    const publish = () => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.send('local-test:state', state); window.webContents.send('local-server:state', server) } }
    for (const channel of ['local-test:getState', 'local-test:start', 'local-test:stop', 'modpack:getServerState']) ipcMain.removeHandler(channel)
    ipcMain.handle('local-test:getState', () => state)
    ipcMain.handle('modpack:getServerState', () => server)
    ipcMain.handle('local-test:start', (_event, options) => {
      globalThis.localTestSmokeOptions = options
      state = { ...state, active: true, stage: 'preparing', message: '正在准备服务端与客户端' }
      publish()
      return state
    })
    ipcMain.handle('local-test:stop', () => { state = { ...state, active: false, stage: 'stopped', message: '测试已停止', client: undefined }; server = { ...server, running: false, stage: 'stopped' }; publish(); return state })
    globalThis.localTestSmokeReady = () => {
      state = { ...state, stage: 'running', message: '客户端运行中', client: { stage: 'running', running: true, installed: true, message: 'Minecraft 测试实例运行中', mods: [], minecraftVersion: '1.20.1' }, recentLogs: [{ time: new Date().toISOString(), message: 'Connecting to 127.0.0.1, 25565' }] }
      server = { ...server, running: true, stage: 'running', port: 25565, recentLogs: [{ time: new Date().toISOString(), message: 'Done! For help, type help' }] }
      publish()
    }
    globalThis.localTestSmokeError = () => { state = { ...state, active: false, stage: 'error', message: '客户端准备失败：测试错误', client: { stage: 'error', running: false, installed: false, minecraftVersion: '1.20.1', message: '测试错误', mods: [] } }; publish() }
  }, projectPath)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.agent-workbench').waitFor()
  await page.screenshot({ path: path.join(work, 'before-test.png') })
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  const quickTest = page.getByRole('dialog', { name: '游戏测试', exact: true })
  await quickTest.getByRole('button', { name: '停止测试', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.localTestSmokeOptions), { username: 'ModMindDev', maxMemoryMb: 4096 })
  await quickTest.getByRole('button', { name: '停止测试', exact: true }).click()
  await quickTest.getByRole('button', { name: '返回创作', exact: true }).last().click()
  await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  const panel = page.locator('.modpack-tool-workspace[data-section="server"]')
  await panel.getByRole('button', { name: '开始测试', exact: true }).click()
  await panel.getByRole('button', { name: '取消测试', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.localTestSmokeOptions), { username: 'ModMindDev', maxMemoryMb: 4096, port: 25565 })
  await panel.getByRole('button', { name: '取消测试', exact: true }).click()
  await panel.getByRole('button', { name: '开始测试', exact: true }).waitFor()
  await panel.getByRole('button', { name: '开始测试', exact: true }).click()
  await app.evaluate(() => globalThis.localTestSmokeReady())
  await panel.getByRole('button', { name: '停止测试', exact: true }).waitFor()
  await panel.getByRole('tab', { name: '客户端', exact: true }).click()
  assert.match(await panel.getByRole('log').innerText(), /Connecting to 127.0.0.1/)
  await page.screenshot({ path: path.join(work, 'desktop.png') })
  await page.setViewportSize({ width: 760, height: 800 })
  await page.screenshot({ path: path.join(work, 'narrow.png') })
  const overflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)
  assert.equal(overflow, false)
  await panel.getByRole('button', { name: '重新测试', exact: true }).click()
  await panel.getByRole('button', { name: '取消测试', exact: true }).waitFor()
  await app.evaluate(() => globalThis.localTestSmokeError())
  await panel.getByText('客户端准备失败：测试错误', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '开始测试', exact: true }).waitFor()
  await panel.locator('summary').filter({ hasText: '测试设置' }).click()
  await panel.getByLabel('玩家名', { exact: true }).fill('x')
  assert.equal(await panel.getByRole('button', { name: '开始测试', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  const report = { work, mode: 'mocked game processes; real Electron UI and IPC', checks: ['测试入口', '开始与取消', '两端状态', '客户端日志', '重新测试', '错误重试', '玩家名校验', '窄窗口无横向溢出'], errors }
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await app?.close() }
