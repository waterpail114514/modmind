import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createResourcePack, importResourcePack, readResourcePackFile, resourcePackArchive, validateResourcePack, writeResourcePackFile } from './resourcePackService'
import { archiveEntries } from './ftbResourceArchive'
import { createStoredZip } from './bedrockAddon'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function project(): Promise<ProjectInfo> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-pack-')); roots.push(root); return { name: 'Test', path: root, namespace: 'test', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } }

it('creates and exports a pack with pack.mcmeta at archive root', async () => {
  const p = await project()
  const pack = await createResourcePack(p, { name: 'test-pack', description: 'Test pack', packFormat: 34 })
  await writeResourcePackFile(p, pack.id, 'assets/test/lang/en_us.json', '{"item.test.example":"Example"}', null)
  expect((await validateResourcePack(p, pack.id)).success).toBe(true)
  const zip = path.join(p.path, 'export.zip')
  await fs.writeFile(zip, await resourcePackArchive(p, pack.id))
  expect(await archiveEntries(zip)).toEqual(expect.arrayContaining(['pack.mcmeta', 'assets/test/lang/en_us.json']))
  const imported = await importResourcePack(p, zip)
  expect(imported.packFormat).toBe(34)
  expect(imported.files).toHaveLength(2)
})

it('rejects stale writes and traversal without changing existing content', async () => {
  const p = await project()
  const pack = await createResourcePack(p, { name: 'safe', description: '', packFormat: 34 })
  const original = await readResourcePackFile(p, pack.id, 'pack.mcmeta')
  await fs.writeFile(path.join(p.path, pack.path, 'pack.mcmeta'), '{"external":true}')
  await expect(writeResourcePackFile(p, pack.id, 'pack.mcmeta', '{}', original.baseline)).rejects.toThrow('其它操作')
  await expect(writeResourcePackFile(p, pack.id, 'assets/../../escape.json', '{}', null)).rejects.toThrow('路径')
  expect(await fs.readFile(path.join(p.path, pack.path, 'pack.mcmeta'), 'utf8')).toBe('{"external":true}')
})

it('reports missing custom resources and blocks invalid exports', async () => {
  const p = await project()
  const pack = await createResourcePack(p, { name: 'broken', description: '', packFormat: 34 })
  await writeResourcePackFile(p, pack.id, 'assets/test/models/item/example.json', '{"textures":{"layer0":"test:item/missing"}}', null)
  expect((await validateResourcePack(p, pack.id)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', path: 'assets/test/models/item/example.json' })]))
  await expect(resourcePackArchive(p, pack.id)).rejects.toThrow('校验失败')
})

it('rejects archives without pack metadata', async () => {
  const p = await project(), zip = path.join(p.path, 'invalid.zip')
  await fs.writeFile(zip, createStoredZip([{ name: 'assets/test/readme.txt', data: Buffer.from('no descriptor') }]))
  await expect(importResourcePack(p, zip)).rejects.toThrow('pack.mcmeta')
})
