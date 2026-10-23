import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const workspace = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-skills-ui-'))
const output = path.join(workspace, 'test-results', 'user-skills-live')
const profile = path.join(root, 'profile')
const project = path.join(root, 'project')
const source = path.join(root, 'release-check')
const content = '---\nname: release-check\ndescription: Prepare release materials when requested.\n---\n\nCheck the current release files.\n'
let app
try {
  await fs.mkdir(output, { recursive: true })
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(project)
  await fs.mkdir(path.join(source, 'references'), { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), content)
  await fs.writeFile(path.join(source, 'references', 'checklist.md'), 'Release evidence')
  await fs.writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: 'Skills 验证', namespace: 'skill_check', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: project, createdAt: '', projectVersion: '1.0.0' }))
  const bootstrap = path.join(root, 'bootstrap.cjs')
  await fs.writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-skills-smoke'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(workspace)}); require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 60_000 })
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Main renderer is available')
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.modmind))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  await page.evaluate(async projectPath => {
    localStorage.setItem('modmind-ui-mode', 'advanced')
    await window.modmind.project.openRecent(projectPath)
  }, project)
  await page.reload()
  await page.setViewportSize({ width: 1280, height: 850 })
  const open = async () => {
    await page.getByRole('textbox', { name: '发送给 AI 的消息' }).waitFor()
    const menu = page.locator('summary[aria-label="工作台更多操作"]')
    if (await menu.isVisible()) await menu.click()
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
  }
  await open()
  const surface = page.getByRole('dialog', { name: '用户 Skills' })
  await surface.getByText('尚未添加 Skill', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'empty-light.png') })
  await surface.getByRole('button', { name: '新建', exact: true }).click()
  const editor = surface.getByRole('textbox', { name: 'SKILL.md 内容' })
  await editor.fill('not a skill')
  await surface.getByRole('button', { name: '保存 Skill', exact: true }).click()
  await surface.getByRole('alert').getByText(/YAML/).waitFor()
  assert.equal(await editor.inputValue(), 'not a skill')
  await page.screenshot({ path: path.join(output, 'invalid-light.png') })
  await editor.fill(content.replaceAll('release-check', 'my-release'))
  await surface.getByRole('button', { name: '保存 Skill', exact: true }).click()
  await surface.getByText('已保存，下次发送生效', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.modmind.skills.list())).length, 1)
  await surface.getByRole('checkbox', { name: '启用', exact: true }).uncheck()
  await surface.getByText('已停用，下次发送生效', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.modmind.skills.read('my-release'))).enabled, false)
  await editor.fill(`${await editor.inputValue()}\nUnsaved change`)
  await surface.getByRole('button', { name: '关闭 Skills', exact: true }).click()
  await surface.getByText('有未保存的修改，放弃这些修改？', { exact: true }).waitFor()
  await surface.getByRole('button', { name: '取消', exact: true }).click()
  assert.match(await editor.inputValue(), /Unsaved change/)
  await surface.getByRole('button', { name: '保存 Skill', exact: true }).click()
  await surface.getByText('已保存，当前已停用', { exact: true }).waitFor()
  const importFolder = async () => {
    await app.evaluate(({ dialog }, folder) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] } }
    }, source)
    await surface.locator('summary[aria-label="导入 Skill"]').click()
    await surface.getByRole('button', { name: '导入目录', exact: true }).click()
  }
  await importFolder()
  await surface.getByText('已导入，下次发送生效', { exact: true }).waitFor()
  assert.equal(await fs.readFile(path.join(profile, 'workbench-skills', 'release-check', 'references', 'checklist.md'), 'utf8'), 'Release evidence')
  await importFolder()
  await surface.getByRole('alert').getByText(/同名/).waitFor()
  await page.screenshot({ path: path.join(output, 'conflict-light.png') })
  await surface.getByRole('button', { name: '刷新 Skills', exact: true }).click()
  await surface.getByRole('alert').waitFor({ state: 'hidden' })
  await page.screenshot({ path: path.join(output, 'desktop-light.png') })
  const settings = await page.evaluate(() => window.modmind.settings.getAgent())
  await page.evaluate(settings => window.modmind.settings.saveAgent({ ...settings, darkMode: true }), settings)
  await page.locator('.app-shell.dark-mode').waitFor()
  await page.screenshot({ path: path.join(output, 'desktop-dark.png') })
  for (const width of [1080]) {
    await page.setViewportSize({ width, height: 760 })
    await page.screenshot({ path: path.join(output, `narrow-${width}-dark.png`) })
    const layout = await surface.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const textarea = element.querySelector('textarea').getBoundingClientRect()
      return { left: rect.left, right: rect.right, viewport: innerWidth, overflow: element.scrollWidth > element.clientWidth, editorHeight: textarea.height }
    })
    assert.ok(layout.left >= 0 && layout.right <= layout.viewport && !layout.overflow && layout.editorHeight >= 100, JSON.stringify(layout))
  }
  await surface.getByRole('button', { name: '移除 Skill', exact: true }).click()
  await surface.getByRole('button', { name: '移除 Skill', exact: true }).last().click()
  await surface.getByText('已移除，下次发送生效', { exact: true }).waitFor()
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), content)
  await surface.getByRole('button', { name: '关闭 Skills', exact: true }).click()
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'beginner'))
  await page.reload()
  await open()
  await surface.getByRole('navigation', { name: '用户 Skill 列表' }).getByRole('button', { name: /my-release/ }).click()
  assert.match(await editor.inputValue(), /Unsaved change/)
  await page.screenshot({ path: path.join(output, 'beginner-narrow-dark.png') })
  await surface.getByRole('button', { name: '关闭 Skills', exact: true }).click()
  await page.evaluate(async () => {
    for (let index = 0; index < 30; index++) await window.modmind.skills.save({ content: `---\nname: sample-${index}\ndescription: A sample workflow for search.\n---\n\nSample instructions.\n` })
  })
  await open()
  await surface.getByRole('textbox', { name: '搜索 Skills' }).fill('sample-29')
  const matches = surface.getByRole('navigation', { name: '用户 Skill 列表' }).getByRole('button')
  await matches.waitFor()
  assert.equal(await matches.count(), 1)
  await matches.click()
  assert.match(await editor.inputValue(), /sample-29/)
  await page.screenshot({ path: path.join(output, 'search-narrow-dark.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, output, scenarios: ['offline create/edit', 'invalid input recovery', 'disable', 'unsaved cancel', 'folder import/resources', 'duplicate import', 'remove', 'reload persistence', 'beginner entry', 'search 30 skills', 'light/dark/1080px/760px'] }, null, 2))
} catch (error) {
  const page = app?.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close().catch(() => undefined)
  assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
}
