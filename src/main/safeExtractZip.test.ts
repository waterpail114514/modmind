import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStoredZip } from './bedrockAddon'
import extractZip from './safeExtractZip'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Unlink the owned junction itself before removing its containing fixture.
    const link = path.join(root, 'destination', 'linked')
    if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) await fs.unlink(link)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-extract-')); roots.push(root)
  const destination = path.join(root, 'destination'), outside = path.join(root, 'outside'), archive = path.join(root, 'input.zip')
  await fs.mkdir(destination); await fs.mkdir(outside)
  return { root, destination, outside, archive }
}
it('extracts regular files and preserves one onEntry call per entry', async () => {
  const { destination, archive } = await fixture()
  await fs.writeFile(archive, createStoredZip([{ name: 'nested/file.txt', data: Buffer.from('content') }]))
  let count = 0
  await extractZip(archive, { dir: destination, onEntry() { count++ } })
  expect(count).toBe(1); expect(await fs.readFile(path.join(destination, 'nested/file.txt'), 'utf8')).toBe('content')
})
it('AUD111 extracts current-directory prefixes and normalizes paths for callbacks once per entry', async () => {
  const { destination, archive } = await fixture()
  await fs.writeFile(archive, createStoredZip([
    { name: '././gradle.properties', data: Buffer.from('minecraft_version=1.20.1') },
    { name: './src/./main/', data: Buffer.alloc(0) },
    { name: './src/./main//Example.java', data: Buffer.from('class Example {}') }
  ]))
  const names: string[] = []
  await extractZip(archive, { dir: destination, onEntry(entry) { names.push(entry.fileName) } })
  expect(names).toEqual(['gradle.properties', 'src/main/', 'src/main/Example.java'])
  expect(await fs.readFile(path.join(destination, 'src/main/Example.java'), 'utf8')).toBe('class Example {}')
})
it.each(['./../escape.txt', 'nested/./../escape.txt', './C:/escape.txt', '/absolute.txt', './file.txt:stream'])('rejects unsafe path %s before writing an earlier entry', async name => {
  const { destination, archive } = await fixture()
  await fs.writeFile(archive, createStoredZip([{ name: './first.txt', data: Buffer.from('first') }, { name, data: Buffer.from('bad') }]))
  await expect(extractZip(archive, { dir: destination })).rejects.toThrow(/path/)
  expect(await fs.readdir(destination)).toEqual([])
})
it.each(['.', './'])('rejects an entry that normalizes to the extraction root: %s', async name => {
  const { destination, archive } = await fixture()
  await fs.writeFile(archive, createStoredZip([{ name, data: name.endsWith('/') ? Buffer.alloc(0) : Buffer.from('bad') }]))
  await expect(extractZip(archive, { dir: destination })).rejects.toThrow(/Unsafe ZIP path/)
  expect(await fs.readdir(destination)).toEqual([])
})
it('rejects a pre-existing hard-linked output before truncating its outside twin', async () => {
  const { destination, outside, archive } = await fixture()
  await fs.writeFile(path.join(outside, 'file.txt'), 'keep')
  await fs.link(path.join(outside, 'file.txt'), path.join(destination, 'file.txt'))
  await fs.writeFile(archive, createStoredZip([{ name: '././file.txt', data: Buffer.from('overwrite') }]))
  await expect(extractZip(archive, { dir: destination })).rejects.toThrow(/link/)
  expect(await fs.readFile(path.join(outside, 'file.txt'), 'utf8')).toBe('keep')
})
it('rejects a junction before creating archive directories outside the destination', async () => {
  const { destination, outside, archive } = await fixture()
  await fs.symlink(outside, path.join(destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(archive, createStoredZip([{ name: './linked/./new/file.txt', data: Buffer.from('unexpected') }]))
  await expect(extractZip(archive, { dir: destination })).rejects.toThrow(/link/)
  expect(await fs.readdir(outside)).toEqual([])
})
it('rejects archive symlinks before writing earlier regular entries', async () => {
  const { destination, archive } = await fixture()
  const zip = createStoredZip([{ name: 'regular.txt', data: Buffer.from('first') }, { name: 'linked', data: Buffer.from('../outside') }])
  let seen = 0
  for (let offset = 0; offset < zip.length - 46; offset++) if (zip.readUInt32LE(offset) === 0x02014b50 && ++seen === 2) { zip.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38); break }
  await fs.writeFile(archive, zip)
  await expect(extractZip(archive, { dir: destination })).rejects.toThrow(/link/)
  expect(await fs.readdir(destination)).toEqual([])
})
