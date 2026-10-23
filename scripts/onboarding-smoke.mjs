import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { featureBundles } from '../src/renderer/src/featureInstallPlan.ts'

// Real Electron, preload, official installation/verification and project creation.
// Only HTTP transport and the native folder picker use local deterministic fixtures.
const workspace = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-onboarding-'))
const profile = path.join(temporary, 'profile'), projects = path.join(temporary, 'projects')
const output = path.join(workspace, 'test-results/onboarding', `${Date.now()}${process.argv.includes('--offline-only') ? '-offline' : ''}`)
const catalog = JSON.parse(await fs.readFile(path.join(workspace, 'feature-release/features/stable/catalog.json'), 'utf8'))
const offlineOnly = process.argv.includes('--offline-only')
const helpOnly = process.argv.includes('--help-only')
const key = 'modmind-onboarding:v1'
let app, page, processLog = ''
const errors = [], checks = []

async function until(predicate, argument, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await page.evaluate(predicate, argument)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error(`Tutorial state timed out: ${predicate}`)
}
const phase = async value => until(expected => JSON.parse(localStorage.getItem('modmind-onboarding:v1') ?? '{}').phase === expected, value)
const popover = () => page.locator('[data-onboarding-popover]')
async function capture(name, width = 1280, dark = false) {
  await page.evaluate(async darkMode => { const settings = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({ ...settings, darkMode }) }, dark)
  // Resize the real desktop window; viewport emulation can bypass its minimum size.
  const size = await app.evaluate(({ BrowserWindow }, { url, requestedWidth }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === url)
    if (!window) throw Error('Main desktop window not found')
    const minimum = window.getMinimumSize()
    const requested = requestedWidth === 'minimum' ? minimum : requestedWidth === 'current' ? window.getSize() : [requestedWidth, 820]
    if (requested[0] < minimum[0] || requested[1] < minimum[1]) throw Error('Capture size is outside desktop window limits')
    if (window.isMaximized()) window.unmaximize()
    window.setSize(...requested)
    return { minimum, actual: window.getSize() }
  }, { url: page.url(), requestedWidth: width })
  assert.ok(size.actual[0] >= size.minimum[0] && size.actual[1] >= size.minimum[1])
  await new Promise(resolve => setTimeout(resolve, 350))
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const bounds = await popover().boundingBox().catch(() => null)
  if (bounds) assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, `Popover fits desktop viewport ${viewport.width}x${viewport.height}`)
  await page.screenshot({ path: path.join(output, `${name}.png`) })
}
async function choose(goal, task) {
  await page.getByRole('button', { name: '新手教程', exact: true }).click()
  await page.getByRole('button', { name: '我是新手，带我开始', exact: false }).click()
  await page.getByRole('button', { name: goal, exact: false }).click()
  await page.getByRole('button', { name: task, exact: false }).click()
}
async function activeClick() {
  const active = page.locator('.driver-active-element')
  await active.waitFor()
  const tag = await active.evaluate(element => element.tagName)
  if (tag === 'SELECT') await active.selectOption('all')
  else if (tag === 'INPUT') await active.fill('')
  else await active.click()
  await new Promise(resolve => setTimeout(resolve, 350))
}
async function enterFeatures() {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await page.locator('.features-page').isVisible().catch(() => false)) break
    await activeClick()
  }
  await phase('locate')
}
async function prepareResources() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')))
    assert.equal(state.status, 'running', `Resource preparation requires an active tutorial (${state.phase})`)
    if (['create', 'tool'].includes(state.phase)) return
    const trust = page.getByRole('dialog', { name: /安装应用功能插件|安装工作台/ })
    if (await trust.isVisible().catch(() => false)) {
      await trust.getByRole('button', { name: '信任并安装', exact: true }).click()
      await trust.waitFor({ state: 'hidden' })
    } else {
      const job = await page.evaluate(async () => (await window.modmind.featurePlugins.store()).job)
      const batch = await page.evaluate(() => document.querySelector('[data-onboarding="feature-batch"]')?.getAttribute('data-onboarding-running'))
      const proceed = popover().getByRole('button', { name: '准备好了，继续', exact: true })
      if (batch === 'true' || job && ['downloading', 'installing'].includes(job.phase)) await new Promise(resolve => setTimeout(resolve, 250))
      else if (await proceed.count()) {
        assert.equal(state.phase, 'locate', 'Ready components must still show the download lesson')
        await new Promise(resolve => setTimeout(resolve, 350))
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).phase), 'locate', 'No automatic advance before user confirmation')
        await capture(`bundle-${state.goal}-ready`, 'current', true)
        await proceed.click()
      }
      else if (await page.getByRole('alertdialog').getByRole('button', { name: '开始安装', exact: true }).isVisible().catch(() => false)) await page.getByRole('alertdialog').getByRole('button', { name: '开始安装', exact: true }).click()
      else if (await page.locator('.driver-active-element').isVisible().catch(() => false)) await activeClick()
      else if (await popover().getByRole('button', { name: /打开/ }).count()) await popover().getByRole('button', { name: /打开/ }).click()
      else await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw Error(`Resource preparation did not finish: ${await popover().innerText()}`)
}
async function selectCombination(goalId) {
  await enterFeatures()
  for (let attempt = 0; attempt < 12; attempt++) {
    const active = page.locator('.driver-active-element')
    if (await active.getAttribute('data-onboarding').catch(() => null) === 'bundle-install') return
    await activeClick()
  }
  throw Error(`Combination selection did not finish: ${await popover().innerText()}`)
}
async function assertCombination(goalId) {
  const ids = featureBundles.find(bundle => bundle.id === goalId).ids
  const entries = await page.evaluate(() => window.modmind.featurePlugins.catalog())
  assert.ok(ids.every(id => entries.some(entry => entry.id === id && entry.available)), `All ${goalId} recommended components actually available`)
}
async function create(name, expectedStudio, cancelPicker = false) {
  await phase('create')
  for (let attempt = 0; attempt < 4 && !await page.locator('.studio-create-dialog').isVisible().catch(() => false); attempt++) await activeClick()
  await phase('studio')
  assert.equal(await page.locator(`[data-onboarding-studio="${expectedStudio}"]`).getAttribute('aria-pressed'), 'true')
  await popover().getByRole('button', { name: '继续', exact: true }).click()
  await phase('field')
  await until(() => document.querySelector('.driver-active-element')?.dataset.onboardingBind === 'name')
  await capture(`${expectedStudio}-name`, 'current', true)
  assert.equal(await popover().getByRole('button', { name: '填好了，继续', exact: true }).isDisabled(), true)
  await page.locator('.driver-active-element input').fill(name)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.driver-active-element input')), true, 'Validity changes preserve typing focus')
  await popover().getByRole('button', { name: '填好了，继续', exact: true }).click()
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')))
    if (state.phase === 'submit') break
    await popover().getByRole('button', { name: '填好了，继续', exact: true }).click()
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  await phase('submit')
  if (cancelPicker) {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await activeClick()
    assert.equal(await page.locator('.studio-create-dialog').isVisible(), true)
    assert.equal(await page.locator('[data-onboarding="create-submit"]').isDisabled(), false)
    checks.push('cancelled native folder selection preserves the form and permits retry')
  }
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, projects)
  await activeClick()
  await page.locator('.studio-create-dialog').waitFor({ state: 'hidden' })
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  const project = await page.evaluate(() => window.modmind.project.current())
  assert.equal(project.studioId, expectedStudio)
  assert.equal(JSON.parse(await fs.readFile(path.join(project.path, 'modmind.project.json'), 'utf8')).name, name)
  return project
}
async function finish() {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await page.getByRole('button', { name: '开始创作', exact: true }).isVisible().catch(() => false)) break
    await popover().waitFor()
    if (await popover().getByRole('button', { name: '知道了，开始创作', exact: true }).count()) await popover().getByRole('button', { name: '知道了，开始创作', exact: true }).click()
    else await activeClick()
  }
  await page.getByRole('button', { name: '开始创作', exact: true }).click()
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).status), 'done')
}
try {
  await fs.mkdir(profile); await fs.mkdir(projects); await fs.mkdir(output, { recursive: true })
  await fs.mkdir(path.join(profile, 'feature-store'))
  if (!offlineOnly) await fs.writeFile(path.join(profile, 'feature-store/catalog.json'), JSON.stringify({ index: catalog, checkedAt: new Date().toISOString() }))
  const bootstrap = path.join(temporary, 'bootstrap.cjs')
  await fs.writeFile(bootstrap, `
    const {app}=require('electron'),fs=require('node:fs'),path=require('node:path'),{Readable}=require('node:stream');
    app.setName('modmind-onboarding-qa');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});
    global.__onboardingQa={failPackages:true,delay:50,offline:${offlineOnly},requests:[]};
    require(${JSON.stringify(require.resolve('undici'))}).request=async(url,options)=>{
      const target=new URL(url),qa=global.__onboardingQa;qa.requests.push(target.pathname);
      if(qa.offline||target.hostname!=='mmdesktop.cn-nb1.rains3.com')throw Error('Onboarding QA offline');
      if(target.pathname.includes('/packages/')&&qa.failPackages)throw Error('Onboarding QA download failure');
      const file=path.join(${JSON.stringify(path.join(workspace, 'feature-release'))},target.pathname),data=fs.readFileSync(file);
      const body=Readable.from((async function*(){for(let index=0;index<data.length;index+=32768){options.signal?.throwIfAborted();await new Promise(r=>setTimeout(r,qa.delay));yield data.subarray(index,index+32768)}})());
      body.text=async()=>{let chunks=[];for await(const chunk of body)chunks.push(chunk);return Buffer.concat(chunks).toString()};
      return {statusCode:200,headers:{'content-length':String(data.length),'content-type':'application/octet-stream'},body};
    };
    global.fetch=async()=>{throw Error('Onboarding QA offline')};
    require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});
  `)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 60000 })
  app.process().stdout?.on('data', chunk => { processLog += chunk }); app.process().stderr?.on('data', chunk => { processLog += chunk })
  await app.firstWindow({ timeout: 60000 })
  for (let attempt = 0; attempt < 100; attempt++) { page = app.windows().find(window => window.url().includes('/renderer/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(page); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.hide(); window.webContents.setBackgroundThrottling(false) }))
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  const changelog = page.getByRole('button', { name: '关闭更新日志', exact: true })
  if (await changelog.isVisible().catch(() => false)) await changelog.click()
  // Simple mode retains its original interface, with no tutorial or added menu items.
  assert.equal(await page.locator('.onboarding-question,[data-onboarding-popover]').count(), 0)
  assert.equal(await page.locator('[data-onboarding="tutorial-help"]').count(), 0)
  assert.equal(await page.locator('#main-sidebar').isVisible(), false)
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: '新手教程', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: '功能与下载', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: '新建项目', exact: true }).count(), 0)
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.locator('.expert-mode-toggle').click()
  checks.push('simple mode has no tutorial, no new menu items and unchanged hidden sidebar; professional mode activates first-run choice')
  await page.getByRole('button', { name: '我是老手，直接进入', exact: false }).waitFor()
  await capture('experience-light'); await capture('experience-dark-desktop-minimum', 'minimum', true)
  await page.getByRole('button', { name: '我是老手，直接进入', exact: false }).click()
  await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.onboarding-question').count(), 0)
  checks.push('first-run novice/expert choice, skip persistence, light/dark and actual desktop minimum size'); console.log('PASS first-run choice and skip')

  if (helpOnly) {
    const help = page.getByRole('button', { name: '新手教程', exact: true })
    await help.waitFor()
    await capture('titlebar-help-light')
    await capture('titlebar-help-dark-desktop-minimum', 'minimum', true)
    const box = await help.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= await page.evaluate(() => innerWidth))
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await help.click()
    assert.equal(await page.locator('.titlebar-menu').count(), 0)
    await phase('experience')
    await page.getByRole('button', { name: '我是新手，带我开始', exact: false }).click()
    await phase('goal')
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).status), 'paused')
    await help.click()
    await phase('experience')
    await page.getByRole('button', { name: '我是老手，直接进入', exact: false }).click()
    await page.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...state, status: 'done' })) }, key)
    await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
    await help.click()
    await phase('experience')
    await page.getByRole('button', { name: '我是新手，带我开始', exact: false }).click()
    await page.getByRole('button', { name: '制作 Mod', exact: false }).click()
    await page.getByRole('button', { name: '准备制作第一个物品', exact: false }).click()
    await enterFeatures()
    await capture('titlebar-help-replayed-tour', 'minimum', true)
    await page.keyboard.press('Escape')
    checks.push('titlebar question mark replays skipped, paused and completed tutorials; dismisses More menu; actual guided navigation; light/dark desktop sizes; absent in simple mode')
  } else if (offlineOnly) {
    await choose('开发服务端插件', '让 AI 帮我制作一条指令')
    await enterFeatures()
    for (let attempt = 0; attempt < 10 && !/组合还没有准备完整/.test(await popover().innerText()); attempt++) await activeClick()
    assert.match(await popover().innerText(), /组合还没有准备完整/)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).phase), 'locate')
    assert.deepEqual(await fs.readdir(path.join(profile, 'feature-plugins')), [])
    await capture('first-offline-unavailable', 'minimum', true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '新建项目', exact: true }).click()
    await page.locator('[data-onboarding-studio="minecraft-server-plugin"]').click()
    await page.locator('[data-onboarding-bind="name"] input').fill('First Offline Server')
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, projects)
    await page.locator('[data-onboarding="create-submit"]').click()
    await page.locator('.studio-create-dialog').waitFor({ state: 'hidden' }); await page.locator('#app-loading').waitFor({ state: 'hidden' })
    assert.equal((await page.evaluate(() => window.modmind.project.current())).studioId, 'minecraft-server-plugin')
    checks.push('fresh offline profile: incomplete full recommendation blocks tutorial advancement; pause preserves ordinary builtin local project creation')
  } else {
  await choose('制作 Mod', '准备制作第一个物品')
  await capture('download-entry-dark', 1280, true)
  await selectCombination('mod')
  console.log('Reached full recommendation installation'); await capture('install-light', 1280); await capture('install-dark-desktop-minimum', 'minimum', true)
  await activeClick()
  await until(async () => (await window.modmind.featurePlugins.store()).job?.phase === 'error')
  await until(() => document.querySelector('[data-onboarding="feature-batch"]')?.getAttribute('data-onboarding-running') !== 'true')
  assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).phase), 'create')
  await popover().getByRole('button', { name: '稍后继续', exact: true }).click()
  await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '继续教程', exact: true }).click()
  await app.evaluate(() => { global.__onboardingQa.failPackages = false; global.__onboardingQa.delay = 1500 })
  await selectCombination('mod')
  await activeClick()
  await until(async () => (await window.modmind.featurePlugins.store()).job?.phase === 'downloading')
  await capture('download-progress-dark', 1280, true)
  await page.locator('[data-onboarding="feature-batch"]').getByRole('button', { name: '取消剩余', exact: true }).click()
  await until(async () => (await window.modmind.featurePlugins.store()).job?.phase === 'cancelled')
  assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).phase), 'create')
  await app.evaluate(() => { global.__onboardingQa.delay = 350 })
  const importFile = path.join(workspace, 'feature-release', catalog.features.find(entry => entry.id === 'item-editor').path)
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, importFile)
  const importing = page.evaluate(() => window.modmind.featurePlugins.install().catch(() => null))
  const trust = page.getByRole('dialog', { name: '安装应用功能插件', exact: true })
  await trust.waitFor(); await capture('install-confirm-dark', 1280, true)
  assert.equal(await trust.locator('.onboarding-install-action').count(), 1)
  await trust.getByRole('button', { name: '取消', exact: true }).click()
  await importing
  assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).phase), 'create')
  await app.evaluate(() => { global.__onboardingQa.delay = 1 })
  await prepareResources()
  await assertCombination('mod')
  checks.push('full Mod recommendation: actual download failure and cancellation do not advance; restart resume; local-import confirmation cancellation; real hash verification and full batch installation; explicit continue')
  await capture('create-entry-desktop-minimum', 'minimum', true)
  await create('Tutorial Mod', 'minecraft-mod', true)
  const originalProject = await page.evaluate(() => window.modmind.project.current())
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '继续新手教程', exact: true }).click()
  await prepareResources()
  assert.equal((await page.evaluate(() => window.modmind.project.current())).path, originalProject.path)
  await phase('tool')
  await capture('tool-entry-dark', 1280, true); await finish()
  checks.push('real Mod creation, persisted metadata readback and opening the installed item tool'); console.log('PASS Mod route')

  for (const [goal, task, studio, name] of [
    ['制作整合包', '准备添加模组', 'minecraft-modpack', 'Tutorial Modpack'],
    ['开发服务端插件', '让 AI 帮我制作一条指令', 'minecraft-server-plugin', 'Tutorial Server'],
    ['制作光影', '查看和编辑光影源码', 'minecraft-shader', 'Tutorial Shader']
  ]) {
    await choose(goal, task); await prepareResources(); await create(name, studio)
    await assertCombination(studio === 'minecraft-modpack' ? 'modpack' : studio === 'minecraft-server-plugin' ? 'server' : 'shader')
    await capture(`${studio}-tool`, 1280); await finish()
    checks.push(`${studio}: full recommended combination installation, explicit continue, actual creation, readback and destination tool`); console.log(`PASS ${studio}`)
  }
  await choose('制作 Mod', '准备制作第一个物品')
  const requestCount = await app.evaluate(() => global.__onboardingQa.requests.length)
  await prepareResources()
  assert.equal(await app.evaluate(() => global.__onboardingQa.requests.length), requestCount)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-onboarding:v1')).status), 'paused')
  checks.push('fully installed recommendations still show download location and require explicit continue; no repeated download; Escape pauses and restores application input')
  await app.evaluate(() => { global.__onboardingQa.offline = true })
  await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '稍后继续', exact: true }).click()
  await page.evaluate(key => { localStorage.removeItem(key) }, key)
  await page.reload(); await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '我是新手，带我开始', exact: false }).click()
  await page.getByRole('button', { name: '开发服务端插件', exact: false }).click()
  await page.getByRole('button', { name: '让 AI 帮我制作一条指令', exact: false }).click()
  await prepareResources(); await create('Tutorial Offline Server', 'minecraft-server-plugin'); await finish()
  checks.push('offline tutorial and local server-plugin creation; no forced AI execution or runtime downloads')
  }
  assert.deepEqual(errors, [])
  const result = { success: true, output, checks, errors }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await fs.writeFile(path.join(output, 'process.log'), processLog)
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined); await fs.writeFile(path.join(output, 'ui.txt'), await page.locator('body').innerText().catch(() => '')) }
  console.error(JSON.stringify({ output, errors })); throw error
} finally {
  await app?.close().catch(() => undefined)
  // Disposable test profile is deliberately retained for inspecting recovery and installed artifacts.
}
