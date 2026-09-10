import { chapterSource, tableIdBigInt, validateFtbQuestBook } from '../shared/ftbQuestValidation'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import JSON5 from 'json5'
import { Byte, Short, Int, Float, parse as parseSnbt, stringify as stringifySnbt } from 'ftbq-nbt'
import type { FtbQuestBook, FtbQuestBookFormat, FtbQuestDiagnostic, FtbQuestDocumentChapter, FtbQuestDocumentQuest, FtbQuestRewardDocument, FtbQuestRewardTable, FtbQuestRewardTableEntry, FtbQuestSaveResult, FtbQuestTaskDocument, ProjectInfo } from '../shared/types'

type RawRecord = Record<string, unknown>

const operations = new Map<string, Promise<unknown>>()
async function exclusive<T>(project: ProjectInfo, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(project.path).toLowerCase()
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
  operations.set(key, next)
  try { return await next } finally { if (operations.get(key) === next) operations.delete(key) }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
function revision(root: string, files: Array<{ source: string; content: string }>): string {
  return createHash('sha256').update(JSON.stringify([path.resolve(root), [...files].sort((a, b) => a.source.localeCompare(b.source))])).digest('hex')
}
async function diskRevision(root: string): Promise<string> {
  return revision(root, [...await readChapterFiles(root), ...await readRewardTableFiles(root)])
}

function asRecord(value: unknown): RawRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {} }
function asList(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return fallback
}
function iconId(value: unknown): string { return text(value) || text(asRecord(value).id) || text(asRecord(value).item) }
function number(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }

/** Normalize FTB's mixed decimal/hex/long ID representations without passing through JS Number. */

function serializedTableId(value: unknown, format: FtbQuestBookFormat): unknown {
  if (format !== 'snbt' || typeof value !== 'string') return value
  const parsed = tableIdBigInt(value)
  return parsed === null ? value : parsed
}
function textList(value: unknown): string[] {
  return asList(value).map((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'bigint' ? String(entry) : text(asRecord(entry).id)).filter(Boolean)
}
function relative(project: ProjectInfo, target: string): string { return path.relative(project.path, target).replaceAll('\\', '/') }
function isInside(root: string, target: string): boolean { const next = path.resolve(target); return next === root || next.startsWith(`${root}${path.sep}`) }

function questRoot(project: ProjectInfo): string {
  if (project.kind !== 'modpack') throw new Error('an FTB Quests book requires a modpack project')
  const candidates = [
    path.join(project.path, 'overrides', 'config', 'ftbquests', 'quests'),
    path.join(project.path, 'config', 'ftbquests', 'quests')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}


function createId(): string { return randomUUID().replaceAll('-', '').toUpperCase() }

function readDescription(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean).join('\n')
  return text(value)
}


function taskFromRaw(value: unknown): FtbQuestTaskDocument {
  const raw = asRecord(value)
  return { id: text(raw.id, createId()), type: text(raw.type, 'checkmark'), title: text(raw.title), raw }
}

function rewardFromRaw(value: unknown): FtbQuestRewardDocument {
  const raw = asRecord(value)
  return { id: text(raw.id, createId()), type: text(raw.type, 'item'), title: text(raw.title), raw }
}

function questFromRaw(value: unknown): FtbQuestDocumentQuest {
  const raw = asRecord(value)
  const id = text(raw.id, createId())
  const tasks = asList(raw.tasks).map(taskFromRaw)
  const explicitTitle = text(raw.title)
  const fallbackTitle = tasks.map((task) => task.title?.trim()).find(Boolean) || text(raw.subtitle) || `任务 ${id.slice(0, 8)}`
  return {
    id, title: explicitTitle || fallbackTitle, titleIsFallback: !explicitTitle, subtitle: text(raw.subtitle), description: readDescription(raw.description), icon: iconId(raw.icon), shape: text(raw.shape, 'circle'), x: number(raw.x), y: number(raw.y),
    dependencies: textList(raw.dependencies), minRequiredTasks: raw.min_required_tasks === undefined ? undefined : number(raw.min_required_tasks), hideDependencyLines: raw.hide_dependency_lines === undefined ? undefined : Boolean(raw.hide_dependency_lines),
    tasks, rewards: asList(raw.rewards).map(rewardFromRaw), raw
  }
}

function chapterFromRaw(value: unknown, source: string): FtbQuestDocumentChapter {
  const raw = asRecord(value)
  const filename = text(raw.filename, path.basename(source).replace(/\.(snbt|json5)$/i, ''))
  return {
    id: text(raw.id, createId()), title: text(raw.title, 'Untitled chapter'), subtitle: text(raw.subtitle), icon: iconId(raw.icon), group: text(raw.group), filename, source,
    quests: asList(raw.quests).map(questFromRaw), raw
  }
}

// 奖励表（游戏 quest/loot/RewardTable）：reward_tables/ 目录下每表一个文件。
function rewardTableEntryFromRaw(value: unknown): FtbQuestRewardTableEntry {
  const raw = asRecord(value)
  return { id: text(raw.id, createId()), type: text(raw.type, 'item'), title: text(raw.title), weight: raw.weight === undefined ? 1 : number(raw.weight, 1), raw }
}

function rewardTableFromRaw(value: unknown, source: string): FtbQuestRewardTable {
  const raw = asRecord(value)
  const filename = path.basename(source).replace(/\.(snbt|json5)$/i, '')
  const crateRaw = asRecord(raw.loot_crate)
  const drops = asRecord(crateRaw.drops)
  const lootCrate = text(crateRaw.string_id) || text(crateRaw.item_name) || crateRaw.color !== undefined || crateRaw.glow !== undefined || crateRaw.drops !== undefined
    ? { stringId: text(crateRaw.string_id), itemName: text(crateRaw.item_name), color: number(crateRaw.color, 0xFFFFFF), glow: Boolean(crateRaw.glow), passive: number(drops.passive), monster: number(drops.monster), boss: number(drops.boss) }
    : null
  return {
    id: text(raw.id, createId()), filename, source,
    title: text(raw.title, '奖励表'), useTitle: Boolean(raw.use_title), hideTooltip: Boolean(raw.hide_tooltip),
    emptyWeight: number(raw.empty_weight), lootSize: number(raw.loot_size, 1), lootCrate,
    rewards: asList(raw.rewards).map(rewardTableEntryFromRaw), raw
  }
}

async function readRewardTableFiles(root: string): Promise<Array<{ source: string; content: string }>> {
  const folder = path.join(root, 'reward_tables')
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error })
  return Promise.all(entries.filter((entry) => entry.isFile() && /\.(snbt|json5)$/i.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => ({ source: `reward_tables/${entry.name}`, content: await fs.readFile(path.join(folder, entry.name), 'utf8') })))
}

