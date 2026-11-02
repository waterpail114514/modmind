import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const portraitsOnly = process.env.ADAPTIVE_SMOKE_PORTRAITS_ONLY === '1'
const catalogPolishOnly = process.env.ADAPTIVE_SMOKE_CATALOG_POLISH_ONLY === '1'
const websiteSyncOnly = process.env.ADAPTIVE_SMOKE_WEBSITE_SYNC_ONLY === '1'
const independentRoutesOnly = process.env.ADAPTIVE_SMOKE_INDEPENDENT_ROUTES_ONLY === '1'
const output = process.env.ADAPTIVE_SMOKE_BUILD || path.join(root, 'out')
const work = path.join(root, 'test-results/single-provider-models-20261017/ui', String(Date.now()))
const profile = path.join(work, 'profile'), bootstrap = path.join(work, 'bootstrap.cjs')
await fs.mkdir(profile, { recursive: true })
await fs.writeFile(path.join(profile, 'recent-projects.json'), '[]', { flag: 'wx' })
const snapshot = { protocolVersion: 2, selectionRevision: 1, defaultAccount: 'ls', connections: [{ account: 'ls', label: 'LS', kind: 'paid', baseUrl: 'https://ls.adaptive-smoke.example', inferenceBaseUrl: 'https://ls.adaptive-smoke.example/v1', apiKey: 'fixture-ls-key', model: null, group: '25', node: 'default' }] }
if (portraitsOnly || catalogPolishOnly || websiteSyncOnly || independentRoutesOnly) snapshot.connections.push({ account: 'trial:one', label: '免费套餐', kind: 'free', baseUrl: 'https://adaptive-smoke.example/api/trial/v1', inferenceBaseUrl: 'https://adaptive-smoke.example/api/trial/v1', apiKey: 'fixture-free-key', model: null, models: ['gpt-6.1-sol', 'deepseek-v4.1-flash'], group: null, node: null })
await fs.writeFile(bootstrap, `const native=require('electron'),{app,BrowserWindow,safeStorage}=native,fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();const smokeWindows=new Map();class TestWindow extends BrowserWindow{constructor(o){super({...o,show:false,webPreferences:{...o.webPreferences,offscreen:true}});const smokeId=this.id;smokeWindows.set(smokeId,this);this.once('closed',()=>smokeWindows.delete(smokeId))}static getAllWindows(){return [...smokeWindows.values()].filter(window=>!window.isDestroyed())}show(){}}const Module=require('node:module'),load=Module._load,proxy=new Proxy(native,{get:(t,k)=>k==='BrowserWindow'?TestWindow:Reflect.get(t,k)});Module._load=function(n,...a){if(n==='electron')return proxy;const loaded=load.call(this,n,...a);return n==='undici'?new Proxy(loaded,{get:(target,key)=>key==='fetch'?((...args)=>global.fetch(...args)):Reflect.get(target,key)}):loaded};app.setName('modmind-single-provider-smoke');app.setPath('userData',${JSON.stringify(profile)});fs.mkdirSync(${JSON.stringify(path.join(profile, 'documents'))},{recursive:true});app.setPath('documents',${JSON.stringify(path.join(profile, 'documents'))});app.setAppPath(${JSON.stringify(root)});
const fixture=globalThis.adaptiveSmoke={snapshot:${JSON.stringify(snapshot)},offline:false,failGroup:null,groupDelayMs:120,requests:[],modelsByGroup:{'ls:25':['gpt-6.1-sol','gpt-6-astra','gpt-6-luna','gpt-5.6-terra'],'ls:74':['gpt-6.1-sol','gpt-6-astra','gpt-6-luna','line-only-model'],'ls:75':['gpt-6-luna'],'secondary:90':['gpt-6.1-sol','gpt-6-astra'],'secondary:91':['gpt-6.1-sol','provider-two-model']},providers:[{account:'ls',label:'LS',kind:'paid',groups:[{id:'25',label:'GPT 不降智分组 a'},{id:'74',label:'GPT 高速，稳定性强'},{id:'75',label:'GPT 官方API，效率非常高'}]},{account:'secondary',label:'供应商 2',kind:'paid',groups:[{id:'90',label:'标准组'},{id:'91',label:'补充分组'}]}]};const serverStatePath=path.join(app.getPath('userData'),'..','mock-server-state.json');if(fs.existsSync(serverStatePath))fixture.snapshot=JSON.parse(fs.readFileSync(serverStatePath,'utf8'));
global.fetch=async(url,init={})=>{const u=String(url),body=init.body?JSON.parse(String(init.body)):undefined,paid=fixture.snapshot.connections.find(c=>c.kind==='paid');fixture.requests.push({url:u,method:init.method||'GET',paidAccount:paid?.account,paidGroup:paid?.group,...(body?{body}:{})});if(!u.includes('adaptive-smoke.example'))throw new Error('Unrelated network blocked');if(fixture.offline)throw new Error('offline');let data={};if(u.endsWith('/api/device/session'))data={routingToken:'fixture-routing-token',routingTokenExpiresAt:new Date(Date.now()+30*86400000).toISOString()};else if(u.includes('/api/device/providers'))data=fixture.snapshot;else if(u.includes('/api/device/group')){if(init.method==='POST'){if(body.expectedAccount&&body.expectedAccount!==paid.account)return new Response('{}',{status:409});if(body.expectedGroup&&body.expectedGroup!==paid.group)return new Response('{}',{status:409});const target=fixture.providers.find(p=>p.account===(body.account||paid.account));if(!target||!target.groups.some(g=>g.id===body.group))return new Response(JSON.stringify({success:false}),{status:409});if(fixture.groupDelayMs)await new Promise(resolve=>setTimeout(resolve,fixture.groupDelayMs));if(target.account!==paid.account)Object.assign(paid,{account:target.account,label:target.label,baseUrl:target.account==='ls'?'https://ls.adaptive-smoke.example':'https://secondary.adaptive-smoke.example',inferenceBaseUrl:target.account==='ls'?'https://ls.adaptive-smoke.example/v1':'https://secondary.adaptive-smoke.example'});paid.group=body.group;paid.apiKey='fixture-'+paid.account+'-'+paid.group+'-key';delete paid.models;fixture.snapshot.defaultAccount=paid.account;fixture.snapshot.selectionRevision++;}data={account:paid.account,current:paid.group,canSwitch:true,canSwitchProvider:true,providers:fixture.providers};}else if(u.endsWith('/models')){const key=new Headers(init.headers).get('Authorization')?.replace('Bearer ','');const c=fixture.snapshot.connections.find(c=>c.apiKey===key);if(c?.kind==='paid'&&fixture.failGroup===c.group)return new Response('temporarily unavailable',{status:503});return new Response(JSON.stringify({data:(c?(c.kind==='free'?c.models||[]:fixture.modelsByGroup[c.account+':'+c.group]||[]):[]).map(id=>({id}))}));}else if(u.endsWith('/api/device/usage'))data={keyStatus:'ACTIVE',balanceCents:'1000',usedQuota:'0',remainQuota:'1000',billedCentsTotal:'0',lastSeenUsedQuota:'0',checkedAt:new Date().toISOString()};else if(u.endsWith('/api/device/image-provider'))data={selection:'follow',provider:paid.account,available:false,choices:[],model:null};return new Response(JSON.stringify({success:true,data}));};
fixture.readStored=()=>{const raw=fs.readFileSync(path.join(app.getPath('userData'),'device-credentials.json'),'utf8'),outer=JSON.parse(raw);return {raw,sync:JSON.parse(safeStorage.decryptString(Buffer.from(outer.encryptedConnections,'base64')))}};app.whenReady().then(()=>{const target=path.join(app.getPath('userData'),'device-credentials.json');if(!fs.existsSync(target))fs.writeFileSync(target,JSON.stringify({version:1,siteUrl:'https://adaptive-smoke.example',baseUrl:'https://ls.adaptive-smoke.example/v1',encryptedApiKey:safeStorage.encryptString('fixture-ls-key').toString('base64'),encryptedConnections:safeStorage.encryptString(JSON.stringify(fixture.snapshot)).toString('base64'),account:'ls',group:'25',username:'adaptive-test',balanceCents:'1000',connectedAt:new Date().toISOString()}));});require(${JSON.stringify(path.join(output, 'main/index.js'))});`)

