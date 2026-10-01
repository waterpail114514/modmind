import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModpackKeybindConflict, ModpackKeybindState, ProjectInfo } from "../../../../src/shared/types"
import { readModpackManifest } from "../../../../src/main/modpackService"

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

export interface PatchouliBookInput {
  bookId: string
  name: string
  landingText: string
  locale?: string
  categories: Array<{ id: string; name: string; description?: string; icon: string; entries: Array<{ id: string; name: string; icon: string; text: string; pages?: Array<Record<string, unknown>> }> }>
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
  if (!/^[a-z0-9_.-]+$/.test(normalized)) throw new Error(`${label} must contain only lowercase letters, numbers, dots and hyphens`)
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
  const pending = `${target}.pending-${process.pid}`
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

export function buildFtbQuestSnbt(project: ProjectInfo, input: FtbQuestInput): { relativePath: string; content: string } {
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
  const relativePath = `overrides/config/ftbquests/quests/chapters/${input.filename?.trim() || chapterId}.snbt`
  return { relativePath, content: snbt({ id: stableQuestId(project.namespace, 'chapter', chapterId), filename: input.filename?.trim() || chapterId, title: input.title.trim(), default_quest_shape: 'square', quests }) }
}

export async function writeFtbQuestChapter(project: ProjectInfo, input: FtbQuestInput): Promise<string> {
  await requirePackMods(project, 'ftbquests')
  const built = buildFtbQuestSnbt(project, input)
  await atomicWrite(resourcePath(project, built.relativePath), `${built.content}\n`)
  return built.relativePath
}

export function buildPatchouliBook(project: ProjectInfo, input: PatchouliBookInput): Array<{ relativePath: string; content: string }> {
  requireModpack(project)
  const bookId = safeId(input.bookId, 'book ID')
  const locale = safeId(input.locale ?? 'zh_cn', 'book locale')
  if (!input.name.trim() || !input.landingText.trim() || !Array.isArray(input.categories) || !input.categories.length) throw new Error('Patchouli book requires a name, landing text and category')
  const dataRoot = `overrides/kubejs/data/${project.namespace}/patchouli_books/${bookId}`
  const assetsRoot = `overrides/kubejs/assets/${project.namespace}/patchouli_books/${bookId}/${locale}`
  const output = [{ relativePath: `${dataRoot}/book.json`, content: `${JSON.stringify({ name: input.name.trim(), landing_text: input.landingText.trim(), version: '1', show_progress: true, use_resource_pack: true, pause_game: true }, null, 2)}\n` }]
  for (const category of input.categories) {
    const categoryId = safeId(category.id, 'category ID')
    if (!category.name.trim() || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(category.icon) || !category.entries.length) throw new Error(`Patchouli category ${categoryId} is incomplete`)
    output.push({ relativePath: `${assetsRoot}/categories/${categoryId}.json`, content: `${JSON.stringify({ name: category.name.trim(), description: category.description?.trim() ?? '', icon: category.icon, sortnum: output.length }, null, 2)}\n` })
    for (const entry of category.entries) {
      const entryId = safeId(entry.id, 'entry ID')
      if (!entry.name.trim() || !entry.text.trim() || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(entry.icon)) throw new Error(`Patchouli entry ${entryId} is incomplete`)
      const pages = entry.pages?.length ? entry.pages : [{ type: 'patchouli:text', text: entry.text.trim() }]
      output.push({ relativePath: `${assetsRoot}/entries/${categoryId}/${entryId}.json`, content: `${JSON.stringify({ name: entry.name.trim(), icon: entry.icon, category: `${project.namespace}:${categoryId}`, pages }, null, 2)}\n` })
    }
  }
  return output
}

export async function writePatchouliBook(project: ProjectInfo, input: PatchouliBookInput): Promise<string[]> {
  await requirePackMods(project, 'patchouli', 'kubejs')
  const files = buildPatchouliBook(project, input)
  for (const file of files) await atomicWrite(resourcePath(project, file.relativePath), file.content)
  return files.map((file) => file.relativePath)
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
