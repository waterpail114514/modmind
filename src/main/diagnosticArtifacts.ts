import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { diagnosticContext, diagnosticValue } from './diagnosticContext'
import { diagnosticJournal } from './diagnosticLog'
import { diagnosticFileFingerprint } from './diagnosticFiles'
import { scopedFilePath } from './scopedFilePath'
import yauzl from 'yauzl'
import type { Readable } from 'node:stream'

type ArtifactInput = ({ name: string; data: Buffer } | { name: string; path: string }) & { identity?: unknown }
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function archiveFingerprint(source: string | Buffer): Promise<unknown> {
  const zip = await new Promise<yauzl.ZipFile>((resolve,reject) => {
    const callback = (error: Error | null, value?: yauzl.ZipFile) => error ? reject(error) : value ? resolve(value) : reject(new Error('Archive could not be opened'))
    if (typeof source === 'string') yauzl.open(source,{lazyEntries:true,autoClose:false},callback)
    else yauzl.fromBuffer(source,{lazyEntries:true,autoClose:false},callback)
  })
  const entries: Array<Record<string, unknown>> = []; let totalHashBytes = 0
  let activeStream: Readable | undefined
  try {
    return await new Promise((resolve,reject) => {
      let finished = false
      const done = (error?: unknown, incomplete=false) => { if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve({entries,totalHashBytes,incomplete}) }
      const timer=setTimeout(()=>{activeStream?.destroy(new Error('Archive diagnostic read timed out'));zip.close();done(undefined,true)},10000)
      zip.on('error',error=>done(error));zip.on('end',()=>done())
      zip.on('entry',entry=>{void (async()=>{
        if(finished)return
        if(entries.length>=10000){zip.close();done(undefined,true);return}
        const item:Record<string,unknown>={name:entry.fileName,bytes:entry.uncompressedSize,compressedBytes:entry.compressedSize,crc32:entry.crc32}
        entries.push(item)
        if(!entry.fileName.endsWith('/') && entry.uncompressedSize<=8*1024*1024 && totalHashBytes+entry.uncompressedSize<=64*1024*1024){
          const stream=await new Promise<Readable>((resolveStream,rejectStream)=>zip.openReadStream(entry,(error,body)=>error?rejectStream(error):resolveStream(body!)))
          activeStream = stream
          const digest=createHash('sha256');let bytes=0
          await new Promise<void>((resolveStream,rejectStream)=>{
            stream.on('error',rejectStream);stream.on('end',resolveStream);stream.on('close',()=>{if(!stream.readableEnded)rejectStream(new Error('Archive stream closed before completion'))})
            stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>entry.uncompressedSize){stream.destroy(new Error('Archive expanded size differs from its directory'));return}digest.update(chunk)})
          })
          activeStream = undefined
          item.sha256=digest.digest('hex');totalHashBytes+=bytes;item.incomplete=bytes!==entry.uncompressedSize
        }else item.hashOmitted='directory or hashing budget'
        if(!finished)zip.readEntry()
      })().catch(error=>done(error))})
      zip.readEntry()
    })
  } finally {activeStream?.destroy();zip.close()}
}

