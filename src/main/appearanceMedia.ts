import { promises as fs, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import path from 'node:path'
import { isBackgroundMediaFile, type BackgroundMedia } from '../shared/appTheme'
import { retryTransientFileLock } from './fileLockRetry'

const mediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const mediaOperations = new Map<string, Promise<unknown>>()
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

function withMediaDirectory<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory)
  const pending = (mediaOperations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
  mediaOperations.set(key, pending)
  void pending.finally(() => { if (mediaOperations.get(key) === pending) mediaOperations.delete(key) }).catch(() => undefined)
  return pending
}

export function importBackgroundMedia(source: string, directory: string): Promise<BackgroundMedia> {
  return withMediaDirectory(directory, async () => {
    const ext = path.extname(source).toLowerCase()
    if (!mediaTypes[ext]) throw new Error('请选择 PNG、JPG、WebP、GIF 图片或 MP4、WebM 视频')
    const stat = await fs.stat(source)
    if (!stat.isFile() || stat.size === 0 || stat.size > 250 * 1024 * 1024) throw new Error('背景文件不能为空，且不能超过 250 MB')
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `.import-${randomUUID()}`)
    try {
      await fs.copyFile(source, temporary)
      const copied = await fs.stat(temporary)
      if (copied.size === 0 || copied.size > 250 * 1024 * 1024) throw new Error('背景文件不能为空，且不能超过 250 MB')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(temporary)) hash.update(chunk)
      const file = `${hash.digest('hex')}${ext}`
      const target = path.join(directory, file)
      // Replacing the same content also repairs an existing truncated managed copy.
      await retryTransientFileLock(() => fs.rename(temporary, target))
      const now = new Date()
      await fs.utimes(target, now, now)
      return { file, name: path.basename(source), kind: mediaTypes[ext].startsWith('video/') ? 'video' : 'image' }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  })
}

/** Read persisted settings, never unsaved UI state; recent imports retain a one-day grace period. */
export function pruneSavedBackgroundMedia(userData: string, now = Date.now()): Promise<string[]> {
  const directory = path.join(userData, 'appearance-media')
  return withMediaDirectory(directory, async () => {
    let current: string | null
    try {
      const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'))
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return []
      const background = stored.background
      if (background != null && (typeof background !== 'object' || Array.isArray(background))) return []
      const media = background?.media
      if (media != null && !isBackgroundMediaFile(media.file)) return []
      current = media?.file ?? null
    } catch { return [] }
    if (!(await fs.lstat(directory).catch(() => null))?.isDirectory()) return []
    const removed: string[] = []
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isBackgroundMediaFile(entry.name) || entry.name.toLowerCase() === current?.toLowerCase()) continue
      const target = path.join(directory, entry.name)
      try {
        const stat = await fs.lstat(target)
        if (!stat.isFile() || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue
        await fs.unlink(target)
        removed.push(entry.name)
      } catch { /* In-use media can be retried on the next startup or settings save. */ }
    }
    return removed
  })
}

// Only imported, generated filenames are served. Range responses let videos seek
// without buffering an entire local file in the renderer or settings storage.
export async function serveBackgroundMedia(request: Request, directory: string): Promise<Response> {
  const url = new URL(request.url)
  const file = url.pathname.slice(1)
  if (url.hostname !== 'background' || !isBackgroundMediaFile(file)) return new Response(null, { status: 404 })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  try {
    const target = path.join(directory, file)
    const stat = await fs.stat(target)
    if (!stat.isFile()) return new Response(null, { status: 404 })
    const headers = new Headers({ 'Content-Type': mediaTypes[path.extname(file)], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' })
    let start = 0, end = stat.size - 1
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    }
    headers.set('Content-Length', String(end - start + 1))
    const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch { return new Response(null, { status: 404 }) }
}
