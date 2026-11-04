import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readValidatedTextCache } from './validatedTextCache'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

it('preserves existing bytes on a failed replacement, removes temporary output, and permits retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-text-cache-'))
  roots.push(root)
  const target = path.join(root, 'index.txt')
  await fs.writeFile(target, 'damaged old entry')
  const validate = (content: string): void => { if (content !== 'valid replacement') throw new Error('invalid') }
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk I/O failed'), { code: 'EIO' }))
  await expect(readValidatedTextCache(target, async () => 'valid replacement', validate)).rejects.toThrow('disk I/O failed')
  expect(await fs.readFile(target, 'utf8')).toBe('damaged old entry')
  expect(await fs.readdir(root)).toEqual(['index.txt'])
  rename.mockRestore()
  expect((await readValidatedTextCache(target, async () => 'valid replacement', validate)).cached).toBe(false)
  expect(await fs.readFile(target, 'utf8')).toBe('valid replacement')
})

it('treats a fresh file as current and falls back to a stale one when the download fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-text-cache-'))
  roots.push(root)
  const target = path.join(root, 'index.txt')
  const validate = (content: string): void => { if (content !== 'valid' && content !== 'stale') throw new Error('invalid') }
  await fs.writeFile(target, 'valid')

  const fresh = vi.fn(async () => 'unused')
  expect(await readValidatedTextCache(target, fresh, validate, 32 * 1024 * 1024, 60_000)).toMatchObject({ content: 'valid', cached: true, stale: false })
  expect(fresh).not.toHaveBeenCalled()

  // Past the TTL the payload is only a fallback: a failed download must not discard it.
  const past = new Date(Date.now() - 120_000)
  await fs.utimes(target, past, past)
  const offline = vi.fn(async () => { throw new Error('offline') })
  expect(await readValidatedTextCache(target, offline, validate, 32 * 1024 * 1024, 60_000)).toMatchObject({ content: 'valid', cached: true, stale: true })
  expect(offline).toHaveBeenCalledTimes(1)

  // A working download replaces the stale bytes and is published for the next reader.
  expect(await readValidatedTextCache(target, async () => 'stale', validate, 32 * 1024 * 1024, 60_000)).toMatchObject({ content: 'stale', cached: false, stale: false })
  expect(await fs.readFile(target, 'utf8')).toBe('stale')
})
