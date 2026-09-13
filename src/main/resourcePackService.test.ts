import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createResourcePack, importResourcePack, previewResourcePackModel, resourcePackModelDocument, readResourcePackFile, resourcePackArchive, validateResourcePack, writeResourcePackFile } from './resourcePackService'
import sharp from 'sharp'
import { archiveEntries } from './ftbResourceArchive'
import { createStoredZip } from './bedrockAddon'
import { listResourcePacks, makeResourcePackEditable, removeResourcePackFile, importResourcePackAssets, deployResourcePack, resourcePackThumbnail } from './resourcePackService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function project(): Promise<ProjectInfo> { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resource-pack-'))); roots.push(root); return { name: 'Test', path: root, namespace: 'test', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } }

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

it('previews inherited geometry with current pack textures and refreshes after an edit', async () => {
  const p = await project(), pack = await createResourcePack(p, { name: 'preview', description: '', packFormat: 34 })
  const texturePath = 'assets/test/textures/block/example.png'
  const png = async (color: string): Promise<string> => `data:image/png;base64,${(await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer()).toString('base64')}`
  await writeResourcePackFile(p, pack.id, texturePath, await png('#ff0000'), null)
  await writeResourcePackFile(p, pack.id, 'assets/test/models/block/base.json', JSON.stringify({ textures: { all: 'test:block/example' }, elements: [{ from: [0,0,0], to: [16,16,16], faces: { north: { texture: '#all' } } }] }), null)
  const file = 'assets/test/models/block/child.json'
  await writeResourcePackFile(p, pack.id, file, '{"parent":"test:block/base"}', null)
  const first = await previewResourcePackModel(p, pack.id, file)
  expect(first.icon?.modelPreview?.elements).toHaveLength(1)
  const before = first.icon!.modelPreview!.textures['#all']
  const { baseline } = await readResourcePackFile(p, pack.id, texturePath)
  await writeResourcePackFile(p, pack.id, texturePath, await png('#00ff00'), baseline)
  expect((await previewResourcePackModel(p, pack.id, file)).icon?.modelPreview?.textures['#all']).not.toBe(before)
  const document = await resourcePackModelDocument(p, pack.id, file)
  expect(document.document.model.textures).toEqual({ all: 'test:block/example' })
  expect(document.document.model.elements).toHaveLength(1)
})

it('fails closed on model cycles, missing textures and preview traversal', async () => {
  const p = await project(), pack = await createResourcePack(p, { name: 'cycle', description: '', packFormat: 34 })
  const file = 'assets/test/models/block/loop.json'
  await writeResourcePackFile(p, pack.id, file, '{"parent":"test:block/loop"}', null)
  const result = await previewResourcePackModel(p, pack.id, file)
  expect(result.icon).toBeNull()
  expect(result.reason).toMatch(/cycle/i)
  await expect(previewResourcePackModel(p, pack.id, '../outside.json')).rejects.toThrow('路径')
  const missing = 'assets/test/models/item/missing.json'
  await writeResourcePackFile(p, pack.id, missing, '{"parent":"minecraft:item/generated","textures":{"layer0":"test:item/missing"}}', null)
  expect((await previewResourcePackModel(p, pack.id, missing)).icon).toBeNull()
})


it('lists existing Java source assets alongside managed packs without requiring pack metadata', async () => {
  const p = await project()
  await fs.mkdir(path.join(p.path, 'src', 'main', 'resources', 'assets', 'test', 'textures', 'item'), { recursive: true })
  await fs.writeFile(path.join(p.path, 'src', 'main', 'resources', 'assets', 'test', 'textures', 'item', 'example.png'), await sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } }).png().toBuffer())
  const packs = await listResourcePacks(p)
  expect(packs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'project:src/main/resources', origin: 'project', files: expect.arrayContaining([expect.objectContaining({ path: 'assets/test/textures/item/example.png', kind: 'image' })]) })]))
  const source = packs.find(item => item.id === 'project:src/main/resources')!
  expect((await validateResourcePack(p, source.id)).success).toBe(true)
  await expect(resourcePackArchive(p, source.id)).rejects.toThrow('原位置编辑')
})

