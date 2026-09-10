import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { listFtbQuestBackups, readFtbQuestBook, restoreFtbQuestBackup, saveFtbQuestBook, validateFtbQuestBook } from './ftbQuestBookService'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function project(root: string): ProjectInfo { return { kind: 'modpack', name: 'Quest Pack', path: root, loader: 'forge', minecraftVersion: '1.20.1', namespace: 'quest_pack', createdAt: new Date().toISOString() } }

async function makeBook(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ftbquests-'))
  roots.push(root)
  const pack = project(root)
  const chapters = path.join(root, 'overrides', 'config', 'ftbquests', 'quests', 'chapters')
  await fs.mkdir(chapters, { recursive: true })
  await fs.writeFile(path.join(chapters, 'start.snbt'), `{
  id: "CHAPTER00000000000000000000000001"
  filename: "start"
  title: "Getting Started"
  custom_chapter_field: "preserve-me"
  quests: [{
    id: "QUEST00000000000000000000000000001"
    title: "Collect Stone"
    subtitle: "The first step"
    x: 0
    y: 0
    tasks: [{ id: "TASK000000000000000000000000000001" type: "item" item: "minecraft:stone" custom_task_field: "preserve-me" }]
    rewards: [{ id: "REWARD000000000000000000000000001" type: "xp" xp: 5 }]
  }]
}
`, 'utf8')
  return pack
}

