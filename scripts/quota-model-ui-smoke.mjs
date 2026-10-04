import { _electron as electron } from 'playwright'
import { build } from 'electron-vite'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Full app + real IPC/routing service with a deterministic upstream. No real keys,
// paid calls, existing profiles, dev server, or visible helper windows are used.
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'quota-model-ui', String(Date.now()))
const profile = path.join(work, 'profile'), output = process.env.QUOTA_SMOKE_BUILD || path.join(work, 'build')
await fs.mkdir(profile, { recursive: true })
const config = path.join(work, 'electron.config.mjs')
await fs.writeFile(config, `import {defineConfig,externalizeDepsPlugin} from 'electron-vite'; import react from '@vitejs/plugin-react';
export default defineConfig({main:{plugins:[externalizeDepsPlugin({exclude:['jfxr']})],build:{outDir:${JSON.stringify(path.join(output,'main'))},rollupOptions:{input:${JSON.stringify(path.join(root,'src/main/index.ts'))}}}},preload:{plugins:[externalizeDepsPlugin()],build:{outDir:${JSON.stringify(path.join(output,'preload'))},rollupOptions:{input:${JSON.stringify(path.join(root,'src/preload/index.ts'))}}}},renderer:{root:${JSON.stringify(path.join(root,'src/renderer'))},publicDir:${JSON.stringify(path.join(root,'resources/renderer-public'))},plugins:[react()],resolve:{alias:{'@renderer':${JSON.stringify(path.join(root,'src/renderer/src'))},'@shared':${JSON.stringify(path.join(root,'src/shared'))}}},build:{outDir:${JSON.stringify(path.join(output,'renderer'))},rollupOptions:{input:${JSON.stringify(path.join(root,'src/renderer/index.html'))}}}}});`)
if (!process.env.QUOTA_SMOKE_BUILD) await build({ configFile: config, logLevel: 'warn' })
const bootstrap = path.join(work, 'bootstrap.cjs')
const freeAccount = 'trial:free-mtjzrt3s-l9afs'
const routes = [
  ...JSON.parse(await fs.readFile(path.join(root, 'src/main/__fixtures__/quota-model-routes.json'), 'utf8')).map(r => ({...r,account:'secondary',label: r.group === 'Kimi' ? 'Kimi系列（200%标准价格）无缓存 K' : r.group === 'Gemini' ? 'Gemini系列（标准价格）无缓存 M' : r.group})),
  {account:freeAccount,group:null,modelIds:['deepseek-v4-pro-0813','deepseek-v4.1-flash','glm-5.3','qwen3.8-flash']}
]
await fs.writeFile(bootstrap, `const native=require('electron');const {app,BrowserWindow,safeStorage}=native;const fs=require('node:fs');const path=require('node:path');
app.disableHardwareAcceleration();
class TestWindow extends BrowserWindow{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}})}show(){}}
const Module=require('node:module');const originalLoad=Module._load;const electronProxy=new Proxy(native,{get:(target,key)=>key==='BrowserWindow'?TestWindow:Reflect.get(target,key)});Module._load=function(name,...args){return name==='electron'?electronProxy:originalLoad.call(this,name,...args)};
app.setName('modmind-quota-smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});
const routes=${JSON.stringify(routes)};
const fixture=globalThis.quotaSmoke={account:'secondary',group:'gpt-pro（混池）',key:'fixture-key',failNext:false,offline:false,posts:[],modelUrls:[],usageCalls:0,sessionCreated:false};
const state=()=>({account:fixture.account,provider:fixture.account,current:fixture.group,keyStatus:'ACTIVE',canSwitch:true,canSwitchProvider:true,providers:[{account:'secondary',kind:'paid',label:'Supplier 2',groups:routes.filter(r=>r.account==='secondary').map(r=>({id:r.group,label:r.label}))},{account:${JSON.stringify(freeAccount)},kind:'free',label:'免费套餐',groups:[]}]});
const credentials=()=>({status:'ok',account:fixture.account,provider:fixture.account,group:fixture.group,node:'default',apiKey:fixture.key,baseUrl:fixture.account==='secondary'?'https://relay.quota-smoke.example':'https://quota-smoke.example/api/trial/v1',username:'quota-test',balanceCents:fixture.account==='secondary'?'1000':'0',keyStatus:'ACTIVE'});
global.fetch=async(url,init={})=>{const u=String(url);const response=(data,status=200)=>new Response(JSON.stringify(status===200?{success:true,data}:{success:false,message:'temporary'}),{status});
if(u.includes('quota-smoke.example')){
if(fixture.offline)throw new Error('offline');
if(u.endsWith('/api/device/session')){fixture.sessionCreated=true;return response({routingToken:'fixture-routing-token',routingTokenExpiresAt:new Date(Date.now()+30*86400000).toISOString()})}
if(u.includes('/api/device/group')){if(init.method==='POST'){if(!fixture.sessionCreated)throw new Error('session not saved');fixture.posts.push(JSON.parse(init.body));if(fixture.failNext){fixture.failNext=false;return response({},503)}fixture.account=JSON.parse(init.body).account;fixture.group=JSON.parse(init.body).group??null;fixture.key='fixture-'+fixture.posts.length;return response(credentials())}return response({...state(),...(u.includes('credentials=1')?{credentials:credentials()}:{})})}
if(u.endsWith('/models')||u.endsWith('/model')){fixture.modelUrls.push(u);return new Response(JSON.stringify({data:routes.find(r=>r.account===fixture.account&&r.group===fixture.group).modelIds.map(id=>({id}))}));}
if(u.endsWith('/api/device/usage')){fixture.usageCalls++;return response({keyStatus:'ACTIVE',balanceCents:'1000',usedQuota:'0',remainQuota:'1000',billedCentsTotal:'0',lastSeenUsedQuota:'0',checkedAt:new Date().toISOString()});}
return response({});}
throw new Error('Unrelated network blocked by quota UI test');};
app.whenReady().then(()=>{fs.writeFileSync(path.join(app.getPath('userData'),'device-credentials.json'),JSON.stringify({version:1,siteUrl:'https://quota-smoke.example',baseUrl:'https://relay.quota-smoke.example',encryptedApiKey:safeStorage.encryptString('fixture-key').toString('base64'),username:'quota-test',balanceCents:'1000',connectedAt:new Date().toISOString()}));});require(${JSON.stringify(path.join(output,'main/index.js'))});`)
let app
try {
  const env = { ...process.env, MODMIND_SITE_URL: 'https://quota-smoke.example' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env })
  let stderr = ''; app.process().stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000) })
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(w => w.url().includes('/renderer/index.html'))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, `main renderer loaded: ${JSON.stringify(app.windows().map(w=>w.url()))}; ${stderr}`)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.webContents.setBackgroundThrottling(false)))
  page.setDefaultTimeout(15000)
  const capture = async filename => {
    const png = await app.evaluate(async({webContents}) => {
      const contents=webContents.getAllWebContents().find(w=>w.getURL().includes('/renderer/index.html'))
      if(!contents)throw new Error('Renderer capture target missing: '+JSON.stringify(webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL(),type:w.getType()}))))
      const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})
      return image.toPNG().toString('base64')
    })
    assert.ok(png.length>1000,'captured rendered app')
    await fs.writeFile(path.join(work,filename),Buffer.from(png,'base64'))
  }
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 与图像', exact: true }).click()
  const picker = page.locator('.quota-model-picker')
  const waitForUi = async (predicate, argument) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await page.evaluate(predicate, argument)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.fail(`UI transition did not settle for ${argument}: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.quota-model-character-layer')].map(layer => ({ family: layer.dataset.family, active: layer.dataset.active, opacity: getComputedStyle(layer).opacity, animations: layer.getAnimations().map(a => ({ state: a.playState, time: a.currentTime })), images: [...layer.querySelectorAll('img')].map(img => ({ loaded: img.complete, width: img.naturalWidth })) }))))}`)
  }
  const assertHighlightAligned = async () => {
    const aligned = await picker.locator('.quota-model-families').evaluate(group => {
      const selected = group.querySelector('button[aria-pressed="true"]')
      const highlight = group.querySelector('.quota-model-family-indicator')
      if (!selected) return getComputedStyle(highlight).opacity === '0'
      const values = getComputedStyle(highlight).clipPath.split('round')[0].match(/[-\d.]+px/g).map(parseFloat)
      const [top, right = top, bottom = top, left = right] = values
      return Math.abs(top - selected.offsetTop) <= 1 && Math.abs(left - selected.offsetLeft) <= 1 &&
        Math.abs(group.clientWidth - left - right - selected.offsetWidth) <= 1 &&
        Math.abs(group.clientHeight - top - bottom - selected.offsetHeight) <= 1
    })
    assert.ok(aligned, 'family highlight matches the selected option, including wrapped rows')
  }
  await picker.getByRole('button', { name: '切换到 GPT-6.1 Sol', exact: true }).waitFor()
  await picker.getByRole('button', { name: 'Kimi', exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await picker.getAttribute('data-family-motion'), 'false', 'keyboard family selection stays immediate')
  await picker.getByRole('button', { name: '切换到 Kimi K3', exact: true }).click()
  await picker.getByText('已切换到 Kimi K3', { exact: true }).waitFor()
  assert.equal(await picker.locator('.quota-model-row .quota-no-cache-mark').innerText(), '无缓存')
  assert.equal(await picker.locator('.quota-model-current .quota-no-cache-mark').innerText(), '无缓存')
  assert.equal(await picker.locator('.quota-model-families .quota-no-cache-mark').count(), 0)
  assert.equal((await page.evaluate(() => window.modmind.device.getAiPreferences())).model, 'kimi-k3')
  assert.equal((await app.evaluate(() => globalThis.quotaSmoke.posts)).at(-1).group, 'Kimi')
  const search = picker.getByRole('searchbox', { name: '搜索额度模型' })
  await search.fill('nothing-matches'); await picker.getByText('没有匹配的模型').waitFor(); await picker.getByText('清除筛选').click()
  await app.evaluate(() => { globalThis.quotaSmoke.failNext = true })
  await picker.getByRole('button', { name: 'GLM', exact: true }).click()
  await picker.getByRole('button', { name: '切换到 GLM 5.3 Flash', exact: true }).click()
  await picker.locator('.quota-model-feedback.is-error').waitFor()
  await capture('failure.png')
  assert.equal((await page.evaluate(() => window.modmind.device.getAiPreferences())).model, 'kimi-k3')
  await picker.getByRole('button', { name: '切换到 GLM 5.3 Flash', exact: true }).click()
  await picker.getByText('已切换到 GLM 5.3 Flash', { exact: true }).waitFor()
  assert.equal(await picker.locator('.quota-model-row .quota-no-cache-mark').count(), 0)
  await picker.getByRole('button', { name: '推荐', exact: true }).click()
  await picker.getByRole('button', { name: '切换到 GPT-6.1 Sol', exact: true }).click()
  await picker.getByText('已切换到 GPT-6.1 Sol', { exact: true }).waitFor()
  const allModels = await page.evaluate(() => window.modmind.device.listModels(true))
  assert.ok(allModels.some(m => m.id === 'kimi-k3') && allModels.some(m => m.id === 'gemini-3.8-flash'), 'legacy model lists include other routes')
  await picker.getByRole('button',{name:'DeepSeek',exact:true}).click()
  assert.equal(await picker.locator('.quota-model-families button[aria-label="DeepSeek"] .quota-free-mark').innerText(),'免')
  await picker.getByRole('button',{name:'切换到 DeepSeek V4.1 Flash 免费版',exact:true}).click()
  await picker.getByText('已切换到 DeepSeek V4.1 Flash（免费版）',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>window.modmind.device.getState())).billing,'free')
  assert.equal((await page.evaluate(()=>window.modmind.device.getAiPreferences())).model,'deepseek-v4.1-flash')
  assert.equal(await picker.locator('.quota-model-current .quota-free-mark').innerText(),'免')
  await picker.locator('.quota-model-advanced summary').click()
  assert.equal(await picker.getByRole('checkbox',{name:'Fast 模式',exact:true}).isDisabled(),true)
  await picker.locator('.quota-model-advanced summary').click()
  const freePost = (await app.evaluate(()=>globalThis.quotaSmoke.posts)).at(-1)
  assert.equal(freePost.account, freeAccount); assert.equal(freePost.group, undefined)
  assert.ok((await app.evaluate(()=>globalThis.quotaSmoke.modelUrls)).includes('https://quota-smoke.example/api/trial/v1/models'))
  await picker.getByRole('button',{name:'GLM',exact:true}).click()
  assert.equal(await picker.locator('.quota-model-row .quota-free-mark').count(),1,'separate free GLM row')
  await capture('free-editions.png')
  await picker.getByRole('button',{name:'切换到 GLM 5.3 Flash',exact:true}).click()
  await picker.getByText('已切换到 GLM 5.3 Flash',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>window.modmind.device.getState())).billing,'quota')
  await picker.getByRole('button',{name:'推荐',exact:true}).click()
  await picker.getByRole('button',{name:'切换到 GPT-6.1 Sol',exact:true}).click()
  await picker.getByText('已切换到 GPT-6.1 Sol',{exact:true}).waitFor()
  for (const dark of [false,true]) {
    const categories=page.getByRole('navigation',{name:'设置分类'})
    await categories.getByRole('button',{name:'通用',exact:true}).click()
    await page.getByRole('button',{name:'ModMind',exact:true}).click()
    const toggle=page.getByRole('switch',{name:'深色模式',exact:true})
    if((await toggle.getAttribute('aria-checked'))!==String(dark))await toggle.click()
    await page.waitForFunction(dark=>document.documentElement.dataset.themeMode===(dark?'dark':'light'),dark)
    await categories.getByRole('button',{name:'AI 与图像',exact:true}).click()
    await picker.getByRole('button', { name: 'Gemini', exact: true }).click()
    assert.equal(await picker.locator('.quota-model-row .quota-no-cache-mark').count(), 4)
    assert.equal(await picker.locator('.quota-model-families .quota-no-cache-mark').count(), 0)
    for (const width of [1440,1100,900,600,390]) {
    await page.setViewportSize({ width, height: 950 })
    const collapse=page.getByRole('button',{name:width<600?'收起侧栏':'展开侧栏',exact:true})
    if(await collapse.count())await collapse.click()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await picker.locator('.quota-model-rows').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))))
    await capture(`${dark?'dark':'light'}-${width}.png`)
    // The non-scrolling picker reserves a clip margin for horizontal motion.
    // Check actual scrolling ancestors, rather than its transient visual overflow.
    const overflow = await picker.evaluate(node => {
      const scrolling = [document.scrollingElement]
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(ancestor).overflowX)) scrolling.push(ancestor)
      }
      return Math.max(...scrolling.map(element => element.scrollWidth - element.clientWidth))
    })
    assert.ok(overflow <= 1, `horizontal page overflow at ${width}: ${overflow}`)
    assert.equal(await picker.locator('.quota-model-row .quota-no-cache-mark').count(), 4)
    for (const family of width === 1440 ? ['推荐','GPT','Gemini','Grok','GLM','Kimi','DeepSeek','Qwen'] : ['推荐','GPT','Kimi']) {
      await picker.getByRole('button', { name: family, exact: true }).click()
      const character = picker.locator('.quota-model-character')
      assert.equal(await character.getAttribute('data-family'), family)
      await waitForUi(family => {
        const layers = document.querySelectorAll('.quota-model-character-layer')
        return layers.length === 1 && layers[0].getAttribute('data-family') === family && (layers[0].getBoundingClientRect().width === 0 || getComputedStyle(layers[0]).opacity === '1')
      }, family)
      await character.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
      await assertHighlightAligned()
      if (family === '推荐') assert.equal(await character.locator('.quota-model-character-note').innerText(), '暂定，不代表最终效果')
      else assert.equal(await character.locator('.quota-model-character-note').count(), 0)
      const geometry = await picker.evaluate(node => {
        const element = node.querySelector('.quota-model-character')
        const art = element.getBoundingClientRect(), width = node.getBoundingClientRect().width
        return { width, artWidth: art.width, artHeight: art.height, display: getComputedStyle(element).display, opacity: Number(getComputedStyle(element).opacity),
          separated: [...node.querySelectorAll('.quota-model-copy, .quota-model-switch')].every(element => {
            const rect = element.getBoundingClientRect()
            return rect.right <= art.left || rect.left >= art.right
          }) }
      })
      assert.ok(Math.abs(geometry.artWidth - Math.max(0, Math.min(400, geometry.width - 515))) < 1, 'portrait reveals continuously with available space')
      assert.notEqual(geometry.display, 'none', 'no abrupt breakpoint visibility toggle')
      assert.ok(Math.abs(geometry.opacity - Math.min(1, Math.max(0, geometry.width - 515) / 280)) < 0.01, 'whole portrait fades as the gap narrows')
      assert.ok(geometry.separated, 'portrait does not cover text or switch buttons')
      if (width === 1440) {
        if (family === '推荐') assert.ok(geometry.artHeight >= 520 && geometry.artHeight <= 620, 'recommended portrait fits the available list height')
        else if (family === 'GPT') assert.ok(geometry.artHeight >= 590, 'long model lists reveal more of the original legs without stretching')
        else assert.equal(geometry.artHeight, 520, 'short lists retain the full portrait frame, including a single-model family')
      }
      await capture(`${family.toLowerCase()}-${dark?'dark':'light'}-${width}.png`)
    }
    await picker.getByRole('button', { name: '推荐', exact: true }).click()
    assert.equal(await picker.locator('.quota-model-character').getAttribute('data-family'), '推荐', 'recommended list uses the ModMind portrait')
    await search.fill('nothing-matches')
    assert.equal(await picker.locator('.quota-model-character').count(), 0, 'no portrait in search results or empty states')
    await assertHighlightAligned()
    await search.fill('')
    await picker.getByRole('button', { name: 'Gemini', exact: true }).click()
    }
  }
  // Inspect actual compositor transitions, including interruption and reduced motion.
  await page.setViewportSize({ width: 1440, height: 950 })
  await picker.getByRole('button', { name: '推荐', exact: true }).focus()
  await page.keyboard.press('Enter')
  const waitForPortrait = family => waitForUi(family => {
    const layers = document.querySelectorAll('.quota-model-character-layer')
    return layers.length === 1 && layers[0].getAttribute('data-family') === family && (layers[0].getBoundingClientRect().width === 0 || getComputedStyle(layers[0]).opacity === '1')
  }, family)
  await waitForPortrait('推荐')
  // Pause transitions as they are created so the mid-fade can be captured reliably.
  await page.evaluate(() => {
    window.quotaMotionListener = event => {
      if (event.target.matches('.quota-model-character-layer, .quota-model-rows, .quota-model-family-indicator')) for (const animation of event.target.getAnimations()) {
        animation.pause(); animation.currentTime = 70
      }
    }
    document.addEventListener('transitionrun', window.quotaMotionListener)
  })
  await picker.getByRole('button', { name: 'Gemini', exact: true }).click()
  await waitForUi(() => document.querySelector('.quota-model-character-layer[data-family="Gemini"]')?.getAnimations().some(animation => animation.playState === 'paused'))
  const fade = await picker.locator('.quota-model-character').evaluate(element => [...element.querySelectorAll('.quota-model-character-layer')].map(layer => ({ family: layer.dataset.family, opacity: Number(getComputedStyle(layer).opacity), x: new DOMMatrixReadOnly(getComputedStyle(layer).transform).m41, duration: layer.getAnimations()[0]?.effect.getTiming().duration })))
  assert.equal(fade.length, 2, 'outgoing and incoming portraits overlap during the fade')
  assert.ok(fade.every(layer => layer.opacity > 0 && layer.opacity < 1 && layer.duration === 400), 'both portraits crossfade over the slower 400ms duration')
  assert.ok(fade.find(layer => layer.family === '推荐').x < 0 && fade.find(layer => layer.family === 'Gemini').x > 0, 'forward selection moves the outgoing portrait left and brings the new one from the right')
  assert.ok(await picker.locator('.quota-model-rows').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41 > 0), 'list follows the same forward direction')
  assert.ok(await picker.locator('.quota-model-family-indicator').evaluate(element => element.getAnimations().some(animation => animation.effect.getTiming().duration === 320 && animation.playState === 'paused') && getComputedStyle(element).clipPath !== element.style.clipPath), 'family highlight travels between options over 320ms')
  assert.ok(await picker.evaluate(element => {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(ancestor).overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1) return false
    }
    return document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1
  }), 'sliding content uses existing page padding without creating horizontal scrolling')
  await capture('family-crossfade-midpoint.png')
  await page.evaluate(() => {
    document.removeEventListener('transitionrun', window.quotaMotionListener)
    document.querySelectorAll('.quota-model-character-layer, .quota-model-rows, .quota-model-family-indicator').forEach(layer => layer.getAnimations().forEach(animation => animation.play()))
  })
  await waitForPortrait('Gemini')
  await page.evaluate(() => document.addEventListener('transitionrun', window.quotaMotionListener))
  await picker.getByRole('button', { name: 'GPT', exact: true }).click()
  await waitForUi(() => document.querySelector('.quota-model-character-layer[data-family="GPT"]')?.getAnimations().some(animation => animation.playState === 'paused'))
  const reverse = await picker.locator('.quota-model-character').evaluate(element => [...element.querySelectorAll('.quota-model-character-layer')].map(layer => ({ family: layer.dataset.family, x: new DOMMatrixReadOnly(getComputedStyle(layer).transform).m41 })))
  assert.ok(reverse.find(layer => layer.family === 'Gemini').x > 0 && reverse.find(layer => layer.family === 'GPT').x < 0, 'backward selection reverses both portrait directions')
  assert.ok(await picker.locator('.quota-model-rows').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41 < 0), 'list follows the same backward direction')
  await capture('family-slide-reverse-midpoint.png')
  await page.evaluate(() => {
    document.removeEventListener('transitionrun', window.quotaMotionListener)
    document.querySelectorAll('.quota-model-character-layer, .quota-model-rows, .quota-model-family-indicator').forEach(layer => layer.getAnimations().forEach(animation => animation.play()))
  })
  // Send several real pointer activations before the current fade has finished.
  for (const family of ['GPT', 'Kimi', 'GLM', '推荐']) await picker.getByRole('button', { name: family, exact: true }).dispatchEvent('click', { detail: 1 })
  await waitForPortrait('推荐')
  assert.equal(await picker.locator('.quota-model-character-note').count(), 1, 'rapid switches retain only the latest portrait and caption')
  await assertHighlightAligned()
  await page.evaluate(() => {
    window.quotaOriginalDecode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = async function () {
      await window.quotaOriginalDecode.call(this)
      if (this.src.includes('gpt-')) await new Promise(resolve => setTimeout(resolve, 400))
    }
  })
  await picker.getByRole('button', { name: 'GPT', exact: true }).dispatchEvent('click', { detail: 1 })
  await picker.getByRole('button', { name: 'GLM', exact: true }).dispatchEvent('click', { detail: 1 })
  await waitForPortrait('GLM')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)))
  assert.equal(await picker.locator('.quota-model-character-layer[data-active="true"]').getAttribute('data-family'), 'GLM', 'late image decode cannot restore a superseded family')
  await page.evaluate(() => { HTMLImageElement.prototype.decode = window.quotaOriginalDecode })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await picker.getByRole('button', { name: 'Kimi', exact: true }).click()
  await waitForPortrait('Kimi')
  assert.ok(await picker.locator('.quota-model-character-layer').evaluate(layer => getComputedStyle(layer).transitionDuration.split(', ').every(value => parseFloat(value) <= 0.1) && getComputedStyle(layer).transform === 'none'), 'reduced motion respects the app-wide near-instant fade and removes translation')
  await picker.getByRole('button', { name: 'Gemini', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitForPortrait('Gemini')
  assert.equal(await picker.locator('.quota-model-character-layer').evaluate(layer => layer.getAnimations().length), 0, 'keyboard selection interrupts motion immediately')
  await assertHighlightAligned()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(()=>{globalThis.quotaSmoke.offline=true})
  await picker.getByRole('button',{name:'刷新额度模型',exact:true}).click()
  await picker.getByText('无法连接模型服务，请检查网络后重试',{exact:true}).waitFor()
  assert.equal(await picker.locator('.quota-model-row').count(),4)
  await app.evaluate(()=>{globalThis.quotaSmoke.offline=false})
  await picker.getByRole('button',{name:'刷新额度模型',exact:true}).click()
  await page.evaluate(()=>window.modmind.device.getModelCatalog(true))
  const persisted=JSON.parse(await fs.readFile(path.join(profile,'beginner-ai-preferences.json'),'utf8'))
  assert.ok(JSON.stringify(persisted).includes('gpt-6.1-sol'))
  const session=await fs.readFile(path.join(profile,'quota-routing-session.enc'),'utf8')
  assert.ok(!session.includes('fixture-routing-token'))
  assert.deepEqual(errors,[])
  await fs.writeFile(path.join(work,'report.json'),JSON.stringify({success:true,checks:['real settings JSX and IPC','route selection and model readback','legacy cross-route catalogue','paid to free to paid','free model and family marks','route-specific no-cache model marks, never on families','seven family portraits and recommended ModMind portrait decoded, clear of text/buttons; short lists retain 520px frame, long lists reveal more legs','continuous portrait masking at 1440/1100/900/600/390, no breakpoint visibility toggle','recommended portrait has provisional caption; no portrait in search views','zero-balance free state','trial v1 URL normalization','keyboard family selection','search empty recovery','503 then retry','light/dark at 1440/1100/900/600/390','offline retained catalogue','encrypted session'],errors},null,2))
  console.log(`PASS: quota model settings. ${work}`)
} finally { await app?.close() }
