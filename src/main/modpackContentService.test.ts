import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { applyKeybindPreset, buildFtbQuestSnbt, buildPatchouliBook, detectKeybindConflicts, readKeybindState, writeFtbQuestChapter, writePatchouliBook } from "../../feature-plugins/modpack-content/src/main/modpackContentService"
import { addModpackFiles, createModpackTemplate } from './modpackService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function project(root: string): ProjectInfo { return { kind: 'modpack', name: 'Test Pack', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'test_pack', createdAt: new Date().toISOString() } }

async function installContentMods(pack: ProjectInfo): Promise<void> {
  await createModpackTemplate(pack)
  const sources = ['ftb-quests-forge.jar', 'patchouli.jar', 'kubejs-forge.jar'].map((name) => path.join(pack.path, name))
  await Promise.all(sources.map((source) => fs.writeFile(source, Buffer.alloc(2_048, 7))))
  await addModpackFiles(pack, sources)
}

describe('modpack content and profiles', () => {
  it('builds deterministic FTB Quests SNBT with namespaced IDs', () => {
    const built = buildFtbQuestSnbt(project('/tmp/pack'), { chapterId: 'getting_started', title: 'Getting Started', quests: [{ id: 'stone', title: 'Stone', tasks: [{ id: 'stone_task', title: 'Collect', type: 'item', item: 'minecraft:stone' }], rewards: [{ id: 'xp', type: 'xp', xp: 5 }] }] })
    expect(built.relativePath).toContain('ftbquests/quests/chapters/getting_started.snbt')
    expect(built.content).toMatch(/id:"[A-F0-9]{32}"/)
    expect(built.content).toContain('minecraft:stone')
  })

  it('writes a Patchouli book and keybind preset into pack overrides', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-content-'))
    roots.push(root)
    const pack = project(root)
    await installContentMods(pack)
    const files = await writePatchouliBook(pack, { bookId: 'guide', name: 'Guide', landingText: 'Welcome', categories: [{ id: 'start', name: 'Start', icon: 'minecraft:book', entries: [{ id: 'intro', name: 'Intro', icon: 'minecraft:stone', text: 'Hello' }] }] })
    expect(files).toHaveLength(3)
    expect(files).toContain('overrides/kubejs/data/test_pack/patchouli_books/guide/book.json')
    expect(files).toContain('overrides/kubejs/assets/test_pack/patchouli_books/guide/zh_cn/categories/start.json')
    const keybind = await applyKeybindPreset(pack, { id: 'default', name: 'Default', bindings: { 'key_test.jump': 'key.keyboard.j' } })
    expect(keybind.changed).toContain('key_test.jump')
    await expect(fs.readFile(path.join(root, 'overrides', 'options.txt'), 'utf8')).resolves.toContain('key_test.jump:key.keyboard.j')
    await writeFtbQuestChapter(pack, { chapterId: 'start', title: 'Start', quests: [{ id: 'one', title: 'One', tasks: [{ id: 'task', title: 'Task', type: 'checkmark' }] }] })
    await expect(fs.access(path.join(root, 'overrides', 'config', 'ftbquests', 'quests', 'chapters', 'start.snbt'))).resolves.toBeUndefined()
  })

  it('refuses content generators whose required runtime mods are absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-content-requirements-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    await expect(writeFtbQuestChapter(pack, { chapterId: 'start', title: 'Start', quests: [{ id: 'one', title: 'One', tasks: [{ id: 'task', title: 'Task', type: 'checkmark' }] }] })).rejects.toThrow(/ftbquests/)
    await expect(writePatchouliBook(pack, { bookId: 'guide', name: 'Guide', landingText: 'Welcome', categories: [{ id: 'start', name: 'Start', icon: 'minecraft:book', entries: [{ id: 'intro', name: 'Intro', icon: 'minecraft:stone', text: 'Hello' }] }] })).rejects.toThrow(/patchouli/)
  })

  it('rejects conflicting keybind presets unless explicitly allowed', async () => {
    expect(detectKeybindConflicts({ key_a: 'key.keyboard.j', key_b: 'key.keyboard.j' })).toEqual([{ key: 'key.keyboard.j', bindings: ['key_a', 'key_b'] }])
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-keybind-'))
    roots.push(root)
    const pack = project(root)
    await fs.mkdir(path.join(root, 'overrides'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'options.txt'), 'key_key.inventory:key.keyboard.e\n', 'utf8')
    await expect(applyKeybindPreset(pack, { id: 'conflict', name: 'Conflict', bindings: { 'key_example.open': 'key.keyboard.e' } })).rejects.toThrow(/conflicts/)
    await expect(applyKeybindPreset(pack, { id: 'override', name: 'Override', bindings: { 'key_example.open': 'key.keyboard.e' } }, true)).resolves.toMatchObject({ conflicts: [{ key: 'key.keyboard.e', bindings: ['key_key.inventory', 'key_example.open'] }] })
  })

  it('reads existing keybinds and reports their conflicts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-keybind-read-'))
    roots.push(root)
    const pack = project(root)
    await fs.mkdir(path.join(root, 'overrides'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'options.txt'), 'key_key.inventory:key.keyboard.e\nkey_example.open:key.keyboard.e\nrenderDistance:12\n', 'utf8')
    await expect(readKeybindState(pack)).resolves.toEqual({ path: 'overrides/options.txt', bindings: { 'key_key.inventory': 'key.keyboard.e', 'key_example.open': 'key.keyboard.e' }, conflicts: [{ key: 'key.keyboard.e', bindings: ['key_key.inventory', 'key_example.open'] }] })
  })
})
