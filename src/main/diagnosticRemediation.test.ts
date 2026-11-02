import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnosticArguments, diagnosticContext, diagnosticValue } from './diagnosticContext'
import { DiagnosticJournal, diagnosticJournal } from './diagnosticLog'
import { DiagnosticHistory } from './diagnosticHistory'
import { DiagnosticOperations } from './diagnosticOperations'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { collectDiagnosticEvidence } from './diagnosticEvidence'
import { DiagnosticAttachments, exportRecoveryDiagnostics, writeDiagnosticArchive } from './diagnosticDelivery'
import { verifiedDiagnosticWrite } from './diagnosticFiles'
import { readDiagnosticState } from './diagnosticState'
import { installNetworkDiagnostics, readDiagnosticNodeResponse, readDiagnosticResponse } from './networkDiagnostics'
import { DownloadManager } from './downloadService'
import { writeSettingsFile } from './settingsFile'
import { GameControlActions } from '../../feature-plugins/testing/src/main/gameControlActions'
import sharp from 'sharp'
import type { BackgroundGameState } from '../../feature-plugins/testing/src/main/gameControlSession'
import { WorkbenchDataStore } from './workbenchDataStore'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'

const roots: string[] = []
async function temporary(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-fix-')); roots.push(root); return root }
async function put(root: string, name: string, text: string): Promise<string> { const file = path.join(root,name); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,text); return file }
afterEach(async () => { await diagnosticJournal.flush(); await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}))) })

