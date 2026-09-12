import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadManager } from './downloadService'

const roots: string[] = []
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
function server(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const instance = http.createServer(handler)
  servers.push(instance)
  return new Promise((resolve) => instance.listen(0, '127.0.0.1', () => {
    const address = instance.address() as { port: number }
    resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => instance.close(() => done())) })
  }))
}

describe('verified download manager', () => {
  it('isolates simultaneous downloads to the same destination', async () => {
    const source = await server((_request, response) => { response.end('verified') })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-concurrent-')); roots.push(root)
    const destination = path.join(root, 'core.jar')
    const request = { sources: [{ id: 'core', label: 'core', url: source.url }], destination, retriesPerSource: 1, expectedHash: { algorithm: 'sha256' as const, value: createHash('sha256').update('verified').digest('hex') } }
    await Promise.all([new DownloadManager().download(request), new DownloadManager().download(request)])
    expect(await fs.readFile(destination, 'utf8')).toBe('verified')
    expect(await fs.readdir(root)).toEqual(['core.jar'])
  })

  it('preserves the old destination on disk write failure', async () => {
    const source = await server((_request, response) => { response.end('verified') })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-disk-')); roots.push(root)
    const destination = path.join(root, 'core.jar'); await fs.writeFile(destination, 'old')
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(new DownloadManager().download({ sources: [{ id: 'core', label: 'core', url: source.url }], destination, retriesPerSource: 1 })).rejects.toThrow('disk full')
    expect(await fs.readFile(destination, 'utf8')).toBe('old')
    expect(await fs.readdir(root)).toEqual(['core.jar'])
  })

  it('rejects a redirect to an unencrypted destination before sending that request', async () => {
    let targetHits = 0
    const target = await server((_request, response) => { targetHits += 1; response.end('unsafe') })
    const source = await server((_request, response) => { response.writeHead(302, { location: target.url }); response.end() })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-redirect-')); roots.push(root)
    await expect(new DownloadManager().download({ sources: [{ id: 'core', label: 'core', url: source.url }], destination: path.join(root, 'core.jar'), retriesPerSource: 1 })).rejects.toThrow('non-HTTPS')
    expect(targetHits).toBe(0)
  })

  it('keeps an existing artifact and removes temporary data after a failed replacement', async () => {
    const source = await server((_request, response) => { response.end('wrong') })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-preserve-')); roots.push(root)
    const destination = path.join(root, 'core.jar'); await fs.writeFile(destination, 'known-good')
    await expect(new DownloadManager().download({ sources: [{ id: 'core', label: 'core', url: source.url }], destination, retriesPerSource: 1, expectedHash: { algorithm: 'sha256', value: '0'.repeat(64) } })).rejects.toThrow('mismatch')
    expect(await fs.readFile(destination, 'utf8')).toBe('known-good')
    expect(await fs.readdir(root)).toEqual(['core.jar'])
  })

  it('aborts a streaming download and leaves no partial artifact', async () => {
    const source = await server((_request, response) => { response.write('partial'); const timer = setInterval(() => response.write('more'), 20); response.on('close', () => clearInterval(timer)) })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-abort-')); roots.push(root)
    const controller = new AbortController()
    await expect(new DownloadManager().download({ sources: [{ id: 'core', label: 'core', url: source.url }], destination: path.join(root, 'core.jar'), signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow('cancelled')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('rejects oversized error bodies without leaving a partial file', async () => {
    const source = await server((_request, response) => { response.writeHead(200, { 'content-length': '100' }); response.end('x'.repeat(100)) })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-limit-')); roots.push(root)
    await expect(new DownloadManager().download({ sources: [{ id: 'core', label: 'core', url: source.url }], destination: path.join(root, 'core.jar'), maxBytes: 10, retriesPerSource: 1 })).rejects.toThrow('exceeds')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('falls back to the next source and atomically verifies the result', async () => {
    const source = await server((_request, response) => { response.statusCode = 503; response.end('offline') })
    const good = await server((_request, response) => { response.end('modmind-fixture') })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-'))
    roots.push(root)
    const value = Buffer.from('modmind-fixture')
    const result = await new DownloadManager().download({
      sources: [
        { id: 'bad', label: 'bad mirror', url: source.url },
        { id: 'good', label: 'good mirror', url: good.url }
      ],
      destination: path.join(root, 'mods', 'example.jar'),
      retriesPerSource: 1,
      expectedHash: { algorithm: 'sha256', value: createHash('sha256').update(value).digest('hex') }
    })
    expect(result.source.id).toBe('good')
    expect(await fs.readFile(result.destination)).toEqual(value)
    expect(result.failures).toHaveLength(1)
  })

  it('never leaves a corrupt destination after a hash failure', async () => {
    const source = await server((_request, response) => { response.end('wrong') })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-hash-'))
    roots.push(root)
    const destination = path.join(root, 'example.jar')
    await expect(new DownloadManager().download({
      sources: [{ id: 'only', label: 'only', url: source.url }],
      destination,
      retriesPerSource: 1,
      expectedHash: { algorithm: 'sha256', value: '0'.repeat(64) }
    })).rejects.toThrow(/all download sources failed/)
    await expect(fs.access(destination)).rejects.toThrow()
  })
})