function parseContent(content: string, format: FtbQuestBookFormat): RawRecord {
  const parsed = format === 'snbt' ? plainSnbt(parseSnbt(content, { skipComma: true, useBoolean: true })) : JSON5.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('chapter root must be an object')
  return parsed as RawRecord
}

// IPC structured clone drops NBT class prototypes. Expose primitives and restore
// numeric tag types from the original file when compiling the edited document.
function plainSnbt(value: unknown): unknown {
  if (value instanceof Byte || value instanceof Short || value instanceof Int || value instanceof Float) return value.valueOf()
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) return value.map(plainSnbt)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainSnbt(child)]))
  return value
}
function restoreSnbtTypes(value: unknown, original: unknown): unknown {
  if (typeof value === 'number') {
    for (const Type of [Byte, Short, Int, Float]) if (original instanceof Type) return new Type(value)
  }
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) {
    const previous = asList(original)
    return value.map((child, i) => {
      const id = asRecord(child).id
      const before = id === undefined ? previous[i] : previous.find(entry => asRecord(entry).id === id)
      return restoreSnbtTypes(child, before)
    })
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreSnbtTypes(child, asRecord(original)[key])]))
  return value
}

function stringifyContent(value: RawRecord, format: FtbQuestBookFormat): string {
  return format === 'snbt'
    ? `${stringifySnbt(value as Parameters<typeof stringifySnbt>[0], { pretty: true, skipComma: true, noTagListTab: true, tab: '  ', newline: '\n', quote: 'double' })}\n`
    : `${JSON.stringify(value, null, 2)}\n`
}

