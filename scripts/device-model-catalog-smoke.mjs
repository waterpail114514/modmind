import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(process.env.CATALOG_SMOKE_BUILD || 'out')
const work = path.join(root, 'test-results', 'device-model-catalog-ui', String(Date.now()))
const profile = path.join(work, 'profile')
await fs.mkdir(profile, { recursive: true })
const bootstrap = path.join(work, 'bootstrap.cjs')
const snapshot = { protocolVersion: 2, selectionRevision: 1, defaultAccount: 'ls', connections: [
  { account: 'ls', label: 'LS', kind: 'paid', baseUrl: 'https://relay.catalog-smoke.example', inferenceBaseUrl: 'https://relay.catalog-smoke.example/v1', apiKey: 'fixture-key', group: '100084', model: null, models: ['gpt-6-astra', 'gpt-6.1-sol'], modelsReady: true, modelsUrl: 'https://catalog-smoke.example/api/device/models?account=ls', modelsVersion: 'one', modelsUpdatedAt: null, modelsStale: false },
  { account: 'trial:one', label: '免费套餐', kind: 'free', baseUrl: 'https://catalog-smoke.example/api/trial/v1', inferenceBaseUrl: 'https://catalog-smoke.example/api/trial/v1', apiKey: 'fixture-free', group: null, model: null, models: ['qwen3.8-flash'] }
] }
await fs.writeFile(bootstrap, `const native=require('electron'),{app,BrowserWindow,safeStorage}=native,fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();class TestWindow extends BrowserWindow{constructor(o){super({...o,show:false,webPreferences:{...o.webPreferences,offscreen:true}})}show(){}}
const Module=require('node:module'),load=Module._load;const proxy=new Proxy(native,{get:(t,k)=>k==='BrowserWindow'?TestWindow:Reflect.get(t,k)});Module._load=function(n,...a){return n==='electron'?proxy:load.call(this,n,...a)};
app.setName('ModMind Catalog Protocol Smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});
const fixture=globalThis.catalogSmoke={snapshot:${JSON.stringify(snapshot)},requests:[],unavailable:false,offline:false,stale:false,models:['gpt-6-astra','gpt-6.1-sol','gpt-6-luna'],groupPosts:0};
global.fetch=async(url,init={})=>{const u=new URL(String(url));fixture.requests.push({origin:u.origin,path:u.pathname,query:u.search,method:init.method||'GET',capability:new Headers(init.headers).get('X-ModMind-Sync-Capabilities')});if(u.origin!=='https://catalog-smoke.example')throw Error('Upstream model enumeration forbidden');if(fixture.offline)throw Error('offline');const response=(data,status=200)=>Response.json({success:status===200,data},{status});if(u.pathname==='/api/device/providers')return response(fixture.snapshot);if(u.pathname==='/api/device/session')return response({routingToken:'fixture-routing',routingTokenExpiresAt:new Date(Date.now()+86400000).toISOString()});if(u.pathname==='/api/device/models'){const account=u.searchParams.get('account')||'ls',group=u.searchParams.get('group')||(account==='ls'?'100084':null);if(account==='primary')return Response.json({success:false,code:'MODEL_GROUP_NOT_CONFIGURED'},{status:400});if(fixture.unavailable)return Response.json({success:false,code:'MODEL_CATALOG_NOT_READY'},{status:503,headers:{'Retry-After':'1'}});return response({account,group,type:'chat',models:account.startsWith('trial:')?['qwen3.8-flash']:fixture.models,version:'two',updatedAt:new Date().toISOString(),stale:fixture.stale,source:account.startsWith('trial:')?'server-config':'server-cache'})}if(u.pathname==='/api/device/group'){if(init.method==='POST'){fixture.groupPosts++;throw Error('Catalog refresh must never switch groups')}return response({account:'ls',current:'100084',canSwitch:true,canSwitchProvider:true,providers:[{account:'primary',kind:'paid',label:'旧供应商',groups:[{id:'plus 2组'}]},{account:'ls',kind:'paid',label:'LS',groups:[{id:'100084',label:'当前线路'},{id:'100086',label:'标准线路'}]}]})}if(u.pathname==='/api/device/usage')return response({keyStatus:'ACTIVE',balanceCents:'1000'});if(u.pathname==='/api/device/image-provider')return response({selection:'follow',provider:'ls',available:false,choices:[],model:null});return response({})};
app.whenReady().then(()=>{fs.writeFileSync(path.join(app.getPath('userData'),'device-credentials.json'),JSON.stringify({version:1,siteUrl:'https://catalog-smoke.example',baseUrl:'https://relay.catalog-smoke.example/v1',encryptedApiKey:safeStorage.encryptString('fixture-key').toString('base64'),encryptedConnections:safeStorage.encryptString(JSON.stringify(fixture.snapshot)).toString('base64'),account:'ls',group:'100084',username:'catalog-test',balanceCents:'1000',connectedAt:new Date().toISOString()}));});require(${JSON.stringify(path.join(output, 'main/index.js'))});`)

