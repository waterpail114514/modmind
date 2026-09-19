import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual settings page with isolated storage and deterministic IPC responses.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'theme-details-live', String(Date.now()))
const profile = path.join(work, 'profile')
await mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setName('modmind-theme-audit-${Date.now()}'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
const server = await createServer({
  configFile: false, root: path.join(root, 'src/renderer'),
  publicDir: path.join(root, 'resources/renderer-public'), plugins: [react()],
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } },
  server: { host: '127.0.0.1', port: 0 }
})
let app
try {
  await server.listen()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(env.ELECTRON_RENDERER_URL))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'main renderer window must be available')
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile), path.resolve(profile))
  await page.waitForFunction(() => Boolean(window.modmind)).catch(async error => {
    console.error('Initialization:', page.url(), await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), preferences: window.webContents.getLastWebPreferences() }))))
    await page.screenshot({ path: path.join(work, 'initialization-error.png') })
    throw error
  })
  const shots = [], results = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  const projectPath = path.join(work, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '主题细节', namespace: 'theme_details', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.6', toolDataDirectory: '.modmind' }))
  await writeFile(path.join(projectPath, 'build.gradle'), '// Theme audit fixture\n')
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode','advanced'))
  await page.reload()
  const sidebar = page.locator('#main-sidebar')
  await sidebar.getByRole('button', { name: '切换项目：主题细节', exact: true }).waitFor()
  const navigate = async id => {
    const button = sidebar.locator(`[data-sidebar-drag-key="item:${id}"]`)
    const group = button.locator('..').locator('..').locator('.nav-caption')
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    await button.click()
    await page.locator(`.main-content[data-view="${id}"]`).waitFor()
  }
  const setAppearance = async (preset, dark) => {
    const customThemeColors = preset === 'custom' ? { light: { canvas: '#edf4f1', accent: '#825124' }, dark: { canvas: '#29272c', accent: '#debd70' } } : {}
    const actualPreset = preset === 'custom' ? 'modmind' : preset
    await page.evaluate(async value => { const s = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({...s,themePreset:value.preset,darkMode:value.dark,customThemeColors:value.customThemeColors}) }, {preset:actualPreset,dark,customThemeColors})
    await page.waitForFunction(value=>document.documentElement.dataset.themePreset===value.preset&&document.documentElement.dataset.themeMode===(value.dark?'dark':'light'),{preset:actualPreset,dark})
  }
  const shot = async name => { await page.screenshot({path:path.join(work,name+'.png')});shots.push(name) }
  for (const dark of [false,true]) {
    await setAppearance('neutral',dark)
    await navigate('settings')
    for (const category of ['通用','AI 与图像','开发与构建','集成','关于']) {
      await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:category,exact:true}).click()
      await shot(`settings-${category}-${dark}`)
    }
    await navigate('production')
    for(const tab of ['依赖','内容','测试矩阵','发布']){
      await page.locator('.production-tabs').getByRole('button',{name:tab,exact:true}).click()
      await shot(`production-${tab}-${dark}`)
    }
    await navigate('image-studio')
    for(const tab of ['工作流','处理','编辑']){
      await page.getByRole('tab',{name:tab,exact:true}).click()
      await shot(`image-${tab}-${dark}`)
    }
    if (!dark) await page.getByRole('button',{name:'新建画布',exact:true}).click()
    let frame
    for (let attempt = 0; attempt < 100; attempt++) {
      frame = page.frames().find(frame=>frame.url().includes('/minipaint/index.html'))
      if (frame) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if(frame){
      for(const preset of ['neutral','sand','sage','graphite','modmind','custom']){
        await setAppearance(preset,dark)
        const expected=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim())
        for(let n=0;n<100;n++){if(await frame.evaluate(()=>document.body.style.getPropertyValue('--background'))===expected)break;await new Promise(resolve=>setTimeout(resolve,100))}
        assert.equal(await frame.evaluate(()=>document.body.style.getPropertyValue('--background')),expected)
        assert.equal(await frame.evaluate(()=>getComputedStyle(document.body, '::-webkit-scrollbar').width),'10px')
        results.push(`miniPaint ${preset}/${dark}`)
      }
      await shot(`miniPaint-${dark}`)
    } else throw Error('miniPaint iframe missing')
    await navigate('settings')
    await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'通用',exact:true}).click()
    await page.locator('summary[aria-label="侧边栏选项"]').click()
    await page.getByRole('button',{name:'恢复默认顺序',exact:true}).click()
    await page.getByRole('alertdialog').waitFor()
    await shot(`confirm-${dark}`)
    await page.getByRole('alertdialog').getByRole('button',{name:'保留当前顺序',exact:true}).click()
  }
  await navigate('blockbench')
  // Check the actual embedded editor, not just its surrounding React toolbar.
  const state=await page.evaluate(()=>window.modmind.blockbench.getState())
  console.log('Blockbench state:',state)
  const embedded=await app.evaluate(({webContents})=>webContents.getAllWebContents().find(contents=>contents.getURL().includes('/blockbench/'))?.id)
  assert.ok(embedded,'Blockbench webContents exists')
  assert.equal(await app.evaluate(async ({webContents},id)=>webContents.fromId(id).executeJavaScript('getComputedStyle(document.body, "::-webkit-scrollbar").width'),embedded),'10px')
  for(const preset of ['neutral','sand','sage','graphite','modmind','custom'])for(const dark of [false,true]){
    await setAppearance(preset,dark)
    await page.evaluate(async () => { const s = await window.modmind.settings.getAgent(); await window.modmind.blockbench.setTheme(s.darkMode?'dark':'light',s.themePreset,s.customThemeColors) })
    const expected=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim())
    const colors=await app.evaluate(async ({webContents},id)=>webContents.fromId(id).executeJavaScript('({back:document.body.style.getPropertyValue("--color-back") || getComputedStyle(document.body).getPropertyValue("--color-back"),ready:!!globalThis.Blockbench})'),embedded)
    assert.equal(colors.back.trim(),expected)
    results.push(`Blockbench ${preset}/${dark}`)
  }
  assert.deepEqual(errors,[])
  await writeFile(path.join(work,'report.json'),JSON.stringify({work,shots,results,errors},null,2))
  console.log(`PASS: settings categories, production tabs, image modes, dialogs and ${results.length} embedded editor themes. ${work}`)
}finally{
  if(app){
    // miniPaint may install beforeunload for the blank fixture. Exit only this
    // isolated test process without invoking its interactive close confirmation.
    const closed=app.waitForEvent('close')
    await app.evaluate(({app})=>{setTimeout(()=>app.exit(0),0)})
    await closed
  }
  await server.close()
}
