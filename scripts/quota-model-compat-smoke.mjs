import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root=path.resolve(import.meta.dirname,'..')
const output=process.env.PROVIDER_SMOKE_BUILD
assert.ok(output,'Set PROVIDER_SMOKE_BUILD to the current isolated application build')
const work=path.join(root,'test-results','quota-model-compat',String(Date.now())),profile=path.join(work,'profile')
await fs.mkdir(profile,{recursive:true})
const account='trial:free-mtjzrt3s-l9afs',models=['deepseek-v4-pro-0813','deepseek-v4.1-flash','glm-5.3','qwen3.8-flash']
const sync={protocolVersion:2,selectionRevision:1,defaultAccount:account,connections:[{account,label:'免费套餐',kind:'free',baseUrl:'https://compat-smoke.example/api/trial/v1',inferenceBaseUrl:'https://compat-smoke.example/api/trial/v1',apiKey:'fixture-free',model:'qwen3.8-flash',models,group:null,node:null}]}
const bootstrap=path.join(work,'bootstrap.cjs')
await fs.writeFile(bootstrap,`const native=require('electron');const {app,BrowserWindow,safeStorage}=native;const fs=require('node:fs');const path=require('node:path');app.disableHardwareAcceleration();class TestWindow extends BrowserWindow{constructor(o){super({...o,show:false,webPreferences:{...o.webPreferences,offscreen:true}})}show(){}}const Module=require('node:module');const load=Module._load;const proxy=new Proxy(native,{get:(t,k)=>k==='BrowserWindow'?TestWindow:Reflect.get(t,k)});Module._load=function(n,...a){return n==='electron'?proxy:load.call(this,n,...a)};app.setName('modmind-compat-smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});const sync=${JSON.stringify(sync)};const fixture=globalThis.compatSmoke={posts:[],recoveries:0};global.fetch=async(url,init={})=>{const u=String(url);if(!u.includes('compat-smoke.example'))throw new Error('Unrelated network blocked');let data={};if(u.endsWith('/api/device/session'))data={routingToken:'fixture-routing',routingTokenExpiresAt:new Date(Date.now()+30*86400000).toISOString()};else if(u.includes('/api/device/providers'))data=sync;else if(u.includes('/api/device/group')){if(init.method==='POST'){fixture.posts.push(JSON.parse(init.body));return new Response(JSON.stringify({success:false,message:'Refresh providers instead',multiProviderSyncRequired:true}),{status:409});}if(u.includes('credentials=1'))fixture.recoveries++;data={account:${JSON.stringify(account)},current:null,keyStatus:'ACTIVE',canSwitch:false,canSwitchProvider:true,providers:[{account:'secondary',kind:'paid',groups:[{id:'Kimi',label:'Kimi'}]},{account:${JSON.stringify(account)},kind:'free',groups:[]}]};}else if(u.endsWith('/models'))return new Response(JSON.stringify({data:${JSON.stringify(models)}.map(id=>({id}))}));return new Response(JSON.stringify({success:true,data}));};app.whenReady().then(()=>{fs.writeFileSync(path.join(app.getPath('userData'),'device-credentials.json'),JSON.stringify({version:1,siteUrl:'https://compat-smoke.example',baseUrl:'https://compat-smoke.example/api/trial/v1',encryptedApiKey:safeStorage.encryptString('fixture-free').toString('base64'),account:${JSON.stringify(account)},group:null,username:'compat-user',balanceCents:'0',connectedAt:new Date().toISOString()}));fs.writeFileSync(path.join(app.getPath('userData'),'beginner-ai-preferences.json'),JSON.stringify({version:3,current:{model:'deepseek-v4.1-flash',reasoningLevel:'auto',fastMode:false},profiles:{}}));});require(${JSON.stringify(path.join(output,'main/index.js'))});`)
let app
try{
  const env={...process.env,MODMIND_SITE_URL:'https://compat-smoke.example'};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  app=await electron.launch({args:[bootstrap,`--user-data-dir=${profile}`],cwd:root,env})
  let page
  for(let i=0;i<100;i++){page=app.windows().find(w=>w.url().includes('/renderer/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100))}
  assert.ok(page);page.setDefaultTimeout(15000)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.webContents.setBackgroundThrottling(false)))
  await page.waitForFunction(()=>Boolean(window.modmind))
  await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'AI 与图像',exact:true}).click()
  const picker=page.locator('.quota-model-picker')
  await picker.getByRole('button',{name:'Kimi',exact:true}).click()
  await picker.getByRole('button',{name:'切换到 Kimi K3',exact:true}).click()
  await picker.getByText('这个供应商尚未同步，请在官网勾选后同步连接').waitFor()
  assert.equal(await picker.getByRole('button',{name:'恢复连接',exact:true}).count(),0)
  const catalog=await page.evaluate(()=>window.modmind.device.getModelCatalog())
  assert.equal(catalog.protocolVersion,2);assert.equal(catalog.recoveryRequired,false)
  assert.ok(!catalog.models.some(m=>m.billing==='quota'))
  const stored=await fs.readFile(path.join(profile,'device-credentials.json'),'utf8')
  assert.ok(JSON.parse(stored).encryptedConnections);assert.ok(!stored.includes('fixture-free'))
  await picker.getByRole('button',{name:'Qwen',exact:true}).click()
  await picker.getByRole('button',{name:'切换到 Qwen 3.8 Flash 免费版',exact:true}).click()
  await picker.getByRole('button',{name:'切换到 Qwen 3.8 Flash 免费版',exact:true}).filter({hasText:'使用中'}).waitFor()
  assert.equal((await page.evaluate(()=>window.modmind.device.getAiPreferences())).model,'qwen3.8-flash')
  const requests=await app.evaluate(()=>globalThis.compatSmoke)
  assert.equal(requests.posts.length,1);assert.equal(requests.recoveries,0)
  const image=await app.evaluate(async({webContents})=>{const c=webContents.getAllWebContents().find(c=>c.getURL().includes('/renderer/index.html'));return(await c.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')})
  await fs.writeFile(path.join(work,'settings-restored-and-switched.png'),Buffer.from(image,'base64'))
  console.log(JSON.stringify({status:'passed',work,checks:['original settings rows','v2-required 409 upgrade','no false recovery loop','immediate free model switch','encrypted snapshot']}))
}finally{await app?.close()}
