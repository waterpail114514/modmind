import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {root,devRoot} from './dev-features.mjs'

const id='dev-watch-'+randomUUID().slice(0,8),source=path.join(root,'feature-plugins',id),output=path.join(root,'test-results/feature-development')
await fs.mkdir(source);await fs.mkdir(output,{recursive:true})
await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({format:'modmind-feature',apiVersion:2,hostVersion:'1.5.0-plugintest',id,name:'Watch Fixture',version:'1.0.0',main:'main.cjs',renderer:'renderer.js',style:'renderer.css',views:[{id,label:'Watch Fixture',component:'Workspace',icon:'Image'}]}))
const renderer=value=>`import {registerFeature} from '../sdk/renderer';function Workspace(){return <div>${value}</div>};registerFeature('${id}',{apiVersion:2,pages:[{id:'${id}',label:'Watch Fixture',component:Workspace,exportName:'Workspace'}]});`
await fs.writeFile(path.join(source,'renderer.tsx'),renderer('watch-before'))
await fs.writeFile(path.join(source,'main.ts'),'export function activate(){return {value:"before"}}')
const child=spawn(process.execPath,[path.join(root,'scripts/dev-features.mjs'),`--only=${id}`,'--watch-only'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']})
let logs='';child.stdout.on('data',chunk=>{logs+=chunk});child.stderr.on('data',chunk=>{logs+=chunk})
const wait=async predicate=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await predicate())return;if(child.exitCode!==null)throw Error('watch runner exited: '+logs);await new Promise(resolve=>setTimeout(resolve,150))}throw Error('watch timeout: '+logs)}
const current=async()=>{try{return JSON.parse(await fs.readFile(path.join(devRoot,'ready.json'),'utf8')).builds.find(build=>build.id===id)?.sha256}catch{return undefined}}
try{
 await wait(async()=>Boolean(await current()));const before=await current()
 await fs.writeFile(path.join(source,'renderer.tsx'),renderer('watch-after'))
 await wait(async()=>(await current())!==before);const after=await current()
 if(!(await fs.readFile(path.join(devRoot,'build',id,'renderer.js'),'utf8')).includes('watch-after'))throw Error('renderer changes did not rebuild')
 await fs.writeFile(path.join(source,'main.ts'),'export function activate( { invalid')
 await wait(()=>logs.includes('构建失败'))
 if(await current()!==after)throw Error('failed compilation published an incomplete package')
 await fs.writeFile(path.join(source,'main.ts'),'export function activate(){return {value:"watch-recovered"}}')
 await wait(async()=>(await current())!==after)
 if(!(await fs.readFile(path.join(devRoot,'build',id,'main.cjs'),'utf8')).includes('watch-recovered'))throw Error('backend changes did not rebuild')
 await fs.writeFile(path.join(output,'watch-verification.json'),JSON.stringify({success:true,checks:['initial-local-build','source-watch','same-version-rebuild','failed-build-keeps-ready-package','repaired-backend-rebuild']},null,2))
 console.log('PASS source watch, same-version rebuild, failure preservation and recovery.')
}finally{
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))])}
 const relative=path.relative(path.join(root,'feature-plugins'),path.resolve(source))
 if(relative!==id||!/^dev-watch-[a-f0-9]{8}$/.test(relative))throw Error('Unexpected fixture cleanup target')
 await fs.rm(source,{recursive:true,force:true,maxRetries:5,retryDelay:100})
 await fs.writeFile(path.join(output,'watch-log.txt'),logs)
}
