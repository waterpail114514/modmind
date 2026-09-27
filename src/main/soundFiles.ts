import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import ffmpegPath from 'ffmpeg-static'
import { spawnManaged } from './processTree'

export const AUDIO_LIMIT = 64 * 1024 * 1024
export const audioExtension = /\.(ogg|mp3|wav|flac|m4a)$/i
export const digestSound = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export function soundResourceId(value: string): string {
  if (typeof value !== 'string' || value.length > 180 || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('声音 ID 只能包含小写英文、数字、下划线、点、横线和目录')
  return value
}
export async function safeSoundPath(root: string, relative: string): Promise<string> {
  const target = path.resolve(root, relative)
  const from = path.relative(path.resolve(root), target)
  if (from.startsWith('..') || path.isAbsolute(from)) throw new Error('声音路径超出目录')
  let cursor = target
  while (true) {
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('声音路径不能包含符号链接')
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
  const binary = ffmpegPath
  if (!binary) throw new Error('当前安装缺少 FFmpeg，请修复安装后重试')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawnManaged(binary.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), ['-nostdin', '-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let output = ''
    const abort = (): void => { child.kill() }
    const timer = setTimeout(abort, 120_000)
    signal?.addEventListener('abort', abort, { once: true })
    const clean = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stderr?.on('data', data => { output = (output + data.toString()).slice(-12000) })
    child.once('error', error => { clean(); reject(error) })
    child.once('close', code => { clean(); code === 0 && !signal?.aborted ? resolve(output) : reject(new Error(signal?.aborted ? '声音处理已取消' : '音频处理失败：' + output.slice(-1200))) })
  })
}
