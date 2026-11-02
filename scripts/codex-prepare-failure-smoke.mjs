import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const build = path.resolve(process.env.PREPARE_SMOKE_BUILD || path.join(root, 'test-results/codex-prepare/build'))
const work = path.join(root, 'test-results/codex-prepare/ui', String(Date.now()))
const profile = path.join(work, 'profile'), project = path.join(work, 'project')
await mkdir(profile, { recursive: true })
await mkdir(project, { recursive: true })
await writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: '准备失败验证', namespace: 'prepare_qa', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1', path: project, createdAt: new Date().toISOString(), projectVersion: '0.1.0' }))
await writeFile(path.join(profile, 'service-config.json'), '{}')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const native = require('electron'), {app, BrowserWindow, session} = native;
app.disableHardwareAcceleration(); app.setName('modmind-prepare-qa'); app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)});
const qaWindows=new Map();
class QuietWindow extends BrowserWindow { constructor(options) { super({...options, show:false, webPreferences:{...options.webPreferences, offscreen:true}}); const id=this.id; qaWindows.set(id,this); this.once('closed',()=>qaWindows.delete(id)) } static getAllWindows(){ return [...qaWindows.values()].filter(window=>!window.isDestroyed()) } show() {} }
const Module = require('node:module'), load = Module._load;
Module._load = function(name,...args) { const result=load.call(this,name,...args); if(name==='electron')return new Proxy(native,{get:(target,key)=>key==='BrowserWindow'?QuietWindow:Reflect.get(target,key)}); return name==='undici'?new Proxy(result,{get:(target,key)=>key==='fetch'?((...args)=>global.fetch(...args)):Reflect.get(target,key)}):result; };
global.fetch = async () => { throw new Error('Offline preparation QA'); };
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true})));
require(${JSON.stringify(path.join(build, 'main/index.js'))});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let app, page
const errors = [], checks = []
const prompt = '检查项目现状，加入一把闪电剑'
const selection = { backend: 'quota', model: 'qwen3.8-flash', account: 'trial:chosen', billing: 'free', reasoningLevel: 'auto' }
const failure = '无法读取供应商模型列表（网络请求超时），请检查网络后重试'
try {
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain, BrowserWindow }, { selection, failure }) => {
    const qa = globalThis.prepareQa = { failPrepare: true, failTask: false, calls: [] }
    const handle = (channel, callback) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, callback) }
    handle('device:getState', () => ({ status:'connected', configured:true, username:'prepare-qa', siteUrl:'https://fixture.invalid' }))
    handle('device:getAiPreferences', () => ({ model:'gpt-6-astra', account:'default-paid', billing:'quota', reasoningLevel:'high', fastMode:false }))
    handle('device:getModelCatalog', () => ({ models:[{ id:selection.model, name:selection.model, account:selection.account, billing:'free', available:true }], providers:[{account:selection.account,label:'测试免费线路',kind:'free'}], protocolVersion:2, bindings:{workspace:selection}, canSwitch:true, configured:true, checkedAt:Date.now(), stale:false }))
    handle('device:listModels', () => [{id:selection.model}])
    handle('beginner-codex:prepare', (event, projectPath, received) => {
      qa.calls.push({ kind:'prepare', projectPath, selection:received })
      if (qa.failPrepare) {
        event.sender.send('beginner-codex:progress', { stage:'error', title:'开发工具准备失败', detail:failure, status:'error', projectPath })
        throw new Error(failure)
      }
      return {ready:true,version:'fixture',configChanged:false,configSource:'device'}
    })
    handle('ai:createCode', (event, _prompt, sessionId, _backend, _profile, options) => {
      qa.calls.push({kind:'create',selection:options.modelSelection})
      if (qa.failTask) throw new Error('无法读取供应商模型列表（网络连接失败）')
      event.sender.send('ai:output', { kind:'answer', content:'测试任务已完成', sessionId, turnId:'turn-'+sessionId, time:new Date().toISOString(), projectPath:options.projectPath, conversationId:options.conversationId })
      return { summary:'测试任务已完成', finalResponse:'测试任务已完成', tasks:[], files:[], tests:[], warnings:[], intent:'informational' }
    })
    handle('conversations:generateTitle', () => ({title:'准备失败验证',titleSource:'auto'}))
    BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false))
  }, { selection, failure })
  await page.context().addInitScript(selection => {
    localStorage.setItem('modmind-ui-mode', 'advanced')
    localStorage.setItem('modmind-onboarding:v1', JSON.stringify({version:1,status:'done',phase:'experience',fieldIndex:0}))
    localStorage.setItem('modmind-ai-owner', 'https://fixture.invalid:prepare-qa')
    localStorage.setItem('modmind-ai-selection:workspace', JSON.stringify(selection))
  }, selection)
  await page.evaluate(async project => { await window.modmind.settings.saveAgent({codingBackend:'quota'}); await window.modmind.project.openRecent(project) }, project)
  await page.reload()
  const input = page.getByRole('textbox', { name:'发送给 AI 的消息', exact:true })
  await input.waitFor()
  await input.fill(prompt)
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await page.locator('.agent-notice.error').filter({hasText:'任务未能开始'}).waitFor()
  assert.match(await page.locator('.agent-notice.error').innerText(), /网络请求超时/)
  assert.equal(await input.inputValue(), prompt)
  assert.equal(await page.getByRole('button', {name:'发送',exact:true}).isEnabled(), true)
  assert.equal(await page.locator('.agent-error-footer').count(), 1)
  let calls = await app.evaluate(() => globalThis.prepareQa.calls)
  assert.deepEqual(calls.map(call=>call.kind), ['prepare'])
  assert.deepEqual(calls[0].selection, selection)
  checks.push('advanced preparation failure is visible, keeps the message, stops before AI execution, passes the exact selected free route')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080,680))
  await page.screenshot({path:path.join(work,'advanced-light-1080.png')})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  let persisted=false
  for (let attempt=0;attempt<100;attempt++) {
    persisted=await page.evaluate(async project => {
      const list=await window.modmind.conversations.list(project,'workspace')
      if(!list.length)return false
      const document=await window.modmind.conversations.read(project,list[0].id)
      return Boolean(document.view?.timeline?.some(item=>item.kind==='error'&&item.terminal===true))
    },project)
    if(persisted)break
    await page.waitForTimeout(100)
  }
  assert.ok(persisted,'preparation failure is durably stored before reloading')
  await page.reload()
  await page.locator('.agent-notice.error').filter({hasText:'网络请求超时'}).waitFor()
  checks.push('terminal error survives a real window reload through the conversation store; minimum window has no horizontal overflow')
  await app.evaluate(() => { globalThis.prepareQa.failPrepare=false; globalThis.prepareQa.failTask=true })
  await input.fill(prompt)
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await page.locator('.agent-notice.error').filter({hasText:'网络连接失败'}).waitFor()
  checks.push('a later task IPC rejection without an output event is also visible in advanced mode')
  await app.evaluate(() => { globalThis.prepareQa.failTask=false })
  await input.fill(prompt)
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await page.getByText('测试任务已完成',{exact:true}).first().waitFor()
  assert.equal(await page.locator('.agent-error-footer').count(),0)
  calls=await app.evaluate(()=>globalThis.prepareQa.calls)
  assert.deepEqual(calls.filter(call=>call.kind==='create').map(call=>call.selection), [selection,selection])
  checks.push('retry starts the task with the same selected model and clears the failed running state')
  await app.evaluate(() => { globalThis.prepareQa.failPrepare=true })
  await page.evaluate(async () => { const settings=await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({...settings,darkMode:true}) })
  await page.locator('.expert-mode-toggle').click()
  assert.equal(await page.getByRole('checkbox',{name:'专业模式',exact:true}).isChecked(),false)
  const previousErrorCount=await page.locator('.agent-notice.error').count()
  await input.fill(prompt)
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await page.waitForFunction(count=>document.querySelectorAll('.agent-notice.error').length>count,previousErrorCount)
  await page.locator('.agent-notice.error').filter({hasText:'任务未能开始'}).last().waitFor()
  assert.equal(await input.inputValue(),prompt)
  await page.screenshot({path:path.join(work,'beginner-dark-1080.png')})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  checks.push('beginner mode also retains the error and original message in the dark minimum window')
  assert.deepEqual(errors,[])
  const report={work,mode:'real isolated Electron UI, preload and conversation store; mocked provider and AI IPC responses',checks,errors}
  await writeFile(path.join(work,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
} catch (error) {
  await page?.screenshot({path:path.join(work,'failure.png')}).catch(()=>{})
  console.error('QA artifacts:',work)
  throw error
} finally { await app?.close() }
