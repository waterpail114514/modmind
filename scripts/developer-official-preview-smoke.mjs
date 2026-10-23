import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createDeveloperAgent } from './developer-agent-fixture.mjs'

const require = createRequire(import.meta.url), workspace = path.resolve(import.meta.dirname, '..')
const output = path.join(workspace, 'test-results/developer-workbench', 'official-' + Date.now())
const profile = path.join(output, 'profile'), projects = path.join(output, 'projects')
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(projects)
const bootstrap = path.join(output, 'bootstrap.cjs')
await fs.writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(workspace)});require(${JSON.stringify(require.resolve('undici'))}).request=async()=>{throw Error('QA offline')};global.fetch=async()=>{throw Error('QA offline')};require(${JSON.stringify(path.join(workspace, 'out/main/index.js'))});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
env.MODMIND_UI_QA_OFFSCREEN = '1'
let app, page, processLog = ''
const errors = [], checks = []
const sdkOnly=process.argv.includes('--sdk-only')
async function screenshot(name) {
  await page.waitForTimeout(200)
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html')).webContents
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{contents.removeListener('paint',paint);reject(Error('Offscreen paint timeout'))},10000)
      const paint=(_event,_rect,image)=>{if(image.isEmpty())return;clearTimeout(timer);contents.removeListener('paint',paint);resolve(image.toPNG().toString('base64'))}
      contents.on('paint',paint);contents.invalidate()
    })
  })
  await fs.writeFile(path.join(output,name),Buffer.from(png,'base64'))
}
async function importFeature(id) {
  await app.evaluate(({ dialog, ipcMain }, files) => {
    let index = 0; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[index++]] })
    if (!global.__qaImportWrapped) {
      global.__qaImportWrapped = true
      const handler = ipcMain._invokeHandlers.get('developer:importPackage')
      ipcMain.removeHandler('developer:importPackage')
      ipcMain.handle('developer:importPackage', async (...args) => { const result = await handler(...args); global.__qaDeveloperState = result; return result })
    }
  }, [path.join(workspace, 'feature-plugin-dist', id + (id.startsWith('studio-') ? '.mmstudio' : '.mmfeature')), projects])
  await page.getByRole('button', { name: 'ModMind开发者工作台', exact: true }).click()
  await page.getByRole('button', { name: '导入功能或工作台', exact: true }).click()
  await page.locator('.developer-file-list').getByRole('button', { name: 'renderer.js', exact: true }).waitFor()
  const state = await app.evaluate(() => global.__qaDeveloperState)
  await page.getByRole('button', { name: '运行预览', exact: true }).click()
  await page.locator('.developer-preview-status').filter({ hasText: '页面已加载' }).waitFor({ timeout: 60000 })
  console.log('Mounted ' + id)
  return { state, frame: page.frameLocator('iframe[title="开发包页面预览"]') }
}
async function leave() { await page.getByRole('button', { name: '返回项目选择', exact: true }).click(); await page.locator('.project-launcher').waitFor() }
try {
  app = await electron.launch({ args: [bootstrap], cwd: workspace, env, timeout: 60000 })
  app.process().stdout?.on('data', c => { processLog += c }); app.process().stderr?.on('data', c => { processLog += c })
  await app.firstWindow()
  for (let i = 0; i < 150; i++) { page = app.windows().find(p => p.url().includes('/renderer/index.html')); if (page) break; await new Promise(r => setTimeout(r, 100)) }
  assert.ok(page)
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => { localStorage.setItem('modmind-ui-mode', 'advanced'); localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, phase: 'experience', fieldIndex: 0, status: 'skipped' })) })
  await page.reload()
  if (await page.getByRole('button', { name: '关闭更新日志' }).isVisible().catch(() => false)) await page.getByRole('button', { name: '关闭更新日志' }).click()
  await page.locator('.project-launcher').waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => { w.webContents.setBackgroundThrottling(false); w.hide() }))
  const originalProject = await page.evaluate(() => window.modmind.project.current())
  if(!sdkOnly){
  {
    const { state, frame } = await importFeature('resource-packs')
    await frame.getByLabel('当前资源包', { exact: true }).waitFor({ timeout: 60000 })
    await frame.locator('summary[aria-label="资源包管理"]').press('Enter')
    await frame.getByRole('button', { name: '新建', exact: true }).press('Enter')
    const form = frame.getByRole('dialog', { name: '新建资源包', exact: true })
    await form.locator('input').first().fill('预览宿主验收')
    await form.getByRole('button', { name: '创建', exact: true }).press('Enter')
    await form.waitFor({ state: 'hidden', timeout: 60000 })
    // Read the real test project rather than accepting the mounted shell as success.
    const profileDirs = await fs.readdir(path.join(state.project.root, '.modmind-dev/test-projects'))
    const testRoot = path.join(state.project.root, '.modmind-dev/test-projects', profileDirs[0])
    const files = []
    async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir,e.name); if(e.isDirectory())await walk(f);else files.push(f) } }
    await walk(testRoot)
    assert.ok(files.some(file => file.endsWith('pack.mcmeta')), JSON.stringify({ files }))
    const mcmeta = await Promise.all(files.filter(file => file.endsWith('pack.mcmeta')).map(file => fs.readFile(file, 'utf8')))
    const readback = await page.evaluate(({ session, root }) => window.modmind.developer.previewInvoke(session, 'feature-plugins:invoke', ['resource-packs','resource-packs:list',{ args: [root] }]), { session: state.project.session, root: testRoot })
    assert.ok(readback.result)
    const denied = await page.evaluate(async ({ session, root }) => { try { await window.modmind.developer.previewInvoke(session, 'feature-plugins:invoke', ['resource-packs','resource-packs:create',{ args: [root,{ name:'readonly-must-not-create',description:'',packFormat:15 }] }],true); return '' } catch(error) { return error.message } }, { session: state.project.session, root: testRoot })
    assert.match(denied,/READ_ONLY/)
    const debugTool = await page.evaluate(session => window.modmind.developer.debug(session, { operation:'tool',name:'modmind_resource_pack',input:{operation:'list'} }), state.project.session)
    assert.ok(debugTool.mcp?.response?.result?.structuredContent)
    await frame.getByRole('button', { name: 'pack.mcmeta', exact: true }).press('Enter')
    await frame.locator('.monaco-editor').waitFor({ timeout: 30000 })
    checks.push({ package: 'resource-packs', created: mcmeta, testRoot })
    for (const darkMode of [false, true]) {
      if (darkMode) { await page.getByRole('button',{name:'预览深色',exact:true}).click(); await page.frames().find(f=>f.url().startsWith('modmind-dev-preview:')).waitForFunction(()=>window.__devDark === true && window.__devReady && !window.__devPending) }
      await page.evaluate(darkMode=>window.modmind.settings.saveAgent({darkMode}),darkMode)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html')).setSize(1080,680))
      await screenshot(`resource-packs-${darkMode ? 'dark' : 'light'}-1080.png`)
    }
    await leave()
  }
  {
    const { state, frame } = await importFeature('image-studio')
    await frame.locator('.image-studio-page').waitFor({ timeout: 60000 })
    const response = await page.evaluate(session => window.modmind.developer.previewInvoke(session, 'feature-plugins:invoke', ['image-studio','image-studio:getSettings',{ args: [] }]), state.project.session)
    assert.ok(response.result && typeof response.result === 'object')
    const persisted=await page.evaluate(async({session,settings})=>{
      const api=window.modmind.developer
      await api.previewInvoke(session,'feature-plugins:invoke',['image-studio','image-studio:saveSettings',{args:[{...settings,model:"offline-qa"}]}])
      const css=await api.read(session,'renderer.css')
      await api.write(session,css.path,css.content+'\n/* preserve preview settings across builds */',css.revision)
      await api.build(session)
      return api.previewInvoke(session,'feature-plugins:invoke',['image-studio','image-studio:getSettings',{args:[]}])
    },{session:state.project.session,settings:response.result})
    assert.equal(persisted.result.model,"offline-qa")
    const selector = page.getByLabel('预览页面', { exact: true })
    await selector.selectOption('settings-image')
    await frame.locator('.image-settings-section').waitFor({ timeout: 60000 })
    await frame.locator('body').evaluate(()=>new Promise(resolve=>{const check=()=>{if(!window.__devPending)return resolve();setTimeout(check,50)};check()}))
    checks.push({ package: 'image-studio', actualSettingsRead: true, settingsPage: true })
    await screenshot('image-studio-settings.png')
    await leave()
  }
  for (const id of ['mappings','studio-mod','studio-modpack','studio-server-plugin']) {
    const { state, frame } = await importFeature(id)
    if (id === 'mappings') await frame.getByPlaceholder('搜索类名或包名').waitFor()
    else await frame.getByText('当前包没有页面，请在调试中检查动作或创建工作台项目。').waitFor()
    if(id==='studio-mod'){
      const marker=await page.evaluate(async session=>{
        const api=window.modmind.developer,main=await api.read(session,'main.cjs'),config=await api.read(session,'manifest.json'),m=JSON.parse(config.content)
        m.actions=[...(m.actions||[]),{id:'qa:modified',handler:'qaModified',permission:'read',projectRequired:false,inputSchema:{type:'object',properties:{},additionalProperties:false}}]
        await api.write(session,'main.cjs',main.content+'\nconst qaActivate=module.exports.activate;module.exports={...module.exports,activate:options=>{const value=qaActivate(options);value.actions={...(value.actions||{}),qaModified:()=>({marker:"edited-builtin-used"})};return value}};\n',main.revision)
        await api.write(session,'manifest.json',JSON.stringify(m),config.revision)
        await api.build(session)
        return api.debug(session,{operation:'action',name:'qa:modified',input:{}})
      },state.project.session)
      assert.equal(marker.result.marker,'edited-builtin-used')
    }
    checks.push({ package: id, mounted: true })
    await leave()
  }
  }
  {
    const agent=await createDeveloperAgent(path.join(output,'agent-fixture'))
    const sdkProjects=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-preview-sdk-'))
    await page.evaluate(executable=>window.modmind.settings.saveAgent({codingBackend:'codex',externalAgents:{codex:{mode:'local',executable,model:'test-model'}}}),agent.executable)
    await app.evaluate(({dialog,ipcMain},root)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})
      const handler=ipcMain._invokeHandlers.get('developer:create');ipcMain.removeHandler('developer:create')
      ipcMain.handle('developer:create',async(...args)=>{const state=await handler(...args);global.__qaCreatedState=state;return state})
    },sdkProjects)
    await page.getByRole('button',{name:'ModMind开发者工作台',exact:true}).click()
    await page.getByRole('button',{name:'新建开发工程',exact:true}).click()
    const form=page.getByRole('dialog',{name:'新建开发工程',exact:true})
    await form.getByLabel('名称',{exact:true}).fill('SDK 与截图回归')
    await form.getByLabel('包 ID',{exact:true}).fill('qa-preview-core')
    await form.getByRole('button',{name:'选择位置并创建',exact:true}).click()
    await form.waitFor({state:'hidden'})
    const state=await app.evaluate(()=>global.__qaCreatedState)
    await page.getByRole('button',{name:'运行预览',exact:true}).click()
    const frame=page.frameLocator('iframe[title="开发包页面预览"]')
    await frame.getByLabel('文稿',{exact:true}).fill('你好')
    await frame.getByRole('button',{name:'检查文本',exact:true}).press('Enter')
    await frame.getByText('2 个字符',{exact:false}).waitFor()
    await page.evaluate(async({session,id})=>window.modmind.developer.runAi(session,id,'验证开发工作台的真实预览、动作调试、截图和导出闭环。','codex'),{session:state.project.session,id:randomUUID()})
    const png=await fs.readFile(path.join(state.project.root,'.modmind-dev/preview.png'))
    assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.length>1000)
    const pixels=await require('sharp')(png).stats()
    assert.ok(pixels.channels.some(channel=>channel.stdev>1),'AI capture contains the actual rendered page, not a blank surface')
    await fs.copyFile(path.join(state.project.root,'.modmind-dev/preview.png'),path.join(output,'sdk-ai-capture.png'))
    checks.push({package:'new-sdk-project',realPreviewAction:true,realAiMcpCapture:true})
    await leave()
    await page.getByRole('button',{name:'ModMind开发者工作台',exact:true}).click()
    await page.getByRole('button',{name:'新建开发工程',exact:true}).click()
    const studioForm=page.getByRole('dialog',{name:'新建开发工程',exact:true})
    await studioForm.getByLabel('包类型',{exact:true}).selectOption('studio')
    await studioForm.getByLabel('名称',{exact:true}).fill('导入工作台回归')
    await studioForm.getByLabel('包 ID',{exact:true}).fill('qa-preview-notes')
    await studioForm.getByRole('button',{name:'选择位置并创建',exact:true}).click()
    await studioForm.waitFor({state:'hidden'})
    const studio=await app.evaluate(()=>global.__qaCreatedState),archive=path.join(output,'qa-preview-notes.mmstudio')
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},archive)
    await page.evaluate(async session=>{await window.modmind.developer.build(session);await window.modmind.developer.export(session)},studio.project.session)
    await leave()
    await app.evaluate(({dialog,ipcMain},files)=>{
      let i=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[files[i++]]})
      if(!global.__qaImportWrapped){const handler=ipcMain._invokeHandlers.get('developer:importPackage');ipcMain.removeHandler('developer:importPackage');ipcMain.handle('developer:importPackage',async(...args)=>{const result=await handler(...args);global.__qaDeveloperState=result;return result})}
    },[archive,sdkProjects])
    await page.getByRole('button',{name:'ModMind开发者工作台',exact:true}).click()
    await page.getByRole('button',{name:'导入功能或工作台',exact:true}).click()
    await page.locator('.developer-file-list').getByRole('button',{name:'renderer.js',exact:true}).waitFor()
    const imported=await app.evaluate(()=>global.__qaDeveloperState)
    const studioResult=await page.evaluate(async session=>{
      const api=window.modmind.developer;await api.build(session)
      const created=await api.debug(session,{operation:'create-studio',input:{name:'兼容测试文稿'}})
      const manifest=(await api.state(session)).manifest
      const checked=await api.debug(session,{operation:'tool',name:manifest.tools[0].name,input:{text:'你好'}})
      return {created,checked}
    },imported.project.session)
    assert.equal(studioResult.created.result.verified,true)
    assert.equal(studioResult.checked.result.characters,2)
    checks.push({package:'imported-studio',createdTestProject:true,scopedMcpAfterCreation:true})
    await leave()
  }
  assert.deepEqual(await page.evaluate(() => window.modmind.project.current()), originalProject)
  assert.ok(!(await page.evaluate(()=>window.modmind.featurePlugins.list())).some(item=>item.id==='resource-packs'||item.id==='image-studio'))
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ checks, errors, originalProject, output },null,2))
  console.log(JSON.stringify({ output, checks }))
} catch (error) {
  if(page) { for(const f of page.frames())await fs.writeFile(path.join(output,'frame-'+page.frames().indexOf(f)+'.txt'),await f.locator('body').innerText().catch(()=>'')); await page.screenshot({path:path.join(output,'failure.png'),timeout:5000}).catch(()=>{}); await fs.writeFile(path.join(output,'failure.txt'),await page.locator('body').innerText().catch(()=>'')) }
  throw error
} finally { await fs.writeFile(path.join(output,'process.log'),processLog); await app?.close() }
