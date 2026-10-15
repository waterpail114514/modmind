import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProjectInfo } from '../shared/types'
import { renameProjectFiles } from './projectRename'
import { ContentService } from './contentService'
import { saveManagedItem } from './itemEditorService'
import { readFtbQuestBook, saveFtbQuestBook } from './ftbQuestBookService'
import { SoundLibraryService } from './soundLibraryService'
import { soundServiceForProject } from './soundLibraryIpc'
import { readPatchouliBooks, writePatchouliBook, writeFtbQuestChapter, buildPatchouliBook } from './modpackContentService'
import { createModpackTemplate, addModpackFiles, readModpackManifest, writeModpackManifest } from './modpackService'
vi.mock('electron', () => ({ dialog: {} }))
vi.mock('./diagnosticIpc', () => ({ diagnosticHandle: vi.fn() }))

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture(kind: ProjectInfo['kind'] = 'mod'): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-audit-fixes-')); roots.push(root)
  return { path: root, kind, namespace: 'mod', name: 'Mod', minecraftVersion: '1.20.1', loader: 'fabric', createdAt: '' }
}
async function write(project: ProjectInfo, relative: string, content: string): Promise<string> {
  const file = path.join(project.path, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file
}
const fail = (): NodeJS.ErrnoException => Object.assign(new Error('injected disk failure'), { code: 'EACCES' })

describe('existing content audit fixes', () => {
  it('AUD001 restores every moved file after a staging rename fails', async () => {
    const project = await fixture()
    await write(project, 'assets/mod/a.bin', 'original-a'); await write(project, 'assets/mod/b.bin', 'original-b')
    const rename = fs.rename.bind(fs); let count = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (++count === 2) throw fail(); return rename(from, to) })
    await expect(renameProjectFiles(project, { ...project, namespace: 'next' })).rejects.toThrow('disk failure')
    expect(await fs.readFile(path.join(project.path, 'assets/mod/a.bin'), 'utf8')).toBe('original-a')
    expect(await fs.readFile(path.join(project.path, 'assets/mod/b.bin'), 'utf8')).toBe('original-b')
    expect((await fs.readdir(project.path)).some(name => name.startsWith('.modmind-rename-'))).toBe(false)
  })
  it('AUD002 replaces namespace tokens while preserving models, modmind and manifests', async () => {
    const project = await fixture()
    await write(project, 'assets/mod/models/item/model.json', '{"parent":"mod:item/model","note":"model modmind modern"}')
    await write(project, 'modmind.pack.json', '{"namespace":"mod"}')
    await renameProjectFiles(project, { ...project, namespace: 'next', name: 'Next' }, ['modmind.pack.json'])
    expect(await fs.readFile(path.join(project.path, 'assets/next/models/item/model.json'), 'utf8')).toBe('{"parent":"next:item/model","note":"model modmind modern"}')
    expect(await fs.readFile(path.join(project.path, 'modmind.pack.json'), 'utf8')).toBe('{"namespace":"mod"}')
  })
  it.each(['chapters', 'reward_tables'])('AUD003 keeps a case-only %s rename', async folder => {
    const project = await fixture('modpack')
    await write(project, `overrides/config/ftbquests/quests/${folder}/start.snbt`, folder === 'chapters' ? '{id:"C1",title:"Start",quests:[]}' : '{id:"T1",title:"Start",rewards:[]}')
    const book = await readFtbQuestBook(project)
    if (folder === 'chapters') book.chapters[0].filename = 'Start'
    else book.rewardTables[0].filename = 'Start'
    await saveFtbQuestBook(project, book)
    const saved = await readFtbQuestBook(project)
    expect(folder === 'chapters' ? saved.chapters.length : saved.rewardTables.length).toBe(1)
  })
  it('AUD009 merges BOM JSON and rejects malformed JSON without changing it', async () => {
    const project = await fixture(), service = new ContentService(() => project)
    const file = await write(project, 'src/main/resources/assets/mod/lang/en_us.json', '\uFEFF{"old":"keep"}')
    await service.create({ kind: 'language', id: 'new', data: { key: 'new', value: 'new' } })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ old: 'keep', new: 'new' })
    await fs.writeFile(file, '{broken')
    await expect(service.create({ kind: 'language', id: 'new', data: { key: 'new', value: 'next' } })).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
    const audio = await write(project, 'src/main/resources/assets/mod/sounds/tone.ogg', 'OggSold')
    const sounds = await write(project, 'src/main/resources/assets/mod/sounds.json', '{broken')
    const source = await write(project, 'new.ogg', 'OggSnew')
    await expect(service.importAudio(source, { eventId: 'tone' })).rejects.toThrow()
    expect(await fs.readFile(audio, 'utf8')).toBe('OggSold'); expect(await fs.readFile(sounds, 'utf8')).toBe('{broken')
  })
  const item = { id: 'thing', name: '物品', englishName: 'Thing', kind: 'item' as const, stackSize: 64, durability: 0, texture: 'minecraft:item/iron_ingot' }
  it('AUD016 rolls back a failed item promotion including earlier committed files', async () => {
    const project = await fixture(), descriptor = await write(project, 'src/main/resources/fabric.mod.json', '{"id":"mod"}')
    await saveManagedItem(project, { revision: 0, item })
    const metadata = path.join(project.path, '.modmind/item-editor.json'), before = await fs.readFile(metadata)
    const rename = fs.rename.bind(fs); let failed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (!failed && String(to).endsWith('lang/en_us.json'.replaceAll('/', path.sep)) && String(from).includes('.pending-')) { failed = true; throw fail() }; return rename(from, to) })
    await expect(saveManagedItem(project, { revision: 1, item: { ...item, name: 'Changed', englishName: 'Changed' } })).rejects.toThrow('disk failure')
    expect(failed).toBe(true); expect(await fs.readFile(metadata)).toEqual(before)
    expect(await fs.readFile(path.join(project.path, 'src/main/resources/assets/mod/lang/zh_cn.json'), 'utf8')).toContain('物品')
    expect(JSON.parse(await fs.readFile(descriptor, 'utf8')).id).toBe('mod')
  })
  it('AUD055 refuses a hardlinked item descriptor without modifying the external inode', async () => {
    const project = await fixture(), external = await write(project, 'external.json', '{"id":"mod"}')
    const descriptor = path.join(project.path, 'src/main/resources/fabric.mod.json'); await fs.mkdir(path.dirname(descriptor), { recursive: true }); await fs.link(external, descriptor)
    await expect(saveManagedItem(project, { revision: 0, item })).rejects.toThrow('链接')
    expect(await fs.readFile(external, 'utf8')).toBe('{"id":"mod"}')
  })
  it('AUD058 recovers both files after failed undo, then permits retry', async () => {
    const project = await fixture(), service = new SoundLibraryService(project, path.join(project.path, 'mc'), path.join(project.path, 'cache'))
    const audio = await write(project, 'src/main/resources/assets/mod/sounds/new.ogg', 'OggSnew')
    const definition = await write(project, 'src/main/resources/assets/mod/sounds.json', '{"new":{}}')
    const directory = '.modmind/sounds/history/1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    await write(project, `${directory}/1`, '{"old":{}}')
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
    await write(project, `${directory}/history.json`, JSON.stringify({ files: [{ relative: path.relative(project.path, audio).replaceAll('\\', '/'), before: false, after: digest('OggSnew') }, { relative: path.relative(project.path, definition).replaceAll('\\', '/'), before: true, after: digest('{"new":{}}') }] }))
    const rename = fs.rename.bind(fs); let failed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (!failed && to === definition) { failed = true; throw fail() }; return rename(from, to) })
    await expect(service.undo()).rejects.toThrow('disk failure')
    expect(await fs.readFile(audio, 'utf8')).toBe('OggSnew'); expect(await fs.readFile(definition, 'utf8')).toBe('{"new":{}}')
    await service.undo()
    await expect(fs.access(audio)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await fs.readFile(definition, 'utf8')).toBe('{"old":{}}')
  })
  it('AUD059 refreshes the cached sound service after namespace changes', async () => {
    const project = await fixture(), cache = path.join(project.path, 'cache'), mc = path.join(project.path, 'mc')
    const first = soundServiceForProject(project, mc, cache)
    expect(soundServiceForProject(project, mc, cache)).toBe(first)
    const next = soundServiceForProject({ ...project, namespace: 'next' }, mc, cache)
    expect(next).not.toBe(first)
    await next.saveEvent({ namespace: 'next', id: 'tone', definition: { sounds: ['next:tone'] } })
    await expect(fs.access(path.join(project.path, 'src/main/resources/assets/next/sounds.json'))).resolves.toBeUndefined()
  })
  it('AUD056/057 round-trips and deletes book entries in an instance layout', async () => {
    const project = await fixture('modpack'); await createModpackTemplate(project)
    const sources = await Promise.all(['patchouli.jar', 'kubejs.jar', 'ftbquests.jar'].map(name => write(project, name, 'test jar'.repeat(512))))
    await addModpackFiles(project, sources)
    const manifest = await readModpackManifest(project)
    manifest.source = { format: 'instance', layout: 'instance', importedAt: '' }
    await writeModpackManifest(project, manifest)
    const input = { bookId: 'guide', name: 'Saved book', landingText: 'Saved text', categories: [{ id: 'start', name: 'Start', icon: 'minecraft:book', entries: [{ id: 'one', name: 'One', icon: 'minecraft:stone', text: 'one' }, { id: 'two', name: 'Two', icon: 'minecraft:stone', text: 'two' }] }] }
    await writePatchouliBook(project, input)
    const loaded = (await readPatchouliBooks(project))[0]
    expect(loaded.name).toBe('Saved book'); expect(loaded.categories[0].entries).toHaveLength(2)
    loaded.categories[0].entries.splice(0, 1)
    await writePatchouliBook(project, loaded)
    expect((await readPatchouliBooks(project))[0].categories[0].entries.map(entry => entry.id)).toEqual(['two'])
    await expect(fs.access(path.join(project.path, 'kubejs/assets/mod/patchouli_books/guide/zh_cn/entries/start/one.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(writePatchouliBook(project, input)).rejects.toThrow('已存在')
    await expect(writePatchouliBook(project, loaded)).rejects.toThrow('磁盘上变化')
    const chapter = await writeFtbQuestChapter(project, { chapterId: 'start', title: 'Start', quests: [{ id: 'one', title: 'One', tasks: [{ id: 'task', title: 'Task', type: 'checkmark' }] }] })
    expect(chapter).toBe('config/ftbquests/quests/chapters/start.snbt')
    expect(() => buildPatchouliBook(project, { ...input, bookId: '..' })).toThrow('relative path')
  })
})