async function readChapterFiles(root: string): Promise<Array<{ source: string; content: string }>> {
  const chapters = path.join(root, 'chapters')
  const entries = await fs.readdir(chapters, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error })
  return Promise.all(entries.filter((entry) => entry.isFile() && /\.(snbt|json5)$/i.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => ({ source: `chapters/${entry.name}`, content: await fs.readFile(path.join(chapters, entry.name), 'utf8') })))
}

export { validateFtbQuestBook } from '../shared/ftbQuestValidation'

export async function readFtbQuestBook(project: ProjectInfo): Promise<FtbQuestBook> {
  return exclusive(project, () => readBook(project))
}

async function readBook(project: ProjectInfo): Promise<FtbQuestBook> {
  const root = questRoot(project)
  const files = await readChapterFiles(root)
  const tableFiles = await readRewardTableFiles(root)
  const formats = new Set([...files, ...tableFiles].map((file) => file.source.toLowerCase().endsWith('.json5') ? 'json5' : 'snbt' as FtbQuestBookFormat))
  const format: FtbQuestBookFormat = formats.has('json5') ? 'json5' : 'snbt'
  const diagnostics: FtbQuestDiagnostic[] = []
  if (formats.size > 1) diagnostics.push({ severity: 'warning', code: 'mixed-format', message: '检测到 SNBT 和 JSON5 章节混用；保存时请先统一格式' })
  const chapters: FtbQuestDocumentChapter[] = []
  for (const file of files) {
    const fileFormat: FtbQuestBookFormat = file.source.toLowerCase().endsWith('.json5') ? 'json5' : 'snbt'
    try { chapters.push(chapterFromRaw(parseContent(file.content, fileFormat), file.source)) }
    catch (error) { diagnostics.push({ severity: 'error', code: 'parse-failed', message: `${file.source} 无法解析：${error instanceof Error ? error.message : String(error)}` }) }
  }
  const rewardTables: FtbQuestRewardTable[] = []
  for (const file of tableFiles) {
    const fileFormat: FtbQuestBookFormat = file.source.toLowerCase().endsWith('.json5') ? 'json5' : 'snbt'
    try { rewardTables.push(rewardTableFromRaw(parseContent(file.content, fileFormat), file.source)) }
    catch (error) { diagnostics.push({ severity: 'error', code: 'parse-failed', message: `${file.source} 无法解析：${error instanceof Error ? error.message : String(error)}` }) }
  }
  const baseline = revision(root, [...files, ...tableFiles])
  const book: FtbQuestBook = { baseline, format, root: relative(project, root), chapters, rewardTables, diagnostics }
  return { ...book, diagnostics: [...diagnostics, ...validateFtbQuestBook(book)] }
}

function compiledTask(task: FtbQuestTaskDocument): RawRecord {
  const { id: _id, type: _type, title: _title, ...preserved } = task.raw
  return { ...preserved, id: task.id, type: task.type, ...(task.title ? { title: task.title } : {}) }
}
function compiledReward(reward: FtbQuestRewardDocument, format: FtbQuestBookFormat): RawRecord {
  const { id: _id, type: _type, title: _title, ...preserved } = reward.raw
  if (Object.prototype.hasOwnProperty.call(preserved, 'table_id')) preserved.table_id = serializedTableId(preserved.table_id, format)
  return { ...preserved, id: reward.id, type: reward.type, ...(reward.title ? { title: reward.title } : {}) }
}
function compiledQuest(quest: FtbQuestDocumentQuest, format: FtbQuestBookFormat): RawRecord {
  const { id: _id, title: _title, subtitle: _subtitle, icon: _icon, shape: _shape, x: _x, y: _y, description: originalDescription, dependencies: _dependencies, min_required_tasks: _minRequiredTasks, hide_dependency_lines: _hideDependencyLines, tasks: _tasks, rewards: _rewards, ...preserved } = quest.raw
  return {
    ...preserved, id: quest.id, ...(quest.titleIsFallback ? {} : { title: quest.title }), subtitle: quest.subtitle, icon: Object.prototype.hasOwnProperty.call(quest.raw, 'icon') && iconId(quest.raw.icon) === quest.icon ? quest.raw.icon : quest.icon, shape: quest.shape, x: quest.x, y: quest.y,
    ...(quest.description ? { description: Array.isArray(originalDescription) ? quest.description.split('\n') : quest.description } : {}),
    ...(quest.minRequiredTasks !== undefined && quest.minRequiredTasks > 0 ? { min_required_tasks: Math.trunc(quest.minRequiredTasks) } : {}),
    ...(quest.hideDependencyLines ? { hide_dependency_lines: true } : {}),
    dependencies: quest.dependencies, tasks: quest.tasks.map(compiledTask), rewards: quest.rewards.map((reward) => compiledReward(reward, format))
  }
}
function compiledChapter(chapter: FtbQuestDocumentChapter, format: FtbQuestBookFormat): RawRecord {
  const { id: _id, filename: _filename, title: _title, subtitle: _subtitle, icon: _icon, group: _group, quests: _quests, ...preserved } = chapter.raw
  return { ...preserved, id: chapter.id, filename: chapter.filename, title: chapter.title, subtitle: chapter.subtitle, icon: Object.prototype.hasOwnProperty.call(chapter.raw, 'icon') && iconId(chapter.raw.icon) === chapter.icon ? chapter.raw.icon : chapter.icon, ...(chapter.group ? { group: chapter.group } : {}), quests: chapter.quests.map((quest) => compiledQuest(quest, format)) }
}

