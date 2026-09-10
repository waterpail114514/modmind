import type { FtbQuestBook, FtbQuestBookFormat, FtbQuestDiagnostic, FtbQuestDocumentQuest } from './types'
type RawRecord = Record<string, unknown>
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const asList = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export function tableIdBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (/^-?\d+$/.test(clean)) {
    try { return BigInt(clean) } catch { return null }
  }
  if (/^[0-9a-f]{16,32}$/i.test(clean)) {
    try {
      const parsed = BigInt(`0x${clean}`)
      return clean.length === 16 && parsed >= 0x8000000000000000n ? parsed - 0x10000000000000000n : parsed
    } catch { return null }
  }
  if (/^0x[0-9a-f]+$/i.test(clean)) {
    try { return BigInt(clean) } catch { return null }
  }
  return null
}

export function tableObjectIdBigInt(value: unknown): bigint | null {
  if (typeof value === 'string' && /^[0-9a-f]{16,32}$/i.test(value.trim())) {
    try {
      const parsed = BigInt(`0x${value.trim()}`)
      // FTB stores object ids in a signed Java long. Normalize 64-bit hex ids
      // to the same signed value that SNBT exposes for table_id references.
      return value.trim().length === 16 && parsed >= 0x8000000000000000n ? parsed - 0x10000000000000000n : parsed
    } catch { return null }
  }
  return tableIdBigInt(value)
}

export function chapterSource(filename: string, format: FtbQuestBookFormat): string {
  const clean = filename.trim().replaceAll('\\', '/').replace(/^chapters\//, '').replace(/\.(snbt|json5)$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(clean) || clean === '.' || clean === '..') throw new Error('chapter filename contains unsupported characters')
  return `chapters/${clean}.${format}`
}

function collectFtbObjectIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((entry) => collectFtbObjectIds(entry, ids)); return }
  if (!value || typeof value !== 'object') return
  const record = value as RawRecord
  const id = text(record.id)
  // FTB Quests uses hexadecimal object IDs for chapters, quests, tasks, rewards and links.
  if (/^[0-9A-F]{16,32}$/i.test(id)) ids.add(id)
  Object.values(record).forEach((entry) => collectFtbObjectIds(entry, ids))
}

