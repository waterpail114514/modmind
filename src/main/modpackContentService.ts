import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModpackKeybindConflict, ModpackKeybindState, ProjectInfo } from '../shared/types'
import { readModpackManifest } from './modpackService'
import { modpackOverridesRoot } from './modpackPaths'
import { assertContentTarget, installContentTransaction } from './contentInstallTransaction'
import { withProjectMutation } from './projectMutation'
import type { PatchouliBookInput } from '../shared/patchouli'
export type { PatchouliBookInput } from '../shared/patchouli'

export interface FtbQuestTask {
  id: string
  title: string
  type: 'item' | 'location' | 'checkmark'
  item?: string
  x?: number
  y?: number
}

export interface FtbQuestReward {
  id: string
  type: 'item' | 'xp' | 'command'
  item?: string
  count?: number
  xp?: number
  command?: string
}

export interface FtbQuestInput {
  chapterId: string
  title: string
  filename?: string
  quests: Array<{ id: string; title: string; description?: string; tasks: FtbQuestTask[]; rewards?: FtbQuestReward[]; x?: number; y?: number }>
}

export interface KeybindPreset {
  id: string
  name: string
  bindings: Record<string, string>
}

export interface KeybindApplyResult {
  path: string
  changed: string[]
  conflicts: ModpackKeybindConflict[]
}

function safeId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9_.-]+$/.test(normalized) || normalized === '.' || normalized === '..') throw new Error(`${label} must contain only lowercase letters, numbers, dots and hyphens; relative path segments are invalid`)
  return normalized
}