it.each(['overrides', 'instance'])('lists installed ZIPs and directories as individual packs in %s layout', async layout => {
  const p = { ...await project(), kind: 'modpack' as const }
  await fs.writeFile(path.join(p.path, 'modmind.pack.json'), JSON.stringify({ source: { layout } }))
  const installed = path.join(p.path, layout === 'instance' ? '' : 'overrides', 'resourcepacks')
  const directory = path.join(installed, '目录资源包')
  await fs.mkdir(path.join(directory, 'assets/test/models/block'), { recursive: true })
  await fs.mkdir(path.join(directory, 'assets/test/textures/block'), { recursive: true })
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#3182aa' } }).png().toBuffer()
  const files = [
    { name: 'pack.mcmeta', data: Buffer.from('{"pack":{"pack_format":34,"description":"Installed pack"}}') },
    { name: 'assets/test/textures/block/cube.png', data: png },
    { name: 'assets/test/models/block/cube.json', data: Buffer.from(JSON.stringify({ textures: { all: 'test:block/cube' }, elements: [{ from: [0,0,0], to: [16,16,16], faces: { north: { texture: '#all' } } }] })) }
  ]
  for (const file of files) await fs.writeFile(path.join(directory, file.name), file.data)
  const bytes = createStoredZip(files)
  await fs.writeFile(path.join(installed, '示例.zip'), bytes)
  // A broken sibling must not hide the healthy packs.
  await fs.writeFile(path.join(installed, 'broken.zip'), 'not a zip')
  const list = await listResourcePacks(p)
  const zip = list.find(pack => pack.id === 'installed:示例.zip')!
  const dir = list.find(pack => pack.id === 'installed:目录资源包')!
  expect(zip).toMatchObject({ origin: 'installed', readOnly: true, description: 'Installed pack' })
  expect(dir).toMatchObject({ origin: 'installed', readOnly: false })
  expect(zip.files).toEqual(dir.files)
  expect(list.find(pack => pack.id === 'installed:broken.zip')?.error).toBeTruthy()
  const texture = files[1].name, model = files[2].name
  expect((await readResourcePackFile(p, zip.id, texture)).dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
  expect(await resourcePackThumbnail(p, zip.id, texture)).toMatch(/^data:image\/png;base64,/)
  const preview = await previewResourcePackModel(p, zip.id, model)
  expect(preview.icon?.modelPreview?.elements).toHaveLength(1)
  expect(preview.localReferences).toContain(texture)
  expect((await validateResourcePack(p, zip.id)).success).toBe(true)
  await expect(writeResourcePackFile(p, zip.id, 'pack.mcmeta', '{}', null)).rejects.toThrow('只读')
  await expect(removeResourcePackFile(p, zip.id, model, '')).rejects.toThrow('只读')
  await expect(importResourcePackAssets(p, zip.id, 'assets/test/textures', [])).rejects.toThrow('只读')
  await expect(resourcePackModelDocument(p, zip.id, model)).rejects.toThrow('只读')
  await expect(deployResourcePack(p, zip.id)).rejects.toThrow('无需重复部署')
  const original = await readResourcePackFile(p, dir.id, 'pack.mcmeta')
  await writeResourcePackFile(p, dir.id, 'pack.mcmeta', '{"pack":{"pack_format":34,"description":"Edited in place"}}', original.baseline)
  expect(await fs.readFile(path.join(directory, 'pack.mcmeta'), 'utf8')).toContain('Edited in place')
  const copy = await makeResourcePackEditable(p, zip.id)
  expect(copy.readOnly).toBe(false)
  const snapshot = await readResourcePackFile(p, copy.id, 'pack.mcmeta')
  await writeResourcePackFile(p, copy.id, 'pack.mcmeta', '{"pack":{"pack_format":34,"description":"Editable copy"}}', snapshot.baseline)
  expect(await fs.readFile(path.join(installed, '示例.zip'))).toEqual(bytes)
  expect((await readResourcePackFile(p, zip.id, 'pack.mcmeta')).text).toContain('Installed pack')
  await expect(readResourcePackFile(p, 'installed:../escape.zip', 'pack.mcmeta')).rejects.toThrow('路径')
  await expect(readResourcePackFile(p, zip.id, '../private.json')).rejects.toThrow('路径')
})

it.each(['directory', 'zip'])('browses %s ancillary files and reports unsupported binaries without rejecting reads', async storage => {
  const p = { ...await project(), kind: 'modpack' as const }
  const resources = path.join(p.path, 'overrides/resourcepacks')
  await fs.mkdir(resources, { recursive: true })
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#c08040' } }).png().toBuffer()
  const jpg = await sharp(png).jpeg().toBuffer()
  const files = [
    { name: 'pack.mcmeta', data: Buffer.from('{"pack":{"pack_format":34,"description":"Mixed files"}}') },
    { name: 'assets/test/textures/icon.PNG', data: png },
    { name: 'assets/test/textures/banner.JPG', data: jpg },
    { name: 'docs/README.TXT', data: Buffer.from('Pack instructions') },
    { name: 'assets/test/lang/zh_cn.JSON', data: Buffer.from('{"item.test.name":"测试"}') },
    { name: 'assets/test/font/custom.ttf', data: Buffer.from([0,1,0,0]) },
    { name: 'assets/test/extra/model.ysm', data: Buffer.from([255,0,128,3]) },
    { name: 'metadata.yaml', data: Buffer.from('name: test') }
  ]
  const name = storage === 'zip' ? 'mixed.zip' : 'mixed'
  const root = path.join(resources, name)
  if (storage === 'zip') await fs.writeFile(root, createStoredZip(files))
  else for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file.name)), { recursive: true }); await fs.writeFile(path.join(root, file.name), file.data) }
  const id = `installed:${name}`
  const list = await listResourcePacks(p)
  expect(list.find(pack => pack.id === id)?.files).toHaveLength(files.length)
  expect((await readResourcePackFile(p, id, files[1].name)).dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(await readResourcePackFile(p, id, files[2].name)).toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/), readOnly: true })
  expect(await resourcePackThumbnail(p, id, files[1].name)).toMatch(/^data:image\/png;base64,/)
  expect(await resourcePackThumbnail(p, id, files[2].name)).toMatch(/^data:image\/png;base64,/)
  expect(await readResourcePackFile(p, id, files[3].name)).toMatchObject({ text: 'Pack instructions', readOnly: true })
  expect((await readResourcePackFile(p, id, files[4].name)).text).toContain('测试')
  for (const file of files.slice(5,7)) {
    const result = await readResourcePackFile(p, id, file.name)
    expect(result).toMatchObject({ readOnly: true, unsupported: expect.stringContaining('不支持预览'), size: 4 })
    expect(result.text).toBeUndefined()
    expect(result.dataUrl).toBeUndefined()
  }
  expect(await readResourcePackFile(p, id, 'metadata.yaml')).toMatchObject({ readOnly: true, text: 'name: test' })
  await expect(readResourcePackFile(p, id, '../private.txt')).rejects.toThrow('路径')
  if (storage === 'directory') {
    const original = await readResourcePackFile(p, id, files[1].name)
    await writeResourcePackFile(p, id, files[1].name, original.dataUrl!, original.baseline)
    expect(await fs.readFile(path.join(root, files[1].name))).toEqual(png)
    await expect(writeResourcePackFile(p, id, 'metadata.yaml', 'replacement', null)).rejects.toThrow()
    await expect(writeResourcePackFile(p, id, files[6].name, 'replacement', null)).rejects.toThrow('文件类型')
  }
})
