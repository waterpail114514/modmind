import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { encodeRGBA } from '../vendor/mc-offline-tool/src/png.mjs'

const require = createRequire(import.meta.url), archiver = require('archiver')
const workspace = path.resolve(import.meta.dirname, '..')
const output = path.join(workspace, 'test-results/mc-offline', String(Date.now()))
await fs.mkdir(output,{recursive:true})
const entry = path.join(output,'entry.ts')
await fs.writeFile(entry,`export {FeaturePluginService,prepareFeaturePlugin} from ${JSON.stringify(path.join(workspace,'src/main/featurePluginService.ts').replaceAll('\\','/'))};export {ModMindBridge} from ${JSON.stringify(path.join(workspace,'src/main/externalAgents.ts').replaceAll('\\','/'))};export {StudioRegistry,configureStudios} from ${JSON.stringify(path.join(workspace,'src/main/studioRegistry.ts').replaceAll('\\','/'))}`)
await build({entryPoints:[entry],outfile:path.join(output,'services.cjs'),bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify(pathToFileURL(path.join(workspace,'src/main/externalAgents.ts')).href)},external:['electron','sharp','ffmpeg-static','7zip-bin'],logLevel:'silent'})
const {FeaturePluginService,prepareFeaturePlugin,ModMindBridge,StudioRegistry,configureStudios}=require(path.join(output,'services.cjs'))
const source = await fs.mkdtemp(path.join(os.tmpdir(),'mc-offline-fixture-'))
const instance = path.join(source,'versions','fixture')
const projectPath = path.join(output,'project')
await fs.mkdir(path.join(instance,'mods'),{recursive:true});await fs.mkdir(projectPath)
await fs.writeFile(path.join(source,'paths.json'),'{}')
process.env.MODMIND_PATHS_CONFIG=path.join(source,'paths.json');process.env.PREVIEW_MC=source
for(const name of ['PREVIEW_INSTANCE','PREVIEW_DATA','PREVIEW_REGISTRY','PREVIEW_PULL_REGISTRY','PREVIEW_PROBE_DIR','PREVIEW_PROBE_JAR'])delete process.env[name]
const rgba=Buffer.alloc(16*16*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=38;rgba[i+1]=157;rgba[i+2]=86;rgba[i+3]=255}
const faces=Object.fromEntries(['north','south','east','west','up','down'].map(face=>[face,{texture:'#all'}]))
async function jar(name='离线测试方块'){
  const entries={
    'version.json':JSON.stringify({id:'1.20.1',world_version:3465}),
    'assets/fixture/lang/en_us.json':JSON.stringify({'block.fixture.cube':'Fixture cube','item.fixture.tool':'Fixture tool'}),
    'assets/fixture/lang/zh_cn.json':JSON.stringify({'block.fixture.cube':name,'item.fixture.tool':'测试工具'}),
    'assets/fixture/blockstates/cube.json':JSON.stringify({variants:{'':{model:'fixture:block/cube'}}}),
    'assets/fixture/models/block/cube.json':JSON.stringify({parent:'fixture:block/base',textures:{all:'fixture:block/cube'}}),
    'assets/fixture/models/block/base.json':JSON.stringify({textures:{all:'fixture:block/parent_texture_must_be_overridden'},elements:[{from:[0,0,0],to:[16,16,16],faces}]}),
    'assets/fixture/textures/block/cube.png':encodeRGBA(16,16,rgba),
    'assets/fixture/textures/item/tool.png':encodeRGBA(16,16,rgba)
  }
  await new Promise((resolve,reject)=>{const out=createWriteStream(path.join(instance,'fixture.jar')),zip=archiver('zip');out.on('close',resolve);out.on('error',reject);zip.on('error',reject);zip.pipe(out);for(const[name,data]of Object.entries(entries))zip.append(data,{name});void zip.finalize().catch(reject)})
  await fs.writeFile(path.join(instance,'fixture.json'),JSON.stringify({id:'fixture',type:'release',inheritsFrom:'1.20.1'}))
}
await jar()
const project={name:'离线采集测试',path:projectPath,kind:'mod',studioId:'minecraft-mod',loader:'fabric',minecraftVersion:'1.20.1',namespace:'qa',createdAt:new Date().toISOString()}
await fs.writeFile(path.join(projectPath,'modmind.project.json'),JSON.stringify(project))
const service = new FeaturePluginService(path.join(output,'plugins'),{requireFrom:path.join(workspace,'package.json'),capabilities:{runtime:{},studioV1:true},options:()=>({}),busy:()=>false,changed:()=>{},projectRoot:()=>projectPath,project:()=>project})
await service.initialize(['studio-mod','studio-modpack','studio-server-plugin'].map(id=>({id,directory:path.join(workspace,'resources/bundled-studios',id)})))
configureStudios(new StudioRegistry(()=>service.catalog(),id=>service.service(id),(id,group)=>service.assetDirectory(id,group),(id,action,input,context)=>service.invoke(id,action,input,context)))
for(const id of ['mc-pull','mc-preview'])await service.install(await prepareFeaturePlugin(path.join(workspace,'feature-plugin-dist',id+'.mmfeature')))
const invoke=(id,action,input={})=>service.invoke(id,action,input,{projectPath,surface:'workbench'})