// 与游戏 RewardTable#write 一致：空值字段省略，loot_crate 仅在启用时写入。
function compiledRewardTableEntry(entry: FtbQuestRewardTableEntry): RawRecord {
  const { id: _id, type: _type, title: _title, weight: _weight, ...preserved } = entry.raw
  return { ...preserved, id: entry.id, type: entry.type, ...(entry.title ? { title: entry.title } : {}), ...(entry.weight !== 1 ? { weight: entry.weight } : {}) }
}

function compiledRewardTable(table: FtbQuestRewardTable, format: FtbQuestBookFormat): RawRecord {
  const { id: _id, filename: _filename, title: _title, use_title: _useTitle, hide_tooltip: _hideTooltip, empty_weight: _emptyWeight, loot_size: _lootSize, rewards: _rewards, loot_crate: _lootCrate, ...preserved } = table.raw
  const rawId = asRecord(table.raw).id
  const outputId = rawId === undefined || (format === 'snbt' && typeof rawId === 'string')
    ? serializedTableId(rawId ?? table.id, format)
    : rawId
  const result: RawRecord = {
    ...preserved, id: outputId, title: table.title,
    ...(table.emptyWeight > 0 ? { empty_weight: table.emptyWeight } : {}),
    loot_size: Math.max(1, Math.trunc(table.lootSize)),
    ...(table.hideTooltip ? { hide_tooltip: true } : {}),
    ...(table.useTitle ? { use_title: true } : {}),
    rewards: table.rewards.map((entry) => ({ ...compiledRewardTableEntry(entry), ...(Object.prototype.hasOwnProperty.call(entry.raw, 'table_id') ? { table_id: serializedTableId(asRecord(entry.raw).table_id, format) } : {}) }))
  }
  if (table.lootCrate) {
    const crate = table.lootCrate
    result.loot_crate = {
      ...(crate.stringId ? { string_id: crate.stringId } : {}),
      ...(crate.itemName ? { item_name: crate.itemName } : {}),
      color: crate.color,
      ...(crate.glow ? { glow: true } : {}),
      drops: { passive: crate.passive, monster: crate.monster, boss: crate.boss }
    }
  }
  return result
}

async function restoreFiles(original: Map<string, string | null>): Promise<string[]> {
  const failures: string[] = []
  for (const [target, content] of original) {
    const pending = `${target}.modmind-${randomUUID()}.restore`
    try {
      if (content === null) await fs.rm(target, { force: true })
      else {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(pending, content, { flag: 'wx' })
        await fs.rename(pending, target)
      }
    } catch (error) { failures.push(`${target}: ${String(error)}`) }
    finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
  }
  return failures
}

export async function saveFtbQuestBook(project: ProjectInfo, input: FtbQuestBook): Promise<FtbQuestSaveResult> {
  return exclusive(project, () => saveBook(project, input))
}

