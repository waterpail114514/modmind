import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ProjectInfo } from '../shared/types'
import { dataPackPath, newDataPackContent, readDataPackForm, writeDataPackForm } from '../shared/dataPack'
import { createDataPack, createDataPackEntry, dataPackHistory, restoreDataPackHistory, exportDataPack, importDataPack, listDataPacks, readDataPackDocument, removeDataPackDocument, validateDataPackContent, writeDataPackDocument } from '../../feature-plugins/data-packs/src/main/dataPackService'
import { archiveEntries, archiveRead } from './archiveInspection'
const temporary: string[] = []
async function project(kind: 'mod' | 'modpack' = 'mod', version = '1.21.1'): Promise<ProjectInfo> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-datapack-')); temporary.push(root); return { path: root, kind, name: '验收', namespace: 'sample', loader: 'fabric', minecraftVersion: version, createdAt: '' } as ProjectInfo }
afterEach(async () => { for (const root of temporary.splice(0)) { if (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('modmind-datapack-')) throw Error('Unexpected cleanup target'); await fs.rm(root, { recursive: true, force: true }) } })

describe('versioned datapack authoring', () => {
  it.each(['1.20.1', '1.20.6', '1.21.1', '1.21.2', '26.3'])('creates a versioned recipe and round trips unknown data without losing components for %s', version => {
    const file = dataPackPath(version, 'sample', 'tools/hammer', 'recipe-shaped'), original = JSON.parse(newDataPackContent(version, 'recipe-shaped'))
    original.custom_mod = { configuration: [1, 2] }; original.result.components = { 'minecraft:custom_name': 'Hammer' }
    const form = readDataPackForm('recipe-shaped', JSON.stringify(original)).form!
    form.slots = ['', 'minecraft:iron_ingot', '', 'minecraft:stick', '#minecraft:logs', '', '', '', '']; form.count = 2
    const saved = writeDataPackForm(version, JSON.stringify(original), form), value = JSON.parse(saved)
    expect(value.custom_mod).toEqual(original.custom_mod); expect(value.result.components).toEqual(original.result.components)
    expect(validateDataPackContent(version, file, saved).valid).toBe(true)
    expect(readDataPackForm('recipe-shaped', saved).form?.count).toBe(2)
    expect(file).toContain(version === '1.20.1' || version === '1.20.6' ? '/recipes/' : '/recipe/')
    expect(value.result[version === '1.20.1' ? 'item' : 'id']).toBe('minecraft:stone')
    expect(typeof value.key.A).toBe(version === '1.21.2' || version === '26.3' ? 'string' : 'object')
  })
  it('retains complex ingredient and tag object source instead of flattening it', () => {
    expect(readDataPackForm('recipe-shaped', JSON.stringify({ type: 'minecraft:crafting_shaped', pattern: ['A'], key: { A: [{ item: 'minecraft:stone' }, { item: 'minecraft:dirt' }] }, result: { id: 'minecraft:stone' } })).form).toBeNull()
    expect(readDataPackForm('item-tag', '{"values":[{"id":"sample:optional","required":false}]}').form).toBeNull()
  })
  it('keeps loot conditions and functions while changing its item', () => {
    const original = JSON.parse(newDataPackContent('1.21.1', 'loot-block')); original.pools[0].entries[0].functions = [{ function: 'minecraft:set_count', count: 3 }]
    const form = readDataPackForm('loot-block', JSON.stringify(original)).form!; form.result = 'minecraft:diamond'
    const value = JSON.parse(writeDataPackForm('1.21.1', JSON.stringify(original), form))
    expect(value.pools[0].conditions).toEqual(original.pools[0].conditions); expect(value.pools[0].entries[0].functions).toEqual(original.pools[0].entries[0].functions); expect(value.pools[0].entries[0].name).toBe('minecraft:diamond')
  })
  it('validates shaped symbols, old ingredient formats, result IDs and quantities', () => {
    const original = JSON.parse(newDataPackContent('1.20.1', 'recipe-shaped'))
    original.pattern = ['X']; original.result.count = -2
    expect(validateDataPackContent('1.20.1', 'data/sample/recipes/test.json', JSON.stringify(original)).errors.length).toBeGreaterThan(1)
    original.pattern = ['A']; original.result.count = 1; original.result.item = '#minecraft:logs'
    expect(validateDataPackContent('1.20.1', 'data/sample/recipes/test.json', JSON.stringify(original)).valid).toBe(false)
    original.result.item = 'minecraft:stone'; original.key.A = 'minecraft:dirt'
    expect(validateDataPackContent('1.20.1', 'data/sample/recipes/test.json', JSON.stringify(original)).valid).toBe(false)
  })
  it('allows predicate arrays and returns explicit limitations for advanced and command source', () => {
    expect(validateDataPackContent('1.21.1', 'data/sample/predicate/test.json', '[]').valid).toBe(true)
    expect(validateDataPackContent('1.21.1', 'data/sample/function/test.mcfunction', 'say hello').warnings).not.toHaveLength(0)
    expect(validateDataPackContent('1.21.1', 'data/sample/recipe/broken.json', '{').valid).toBe(false)
  })
})
describe('project-scoped data packs', () => {
  it('creates and reopens mod data; rejects stale, racing and missing baselines; preserves recovery source', async () => {
    const p = await project(), root = 'src/main/resources', first = await createDataPackEntry(p, root, 'recipe-shaped', 'sample', 'test')
    const value = JSON.parse(first.content); value.result.count = 2; const content = JSON.stringify(value)
    const results = await Promise.allSettled([writeDataPackDocument(p, { root, path: first.path, content, baseline: first.baseline }), writeDataPackDocument(p, { root, path: first.path, content, baseline: first.baseline })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(writeDataPackDocument(p, { root, path: first.path, content, baseline: null })).rejects.toThrow('修改')
    const saved = await readDataPackDocument(p, root, first.path); expect(JSON.parse(saved.content).result.count).toBe(2)
    const history = await fs.readdir(path.join(p.path, '.modmind/data-pack-history')); expect(history.length).toBe(1)
    const removed = await removeDataPackDocument(p, root, saved.path, saved.baseline)
    expect(JSON.parse(await fs.readFile(path.join(p.path, removed.recoveryPath), 'utf8')).content).toBe(saved.content)
    const recovery = (await dataPackHistory(p, root)).entries.find(entry => entry.id === path.basename(removed.recoveryPath))!
    const restored = await restoreDataPackHistory(p, root, recovery.id, recovery.baseline)
    expect(restored.content).toBe(saved.content)
  })
  it('does not write outside allowed roots or through a junction', async () => {
    const p = await project(), other = await project()
    await expect(createDataPackEntry(p, '../escape', 'item-tag', 'sample', 'test')).rejects.toThrow()
    await expect(createDataPackEntry(p, 'src/main/resources', 'item-tag', 'sample', '../escape')).rejects.toThrow()
    await fs.mkdir(path.join(p.path, 'src/main/resources'), { recursive: true })
    await fs.symlink(other.path, path.join(p.path, 'src/main/resources/data'), 'junction')
    try { await expect(createDataPackEntry(p, 'src/main/resources', 'item-tag', 'sample', 'test')).rejects.toThrow('链接'); expect(await fs.readdir(other.path)).toHaveLength(0) } finally { await fs.unlink(path.join(p.path, 'src/main/resources/data')) }
  })
  it('exports a game-loadable ZIP and imports it without replacing an existing pack', async () => {
    const p = await project('modpack'), info = await createDataPack(p, 'my_pack')
    await createDataPackEntry(p, info.root, 'item-tag', 'sample', 'ores')
    const exported = await exportDataPack(p, info.root), files = await archiveEntries(exported.path)
    expect(files).toContain('pack.mcmeta'); expect(files).toContain('data/sample/tags/item/ores.json'); expect(files).not.toContain('items.json')
    expect(JSON.parse((await archiveRead(exported.path, 'pack.mcmeta')).toString()).pack.pack_format).toBe(48)
    const imported = await importDataPack(p, exported.path); expect(imported.root).not.toBe(info.root); expect((await listDataPacks(p)).length).toBe(2)
    expect(JSON.parse((await readDataPackDocument(p, imported.root, 'data/sample/tags/item/ores.json')).content).values).toEqual(['minecraft:stone'])
  })
  it('exports mod data with data-pack metadata instead of borrowing resource-pack metadata', async () => {
    const p = await project('mod', '1.20.1'); await createDataPackEntry(p, 'src/main/resources', 'item-tag', 'sample', 'ores')
    await fs.writeFile(path.join(p.path, 'src/main/resources/pack.mcmeta'), '{"pack":{"description":"resource","pack_format":15}}')
    const exported = await exportDataPack(p, 'src/main/resources')
    expect(JSON.parse((await archiveRead(exported.path, 'pack.mcmeta')).toString()).pack.pack_format).toBe(15)
    expect(await archiveEntries(exported.path)).not.toContain('assets/')
  })
  it('keeps malformed files readable for source repair while blocking invalid saves', async () => {
    const p = await project(), first = await createDataPackEntry(p, 'src/main/resources', 'item-tag', 'sample', 'ores')
    await fs.writeFile(path.join(p.path, 'src/main/resources', first.path), '{bad')
    const broken = await readDataPackDocument(p, 'src/main/resources', first.path); expect(broken.content).toBe('{bad'); expect(broken.validation.valid).toBe(false)
    await expect(writeDataPackDocument(p, { root: 'src/main/resources', path: first.path, content: '{bad', baseline: broken.baseline })).rejects.toThrow()
  })
})