let app, page
const errors = [], checks = []
try {
  const env = { ...process.env, MODMIND_SITE_URL: 'https://catalog-smoke.example' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap], cwd: root, env })
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(w => w.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Main renderer loaded')
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.setBackgroundThrottling(false)))
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(() => localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, status: 'skipped', phase: 'experience', fieldIndex: 0 })))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.modmind))
  const refresh = () => page.evaluate(() => window.modmind.device.discoverModels())
  const catalog = await refresh()
  assert.equal(catalog.stale, false)
  assert.ok(catalog.models.some(m => m.id === 'gpt-6-astra' && m.account === 'ls'))
  assert.ok(!catalog.providers.some(p => p.account === 'primary'))
  checks.push('Actual IPC reads server catalogs and excludes an unconfigured unrelated group')
  if (!await page.getByRole('checkbox', { name: '专业模式', exact: true }).isChecked()) await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
  const picker = page.locator('.quota-model-picker')
  await picker.waitFor()
  await picker.getByRole('button', { name: '全部', exact: true }).click()
  await picker.locator('[data-model-id="gpt-6-astra"]').waitFor()
  const capture = async name => {
    const data = await app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(w => w.getURL().includes('/renderer/index.html'))
      return (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
    })
    await fs.writeFile(path.join(work, name + '.png'), Buffer.from(data, 'base64'))
  }
  for (const [width, height] of [[1440, 900], [1080, 680]]) {
    await page.setViewportSize({ width, height })
    await picker.scrollIntoViewIfNeeded()
    await capture('settings-' + width)
  }
  await app.evaluate(() => { globalThis.catalogSmoke.models = ['gpt-6-astra', 'new-server-model'] })
  await picker.getByRole('button', { name: '刷新模型与连接', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.quota-model-list[aria-busy="true"]'))
  const updated = await page.evaluate(() => window.modmind.device.getModelCatalog())
  assert.ok(updated.models.some(m => m.id === 'new-server-model'))
  assert.ok(!updated.models.some(m => m.id === 'gpt-6.1-sol'))
  checks.push('Settings refresh replaces the directory including model removals')
  const selected = await page.evaluate(() => window.modmind.device.getAiPreferences())
  await app.evaluate(() => { globalThis.catalogSmoke.unavailable = true })
  await picker.getByRole('button', { name: '刷新模型与连接', exact: true }).click()
  await picker.getByText(/官网模型列表尚未就绪/).waitFor()
  await capture('settings-not-ready')
  assert.deepEqual(await page.evaluate(() => window.modmind.device.getAiPreferences()), selected)
  checks.push('HTTP 503 retains saved preferences and renders a nearby recovery message')
  await app.evaluate(() => { globalThis.catalogSmoke.unavailable = false; globalThis.catalogSmoke.offline = true })
  const saved = await page.evaluate(() => window.modmind.device.getModelCatalog(false, true))
  assert.ok(saved.models.some(m => m.id === 'new-server-model'))
  const requests = await app.evaluate(() => globalThis.catalogSmoke.requests)
  assert.equal(await app.evaluate(() => globalThis.catalogSmoke.groupPosts), 0)
  assert.ok(requests.every(r => r.origin === 'https://catalog-smoke.example'))
  assert.ok(requests.filter(r => r.path === '/api/device/models').every(r => r.method === 'GET' && r.capability === 'provider-ls'))
  assert.deepEqual(errors, [])
  checks.push('Offline cached directory remains readable; no upstream enumeration, group mutations or renderer errors')
  const report = { status: 'passed', work, output, checks, requestCount: requests.length }
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (page) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  console.error(JSON.stringify({ status: 'failed', work, checks, message: error.message }))
  throw error
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app.close().catch(() => undefined) }
}