async function saveBook(project: ProjectInfo, input: FtbQuestBook): Promise<FtbQuestSaveResult> {
  const root = questRoot(project)
  const current = await readBook(project)
  if (current.diagnostics.some((diagnostic) => diagnostic.code === 'parse-failed')) throw new Error('任务书存在无法解析的文件，为避免丢失内容，请修复文件并重新加载后保存')
  if (current.diagnostics.some((diagnostic) => diagnostic.code === 'mixed-format')) throw new Error('任务书混用了 SNBT 和 JSON5，请先在文件工作台中统一格式后再保存')
  if (input.diagnostics.some((diagnostic) => diagnostic.code === 'parse-failed')) throw new Error('任务书读取不完整，请重新加载后保存')
  if (input.baseline !== undefined && input.baseline !== current.baseline) throw new Error('任务书已在磁盘上变化，保存冲突，请重新加载后保存')
  const format = (current.chapters.length || current.rewardTables.length) ? current.format : input.format
  if ((current.chapters.length || current.rewardTables.length) && input.format !== current.format) throw new Error('任务书格式已在磁盘上变化，请重新加载后保存')
  const book: FtbQuestBook = { ...input, format, root: relative(project, root), diagnostics: [] }
  const diagnostics = validateFtbQuestBook(book)
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  if (errors.length) throw new Error(errors.map((diagnostic) => diagnostic.message).join('；'))
  const rootResolved = path.resolve(root)
  const existingFiles = await readChapterFiles(root)
  const existingTableFiles = await readRewardTableFiles(root)
  const compile = (value: RawRecord, source: string): string => {
    const original = [...existingFiles, ...existingTableFiles].find(file => file.source === source)
    const typed = format === 'snbt' && original ? restoreSnbtTypes(value, parseSnbt(original.content, { skipComma: true, useBoolean: true })) as RawRecord : value
    return stringifyContent(typed, format)
  }
  const desired = new Map<string, string>()
  for (const chapter of book.chapters) {
    const source = chapterSource(chapter.filename, format)
    const target = path.resolve(root, source)
    if (!isInside(rootResolved, target)) throw new Error('unsafe chapter path')
    if (desired.has(target)) throw new Error(`chapter filename is duplicated: ${chapter.filename}`)
    desired.set(target, compile(compiledChapter({ ...chapter, source }, format), chapter.source))
  }
  const existing = new Set([...existingFiles, ...existingTableFiles].map((file) => path.resolve(root, file.source)))
  // 奖励表文件：reward_tables/{filename}.{format}（与游戏 RewardTable 存储一致，每表一个文件）。
  for (const table of book.rewardTables ?? []) {
    const source = `reward_tables/${table.filename}.${format}`
    const target = path.resolve(root, source)
    if (!isInside(rootResolved, target)) throw new Error('unsafe reward table path')
    if (desired.has(target)) throw new Error(`reward table filename is duplicated: ${table.filename}`)
    desired.set(target, compile(compiledRewardTable(table, format), table.source))
  }
  const removed = [...existing].filter((file) => !desired.has(file))
  const original = new Map<string, string | null>()
  for (const target of new Set([...desired.keys(), ...removed])) original.set(target, await fs.readFile(target, 'utf8').catch((error) => { if (missing(error)) return null; throw error }))
  const temporary = new Map<string, string>()
  const changed = new Map<string, string | null>()
  const backup = path.join(project.path, '.modmind', 'ftbquests-backups', randomUUID())
  try {
    for (const [target, content] of desired) {
      if (original.get(target) === content) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      const pending = `${target}.modmind-${process.pid}-${randomUUID()}.pending`
      temporary.set(target, pending)
      await fs.writeFile(pending, content, { encoding: 'utf8', flag: 'wx' })
    }
    if (await diskRevision(root) !== current.baseline) throw new Error('任务书已在磁盘上变化，保存冲突，请重新加载后保存')
    if (temporary.size || removed.length) {
      await fs.mkdir(backup, { recursive: true })
      await fs.writeFile(path.join(backup, 'original.json'), JSON.stringify([...original].map(([target, content]) => ({ target: relative(project, target), content }))), { flag: 'wx' })
      if (await diskRevision(root) !== current.baseline) throw new Error('任务书已在磁盘上变化，保存冲突，请重新加载后保存')
    }
    for (const [target, pending] of temporary) {
      await fs.rename(pending, target)
      changed.set(target, original.get(target)!)
    }
    for (const target of removed) {
      await fs.rm(target)
      changed.set(target, original.get(target)!)
    }
  } catch (error) {
    const failures = await restoreFiles(changed)
    if (failures.length) throw new Error(`保存失败：${String(error)}；回滚失败：${failures.join('；')}；恢复备份：${backup}`)
    if (changed.size) throw new Error(`保存失败，已回滚：${String(error)}；恢复备份：${backup}`)
    throw error
  } finally {
    await Promise.all([...temporary.values()].map((pending) => fs.rm(pending, { force: true }).catch(() => undefined)))
  }
  return { written: [...temporary.keys()].map((target) => relative(project, target)), removed: removed.map((target) => relative(project, target)), diagnostics, baseline: await diskRevision(root) }
}

