import http from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { ImageStudioJournal } from '../src/main/imageStudioJournal'

const root = process.env.MODMIND_IMAGE_LOG_ROOT || path.join(process.env.APPDATA!, 'modmind', 'image-studio-logs')
const journal = new ImageStudioJournal(root)
const port = Number(process.env.MODMIND_IMAGE_LOG_PORT || 43187)
const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])
const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin
  if (origin && !origins.has(origin)) { response.writeHead(403); response.end(); return }
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (request.method === 'GET' && request.url === '/status') {
    response.end(JSON.stringify({ directory: journal.directory, sessionId: journal.sessionId })); return
  }
  if (request.method !== 'POST' || request.url !== '/events' || !origin) { response.writeHead(404); response.end(); return }
  try {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      size += chunk.length
      if (size > 40 * 1024 * 1024) { response.writeHead(413); response.end(); return }
      chunks.push(chunk)
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Invalid image trace event')
    await journal.record(event)
    response.end('{"saved":true}')
  } catch (error) {
    console.error(error)
    response.writeHead(500); response.end('{"saved":false}')
  }
})

// Retain main-process evidence as well as renderer actions, without modifying or restarting Electron.
const diagnosticFile = path.join(process.env.APPDATA!, 'modmind', 'logs', 'diagnostic-events.jsonl')
let offset = 0
let remainder = ''
let reading = false
async function readBackendEvents(): Promise<void> {
  if (reading) return
  reading = true
  try {
    const file = await fs.open(diagnosticFile, 'r')
    try {
      const { size } = await file.stat()
      if (size < offset) { offset = 0; remainder = '' }
      if (size === offset) return
      const bytes = Buffer.alloc(size - offset)
      const result = await file.read(bytes, 0, bytes.length, offset)
      offset += result.bytesRead
      const lines = (remainder + bytes.subarray(0, result.bytesRead).toString('utf8')).split('\n')
      remainder = lines.pop() || ''
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          if (item.subsystem === 'image-studio' || /^image-studio[-:]/.test(item.operation)) await journal.record({ type: 'backend.diagnostic', data: item })
        } catch { /* Ignore partial/invalid historical lines. */ }
      }
    } finally { await file.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(error) }
  finally { reading = false }
}

await journal.record({ type: 'recorder.started', data: { pid: process.pid, origin: [...origins], mode: 'development', backendHistoryIncluded: true } })
await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ directory: journal.directory, sessionId: journal.sessionId, pid: process.pid, port }, null, 2))
await readBackendEvents()
const timer = setInterval(() => void readBackendEvents(), 1000)
server.listen(port, '127.0.0.1', () => console.log(`Image studio recording: ${journal.directory}`))
server.on('error', error => { console.error(error); clearInterval(timer); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(timer)
  server.close(() => { void journal.record({ type: 'recorder.stopped' }).then(() => process.exit(0)) })
})
