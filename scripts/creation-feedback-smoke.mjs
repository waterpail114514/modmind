import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'creation-feedback-live', String(Date.now()))
const projectPath = path.join(work, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '创作反馈回归', namespace: 'feedback_test', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.20.1', path: projectPath, createdAt: '', toolDataDirectory: '.modmind' }))
const attachment = path.join(work, 'feedback.log')
await writeFile(attachment, Array.from({ length: 64 }, () => '[12:00:00 ERROR] java.lang.IllegalStateException: example\n    at test.Skill.run(Skill.java:12)').join('\n'))
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(work, 'profile')}`], cwd: root, timeout: 30000 })
  const page = await app.firstWindow(); page.setDefaultTimeout(15000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.agent-workbench').waitFor()
  assert.equal(await page.locator('.creation-feedback-panel').count(), 0)
  assert.equal(await page.evaluate(() => 'creationFeedback' in window.modmind), false)
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, attachment)
  const picked = await page.evaluate(() => window.modmind.ai.pickAttachments('files'))
  assert.match(picked[0].diagnosticSummary, /出现 64 次/)
  await page.screenshot({ path: path.join(work, 'workspace.png') })
  assert.deepEqual(errors, [])
  const report = { work, checked: ['聊天页没有新增反馈面板', '没有新增页面接口', '首次日志附件自动聚合 64 次异常'], errors }
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await app?.close() }
