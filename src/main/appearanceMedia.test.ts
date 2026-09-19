import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importBackgroundMedia, serveBackgroundMedia } from './appearanceMedia'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
it('imports a private copy and serves video ranges without exposing other local paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-background-'))
  directories.push(directory)
  const source = path.join(directory, 'demo.mp4'), managed = path.join(directory, 'media')
  await writeFile(source, '0123456789')
  const media = await importBackgroundMedia(source, managed)
  await rm(source)
  expect(await readFile(path.join(managed, media.file), 'utf8')).toBe('0123456789')
  const url = `modmind-media://background/${media.file}`
  const range = await serveBackgroundMedia(new Request(url, { headers: { Range: 'bytes=2-5' } }), managed)
  expect(range.status).toBe(206)
  expect(range.headers.get('Content-Range')).toBe('bytes 2-5/10')
  expect(await range.text()).toBe('2345')
  expect(await (await serveBackgroundMedia(new Request(url, { headers: { Range: 'bytes=-3' } }), managed)).text()).toBe('789')
  expect((await serveBackgroundMedia(new Request(url, { headers: { Range: 'bytes=100-' } }), managed)).status).toBe(416)
  expect((await serveBackgroundMedia(new Request('modmind-media://background/..%2fsecret.png'), managed)).status).toBe(404)
  expect((await serveBackgroundMedia(new Request(url.replace('background/', 'other/')), managed)).status).toBe(404)
  expect((await serveBackgroundMedia(new Request(url, { method: 'HEAD' }), managed)).headers.get('Content-Length')).toBe('10')
  await expect(importBackgroundMedia(path.join(directory, 'secret.txt'), managed)).rejects.toThrow('请选择')
})
