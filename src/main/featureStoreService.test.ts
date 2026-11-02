import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { ProjectInfo } from '../shared/types'
import { FeaturePluginService } from './featurePluginService'
import { FeatureStoreService, validateOfficialFeatureIndex } from './featureStoreService'
import { httpTransport } from './networkRequest'
import { featureGroups, OFFICIAL_FEATURE_INDEX, type OfficialFeatureIndex, type OfficialFeatureRelease } from '../shared/featureStore'
import type { FeaturePluginDefinition, FeaturePluginManifest } from '../shared/featurePlugins'

const require=createRequire(import.meta.url), archiver=require('archiver')
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const dispose of cleanup.splice(0).reverse())await dispose()})
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
async function bundle(id='test-feature',version='1.0.0',dependencies:string[]=[],code?:string){
  const definition:FeaturePluginDefinition={format:'modmind-feature',apiVersion:2,hostVersion:'1.5.0-plugintest',id,name:id,version,main:'main.cjs',renderer:'renderer.js',style:'renderer.css',dependencies,views:[],actions:[{id:'hello',handler:'hello',permission:'read',inputSchema:{type:'object',additionalProperties:false}}],tools:[{name:`modmind_${id.replaceAll('-','_')}_hello`,action:'hello',description:'Read installed version'}]}
  const files=new Map([['main.cjs',Buffer.from(code??`exports.activate=()=>({actions:{hello:()=>({version:${JSON.stringify(version)}})}})`)],['renderer.js',Buffer.from('')],['renderer.css',Buffer.from('')]])
  const manifest:FeaturePluginManifest={...definition,files:Object.fromEntries([...files].map(([key,value])=>[key,digest(value)]))};files.set('manifest.json',Buffer.from(JSON.stringify(manifest)))
  const zip=archiver('zip'),chunks:Buffer[]=[]
  const bytes=await new Promise<Buffer>((resolve,reject)=>{zip.on('data',(chunk:Buffer)=>chunks.push(chunk));zip.on('end',()=>resolve(Buffer.concat(chunks)));zip.on('error',reject);for(const[name,value]of files)zip.append(value,{name});void zip.finalize()})
  const sha256=digest(bytes)
  const release:OfficialFeatureRelease={id,name:id,description:'用于当前任务的测试功能',version,hostVersion:definition.hostVersion,apiVersion:2,sha256,size:bytes.length,path:`features/packages/${id}/${version}/${sha256}.mmfeature`,publishedAt:'2026-10-01T00:00:00.000Z',changelog:['Updated'],dependencies,groups:featureGroups(definition)}
  return{definition,manifest,files,bytes,release}
}
async function harness(bundles:Awaited<ReturnType<typeof bundle>>[]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-feature-store-'))
  cleanup.push(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
  let index:OfficialFeatureIndex={format:'modmind-feature-catalog',schemaVersion:1,generatedAt:'2026-10-01T00:00:00.000Z',features:bundles.map(value=>value.release)},offline=false,busy=false,slow=false
  const files=new Map(bundles.map(value=>['/'+value.release.path,value.bytes])),requests:Array<{method:string|undefined;path:string;authorization:string|undefined}>=[]
  const server=createServer((request,response)=>{
    requests.push({method:request.method,path:request.url??'',authorization:request.headers.authorization})
    if(offline){response.writeHead(403);response.end('Forbidden');return}
    if(request.url==='/'+OFFICIAL_FEATURE_INDEX){response.setHeader('content-type','application/json');response.end(JSON.stringify(index));return}
    const bytes=files.get(request.url??'');if(!bytes){response.writeHead(404);response.end();return}
    response.setHeader('content-length',bytes.length)
    if(slow){response.write(bytes.subarray(0,20));const timer=setTimeout(()=>response.end(bytes.subarray(20)),2000);response.on('close',()=>clearTimeout(timer))}else response.end(bytes)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  const port=(server.address()as{port:number}).port,transport=httpTransport.request
  vi.spyOn(httpTransport,'request').mockImplementation((url,options)=>transport(`http://127.0.0.1:${port}${new URL(url).pathname}`,options))
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
  const manager=new FeaturePluginService(path.join(root,'plugins'),{requireFrom:path.resolve('package.json'),catalog:bundles.map(value=>value.definition),capabilities:{},options:()=>({}),changed:()=>undefined,busy:()=>busy})
  await manager.initialize()
  const store=new FeatureStoreService(path.join(root,'cache'),manager,()=>undefined);await store.initialize()
  return{root,manager,store,files,requests,setBusy:(value:boolean)=>{busy=value},setSlow:()=>{slow=true},setOffline:()=>{offline=true},setIndex:(value:OfficialFeatureIndex)=>{index=value},publish:async(next:Awaited<ReturnType<typeof bundle>>)=>{files.set('/'+next.release.path,next.bytes);index.features=index.features.filter(item=>item.id!==next.release.id).concat(next.release);now+=6000;await store.refresh(true)},refresh:()=>{now+=6000;return store.refresh(true)}}
}
describe('official feature downloads',()=>{
  it('prompts on a withdrawn official installation without disabling or removing it, including after restart',async()=>{
    const feature=await bundle(),h=await harness([feature]);await h.store.installOfficial('test-feature')
    await fs.writeFile(path.join(h.root,'project-content.txt'),'keep project content')
    h.setIndex({format:'modmind-feature-catalog',schemaVersion:1,generatedAt:'2026-11-01T00:00:00.000Z',features:[]});await h.refresh()
    expect(h.store.snapshot().entries.find(entry=>entry.id==='test-feature')).toMatchObject({installationSource:'official',withdrawn:true,installed:true,available:true})
    expect(await h.manager.invoke('test-feature','hello',{})).toEqual({version:'1.0.0'})
    expect(await fs.readFile(path.join(h.root,'project-content.txt'),'utf8')).toBe('keep project content')
    const restarted=new FeatureStoreService(path.join(h.root,'cache'),h.manager,()=>undefined);await restarted.initialize()
    expect(restarted.snapshot().entries.find(entry=>entry.id==='test-feature')?.withdrawn).toBe(true)
    await h.publish(feature)
    expect(h.store.snapshot().entries.find(entry=>entry.id==='test-feature')?.withdrawn).toBe(false)
    expect(h.manager.enabled('test-feature')).toBe(true)
  })
  it('keeps local imports out of withdrawal notices even when their ID also appears in the official directory',async()=>{
    const feature=await bundle(),h=await harness([feature])
    await h.manager.install({manifest:feature.manifest,files:feature.files});await h.refresh()
    expect(h.store.snapshot().entries.find(entry=>entry.id==='test-feature')).toMatchObject({installationSource:'local',withdrawn:false})
    h.setIndex({format:'modmind-feature-catalog',schemaVersion:1,generatedAt:'2026-11-01T00:00:00.000Z',features:[]});await h.refresh()
    expect(h.store.snapshot().entries.find(entry=>entry.id==='test-feature')).toMatchObject({installationSource:'local',withdrawn:false,available:true})
    const offline=await bundle('offline-feature');await h.manager.install({manifest:offline.manifest,files:offline.files});h.setOffline();await h.refresh()
    expect(h.store.snapshot().entries.find(entry=>entry.id==='offline-feature')).toMatchObject({installationSource:'local',withdrawn:false,available:true})
  })
  it('does not call a changed local replacement an official or withdrawn package',async()=>{
    const feature=await bundle(),h=await harness([feature]);await h.store.installOfficial('test-feature')
    const local=await bundle('test-feature','1.1.0');await h.manager.update({manifest:local.manifest,files:local.files})
    h.setIndex({format:'modmind-feature-catalog',schemaVersion:1,generatedAt:'2026-11-01T00:00:00.000Z',features:[]});await h.refresh()
    expect(h.store.snapshot().entries.find(entry=>entry.id==='test-feature')).toMatchObject({installationSource:'local',withdrawn:false,version:'1.1.0',available:true})
  })
  it('downloads verified dependencies with GET only and keeps existing functionality when the source is offline',async()=>{
    const base=await bundle('support-runtime'),feature=await bundle('test-feature','1.0.0',['support-runtime']),h=await harness([base,feature])
    await h.refresh();expect(h.store.snapshot().entries).toHaveLength(2)
    await h.store.installOfficial('test-feature')
    expect(h.manager.catalog().every(entry=>entry.available)).toBe(true)
    expect(h.requests.every(request=>request.method==='GET'&&!request.authorization)).toBe(true)
    expect(h.requests.filter(request=>request.path.endsWith('.mmfeature')).map(request=>request.path)).toEqual(['/'+base.release.path,'/'+feature.release.path])
    h.setOffline();await h.refresh();expect(h.store.snapshot()).toMatchObject({cached:true,error:expect.stringContaining('未开放')});expect(h.manager.enabled('test-feature')).toBe(true)
    const restored=new FeatureStoreService(path.join(h.root,'cache'),h.manager,()=>undefined);await restored.initialize();expect(restored.snapshot().entries).toHaveLength(2)
  })
  it('only recommends in manual mode; automatically installs in beginner mode while preserving the busy gate for replacements',async()=>{
    const feature=await bundle(),h=await harness([feature]);const input={recommendations:[{id:'test-feature',reason:'读取此任务所需的功能数据'}]}
    const manual=await h.store.recommend(input,false);expect(manual.recommendations[0].status).toBe('manual');expect(h.requests.some(request=>request.path.endsWith('.mmfeature'))).toBe(false)
    h.setBusy(true)
    const automatic=await h.store.recommend(input,true);expect(automatic.recommendations[0].status).toBe('installed');expect(automatic.tools[0].name).toBe('modmind_test_feature_hello')
    await expect(h.manager.uninstall('test-feature')).rejects.toThrow('等待')
    expect((await h.store.recommend(input,true)).recommendations[0].status).toBe('ready')
    await expect(h.store.recommend({recommendations:[{id:'unknown',reason:'unknown'}]},true)).rejects.toThrow('官方目录')
    await expect(h.store.recommend({recommendations:[{id:'test-feature',reason:'reason'}],automatic:true},false)).rejects.toThrow('推荐清单')
  })
  it('identifies updates and restores the old runtime if the replacement fails to load',async()=>{
    const feature=await bundle(),h=await harness([feature]);await h.store.installOfficial('test-feature')
    await fs.writeFile(path.join(h.root,'saved-user-project.txt'),'keep')
    const bad=await bundle('test-feature','1.1.0',[],'exports.activate=()=>{throw Error("broken new runtime")}');await h.publish(bad)
    expect(h.store.snapshot().entries[0].updateAvailable).toBe(true)
    await expect(h.store.installOfficial('test-feature')).rejects.toThrow('broken new runtime')
    expect(h.manager.list()[0].version).toBe('1.0.0')
    expect(await h.manager.invoke('test-feature','hello',{})).toEqual({version:'1.0.0'})
    const good=await bundle('test-feature','1.1.1');await h.publish(good);await h.store.installOfficial('test-feature')
    expect(await h.manager.invoke('test-feature','hello',{})).toEqual({version:'1.1.1'})
    expect(await fs.readFile(path.join(h.root,'saved-user-project.txt'),'utf8')).toBe('keep')
    await h.manager.setEnabled('test-feature',false)
    await h.publish(await bundle('test-feature','1.1.2'));await h.store.installOfficial('test-feature')
    expect(h.manager.list()[0]).toMatchObject({version:'1.1.2',enabled:false})
  })
  it('rejects corrupted downloads and incompatible releases without installing them',async()=>{
    const feature=await bundle(),h=await harness([feature]);h.files.set('/'+feature.release.path,Buffer.alloc(feature.bytes.length,1))
    await expect(h.store.installOfficial('test-feature')).rejects.toThrow(/hash|mismatch/i);expect(h.manager.list()).toEqual([])
    h.files.set('/'+feature.release.path,feature.bytes);await h.store.installOfficial('test-feature');expect(h.manager.enabled('test-feature')).toBe(true)
    const release={...feature.release,target:{platform:'unsupported',arch:'invalid'}};h.setIndex({format:'modmind-feature-catalog',schemaVersion:1,generatedAt:new Date().toISOString(),features:[release]});await h.refresh()
    await expect(h.store.installOfficial('test-feature')).rejects.toThrow('不支持');expect(h.manager.enabled('test-feature')).toBe(true)
  })
  it('cancels an in-flight download and cleans staging files',async()=>{
    const h=await harness([await bundle()]);await h.refresh();h.setSlow();const install=h.store.installOfficial('test-feature');void install.catch(()=>undefined)
    await vi.waitFor(()=>expect(h.store.snapshot().job?.downloaded).toBeGreaterThan(0));h.store.cancel();await expect(install).rejects.toThrow();expect(h.store.snapshot().job?.phase).toBe('cancelled');expect(h.manager.list()).toEqual([])
    expect((await fs.readdir(path.join(h.root,'cache'))).some(name=>name.startsWith('download-'))).toBe(false)
  })
  it('rejects catalogue path escapes, missing dependencies, duplicates and dependency cycles',async()=>{
    const a=await bundle('a-feature'),b=await bundle('b-feature');const index={format:'modmind-feature-catalog',schemaVersion:1,generatedAt:new Date().toISOString(),features:[a.release,b.release]}
    expect(()=>validateOfficialFeatureIndex({...index,features:[{...a.release,path:'https://other.test/payload'}]})).toThrow('路径')
    expect(validateOfficialFeatureIndex({...index, features: [{...a.release, path: a.release.path.replace(/\.mmfeature$/, '.mmstudio')}]}).features[0].path).toMatch(/\.mmstudio$/)
    expect(()=>validateOfficialFeatureIndex({...index,features:[{...a.release,dependencies:['absent']}]})).toThrow('缺少')
    expect(()=>validateOfficialFeatureIndex({...index,features:[a.release,a.release]})).toThrow('重复')
    expect(()=>validateOfficialFeatureIndex({...index,features:[{...a.release,dependencies:['b-feature']},{...b.release,dependencies:['a-feature']}]})).toThrow('循环')
  })
  it('retains the studio extension during verified downloads and rejects a package without a domain declaration', async () => {
    const feature = await bundle(), h = await harness([feature])
    const release = { ...feature.release, path: feature.release.path.replace(/\.mmfeature$/, '.mmstudio') }
    h.files.set('/' + release.path, feature.bytes)
    h.setIndex({ format: 'modmind-feature-catalog', schemaVersion: 1, generatedAt: new Date().toISOString(), features: [release] })
    await h.refresh()
    await expect(h.store.installOfficial(release.id)).rejects.toThrow('未声明领域工作台')
    expect(h.manager.list()).toEqual([])
  })
  it('recommends, installs and calls a new feature through real MCP in one session, while rejecting installation from inspiration',async()=>{
    const h=await harness([await bundle()]),children:ChildProcessWithoutNullStreams[]=[],bridges:ModMindBridge[]=[]
    const project={path:h.root,name:'Official feature test',namespace:'official_feature',loader:'fabric',minecraftVersion:'1.21.1',createdAt:''}as ProjectInfo
    let automatic=false
    const handlers={projectInfo:project,featureCatalog:async()=>h.store.agentCatalog(),featureTools:async(surface:'workbench'|'inspiration')=>h.manager.tools(surface),featureInvoke:(id:string,action:string,input:Record<string,unknown>,context:object)=>h.manager.invoke(id,action,input,context),featureRecommend:(input:unknown)=>h.store.recommend(input,automatic),reviewAction:async()=>({approved:true,complete:true,risk:'low',dangerousOperations:[],feedback:''})}as unknown as ExternalAgentBridgeHandlers
    const connect=async(readOnly=false)=>{
      const bridge=new ModMindBridge(project,handlers,'test',undefined,readOnly,readOnly?'inspiration':'workbench');bridges.push(bridge)
      const{mcpConfigPath}=await bridge.start();await bridge.writeMcpConfig(mcpConfigPath)
      const config=JSON.parse(await fs.readFile(mcpConfigPath,'utf8')).mcpServers.modmind
      const child=spawn(config.command,config.args,{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child)
      let sequence=0,buffer='';const pending=new Map<number,(result:any)=>void>()
      child.stdout.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n'))>=0){const result=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(result.id)?.(result);pending.delete(result.id)}})
      return(method:string,params?:object)=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error('MCP timeout')),10000);pending.set(id,result=>{clearTimeout(timer);resolve(result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
    }
    try{
      const rpc=await connect(),call=(name:string,args:object)=>rpc('tools/call',{name,arguments:args}),input={recommendations:[{id:'test-feature',reason:'完成当前任务需要读取此功能的数据'}]}
      expect((await rpc('tools/list')).result.tools.some((tool:{name:string})=>tool.name==='modmind_recommend_features')).toBe(true)
      expect(JSON.parse((await call('modmind_recommend_features',input)).result.content[0].text).mode).toBe('manual');expect(h.manager.list()).toEqual([])
      automatic=true;h.setBusy(true)
      const recommended=await call('modmind_recommend_features',input)
      expect(recommended.result.isError).toBeUndefined();expect(JSON.parse(recommended.result.content[0].text).recommendations[0].status).toBe('installed')
      const result=await call('modmind_feature_call',{tool:'modmind_test_feature_hello',input:{}})
      expect(result.result.isError).toBeUndefined();expect(JSON.parse(result.result.content[0].text)).toEqual({version:'1.0.0'})
      const inspiration=await connect(true)
      expect((await inspiration('tools/list')).result.tools.some((tool:{name:string})=>tool.name==='modmind_recommend_features')).toBe(false)
      expect((await inspiration('tools/call',{name:'modmind_recommend_features',arguments:input})).result.isError).toBe(true)
    }finally{for(const child of children)child.kill();for(const bridge of bridges)await bridge.stop()}
  },20000)
})
