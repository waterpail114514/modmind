import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { ProjectInfo } from '../shared/types'
import type { ManagedItem } from '../shared/itemEditor'
import { importItemTexture, listManagedItems, removeManagedItem, saveManagedItem } from './itemEditorService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(version = '1.21.1', loader: ProjectInfo['loader'] = 'fabric'): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-items-'))
  roots.push(root)
  if (loader === 'fabric' || loader === 'quilt') {
    const file = path.join(root, `src/main/resources/${loader}.mod.json`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, loader === 'quilt'
      ? JSON.stringify({ quilt_loader: { id: 'sample', entrypoints: { init: ['dev.modmind.sample.ModMindEntry'] } } })
      : JSON.stringify({ id: 'sample', entrypoints: { main: ['dev.modmind.sample.ModMindEntry'] } }))
  }
  return { kind: 'mod', name: 'Sample', namespace: 'sample', path: root, loader, minecraftVersion: version, createdAt: '' }
}

const item: ManagedItem = { id: 'copper_hammer', name: '铜锤', englishName: 'Copper Hammer', kind: 'item', stackSize: 1, durability: 256, texture: 'minecraft:item/iron_ingot' }

describe('managed item editor', () => {
  it('creates, edits and removes item registrations and resources without replacing other entries', async () => {
    const project = await fixture()
    const langPath = path.join(project.path, 'src/main/resources/assets/sample/lang/zh_cn.json')
    await fs.mkdir(path.dirname(langPath), { recursive: true })
    await fs.writeFile(langPath, JSON.stringify({ 'item.sample.existing': '保留' }))
    const created = await saveManagedItem(project, { revision: 0, item })
    expect(created.revision).toBe(1)
    const descriptor = JSON.parse(await fs.readFile(path.join(project.path, 'src/main/resources/fabric.mod.json'), 'utf8'))
    expect(descriptor.entrypoints.main).toEqual(['dev.modmind.sample.ModMindEntry', 'dev.modmind.sample.generated.ModMindItems'])
    const javaPath = path.join(project.path, 'src/main/java/dev/modmind/sample/generated/ModMindItems.java')
    expect(await fs.readFile(javaPath, 'utf8')).toContain('new Item.Properties().stacksTo(1).durability(256)')
    expect(await fs.readFile(javaPath, 'utf8')).toContain('ResourceLocation.fromNamespaceAndPath(MOD_ID, id)')
    expect(JSON.parse(await fs.readFile(langPath, 'utf8'))).toMatchObject({ 'item.sample.existing': '保留', 'item.sample.copper_hammer': '铜锤' })

    const updated = await saveManagedItem(project, { revision: 1, item: { ...item, name: '铜制锤' } })
    expect(updated.revision).toBe(2)
    expect(JSON.parse(await fs.readFile(langPath, 'utf8'))['item.sample.copper_hammer']).toBe('铜制锤')
    const removed = await removeManagedItem(project, item.id, 2)
    expect(removed.items).toEqual([])
    expect(await fs.readFile(javaPath, 'utf8')).not.toContain('register("copper_hammer"')
    expect(JSON.parse(await fs.readFile(langPath, 'utf8'))).toEqual({ 'item.sample.existing': '保留' })
    await expect(fs.access(path.join(project.path, 'src/main/resources/assets/sample/models/item/copper_hammer.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects stale saves and hand-edited generated files', async () => {
    const project = await fixture('1.20.1')
    await saveManagedItem(project, { revision: 0, item })
    await expect(saveManagedItem(project, { revision: 0, item })).rejects.toThrow('已更新')
    const javaPath = path.join(project.path, 'src/main/java/dev/modmind/sample/generated/ModMindItems.java')
    expect(await fs.readFile(javaPath, 'utf8')).toContain('new ResourceLocation(MOD_ID, id)')
    await fs.appendFile(javaPath, '// hand edit\n')
    await expect(saveManagedItem(project, { revision: 1, item: { ...item, name: '新名字' } })).rejects.toThrow('手动修改')
    expect((await listManagedItems(project)).revision).toBe(1)
  })

  it('does not overwrite existing item models and rejects unsupported versions', async () => {
    const project = await fixture()
    const model = path.join(project.path, 'src/main/resources/assets/sample/models/item/copper_hammer.json')
    await fs.mkdir(path.dirname(model), { recursive: true })
    await fs.writeFile(model, '{"parent":"custom"}')
    await expect(saveManagedItem(project, { revision: 0, item })).rejects.toThrow('已存在')
    expect(JSON.parse(await fs.readFile(path.join(project.path, 'src/main/resources/fabric.mod.json'), 'utf8')).entrypoints.main).toHaveLength(1)
    expect((await listManagedItems({ ...project, minecraftVersion: '1.21.4' })).supported).toBe(false)
  })

  it('imports a PNG once and makes it selectable', async () => {
    const project = await fixture()
    const source = path.join(project.path, 'hammer.png')
    await fs.writeFile(source, await sharp({ create: { width: 16, height: 16, channels: 4, background: '#c28143' } }).png().toBuffer())
    expect(await importItemTexture(project, source)).toBe('sample:item/hammer')
    expect((await listManagedItems(project)).textures).toContain('sample:item/hammer')
    await expect(importItemTexture(project, source)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it.each([['quilt', '1.20.1'], ['forge', '1.20.1'], ['neoforge', '1.21.1']] as const)('writes managed items for %s %s', async (loader, version) => {
    const project = await fixture(version, loader)
    const sword: ManagedItem = { ...item, kind: 'sword', tier: 'iron', attackDamage: 3, attackSpeed: -2.4 }
    const state = await saveManagedItem(project, { revision: 0, item: sword })
    expect(state.items).toHaveLength(1)
    const source = await fs.readFile(path.join(project.path, 'src/main/java/dev/modmind/sample/generated/ModMindItems.java'), 'utf8')
    expect(source).toContain('new SwordItem(')
    if (loader === 'quilt') {
      const descriptor = JSON.parse(await fs.readFile(path.join(project.path, 'src/main/resources/quilt.mod.json'), 'utf8'))
      expect(descriptor.quilt_loader.entrypoints.init).toHaveLength(2)
    } else expect(source).toContain('RegisterEvent')
  })

  it('reads records created before equipment types were added', async () => {
    const project = await fixture()
    const metadata = path.join(project.path, '.modmind/item-editor.json')
    await fs.mkdir(path.dirname(metadata), { recursive: true })
    const { kind: _kind, ...legacy } = item
    await fs.writeFile(metadata, JSON.stringify({ revision: 4, items: [legacy] }))
    expect((await listManagedItems(project)).items[0].kind).toBe('item')
    await expect(saveManagedItem(project, { revision: 4, item: { ...item, id: 'another' } })).resolves.toMatchObject({ revision: 5 })
    await expect(saveManagedItem(project, { revision: 5, item: { ...item, id: 'bad', kind: undefined as never } })).rejects.toThrow('字段无效')
  })

  it('serializes concurrent saves for the same project', async () => {
    const project = await fixture()
    const results = await Promise.allSettled([
      saveManagedItem(project, { revision: 0, item }),
      saveManagedItem(project, { revision: 0, item: { ...item, id: 'second' } })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await listManagedItems(project)).items).toHaveLength(1)
  })
})
