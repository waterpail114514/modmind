import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'

// Read-only live verification of the new catalogue service. No routing mutation,
// token creation, credential copying, preference write, or model inference.
const root=path.resolve(import.meta.dirname,'..')
const work=path.join(root,'test-results','quota-model-live-read',String(Date.now()))
await fs.mkdir(path.join(work,'profile'),{recursive:true})
await build({entryPoints:[path.join(root,'src/main/quotaModelRouting.ts')],outfile:path.join(work,'routing.cjs'),bundle:true,platform:'node',format:'cjs'})
const helper=path.join(work,'read.cjs')
const expectedSite=new URL(JSON.parse(await fs.readFile(path.join(root,'resources/service-config.json'),'utf8')).siteUrl).origin
await fs.writeFile(helper,`const {app,safeStorage}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const {QuotaModelRouting}=require('./routing.cjs');
app.setName('ModMind Read-only Catalogue Check');app.setPath('userData',path.join(process.env.APPDATA,'modmind'));
let phase='credentials';app.whenReady().then(async()=>{try{
const source=path.join(process.env.APPDATA,'modmind');const stored=JSON.parse(await fs.readFile(path.join(source,'device-credentials.json'),'utf8'));
if(stored.provider==='custom'||new URL(stored.siteUrl).origin!==${JSON.stringify(expectedSite)})throw new Error('Unsupported account');
phase='decrypt';const c={...stored,apiKey:safeStorage.decryptString(Buffer.from(stored.encryptedApiKey,'base64'))};
const saved=JSON.parse(await fs.readFile(path.join(source,'beginner-ai-preferences.json'),'utf8').catch(()=>'{}'));const preferences=saved.current??saved;
const noWrite=async()=>{throw new Error('Live check is read-only')};
const service=new QuotaModelRouting({readCredentials:async()=>c,writeCredentials:noWrite,readSession:async()=>null,writeSession:noWrite,clearSession:noWrite,readPreferences:async()=>({model:preferences.model??'gpt-5.6-sol',reasoningLevel:'auto',fastMode:false}),applyModel:noWrite,listModels:async c=>{
const base=c.baseUrl.endsWith('/')?c.baseUrl.slice(0,-1):c.baseUrl;const v1=base.toLowerCase().endsWith('/v1')?base:base+'/v1';const r=await fetch(v1+'/models',{headers:{Authorization:'Bearer '+c.apiKey},redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('Model list unavailable');const data=await r.json();return (Array.isArray(data.data)?data.data:[]).map(m=>({id:m.id}));}});
phase='catalogue';const result=await service.catalog(true);const summary={connected:result.connected,stale:result.stale,currentModel:result.currentModel,currentRoute:result.currentRoute,models:result.models.map(m=>({id:m.id,billing:m.billing,available:m.available,...(m.noCache?{noCache:true}:{})})),readOnly:true};
await fs.writeFile(${JSON.stringify(path.join(work,'report.json'))},JSON.stringify(summary,null,2));console.log(JSON.stringify({connected:result.connected,stale:result.stale,modelCount:result.models.length,available:result.models.filter(m=>m.available).length,noCache:result.models.filter(m=>m.noCache).map(m=>m.id),account:result.currentRoute?.account,readOnly:true}));app.exit(result.connected&&!result.stale?0:1);
}catch(error){console.log(JSON.stringify({status:'live-read-unavailable',phase,errorType:error.name,readOnly:true}));app.exit(1)}});`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
if(spawnSync(process.execPath,['--check',helper],{windowsHide:true}).status!==0)throw new Error('Invalid live-check helper')
const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),['--no-error-dialogs',helper],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
const timeout=setTimeout(()=>child.kill(),45000)
let stdout='';child.stdout.on('data',chunk=>stdout+=String(chunk));child.stderr.resume()
const code=await new Promise(resolve=>child.once('exit',resolve))
clearTimeout(timeout)
console.log(stdout.trim());console.log('Report: '+path.join(work,'report.json'))
process.exitCode=code??1
