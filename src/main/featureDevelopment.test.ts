import {afterEach,describe,expect,it,vi} from 'vitest'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {FeaturePluginService} from './featurePluginService'
import {FeatureDevelopmentLoader} from './featureDevelopment'
import {FEATURE_PLUGIN_HOST} from '../shared/featurePlugins'

const require=createRequire(import.meta.url),zip=require('yazl'),roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
async function fixture() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-local-features-'));roots.push(root)
 const changed=vi.fn(),log=vi.fn(),host={requireFrom:path.resolve('package.json'),capabilities:{},options:()=>({}),busy:()=>false,changed,catalog:[]}
 const service=new FeaturePluginService(path.join(root,'profile/features'),host);await service.initialize()
 const loader=new FeatureDevelopmentLoader(root,service,log)
 return{root,service,host,loader,changed,log}
}
async function publish(root:string,value:string,options:{id?:string;code?:string;corrupt?:boolean;dependencies?:string[]}={}) {
 const id=options.id??'live-example'
 const files=new Map([['main.cjs',Buffer.from(options.code??`exports.activate=()=>({actions:{read:()=>${JSON.stringify(value)}}})`)],['renderer.js',Buffer.from('/* '+value+' */')],['renderer.css',Buffer.from('')]])
 const manifest={format:'modmind-feature',apiVersion:2,hostVersion:FEATURE_PLUGIN_HOST,id,name:'Live Example',version:'1.0.0',main:'main.cjs',renderer:'renderer.js',style:'renderer.css',dependencies:options.dependencies??[],actions:[{id:'read',handler:'read',permission:'read',inputSchema:{type:'object',additionalProperties:false}}],tools:[{name:'modmind_'+id.replaceAll('-','_')+'_read',action:'read',description:'Read live build'}],files:Object.fromEntries([...files].map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]))}
 files.set('manifest.json',Buffer.from(JSON.stringify(manifest)))
 const archive=new zip.ZipFile();for(const[name,bytes]of files)archive.addBuffer(bytes,name);archive.end()
 const chunks:Buffer[]=[];for await(const chunk of archive.outputStream)chunks.push(chunk)
 const bytes=Buffer.concat(chunks),sha256=createHash('sha256').update(bytes).digest('hex'),relative=`packages/${id}-${sha256}.zip`
 await fs.mkdir(path.join(root,'packages'),{recursive:true});await fs.writeFile(path.join(root,relative),options.corrupt?Buffer.from('damaged'):bytes)
 let state={version:1,builds:[] as any[]};try{state=JSON.parse(await fs.readFile(path.join(root,'ready.json'),'utf8'))}catch{}
 state.builds=state.builds.filter(build=>build.id!==id);state.builds.push({id,archive:relative,sha256});await fs.writeFile(path.join(root,'ready.json'),JSON.stringify(state))
 return sha256
}
describe('local feature development loading',()=>{
 it('loads a local package, then replaces UI and actual tools without a version bump',async()=>{
  const{root,service,loader}=await fixture();await publish(root,'before');await loader.refresh()
  const previous=service.list()[0].contentHash
  expect(await service.invoke('live-example','read',{})).toBe('before')
  expect(service.tools()[0].name).toBe('modmind_live_example_read')
  await publish(root,'after');await loader.refresh()
  expect(service.list()[0]).toMatchObject({version:'1.0.0',enabled:true})
  expect(service.list()[0].contentHash).not.toBe(previous)
  expect(await service.invoke('live-example','read',{})).toBe('after')
  expect(await(await service.serve(new Request('modmind-feature://live-example/renderer.js?v=latest'))).text()).toContain('after')
 })
 it('defers while a task runs, then loads when the host becomes idle',async()=>{
  const{root,service,loader,host}=await fixture();await publish(root,'before');await loader.refresh()
  await publish(root,'after');host.busy=()=>true;await loader.refresh()
  expect(await service.invoke('live-example','read',{})).toBe('before')
  host.busy=()=>false;await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('after')
 })
 it('preserves the previous version after corrupt or broken new builds, and recovers on the next valid build',async()=>{
  const{root,service,loader}=await fixture();await publish(root,'before');await loader.refresh()
  await publish(root,'damaged',{corrupt:true});await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('before')
  await publish(root,'throws',{code:'exports.activate=()=>{throw new Error("fixture activation failed")}'});await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('before')
  await publish(root,'recovered');await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('recovered')
 })
 it('removes a failing first install and accepts a repaired build',async()=>{
  const{root,service,loader}=await fixture();await publish(root,'broken',{code:'exports.activate=()=>{throw Error("broken")}'});await loader.refresh();expect(service.list()).toEqual([])
  await publish(root,'fixed');await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('fixed')
 })
 it('loads dependencies before retrying their dependent package',async()=>{
  const{root,service,loader}=await fixture();await publish(root,'parent',{dependencies:['live-dependency']});await publish(root,'dependency',{id:'live-dependency'})
  await loader.refresh();expect(service.enabled('live-example')).toBe(false)
  await loader.refresh();expect(service.enabled('live-example')).toBe(true)
 })
 it('ignores unfinished indexes and rejects path escapes',async()=>{
  const{root,service,loader}=await fixture();await fs.writeFile(path.join(root,'ready.json'),'partial');await loader.refresh();expect(service.list()).toEqual([])
  await fs.writeFile(path.join(root,'ready.json'),JSON.stringify({version:1,builds:[{id:'live-example',sha256:'a'.repeat(64),archive:'../../outside.zip'}]}));await loader.refresh();expect(service.list()).toEqual([])
 })
 it('does not unload a busy runtime or load anything after stopping',async()=>{
  const{root,service,loader}=await fixture();await publish(root,'before',{code:'exports.activate=()=>({actions:{read:()=>"before"},isBusy:()=>true})'});await loader.refresh();expect(service.canChange()).toBe(false)
  await publish(root,'after');await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('before')
  loader.stop();await loader.refresh();expect(await service.invoke('live-example','read',{})).toBe('before')
 })
})
