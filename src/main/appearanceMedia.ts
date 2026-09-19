import { promises as fs, createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import path from 'node:path'
import type { BackgroundMedia } from '../shared/appTheme'

const mediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' }

export async function importBackgroundMedia(source: string, directory: string): Promise<BackgroundMedia> {
  const ext = path.extname(source).toLowerCase()
  if (!mediaTypes[ext]) throw new Error('请选择 PNG、JPG、WebP、GIF 图片或 MP4、WebM 视频')
  const stat = await fs.stat(source)
  if (!stat.isFile() || stat.size === 0 || stat.size > 250 * 1024 * 1024) throw new Error('背景文件不能为空，且不能超过 250 MB')
  await fs.mkdir(directory, { recursive: true })
  const file = randomUUID() + ext
  await fs.copyFile(source, path.join(directory, file))
  return { file, name: path.basename(source), kind: mediaTypes[ext].startsWith('video/') ? 'video' : 'image' }
}

// Only imported, generated filenames are served. Range responses let videos seek
// without buffering an entire local file in the renderer or settings storage.
export async function serveBackgroundMedia(request: Request, directory: string): Promise<Response> {
  const url = new URL(request.url)
  const file = url.pathname.slice(1)
  if (url.hostname !== 'background' || !/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|gif|mp4|webm)$/.test(file)) return new Response(null, { status: 404 })
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
