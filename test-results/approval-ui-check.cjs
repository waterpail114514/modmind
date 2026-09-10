const { _electron: electron } = require('playwright')
const { mkdtemp } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

;(async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'modmind-approval-ui-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () => electron.launch({ args: ['.', `--user-data-dir=${profile}`], env })
  let app
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const select = page.getByLabel('Codex 审批模式')
    if (await select.inputValue() !== 'auto-review') throw new Error('incorrect default')
    await select.selectOption('yolo')
    await page.waitForFunction(async () => (await window.modmind.settings.getAgent()).codexApprovalMode === 'yolo')
    await page.screenshot({ path: 'test-results/approval-settings-desktop.png' })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    if (await page.getByLabel('Codex 审批模式').inputValue() !== 'yolo') throw new Error('setting did not persist')
    await page.setViewportSize({ width: 800, height: 700 })
    await page.screenshot({ path: 'test-results/approval-settings-compact.png' })
    await page.getByLabel('Codex 审批模式').selectOption('auto-review')
    await page.waitForFunction(async () => (await window.modmind.settings.getAgent()).codexApprovalMode === 'auto-review')
    console.log('PASS: default, YOLO save, restart persistence, and return to automatic review')
  } finally {
    if (app) await app.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