describe('Diagnostic coverage remediation', () => {
  it('keeps diagnostic argument names synchronized with all production IPC handlers', () => {
    expect(execFileSync(process.execPath,['scripts/sync-diagnostic-arguments.mjs'],{encoding:'utf8'})).toContain('verified')
    expect(diagnosticArguments('snapshots:restore',['snapshot-A','D:/background'])).toEqual({id:'snapshot-A',projectPath:'D:/background'})
    expect(diagnosticArguments('itemEditor:save',['D:/background',{id:'a',revision:2}])).toMatchObject({projectPath:'D:/background',input:{id:'a',revision:2}})
  })
  it('retains object identities and hashes without leaking arbitrary contents, credentials or signed URLs', () => {
    const summary = diagnosticArguments('project:writeFile', ['src/A.java','private source', 'D:/project'])
    expect(summary).toMatchObject({relativePath:'src/A.java',projectPath:'D:/project',content:{chars:14,sha256:expect.any(String)}})
    expect(JSON.stringify(summary)).not.toContain('private source')
    const value = diagnosticValue({ apiKey:'secret-value', prompt:'private prompt', url:'https://user:password@example.test/a?token=secret-value' })
    expect(JSON.stringify(value)).not.toContain('secret-value'); expect(JSON.stringify(value)).not.toContain('private prompt')
    expect(JSON.stringify(value)).not.toContain('password')
  })
  it('correlates child failures with their parent operation and records failed result payloads', async () => {
    const journal = new DiagnosticJournal(), operations = new DiagnosticOperations(journal)
    await operations.run('ipc','parent',{path:'A'},()=>operations.run('ipc','child',{},async()=>{ expect(diagnosticContext.getStore()?.operation).toBe('child'); return {success:false,error:'INVALID_ITEM: missing texture',path:'textures/a.png'} }))
    const events = journal.snapshot()
    const parent = events.find(event=>event.operation==='parent'&&event.phase==='start')!
    const child = events.find(event=>event.operation==='child'&&event.phase==='result-error')!
    expect(child.data).toMatchObject({parentRequestId:(parent.data as {requestId:string}).requestId,result:{error:'INVALID_ITEM: missing texture',path:'textures/a.png'}})
    expect(diagnosticContext.getStore()).toBeUndefined()
  })
  it('keeps critical incidents across days and ordinary rotations; survives a recorder restart', async () => {
    const root=await temporary(); let now=Date.parse('2026-10-01T12:00:00Z')
    const history=new DiagnosticHistory(path.join(root,'history'),1024,()=>now)
    history.record({time:new Date(now).toISOString()})
    now+=86400000; history.record({time:new Date(now).toISOString()})
    expect(await fs.readdir(path.join(root,'history'))).toContain('2026-10-01.jsonl')
    for(let i=0;i<50;i++)history.record({time:String(i)+'x'.repeat(200)})
    const next=new DiagnosticHistory(path.join(root,'history'),1024,()=>now)
    expect(next.status().rotations).toBeGreaterThan(0)
    const journal=new DiagnosticJournal({maxFileBytes:256*1024}); journal.configure(path.join(root,'journal'))
    journal.recordCritical({subsystem:'process',operation:'failure',message:'preserved-incident'})
    for(let i=0;i<40;i++){journal.record({subsystem:'noise',operation:'output',message:'x'.repeat(30000)});await journal.flush()}
    const retained=await fs.readFile(path.join(root,'journal','diagnostic-history',new Date().toISOString().slice(0,10)+'.jsonl'),'utf8')
    expect(retained).toContain('preserved-incident')
  })
  it('collects actual scenario, assertion, conversation and snapshot evidence and streams a readable ZIP', async () => {
    const root=await temporary(), project=path.join(root,'project'), userData=path.join(root,'profile')
    await put(project,'.modmind/server/scenarios/a/server.log','ACTUAL_SCENARIO_REASON\n')
    await put(project,'.modmind/creation/evidence/a.txt','ACTUAL_ASSERTION\n')
    await put(project,'.modmind/workbench-journal/a/events.jsonl','{"reason":"ACTUAL_REPLAY"}\n')
    await put(project,'.modmind/snapshots/a/snapshot.json','{"hash":"ACTUAL_SNAPSHOT"}')
    await put(project,'src/main/resources/assets/a/models/item.json','{"parent":"item/generated"}')
    await put(project,'src/secret-settings.json','{"apiKey":"should-not-export"}')
    const normalized=path.resolve(project).replaceAll('\\','/'); const identity=createHash('sha256').update(process.platform==='win32'?normalized.toLowerCase():normalized).digest('hex').slice(0,24)
    await put(userData,`workbench-journal/${identity}/a/events.jsonl`,'{"reason":"MIRROR_REPLAY"}\n')
    const collector=new DiagnosticArchiveCollector()
    await collectDiagnosticEvidence(collector,{projectPath:project,userData})
    const entries=collector.finalize(), content=entries.map(entry=>entry.data.toString('utf8')).join('\n')
    for(const marker of ['ACTUAL_SCENARIO_REASON','ACTUAL_ASSERTION','ACTUAL_REPLAY','ACTUAL_SNAPSHOT','MIRROR_REPLAY'])expect(content).toContain(marker)
    expect(content).not.toContain('should-not-export')
    expect(content).toContain('src/main/resources/assets/a/models/item.json')
    const zip=path.join(root,'support.zip'), extracted=path.join(root,'extracted')
    await writeDiagnosticArchive(zip,entries); await extractZip(zip,{dir:extracted})
    expect(await fs.readFile(path.join(extracted,'project/evidence/server/scenarios/a/server.log'),'utf8')).toContain('ACTUAL_SCENARIO_REASON')
  })
  it('exports captured game pixels with frame identity and the actual action receipt', async () => {
    const root=await temporary(),project=path.join(root,'project'),directory=path.join(project,'.modmind/player-tests/fixture-session')
    const state: BackgroundGameState={protocol:1,pid:123,family:'glfw',active:true,ready:true,frameId:3,actionSequence:0,width:16,height:16,logicalWidth:16,logicalHeight:16,lastPumpAgeMs:0,keysDown:[],buttonsDown:[],hookClasses:1,physicalCallbacksFiltered:true,error:null,coordinateRevision:'geometry-1',ownership:'ai'}
    const image=await sharp({create:{width:16,height:16,channels:3,background:'#000000'}}).png().toBuffer()
    const transport={sessionId:randomUUID(),status:async()=>state,sync:async()=>state,input:async()=>({dispatched:true as const,actionSequence:1}),capture:async()=>({...state,capturedAt:Date.now(),image,mimeType:'image/png' as const}),release:async()=>{},settle:async()=>({settled:true as const,frameId:4,actionSequence:1}),ownership:async()=>state}
    const actions=new GameControlActions(transport,directory)
    const frame=await actions.capture();await actions.action({operation:'wait',durationMs:1})
    const collector=new DiagnosticArchiveCollector();await collectDiagnosticEvidence(collector,{projectPath:project,userData:root})
    const entries=collector.finalize();expect(entries.some(entry=>entry.name.endsWith(path.basename(frame.path)))).toBe(true)
    const activity=entries.filter(entry=>entry.name.includes('/activity/')).map(entry=>entry.data.toString('utf8')).join('')
    expect(activity).toContain('geometry-1');expect(activity).toContain('action-result');expect(activity).toContain('"pid":123')
    expect(activity).not.toContain('data:image/png;base64')
  })
  it('collects real knowledge files and compressed conversation replicas produced by business stores', async () => {
    const root=await temporary(),project=path.join(root,'project'),profile=path.join(root,'profile')
    await fs.mkdir(path.join(project,'.modmind'),{recursive:true})
    const store=new WorkbenchDataStore(profile),knowledge=new InspirationKnowledgeStore(path.join(profile,'inspiration-knowledge'))
    await store.write(project,'.modmind/workbench-timeline-fixture.json','[{"id":"fixture","content":"dialogue evidence"}]')
    await knowledge.update(project,{title:'fixture knowledge',content:'REAL_KNOWLEDGE_EVIDENCE'})
    const collector=new DiagnosticArchiveCollector();await collectDiagnosticEvidence(collector,{projectPath:project,userData:profile})
    const entries=collector.finalize()
    expect(entries.some(entry=>entry.name.startsWith('project/evidence/workbench-store/')&&entry.name.endsWith('.snapshot.gz'))).toBe(true)
    expect(entries.some(entry=>entry.name.startsWith('app-runtime/project-evidence/workbench-mirror/')&&entry.name.endsWith('.snapshot.gz'))).toBe(true)
    expect(entries.find(entry=>entry.name.endsWith('inspiration-knowledge.json'))?.data.toString('utf8')).toContain('REAL_KNOWLEDGE_EVIDENCE')
  })
  it('reports file-count traversal and generated-item limits instead of claiming complete collection', async () => {
    const root=await temporary(); for(let i=0;i<5;i++)await put(root,`${i}.log`,'line')
    const collector=new DiagnosticArchiveCollector({maxFileBytes:64*1024})
    await collector.addDirectory(root,'logs',{maxEntries:2})
    collector.addBuffer('oversized.json',Buffer.alloc(65*1024))
    const report=collector.finalize().find(entry=>entry.name==='collection-report.json')!.data.toString('utf8')
    expect(report).toContain('traversal limit reached'); expect(report).toContain('per-file limit')
  })
  it('includes explicitly selected native crash dumps above the text limit without truncating binary data', async () => {
    const root=await temporary(), dump=path.join(root,'main.dmp'), expected=Buffer.alloc(70*1024,42)
    await fs.writeFile(dump,expected)
    const collector=new DiagnosticArchiveCollector({maxFileBytes:64*1024,maxTotalBytes:256*1024})
    await collector.addDirectory(root,'native-crashes/dumps',{maxBinaryBytes:128*1024})
    const zip=path.join(root,'native.zip'); await writeDiagnosticArchive(zip,collector.finalize())
    await extractZip(zip,{dir:path.join(root,'unzip')})
    expect(await fs.readFile(path.join(root,'unzip/native-crashes/dumps/main.dmp'))).toEqual(expected)
  })
  it('requires native-picked attachments owned by the caller and includes the selected evidence', async () => {
    const root=await temporary(), file=await put(root,'bill.csv','request_id,amount\nreq-1,5\n')
    const attachments=new DiagnosticAttachments(), selected=await attachments.register(7,[file])
    await expect(attachments.collect(new DiagnosticArchiveCollector(),8,selected.map(item=>item.id))).rejects.toThrow('不属于')
    const collector=new DiagnosticArchiveCollector(); await attachments.collect(collector,7,selected.map(item=>item.id))
    expect(collector.finalize().find(entry=>entry.name.endsWith('bill.csv'))?.data.toString('utf8')).toContain('req-1,5')
    await fs.appendFile(file,'changed'); await expect(attachments.collect(collector,7,selected.map(item=>item.id))).rejects.toThrow('已变化')
  })
  it('verifies a saved file and records before/after hashes without source contents', async () => {
    const root=await temporary(), file=await put(root,'A.txt','before')
    diagnosticJournal.configure(path.join(root,'logs'))
    await verifiedDiagnosticWrite(root,'A.txt',file,'after')
    const event=diagnosticJournal.snapshot().filter(event=>event.operation==='verified-write').at(-1)!
    expect(event.phase).toBe('verified'); expect(event.data).toMatchObject({relativePath:'A.txt',before:{sha256:expect.any(String)},expectedSha256:createHash('sha256').update('after').digest('hex')})
    expect(await fs.readFile(file,'utf8')).toBe('after')
    const large='x'.repeat(9*1024*1024)
    await expect(verifiedDiagnosticWrite(root,'A.txt',file,large)).resolves.toBeUndefined()
  })
  it('verifies settings persistence and keeps only credential presence in diagnostic summaries', async () => {
    const root=await temporary(),target=path.join(root,'settings.json');diagnosticJournal.configure(path.join(root,'logs'))
    await writeSettingsFile(target,{darkMode:true,externalAgents:{codex:{model:'fixture-model',apiKey:'private-settings-key',hasStoredKey:true}}})
    const event=diagnosticJournal.snapshot().filter(event=>event.subsystem==='settings'&&event.operation==='verified-write').at(-1)!
    expect(event.phase).toBe('verified');expect(JSON.stringify(event)).toContain('fixture-model');expect(JSON.stringify(event)).not.toContain('private-settings-key')
    expect(JSON.parse(await fs.readFile(target,'utf8'))).toMatchObject({darkMode:true})
  })
  it('exports existing logs without creating a new application session marker', async () => {
    const root=await temporary(), logs=path.join(root,'logs')
    await put(logs,'diagnostic-session.json','{"state":"running","sessionId":"prior"}')
    await put(logs,'diagnostic-events.jsonl','{"error":"startup-failure"}\n')
    const target=path.join(root,'recovery.zip')
    await exportRecoveryDiagnostics({logs,userData:root,target})
    expect(await fs.readFile(path.join(logs,'diagnostic-session.json'),'utf8')).toBe('{"state":"running","sessionId":"prior"}')
    await extractZip(target,{dir:path.join(root,'extracted')})
    expect(await fs.readFile(path.join(root,'extracted/app-logs/diagnostic-events.jsonl'),'utf8')).toContain('startup-failure')
  })
  it('bounds upstream error bodies and scopes the workbench query to its project', async () => {
    expect((await readDiagnosticResponse(new Response('x'.repeat(100000)),1024)).length).toBeLessThan(1100)
    const root=await temporary(); diagnosticJournal.configure(path.join(root,'logs'),()=>({path:path.join(root,'B')}))
    diagnosticJournal.record({subsystem:'files',operation:'write',message:'B-private-path'})
    diagnosticJournal.record({subsystem:'files',operation:'write',message:'A-visible',data:{projectPath:path.join(root,'A')}})
    const state=JSON.stringify(readDiagnosticState(path.join(root,'A'),{limit:10}))
    expect(state).toContain('A-visible'); expect(state).not.toContain('B-private-path')
    expect(()=>readDiagnosticState(root,{limit:10000})).toThrow('limit')
  })
  it('does not wait indefinitely for diagnostic error bodies', async () => {
    const nodeBody=new Readable({read(){}})
    expect(await readDiagnosticNodeResponse(nodeBody,1024,20)).toMatchObject({timedOut:true,incomplete:true})
    const webBody=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('partial'))}})
    expect(await readDiagnosticResponse(new Response(webBody),1024,20)).toContain('RESPONSE_BODY_TIMEOUT')
  })
  it('retains real upstream download rejection, request ID and network operation correlation', async () => {
    const root=await temporary(); diagnosticJournal.configure(path.join(root,'logs')); installNetworkDiagnostics()
    const server=http.createServer((request,response)=>{response.writeHead(403,{'x-request-id':'gateway-fixture-id'});response.end(JSON.stringify({code:'REGION_BLOCKED',reason:'fixture policy',echo:request.headers['x-api-key']}))})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try {
      const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/download`
      const manager=new DownloadManager()
      await expect(diagnosticContext.run({requestId:'outer-network',operation:'download',projectPath:root},()=>manager.download({sources:[{id:'fixture',label:'fixture',url,headers:{'X-Api-Key':'private-download-credential'}}],destination:path.join(root,'file'),retriesPerSource:0,trackActivity:false}))).rejects.toThrow('HTTP 403')
      const events=JSON.stringify(diagnosticJournal.snapshot())
      expect(events).toContain('REGION_BLOCKED'); expect(events).toContain('gateway-fixture-id'); expect(events).toContain('outer-network')
      expect(events).not.toContain('private-download-credential')
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
  })
})
