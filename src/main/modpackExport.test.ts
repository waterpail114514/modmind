import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { afterEach, expect, it, vi } from 'vitest'
import * as yauzl from 'yauzl'
import type { ProjectInfo } from '../shared/types'
import { addModpackFiles, addModpackModule, createModpackTemplate, writeModrinthPackArchive } from './modpackService'
import { createEmptyModpackLock, writeModpackLock } from './modpackLockService'
import { registerImportedPackContent } from './modpackContentMetadata'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-export-'))
  roots.push(root)
  const project: ProjectInfo = { path: root, namespace: 'pack', name: 'Pack', kind: 'modpack', minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5', createdAt: '' }
  await createModpackTemplate(project)
  const mod = Buffer.alloc(2048, 5)
  const modPath = path.join(root, 'fixture.jar')
  await fs.writeFile(modPath, mod)
  await addModpackFiles(project, [modPath])
  await writeModpackLock(project, { ...createEmptyModpackLock(project), mods: [{ provider: 'modrinth', projectId: 'p', versionId: 'v', versionName: '1', fileName: 'fixture.jar', sha256: createHash('sha256').update(mod).digest('hex'), size: mod.length, side: 'client', sources: ['https://cdn.modrinth.com/data/p/versions/v/fixture.jar'], installedAt: '' }] })
  await fs.writeFile(path.join(root, 'mods/manual.jar'), Buffer.alloc(2048, 9))
  for (const dir of ['config', 'resourcepacks', 'shaderpacks']) await fs.mkdir(path.join(root, 'overrides', dir), { recursive: true })
  await fs.writeFile(path.join(root, 'overrides/config/pack.json'), '{"enabled":true}')
  for (const relative of ['resourcepacks/visuals.zip', 'shaderpacks/lights.zip']) {
    const bytes = Buffer.from(`original:${relative}`)
    await fs.writeFile(path.join(root, 'overrides', relative), bytes)
    await registerImportedPackContent(project, [{ path: relative, sha1: createHash('sha1').update(bytes).digest('hex'), sourceUrl: `https://cdn.modrinth.com/${relative}`, size: bytes.length, scope: 'client' }])
  }
  await addModpackModule(project, { name: 'Local', namespace: 'local', path: 'modules/local', side: 'server', createdAt: '' })
  await fs.mkdir(path.join(root, 'modules/local/build/libs'), { recursive: true })
  await fs.writeFile(path.join(root, 'modules/local/build/libs/local.jar'), Buffer.alloc(2048, 7))
  await fs.mkdir(path.join(root, 'server-overrides/config'), { recursive: true })
  await fs.writeFile(path.join(root, 'server-overrides/config/server.txt'), 'server setting')
  return project
}