export function validateFtbQuestBook(book: FtbQuestBook): FtbQuestDiagnostic[] {
  const diagnostics: FtbQuestDiagnostic[] = []
  const chapterIds = new Set<string>()
  const globalIds = new Set<string>()
  const register = (id: string): void => {
    const key = /^[0-9a-f]{16,32}$/i.test(id) ? id.toUpperCase() : id
    if (id && globalIds.has(key)) diagnostics.push({ severity: 'error', code: 'book-object-id-duplicate', message: `任务书中存在重复对象 ID：${id}` })
    globalIds.add(key)
  }
  for (const chapter of book.chapters) {
    register(chapter.id)
    for (const quest of chapter.quests) {
      register(quest.id)
      for (const object of [...quest.tasks, ...quest.rewards]) register(object.id)
    }
    for (const link of asList(chapter.raw.quest_links)) register(text(asRecord(link).id))
  }
  for (const table of book.rewardTables ?? []) {
    register(table.id)
    table.rewards.forEach((entry) => register(entry.id))
  }
  const quests = new Map<string, FtbQuestDocumentQuest>()
  const objectIds = new Set<string>()
  for (const chapter of book.chapters) {
    collectFtbObjectIds({ ...chapter.raw, quests: undefined }, objectIds)
    objectIds.add(chapter.id)
    if (!chapter.id.trim()) diagnostics.push({ severity: 'error', code: 'chapter-id-empty', message: '章节缺少 ID', chapterId: chapter.id })
    else if (chapterIds.has(chapter.id)) diagnostics.push({ severity: 'error', code: 'chapter-id-duplicate', message: `重复的章节 ID：${chapter.id}`, chapterId: chapter.id })
    else chapterIds.add(chapter.id)
    if (!chapter.title.trim()) diagnostics.push({ severity: 'error', code: 'chapter-title-empty', message: '章节标题不能为空', chapterId: chapter.id })
    try { chapterSource(chapter.filename, book.format) } catch (error) { diagnostics.push({ severity: 'error', code: 'chapter-filename-invalid', message: error instanceof Error ? error.message : String(error), chapterId: chapter.id }) }
    for (const quest of chapter.quests) {
      if (!quest.id.trim()) diagnostics.push({ severity: 'error', code: 'quest-id-empty', message: '任务缺少 ID', chapterId: chapter.id })
      else if (quests.has(quest.id)) diagnostics.push({ severity: 'error', code: 'quest-id-duplicate', message: `重复的任务 ID：${quest.id}`, chapterId: chapter.id, questId: quest.id })
      else quests.set(quest.id, quest)
      objectIds.add(quest.id)
      quest.tasks.forEach((task) => objectIds.add(task.id))
      quest.rewards.forEach((reward) => objectIds.add(reward.id))
      if (!quest.title.trim()) diagnostics.push({ severity: 'error', code: 'quest-title-empty', message: '任务标题不能为空', chapterId: chapter.id, questId: quest.id })
      const childObjectIds = new Set<string>()
      for (const object of [...quest.tasks, ...quest.rewards]) {
        if (!object.id.trim()) diagnostics.push({ severity: 'error', code: 'object-id-empty', message: '任务条件或奖励缺少 ID', chapterId: chapter.id, questId: quest.id })
        else if (childObjectIds.has(object.id)) diagnostics.push({ severity: 'error', code: 'object-id-duplicate', message: `任务内存在重复 ID：${object.id}`, chapterId: chapter.id, questId: quest.id })
        else childObjectIds.add(object.id)
        if (!object.type.trim()) diagnostics.push({ severity: 'error', code: 'object-type-empty', message: '任务条件或奖励缺少类型', chapterId: chapter.id, questId: quest.id })
      }
    }
  }
  const visit = (id: string, seen: Set<string>, active: Set<string>): void => {
    if (active.has(id)) { diagnostics.push({ severity: 'error', code: 'dependency-cycle', message: `任务依赖形成循环：${id}`, questId: id }); return }
    if (seen.has(id)) return
    seen.add(id); active.add(id)
    for (const next of quests.get(id)?.dependencies ?? []) visit(next, seen, active)
    active.delete(id)
  }
  const seen = new Set<string>()
  for (const id of quests.keys()) visit(id, seen, new Set())
  // 奖励表：重复 ID / 重复文件名 / random、choice、all_table 奖励引用不存在的表。
  const tableIds = new Set<string>()
  const tableFilenames = new Set<string>()
  const tableNumericIds = new Set<bigint>()
  for (const table of book.rewardTables ?? []) {
    collectFtbObjectIds(table.raw, objectIds)
    if (!table.id.trim()) diagnostics.push({ severity: 'error', code: 'reward-table-id-empty', message: '奖励表缺少 ID' })
    else if (tableIds.has(table.id)) diagnostics.push({ severity: 'error', code: 'reward-table-id-duplicate', message: `重复的奖励表 ID：${table.id}` })
    else tableIds.add(table.id)
    objectIds.add(table.id)
    // 游戏 table_id 用 64 位整数引用表（SNBT 里以长整型存储），用 BigInt 精确比较。
    const tableNumericId = tableObjectIdBigInt(asRecord(table.raw).id ?? table.id)
    if (tableNumericId !== null) tableNumericIds.add(tableNumericId)
    if (!table.title.trim()) diagnostics.push({ severity: 'error', code: 'reward-table-title-empty', message: '奖励表标题不能为空' })
    if (!/^[A-Za-z0-9_.-]+$/.test(table.filename) || table.filename === '.' || table.filename === '..') diagnostics.push({ severity: 'error', code: 'reward-table-filename-invalid', message: `奖励表文件名包含不支持的字符：${table.filename}` })
    else if (tableFilenames.has(table.filename)) diagnostics.push({ severity: 'error', code: 'reward-table-filename-duplicate', message: `重复的奖励表文件名：${table.filename}` })
    else tableFilenames.add(table.filename)
    const entryIds = new Set<string>()
    for (const entry of table.rewards) {
      if (!entry.id.trim()) diagnostics.push({ severity: 'error', code: 'reward-table-entry-id-empty', message: `奖励表“${table.title}”的条目缺少 ID` })
      else if (entryIds.has(entry.id)) diagnostics.push({ severity: 'error', code: 'reward-table-entry-id-duplicate', message: `奖励表“${table.title}”内存在重复条目 ID：${entry.id}` })
      else entryIds.add(entry.id)
      objectIds.add(entry.id)
      if (!entry.type.trim()) diagnostics.push({ severity: 'error', code: 'reward-table-entry-type-empty', message: `奖励表“${table.title}”的条目缺少类型` })
    }
  }
  for (const chapter of book.chapters) for (const quest of chapter.quests) for (const reward of quest.rewards) {
    if (reward.type !== 'random' && reward.type !== 'choice' && reward.type !== 'all_table') continue
    const tableId = asRecord(reward.raw).table_id
    const numeric = tableIdBigInt(tableId)
    if (numeric === null) diagnostics.push({ severity: 'error', code: tableId === undefined ? 'reward-table-id-missing' : 'reward-table-id-invalid', message: tableId === undefined ? `奖励“${reward.title || quest.title}”缺少奖励表引用` : `奖励“${reward.title || quest.title}”的奖励表引用无效：${String(tableId)}`, chapterId: chapter.id, questId: quest.id })
    else if (!tableNumericIds.has(numeric)) diagnostics.push({ severity: 'error', code: 'reward-table-missing', message: `奖励“${reward.title || quest.title}”引用的奖励表不存在：${String(tableId)}`, chapterId: chapter.id, questId: quest.id })
  }
  for (const chapter of book.chapters) for (const quest of chapter.quests) for (const dependency of quest.dependencies) {
    if (dependency === quest.id) diagnostics.push({ severity: 'error', code: 'dependency-self', message: '任务不能依赖自身', chapterId: chapter.id, questId: quest.id })
    else if (!objectIds.has(dependency)) diagnostics.push({ severity: 'error', code: 'dependency-missing', message: `前置任务不存在：${dependency}`, chapterId: chapter.id, questId: quest.id })
  }
  return diagnostics
}