await fs.appendFile(bootstrap, `
globalThis.smokeCredentialReadFailures=[];const originalCredentialRead=fs.promises.readFile.bind(fs.promises);fs.promises.readFile=async function(target,...args){try{return await originalCredentialRead(target,...args)}catch(error){if(String(target).endsWith('device-credentials.json'))globalThis.smokeCredentialReadFailures.push({code:error.code,name:error.name});throw error}};
globalThis.smokeCredentialReplacementChecks=[];const originalCredentialRename=fs.promises.rename.bind(fs.promises);let credentialRenameRecovery=false;fs.promises.rename=async function(from,to){if(String(to).endsWith('device-credentials.json')){if(globalThis.smokeFailNextCredentialRename){globalThis.smokeFailNextCredentialRename=false;credentialRenameRecovery=true;globalThis.smokeCredentialReplacementChecks.push({phase:'locked',previousExists:fs.existsSync(to)});throw Object.assign(new Error('injected transient credential lock'),{code:'EPERM'})}if(credentialRenameRecovery){credentialRenameRecovery=false;globalThis.smokeCredentialReplacementChecks.push({phase:'retry',previousExists:fs.existsSync(to)});if(!fs.existsSync(to))throw new Error('Original credential file disappeared during replacement')}}return originalCredentialRename(from,to)};
`)
let app, page
if (websiteSyncOnly) await fs.appendFile(bootstrap, `
fixture.catalogReads=0;const originalHandle=native.ipcMain.handle.bind(native.ipcMain);native.ipcMain.handle=(channel,listener)=>originalHandle(channel,channel==='device:getModelCatalog'?((...args)=>{fixture.catalogReads++;return listener(...args)}):listener);
fixture.webSyncCases={};fixture.usedWebCodes=new Set();const beforeWebPoll=global.fetch;global.fetch=async(url,init={})=>{if(!String(url).endsWith('/api/device/poll'))return beforeWebPoll(url,init);const code=JSON.parse(init.body).code,headers=new Headers(init.headers);fixture.requests.push({url:String(url),method:init.method||'GET',code,syncVersion:headers.get('X-ModMind-Sync-Version'),capabilities:headers.get('X-ModMind-Sync-Capabilities')});if(fixture.usedWebCodes.has(code))return new Response(JSON.stringify({success:true,data:{status:'expired'}}));fixture.usedWebCodes.add(code);const item=fixture.webSyncCases[code];if(!item)throw new Error('Unknown test sync code');const next=structuredClone(item.snapshot||fixture.snapshot);if(next.selectionRevision>=fixture.snapshot.selectionRevision)fixture.snapshot=structuredClone(next);return new Response(JSON.stringify({success:true,data:{...next,status:'ok',username:item.username||'adaptive-test',balanceCents:'1000'}}))};
`)
const checks = [], captures = [], errors = [], motion = [], portraitGeometry = []
const record = value => { checks.push(value); console.log('PASS ' + value) }
const modelCatalogIdentity = model => JSON.stringify([model.id, model.account, model.group ?? null, model.billing])
const env = { ...process.env, MODMIND_SITE_URL: 'https://adaptive-smoke.example' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const launch = async () => {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  for (let attempt = 0; attempt < 100; attempt++) { page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(page, 'Renderer available'); page.setDefaultTimeout(20000)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)))
  await page.waitForFunction(() => Boolean(window.modmind))
}
const capture = async name => {
  let data
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await app.evaluate(async ({ webContents }) => { const target = webContents.getAllWebContents().find(target => target.getURL().includes('/renderer/index.html')); return (await target.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64') }); break
    } catch (error) {
      if (!/UnknownVizError/.test(error.message) || attempt === 2) throw error
      await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(target => target.getURL().includes('/renderer/index.html'))?.invalidate())
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  await fs.writeFile(path.join(work, name + '.png'), Buffer.from(data, 'base64')); captures.push(name + '.png')
}
const catalog = () => page.evaluate(() => window.modmind.device.getModelCatalog())
const stored = () => app.evaluate(() => globalThis.adaptiveSmoke.readStored())
const requests = () => app.evaluate(() => globalThis.adaptiveSmoke.requests)
const groupPosts = async () => (await requests()).filter(request => request.method === 'POST' && request.url.includes('/api/device/group'))
const panel = () => page.getByRole('dialog', { name: '模型与思考强度' })
const open = async (surface = '工作台') => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: surface, exact: true }).click()
  const local = surface === '灵感台' ? page.locator('.inspiration-page:not([hidden])') : page.locator('.agent-workbench')
  await local.getByRole('button', { name: /模型与思考强度：/ }).click(); await panel().waitFor()
  await panel().getByRole('button', { name: '全部', exact: true }).click()
}
const expand = async (id = 'gpt-6.1-sol') => {
  const row = panel().locator(`[data-model-id="${id}"]`)
  await row.waitFor(); const trigger = row.getByRole('button', { name: /选择 .* 的线路/ })
  if (await trigger.count() && await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  return row
}
const bound = (surface, account, group) => page.waitForFunction(async expected => { const binding = (await window.modmind.device.getModelCatalog()).bindings?.[expected.surface]; return binding?.account === expected.account && binding?.group === expected.group }, { surface, account, group })
const waitBounds = () => page.waitForFunction(() => { const bounds = document.querySelector('.composer-ai-panel')?.getBoundingClientRect(); return bounds && bounds.x >= 8 && bounds.y >= 8 && bounds.right <= innerWidth - 7 && bounds.bottom <= innerHeight - 7 })
const assertNoProviderMenu = async target => {
  assert.equal(await target.getByRole('button', { name: /选择供应商：/ }).count(), 0, 'all suppliers share the model list without an extra supplier selector')
  assert.equal(await target.locator('.model-provider-picker, .model-provider-menu, .model-provider-options').count(), 0)
  assert.ok(!/(^|\s)额度(\s|$)/.test(await target.innerText()), 'paid routes do not add a quota badge')
}
const assertFreeBadge = async (target, expectedText) => {
  assert.ok(await target.locator('.model-catalog-free').count(), 'free routes have a visible badge')
  const colors = await target.locator('.model-catalog-free').evaluateAll(badges => badges.map(badge => {
    const reference = document.createElement('span'); reference.style.color = 'var(--theme-accent)'; badge.parentElement.append(reference)
    const accent = getComputedStyle(reference).color; reference.remove()
    return { text: badge.textContent, color: getComputedStyle(badge).color, tag: badge.tagName, accent }
  }))
  for (const badge of colors) {
    assert.equal(badge.text?.trim(), expectedText ?? (badge.tag === 'SUP' ? '免' : '免费'))
    assert.equal(badge.color, badge.accent, 'free marks retain the existing theme accent')
  }
}
const checkFamilyMotion = async picker => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const waitPortrait = family => page.waitForFunction(family => {
    const element = document.querySelector('.quota-model-character'), layers = element?.querySelectorAll('.quota-model-character-layer')
    return element?.dataset.family === family && layers?.length === 1 && layers[0].dataset.family === family && [...layers[0].querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0) && getComputedStyle(layers[0]).opacity === '1'
  }, family)
  await picker.getByRole('button', { name: '推荐', exact: true }).focus(); await page.keyboard.press('Enter'); await waitPortrait('推荐')
  const recommendedSrc = await picker.locator('.quota-model-character-sharp').getAttribute('src')
  assert.equal(await picker.locator('.quota-model-character-note').count(), 0)
  assert.ok(!(await picker.innerText()).includes('暂定，不代表最终效果'))
  await page.evaluate(() => {
    window.unifiedMotionListener = event => {
      if (event.target.matches('.quota-model-character-layer, .quota-model-rows, .quota-model-family-indicator')) for (const animation of event.target.getAnimations()) { animation.pause(); animation.currentTime = 70 }
    }
    document.addEventListener('transitionrun', window.unifiedMotionListener)
  })
  const sample = async family => {
    await page.waitForFunction(family => document.querySelector(`.quota-model-character-layer[data-family="${family}"]`)?.getAnimations().some(animation => animation.playState === 'paused'), family)
    return picker.evaluate(element => ({
      family: element.querySelector('.quota-model-character')?.dataset.family,
      animated: element.querySelector('.quota-model-character')?.dataset.animated,
      layers: [...element.querySelectorAll('.quota-model-character-layer')].map(layer => { const image = layer.querySelector('.quota-model-character-sharp'); return { family: layer.dataset.family, x: new DOMMatrixReadOnly(getComputedStyle(layer).transform).m41, opacity: Number(getComputedStyle(layer).opacity), durations: layer.getAnimations().map(animation => animation.effect.getTiming().duration), fullArt: layer.dataset.fullArt, imageBottom: image.offsetTop + image.offsetHeight, capacity: layer.clientHeight, mask: getComputedStyle(layer).maskImage } }),
      listX: new DOMMatrixReadOnly(getComputedStyle(element.querySelector('.quota-model-rows')).transform).m41,
      listDurations: element.querySelector('.quota-model-rows').getAnimations().map(animation => animation.effect.getTiming().duration),
      indicatorDurations: element.querySelector('.quota-model-family-indicator').getAnimations().map(animation => animation.effect.getTiming().duration),
      noOverflow: document.documentElement.scrollWidth <= innerWidth + 1
    }))
  }
  const resume = () => page.evaluate(() => {
    document.removeEventListener('transitionrun', window.unifiedMotionListener)
    document.querySelectorAll('.quota-model-character-layer, .quota-model-rows, .quota-model-family-indicator').forEach(layer => layer.getAnimations().forEach(animation => animation.play()))
  })
  await picker.getByRole('button', { name: 'GPT', exact: true }).click()
  const forward = await sample('GPT'); motion.push({ phase: 'forward-70ms', ...forward })
  await capture('family-motion-forward-70ms')
  assert.equal(forward.animated, 'true')
  assert.equal(forward.layers.length, 2)
  assert.ok(forward.layers.every(layer => layer.opacity > 0 && layer.opacity < 1 && layer.durations.includes(400)), 'actual portraits crossfade over 400ms')
  assert.ok(forward.layers.find(layer => layer.family === '推荐').x < 0 && forward.layers.find(layer => layer.family === 'GPT').x > 0, 'actual outgoing/incoming portraits move in opposite forward directions')
  assert.ok(forward.listX > 0 && forward.listDurations.includes(320), 'actual model list moves horizontally for 320ms')
  assert.ok(forward.indicatorDurations.includes(320), 'actual family highlight transitions for 320ms')
  for (const layer of forward.layers) {
    assert.equal(layer.fullArt, String(layer.imageBottom <= layer.capacity))
    assert.equal(layer.mask === 'none', layer.imageBottom <= layer.capacity, 'each transitioning portrait independently applies only its necessary bottom mask')
  }
  assert.ok(forward.noOverflow)
  await resume(); await waitPortrait('GPT')
  await page.evaluate(() => document.addEventListener('transitionrun', window.unifiedMotionListener))
  await picker.getByRole('button', { name: '推荐', exact: true }).click()
  const reverse = await sample('推荐'); motion.push({ phase: 'reverse-70ms', ...reverse })
  await capture('family-motion-reverse-70ms')
  assert.ok(reverse.layers.find(layer => layer.family === 'GPT').x > 0 && reverse.layers.find(layer => layer.family === '推荐').x < 0, 'backward pointer selection reverses actual portrait positions')
  assert.ok(reverse.listX < 0)
  for (const layer of reverse.layers) {
    assert.equal(layer.fullArt, String(layer.imageBottom <= layer.capacity))
    assert.equal(layer.mask === 'none', layer.imageBottom <= layer.capacity)
  }
  await resume(); await waitPortrait('推荐')
  // Real pointer clicks interrupt an unfinished transition and retain the newest family.
  for (const family of ['GPT', 'DeepSeek', 'GPT', '全部']) await picker.getByRole('button', { name: family, exact: true }).click({ noWaitAfter: true })
  await waitPortrait('全部')
  assert.equal(await picker.locator('.quota-model-character-sharp').getAttribute('src'), recommendedSrc, 'all models shares the recommended ModMind portrait')
  assert.equal(await picker.locator('.quota-model-character-note').count(), 0)
  await capture('family-motion-interrupted-all-models')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await picker.getByRole('button', { name: 'GPT', exact: true }).click(); await waitPortrait('GPT')
  assert.ok(await picker.locator('.quota-model-character-layer').evaluate(element => getComputedStyle(element).transform === 'none' && getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) <= 0.1)), 'system reduced motion removes translation and shortens transitions')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await picker.getByRole('button', { name: '推荐', exact: true }).focus(); await page.keyboard.press('Enter'); await waitPortrait('推荐')
  assert.equal(await picker.locator('.quota-model-character-layer').evaluate(element => element.getAnimations().length), 0)
  await fs.writeFile(path.join(work, 'motion.json'), JSON.stringify(motion, null, 2))
  record('actual pointer family switches move both portraits and the model list, crossfade at400ms, reverse/interruption work, all/recommended share art, and reduced motion is respected')
}
const measurePortrait = async (picker, phase) => {
  await page.waitForFunction(() => {
    const root = document.querySelector('.quota-model-picker'), rows = root?.querySelector('.quota-model-rows'), frame = root?.querySelector('.quota-model-character')
    if (!rows || !frame) return false
    const visible = [...rows.querySelectorAll('.model-catalog-item, .model-catalog-more > summary')].filter(element => element.tagName === 'SUMMARY' || !element.closest('details:not([open])')).map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
    const expected = Math.max(560, Math.ceil(Math.max(...visible.map(rect => rect.bottom)) - rows.getBoundingClientRect().top) + 16)
    const layers = [...frame.querySelectorAll('.quota-model-character-layer')]
    return Math.abs(frame.getBoundingClientRect().height - expected) <= 1 && layers.length === 1 && layers.every(layer => { const image = layer.querySelector('.quota-model-character-sharp'); return layer.dataset.family === frame.dataset.family && layer.dataset.active === 'true' && image?.naturalWidth > 0 && layer.dataset.fullArt === String(image.offsetTop + image.offsetHeight <= layer.clientHeight) })
  })
  const geometry = await picker.evaluate(element => {
    const rows = element.querySelector('.quota-model-rows'), frame = element.querySelector('.quota-model-character'), image = frame.querySelector('.quota-model-character-sharp')
    const visible = [...rows.querySelectorAll('.model-catalog-item, .model-catalog-more > summary')].filter(element => element.tagName === 'SUMMARY' || !element.closest('details:not([open])')).map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
    return { rows: rows.querySelectorAll('.model-catalog-item').length, height: frame.getBoundingClientRect().height, expected: Math.max(560, Math.ceil(Math.max(...visible.map(rect => rect.bottom)) - rows.getBoundingClientRect().top) + 16), width: frame.getBoundingClientRect().width, imageWidth: image.getBoundingClientRect().width, imageHeight: image.getBoundingClientRect().height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, mask: getComputedStyle(frame).maskImage, layers: [...frame.querySelectorAll('.quota-model-character-layer')].map(layer => { const sharp = layer.querySelector('.quota-model-character-sharp'); return { family: layer.dataset.family, active: layer.dataset.active, fullArt: layer.dataset.fullArt, imageBottom: sharp.offsetTop + sharp.offsetHeight, capacity: layer.clientHeight, mask: getComputedStyle(layer).maskImage, imageMasks: [...layer.querySelectorAll('img')].map(image => getComputedStyle(image).maskImage) } }), overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  assert.equal(geometry.imageWidth, 400, 'portrait images retain their fixed width instead of stretching to the frame')
  assert.ok(Math.abs(geometry.imageHeight / geometry.imageWidth - geometry.naturalHeight / geometry.naturalWidth) < 0.001)
  assert.ok(geometry.mask.includes('to right') && (geometry.mask.match(/linear-gradient/g) ?? []).length === 1, 'portrait frame fades only its horizontal edges')
  for (const layer of geometry.layers) {
    const full = layer.imageBottom <= layer.capacity
    assert.equal(layer.fullArt, String(full))
    if (full) assert.equal(layer.mask, 'none', 'fully visible art has no bottom masking')
    else assert.ok(layer.mask.includes('linear-gradient') && layer.mask.includes('rgba(0, 0, 0, 0)'), 'only cropped art fades at the bottom')
    assert.ok(layer.imageMasks.every(mask => mask.includes('to right') && (mask.match(/linear-gradient/g) ?? []).length === 1), 'neither image copy has a permanent bottom fade')
  }
  assert.equal(geometry.overflow, false)
  portraitGeometry.push({ phase, ...geometry })
  return geometry
}
const checkPortraitGeometry = async picker => {
  await app.evaluate(() => { const fixture = globalThis.adaptiveSmoke, connection = fixture.snapshot.connections.find(connection => connection.account === 'trial:one'); connection.models = [...new Set([...connection.models, 'glm-5.3', 'glm-5.3-flash'])]; fixture.snapshot.selectionRevision++ })
  await page.evaluate(() => window.modmind.device.refreshConnections())
  await picker.getByRole('button', { name: 'GLM', exact: true }).waitFor()
  for (const [family, count] of [['GLM', 2], ['DeepSeek', 1]]) {
    await picker.getByRole('button', { name: family, exact: true }).focus(); await page.keyboard.press('Enter')
    for (const [width, height] of [[1440, 1100], [1080, 900], [1080, 680]]) {
      await page.setViewportSize({ width, height }); const short = await measurePortrait(picker, `short-${family}-${width}x${height}`)
      assert.equal(short.rows, count); assert.ok(Math.abs(short.height - 560) <= 1, 'short lists preserve a portrait frame longer than the former520px frame')
      await page.evaluate(() => { const picker = document.querySelector('.quota-model-picker'); for (let element = picker.parentElement; element; element = element.parentElement) if (element.scrollTop) element.scrollTop = 0 })
      await capture(`portrait-short-${family.toLowerCase()}-${width}x${height}`)
    }
  }
  // Exercise the real resize observer immediately around the active image's natural bottom.
  const boundary = await picker.evaluate(element => { const list = element.querySelector('.quota-model-list'), layer = element.querySelector('.quota-model-character-layer[data-active="true"]'), image = layer.querySelector('.quota-model-character-sharp'); return { saved: list.style.getPropertyValue('--character-frame-height'), bottom: image.offsetTop + image.offsetHeight } })
  for (const [offset, full] of [[0, false], [1, true]]) {
    await picker.locator('.quota-model-list').evaluate((element, height) => element.style.setProperty('--character-frame-height', `${height}px`), boundary.bottom + offset)
    await page.waitForFunction(full => { const layer = document.querySelector('.quota-model-character-layer[data-active="true"]'), image = layer?.querySelector('.quota-model-character-sharp'); return image?.naturalWidth > 0 && layer.dataset.fullArt === String(full) && (getComputedStyle(layer).maskImage === 'none') === full }, full)
    portraitGeometry.push(await picker.evaluate((element, phase) => { const layer = element.querySelector('.quota-model-character-layer[data-active="true"]'), image = layer.querySelector('.quota-model-character-sharp'); return { phase, family: layer.dataset.family, imageBottom: image.offsetTop + image.offsetHeight, capacity: layer.clientHeight, fullArt: layer.dataset.fullArt, mask: getComputedStyle(layer).maskImage } }, `natural-bottom-boundary-${full ? 'complete' : 'cropped'}`))
  }
  await picker.locator('.quota-model-list').evaluate((element, saved) => element.style.setProperty('--character-frame-height', saved), boundary.saved)
  await measurePortrait(picker, 'short-restored-after-boundary')
  await app.evaluate(() => {
    const fixture = globalThis.adaptiveSmoke, connection = fixture.snapshot.connections.find(connection => connection.account === 'trial:one')
    connection.models = [...new Set([...connection.models, 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'])]; fixture.snapshot.selectionRevision++
  })
  await page.evaluate(() => window.modmind.device.refreshConnections())
  await picker.getByRole('button', { name: 'GPT', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.quota-model-picker [data-model-id]').length >= 10)
  const supplementary = picker.locator('.model-catalog-more')
  if (await supplementary.count() && await supplementary.getAttribute('open') === null) await supplementary.locator(':scope > summary').click()
  for (const [width, height] of [[1440, 900], [1080, 680]]) {
    await page.setViewportSize({ width, height }); const closed = await measurePortrait(picker, `long-closed-${width}`)
    assert.ok(closed.height > 650, 'long lists reveal lower portrait content instead of retaining the old fixed-height crop')
    assert.ok(closed.layers.every(layer => layer.fullArt === 'true' && layer.mask === 'none'), 'long-list art is completely shown without bottom masking')
    const trigger = picker.locator('[data-model-id="gpt-6.1-sol"]').getByRole('button', { name: /选择 .* 的线路/ })
    await trigger.click(); const expanded = await measurePortrait(picker, `long-expanded-${width}`)
    assert.ok(expanded.height > closed.height, 'opening model routes extends the portrait frame with the actual content')
    await capture(`portrait-long-expanded-${width}`)
    await trigger.click(); await measurePortrait(picker, `long-recollapsed-${width}`)
  }
  const search = picker.getByRole('searchbox', { name: '搜索模型', exact: true })
  for (const [query, count] of [['gpt-6.1-sol', 1], ['nothing-matches-the-catalog', 0]]) {
    await search.fill(query)
    await page.waitForFunction(expected => {
      const picker = document.querySelector('.quota-model-picker'), list = picker.querySelector('.quota-model-list')
      return picker.querySelectorAll('.model-catalog-item').length === expected && !picker.querySelector('.quota-model-character') && getComputedStyle(list).minHeight === '300px' && list.getBoundingClientRect().height <= 301
    }, count)
    portraitGeometry.push({ phase: `search-${count ? 'single' : 'empty'}`, rows: count, height: await picker.locator('.quota-model-list').evaluate(element => element.getBoundingClientRect().height), portraitHidden: true })
    await capture(`portrait-long-to-search-${count ? 'single' : 'empty'}`)
  }
  await search.fill(''); await measurePortrait(picker, 'long-restored-after-search')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await picker.getByRole('button', { name: '全部', exact: true }).focus(); await page.keyboard.press('Enter')
  const complete = await measurePortrait(picker, 'natural-complete-modmind')
  assert.ok(complete.layers.every(layer => layer.fullArt === 'true' && layer.mask === 'none'))
  await page.evaluate(() => { const picker = document.querySelector('.quota-model-picker'); for (let element = picker.parentElement; element; element = element.parentElement) if (element.scrollTop) element.scrollTop = 0 })
  await capture('portrait-complete-modmind-1440x1100')
  await fs.writeFile(path.join(work, 'portrait-geometry.json'), JSON.stringify(portraitGeometry, null, 2))
  record('GLM/DeepSeek short lists retain560px portraits, searches remain300px, actual natural-bottom boundaries control per-layer fades, complete art has no bottom mask, and long-list/expanded-route heights preserve the original image ratio')
}

try {
  await launch()
  await page.evaluate(() => { localStorage.setItem('modmind-onboarding:v1', JSON.stringify({ version: 1, status: 'skipped', phase: 'experience', fieldIndex: 0 })); localStorage.setItem('modmind-appearance:v1', JSON.stringify({ darkMode: false, themePreset: 'modmind' })) })
  await page.waitForFunction(async () => (await window.modmind.device.getModelCatalog()).canSwitch)
  assert.equal((await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'ls', group: '25', billing: 'quota', scope: 'settings' }))).status, 'ok')
  const project = await page.evaluate(() => window.modmind.project.createDraft('设计一个经验水晶模组'))
  await fs.writeFile(path.join(project.path, 'modmind.project.json'), JSON.stringify({ ...project, draft: false }))
  await page.evaluate(projectPath => window.modmind.project.recordDraftMessage('经验水晶', projectPath), project.path)
  await page.reload(); await page.waitForFunction(() => Boolean(window.modmind))
  if (!await page.getByRole('checkbox', { name: '专业模式', exact: true }).isChecked()) await page.locator('.expert-mode-toggle').click()
  if (independentRoutesOnly) {
    await app.evaluate(() => {
      const fixture = globalThis.adaptiveSmoke
      fixture.snapshot.connections.find(connection => connection.kind === 'free').models.push('gpt-6-astra')
      fixture.snapshot.connections.push({ account: 'trial:two', label: '备用免费套餐', kind: 'free', baseUrl: 'https://second.adaptive-smoke.example/v1', inferenceBaseUrl: 'https://second.adaptive-smoke.example/v1', apiKey: 'fixture-second-free-key', model: null, models: ['gpt-6.1-sol', 'gpt-6-astra'], group: null, node: null })
      fixture.snapshot.selectionRevision++
    })
    await page.evaluate(() => window.modmind.device.discoverModels())
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const categories = page.getByRole('navigation', { name: '设置分类' })
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    const picker = page.locator('.quota-model-picker')
    await picker.getByRole('button', { name: 'GPT', exact: true }).click()
    const row = id => picker.locator(`[data-model-id="${id}"]`)
    const preferred = id => row(id).locator('.model-catalog-model-row').getAttribute('data-option-key')
    const settingsRoute = async (id, name) => {
      const trigger = row(id).getByRole('button', { name: /选择 .* 的线路/ })
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
      await row(id).getByRole('button', { name, exact: true }).click()
    }
    const current = (model, account, group) => page.waitForFunction(async expected => {
      const catalog = await window.modmind.device.getModelCatalog()
      const route = catalog.models.find(entry => entry.optionKey === catalog.currentOptionKey)
      const picker = document.querySelector('.quota-model-picker')
      const row = [...picker?.querySelectorAll('.model-catalog-item') ?? []].find(entry => entry.dataset.modelId === expected.model)
      return catalog.currentModel === expected.model && route?.account === expected.account && route?.group === expected.group
        && row?.querySelector('.model-catalog-model-row')?.dataset.optionKey === catalog.currentOptionKey
        && picker?.querySelector('[aria-label="刷新模型与连接"]')?.disabled === false
    }, { model, account, group })
    await row('gpt-6-astra').waitFor()
    const originalA = await preferred('gpt-6.1-sol'), originalC = await preferred('gpt-6-luna')
    const beforePreparation = await stored(), postsBeforePreparation = (await groupPosts()).length
    await settingsRoute('gpt-6-astra', '使用 GPT-6 Astra · 供应商 2 · 标准组')
    assert.deepEqual((await stored()).sync, beforePreparation.sync, 'inactive line preparation never changes credentials, defaults or bindings')
    assert.equal((await groupPosts()).length, postsBeforePreparation)
    assert.equal((await catalog()).currentModel, 'gpt-6.1-sol')
    const preparedB = await preferred('gpt-6-astra')
    assert.notEqual(preparedB, originalA)
    assert.ok(preparedB.includes('secondary'))
    assert.equal(await preferred('gpt-6-luna'), originalC)
    assert.equal(await row('gpt-6-astra').getByRole('button', { name: '切换到 GPT-6 Astra', exact: true }).innerText(), '切换')
    await capture('independent-inactive-route-prepared')
    await picker.getByRole('button', { name: '全部', exact: true }).click()
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('gpt-6-astra')
    assert.equal(await preferred('gpt-6-astra'), preparedB)
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('')
    await row('gpt-6-astra').getByRole('button', { name: '切换到 GPT-6 Astra', exact: true }).click()
    await current('gpt-6-astra', 'secondary', '90')
    await page.waitForFunction(() => document.querySelector('[data-model-id="gpt-6-astra"] .quota-model-switch')?.textContent === '使用中')
    assert.equal(await preferred('gpt-6.1-sol'), originalA)
    assert.equal(await preferred('gpt-6-luna'), originalC)
    await capture('independent-explicit-switch-keeps-other-models')
    record('inactive paid-supplier choices remain local through filters/search; the explicit switch applies the exact prepared route without moving other models')

    await settingsRoute('gpt-6-astra', '使用 GPT-6 Astra · LS · GPT 高速，稳定性强')
    await current('gpt-6-astra', 'ls', '74')
    assert.equal(await preferred('gpt-6.1-sol'), originalA)
    assert.equal(await preferred('gpt-6-luna'), originalC)
    await settingsRoute('gpt-6-astra', '使用 GPT-6 Astra · 免费套餐')
    await current('gpt-6-astra', 'trial:one', undefined)
    const postsBeforeFreePreparation = (await groupPosts()).length, currentBeforeFreePreparation = (await catalog()).currentOptionKey
    await settingsRoute('gpt-6.1-sol', '使用 GPT-6.1 Sol · 备用免费套餐')
    assert.equal((await catalog()).currentOptionKey, currentBeforeFreePreparation)
    assert.equal((await groupPosts()).length, postsBeforeFreePreparation)
    await assertFreeBadge(row('gpt-6.1-sol').locator('.model-catalog-model-row'))
    const freePrepared = await preferred('gpt-6.1-sol')
    assert.ok(freePrepared.includes('trial:two'))
    await page.reload(); await page.waitForFunction(() => Boolean(window.modmind))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    await picker.waitFor(); await picker.getByRole('button', { name: 'GPT', exact: true }).click()
    assert.equal(await preferred('gpt-6.1-sol'), freePrepared, 'local choices survive renderer reload')
    assert.equal(await preferred('gpt-6-luna'), originalC)
    await row('gpt-6.1-sol').getByRole('button', { name: '切换到 GPT-6.1 Sol', exact: true }).click()
    await current('gpt-6.1-sol', 'trial:two', undefined)
    record('active-model route changes apply immediately; inactive free-platform choices stay local, carry the free mark and persist across reload before activation')

    await app.evaluate(() => { globalThis.adaptiveSmoke.modelsByGroup['ls:25'] = ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra'] })
    await settingsRoute('gpt-6.1-sol', '使用 GPT-6.1 Sol · LS · GPT 不降智分组 a')
    await row('gpt-6.1-sol').locator('.model-catalog-error').waitFor()
    assert.equal((await catalog()).currentOptionKey, freePrepared)
    assert.equal(await preferred('gpt-6.1-sol'), freePrepared, 'failed immediate switching preserves the actual selected route')
    assert.equal(await preferred('gpt-6-luna'), originalC)
    assert.ok(!/Error invoking remote method|device:selectModel/.test(await row('gpt-6.1-sol').innerText()))
    await capture('independent-failed-active-route-preserves-choice')
    record('an active-model switch rejected by the upstream model list preserves the previous exact route and leaves other model choices untouched')
    await app.evaluate(() => { globalThis.adaptiveSmoke.modelsByGroup['ls:25'].push('gpt-6.1-sol') })
    assert.equal((await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'ls', group: '25', billing: 'quota', scope: 'settings' }))).status, 'ok')
    assert.equal((await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'trial:two', billing: 'free', scope: 'settings' }))).status, 'ok')
    await current('gpt-6.1-sol', 'trial:two', undefined)

    await open()
    const other = panel().locator('[data-model-id="gpt-6-astra"]')
    await other.getByRole('button', { name: /选择 .* 的线路/ }).click()
    const beforeCompact = await stored(), postsBeforeCompact = (await groupPosts()).length
    await other.getByRole('button', { name: '使用 GPT-6 Astra · 备用免费套餐', exact: true }).click()
    assert.deepEqual((await stored()).sync, beforeCompact.sync)
    assert.equal((await groupPosts()).length, postsBeforeCompact)
    assert.equal(await panel().isVisible(), true)
    await page.keyboard.press('Escape'); await open()
    assert.ok((await other.locator('.model-catalog-model-row').getAttribute('data-option-key')).includes('trial:two'))
    await other.getByRole('button', { name: '切换到 GPT-6 Astra', exact: true }).click()
    await bound('workspace', 'trial:two', undefined); await panel().waitFor({ state: 'hidden' })
    assert.equal((await catalog()).bindings.workspace.model, 'gpt-6-astra')
    record('the compact picker also prepares routes locally, retains them after closing and applies them only when the model title is clicked')

    await app.evaluate(() => {
      const fixture = globalThis.adaptiveSmoke
      fixture.snapshot.connections.find(connection => connection.account === 'trial:two').models = ['gpt-6-astra']
      fixture.snapshot.selectionRevision++
    })
    await page.evaluate(() => window.modmind.device.refreshConnections())
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    await picker.getByRole('button', { name: 'GPT', exact: true }).click()
    assert.ok(!(await catalog()).models.some(entry => entry.id === 'gpt-6.1-sol' && entry.account === 'trial:two'))
    await settingsRoute('gpt-6.1-sol', '使用 GPT-6.1 Sol · 免费套餐')
    await current('gpt-6.1-sol', 'trial:one', undefined)
    record('when the active model disappears from its old route, explicitly choosing a remaining route still applies immediately')

    for (const dark of [false, true]) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await categories.getByRole('button', { name: '通用', exact: true }).click(); await page.getByRole('button', { name: 'ModMind', exact: true }).click()
      const theme = page.getByRole('switch', { name: '深色模式', exact: true }); if (await theme.getAttribute('aria-checked') !== String(dark)) await theme.click()
      await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
      for (const [width, height] of [[1440, 900], [1080, 680]]) {
        await page.setViewportSize({ width, height }); await picker.getByRole('button', { name: 'GPT', exact: true }).click()
        const trigger = row('gpt-6-astra').getByRole('button', { name: /选择 .* 的线路/ })
        if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
        assert.equal(await row('gpt-6-astra').getByRole('button', { name: '使用 GPT-6 Astra · 免费套餐', exact: true }).getAttribute('aria-pressed'), 'true')
        assert.equal(await row('gpt-6.1-sol').getByRole('button', { name: '切换到 GPT-6.1 Sol', exact: true }).innerText(), '使用中')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        await capture(`independent-routes-${dark ? 'dark' : 'light'}-${width}`)
      }
    }
    const savedChoices = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('modmind-model-route-choices:')).map(key => [key, localStorage.getItem(key)])))
    await fs.writeFile(path.join(work, 'mock-server-state.json'), JSON.stringify(await app.evaluate(() => globalThis.adaptiveSmoke.snapshot)))
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app.close().catch(() => undefined)
    await launch()
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('modmind-model-route-choices:')).map(key => [key, localStorage.getItem(key)]))), savedChoices)
    assert.deepEqual(errors, [])
    record('settings and workspace remember routes independently across a full Electron restart; light/dark1440/1080 windows retain the original layout and selected-route marks without page errors')
  } else if (websiteSyncOnly) {
    await app.evaluate(() => { globalThis.adaptiveSmoke.modelsByGroup['ls:25'].push('gpt-4o'); globalThis.adaptiveSmoke.modelsByGroup['ls:74'].push('gpt-4o') })
    await page.evaluate(() => window.modmind.device.discoverModels())
    await page.evaluate(() => window.modmind.device.selectModel('gpt-6-astra', { account: 'ls', group: '25', billing: 'quota', scope: 'workspace' }))
    await page.evaluate(() => window.modmind.device.selectModel('deepseek-v4.1-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' }))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
    const picker = page.locator('.quota-model-picker')
    await picker.getByRole('button', { name: 'GPT', exact: true }).click()
    const luna = picker.locator('[data-model-id="gpt-6-luna"]')
    await luna.getByRole('button', { name: /选择 .* 的线路/ }).click()
    await luna.getByRole('button', { name: '使用 GPT-6 Luna · LS · GPT 高速，稳定性强', exact: true }).click()
    await picker.locator('.model-catalog-more').waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="刷新模型与连接"]')?.disabled === false)
    const initial = (await stored()).sync
    const readPreferenceText = () => fs.readFile(path.join(profile, 'beginner-ai-preferences.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const preferenceText = await readPreferenceText()
    const localChoices = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('modmind-model-route-choices:')).map(key => [key, localStorage.getItem(key)])))
    const choicesBefore = await localChoices()
    const visibleRows = () => picker.locator('.model-catalog-item').evaluateAll(rows => rows.map(row => [row.dataset.modelId, row.querySelector('.model-catalog-model-row')?.dataset.optionKey]))
    const rowsBefore = await visibleRows()
    const directoryReads = async () => (await requests()).filter(request => request.url.includes('/providers') || request.url.includes('/group') || request.url.endsWith('/models')).length
    async function deliver(code, change) {
      const prior = JSON.parse((await stored()).raw).connectedAt
      const readsBefore = await directoryReads()
      const ipcReadsBefore = await app.evaluate(() => globalThis.adaptiveSmoke.catalogReads)
      await app.evaluate(({ app }, args) => {
        const fixture = globalThis.adaptiveSmoke, snapshot = structuredClone(fixture.snapshot)
        snapshot.selectionRevision++
        if (args.change === 'default') snapshot.defaultAccount = 'trial:one'
        if (args.change === 'rotated') snapshot.connections.find(c => c.kind === 'free').apiKey = 'fixture-free-rotated-key'
        if (args.change === 'paid') Object.assign(snapshot.connections.find(c => c.kind === 'paid'), { account: 'secondary', label: '供应商 2', group: '90', apiKey: 'fixture-secondary-90-key', baseUrl: 'https://secondary.adaptive-smoke.example', inferenceBaseUrl: 'https://secondary.adaptive-smoke.example' })
        if (args.change === 'removed') { snapshot.connections = snapshot.connections.filter(c => c.kind === 'paid'); snapshot.defaultAccount = snapshot.connections[0].account }
        fixture.webSyncCases[args.code] = { snapshot }
        app.emit('second-instance', {}, ['modmind-test', 'mcdev://sync?site=https%3A%2F%2Fadaptive-smoke.example&version=2&code=' + args.code])
      }, { code, change })
      await app.evaluate(async (_electron, args) => {
        for (let attempt = 0; attempt < 240; attempt++) {
          const fixture = globalThis.adaptiveSmoke, outer = JSON.parse(fixture.readStored().raw)
          if (fixture.usedWebCodes.has(args.code) && outer.connectedAt !== args.prior) return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Website authorization did not finish')
      }, { code, prior })
      await page.waitForFunction(async () => (await window.modmind.device.getState()).status === 'connected')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.deepEqual((await stored()).sync, initial, 'website sync never replaces the client snapshot')
      assert.deepEqual(await visibleRows(), rowsBefore, 'rendered model rows and per-model choices stay unchanged')
      assert.deepEqual(await localChoices(), choicesBefore)
      assert.equal(await readPreferenceText(), preferenceText)
      assert.equal(await directoryReads(), readsBefore, 'website authorization must not fetch providers, groups or model catalogs')
      assert.equal(await app.evaluate(() => globalThis.adaptiveSmoke.catalogReads), ipcReadsBefore, 'account events must not trigger a renderer catalog reload, even from cache')
      assert.equal((await requests()).filter(request => request.url.endsWith('/api/device/poll') && request.code === code).length, 1)
    }
    await deliver('SYNC0001', 'default')
    record('website v2 deep-link authorization changes its default without reloading the desktop catalog or changing independent model choices and surface bindings')
    await deliver('SYNC0002', 'rotated')
    record('website free-Key rotation updates authorization without replacing the retained free models or scanning routes')
    await deliver('SYNC0003', 'paid')
    record('website paid-provider replacement leaves the existing paid/free model catalog and prepared per-model routes intact')
    await deliver('SYNC0004', 'removed')
    record('a website response reduced to one paid connection cannot shrink the desktop model catalog')
    assert.equal(await picker.locator('.model-catalog-more').getAttribute('open'), null)
    assert.equal(await picker.locator('.quota-model-feedback').count(), 0)
    for (const [width, height] of [[1440, 1100], [1080, 680]]) {
      await page.setViewportSize({ width, height })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await capture('website-sync-independent-catalog-' + width)
    }
    await new Promise(resolve => setTimeout(resolve, 16_000))
    const readsBeforeRefresh = await directoryReads()
    await picker.getByRole('button', { name: '刷新模型与连接', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="刷新模型与连接"]')?.disabled === false)
    const afterManualRefresh = (await stored()).sync
    assert.equal(afterManualRefresh.connections.some(c => c.kind === 'free'), false)
    assert.equal(afterManualRefresh.connections.find(c => c.kind === 'paid').account, 'secondary')
    assert.deepEqual(afterManualRefresh.bindings, initial.bindings)
    assert.ok(await directoryReads() > readsBeforeRefresh)
    record('the explicit refresh control still imports updated website credentials while preserving exact selections for recovery')
    const polls = (await requests()).filter(request => request.url.endsWith('/api/device/poll'))
    assert.equal(polls.length, 4)
    assert.ok(polls.every(request => request.syncVersion === '2' && request.capabilities === 'provider-ls'))
    assert.deepEqual(errors, [])
  } else if (catalogPolishOnly) {
    await app.evaluate(() => {
      const fixture = globalThis.adaptiveSmoke
      fixture.modelsByGroup['ls:25'].push('gpt-4o', 'gpt-4o-mini', 'gpt-5.1-codex', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.6', 'gpt-6', 'gpt-reserve')
      fixture.modelsByGroup['ls:74'].push('gpt-4o')
      fixture.modelsByGroup['secondary:90'].push('gpt-4o')
      fixture.snapshot.connections.find(connection => connection.kind === 'free').models.push('gpt-4o')
      fixture.snapshot.selectionRevision++
    })
    await page.evaluate(() => window.modmind.device.discoverModels())
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const categories = page.getByRole('navigation', { name: '设置分类' })
    await categories.getByRole('button', { name: '通用', exact: true }).click(); await page.getByRole('button', { name: 'ModMind', exact: true }).click()
    const theme = page.getByRole('switch', { name: '深色模式', exact: true }); if (await theme.getAttribute('aria-checked') !== 'false') await theme.click()
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    const picker = page.locator('.quota-model-picker')
    await picker.getByRole('button', { name: 'GPT', exact: true }).click()
    const more = picker.locator('.model-catalog-more'), summary = more.locator(':scope > summary'), oldModel = picker.locator('[data-model-id="gpt-4o"]')
    await more.waitFor(); assert.equal(await more.getAttribute('open'), null)
    assert.equal(await oldModel.isVisible(), false)
    assert.equal(await more.locator('.model-catalog-item').count(), 9)
    assert.equal(await picker.locator('.quota-model-feedback').count(), 0)
    const postsBefore = (await groupPosts()).length
    await page.setViewportSize({ width: 1440, height: 1100 })
    await capture('gpt-more-collapsed-light-1440')
    const shortHeight = await picker.locator('.quota-model-character').evaluate(element => element.getBoundingClientRect().height)
    await summary.focus(); await page.keyboard.press('Enter'); await oldModel.waitFor({ state: 'visible' })
    await page.waitForFunction(height => document.querySelector('.quota-model-character').getBoundingClientRect().height > height, shortHeight)
    await capture('gpt-more-expanded-light-1440')
    assert.equal((await groupPosts()).length, postsBefore, 'expansion never selects a model or changes a route')
    await summary.focus(); await page.keyboard.press('Enter'); assert.equal(await oldModel.isVisible(), false)
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('gpt-4o')
    await oldModel.waitFor({ state: 'visible' }); assert.equal(await picker.locator('.model-catalog-more').count(), 0)
    await oldModel.getByRole('button', { name: '选择 gpt-4o 的线路', exact: true }).click()
    assert.equal(await oldModel.locator('.model-catalog-route-option').count(), 4)
    await assertFreeBadge(oldModel.getByRole('button', { name: '使用 gpt-4o · 免费套餐', exact: true }))
    await capture('gpt-search-keeps-paid-free-routes')
    await oldModel.getByRole('button', { name: '使用 gpt-4o · LS · GPT 不降智分组 a', exact: true }).click()
    await oldModel.getByRole('button', { name: '切换到 gpt-4o', exact: true }).click()
    await page.waitForFunction(async () => (await window.modmind.device.getModelCatalog()).currentModel === 'gpt-4o')
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('')
    await oldModel.waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.model-catalog-rows > [data-model-id="gpt-4o"]').count(), 1, 'selected supplementary model stays outside the closed section')
    record('GPT variants collapse by default; keyboard expansion only browses, search exposes exact paid/free routes, and the selected variant stays visible')
    for (const dark of [false, true]) {
      await categories.getByRole('button', { name: '通用', exact: true }).click(); if (await theme.getAttribute('aria-checked') !== String(dark)) await theme.click()
      await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
      for (const [width, height] of [[1440, 1100], [1080, 680]]) {
        await page.setViewportSize({ width, height }); await picker.getByRole('button', { name: 'GPT', exact: true }).click()
        await picker.locator('.model-catalog-more > summary').scrollIntoViewIfNeeded()
        assert.equal(await picker.locator('.quota-model-feedback').count(), 0)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        await capture(`gpt-selected-more-${dark ? 'dark' : 'light'}-${width}`)
      }
    }
    await open(); const compact = panel(); await compact.getByRole('textbox', { name: '搜索模型', exact: true }).fill('')
    await compact.getByRole('button', { name: '全部', exact: true }).click()
    await compact.locator('.model-catalog-more').waitFor()
    assert.equal(await compact.locator('[data-model-id="gpt-reserve"]').isVisible(), false)
    await compact.locator('.model-catalog-more > summary').click()
    await compact.locator('[data-model-id="gpt-reserve"]').waitFor({ state: 'visible' })
    await waitBounds(); await capture('compact-gpt-more-expanded-1080')
    assert.deepEqual(errors, [])
    record('settings and compact pickers preserve fold/search behavior in both themes and1080/1440 windows; no footer information row remains')
  } else if (portraitsOnly) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const categories = page.getByRole('navigation', { name: '设置分类' })
    await categories.getByRole('button', { name: '通用', exact: true }).click(); await page.getByRole('button', { name: 'ModMind', exact: true }).click()
    const theme = page.getByRole('switch', { name: '深色模式', exact: true }); if (await theme.getAttribute('aria-checked') !== 'false') await theme.click()
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    const picker = page.locator('.quota-model-picker'); await picker.locator('[data-model-id="gpt-6.1-sol"]').waitFor()
    await checkFamilyMotion(picker); await checkPortraitGeometry(picker)
    await categories.getByRole('button', { name: '通用', exact: true }).click(); await page.getByRole('button', { name: 'ModMind', exact: true }).click()
    await page.getByRole('switch', { name: '深色模式', exact: true }).click(); await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    for (const [family, width, height, name] of [['GLM', 1080, 900, 'portrait-short-glm-dark-1080x900'], ['全部', 1440, 1100, 'portrait-complete-modmind-dark-1440x1100']]) {
      await page.setViewportSize({ width, height }); await picker.getByRole('button', { name: family, exact: true }).focus(); await page.keyboard.press('Enter')
      const geometry = await measurePortrait(picker, `${name}-ready`)
      assert.equal(geometry.layers[0].family, family)
      if (family === 'GLM') { assert.equal(geometry.rows, 2); assert.ok(Math.abs(geometry.height - 560) <= 1) }
      else assert.ok(geometry.layers.every(layer => layer.fullArt === 'true' && layer.mask === 'none'))
      await page.evaluate(() => { const picker = document.querySelector('.quota-model-picker'); for (let element = picker.parentElement; element; element = element.parentElement) if (element.scrollTop) element.scrollTop = 0 })
      await capture(name)
    }
    await fs.writeFile(path.join(work, 'portrait-geometry.json'), JSON.stringify(portraitGeometry, null, 2))
    assert.deepEqual(errors, [])
    record('focused portrait checks cover the real GLM pair and decoded complete ModMind art in light and dark themes')
  } else {
  const readOnlyBefore = (await groupPosts()).length
  await open()
  assert.equal((await groupPosts()).length, readOnlyBefore, 'opening model picker never switches groups')
  await assertNoProviderMenu(panel())
  assert.equal(await panel().locator('[data-model-id="gpt-6.1-sol"]').count(), 1)
  assert.ok((await catalog()).models.every(model => model.account === 'ls'))
  assert.equal(await panel().locator('.model-catalog-free').count(), 0)
  await capture('workbench-single-paid-unscanned')
  record('opening is read-only; only synchronized paid supplier appears, with no free or disconnected-provider placeholders')

  await panel().getByRole('button', { name: '刷新模型与连接', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.agent-workbench .composer-ai-pill')?.textContent?.includes('正在读取线路'))
  assert.equal(await panel().getByRole('button', { name: '切换到 GPT-6.1 Sol', exact: true }).isDisabled(), true)
  await capture('workbench-discovering-lines')
  await page.waitForFunction(() => !document.querySelector('.agent-workbench .composer-ai-pill')?.textContent?.includes('正在读取线路'))
  const discovered = await catalog()
  assert.ok(discovered.models.some(model => model.id === 'line-only-model' && model.group === '74'))
  assert.ok(!discovered.models.some(model => model.id === 'gpt-6.1-sol' && model.group === '75'))
  assert.ok(!discovered.models.some(model => model.modelEvidence === 'unknown'))
  assert.equal((await stored()).sync.connections.find(connection => connection.kind === 'paid').group, '25')
  const paidLines = await expand()
  assert.equal(await paidLines.locator('.model-catalog-route-option').count(), 4)
  assert.ok((await paidLines.innerText()).includes('供应商 2'))
  assert.ok(discovered.models.some(model => model.id === 'provider-two-model' && model.account === 'secondary' && model.group === '91'))
  assert.equal(discovered.models.filter(model => model.id === 'gpt-6.1-sol').length, 4)
  assert.ok((await groupPosts()).some(request => request.body.account === 'secondary' && request.paidAccount === 'ls'))
  assert.ok((await groupPosts()).some(request => request.body.account === 'ls' && request.paidAccount === 'secondary'))
  await capture('workbench-discovered-lines')
  record('explicit refresh discovers both paid suppliers, restores the encrypted original supplier/group, and merges only verified exact model routes')

  await paidLines.getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 高速，稳定性强', exact: true }).click()
  await bound('workspace', 'ls', '74'); await panel().waitFor({ state: 'hidden' })
  assert.equal((await stored()).sync.connections.find(connection => connection.kind === 'paid').group, '74')
  await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'ls', group: '74', billing: 'quota', scope: 'inspiration' }))
  await open(); await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 不降智分组 a', exact: true }).click()
  await bound('workspace', 'ls', '25'); await panel().waitFor({ state: 'hidden' })
  assert.equal((await catalog()).bindings.inspiration.group, '74')
  record('same-model line selection uses exact real IPC group and independent workspace/inspiration bindings')

  await app.evaluate(() => { globalThis.adaptiveSmoke.modelsByGroup['ls:74'] = ['gpt-6-luna'] })
  await page.locator('.agent-workbench').getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).fill('保留这条尚未发送的制作需求')
  await open(); await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 高速，稳定性强', exact: true }).click()
  await panel().locator('.model-catalog-error').waitFor()
  const failure = await panel().locator('.model-catalog-error').innerText()
  assert.ok(!/Error invoking remote method|device:selectModel/.test(failure), 'transport wrapper never reaches product UI')
  assert.equal((await catalog()).bindings.workspace.group, '25')
  assert.equal((await catalog()).bindings.workspace.model, 'gpt-6.1-sol')
  assert.equal(await page.locator('.agent-workbench').getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).inputValue(), '保留这条尚未发送的制作需求')
  await capture('model-disappeared-business-error')
  await app.evaluate(() => { globalThis.adaptiveSmoke.modelsByGroup['ls:74'] = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'line-only-model'] })
  await new Promise(resolve => setTimeout(resolve, 16_000))
  await panel().getByRole('button', { name: '刷新模型与连接', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.agent-workbench .composer-ai-pill')?.textContent?.includes('正在读取线路'))
  await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 不降智分组 a', exact: true }).click()
  await bound('workspace', 'ls', '25'); await panel().waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.agent-workbench').getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).inputValue(), '保留这条尚未发送的制作需求')
  record('a previously verified model disappearing preserves its pin, shows a short business error, and never substitutes another model')

  await app.evaluate(() => { const fixture = globalThis.adaptiveSmoke; fixture.snapshot.selectionRevision++; fixture.snapshot.connections.push({ account: 'trial:one', label: '免费套餐', kind: 'free', baseUrl: 'https://adaptive-smoke.example/api/trial/v1', inferenceBaseUrl: 'https://adaptive-smoke.example/api/trial/v1', apiKey: 'fixture-free-key', model: null, models: ['gpt-6.1-sol', 'deepseek-v4.1-flash'], group: null, node: null }, { account: 'trial:empty', label: '空套餐', kind: 'free', baseUrl: 'https://empty.adaptive-smoke.example/v1', inferenceBaseUrl: 'https://empty.adaptive-smoke.example/v1', apiKey: 'fixture-empty-key', model: null, models: [], group: null, node: null }) })
  await page.evaluate(() => window.modmind.device.refreshConnections())
  await open('灵感台')
  const beforeBrowse = (await catalog()).bindings.inspiration, postsBeforeBrowse = (await groupPosts()).length
  await assertNoProviderMenu(panel())
  const shared = await expand()
  assert.deepEqual((await catalog()).bindings.inspiration, beforeBrowse, 'opening shared model routes does not commit a model')
  assert.equal((await groupPosts()).length, postsBeforeBrowse)
  assert.equal(await panel().locator('[data-model-id="gpt-6.1-sol"]').count(), 1)
  assert.equal(await shared.locator('.model-catalog-route-option').count(), 5, 'one model row offers all four paid routes across both suppliers and its free supplier')
  const freeRoute = shared.getByRole('button', { name: '使用 GPT-6.1 Sol · 免费套餐', exact: true })
  await assertFreeBadge(shared.locator('.model-catalog-model-row'), '可免费')
  await assertFreeBadge(freeRoute)
  assert.equal(await shared.locator('.model-catalog-route-option').filter({ hasText: '额度' }).count(), 0)
  assert.equal(await panel().locator('[data-model-id="deepseek-v4.1-flash"]').count(), 1, 'free-only and paid models are visible together')
  await capture('unified-paid-free-model-routes')
  await freeRoute.click()
  await bound('inspiration', 'trial:one', undefined); await panel().waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('modmind-ai-selection:inspiration')).group), undefined, 'free selection never inherits an old paid group')
  assert.ok(!(await page.locator('.inspiration-page:not([hidden]) .composer-ai-pill').innerText()).includes('重新选择模型'))
  assert.equal((await catalog()).bindings.workspace.group, '25')
  await open('灵感台'); await expand()
  assert.equal(await panel().locator('[data-model-id="gpt-6.1-sol"]').count(), 1)
  assert.ok((await catalog()).providers.some(provider => provider.account === 'trial:empty'))
  assert.ok(await panel().locator('.model-catalog-item').count() > 0, 'an empty connected supplier does not hide other suppliers models')
  const selectedFreeShared = panel().locator('[data-model-id="gpt-6.1-sol"]')
  await assertFreeBadge(selectedFreeShared)
  assert.equal(await selectedFreeShared.getByRole('button', { name: '使用 GPT-6.1 Sol · 免费套餐', exact: true }).getAttribute('aria-pressed'), 'true')
  await capture('unified-free-selected-empty-provider')
  await selectedFreeShared.getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 不降智分组 a', exact: true }).click()
  await bound('inspiration', 'ls', '25'); await panel().waitFor({ state: 'hidden' })
  await open('灵感台'); await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · 免费套餐', exact: true }).click()
  await bound('inspiration', 'trial:one', undefined); await panel().waitFor({ state: 'hidden' })
  assert.equal((await catalog()).bindings.workspace.account, 'ls')
  assert.equal((await catalog()).bindings.workspace.group, '25')
  record('paid/free suppliers share one list, identical model IDs merge into exact selectable routes, existing accent free marks appear in model and route rows, and free choices clear the old paid group')

  await app.evaluate(() => { const fixture = globalThis.adaptiveSmoke; fixture.snapshot.selectionRevision++; for (let index = 0; index < 130; index++) fixture.snapshot.connections.push({ account: 'trial:bulk-' + index, label: '测试套餐 ' + index, kind: 'free', baseUrl: 'https://bulk' + index + '.adaptive-smoke.example/v1', inferenceBaseUrl: 'https://bulk' + index + '.adaptive-smoke.example/v1', apiKey: 'fixture-bulk-' + index, model: null, models: index === 129 ? ['bulk-only-model'] : [], group: null, node: null }) })
  await page.evaluate(() => window.modmind.device.refreshConnections())
  await open('灵感台')
  await page.waitForFunction(async () => { const providers = (await window.modmind.device.getModelCatalog()).providers; return providers.length === 134 && providers.filter(provider => provider.kind === 'paid').length === 2 })
  await assertNoProviderMenu(panel())
  await panel().getByRole('textbox', { name: '搜索模型', exact: true }).fill('测试套餐 129')
  await panel().locator('[data-model-id="bulk-only-model"]').waitFor()
  assert.equal(await panel().locator('[data-model-id="bulk-only-model"]').count(), 1)
  assert.equal(await panel().locator('.model-catalog-item').count(), 1)
  assert.equal((await catalog()).bindings.inspiration.account, 'trial:one')
  await assertFreeBadge(panel().locator('[data-model-id="bulk-only-model"]'))
  await capture('many-providers-global-model-search')
  await panel().getByRole('textbox', { name: '搜索模型', exact: true }).fill('gpt-6.1-sol')
  const searchedShared = await expand()
  assert.equal(await panel().locator('.model-catalog-item').count(), 1)
  assert.equal(await searchedShared.locator('.model-catalog-route-option').count(), 5, 'model search preserves every matching model route across suppliers')
  assert.equal((await catalog()).bindings.inspiration.account, 'trial:one')
  record('hundreds of connected suppliers add no provider controls, global model/provider search finds their models, and searching never commits a selection')

  // Switch both paid suppliers through exact routes in the shared model row.
  await open()
  await assertNoProviderMenu(panel())
  const dualPaidRoutes = await expand()
  assert.equal(await dualPaidRoutes.locator('.model-catalog-route-option').count(), 5)
  await capture('dual-paid-and-free-model-routes')
  await app.evaluate(() => { globalThis.smokeFailNextCredentialRename = true })
  await dualPaidRoutes.getByRole('button', { name: '使用 GPT-6.1 Sol · 供应商 2 · 补充分组', exact: true }).click()
  await bound('workspace', 'secondary', '91'); await panel().waitFor({ state: 'hidden' })
  assert.equal((await stored()).sync.connections.find(connection => connection.kind === 'paid').account, 'secondary')
  const replacementChecks = await app.evaluate(() => globalThis.smokeCredentialReplacementChecks)
  assert.deepEqual(replacementChecks, [{ phase: 'locked', previousExists: true }, { phase: 'retry', previousExists: true }], 'a transient Windows lock never removes the previous credential file')
  assert.equal((await catalog()).bindings.inspiration.account, 'trial:one')
  await open()
  assert.ok((await catalog()).models.some(model => model.account === 'ls' && model.group === '74'), 'verified LS routes remain available while the other paid supplier is active')
  await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · LS · GPT 不降智分组 a', exact: true }).click()
  await bound('workspace', 'ls', '25'); await panel().waitFor({ state: 'hidden' })
  await open()
  await (await expand()).getByRole('button', { name: '使用 GPT-6.1 Sol · 供应商 2 · 标准组', exact: true }).click()
  await bound('workspace', 'secondary', '90'); await panel().waitFor({ state: 'hidden' })
  assert.equal((await catalog()).bindings.inspiration.account, 'trial:one')
  assert.ok((await requests()).some(request => request.url === 'https://secondary.adaptive-smoke.example/models'))
  assert.ok((await groupPosts()).filter(request => request.body.account && request.body.account !== request.paidAccount).every(request => request.body.expectedAccount === request.paidAccount && request.body.expectedGroup === request.paidGroup), 'cross-supplier mutations carry accurate optimistic-concurrency guards')
  record('the shared route chooser switches both paid suppliers directly in both directions, keeps independent free bindings, and uses exact inference roots and concurrency guards')

  await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'secondary', group: '90', billing: 'quota', scope: 'settings' }))
  const categories = page.getByRole('navigation', { name: '设置分类' })
  for (const dark of [false, true]) {
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.getByRole('button', { name: '设置', exact: true }).click()
    await categories.getByRole('button', { name: '通用', exact: true }).click(); await page.getByRole('button', { name: 'ModMind', exact: true }).click()
    const theme = page.getByRole('switch', { name: '深色模式', exact: true }); if (await theme.getAttribute('aria-checked') !== String(dark)) await theme.click()
    await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    const picker = page.locator('.quota-model-picker'); await picker.locator('[data-model-id="gpt-6.1-sol"]').waitFor()
    if (!dark) { await checkFamilyMotion(picker); await checkPortraitGeometry(picker) }
    await picker.getByRole('button', { name: '全部', exact: true }).click()
    for (const [width, height] of [[1440, 900], [1080, 680]]) {
      await page.setViewportSize({ width, height })
      const source = picker.locator('[data-model-id="gpt-6.1-sol"]').getByRole('button', { name: /选择 .* 的线路/ })
      if (await source.getAttribute('aria-expanded') !== 'true') await source.click()
      await assertNoProviderMenu(picker)
      await assertFreeBadge(picker.locator('[data-model-id="gpt-6.1-sol"] .model-catalog-model-row'), '可免费')
      await assertFreeBadge(picker.getByRole('button', { name: '使用 GPT-6.1 Sol · 免费套餐', exact: true }))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await capture(`settings-${dark ? 'dark' : 'light'}-${width}`)
      await open(); await expand(); await waitBounds(); await assertNoProviderMenu(panel()); await assertFreeBadge(panel().getByRole('button', { name: '使用 GPT-6.1 Sol · 免费套餐', exact: true })); await capture(`workbench-${dark ? 'dark' : 'light'}-${width}`)
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.getByRole('button', { name: '设置', exact: true }).click()
      await categories.getByRole('button', { name: 'AI 与图像', exact: true }).click()
    }
  }
  assert.ok(!(await stored()).raw.includes('fixture-'))
  assert.ok(!(await requests()).some(request => request.url.includes('/v1/v1')))
  assert.deepEqual(errors, [])
  record('light/dark settings and workbench at1440×900/1080×680 preserve the unified layout, exact route rows, encrypted keys, and viewport bounds')

  await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'secondary', group: '90', billing: 'quota', scope: 'workspace' }))
  await page.evaluate(() => window.modmind.device.selectModel('gpt-6.1-sol', { account: 'trial:one', billing: 'free', scope: 'inspiration' }))
  const savedBindings = (await catalog()).bindings
  await fs.writeFile(path.join(project.path, 'modmind.project.json'), JSON.stringify({ ...project, draft: { target: {} } }))
  await fs.writeFile(path.join(work, 'mock-server-state.json'), JSON.stringify(await app.evaluate(() => globalThis.adaptiveSmoke.snapshot)))
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); app = undefined
  await launch()
  assert.deepEqual((await catalog()).bindings, savedBindings)
  assert.equal((await stored()).sync.connections.find(connection => connection.kind === 'paid').account, 'secondary')
  assert.ok((await catalog()).models.some(model => model.id === 'provider-two-model' && model.group === '91'), 'discovered line directory survives restart')
  record('full Electron restart restores independent exact bindings, encrypted current paid credentials, and the discovered supplier line directory')

  if (await page.getByRole('checkbox', { name: '专业模式', exact: true }).isChecked()) await page.locator('.expert-mode-toggle').click()
  await page.locator('.minimal-project-trigger').click(); await page.locator('.minimal-project-dropdown').getByRole('button', { name: project.name, exact: true }).click()
  const beginner = page.locator('.agent-workbench:not(.minimal-project-start)')
  await beginner.getByRole('button', { name: /模型与思考强度：/ }).click(); await panel().getByRole('button', { name: '全部', exact: true }).click(); await expand()
  for (const [width, height] of [[1440, 900], [1080, 680]]) { await page.setViewportSize({ width, height }); await waitBounds(); await capture(`beginner-${width}`) }
  record('beginner uses the same unified visible model picker and remains fully within the viewport at1440/1080')
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await app.evaluate(() => { const fixture = globalThis.adaptiveSmoke; fixture.snapshot.selectionRevision++; for (const connection of fixture.snapshot.connections) if (connection.kind === 'free') connection.models = []; for (const key of Object.keys(fixture.modelsByGroup)) fixture.modelsByGroup[key] = [] })
  await new Promise(resolve => setTimeout(resolve, 16_000))
  await page.evaluate(() => window.modmind.device.discoverModels())
  await beginner.getByRole('button', { name: /模型与思考强度：/ }).click()
  await panel().locator('.composer-ai-caption').filter({ hasText: /暂无可用模型|模型列表尚未就绪/ }).waitFor()
  await panel().getByRole('textbox', { name: '搜索模型', exact: true }).fill('made-up-model')
  assert.equal(await panel().locator('.model-catalog-item').count(), 0)
  assert.equal(await panel().getByRole('button', { name: '使用 made-up-model', exact: true }).count(), 0, 'empty hosted catalogs never expose the custom raw-ID path')
  await capture('all-connected-model-lists-empty')
  record('all hosted model lists empty remain recoverable without offering invented model IDs')
  assert.deepEqual(errors, [])
  }
  const rendererEntry = (await fs.readFile(path.join(output, 'renderer/index.html'), 'utf8')).match(/<script[^>]+src="([^"]+)"/)?.[1]
  const report = { status: 'passed', mode: independentRoutesOnly ? 'independent-routes-only' : websiteSyncOnly ? 'website-sync-only' : catalogPolishOnly ? 'catalog-polish-only' : portraitsOnly ? 'portraits-only' : 'full', work, output, rendererEntry, checks, captures, motion, portraitGeometry, pageErrors: errors }
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} catch (error) {
  if (app) {
    await fs.writeFile(path.join(work, 'mock-requests.json'), JSON.stringify(await requests().catch(() => []), null, 2))
    const failureState = await app.evaluate(() => {
      const fixture = globalThis.adaptiveSmoke, summarize = sync => ({ defaultAccount: sync.defaultAccount, selectionRevision: sync.selectionRevision, defaults: sync.defaults, bindings: sync.bindings, connections: sync.connections.map(connection => ({ account: connection.account, group: connection.group, kind: connection.kind, models: connection.models })) })
      return { stored: summarize(fixture.readStored().sync), server: summarize(fixture.snapshot), credentialReadFailures: globalThis.smokeCredentialReadFailures }
    }).catch(() => null)
    await fs.writeFile(path.join(work, 'failure-state.json'), JSON.stringify(failureState, null, 2))
  }
  await fs.writeFile(path.join(work, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, captures, pageErrors: errors, output }, null, 2))
  if (page) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  console.error(JSON.stringify({ status: 'failed', work, output, message: error.message })); throw error
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app.close().catch(() => undefined) }
}