it('exports every pack file by default and supports standard download records without losing private content', async () => {
  const project = await fixture()
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  for (const mode of ['bundled', 'download'] as const) {
    const target = path.join(project.path, `${mode}.mrpack`)
    const artifact = await writeModrinthPackArchive(project, target, { ...(mode === 'download' ? { mode } : {}), version: '1.2.3' })
    expect(artifact).toEqual({ path: target, size: (await fs.stat(target)).size })
    const extracted = path.join(project.path, mode)
    await extractZip(target, { dir: extracted })
    const index = JSON.parse(await fs.readFile(path.join(extracted, 'modrinth.index.json'), 'utf8'))
    expect(index).toMatchObject({ versionId: '1.2.3', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' } })
    if (mode === 'bundled') {
      expect(index.files).toEqual([])
      expect(await fs.readFile(path.join(extracted, 'client-overrides/mods/fixture.jar'))).toEqual(Buffer.alloc(2048, 5))
      expect(await fs.readFile(path.join(extracted, 'client-overrides/resourcepacks/visuals.zip'), 'utf8')).toBe('original:resourcepacks/visuals.zip')
      expect(await fs.readFile(path.join(extracted, 'client-overrides/shaderpacks/lights.zip'), 'utf8')).toBe('original:shaderpacks/lights.zip')
    } else {
      expect(index.files).toHaveLength(3)
      for (const file of index.files) {
        expect(file.env).toEqual({ client: 'required', server: 'unsupported' })
        expect(file.hashes.sha1).toMatch(/^[a-f0-9]{40}$/)
        expect(file.hashes.sha512).toMatch(/^[a-f0-9]{128}$/)
        expect(file.fileSize).toBeGreaterThan(0)
        await expect(fs.access(path.join(extracted, 'overrides', file.path))).rejects.toThrow()
        await expect(fs.access(path.join(extracted, 'client-overrides', file.path))).rejects.toThrow()
      }
    }
    expect(await fs.readFile(path.join(extracted, 'overrides/mods/manual.jar'))).toEqual(Buffer.alloc(2048, 9))
    expect(await fs.readFile(path.join(extracted, 'server-overrides/mods/modmind-local-local.jar'))).toEqual(Buffer.alloc(2048, 7))
    expect(await fs.readFile(path.join(extracted, 'overrides/config/pack.json'), 'utf8')).toContain('enabled')
    expect(await fs.readFile(path.join(extracted, 'server-overrides/config/server.txt'), 'utf8')).toBe('server setting')
  }
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('embeds edited downloaded resources and rejects missing content without replacing an existing export', async () => {
  const project = await fixture()
  const resource = path.join(project.path, 'overrides/resourcepacks/visuals.zip')
  await fs.writeFile(resource, 'authored changes')
  const target = path.join(project.path, 'edited.mrpack')
  await writeModrinthPackArchive(project, target, { mode: 'download' })
  const extracted = path.join(project.path, 'edited')
  await extractZip(target, { dir: extracted })
  const index = JSON.parse(await fs.readFile(path.join(extracted, 'modrinth.index.json'), 'utf8'))
  expect(index.files.map((file: { path: string }) => file.path)).not.toContain('resourcepacks/visuals.zip')
  expect(await fs.readFile(path.join(extracted, 'client-overrides/resourcepacks/visuals.zip'), 'utf8')).toBe('authored changes')
  const previous = await fs.readFile(target)
  await fs.unlink(resource)
  for (const mode of ['bundled', 'download'] as const) await expect(writeModrinthPackArchive(project, target, { mode })).rejects.toThrow('缺少文件')
  expect(await fs.readFile(target)).toEqual(previous)
  await expect(writeModrinthPackArchive(project, target, { mode: 'bad' as 'bundled' })).rejects.toThrow('导出方式无效')
})

it('cleans partial archives and preserves the previous output when the final rename fails', async () => {
  const project = await fixture()
  const target = path.join(project.path, 'previous.mrpack')
  await fs.writeFile(target, 'previous archive')
  const original = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).startsWith(`${target}.pending-`)) throw new Error('fixture rename failed')
    return original(from, to)
  })
  await expect(writeModrinthPackArchive(project, target)).rejects.toThrow('rename failed')
  expect(await fs.readFile(target, 'utf8')).toBe('previous archive')
  expect((await fs.readdir(project.path)).some(name => name.startsWith('previous.mrpack.pending-'))).toBe(false)
})

it('streams an actual file larger than 1 GiB and verifies its complete decompressed contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-export-large-'))
  roots.push(root)
  const project: ProjectInfo = { path: root, namespace: 'large', name: 'Large', kind: 'modpack', minecraftVersion: '1.21.1', loader: 'fabric', createdAt: '' }
  await createModpackTemplate(project)
  const size = 1024 ** 3 + 17
  const source = path.join(root, 'overrides/config/large.dat')
  await fs.writeFile(source, '')
  await fs.truncate(source, size)
  const handle = await fs.open(source, 'r+')
  try { await handle.write(Buffer.from('end marker'), 0, 10, size - 10) } finally { await handle.close() }
  const target = path.join(root, 'large.mrpack')
  await writeModrinthPackArchive(project, target)
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(target, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip!)))
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith('large.dat')) { zip.readEntry(); return }
      expect(entry.uncompressedSize).toBe(size)
      zip.openReadStream(entry, async (error, stream) => {
        if (error) { reject(error); return }
        try {
          let bytes = 0
          let tail = Buffer.alloc(0)
          for await (const chunk of stream!) { bytes += chunk.length; tail = Buffer.concat([tail, chunk]).subarray(-10) }
          expect(bytes).toBe(size)
          expect(tail.toString()).toBe('end marker')
          zip.close(); resolve()
        } catch (failure) { zip.close(); reject(failure) }
      })
    })
    zip.readEntry()
  })
}, 60_000)