test('handoff packages: real capture, project-scoped preview, scene assets, format round trips, MCP and export',async()=>{
  let bridge, child, reader
  try{
    await assert.rejects(invoke('mc-preview','preview:items'),/方块资源|资源来源/)
    const captured=await invoke('mc-pull','pull:run',{instanceDir:instance})
    assert.equal(captured.count,2)
    const items=await invoke('mc-preview','preview:items',{limit:1})
    assert.equal(items.count,2);assert.equal(items.nextOffset,1)
    const blocks=await invoke('mc-preview','preview:items',{query:'cube'})
    assert.equal(blocks.items[0].block,true);assert.equal(blocks.items[0].name,'离线测试方块')
    const icons=await invoke('mc-preview','preview:icons',{ids:['fixture:cube']})
    assert.match(icons.icons['fixture:cube'],/^data:image\/png;base64,/)
    const scene=await invoke('mc-preview','preview:scene',{states:['fixture:cube']})
    assert.ok(scene.models['fixture:block/cube']);assert.equal(scene.missing.length,0);assert.match(scene.atlas,/^data:image\/png;base64,/)
    assert.ok(scene.uv['fixture:block/cube'],'child model texture overrides its parent')
    assert.match(scene.key,/^[a-f0-9]{64}$/)
    assert.equal(scene.dataVersion,3465)
    const building={name:'Fixture building',dataVersion:3465,size:[2,1,1],palette:[{Name:'fixture:cube',Properties:{}}],blocks:[{pos:[0,0,0],state:0},{pos:[1,0,0],state:0}]}
    for(const format of ['schem','litematic']){
      const exported=await invoke('mc-preview','preview:export',{format,build:building})
      const imported=await invoke('mc-preview','preview:import',{name:exported.filename,dataBase64:exported.dataBase64})
      assert.equal(imported.build.blocks.length,2);assert.deepEqual(imported.build.size,[2,1,1])
      assert.equal(imported.build.dataVersion,3465);assert.ok(imported.build.original.dataBase64)
      await fs.writeFile(path.join(output,'fixture.'+format),Buffer.from(exported.dataBase64,'base64'))
    }
    const created=await invoke('mc-preview','preview:save',{operation:'create',build:building})
    const id=created.document.id
    const read=await invoke('mc-preview','preview:documents',{id})
    assert.deepEqual(read.document.build.blocks,building.blocks)
    await assert.rejects(invoke('mc-preview','preview:save',{operation:'save',id,expectedRevision:99,build:building}),/更新/)
    await assert.rejects(service.invoke('mc-preview','preview:save',{operation:'create',build:building},{projectPath,readOnly:true,surface:'workbench'}),/READ_ONLY/)
    await assert.rejects(invoke('mc-preview','preview:save',{operation:'create',build:building,projectPath:source}),/项目已经切换/)
    await assert.rejects(invoke('mc-preview','preview:export',{format:'schem',build:{...building,dataVersion:null}}),/版本/)
    await assert.rejects(invoke('mc-preview','preview:import',{name:'broken.nbt',dataBase64:Buffer.from([10,0,0,10,0,0]).toString('base64')}),/不完整/)
    await assert.rejects(invoke('mc-preview','preview:export',{format:'schem',build:{...building,losses:['1 个方块实体的数据不会写入导出文件']}}),/不能导出/)
    for(let i=0;i<rgba.length;i+=4){rgba[i]=180;rgba[i+1]=50;rgba[i+2]=30}
    await jar('更新后的测试方块');await invoke('mc-pull','pull:run',{instanceDir:instance})
    assert.equal((await invoke('mc-preview','preview:items',{query:'cube'})).items[0].name,'更新后的测试方块')
    assert.notEqual((await invoke('mc-preview','preview:icons',{ids:['fixture:cube']})).icons['fixture:cube'],icons.icons['fixture:cube'])
    assert.notEqual((await invoke('mc-preview','preview:scene',{states:['fixture:cube']})).atlas,scene.atlas)
    await assert.rejects(invoke('mc-pull','pull:clear',{key:'../outside'}),/校验|名称|参数/)
    await assert.rejects(invoke('mc-pull','pull:run',{instanceDir:instance,projectPath:source}),/项目已经切换/)
    await assert.rejects(service.invoke('mc-pull','pull:run',{instanceDir:instance},{projectPath,readOnly:true,surface:'workbench'}),/READ_ONLY/)
    bridge=new ModMindBridge(project,{featureCatalog:async()=>service.catalog(),featureTools:async surface=>service.tools(surface),featureInvoke:async(id,action,input,context)=>service.invoke(id,action,input,context)},'mc-offline-qa')
    const config=await bridge.start()
    child=spawn(process.execPath,[path.join(path.dirname(config.mcpConfigPath),'modmind-mcp-server.mjs')],{stdio:['pipe','pipe','ignore'],windowsHide:true})
    reader=createInterface({input:child.stdout});let sequence=0;const pending=new Map()
    reader.on('line',line=>{const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id)})
    const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('MCP timeout')),30000);pending.set(id,r=>{clearTimeout(timer);resolve(r)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
    await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'mc-offline-qa',version:'1'}})
    const tools=await rpc('tools/list');assert.ok(tools.result.tools.some(t=>t.name==='modmind_mc_preview_items'),JSON.stringify(tools.result.tools.map(t=>t.name)))
    const queried=await rpc('tools/call',{name:'modmind_mc_preview_items',arguments:{query:'cube'}})
    assert.ok(!queried.result.isError,JSON.stringify(queried));assert.equal(JSON.parse(queried.result.content[0].text).items[0].name,'更新后的测试方块')
    const saved=await rpc('tools/call',{name:'modmind_mc_preview_save',arguments:{operation:'rename',id,expectedRevision:1,name:'MCP 建筑'}})
    assert.ok(!saved.result.isError,JSON.stringify(saved))
    const reread=await rpc('tools/call',{name:'modmind_mc_preview_documents',arguments:{id}})
    assert.ok(!reread.result.isError,JSON.stringify(reread));assert.equal(JSON.parse(reread.result.content[0].text).document.name,'MCP 建筑')
    assert.equal(JSON.parse(reread.result.content[0].text).document.revision,2)
    assert.ok((await fs.stat(path.join(projectPath,'structures',id+'.modmind.json.bak'))).size>0)
    const archived=await rpc('tools/call',{name:'modmind_mc_capture_export',arguments:{key:captured.key}})
    assert.ok(!archived.result.isError,JSON.stringify(archived));const file=JSON.parse(archived.result.content[0].text).file;assert.ok((await fs.stat(file)).size>500)
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify({captured,scene:scene.stats,query:queried.result,export:archived.result,sourceFixture:instance},null,2))
    console.log(output)
  }finally{child?.kill();reader?.close();await bridge?.stop();await service.shutdown();await fs.rm(source,{recursive:true,force:true})}
})