export async function listFtbQuestBackups(project: ProjectInfo): Promise<Array<{ id: string; createdAt: string; files: number }>> {
  const root = path.join(project.path, '.modmind/ftbquests-backups')
  const result: Array<{ id: string; createdAt: string; files: number }> = []
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
    const file = path.join(root, entry.name, 'original.json')
    try { const rows = JSON.parse(await fs.readFile(file, 'utf8')); if (Array.isArray(rows)) result.push({ id: entry.name, createdAt: (await fs.stat(file)).mtime.toISOString(), files: rows.length }) } catch { /* Incomplete backups are not offered for restore. */ }
  }
  return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt))
}

export async function restoreFtbQuestBackup(project: ProjectInfo, id: string, baseline: string): Promise<FtbQuestBook> {
  return exclusive(project, async () => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup ID')
    const root = path.resolve(questRoot(project))
    if (await diskRevision(root) !== baseline) throw new Error('任务书已变化，请重新加载后恢复')
    const rows: unknown = JSON.parse(await fs.readFile(path.join(project.path, '.modmind/ftbquests-backups', id, 'original.json'), 'utf8'))
    if (!Array.isArray(rows)) throw new Error('Invalid backup manifest')
    const desired = new Map<string, string | null>()
    for (const row of rows) {
      const entry = asRecord(row)
      if (typeof entry.target !== 'string' || (entry.content !== null && typeof entry.content !== 'string')) throw new Error('Invalid backup entry')
      const target = path.resolve(project.path, entry.target)
      const rel = path.relative(root, target).replaceAll('\\', '/')
      if (!/^(chapters|reward_tables)\/[A-Za-z0-9_.-]+\.(snbt|json5)$/.test(rel) || !isInside(root, target)) throw new Error('Unsafe backup target')
      desired.set(target, entry.content as string | null)
    }
    for (const file of [...await readChapterFiles(root), ...await readRewardTableFiles(root)]) if (!desired.has(path.resolve(root, file.source))) desired.set(path.resolve(root, file.source), null)
    const original = new Map<string, string | null>()
    for (const target of desired.keys()) original.set(target, await fs.readFile(target, 'utf8').catch(error => { if (missing(error)) return null; throw error }))
    const backup = path.join(project.path, '.modmind/ftbquests-backups', randomUUID())
    await fs.mkdir(backup, { recursive: true })
    await fs.writeFile(path.join(backup, 'original.json'), JSON.stringify([...original].map(([target, content]) => ({ target: relative(project, target), content }))), { flag: 'wx' })
    if (await diskRevision(root) !== baseline) throw new Error('任务书已变化，请重新加载后恢复')
    const failures = await restoreFiles(desired)
    if (failures.length) {
      const rollback = await restoreFiles(original)
      throw new Error(`恢复失败：${failures.join('; ')}${rollback.length ? `；回滚失败：${rollback.join('; ')}` : '；已回滚'}；备份：${backup}`)
    }
    return readBook(project)
  })
}

export function newFtbQuestChapter(format: FtbQuestBookFormat, index: number): FtbQuestDocumentChapter {
  const filename = `chapter_${index + 1}`
  return { id: createId(), title: '新章节', subtitle: '', icon: 'minecraft:book', group: '', filename, source: chapterSource(filename, format), quests: [], raw: {} }
}

export function newFtbQuest(index: number): FtbQuestDocumentQuest {
  return { id: createId(), title: `新任务 ${index + 1}`, titleIsFallback: false, subtitle: '', description: '', icon: 'minecraft:book', shape: 'circle', x: index * 2, y: 0, dependencies: [], tasks: [{ id: createId(), type: 'checkmark', raw: {} }], rewards: [], raw: {} }
}
