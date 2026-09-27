import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Real application routes and local content/CI writes, with external publication,
// game launches, provider searches and native audio selection replaced by fixtures.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'production-navigation', String(Date.now()))
const profile = path.join(work, 'profile')
const projectPath = path.join(work, 'project')
await mkdir(profile, { recursive: true })
await mkdir(path.join(projectPath, 'src/main/resources'), { recursive: true })
await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '发布拆分验证', namespace: 'release_split', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.11' }))
await writeFile(path.join(projectPath, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'release_split', version: '0.1.0', name: '发布拆分验证' }))
await writeFile(path.join(projectPath, 'build.gradle'), 'plugins { id "java" }\nrepositories { mavenCentral() }\ndependencies {}\n')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-production-smoke-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const server = await createServer({
  configFile: false, root: path.join(root, 'src/renderer'), publicDir: path.join(root, 'resources/renderer-public'), plugins: [react()],
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } },
  server: { host: '127.0.0.1', port: 0 }
})
let app
let page
try {
  await server.listen()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(env.ELECTRON_RENDERER_URL))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  await app.evaluate(({ ipcMain }, projectPath) => {
    const handle = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    const state = globalThis.productionNavigation = {
      settings: { version: '0.1.0', displayName: '发布拆分验证 0.1.0', summary: '', changelog: '', channel: 'release', autoBump: true, bumpMode: 'patch', modrinthProjectId: '', curseForgeProjectId: '', githubRepository: '' },
      checks: [], publications: [], audio: [], matrices: [], failSave: false
    }
    handle('release:getSettings', () => state.settings)
    handle('release:saveSettings', (_, input) => {
      if (state.failSave) { state.failSave = false; throw new Error('fixture save failed') }
      state.settings = { ...input, hasGithubToken: Boolean(input.githubToken || state.settings.hasGithubToken) }
      delete state.settings.githubToken
      return state.settings
    })
    handle('release:preflight', () => {
      state.checks.push({ ...state.settings })
      return { ready: true, artifactPath: 'build/libs/release-split.jar', checks: [{ id: 'artifact', label: '发布 JAR', status: 'pass', detail: `release-split-${state.settings.version}.jar` }] }
    })
    handle('release:publish', (_, input) => { state.publications.push(input); return [{ target: 'github', success: true, detail: 'fixture published', url: 'https://github.com/example/release-split/releases/tag/v0.2.0' }] })
    handle('content:importAudio', (_, input) => { state.audio.push(input); return { paths: [], summary: `已导入声音 release_split:${input.eventId}`, warnings: [] } })
    handle('tests:runMatrix', async (_, targets) => {
      state.matrices.push(targets)
      await new Promise(resolve => setTimeout(resolve, 300))
      return { success: true, results: targets.map(target => ({ target, status: 'passed', summary: 'fixture check passed', durationMs: 300 })) }
    })
    handle('relationships:providers', () => [{ id: 'modrinth', label: 'Modrinth' }])
    handle('relationships:recommendations', () => [])
    handle('image-studio:capabilities', () => ({ models: [], sizes: ['1024x1024'], qualities: ['medium'], moderations: ['auto'] }))
    handle('minecraft:getState', () => ({ projectPath, stage: 'idle', running: false, installed: false, mods: [], minecraftVersion: '1.21.1', message: '尚未启动' }))
  }, projectPath)
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  const sidebar = page.locator('#main-sidebar')
  await sidebar.getByRole('button', { name: '切换项目：发布拆分验证', exact: true }).waitFor()
  const navigate = async name => {
    const button = sidebar.getByRole('button', { name, exact: true, includeHidden: true }).and(sidebar.locator('button:not(.nav-caption)'))
    const caption = button.locator('..').locator('..').locator('.nav-caption')
    if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
    await button.click()
  }
  const snapshot = async name => {
    await page.screenshot({ path: path.join(work, `${name}.png`) })
    const overflow = await page.locator('.main-content').evaluate(element => element.scrollWidth - element.clientWidth)
    assert.ok(overflow <= 2, `${name}: main content overflows horizontally by ${overflow}px`)
  }

  await navigate('发布')
  await page.getByRole('heading', { name: '发布', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '依赖', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('Modrinth 项目 ID', { exact: true }).count(), 0)
  assert.equal(await page.getByText('导出成功后自动增加版本', { exact: true }).count(), 0)
  await page.getByLabel('版本', { exact: true }).fill('0.2.0')
  await page.getByLabel('更新日志', { exact: true }).fill('拆分后的发布流程')
  await page.locator('.release-pane summary[aria-label="发布更多操作"]').click()
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await page.getByText('草稿已保存', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.checks.length), 0)
  await page.getByRole('button', { name: '保存并预检', exact: true }).click()
  await page.getByText('release-split-0.2.0.jar', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.checks.at(-1).version), '0.2.0')

  // Keep an unsaved changelog while moving to the platform settings page.
  await page.getByLabel('更新日志', { exact: true }).fill('尚未保存的更新日志')
  await page.getByRole('button', { name: '配置发布平台', exact: true }).click()
  await page.getByRole('heading', { name: '发布平台', exact: true }).waitFor()
  await page.getByLabel('GitHub 仓库', { exact: true }).fill('example/release-split')
  await page.getByLabel('GitHub Token', { exact: true }).fill('fixture-token')
  await page.getByRole('button', { name: '保存平台配置', exact: true }).click()
  await page.getByText('平台绑定已保存，令牌使用系统加密存储', { exact: true }).waitFor()
  await snapshot('platform-settings')
  await navigate('发布')
  await page.locator('.authoring-platform-options').getByText('example/release-split', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('更新日志', { exact: true }).inputValue(), '尚未保存的更新日志')
  await page.getByRole('button', { name: '保存并预检', exact: true }).click()
  await page.getByText('release-split-0.2.0.jar', { exact: true }).waitFor()
  await page.getByRole('checkbox', { name: 'GitHub', exact: true }).check()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认发布', exact: true }).click()
  await page.getByRole('link', { name: '查看发布' }).waitFor()
  const published = await app.evaluate(() => globalThis.productionNavigation)
  assert.equal(published.settings.githubRepository, 'example/release-split')
  assert.equal(published.settings.changelog, '尚未保存的更新日志')
  assert.equal(published.publications.length, 1)
  await snapshot('release-desktop')

  // A failed save must never preflight the old stored version.
  const previousChecks = published.checks.length
  await page.getByLabel('版本', { exact: true }).fill('0.3.0')
  await app.evaluate(() => { globalThis.productionNavigation.failSave = true })
  await page.getByRole('button', { name: '保存并预检', exact: true }).click()
  await page.locator('.release-pane .authoring-feedback.error').waitFor()
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.checks.length), previousChecks)
  assert.ok(await page.getByRole('button', { name: '确认发布', exact: true }).isDisabled())
  await page.getByRole('button', { name: '保存并预检', exact: true }).click()
  await page.getByText('release-split-0.3.0.jar', { exact: true }).waitFor()

  assert.equal(await sidebar.getByRole('button', { name: '内容与数据', exact: true, includeHidden: true }).count(), 0)
  await navigate('资源包')
  await page.getByRole('tab', { name: '内容与数据', exact: true }).click()
  await page.getByLabel('内容类型', { exact: true }).selectOption('recipe-shapeless')
  await page.getByLabel('资源 ID', { exact: true }).fill('copper_mix')
  await page.getByLabel('材料 ID（逗号分隔）', { exact: true }).fill('minecraft:copper_ingot,minecraft:stone')
  await page.getByLabel('产物 ID', { exact: true }).fill('minecraft:gold_ingot')
  await page.getByRole('button', { name: '生成文件', exact: true }).click()
  await page.getByText('已生成无序配方', { exact: true }).waitFor()
  assert.equal(JSON.parse(await readFile(path.join(projectPath, 'src/main/resources/data/release_split/recipe/copper_mix.json'), 'utf8')).result.id, 'minecraft:gold_ingot')
  assert.equal(await page.getByRole('button', { name: '导入声音', exact: true }).count(), 0)
  await page.getByRole('tab', { name: '资源文件', exact: true }).click()
  await page.getByRole('button', { name: 'data/release_split/recipe/copper_mix.json', exact: true }).waitFor()
  await page.getByRole('tab', { name: '内容与数据', exact: true }).click()
  assert.equal(await page.getByLabel('资源 ID', { exact: true }).inputValue(), 'copper_mix')
  await snapshot('content-desktop')
  await page.locator('.content-pane summary[aria-label="内容更多操作"]').click()
  await page.getByRole('button', { name: '验证资源', exact: true }).click()
  await page.locator('.content-pane').getByText('资源验证通过', { exact: true }).waitFor()

  await navigate('前置与联动')
  await page.getByRole('tab', { name: '开发依赖', exact: true }).click()
  await page.getByLabel('坐标', { exact: true }).fill('com.example:helper:1.0.0')
  await page.getByRole('button', { name: '添加 Maven', exact: true }).click()
  await page.getByText('已添加 Maven 依赖 com.example:helper:1.0.0', { exact: true }).waitFor()
  assert.match(await readFile(path.join(projectPath, 'build.gradle'), 'utf8'), /com\.example:helper:1\.0\.0/)
  await page.getByRole('tab', { name: '前置与联动', exact: true }).click()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('heading', { name: '开发依赖', exact: true }).waitFor()
  await snapshot('dependencies-desktop')

  await navigate('声音')
  await page.getByLabel('声音事件 ID', { exact: true }).fill('ambient/wind')
  await page.locator('.sound-import-pane summary').filter({ hasText: '播放设置' }).click()
  await page.getByLabel('音量', { exact: true }).fill('0.5')
  await page.locator('.sound-import-pane summary').filter({ hasText: '播放设置' }).click()
  await page.getByRole('button', { name: '导入音频', exact: true }).click()
  await page.getByText('已导入声音 ambient/wind', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.audio.at(-1).volume), 0.5)
  await navigate('图像工坊')
  assert.equal(await page.getByRole('tab', { name: '声音', exact: true }).count(), 0)
  await page.getByRole('tab', { name: '处理', exact: true }).click()
  await navigate('声音')
  assert.equal(await page.getByLabel('声音事件 ID', { exact: true }).inputValue(), 'ambient/wind')
  await snapshot('sound-desktop')
  await page.locator('.sound-import-pane summary[aria-label="声音更多操作"]').click()
  await page.getByRole('button', { name: '验证资源', exact: true }).click()
  await page.locator('.sound-import-pane').getByText('资源验证通过', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.audio.length), 1, 'validation must not resubmit the import form')

  await navigate('游戏测试')
  await page.getByRole('tab', { name: '自动检查', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '生成 CI', exact: true }).count(), 0)
  await page.getByRole('button', { name: '运行选中测试', exact: true }).click()
  await page.getByRole('tab', { name: '游戏测试', exact: true }).click()
  await page.getByRole('tab', { name: '自动检查', exact: true }).click()
  await page.locator('.matrix-result').first().waitFor()
  assert.equal(await page.locator('.matrix-result').count(), 4)
  assert.equal(await app.evaluate(() => globalThis.productionNavigation.matrices.length), 1)
  await snapshot('tests-desktop')

  await navigate('构建与导出')
  await page.getByRole('button', { name: '生成 CI', exact: true }).click()
  await page.getByText('已生成 .github/workflows/mod-build.yml', { exact: true }).waitFor()
  assert.match(await readFile(path.join(projectPath, '.github/workflows/mod-build.yml'), 'utf8'), /ubuntu-latest, windows-latest/)
  await page.getByLabel('导出版本', { exact: true }).fill('0.4.0')
  await page.getByRole('button', { name: '保存版本设置', exact: true }).click()
  await page.getByText('导出版本设置已保存', { exact: true }).waitFor()
  await navigate('发布')
  await page.waitForFunction(() => document.querySelector('.release-pane input')?.value === '0.4.0')
  assert.equal(await page.getByLabel('更新日志', { exact: true }).inputValue(), '尚未保存的更新日志')

  for (const [label, screenshot] of [['发布', 'release'], ['资源包', 'content'], ['前置与联动', 'dependencies'], ['声音', 'sound'], ['游戏测试', 'tests']]) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await navigate(label)
    if (label === '前置与联动') await page.getByRole('tab', { name: '开发依赖', exact: true }).click()
    if (label === '资源包') await page.getByRole('tab', { name: '内容与数据', exact: true }).click()
    if (label === '游戏测试') await page.getByRole('tab', { name: '自动检查', exact: true }).click()
    await page.setViewportSize({ width: 640, height: 900 })
    await snapshot(`${screenshot}-narrow`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(async () => {
    const settings = await window.modmind.settings.getAgent()
    await window.modmind.settings.saveAgent({ ...settings, darkMode: true })
  })
  await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
  await navigate('发布')
  await snapshot('release-dark')
  await navigate('声音')
  await page.setViewportSize({ width: 640, height: 900 })
  await snapshot('sound-dark-narrow')
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ success: true, errors, checks: 'navigation, draft preservation, save-before-preflight, failed-save guard, platform publish fixture, content/CI disk writes, dependencies, sounds, retained tests, narrow layouts' }, null, 2))
  console.log(`PASS: production navigation smoke; artifacts: ${work}`)
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
    await writeFile(path.join(work, 'failure.html'), await page.content()).catch(() => undefined)
  }
  console.error(`Smoke artifacts: ${work}`)
  throw error
} finally {
  if (app) await app.close()
  await server.close()
}
