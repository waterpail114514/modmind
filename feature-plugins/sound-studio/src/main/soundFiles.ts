import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mediaExecutable } from '../../../sdk/mediaRuntime'
import { spawnManaged } from '../../../../src/main/processTree'
import { diagnosticJournal } from '../../../../src/main/diagnosticLog'
import { diagnosticContext, diagnosticValue } from '../../../../src/main/diagnosticContext'

export const AUDIO_LIMIT = 64 * 1024 * 1024
export const audioExtension = /\.(ogg|mp3|wav|flac|m4a)$/i
export const digestSound = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export function soundResourceId(value: string): string {
  if (typeof value !== 'string' || value.length > 180 || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('声音 ID 只能包含小写英文、数字、下划线、点、横线和目录')
  return value
}
export async function safeSoundPath(root: string, relative: string): Promise<string> {
  const rootPath = path.resolve(root)
  const target = path.resolve(rootPath, relative)
  const from = path.relative(rootPath, target)
  if (from.startsWith('..') || path.isAbsolute(from)) throw new Error('声音路径超出目录')
  let cursor = target
  while (true) {
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('声音路径不能包含符号链接')
    if (cursor === rootPath) break
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return target
}
export async function readSoundBytes(root: string, relative: string, limit = AUDIO_LIMIT): Promise<Buffer> {
  const target = await safeSoundPath(root, relative)
  if ((await fs.stat(target)).size > limit) throw new Error('文件超过预览大小限制（' + Math.round(limit / 1024 / 1024) + ' MiB）')
  return fs.readFile(target)
}
export async function soundJson<T>(file: string): Promise<T | null> {
  try {
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('声音配置超过 8 MiB')
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('无法读取声音配置 ' + path.basename(file) + '：' + String(error))
  }
}
export async function writeSoundAtomic(file: string, bytes: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.pending-' + randomUUID()
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}
export async function runSoundFfmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  const requestId = randomUUID(), startedAt = Date.now()
  const binary = mediaExecutable()
  if (!binary) throw new Error('当前安装缺少 FFmpeg，请修复安装后重试')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawnManaged(binary.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), ['-nostdin', '-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const data = { requestId, projectPath: diagnosticContext.getStore()?.projectPath, pid: child.pid, executable: binary, arguments: args.slice(0,100).map(arg=>diagnosticValue(arg, 'path')), omittedArguments: Math.max(0,args.length-100) }
    diagnosticJournal.record({subsystem:'audio',operation:'ffmpeg',phase:'start',message:'Audio conversion started',data})
    let output = ''
    const abort = (): void => { child.kill() }
    const timer = setTimeout(abort, 120_000)
    signal?.addEventListener('abort', abort, { once: true })
    const clean = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stderr?.on('data', chunk => { output = (output + chunk.toString()).slice(-64000) })
    child.once('error', error => { clean(); diagnosticJournal.record({subsystem:'audio',operation:'ffmpeg',phase:'error',level:'error',message:'FFmpeg process failed',data,error});reject(error) })
    child.once('close', code => { clean(); diagnosticJournal.record({subsystem:'audio',operation:'ffmpeg',phase:code===0&&!signal?.aborted?'complete':'error',level:code===0&&!signal?.aborted?'info':'error',message:'Audio conversion exited',durationMs:Date.now()-startedAt,data:{...data,exitCode:code,cancelled:signal?.aborted,stderr:output}});code === 0 && !signal?.aborted ? resolve(output) : reject(Object.assign(new Error(signal?.aborted ? '声音处理已取消' : '音频处理失败：' + output.slice(-1200)),{exitCode:code,stderr:output,requestId})) })
  })
}
