import {_electron as electron} from 'playwright'
import {build} from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),zip=require('yazl')
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'test-results/feature-development'),profile=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-live-feature-'))
await fs.mkdir(output,{recursive:true});await fs.mkdir(path.join(profile,'packages'))
await build({entryPoints:[path.join(root,'scripts/fixtures/feature-development-ui.tsx')],outfile:path.join(output,'ui.js'),platform:'browser',format:'iife',bundle:true,jsx:'automatic',plugins:[{name:'unused-editor-fixture',setup(builder){builder.onResolve({filter:/MonacoCodeEditor$/},()=>({path:'unused-editor',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function UnusedEditor(){throw Error("Editor outside live reload fixture")}',loader:'js'}))}}],define:{'import.meta.env':'{}','import.meta.hot':'undefined'}})
await build({stdin:{contents:"export {FeaturePluginService} from './src/main/featurePluginService';export {FeatureDevelopmentLoader} from './src/main/featureDevelopment';",resolveDir:root,loader:'ts'},outfile:path.join(output,'service.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'})
const preload=path.join(output,'preload.cjs'),html=path.join(output,'index.html'),bootstrap=path.join(output,'bootstrap.cjs')
await fs.writeFile(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('modmind',{featurePlugins:{list:()=>ipcRenderer.invoke('list'),catalog:()=>ipcRenderer.invoke('catalog'),invoke:(...args)=>ipcRenderer.invoke('invoke',...args),onChanged:callback=>{const listener=()=>callback();ipcRenderer.on('changed',listener);return()=>ipcRenderer.removeListener('changed',listener)}}});`)
await fs.writeFile(html,'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="ui.js"></script>')
await fs.writeFile(bootstrap,`const{app,BrowserWindow,ipcMain,protocol}=require('electron');app.setPath('userData',${JSON.stringify(profile)});protocol.registerSchemesAsPrivileged([{scheme:'modmind-feature',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);app.whenReady().then(async()=>{
 const{FeaturePluginService,FeatureDevelopmentLoader}=require('./service.cjs');const service=new FeaturePluginService(${JSON.stringify(path.join(profile,'features'))},{requireFrom:${JSON.stringify(path.join(root,'package.json'))},capabilities:{},options:()=>({}),catalog:[],busy:()=>false,changed:()=>BrowserWindow.getAllWindows().forEach(win=>win.webContents.send('changed'))});await service.initialize();
 const loader=new FeatureDevelopmentLoader(${JSON.stringify(profile)},service);await loader.start();app.once('quit',()=>loader.stop());protocol.handle('modmind-feature',request=>service.serve(request));ipcMain.handle('list',()=>service.list());ipcMain.handle('catalog',()=>service.catalog());ipcMain.handle('invoke',(_,id,action,input)=>service.invoke(id,action,input));const win=new BrowserWindow({show:false,width:1080,height:680,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true}});await win.loadFile(${JSON.stringify(html)});});app.on('window-all-closed',()=>app.quit());`)
async function publish(text,broken=false){
 const code=`exports.activate=()=>(${broken?'(()=>{throw Error("fixture failed")})()':'{actions:{read:()=>'+JSON.stringify(text)+'}}'});`
 const renderer=`(()=>{const R=window.__modmindFeatureHost.React;window.__modmindRegisterFeature('dev-live-smoke',{Workspace:function Workspace(){return R.createElement('div',{'data-testid':'live-value'},${JSON.stringify(text)})}})})();`
 const files=new Map([['main.cjs',Buffer.from(code)],['renderer.js',Buffer.from(renderer)],['renderer.css',Buffer.from(`[data-testid=live-value]{color:${text==='before'?'rgb(20,40,60)':'rgb(60,40,20)'}}`)]])
 const manifest={format:'modmind-feature',apiVersion:2,hostVersion:'1.5.0-plugintest',id:'dev-live-smoke',name:'Live Smoke',version:'1.0.0',main:'main.cjs',renderer:'renderer.js',style:'renderer.css',views:[{id:'dev-live-smoke',label:'Live Smoke',component:'Workspace',icon:'Image'}],actions:[{id:'read',handler:'read',permission:'read',inputSchema:{type:'object'}}],tools:[{name:'modmind_dev_live_read',action:'read',description:'Read current build'}],files:Object.fromEntries([...files].map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]))}
 files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));const archive=new zip.ZipFile();for(const[name,bytes]of files)archive.addBuffer(bytes,name);archive.end();const chunks=[];for await(const chunk of archive.outputStream)chunks.push(chunk);const bytes=Buffer.concat(chunks),sha256=createHash('sha256').update(bytes).digest('hex'),relative=`packages/dev-live-smoke-${sha256}.zip`;await fs.writeFile(path.join(profile,relative),bytes)
 const temp=path.join(profile,'next.json');await fs.writeFile(temp,JSON.stringify({version:1,builds:[{id:manifest.id,archive:relative,sha256}]}));await fs.rename(temp,path.join(profile,'ready.json'))
}
await publish('before')
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({args:[bootstrap],cwd:root,env})
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.getByTestId('live-value').filter({hasText:'before'}).waitFor()
 const before=await page.evaluate(async()=>({records:await window.modmind.featurePlugins.list(),result:await window.modmind.featurePlugins.invoke('dev-live-smoke','read',{})}))
 await publish('after')
 await page.getByTestId('live-value').filter({hasText:'after'}).waitFor()
 const after=await page.evaluate(async()=>({records:await window.modmind.featurePlugins.list(),result:await window.modmind.featurePlugins.invoke('dev-live-smoke','read',{})}))
 if(before.result!=='before'||after.result!=='after'||before.records[0].version!==after.records[0].version||before.records[0].contentHash===after.records[0].contentHash)throw Error('same-version reload did not replace both UI and business service')
 const color=await page.getByTestId('live-value').evaluate(element=>getComputedStyle(element).color);if(color!=='rgb(60, 40, 20)')throw Error('new CSS did not load: '+color)
 await publish('broken',true)
 // Poll the actual host log until rollback occurred, then verify the live UI and action.
 await page.waitForTimeout(1500)
 if(await page.getByTestId('live-value').innerText()!=='after')throw Error('failed update discarded the previous UI')
 if(await page.evaluate(()=>window.modmind.featurePlugins.invoke('dev-live-smoke','read',{}))!=='after')throw Error('failed update discarded previous backend')
 await publish('recovered');await page.getByTestId('live-value').filter({hasText:'recovered'}).waitFor()
 if(errors.length)throw Error(errors.join('\n'))
 await page.screenshot({path:path.join(output,'live-reloaded.png')})
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,sameVersion:true,errors,checks:['local-verified-package','renderer-script-reload','stylesheet-reload','business-service-reload','failed-activation-rollback','recovery'],profile},null,2));console.log('PASS local feature live reload in Electron, including same-version UI/CSS/backend and failed-update recovery.')
}finally{await app.close()}
