import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { readFtbQuestBook, saveFtbQuestBook, validateFtbQuestBook } from './ftbQuestBookService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

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