function quoteSnbt(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`
}

function stableQuestId(namespace: string, kind: string, id: string): string {
  return createHash('sha256').update(`${namespace}:${kind}:${id}`).digest('hex').slice(0, 32).toUpperCase()
}

function snbt(value: unknown): string {
  if (typeof value === 'string') return quoteSnbt(value)
  if (typeof value === 'number' && Number.isInteger(value)) return `${value}`
  if (typeof value === 'number') return `${value}d`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(snbt).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${key}:${snbt(child)}`).join(',')}}`
  return 'null'
}

function resourcePath(project: ProjectInfo, relative: string): string {
  const root = path.resolve(project.path)
  const target = path.resolve(project.path, ...relative.split('/'))
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('unsafe modpack content path')
  return target
}

function packRoot(project: ProjectInfo): string {
  return project.kind === 'modpack' ? path.join(project.path, 'overrides') : path.join(project.path, 'src', 'main', 'resources')
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const pending = `${target}.pending-${randomUUID()}`
  await fs.writeFile(pending, content, 'utf8')
  try { await fs.rename(pending, target) } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
}

function requireModpack(project: ProjectInfo): void {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required')
}

function normalizedModName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function requirePackMods(project: ProjectInfo, ...modIds: string[]): Promise<void> {
  const manifest = await readModpackManifest(project)
  const installed = manifest.mods.map((mod) => normalizedModName(mod.fileName))
  const missing = modIds.filter((modId) => !installed.some((fileName) => fileName.includes(normalizedModName(modId))))
  if (missing.length) throw new Error(`此内容需要先安装：${missing.join('、')}`)
}

export function buildFtbQuestSnbt(project: ProjectInfo, input: FtbQuestInput, prefix = 'overrides/'): { relativePath: string; content: string } {
  requireModpack(project)
  const chapterId = safeId(input.chapterId, 'chapter ID')
  if (!input.title.trim() || !Array.isArray(input.quests) || !input.quests.length) throw new Error('FTB chapter requires a title and at least one quest')
  const quests = input.quests.map((quest, index) => {
    const id = safeId(quest.id, `quest ${index + 1} ID`)
    if (!quest.title.trim() || !Array.isArray(quest.tasks) || !quest.tasks.length) throw new Error(`quest ${id} requires a title and task`)
    return {
      id: stableQuestId(project.namespace, 'quest', id),
      title: quest.title.trim(),
      subtitle: quest.description?.trim() ?? '',
      x: Number.isFinite(quest.x) ? Math.trunc(quest.x!) : index * 2,
      y: Number.isFinite(quest.y) ? Math.trunc(quest.y!) : 0,
      tasks: quest.tasks.map((task) => {
        const taskId = safeId(task.id, 'task ID')
        if (task.type === 'item' && (!task.item || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(task.item))) throw new Error(`item task ${taskId} requires a namespaced item`)
        return { id: stableQuestId(project.namespace, 'task', taskId), type: task.type, ...(task.item ? { item: task.item } : {}), ...(task.x !== undefined ? { x: task.x } : {}), ...(task.y !== undefined ? { y: task.y } : {}) }
      }),
      rewards: (quest.rewards ?? []).map((reward) => {
        const rewardId = safeId(reward.id, 'reward ID')
        if (reward.type === 'item' && (!reward.item || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(reward.item))) throw new Error(`item reward ${rewardId} requires a namespaced item`)
        if (reward.type === 'command' && !reward.command?.trim()) throw new Error(`command reward ${rewardId} requires a command`)
        return { id: stableQuestId(project.namespace, 'reward', rewardId), type: reward.type, ...(reward.item ? { item: reward.item, count: Math.max(1, Math.min(64, Math.trunc(reward.count ?? 1))) } : {}), ...(reward.xp !== undefined ? { xp: Math.max(0, Math.trunc(reward.xp)) } : {}), ...(reward.command ? { command: reward.command.trim() } : {}) }
      })
    }
  })
  const filename = safeId(input.filename?.trim() || chapterId, 'chapter filename')
  const relativePath = `${prefix}config/ftbquests/quests/chapters/${filename}.snbt`
  return { relativePath, content: snbt({ id: stableQuestId(project.namespace, 'chapter', chapterId), filename: input.filename?.trim() || chapterId, title: input.title.trim(), default_quest_shape: 'square', quests }) }
}

export async function writeFtbQuestChapter(project: ProjectInfo, input: FtbQuestInput): Promise<string> {
  await requirePackMods(project, 'ftbquests')
  const built = buildFtbQuestSnbt(project, input, await contentPrefix(project))
  await assertContentTarget(project.path, resourcePath(project, built.relativePath))
  await atomicWrite(resourcePath(project, built.relativePath), `${built.content}\n`)
  return built.relativePath
}

async function contentPrefix(project: ProjectInfo): Promise<string> {
  const root = modpackOverridesRoot(project, await readModpackManifest(project))
  const relative = path.relative(project.path, root).replaceAll('\\', '/')
  return relative ? `${relative}/` : ''
}

export function buildPatchouliBook(project: ProjectInfo, input: PatchouliBookInput, prefix = 'overrides/'): Array<{ relativePath: string; content: string }> {
  requireModpack(project)
  const bookId = safeId(input.bookId, 'book ID')
  const locale = safeId(input.locale ?? 'zh_cn', 'book locale')
  if (!input.name.trim() || !input.landingText.trim() || !Array.isArray(input.categories)) throw new Error('Patchouli book requires a name, landing text and category list')
  const dataRoot = `${prefix}kubejs/data/${project.namespace}/patchouli_books/${bookId}`
  const assetsRoot = `${prefix}kubejs/assets/${project.namespace}/patchouli_books/${bookId}/${locale}`
  const output = [{ relativePath: `${dataRoot}/book.json`, content: `${JSON.stringify({ version: '1', show_progress: true, use_resource_pack: true, pause_game: true, ...input.raw, name: input.name.trim(), landing_text: input.landingText.trim() }, null, 2)}\n` }]
  for (const category of input.categories) {
    const categoryId = safeId(category.id, 'category ID')
    if (!category.name.trim() || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(category.icon)) throw new Error(`Patchouli category ${categoryId} is incomplete`)
    output.push({ relativePath: `${assetsRoot}/categories/${categoryId}.json`, content: `${JSON.stringify({ sortnum: output.length, ...category.raw, name: category.name.trim(), description: category.description?.trim() ?? '', icon: category.icon }, null, 2)}\n` })
    for (const entry of category.entries) {
      const entryId = safeId(entry.id, 'entry ID')
      if (!entry.name.trim() || (!entry.text.trim() && !entry.pages?.length) || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(entry.icon)) throw new Error(`Patchouli entry ${entryId} is incomplete`)
      const pages = entry.pages?.length ? entry.pages : [{ type: 'patchouli:text', text: entry.text.trim() }]
      output.push({ relativePath: `${assetsRoot}/entries/${categoryId}/${entryId}.json`, content: `${JSON.stringify({ ...entry.raw, name: entry.name.trim(), icon: entry.icon, category: `${project.namespace}:${categoryId}`, pages }, null, 2)}\n` })
    }
  }
  return output
}

export async function writePatchouliBook(project: ProjectInfo, input: PatchouliBookInput): Promise<string[]> {
  return withProjectMutation(project.path, async () => {
    await requirePackMods(project, 'patchouli', 'kubejs')
    const prefix = await contentPrefix(project)
    const files = buildPatchouliBook(project, input, prefix)
    const bookId = safeId(input.bookId, 'book ID'), locale = safeId(input.locale ?? 'zh_cn', 'book locale')
    const current = await readPatchouliBook(project, prefix, bookId, locale)
    if (current && input.baseline === undefined) throw new Error('指南书已存在，请重新加载后保存，避免覆盖已有内容')
    if (input.baseline !== undefined && input.baseline !== current?.baseline) throw new Error('指南书已在磁盘上变化，请重新加载后保存')
    const stagingRoot = resourcePath(project, '.modmind/patchouli-staging')
    await assertContentTarget(project.path, stagingRoot)
    await fs.mkdir(stagingRoot, { recursive: true })
    const staging = await fs.mkdtemp(path.join(stagingRoot, 'save-'))
    try {
      const roots = [`${prefix}kubejs/data/${project.namespace}/patchouli_books/${bookId}/book.json`, ...['categories', 'entries'].map(kind => `${prefix}kubejs/assets/${project.namespace}/patchouli_books/${bookId}/${locale}/${kind}`)]
      const entries: Array<{ source: string; destination: string }> = []
      for (const [index, relative] of roots.entries()) {
        const source = path.join(staging, String(index))
        if (index > 0) await fs.mkdir(source, { recursive: true })
        for (const file of files.filter(file => file.relativePath === relative || file.relativePath.startsWith(`${relative}/`))) {
          const destination = file.relativePath === relative ? source : path.join(source, file.relativePath.slice(relative.length + 1))
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.writeFile(destination, file.content)
        }
        entries.push({ source, destination: resourcePath(project, relative) })
      }
      await installContentTransaction(project.path, entries, async () => undefined)
      return files.map(file => file.relativePath)
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined) }
  })
}

async function jsonFiles(project: ProjectInfo, root: string): Promise<Array<{ id: string; raw: Record<string, unknown>; content: string }>> {
  await assertContentTarget(project.path, root)
  const result: Array<{ id: string; raw: Record<string, unknown>; content: string }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
      const file = path.join(directory, entry.name)
      await assertContentTarget(project.path, file)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        if (!entry.name.endsWith('.json')) throw new Error(`指南书包含暂不支持编辑的文件：${file}`)
        const content = await fs.readFile(file, 'utf8'), raw = JSON.parse(content.replace(/^\uFEFF/, '')) as Record<string, unknown>
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`指南书 JSON 无效：${file}`)
        result.push({ id: path.relative(root, file).replaceAll('\\', '/').slice(0, -5), raw, content })
      }
    }
  }
  await visit(root)
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

async function readPatchouliBook(project: ProjectInfo, prefix: string, bookId: string, locale: string): Promise<PatchouliBookInput | null> {
  const bookPath = resourcePath(project, `${prefix}kubejs/data/${project.namespace}/patchouli_books/${bookId}/book.json`)
  await assertContentTarget(project.path, bookPath)
  const content = await fs.readFile(bookPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (content === null) return null
  const raw = JSON.parse(content.replace(/^\uFEFF/, '')) as Record<string, unknown>
  if (!raw || typeof raw.name !== 'string' || typeof raw.landing_text !== 'string') throw new Error('指南书主文件格式暂不支持编辑')
  const assets = resourcePath(project, `${prefix}kubejs/assets/${project.namespace}/patchouli_books/${bookId}/${locale}`)
  const categories = await jsonFiles(project, path.join(assets, 'categories')), entries = await jsonFiles(project, path.join(assets, 'entries'))
  const books: PatchouliBookInput['categories'] = categories.map(category => {
    if (safeId(category.id, 'category ID') !== category.id || typeof category.raw.name !== 'string' || typeof category.raw.icon !== 'string') throw new Error('指南书分类格式暂不支持编辑')
    return { id: category.id, name: category.raw.name, description: String(category.raw.description ?? ''), icon: category.raw.icon, raw: category.raw, entries: [] }
  })
  for (const entry of entries) {
    const category = books.find(category => entry.raw.category === `${project.namespace}:${category.id}` || entry.raw.category === category.id)
    const id = entry.id.split('/').at(-1)!
    if (!category || entry.id !== `${category.id}/${id}` || safeId(id, 'entry ID') !== id || typeof entry.raw.name !== 'string' || typeof entry.raw.icon !== 'string' || !Array.isArray(entry.raw.pages)) throw new Error('指南书条目格式暂不支持编辑，原文件已保留')
    const pages = entry.raw.pages as Array<Record<string, unknown>>
    category.entries.push({ id, name: entry.raw.name, icon: entry.raw.icon, text: String(pages.find(page => page.type === 'patchouli:text')?.text ?? ''), pages, raw: entry.raw })
  }
  const baseline = createHash('sha256').update(JSON.stringify([content, categories, entries])).digest('hex')
  return { bookId, locale, name: raw.name, landingText: raw.landing_text, raw, baseline, categories: books }
}

export async function readPatchouliBooks(project: ProjectInfo): Promise<PatchouliBookInput[]> {
  requireModpack(project)
  const prefix = await contentPrefix(project)
  const root = resourcePath(project, `${prefix}kubejs/data/${project.namespace}/patchouli_books`)
  await assertContentTarget(project.path, root)
  const result: PatchouliBookInput[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
    if (!entry.isDirectory()) continue
    const id = safeId(entry.name, 'book ID')
    const assets = resourcePath(project, `${prefix}kubejs/assets/${project.namespace}/patchouli_books/${id}`)
    await assertContentTarget(project.path, assets)
    const locales = await fs.readdir(assets, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const locale of locales.filter(item => item.isDirectory()).map(item => safeId(item.name, 'locale')).concat(locales.length ? [] : ['zh_cn'])) {
      const book = await readPatchouliBook(project, prefix, id, locale)
      if (book) result.push(book)
    }
  }
  return result
}

async function keybindPath(project: ProjectInfo): Promise<{ relative: string; target: string }> {
  const manifest = project.kind === 'modpack' ? await readModpackManifest(project).catch(() => null) : null
  const relative = project.kind === 'modpack'
    ? manifest?.source?.layout === 'instance' ? 'options.txt' : 'overrides/options.txt'
    : 'run/options.txt'
  return { relative, target: resourcePath(project, relative) }
}

function normalizeBinding(value: string): string {
  const normalized = value.trim()
  if (!/^key\.(?:keyboard|mouse)\.[a-z0-9_.-]+$/i.test(normalized) && normalized !== 'key.keyboard.unknown') throw new Error(`invalid key binding: ${value}`)
  return normalized
}

export function detectKeybindConflicts(bindings: Record<string, string>): ModpackKeybindConflict[] {
  const byBinding = new Map<string, string[]>()
  for (const [action, value] of Object.entries(bindings)) {
    const normalized = normalizeBinding(value)
    const actions = byBinding.get(normalized) ?? []
    actions.push(action)
    byBinding.set(normalized, actions)
  }
  return [...byBinding.entries()].filter(([, actions]) => actions.length > 1).map(([key, actions]) => ({ key, bindings: actions }))
}

function parseKeybinds(content: string): Record<string, string> {
  const bindings: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):(.*)$/)
    if (!match || !/^key_[A-Za-z0-9_.-]+$/.test(match[1])) continue
    try { bindings[match[1]] = normalizeBinding(match[2]) } catch { /* Keep unrelated or malformed option lines untouched. */ }
  }
  return bindings
}

export async function readKeybindState(project: ProjectInfo): Promise<ModpackKeybindState> {
  const { relative, target } = await keybindPath(project)
  const bindings = parseKeybinds(await fs.readFile(target, 'utf8').catch(() => ''))
  return { path: relative, bindings, conflicts: detectKeybindConflicts(bindings) }
}

export async function applyKeybindPreset(project: ProjectInfo, preset: KeybindPreset, allowConflicts = false): Promise<KeybindApplyResult> {
  const normalized = Object.fromEntries(Object.entries(preset.bindings).map(([key, value]) => [key.trim(), normalizeBinding(value)]))
  for (const key of Object.keys(normalized)) if (!/^key_[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`invalid keybind action: ${key}`)
  const { relative, target } = await keybindPath(project)
  const existing = await fs.readFile(target, 'utf8').catch(() => '')
  const lines = existing ? existing.split(/\r?\n/) : []
  const existingBindings = parseKeybinds(existing)
  const effectiveBindings = { ...existingBindings, ...normalized }
  const conflicts = detectKeybindConflicts(effectiveBindings)
    .filter((conflict) => conflict.bindings.some((binding) => binding in normalized) && conflict.bindings.length > 1)
  if (conflicts.length && !allowConflicts) throw new Error(`keybind conflicts detected: ${conflicts.map((conflict) => `${conflict.key}=${conflict.bindings.join(',')}`).join('; ')}`)
  const changed: string[] = []
  const seen = new Set<string>()
  const next = lines.map((line) => {
    const match = line.match(/^([^:]+):(.*)$/)
    if (!match || !(match[1] in normalized)) return line
    const value = normalized[match[1]]
    seen.add(match[1])
    if (match[2] === value) return line
    changed.push(match[1])
    return `${match[1]}:${value}`
  })
  for (const [key, value] of Object.entries(normalized)) if (!seen.has(key)) { next.push(`${key}:${value}`); changed.push(key) }
  await atomicWrite(target, `${next.filter((line, index) => line || index < next.length - 1).join('\n')}\n`)
  return { path: relative, changed, conflicts }
}
