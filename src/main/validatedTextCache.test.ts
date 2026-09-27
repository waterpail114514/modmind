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
