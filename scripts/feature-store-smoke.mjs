import { _electron as electron } from 'playwright'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url),archiver=require('archiver')
const root=path.resolve(import.meta.dirname,'..'),work=path.join(root,'test-results/feature-store',String(Date.now())),profile=path.join(work,'profile')
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Host state did not settle')}
await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'service-config.json'),'{}')
const index=JSON.parse(await fs.readFile(path.join(root,'feature-release/features/stable/catalog.json'),'utf8'))
const requests=[],extra=new Map(),errors=[];let offline=false,app,page
const server=createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url})
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  if(offline){res.writeHead(403);res.end('Forbidden');return}
  if(req.url==='/features/stable/catalog.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(index));return}
  try{const name=String(req.url).slice(1),bytes=extra.get(name)??await fs.readFile(path.join(root,'feature-release',name));res.setHeader('content-length',bytes.length);res.end(bytes)}catch{res.writeHead(404);res.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port
const bootstrap=path.join(work,'bootstrap.cjs')
await fs.writeFile(bootstrap,`const {app,session}=require('electron');app.setName('ModMind Feature Store QA');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});app.getVersion=()=>'1.5.0-plugintest';Object.defineProperty(app,'isPackaged',{get:()=>true});
const undici=require(${JSON.stringify(require.resolve('undici'))}),original=undici.request;undici.request=(url,options)=>{const parsed=new URL(String(url));if(parsed.hostname==='mmdesktop.cn-nb1.rains3.com')return original('http://127.0.0.1:${port}'+parsed.pathname,{...options,dispatcher:undefined});return Promise.reject(new Error('Offline QA: external request disabled'))};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_request,done)=>done({cancel:true})));
require(${JSON.stringify(path.join(root,'out/main/index.js'))});`)
try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  app=await electron.launch({args:[bootstrap,'--user-data-dir='+profile],cwd:root,env})
  page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message))
  await page.locator('.app-shell').waitFor();await page.locator('#app-loading').waitFor({state:'hidden'})
  await page.evaluate(()=>{localStorage.setItem('modmind-ui-mode','advanced');localStorage.setItem('modmind-appearance:v1',JSON.stringify({themePreset:'modmind',darkMode:false}))});await page.reload();await page.locator('.app-shell').waitFor()
  await page.locator('#main-sidebar').getByRole('button',{name:'功能',exact:true}).click();await page.locator('.features-page').waitFor()
  await until(()=>page.evaluate(async()=>Boolean((await window.modmind.featurePlugins.store()).checkedAt)))
  assert.equal(await page.locator('.feature-store-row').count(),17)
  await page.getByRole('navigation',{name:'功能分类'}).getByRole('button',{name:/^资源/}).click();assert.equal(await page.locator('.feature-store-row').count(),5)
  const row=()=>page.locator('.feature-store-row').filter({has:page.getByRole('button',{name:'查看图像工坊',exact:true})})
  await row().getByRole('button',{name:'安装',exact:true}).click()
  await until(()=>page.evaluate(async()=>Boolean((await window.modmind.featurePlugins.list()).find(entry=>entry.id==='image-studio'&&entry.enabled))))
  await page.locator('script[src="modmind-feature://image-studio/renderer.js"]').waitFor({state:'attached'})
  await row().getByRole('button',{name:'查看图像工坊',exact:true}).click()
  await fs.writeFile(path.join(profile,'saved-project-sentinel.txt'),'preserved')
  const manifest=JSON.parse(await fs.readFile(path.join(root,'feature-plugin-dist/image-studio/manifest.json'),'utf8'));manifest.version='1.5.1-plugintest'
  const zip=archiver('zip'),chunks=[];const zipDone=new Promise((resolve,reject)=>{zip.on('data',chunk=>chunks.push(chunk));zip.on('end',()=>resolve(Buffer.concat(chunks)));zip.on('error',reject)})
  zip.append(JSON.stringify(manifest),{name:'manifest.json'});for(const name of Object.keys(manifest.files))zip.file(path.join(root,'feature-plugin-dist/image-studio',name),{name});await zip.finalize();const bytes=await zipDone,sha256=createHash('sha256').update(bytes).digest('hex')
  const release=index.features.find(entry=>entry.id==='image-studio');Object.assign(release,{version:manifest.version,path:`features/packages/image-studio/${manifest.version}/${sha256}.mmfeature`,sha256,size:bytes.length,changelog:['验证在线识别更新。','更新时保留已保存的项目内容。']});extra.set(release.path,bytes)
  await page.waitForTimeout(5100);await page.getByRole('button',{name:'检查更新',exact:true}).click();await row().getByRole('button',{name:'更新',exact:true}).waitFor()
  for(const dark of[false,true])for(const width of[1440,780,390]){
    await page.evaluate(darkMode=>window.dispatchEvent(new StorageEvent('storage',{key:'modmind-appearance:v1',newValue:JSON.stringify({themePreset:'modmind',darkMode})})),dark)
    await page.setViewportSize({width,height:900});if(width<1100)await page.locator('.feature-store-back').click()
    const bounds=await page.locator('.features-page').boundingBox();assert.ok(bounds&&bounds.x>=-1&&bounds.x+bounds.width<=width+1)
    await page.screenshot({path:path.join(work,`features-${dark?'dark':'light'}-${width}.png`)})
    assert.ok(await page.locator('.features-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`Overflow at ${width}`)
    if(width<1100){await row().getByRole('button',{name:'查看图像工坊',exact:true}).click();await page.locator('.feature-store-detail').waitFor({state:'visible'});assert.ok(await page.locator('.feature-store-detail').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:path.join(work,`details-${dark?'dark':'light'}-${width}.png`)})}
  }
  await page.setViewportSize({width:1440,height:900});await row().getByRole('button',{name:'更新',exact:true}).click();await page.getByRole('button',{name:'更新功能',exact:true}).click()
  await until(()=>page.evaluate(async()=>(await window.modmind.featurePlugins.list()).find(entry=>entry.id==='image-studio')?.version==='1.5.1-plugintest'))
  await page.locator('.feature-store-maintenance').getByRole('button',{name:'卸载',exact:true}).click();await page.getByRole('button',{name:'卸载功能',exact:true}).click()
  await until(()=>page.evaluate(async()=>!(await window.modmind.featurePlugins.list()).some(entry=>entry.id==='image-studio')))
  assert.equal(await fs.readFile(path.join(profile,'saved-project-sentinel.txt'),'utf8'),'preserved')
  offline=true;await page.waitForTimeout(5100);await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.locator('.feature-store-notice').getByText(/未开放/).waitFor();assert.equal(await page.locator('.feature-store-row').count(),5)
  assert.ok(requests.length>0&&requests.every(request=>request.method==='GET'));assert.deepEqual(errors,[])
  await fs.writeFile(path.join(work,'result.json'),JSON.stringify({pass:true,requests,errors,checks:['17 official entries','matching sidebar categories','download and load image feature','version update detection','same-id update without uninstall','light/dark at 1440/780/390','narrow details and back','uninstall preserves user files','403 preserves cached catalogue','GET requests only']},null,2))
  console.log(work)
}finally{if(app)await app.close().catch(()=>undefined);server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
