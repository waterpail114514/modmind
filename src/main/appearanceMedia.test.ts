import { mkdtemp, writeFile, readFile, rm, readdir, mkdir, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importBackgroundMedia, pruneSavedBackgroundMedia, serveBackgroundMedia } from './appearanceMedia'
import { normalizeBackground } from '../shared/appTheme'

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

it('deduplicates simultaneous imports and repairs an existing damaged copy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-background-dedup-'))
  directories.push(directory)
  const source = path.join(directory, 'demo.mp4'), managed = path.join(directory, 'appearance-media')
  await writeFile(source, 'same content')
  const imported = await Promise.all(Array.from({ length: 3 }, () => importBackgroundMedia(source, managed)))
  expect(new Set(imported.map(media => media.file)).size).toBe(1)
  expect(await readdir(managed)).toEqual([imported[0].file])
  expect(normalizeBackground({ media: imported[0] }).media).toEqual(imported[0])
  await writeFile(path.join(managed, imported[0].file), 'broken')
  expect((await importBackgroundMedia(source, managed)).file).toBe(imported[0].file)
  expect(await readFile(path.join(managed, imported[0].file), 'utf8')).toBe('same content')
})

it('reclaims only old unreferenced managed media, preserving current, pending, and unknown files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-background-prune-'))
  directories.push(directory)
  const managed = path.join(directory, 'appearance-media')
  await mkdir(managed)
  const current = `${'a'.repeat(64)}.png`, orphan = '00000000-0000-0000-0000-000000000001.mp4', pending = `${'c'.repeat(64)}.png`
  const now = Date.now()
  for (const file of [current, orphan, pending, 'user-photo.png']) {
    await writeFile(path.join(managed, file), 'content')
    const date = new Date(now - (file === pending ? 0 : 48 * 60 * 60 * 1000))
    await utimes(path.join(managed, file), date, date)
  }
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ background: { media: { file: current } } }))
  expect(await pruneSavedBackgroundMedia(directory, now)).toEqual([orphan])
  expect((await readdir(managed)).sort()).toEqual([current, pending, 'user-photo.png'].sort())
  await writeFile(path.join(directory, 'settings.json'), '{broken')
  expect(await pruneSavedBackgroundMedia(directory, now + 72 * 60 * 60 * 1000)).toEqual([])
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ background: { media: { file: '../invalid.png' } } }))
  expect(await pruneSavedBackgroundMedia(directory, now + 72 * 60 * 60 * 1000)).toEqual([])
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ background: { media: null } }))
  expect((await pruneSavedBackgroundMedia(directory, now + 72 * 60 * 60 * 1000)).sort()).toEqual([current, pending].sort())
  expect(await readdir(managed)).toEqual(['user-photo.png'])
})