/** Record actual business inputs/outputs without copying project source or affecting the operation. */
export async function recordDiagnosticArtifact(project: ProjectInfo, operation: string, input: { outputPath?: string; output?: Buffer; entries?: ArtifactInput[]; metadata?: unknown }): Promise<void> {
  try {
    const id = randomUUID(), time = new Date().toISOString()
    const directory = path.dirname(await scopedFilePath(project.path, `${project.toolDataDirectory ?? '.modmind'}/diagnostic-artifacts/${id}.json`))
    await fs.mkdir(directory, { recursive: true })
    let hashBytes = 0
    const entries = [] as Array<Record<string, unknown>>
    for (const entry of (input.entries ?? []).slice(0, 10000)) {
      const item: Record<string, unknown> = { name: entry.name }
      if (entry.identity !== undefined) item.identity = diagnosticValue(entry.identity)
      try {
        if ('data' in entry) { item.bytes = entry.data.length; item.sha256 = hash(entry.data) }
        else {
          item.path = entry.path
          const fingerprint = await diagnosticFileFingerprint(entry.path, Math.max(0, 64 * 1024 * 1024 - hashBytes))
          Object.assign(item, fingerprint); if (fingerprint.sha256) hashBytes += fingerprint.bytes
        }
      } catch (error) { item.error = String(error).slice(0, 1000) }
      entries.push(item)
    }
    const output = input.output ? { bytes: input.output.length, sha256: hash(input.output) }
      : input.outputPath ? await diagnosticFileFingerprint(input.outputPath, 256 * 1024 * 1024).catch(error => ({ error: String(error) })) : undefined
    const actualOutput = input.output && input.outputPath ? await diagnosticFileFingerprint(input.outputPath, 256 * 1024 * 1024).catch(error => ({ error: String(error) })) : undefined
    const archiveSource=input.outputPath && /\.(?:zip|jar|mrpack|mcpack|mcaddon)$/i.test(input.outputPath)?input.outputPath:input.output?.subarray(0,4).equals(Buffer.from([80,75,3,4]))?input.output:undefined
    const archive=archiveSource?await archiveFingerprint(archiveSource).catch(error=>({error:String(error)})):undefined
    const value = { id, time, operation, projectPath: project.path, trace: diagnosticContext.getStore(), outputPath: input.outputPath, output, actualOutput, archive, metadata: diagnosticValue(input.metadata),
      consistency: 'Each file is read after or before the documented business step; concurrent source edits and hashing omissions are not claimed as a verified archive content.', entryCount: input.entries?.length ?? 0, omittedEntries: Math.max(0, (input.entries?.length ?? 0) - entries.length), entries }
    // Entry objects contain only identities/hashes, never arbitrary contents or credentials.
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Artifact evidence exceeds 4 MiB')
    await fs.writeFile(path.join(directory, `${time.replace(/[:.]/g, '-')}-${id}.json`), encoded, { mode: 0o600, flag: 'wx' })
    const previous = await Promise.all((await fs.readdir(directory)).filter(name => /^\d{4}-.*-[a-f0-9-]{36}\.json$/.test(name)).map(async name => ({ name, bytes: (await fs.lstat(path.join(directory, name))).size })))
    let bytes = 0, count = 0, removed = 0
    for (const file of previous.sort((a,b) => b.name.localeCompare(a.name))) { bytes += file.bytes; if (++count > 40 || bytes > 32 * 1024 * 1024) {await fs.rm(path.join(directory, file.name), { force: true });removed++} }
    if(removed)await fs.writeFile(path.join(directory,'retention.json'),JSON.stringify({time,maxFiles:40,maxBytes:32*1024*1024,removedThisPass:removed,completeness:'older evidence was pruned'}),{mode:0o600})
    diagnosticJournal.recordCritical({ subsystem: 'artifacts', operation, phase: 'recorded', message: 'Artifact input/output identities recorded', data: { projectPath: project.path, id, entries: entries.length, output, outputPath: input.outputPath } })
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'artifact-evidence', phase: 'error', level: 'warning', message: 'Unable to retain artifact evidence; business result is unchanged', data: { projectPath: project.path, operation }, error })
  }
}

/** Manifests are structured identity/ownership evidence; no arbitrary source contents. */
export async function recordDiagnosticManifest<T extends { mods?: unknown[]; modules?: unknown[] }>(project: ProjectInfo, operation: string, state: T): Promise<void> {
  try {
  const { mods, modules, ...metadata } = state
  const records = [...(mods ?? []), ...(modules ?? [])].slice(0,10000).map((record,index) => ({ name: String(index), identity: record, data: Buffer.from(JSON.stringify(diagnosticValue(record))) }))
  // Preserve individual structured identities without truncating the entire manifest to twenty items.
  await recordDiagnosticArtifact(project, operation, { entries: records, metadata: { ...metadata, originalMods: mods?.length, originalModules: modules?.length, recordsOmitted: Math.max(0, (mods?.length ?? 0) + (modules?.length ?? 0) - records.length) } })
  } catch (error) { diagnosticJournal.record({subsystem:'diagnostics',operation:'manifest-evidence',phase:'error',level:'warning',message:'Unable to summarize manifest evidence',error}) }
}
