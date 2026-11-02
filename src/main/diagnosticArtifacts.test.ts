import ffmpegPath from 'ffmpeg-static'
import { configureNativeFeatureServices } from './nativeFeatureServices'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import extractZip from 'extract-zip'
import { recordDiagnosticArtifact, recordDiagnosticManifest } from './diagnosticArtifacts'
import { createStoredZip, buildBedrockAddon } from './bedrockAddon'
import { bedrockTemplateFiles } from '../../feature-plugins/studio-mod/src/main/addonTemplates'
import { collectDiagnosticEvidence } from './diagnosticEvidence'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { writeDiagnosticArchive } from './diagnosticDelivery'
import { createResourcePack, deployResourcePack, writeResourcePackFile } from '../../feature-plugins/resource-packs/src/main/resourcePackService'
import { ReleaseService } from '../../feature-plugins/publishing/src/main/releaseService'
import { diagnosticJournal } from './diagnosticLog'
import { runSoundFfmpeg } from '../../feature-plugins/sound-studio/src/main/soundFiles'
import type { ProjectInfo } from '../shared/types'

const roots:string[]=[]
async function project():Promise<ProjectInfo>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'modmind-artifact-diagnostic-')));roots.push(root);return {path:root,name:'Fixture',namespace:'fixture',loader:'fabric',minecraftVersion:'1.21.1',createdAt:''}}
async function records(info:ProjectInfo):Promise<any[]>{const root=path.join(info.path,'.modmind/diagnostic-artifacts');return Promise.all((await fs.readdir(root)).filter(file=>file.endsWith('.json')&&file!=='retention.json').map(async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'))))}
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await diagnosticJournal.flush();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})))})

it('retains all manifest identities beyond the generic twenty-item result limit',async()=>{
 const info=await project();await recordDiagnosticManifest(info,'before-delete',{mods:Array.from({length:45},(_,index)=>({fileName:`mod-${index}.jar`,projectId:`id-${index}`,provider:'modrinth',role:'required',apiKey:'private-key'}))})
 const [value]=await records(info);expect(value.entries).toHaveLength(45);expect(value.entries[44].identity).toMatchObject({fileName:'mod-44.jar',projectId:'id-44',provider:'modrinth',role:'required'});expect(JSON.stringify(value)).not.toContain('private-key')
})
it('reads actual ZIP entries and distinguishes input content from content really archived',async()=>{
 const info=await project(),file=path.join(info.path,'fixture.zip'),expected=Buffer.from('expected'),actual=Buffer.from('actual')
 await fs.writeFile(file,createStoredZip([{name:'file.txt',data:actual}]))
 await recordDiagnosticArtifact(info,'fixture',{outputPath:file,entries:[{name:'file.txt',data:expected}]})
 const [value]=await records(info);expect(value.entries[0].sha256).toBe(createHash('sha256').update(expected).digest('hex'));expect(value.archive.entries[0].sha256).toBe(createHash('sha256').update(actual).digest('hex'))
 const collector=new DiagnosticArchiveCollector();await collectDiagnosticEvidence(collector,{projectPath:info.path,userData:info.path})
 const zip=path.join(info.path,'support.zip');await writeDiagnosticArchive(zip,collector.finalize());await extractZip(zip,{dir:path.join(info.path,'support')})
 expect((await fs.readdir(path.join(info.path,'support/project/evidence/diagnostic-artifacts'))).some(name=>name.endsWith('.json'))).toBe(true)
})
it('records the canonical script version actually packaged by the Bedrock builder',async()=>{
 const info={...await project(),loader:'bedrock' as const,apiVersion:'2.9.0',loaderVersion:'2.9.0'}
 for(const [name,content]of Object.entries(bedrockTemplateFiles(info,true))){const file=path.join(info.path,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content)}
 const source='// diagnostic canonical source fixture\n';await fs.writeFile(path.join(info.path,'src/main.js'),source);await buildBedrockAddon(info)
 const values=await records(info),behavior=values.find(value=>value.operation==='bedrock-pack-written'&&value.metadata.directory?.sha256===createHash('sha256').update('behavior_pack').digest('hex'))??values.find(value=>value.archive?.entries?.some((entry:any)=>entry.name==='scripts/main.js'))
 expect(behavior.archive.entries.find((entry:any)=>entry.name==='scripts/main.js').sha256).toBe(createHash('sha256').update(source).digest('hex'))
 expect(values.some(value=>value.operation==='bedrock-addon-written'&&value.archive.entries.length===2)).toBe(true)
})
it('records saved resource definitions and actual deployed ZIP identity',async()=>{
 const info=await project(),pack=await createResourcePack(info,{name:'Diagnostic',description:'fixture',packFormat:34})
 await writeResourcePackFile(info,pack.id,'assets/fixture/lang/en_us.json','{"item.fixture.a":"A"}',null)
 await deployResourcePack(info,pack.id)
 const values=await records(info),deployed=values.find(value=>value.operation==='resource-archive-deployed')
 expect(deployed.actualOutput.sha256).toBe(deployed.output.sha256);expect(deployed.archive.entries.some((entry:any)=>entry.name==='assets/fixture/lang/en_us.json'&&entry.sha256)).toBe(true)
})
it('keeps the remote object receipt when a later GitHub upload fails without publishing anything online',async()=>{
 const info=await project(),file=path.join(info.path,'fixture.jar');await fs.writeFile(file,createStoredZip([{name:'fixture.class',data:Buffer.from([1,2])}]))
 const service=new ReleaseService(()=>info,async()=>({githubToken:'private-release-key',modrinthToken:'',curseForgeToken:''}),async()=>{})
 await service.saveSettings({version:'1.0.0',displayName:'Fixture',changelog:'',channel:'release',githubRepository:'owner/fixture',modrinthProjectId:'',curseForgeProjectId:''})
 vi.spyOn(service,'preflight').mockResolvedValue({ready:true,artifactPath:file,checks:[]})
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/releases')?new Response(JSON.stringify({id:123,upload_url:'https://uploads.example.test/assets',html_url:'https://example.test/releases/123'})):new Response('{"code":"UPLOAD_REJECTED","message":"private-release-key"}',{status:503,headers:{'x-request-id':'publish-request'}})))
 expect((await service.publish({confirmed:true,targets:['github']}))[0].success).toBe(false)
 const values=await records(info);expect(values.some(value=>value.operation==='publish-github-release-created'&&value.metadata.response.id===123)).toBe(true);expect(values.some(value=>value.operation==='publish-target-failed')).toBe(true);expect(JSON.stringify(values)).not.toContain('private-release-key')
})
it('preserves actual FFmpeg process arguments, exit status and bounded original stderr',async()=>{
 const info=await project();diagnosticJournal.configure(path.join(info.path,'logs')); configureNativeFeatureServices(id => id === 'media-runtime' ? { executable: () => { if (!ffmpegPath) throw new Error('FFmpeg test fixture unavailable'); return ffmpegPath } } : {})
 await expect(runSoundFfmpeg(['-i',path.join(info.path,'missing-input.wav'),'-f','null','-'])).rejects.toThrow('音频处理失败')
 const event=diagnosticJournal.snapshot().filter(event=>event.subsystem==='audio'&&event.operation==='ffmpeg').at(-1)!
 expect(event.phase).toBe('error');expect(JSON.stringify(event)).toContain('missing-input.wav');expect(event.data).toMatchObject({exitCode:expect.any(Number),stderr:expect.any(String)})
})