describe('FTB Quests book service', () => {
  it('round-trips typed NBT through IPC primitives and updates the save baseline', async () => {
    const pack = await makeBook()
    const file = path.join(pack.path, 'overrides/config/ftbquests/quests/chapters/start.snbt')
    await fs.writeFile(file, '{id:"C1",title:"Chapter",quests:[{id:"Q1",title:"Quest",x:3,y:2,icon:{id:"minecraft:stone",Count:1b,tag:{CustomModelData:7,scale:0.5f}}}]}')
    const book = structuredClone(await readFtbQuestBook(pack))
    expect(book.chapters[0].quests[0].x).toBe(3)
    expect(book.chapters[0].quests[0].raw.icon).toMatchObject({ Count: 1, tag: { CustomModelData: 7, scale: .5 } })
    book.chapters[0].quests[0].title = 'Changed'
    const saved = await saveFtbQuestBook(pack, book)
    expect(saved.baseline).not.toBe(book.baseline)
    expect(await fs.readFile(file, 'utf8')).toMatch(/Count: 1b/)
    expect(await fs.readFile(file, 'utf8')).toMatch(/scale: 0.5f/)
    await expect(saveFtbQuestBook(pack, { ...book, baseline: saved.baseline })).resolves.toBeDefined()
  })
  it('restores a persistent backup with a baseline check and keeps a recovery backup', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    book.chapters[0].title = 'Changed'
    const saved = await saveFtbQuestBook(pack, book)
    const backups = await listFtbQuestBackups(pack)
    expect(backups).toHaveLength(1)
    await expect(restoreFtbQuestBackup(pack, backups[0].id, book.baseline!)).rejects.toThrow(/变化/)
    const restored = await restoreFtbQuestBackup(pack, backups[0].id, saved.baseline!)
    expect(restored.chapters[0].title).toBe('Getting Started')
    expect(await listFtbQuestBackups(pack)).toHaveLength(2)
    await expect(restoreFtbQuestBackup(pack, '../escape', restored.baseline!)).rejects.toThrow(/Invalid/)
  })
  it('reports rollback failures with a usable persistent backup', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    book.chapters[0].title = 'Changed'
    book.chapters.push({ ...book.chapters[0], id: 'C2', filename: 'second', source: 'chapters/second.snbt', quests: [] })
    const rename = fs.rename.bind(fs)
    let writes = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(source).endsWith('.restore')) throw new Error('restore denied')
      if (++writes === 2) throw new Error('write denied')
      return rename(source, target)
    })
    await expect(saveFtbQuestBook(pack, book)).rejects.toThrow(/回滚失败.*restore denied.*恢复备份/)
    vi.restoreAllMocks()
    const backup = (await listFtbQuestBackups(pack))[0]
    const current = await readFtbQuestBook(pack)
    expect((await restoreFtbQuestBackup(pack, backup.id, current.baseline!)).chapters[0].title).toBe('Getting Started')
  })
  it('preserves object icons on unrelated edits and allows explicit replacement', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    const icon = { id: 'minecraft:stone', Count: 2, tag: { CustomModelData: 17 } }
    book.chapters[0].raw.icon = icon
    book.chapters[0].icon = icon.id
    book.chapters[0].quests[0].raw.icon = icon
    book.chapters[0].quests[0].icon = icon.id
    await saveFtbQuestBook(pack, book)
    const reread = await readFtbQuestBook(pack)
    expect(reread.chapters[0].icon).toBe(icon.id)
    expect(reread.chapters[0].raw.icon).toEqual(icon)
    expect(reread.chapters[0].quests[0].icon).toBe(icon.id)
    expect(reread.chapters[0].quests[0].raw.icon).toEqual(icon)
    reread.chapters[0].quests[0].icon = 'minecraft:diamond'
    await saveFtbQuestBook(pack, reread)
    expect((await readFtbQuestBook(pack)).chapters[0].quests[0].raw.icon).toBe('minecraft:diamond')
  })
  it.each(['chapters', 'reward_tables'])('preserves unreadable %s files when saving an older snapshot', async (folder) => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    const root = path.join(pack.path, 'overrides', 'config', 'ftbquests', 'quests')
    const chapterFile = path.join(root, 'chapters', 'start.snbt')
    const original = await fs.readFile(chapterFile, 'utf8')
    await fs.mkdir(path.join(root, folder), { recursive: true })
    const brokenFile = path.join(root, folder, 'broken.snbt')
    await fs.writeFile(brokenFile, '{ invalid:', 'utf8')
    book.chapters[0].title = 'Unsaved edit'
    await expect(saveFtbQuestBook(pack, book)).rejects.toThrow(/无法解析/)
    expect(await fs.readFile(brokenFile, 'utf8')).toBe('{ invalid:')
    expect(await fs.readFile(chapterFile, 'utf8')).toBe(original)
  })
  it('reads, validates, and writes a full SNBT chapter without discarding unknown fields', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    expect(book.format).toBe('snbt')
    expect(book.chapters).toHaveLength(1)
    expect(book.chapters[0].quests[0]).toMatchObject({ title: 'Collect Stone', dependencies: [], tasks: [{ type: 'item', raw: { item: 'minecraft:stone' } }] })
    book.chapters[0].title = 'Start Here'
    book.chapters[0].quests[0].dependencies = []
    const saved = await saveFtbQuestBook(pack, book)
    expect(saved.written).toContain('overrides/config/ftbquests/quests/chapters/start.snbt')
    const content = await fs.readFile(path.join(pack.path, 'overrides', 'config', 'ftbquests', 'quests', 'chapters', 'start.snbt'), 'utf8')
    expect(content).toContain('custom_chapter_field')
    expect(content).toContain('custom_task_field')
    expect(content).toContain('Start Here')
  })

  it('rejects a stale baseline and reports global object id collisions', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    book.chapters[0].quests[0].tasks[0].id = book.chapters[0].id
    expect(validateFtbQuestBook(book).some((entry) => entry.code === 'book-object-id-duplicate')).toBe(true)
    await fs.appendFile(path.join(pack.path, 'overrides/config/ftbquests/quests/chapters/start.snbt'), '\n')
    await expect(saveFtbQuestBook(pack, book)).rejects.toThrow(/变化|冲突/)
  })

  it('reports duplicate ids and unresolved dependencies before save', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    const quest = book.chapters[0].quests[0]
    book.chapters[0].quests.push({ ...quest, title: 'Duplicate', dependencies: ['MISSING'] })
    const diagnostics = validateFtbQuestBook(book)
    expect(diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(['quest-id-duplicate', 'dependency-missing']))
    await expect(saveFtbQuestBook(pack, book)).rejects.toThrow(/重复的任务 ID/)
  })

  it('accepts FTB dependencies that target a chapter or task object', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    const chapter = book.chapters[0]
    chapter.id = '1111111111111111'
    chapter.quests[0].id = '2222222222222222'
    chapter.quests[0].tasks[0].id = '3333333333333333'
    chapter.quests.push({ ...chapter.quests[0], id: '4444444444444444', title: 'Depends on task and chapter', dependencies: ['1111111111111111', '3333333333333333'], tasks: [], rewards: [] })
    expect(validateFtbQuestBook(book).filter((entry) => entry.code === 'dependency-missing')).toEqual([])
  })

  it('keeps a fallback task title out of the serialized quest until the user edits it', async () => {
    const pack = await makeBook()
    const book = await readFtbQuestBook(pack)
    const quest = book.chapters[0].quests[0]
    delete quest.raw.title
    quest.title = 'The first step'
    quest.titleIsFallback = true
    await saveFtbQuestBook(pack, book)
    const reloaded = await readFtbQuestBook(pack)
    expect(reloaded.chapters[0].quests[0].raw.title).toBeUndefined()
    expect(reloaded.chapters[0].quests[0]).toMatchObject({ title: 'The first step', titleIsFallback: true })
  })

  it('detects and writes JSON5 chapter books', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ftbquests-json5-'))
    roots.push(root)
    const pack = project(root)
    const chapters = path.join(root, 'overrides', 'config', 'ftbquests', 'quests', 'chapters')
    await fs.mkdir(chapters, { recursive: true })
    await fs.writeFile(path.join(chapters, 'modern.json5'), `{
      // modern FTB Quests task book
      id: 'C1', filename: 'modern', title: 'Modern',
      quests: [{ id: 'Q1', title: 'First', x: 2, y: 3, tasks: [], rewards: [] }],
    }`, 'utf8')
    const book = await readFtbQuestBook(pack)
    expect(book.format).toBe('json5')
    book.chapters[0].quests[0].title = 'Updated'
    await saveFtbQuestBook(pack, book)
    const written = await fs.readFile(path.join(chapters, 'modern.json5'), 'utf8')
    expect(written).toContain('Updated')
  })

  it('preserves 64-bit reward table ids and rejects missing table references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ftbquests-reward-table-'))
    roots.push(root)
    const pack = project(root)
    const questRoot = path.join(root, 'overrides', 'config', 'ftbquests', 'quests')
    await fs.mkdir(path.join(questRoot, 'chapters'), { recursive: true })
    await fs.mkdir(path.join(questRoot, 'reward_tables'), { recursive: true })
    await fs.writeFile(path.join(questRoot, 'chapters', 'reward.snbt'), `{
      id: "CHAPTER00000000000000000000000002"
      filename: "reward"
      title: "Reward"
      quests: [{ id: "QUEST00000000000000000000000000002" title: "Roll" tasks: [] rewards: [{ id: "REWARD000000000000000000000000002" type: "random" table_id: "999" }] }]
    }`, 'utf8')
    await fs.writeFile(path.join(questRoot, 'reward_tables', 'loot.snbt'), `{
      id: "FEDCBA9876543210"
      title: "Loot"
      rewards: []
    }`, 'utf8')
    const book = await readFtbQuestBook(pack)
    expect(book.rewardTables[0].id).toBe('FEDCBA9876543210')
    expect(book.diagnostics.some((entry) => entry.code === 'reward-table-missing')).toBe(true)
    const reward = book.chapters[0].quests[0].rewards[0]
    reward.raw.table_id = '-81985529216486896'
    expect(validateFtbQuestBook(book).some((entry) => entry.code === 'reward-table-id-invalid')).toBe(false)
    expect(validateFtbQuestBook(book).some((entry) => entry.code === 'reward-table-missing')).toBe(false)
    await saveFtbQuestBook(pack, book)
    const written = await fs.readFile(path.join(questRoot, 'chapters', 'reward.snbt'), 'utf8')
    expect(written).toContain('-81985529216486896')
  })
})
