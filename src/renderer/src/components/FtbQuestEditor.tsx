import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { addEdge, Background, BaseEdge, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, useStore, type Connection, type Edge, type EdgeMouseHandler, type EdgeProps, type Node, type NodeChange, type NodeMouseHandler, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, BookOpen, ChevronLeft, ChevronRight, CirclePlus, ClipboardCheck, FileCode2, FilePlus2, FolderTree, Gift, LoaderCircle, PackageOpen, Plus, Redo2, RotateCw, Save, Settings2, Trash2, Undo2, Unlink, X } from 'lucide-react'
import type { FtbQuestBook, FtbQuestDocumentChapter, FtbQuestDocumentQuest, FtbQuestIconInspection, FtbQuestRewardDocument, FtbQuestRewardTable, FtbQuestShapeSet, FtbQuestTaskDocument, ProjectInfo } from '../../../shared/types'
import { ftbIconDescriptor, ftbIconKey, type FtbIconDescriptor } from '../../../shared/ftbIcon'
import { requestFtbIcon } from '../lib/ftbIconClient'
import { ftbObjectIds, rewriteFtbQuestReferences } from '../../../shared/ftbQuestReferences'
import { validateFtbQuestBook } from '../../../shared/ftbQuestValidation'
import { useConfirmDialog } from './InteractionDialogs'

function dependencyIndex(book: FtbQuestBook | null): Map<string, { title: string; owner: string; questId?: string }> {
  const index = new Map<string, { title: string; owner: string; questId?: string }>()
  for (const chapter of book?.chapters ?? []) {
    index.set(chapter.id, { title: chapter.title, owner: '章节' })
    for (const quest of chapter.quests) {
      index.set(quest.id, { title: quest.title, owner: chapter.title, questId: quest.id })
      for (const [kind, entries] of [['条件', quest.tasks], ['奖励', quest.rewards]] as const) {
        for (const entry of entries) index.set(entry.id, { title: entry.title || entry.type, owner: `${chapter.title} / ${quest.title} / ${kind}`, questId: quest.id })
      }
    }
  }
  for (const table of book?.rewardTables ?? []) {
    index.set(table.id, { title: table.title, owner: '奖励表' })
    for (const entry of table.rewards) index.set(entry.id, { title: entry.title || entry.type, owner: `${table.title} / 奖励表条目` })
  }
  return index
}

function useModalAccessibility(open: boolean, onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const previousFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const first = Array.from(ref.current?.querySelectorAll<HTMLElement>('input, textarea, select, button, [tabindex]:not([tabindex="-1"])') ?? []).find(item => !item.hasAttribute('disabled') && item.getClientRects().length > 0)
      first?.focus()
    })
    const keydown = (event: KeyboardEvent): void => {
      if (document.querySelector('[role="alertdialog"]')) return
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('input, textarea, select, button, [tabindex]:not([tabindex="-1"])')).filter((item) => !item.hasAttribute('disabled') && item.getClientRects().length > 0)
      if (!focusable.length) return
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1)
      event.preventDefault(); focusable[next].focus()
    }
    document.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previousFocus.current?.focus() }
  }, [open])
  return ref
}

type QuestNodeData = { title: string; subtitle: string; icon: string; descriptor: FtbIconDescriptor | null; iconFallback: FtbIconDescriptor[]; shape: string; tasks: number; rewards: number; mcVersion: string; projectPath: string }
type QuestNode = Node<QuestNodeData>
type QuestEdge = Edge<{ lane?: number; animated?: boolean }>

// FTB quest coordinates frequently use half-grid increments. Keep enough visual room for the node itself.
const QUEST_GRID_X = 72
const QUEST_GRID_Y = 78
// 原版依赖连线：与游戏 QuestPanel#renderConnection 一致，从源任务中心到目标任务中心的直线，
// 用 dependency.png 箭头贴图沿直线无缝平铺并按主题色染色（编辑器内任务无完成态，用未完成色）。
// 颜色取自 FTB-Quests 默认主题 ftb_quests_theme.txt（#AARRGGBB）：#B4CCA3A3 = rgba(204,163,163,0.71)。
const QUEST_EDGE_COLOR = '#B4CCA3A3'
const QUEST_EDGE_START = 'rgba(204, 163, 163, 0.71)'
// 原版线条末端 RGB 衰减为 3/4（见 renderConnection 顶点颜色 r*3/4 等）。
const QUEST_EDGE_END = 'rgba(153, 122, 122, 0.71)'
// 原版 renderConnection 贴图平铺周期 = 2×半宽（线宽），游戏中线宽 ≈ 按钮宽 / 5.9。
// 编辑器按钮 64px，对应贴图单元 = 64 / 5.9 ≈ 11px。
const QUEST_EDGE_TILE = 11
const FtbResources = createContext({ projectPath: '', scope: '' })
const shapeRequests = new Map<string, Promise<Record<string, FtbQuestShapeSet>>>()
const dependencyRequests = new Map<string, Promise<string | null>>()
function useFtbShapes(): Record<string, FtbQuestShapeSet> | null {
  const { projectPath, scope } = useContext(FtbResources)
  const [map, setMap] = useState<Record<string, FtbQuestShapeSet> | null>(null)
  useEffect(() => {
    let alive = true
    setMap(null)
    let request = shapeRequests.get(scope)
    if (!request) { request = window.modmind.modpack.ftbQuestShapes(projectPath); shapeRequests.set(scope, request); if (shapeRequests.size > 8) shapeRequests.delete(shapeRequests.keys().next().value!) }
    request.then(value => { if (alive) setMap(value) }).catch(() => {})
    return () => { alive = false }
  }, [scope, projectPath])
  return map
}
function useFtbDependencyTexture(): string | null {
  const { projectPath, scope } = useContext(FtbResources)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setUrl(null)
    let request = dependencyRequests.get(scope)
    if (!request) { request = window.modmind.modpack.ftbDependencyTexture(projectPath); dependencyRequests.set(scope, request); if (dependencyRequests.size > 8) dependencyRequests.delete(dependencyRequests.keys().next().value!) }
    request.then(value => { if (alive) setUrl(value) }).catch(() => {})
    return () => { alive = false }
  }, [scope, projectPath])
  return url
}
function newId(): string { return crypto.randomUUID().replaceAll('-', '').toUpperCase() }
function newTableId(): string { return newId().slice(0, 16) }
// 物品显示名缓存：模组物品走主进程（mod jar 语言文件），原版物品走 CDN 语言文件（zh_cn 优先）。
const ftbItemNameCache = new Map<string, string | null>()
const ftbVanillaLangState: { promise: Promise<Record<string, string>> | null; version: string } = { promise: null, version: '' }
function vanillaLang(mcVersion: string): Promise<Record<string, string>> {
  if (ftbVanillaLangState.promise && ftbVanillaLangState.version === mcVersion) return ftbVanillaLangState.promise
  // mcmeta 仓库的版本标签格式为 "<版本>-assets"（如 1.20.1-assets），不带 -assets 后缀的引用会 404。
  const base = `https://cdn.jsdelivr.net/gh/misode/mcmeta@${mcVersion}-assets/assets/minecraft/lang`
  // zh_cn 拉取失败（该版本无翻译）时回退 en_us，再失败返回空表。
  ftbVanillaLangState.promise = fetch(`${base}/zh_cn.json`, { mode: 'cors' })
    .then((response) => response.ok ? response.json() as Promise<Record<string, string>> : Promise.reject(new Error(`zh_cn ${response.status}`)))
    .catch(() => fetch(`${base}/en_us.json`, { mode: 'cors' }).then((response) => response.ok ? response.json() as Promise<Record<string, string>> : {}))
    .catch(() => ({}))
  ftbVanillaLangState.version = mcVersion
  return ftbVanillaLangState.promise
}
/** 统一的物品 ID 清洗：剥离 NBT（后缀 {…} / 整体对象 {id:"mod:item",…}）与容器 [...]，小写。 */
function cleanItemId(rawId: string): string {
  let clean = rawId.trim()
  const objectForm = clean.match(/^\{\s*id\s*:\s*["']([a-z0-9_.-]+:[a-z0-9_.-]+)["']\s*,/i)
  if (objectForm) clean = objectForm[1]
  return clean.split(/[[({]/)[0]?.trim().toLowerCase() ?? clean.toLowerCase()
}

/** 解析物品/流体 ID（自动剥离 NBT）的显示名；未知返回 null。 */
function useFtbItemName(itemId: string, mcVersion: string, enabled = true): string | null {
  const { projectPath, scope } = useContext(FtbResources)
  const clean = cleanItemId(itemId)
  const cacheKey = `${scope}\u0000${clean}`
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled || !clean) { setName(null); return }
    const cached = ftbItemNameCache.get(cacheKey)
    if (cached !== undefined) { setName(cached); return }
    const [namespace = 'minecraft', ...rest] = clean.split(':')
    const shortName = rest.join(':')
    const resolve = namespace === 'minecraft'
      ? vanillaLang(mcVersion).then((lang) => lang[`item.minecraft.${shortName}`] ?? lang[`block.minecraft.${shortName}`] ?? null)
      : window.modmind.modpack.ftbQuestItemNames([clean], projectPath).then((map) => map[clean] ?? null)
    let alive = true
    resolve.then((value) => { ftbItemNameCache.set(cacheKey, value); if (alive) setName(value) })
      .catch(() => { ftbItemNameCache.set(cacheKey, null); if (alive) setName(null) })
    return () => { alive = false }
  }, [clean, mcVersion, enabled, scope, projectPath])
  return name
}
/** Minecraft 颜色代码 &0-&f 的实际颜色（§ 变体同样支持）。 */
const MC_COLOR_CODES: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF'
}
/** 把 Java/Minecraft 文本格式码渲染成浏览态富文本；输入框仍保留原始字符串。 */
function renderColoredText(text: string): React.JSX.Element {
  let color = ''
  let bold = false
  let italic = false
  let underline = false
  let strike = false
  let obfuscated = false
  const parts: React.JSX.Element[] = []
  let buffer = ''
  let partIndex = 0
  const flush = (): void => {
    if (buffer) {
      parts.push(<span key={`mc-${partIndex++}`} className={obfuscated ? 'ftb-mc-text-obfuscated' : undefined} style={{ color: color || undefined, fontWeight: bold ? 700 : undefined, fontStyle: italic ? 'italic' : undefined, textDecoration: [underline ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined }}>{buffer}</span>)
    }
    buffer = ''
  }
  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index]
    const code = text[index + 1]?.toLowerCase()
    if ((marker !== '&' && marker !== '§') || !code || !/[0-9a-fk-orx]/i.test(code)) { buffer += marker; continue }
    flush()
    if (MC_COLOR_CODES[code]) { color = MC_COLOR_CODES[code]; bold = false; italic = false; underline = false; strike = false; obfuscated = false }
    else if (code === 'l') bold = true
    else if (code === 'o') italic = true
    else if (code === 'n') underline = true
    else if (code === 'm') strike = true
    else if (code === 'k') obfuscated = true
    else if (code === 'r') { color = ''; bold = false; italic = false; underline = false; strike = false; obfuscated = false }
    // Java's extended hex form: §x§R§R§G§G§B§B (and the & equivalent).
    else if (code === 'x') {
      const hex = text.slice(index + 2).match(/^(?:[§&][0-9a-f]){6}/i)?.[0]
      if (hex) { color = `#${hex.replace(/[§&]/gi, '').slice(0, 6)}`; bold = false; italic = false; underline = false; strike = false; obfuscated = false; index += 13 }
    }
    index += 1
  }
  flush()
  if (!parts.length) return <>{text}</>
  return <span className="ftb-mc-text">{parts}</span>
}

/** 异步显示物品中文名；未解析到时显示清洗后的 ID（剥离 NBT）。 */
function FtbItemLabel({ itemId, mcVersion, fallback }: { itemId: string; mcVersion: string; fallback?: string }): React.JSX.Element | null {
  const name = useFtbItemName(itemId, mcVersion)
  if (name) return renderColoredText(name)
  const clean = fallback !== undefined ? cleanItemId(fallback) : cleanItemId(itemId)
  return clean ? <>{clean}</> : null
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function asList(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function asText(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : fallback }
function resourceId(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) return asText(asRecord(value).id)
  return ''
}
function asNumber(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function formatRaw(value: unknown): string { return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) }

// FTB Quests 任务/奖励类型元数据，字段 key 与游戏内 SNBT/JSON5 文件格式保持一致。
type FtbFieldKind = 'text' | 'number' | 'boolean' | 'select' | 'vec3'
type FtbFieldSchema = { key: string; label: string; kind: FtbFieldKind; placeholder?: string; options?: Array<{ value: string; label: string }>; default?: string | number | boolean }
type FtbTypeMeta = { value: string; label: string; fields: FtbFieldSchema[] }

const OBSERVATION_KINDS: Array<{ value: string; label: string }> = [
  { value: 'block', label: '方块' },
  { value: 'block_tag', label: '方块标签' },
  { value: 'block_state', label: '方块状态' },
  { value: 'block_entity', label: '方块实体' },
  { value: 'block_entity_type', label: '方块实体类型' },
  { value: 'entity_type', label: '实体类型' },
  { value: 'entity_type_tag', label: '实体类型标签' }
]

const TASK_TYPES: FtbTypeMeta[] = [
  { value: 'checkmark', label: '手动确认', fields: [] },
  { value: 'item', label: '提交物品', fields: [
    { key: 'item', label: '物品 ID', kind: 'text', placeholder: 'minecraft:stone', default: 'minecraft:stone' },
    { key: 'count', label: '数量', kind: 'number', default: 1 },
    { key: 'consume', label: '扣除物品', kind: 'boolean', default: true },
    { key: 'only_from_crafting', label: '仅合成计数', kind: 'boolean' },
    { key: 'weak_nbt', label: '忽略 NBT 差异', kind: 'boolean' }
  ] },
  { value: 'fluid', label: '提交流体', fields: [
    { key: 'fluid', label: '流体 ID', kind: 'text', placeholder: 'minecraft:water', default: 'minecraft:water' },
    { key: 'amount', label: '数量（mB）', kind: 'number', default: 1000 }
  ] },
  { value: 'energy', label: '提交能量', fields: [
    { key: 'value', label: '能量（FE）', kind: 'number', default: 1000 }
  ] },
  { value: 'xp', label: '提交经验', fields: [
    { key: 'value', label: '数量', kind: 'number', default: 10 },
    { key: 'points', label: '按经验点计（否则为等级）', kind: 'boolean' }
  ] },
  { value: 'kill', label: '击杀实体', fields: [
    { key: 'entity', label: '实体 ID', kind: 'text', placeholder: 'minecraft:zombie', default: 'minecraft:zombie' },
    { key: 'value', label: '数量', kind: 'number', default: 1 },
    { key: 'custom_name', label: '自定义名称', kind: 'text' }
  ] },
  { value: 'location', label: '到达位置', fields: [
    { key: 'dimension', label: '维度', kind: 'text', placeholder: 'minecraft:overworld', default: 'minecraft:overworld' },
    { key: 'position', label: '中心坐标 x, y, z', kind: 'vec3', placeholder: '0, 64, 0' },
    { key: 'size', label: '区域大小 w, h, d', kind: 'vec3', placeholder: '16, 16, 16' },
    { key: 'ignore_dimension', label: '忽略维度限制', kind: 'boolean' }
  ] },
  { value: 'observation', label: '观察目标', fields: [
    { key: 'observation_type', label: '观察类型', kind: 'select', options: OBSERVATION_KINDS, default: 'block' },
    { key: 'to_observe', label: '目标 ID', kind: 'text', placeholder: 'minecraft:dirt', default: 'minecraft:dirt' },
    { key: 'timer', label: '停留时间（tick）', kind: 'number' }
  ] },
  { value: 'advancement', label: '达成进度', fields: [
    { key: 'advancement', label: '进度 ID', kind: 'text', placeholder: 'minecraft:story/root', default: 'minecraft:story/root' },
    { key: 'criterion', label: '条件（可选）', kind: 'text' }
  ] },
  { value: 'stat', label: '统计数值', fields: [
    { key: 'stat', label: '统计项 ID', kind: 'text', placeholder: 'minecraft:play_one_minute' },
    { key: 'value', label: '目标值', kind: 'number', default: 1 }
  ] },
  { value: 'biome', label: '进入生物群系', fields: [
    { key: 'biome', label: '生物群系 ID', kind: 'text', placeholder: 'minecraft:plains', default: 'minecraft:plains' }
  ] },
  { value: 'dimension', label: '进入维度', fields: [
    { key: 'dimension', label: '维度 ID', kind: 'text', placeholder: 'minecraft:the_nether', default: 'minecraft:the_nether' }
  ] },
  { value: 'structure', label: '探索结构', fields: [
    { key: 'structure', label: '结构 ID', kind: 'text', placeholder: 'minecraft:village_plains' }
  ] },
  { value: 'gamestage', label: '游戏阶段（GameStage）', fields: [
    { key: 'stage', label: '阶段名', kind: 'text' }
  ] },
  { value: 'custom', label: '自定义', fields: [] }
]

const REWARD_TYPES: FtbTypeMeta[] = [
  { value: 'item', label: '物品', fields: [
    { key: 'item', label: '物品 ID', kind: 'text', placeholder: 'minecraft:stone', default: 'minecraft:stone' },
    { key: 'count', label: '数量', kind: 'number', default: 1 }
  ] },
  { value: 'xp', label: '经验点', fields: [
    { key: 'xp', label: '经验点数', kind: 'number', default: 10 }
  ] },
  { value: 'xp_levels', label: '经验等级', fields: [
    { key: 'xp_levels', label: '等级数', kind: 'number', default: 1 }
  ] },
  { value: 'command', label: '命令', fields: [
    { key: 'command', label: '命令', kind: 'text', placeholder: 'give @s minecraft:stone', default: 'give @s minecraft:stone' }
  ] },
  { value: 'advancement', label: '授予进度', fields: [
    { key: 'advancement', label: '进度 ID', kind: 'text', placeholder: 'minecraft:story/root' }
  ] },
  { value: 'gamestage', label: '授予游戏阶段', fields: [
    { key: 'stage', label: '阶段名', kind: 'text' }
  ] },
  { value: 'toast', label: '弹窗提示', fields: [
    { key: 'toast', label: '提示文本', kind: 'text', placeholder: '感谢游玩！' }
  ] },
  { value: 'choice', label: '多选一奖励表', fields: [
    { key: 'table_id', label: '奖励表 ID', kind: 'text', placeholder: '选择奖励表' }
  ] },
  { value: 'random', label: '随机奖励表', fields: [
    { key: 'table_id', label: '奖励表 ID', kind: 'text', placeholder: '选择奖励表' }
  ] },
  { value: 'all_table', label: '全量奖励表', fields: [
    { key: 'table_id', label: '奖励表 ID', kind: 'text', placeholder: '选择奖励表' }
  ] },
  { value: 'loot', label: '战利品表', fields: [
    { key: 'table', label: '战利品表 ID', kind: 'text', placeholder: 'minecraft:gameplay/fishing' }
  ] },
  { value: 'currency', label: '货币（FTB Money）', fields: [
    { key: 'currency', label: '金额', kind: 'number', default: 1 }
  ] },
  { value: 'custom', label: '自定义', fields: [] }
]

function typeMeta(types: FtbTypeMeta[], type: string): FtbTypeMeta {
  return types.find((meta) => meta.value === type) ?? { value: type, label: `${type}（未知类型）`, fields: [] }
}

/** Convert an FTB object ID to a decimal string for table_id without Number precision loss. */
function rewardTableIdValue(table: FtbQuestRewardTable): string {
  const rawId = asRecord(table.raw).id
  if (typeof rawId === 'bigint') return rawId.toString(10)
  const id = asText(rawId, table.id).trim()
  if (/^[0-9a-f]{16,32}$/i.test(id)) {
    try {
      const parsed = BigInt(`0x${id}`)
      const signed = id.length === 16 && parsed >= 0x8000000000000000n ? parsed - 0x10000000000000000n : parsed
      return signed.toString(10)
    } catch { return id }
  }
  return id
}

function defaultRaw(meta: FtbTypeMeta): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const field of meta.fields) if (field.default !== undefined) raw[field.key] = field.default
  return raw
}

function vec3Text(value: unknown): string {
  return asList(value).map((entry) => asNumber(entry)).join(', ')
}

function parseVec3(value: string): number[] | undefined {
  const parts = value.split(',').map((part) => Number(part.trim()))
  return parts.length === 3 && parts.every((part) => Number.isFinite(part)) ? parts.map(Math.trunc) : undefined
}

function FtbFieldRow({ schema, value, onChange }: { schema: FtbFieldSchema; value: unknown; onChange: (next: unknown) => void }): React.JSX.Element {
  if (schema.kind === 'boolean') return <label className="ftb-quest-field boolean"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{schema.label}</label>
  if (schema.kind === 'select') return <label className="ftb-quest-field">{schema.label}<select value={asText(value, String(schema.default ?? ''))} onChange={(event) => onChange(event.target.value)}>{schema.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
  if (schema.kind === 'number') return <label className="ftb-quest-field">{schema.label}<input type="number" value={value === undefined || value === null || value === '' ? '' : asNumber(value)} placeholder={schema.placeholder} onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} /></label>
  if (schema.kind === 'vec3') return <label className="ftb-quest-field">{schema.label}<input value={value === undefined || value === null ? '' : vec3Text(value)} placeholder={schema.placeholder ?? '0, 0, 0'} onChange={(event) => { const trimmed = event.target.value.trim(); onChange(trimmed === '' ? undefined : parseVec3(trimmed)) }} /></label>
  return <label className="ftb-quest-field">{schema.label}<input value={asText(value)} placeholder={schema.placeholder} onChange={(event) => onChange(event.target.value)} /></label>
}

function hydrateQuest(rawInput: Record<string, unknown>): FtbQuestDocumentQuest {
  const raw = rawInput
  const dependencies = asList(raw.dependencies).map((entry) => typeof entry === 'object' ? asText(asRecord(entry).id) : asText(entry)).filter(Boolean)
  const tasks = asList(raw.tasks).map((entry): FtbQuestTaskDocument => { const item = asRecord(entry); return { id: asText(item.id, newId()), type: asText(item.type, 'checkmark'), title: asText(item.title), raw: item } })
  const rewards = asList(raw.rewards).map((entry): FtbQuestRewardDocument => { const item = asRecord(entry); return { id: asText(item.id, newId()), type: asText(item.type, 'item'), title: asText(item.title), raw: item } })
  const id = asText(raw.id, newId())
  const explicitTitle = asText(raw.title)
  const fallbackTitle = tasks.map((task) => task.title?.trim()).find(Boolean) || asText(raw.subtitle) || `任务 ${id.slice(0, 8)}`
  return {
    id, title: explicitTitle || fallbackTitle, titleIsFallback: !explicitTitle, subtitle: asText(raw.subtitle), description: Array.isArray(raw.description) ? raw.description.map((entry) => asText(entry)).join('\n') : asText(raw.description), icon: resourceId(raw.icon), shape: asText(raw.shape, 'circle'), x: asNumber(raw.x), y: asNumber(raw.y),
    minRequiredTasks: raw.min_required_tasks === undefined ? undefined : asNumber(raw.min_required_tasks), hideDependencyLines: raw.hide_dependency_lines === undefined ? undefined : Boolean(raw.hide_dependency_lines),
    dependencies, tasks, rewards, raw
  }
}

function QuestFlowNode({ data }: { data: QuestNodeData }): React.JSX.Element {
  const { scope } = useContext(FtbResources)
  // A quest without an explicit icon or item/fluid task still needs a visual
  // identity. This is render-only and never mutates the serialized quest.
  const descriptor = data.descriptor ?? data.iconFallback[0] ?? ftbIconDescriptor('minecraft:book')!
  const descriptorKey = ftbIconKey(descriptor)
  const targetId = descriptor?.id ?? ''
  // React Flow already mounts only visible nodes. A second zoom/observer gate
  // left icon requests permanently disabled after fitView on large chapters.
  const shouldLoadIcon = true
  const itemName = useFtbItemName(targetId, data.mcVersion, shouldLoadIcon)
  const itemCount = data.iconFallback.length
  const [inspection, setInspection] = useState<FtbQuestIconInspection | null>(null)
  const [fallbackIcon, setFallbackIcon] = useState<FtbQuestIconInspection['icon']>(null)
  useEffect(() => {
    let alive = true
    setInspection(null)
    setFallbackIcon(null)
    if (shouldLoadIcon && descriptor) requestFtbIcon(data.projectPath, scope, descriptor).then(result => {
      if (alive) setInspection(result)
    }).catch(error => { if (alive) setInspection({ icon: null, reason: String(error), sources: [], generation: 0 }) })
    return () => { alive = false }
  }, [descriptorKey, data.projectPath, scope, shouldLoadIcon])
  useEffect(() => {
    if (!shouldLoadIcon || !inspection || inspection.icon) return
    let alive = true
    requestFtbIcon(data.projectPath, scope, 'minecraft:book').then(result => { if (alive) setFallbackIcon(result.icon) }).catch(() => undefined)
    return () => { alive = false }
  }, [inspection, data.projectPath, scope, shouldLoadIcon])
  const icon = inspection?.icon
  const renderedIcon = icon ?? fallbackIcon
  const imageSrc = shouldLoadIcon ? renderedIcon?.url : null
  const animatedStyle: CSSProperties | null = renderedIcon?.animated ? {
    width: renderedIcon.frameWidth * Math.min(42 / renderedIcon.frameWidth, 42 / renderedIcon.frameHeight),
    height: renderedIcon.frameHeight * Math.min(42 / renderedIcon.frameWidth, 42 / renderedIcon.frameHeight),
    backgroundImage: `url(${renderedIcon.url})`,
    backgroundSize: `100% ${renderedIcon.frameCount * 100}%`,
    backgroundRepeat: 'no-repeat',
    '--fqi-shift': `-${renderedIcon.frameCount * renderedIcon.frameHeight * Math.min(42 / renderedIcon.frameWidth, 42 / renderedIcon.frameHeight)}px`,
    animation: `ftb-quest-icon-flow ${renderedIcon.frameCount * renderedIcon.frametimeMs}ms steps(${renderedIcon.frameCount}) infinite`
  } as CSSProperties : null
  // 与游戏 QuestButton#draw 一致：形状用三层贴图叠加（shape 深灰底 + background 白色高光 + outline 状态色描边），
  // 每层都是白色剪影，渲染端用 CSS mask 按层颜色着色（等价于游戏里剪影×颜色的乘法着色）。
  const shapes = useFtbShapes()
  const shapeId = shapes && (data.shape in shapes) ? data.shape : 'circle'
  const shapeSet = shapes?.[shapeId] ?? null
  const shapeLayers = shapeId === 'none' ? null : shapeSet
    ? <>
      <span className="ftb-quest-shape-layer" style={{ background: '#373737', maskImage: `url(${shapeSet.shape})`, WebkitMaskImage: `url(${shapeSet.shape})` }} />
      <span className="ftb-quest-shape-layer" style={{ background: 'rgba(255,255,255,0.59)', maskImage: `url(${shapeSet.background})`, WebkitMaskImage: `url(${shapeSet.background})` }} />
      <span className="ftb-quest-shape-layer" style={{ background: 'rgba(255,255,255,0.59)', maskImage: `url(${shapeSet.outline})`, WebkitMaskImage: `url(${shapeSet.outline})` }} />
    </>
    : <span className="ftb-quest-shape-fallback" />
  return <div className={`ftb-quest-node shape-${shapeId}`}>
    <Handle id="target-top" className="ftb-quest-handle target top" type="target" position={Position.Top} />
    <Handle id="source-top" className="ftb-quest-handle source top" type="source" position={Position.Top} />
    <Handle id="target-right" className="ftb-quest-handle target right" type="target" position={Position.Right} />
    <Handle id="source-right" className="ftb-quest-handle source right" type="source" position={Position.Right} />
    <Handle id="target-bottom" className="ftb-quest-handle target bottom" type="target" position={Position.Bottom} />
    <Handle id="source-bottom" className="ftb-quest-handle source bottom" type="source" position={Position.Bottom} />
    <Handle id="target-left" className="ftb-quest-handle target left" type="target" position={Position.Left} />
    <Handle id="source-left" className="ftb-quest-handle source left" type="source" position={Position.Left} />
    {shapeLayers}
    <div className="ftb-quest-tile" title={inspection ? `${targetId}: ${inspection.reason}` : targetId}>{imageSrc ? (animatedStyle ? <div className="ftb-quest-tile-img animated" style={animatedStyle} /> : <img className="ftb-quest-tile-img" src={imageSrc} alt={icon ? targetId : 'minecraft:book'} draggable={false} onError={() => setFallbackIcon(null)} />) : <span>{inspection ? <AlertTriangle size={20} /> : <LoaderCircle className="spin" size={20} />}</span>}{itemCount > 1 ? <span className="ftb-quest-tile-count">{itemCount > 99 ? '99+' : itemCount}</span> : null}</div>
    <div className="ftb-quest-node-tooltip"><strong>{renderColoredText(data.title)}</strong>{itemName ? <small>{itemName}</small> : null}{icon?.quality === 'approximate' ? <small>近似预览</small> : null}{data.subtitle ? <small>{renderColoredText(data.subtitle)}</small> : null}{data.tasks || data.rewards ? <em>{data.tasks} 个条件 · {data.rewards} 个奖励</em> : null}</div>
  </div>
}

function directionalHandles(source: { x: number; y: number }, target: { x: number; y: number }): Pick<Edge, 'sourceHandle' | 'targetHandle'> {
  const dx = target.x - source.x
  const dy = target.y - source.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0
    ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
    : { sourceHandle: 'source-left', targetHandle: 'target-right' }
  return dy >= 0
    ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
    : { sourceHandle: 'source-top', targetHandle: 'target-bottom' }
}

function RoutedQuestEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, markerStart, style, interactionWidth, data }: EdgeProps<QuestEdge>): React.JSX.Element {
  // 与游戏 QuestPanel#renderConnection 一致：连线从源任务中心到目标任务中心的直线（不是贝塞尔弧线），
  // dependency.png 箭头贴图沿直线无缝平铺并按主题色染色，无独立箭头端点。
  const depTexture = useFtbDependencyTexture()
  const [sourceId, targetId] = id.split(':')
  const sourceNode = useStore((store) => store.nodeLookup.get(sourceId))
  const targetNode = useStore((store) => store.nodeLookup.get(targetId))
  const sx = sourceNode ? sourceNode.position.x + (sourceNode.measured?.width ?? 0) / 2 : sourceX
  const sy = sourceNode ? sourceNode.position.y + (sourceNode.measured?.height ?? 0) / 2 : sourceY
  const tx = targetNode ? targetNode.position.x + (targetNode.measured?.width ?? 0) / 2 : targetX
  const ty = targetNode ? targetNode.position.y + (targetNode.measured?.height ?? 0) / 2 : targetY
  const dx = tx - sx
  const dy = ty - sy
  const length = Math.hypot(dx, dy) || 1
  const angle = Math.atan2(dy, dx) * (180 / Math.PI)
  const path = `M ${sx} ${sy} L ${tx} ${ty}`
  const animated = Boolean(data?.animated)
  const uid = id.replace(/[^a-zA-Z0-9_-]/g, '')
  const patternId = `ftb-dep-pat-${uid}`
  const maskId = `ftb-dep-mask-${uid}`
  const gradientId = `ftb-dep-grad-${uid}`
  // 贴图尚未就绪/缺失时的兜底：主题色直线（无箭头贴图，与游戏 drawOffsetBackground 无贴图时的表现一致）。
  if (!depTexture) {
    return <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} style={{ ...style, stroke: QUEST_EDGE_START, strokeWidth: 2 }} interactionWidth={interactionWidth} />
  }
  // 原版渲染：在旋转到连线方向的局部坐标系里，用 dependency.png 斜条纹贴图沿长度平铺（贴图单元 = 2×线宽），
  // 以主题色遮罩染色。注意渐变方向：游戏 x=0 是"依赖者"端保持主题色、依赖端 RGB×3/4 变暗，
  // 而这里局部坐标系 x=0 在依赖（source）端，所以 stop0 用暗色 END、stop1 用亮色 START。
  // 流动动画对应游戏内 mu 偏移：图案向依赖者（解锁中的任务）方向前进，用 CSS 平移 mask 内的贴图矩形实现。
  return (
    <g>
      <BaseEdge id={id} path={path} style={{ ...style, stroke: 'transparent', strokeWidth: Math.max(interactionWidth ?? 20, 14) }} interactionWidth={interactionWidth} />
      <g transform={`translate(${sx}, ${sy}) rotate(${angle})`}>
        <defs>
          <pattern id={patternId} width={QUEST_EDGE_TILE} height={QUEST_EDGE_TILE} patternUnits="userSpaceOnUse">
            <image href={depTexture} width={QUEST_EDGE_TILE} height={QUEST_EDGE_TILE} preserveAspectRatio="none" />
          </pattern>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y={-QUEST_EDGE_TILE / 2} width={length} height={QUEST_EDGE_TILE}>
            <g className={animated ? 'ftb-dep-flow' : undefined} style={animated ? ({ '--ftb-dep-tile': `${QUEST_EDGE_TILE}px` } as CSSProperties) : undefined}>
              <rect x={-QUEST_EDGE_TILE} y={-QUEST_EDGE_TILE / 2} width={length + QUEST_EDGE_TILE * 2} height={QUEST_EDGE_TILE} fill={`url(#${patternId})`} />
            </g>
          </mask>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={length} y2="0">
            <stop offset="0" stopColor={QUEST_EDGE_END} />
            <stop offset="1" stopColor={QUEST_EDGE_START} />
          </linearGradient>
        </defs>
        <rect x="0" y={-QUEST_EDGE_TILE / 2} width={length} height={QUEST_EDGE_TILE} fill={`url(#${gradientId})`} mask={`url(#${maskId})`} />
      </g>
    </g>
  )
}

// 游戏内行为：任务未显式设置 icon 时，自动使用提交物品/流体任务对应的物品图标。
// 一个任务（quest）可包含多个 item/fluid 条件，全部收集：首个作为节点主图标，其余以数量角标提示。
function questIconFallback(quest: FtbQuestDocumentQuest): FtbIconDescriptor[] {
  return quest.tasks.flatMap(task => {
    const descriptor = ftbIconDescriptor(task.raw.icon ?? (task.type === 'item' ? task.raw.item : task.type === 'fluid' ? task.raw.fluid : null))
    return descriptor ? [descriptor] : []
  })
}

function questNodes(chapter: FtbQuestDocumentChapter | undefined, mcVersion: string, projectPath: string): QuestNode[] {
  return (chapter?.quests ?? []).map((quest) => ({ id: quest.id, type: 'quest', position: { x: quest.x * QUEST_GRID_X, y: quest.y * QUEST_GRID_Y }, data: { title: quest.title, subtitle: quest.subtitle, icon: quest.icon, descriptor: ftbIconDescriptor(quest.raw.icon)?.id === quest.icon ? ftbIconDescriptor(quest.raw.icon) : ftbIconDescriptor(quest.icon), iconFallback: questIconFallback(quest), shape: quest.shape, tasks: quest.tasks.length, rewards: quest.rewards.length, mcVersion, projectPath } }))
}

function questEdges(chapter: FtbQuestDocumentChapter | undefined): QuestEdge[] {
  const local = new Set((chapter?.quests ?? []).map((quest) => quest.id))
  const positions = new Map((chapter?.quests ?? []).map((quest) => [quest.id, { x: quest.x * QUEST_GRID_X, y: quest.y * QUEST_GRID_Y }]))
  // 与游戏 drawOffsetBackground 一致：设置了 hide_dependency_lines 的任务不画依赖线。
  const edges: QuestEdge[] = (chapter?.quests ?? []).filter((quest) => !quest.hideDependencyLines).flatMap((quest) => quest.dependencies.filter((dependency) => local.has(dependency)).map((dependency): QuestEdge => ({ id: `${dependency}:${quest.id}`, source: dependency, target: quest.id, type: 'questRoute', style: { stroke: QUEST_EDGE_COLOR, strokeWidth: 2 }, ...directionalHandles(positions.get(dependency) ?? { x: 0, y: 0 }, positions.get(quest.id) ?? { x: 0, y: 0 }) })))
  return edges
}

export default function FtbQuestEditor({ project }: { project: ProjectInfo }): React.JSX.Element {
  const resourceRevision = 0
  const [backups, setBackups] = useState<Array<{ id: string; createdAt: string; files: number }> | null>(null)
  const savedBook = useRef<FtbQuestBook | null>(null)
  const textEdit = useRef({ key: '', time: 0 })
  const requestGeneration = useRef(0)
  const loadedProject = useRef<string | null>(null)
  const { confirm, dialog } = useConfirmDialog()
  const [book, setBook] = useState<FtbQuestBook | null>(null)
  const [selectedChapterId, setSelectedChapterId] = useState('')
  const selectedChapterIdRef = useRef('')
  const [selectedQuestId, setSelectedQuestId] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  // 右键菜单：kind=pane 在画布空白处，kind=quest 在任务节点上（与游戏编辑模式右键一致）。
  const [ctxMenu, setCtxMenu] = useState<{ kind: 'pane' | 'quest'; x: number; y: number; questId?: string } | null>(null)
  // 菜单实际尺寸（渲染后测量），用于在屏幕边缘自动调整位置，避免超出可视区域。
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)
  const [ctxMenuSize, setCtxMenuSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (!ctxMenu) { setCtxMenuSize(null); return }
    // 下一帧测量，避免在同一渲染周期内读取旧布局。
    const frame = window.requestAnimationFrame(() => {
      const rect = ctxMenuRef.current?.getBoundingClientRect()
      if (rect) setCtxMenuSize({ width: rect.width, height: rect.height })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ctxMenu])
  // 位置策略（与游戏 openContextMenu 一致）：优先出现在光标右下方；靠近右/下边缘时翻转到左/上方。
  const ctxMenuPosition = useMemo<{ left: number; top: number }>(() => {
    if (!ctxMenu) return { left: 0, top: 0 }
    const width = ctxMenuSize?.width ?? 180
    const height = ctxMenuSize?.height ?? 260
    const overflowRight = ctxMenu.x + width > window.innerWidth - 8
    const overflowBottom = ctxMenu.y + height > window.innerHeight - 8
    return {
      left: overflowRight ? Math.max(8, ctxMenu.x - width) : ctxMenu.x,
      top: overflowBottom ? Math.max(8, ctxMenu.y - height) : ctxMenu.y
    }
  }, [ctxMenu, ctxMenuSize])
  const [message, setMessage] = useState('正在读取任务书…')
  // 奖励表管理弹层（对应游戏 RewardTablesScreen / EditRewardTableScreen）。
  const [showRewardTables, setShowRewardTables] = useState(false)
  const [editingRewardTableId, setEditingRewardTableId] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | ''>('load')
  const [rawValue, setRawValue] = useState('')
  const [expandedTaskId, setExpandedTaskId] = useState('')
  const [expandedRewardId, setExpandedRewardId] = useState('')
  const [nodes, setNodes, onNodesChange] = useNodesState<QuestNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<QuestEdge>([])
  const flowRef = useRef<ReactFlowInstance<QuestNode, QuestEdge> | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!canvasRef.current) return
    const observer = new ResizeObserver(() => { void flowRef.current?.fitView({ padding: .18, maxZoom: 1.15 }) })
    observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [])
  const undoStack = useRef<FtbQuestBook[]>([])
  const redoStack = useRef<FtbQuestBook[]>([])
  const [, setHistoryVersion] = useState(0)

  const chapter = book?.chapters.find((item) => item.id === selectedChapterId) ?? book?.chapters[0]
  const selectedQuest = chapter?.quests.find((item) => item.id === selectedQuestId)
  const diagnostics = useMemo(() => book ? [...book.diagnostics.filter(item => ['parse-failed', 'mixed-format'].includes(item.code)), ...validateFtbQuestBook(book)] : [], [book])
  const errors = diagnostics.filter((item) => item.severity === 'error')
  const onQuestNodesChange = useCallback((changes: NodeChange<QuestNode>[]): void => onNodesChange(changes.filter((change) => change.type !== 'remove')), [onNodesChange])

  const syncCanvas = useCallback((nextChapter: FtbQuestDocumentChapter | undefined): void => {
    setNodes(questNodes(nextChapter, project.minecraftVersion, project.path)); setEdges(questEdges(nextChapter)); setSelectedEdgeId('')
    window.requestAnimationFrame(() => flowRef.current?.fitView({ duration: 180, padding: 0.18, maxZoom: 1.15 }))
  }, [project.minecraftVersion, project.path, setEdges, setNodes])

  const load = useCallback(async (): Promise<void> => {
    const generation = ++requestGeneration.current
    loadedProject.current = null
    setBook(null)
    setNodes([]); setEdges([])
    setSelectedQuestId(''); setSelectedEdgeId('')
    undoStack.current = []; redoStack.current = []
    setBusy('load')
    try {
      const next = await window.modmind.modpack.readFtbQuestBook(project.path)
      if (generation !== requestGeneration.current) return
      loadedProject.current = project.path
      setBook(next)
      savedBook.current = next
      undoStack.current = []; redoStack.current = []; setHistoryVersion((current) => current + 1)
      const nextChapter = next.chapters.find((item) => item.id === selectedChapterIdRef.current) ?? next.chapters[0]
      selectedChapterIdRef.current = nextChapter?.id ?? ''
      setSelectedChapterId(selectedChapterIdRef.current)
      setSelectedQuestId('')
      syncCanvas(nextChapter)
      setMessage(next.chapters.length ? `已载入 ${next.chapters.length} 个章节` : '未发现任务章节，可以从这里创建第一章')
    } catch (error) { if (generation === requestGeneration.current) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (generation === requestGeneration.current) setBusy('') }
  }, [syncCanvas, project.path, setNodes, setEdges])

  useEffect(() => { void load(); return () => { requestGeneration.current += 1; loadedProject.current = null } }, [load, project.path])
  useEffect(() => { if (selectedQuest) setRawValue(formatRaw(selectedQuest.raw)) }, [selectedQuest?.id])
  useEffect(() => {
    const same = (a: unknown, b: unknown): boolean => formatRaw(a) === formatRaw(b)
    setNodes(current => questNodes(chapter, project.minecraftVersion, project.path).map(node => {
      const existing = current.find(item => item.id === node.id)
      return existing && same(existing.data, node.data) && same(existing.position, node.position) ? existing : { ...existing, ...node }
    }))
    setEdges(current => questEdges(chapter).map(edge => current.find(item => item.id === edge.id && same(item, edge)) ?? edge))
  }, [chapter, project.minecraftVersion, project.path, setEdges, setNodes])

  const updateBook = (recipe: (current: FtbQuestBook) => FtbQuestBook, mergeKey = ''): void => {
    if (!book) return
    let next = recipe(book)
    const remaining = ftbObjectIds(next)
    const removed = [...ftbObjectIds(book)].filter(id => !remaining.has(id))
    if (removed.length) next = rewriteFtbQuestReferences(next, new Map(removed.map(id => [id, null])))
    const now = Date.now()
    if (!mergeKey || textEdit.current.key !== mergeKey || now - textEdit.current.time > 700) undoStack.current = [...undoStack.current, book].slice(-80)
    textEdit.current = { key: mergeKey, time: now }
    redoStack.current = []
    setHistoryVersion((current) => current + 1)
    setBook(next)
  }
  const undo = (): void => {
    if (!book) return
    textEdit.current = { key: '', time: 0 }
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(book); setBook(previous); setHistoryVersion((current) => current + 1); setMessage('已撤销上一步编辑')
  }
  const redo = (): void => {
    if (!book) return
    textEdit.current = { key: '', time: 0 }
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(book); setBook(next); setHistoryVersion((current) => current + 1); setMessage('已重做编辑')
  }
  const updateChapter = (id: string, patch: Partial<FtbQuestDocumentChapter>): void => updateBook((current) => ({ ...current, chapters: current.chapters.map((item) => item.id === id ? { ...item, ...patch } : item) }))
  const updateQuest = (questId: string, patch: Partial<FtbQuestDocumentQuest>): void => updateBook((current) => ({ ...current, chapters: current.chapters.map((item) => item.id !== chapter?.id ? item : { ...item, quests: item.quests.map((quest) => quest.id === questId ? { ...quest, ...patch } : quest) }) }), Object.keys(patch).length === 1 && ['title', 'subtitle', 'description'].includes(Object.keys(patch)[0]) ? `${questId}:${Object.keys(patch)[0]}` : '')

  const chooseChapter = (id: string): void => {
    const next = book?.chapters.find((item) => item.id === id)
    selectedChapterIdRef.current = id
    setSelectedChapterId(id); setSelectedQuestId(''); syncCanvas(next)
  }
  const chooseQuest = (id: string): void => {
    const owner = book?.chapters.find((item) => item.quests.some((quest) => quest.id === id))
    if (!owner) return
    if (owner.id !== chapter?.id) chooseChapter(owner.id)
    setExpandedTaskId(''); setExpandedRewardId('')
    setSelectedQuestId(id); setSelectedEdgeId('')
  }

  const createChapter = (): void => {
    if (!book) return
    const usedFilenames = new Set(book.chapters.map((item) => item.filename.toLowerCase()))
    let filenameIndex = book.chapters.length + 1
    while (usedFilenames.has(`chapter_${filenameIndex}`)) filenameIndex += 1
    const id = newId(); const filename = `chapter_${filenameIndex}`
    const next: FtbQuestDocumentChapter = { id, title: '新章节', subtitle: '', icon: 'minecraft:book', group: '', filename, source: `chapters/${filename}.${book.format}`, quests: [], raw: {} }
    updateBook((current) => ({ ...current, chapters: [...current.chapters, next] }))
    selectedChapterIdRef.current = id
    setSelectedChapterId(id); setSelectedQuestId(''); syncCanvas(next); setMessage('已创建新章节')
  }
  const deleteChapter = async (): Promise<void> => {
    if (!book || !chapter) return
    if (!await confirm({ title: `删除章节“${chapter.title}”？`, message: `其中的 ${chapter.quests.length} 个任务也会从任务书移除。更改将在保存任务书时写入文件。`, confirmLabel: '删除章节', cancelLabel: '保留章节', tone: 'danger', actionIcon: 'delete' })) return
    const remaining = book.chapters.filter((item) => item.id !== chapter.id)
    updateBook((current) => ({ ...current, chapters: remaining })); chooseChapter(remaining[0]?.id ?? ''); setMessage('章节将在保存时从任务书移除')
  }
  const createQuest = (): void => {
    if (!chapter) return
    const quest: FtbQuestDocumentQuest = { id: newId(), title: `新任务 ${chapter.quests.length + 1}`, titleIsFallback: false, subtitle: '', description: '', icon: 'minecraft:book', shape: 'circle', x: chapter.quests.length * 2, y: 0, dependencies: [], tasks: [{ id: newId(), type: 'checkmark', raw: {} }], rewards: [], raw: {} }
    updateChapter(chapter.id, { quests: [...chapter.quests, quest] }); setSelectedQuestId(quest.id); syncCanvas({ ...chapter, quests: [...chapter.quests, quest] }); setMessage('已添加任务')
  }
  // 右键空白处"新建任务"：与游戏 CreateTaskAtMessage 一致——先选任务条件类型，创建的任务带一个该类型条件（含默认字段）。
  const createQuestAt = useCallback((position: { x: number; y: number }, taskType: string): void => {
    if (!chapter) return
    const meta = typeMeta(TASK_TYPES, taskType)
    const quest: FtbQuestDocumentQuest = { id: newId(), title: `新任务 ${chapter.quests.length + 1}`, titleIsFallback: false, subtitle: '', description: '', icon: 'minecraft:book', shape: 'circle', x: Math.round(position.x / QUEST_GRID_X), y: Math.round(position.y / QUEST_GRID_Y), dependencies: [], tasks: [{ id: newId(), type: taskType, raw: defaultRaw(meta) }], rewards: [], raw: {} }
    updateChapter(chapter.id, { quests: [...chapter.quests, quest] }); setSelectedQuestId(''); syncCanvas({ ...chapter, quests: [...chapter.quests, quest] }); setMessage('已添加任务')
  }, [chapter, syncCanvas, updateChapter])
  const duplicateQuestById = (questId: string): void => {
    const quest = chapter?.quests.find((item) => item.id === questId)
    if (!chapter || !quest) return
    const clone: FtbQuestDocumentQuest = { ...quest, id: newId(), title: `${quest.title} 副本`, x: quest.x + 1, y: quest.y + 1, dependencies: [], tasks: quest.tasks.map((task) => ({ ...task, id: newId(), raw: { ...task.raw } })), rewards: quest.rewards.map((reward) => ({ ...reward, id: newId(), raw: { ...reward.raw } })), raw: { ...quest.raw } }
    updateChapter(chapter.id, { quests: [...chapter.quests, clone] }); setSelectedQuestId(clone.id); syncCanvas({ ...chapter, quests: [...chapter.quests, clone] })
  }
  const duplicateQuest = (): void => duplicateQuestById(selectedQuestId)
  // 添加前置依赖：questId（依赖者）依赖 dependencyId（前置）。对应游戏右键菜单的 Add Dependencies。
  const addDependency = (dependencyId: string, questId: string): void => {
    const quest = chapter?.quests.find((item) => item.id === questId)
    if (!quest || dependencyId === questId || quest.dependencies.includes(dependencyId)) return
    updateQuest(questId, { dependencies: [...quest.dependencies, dependencyId] }); setMessage('已添加前置任务')
  }
  const deleteQuestById = async (questId: string): Promise<void> => {
    const quest = chapter?.quests.find((item) => item.id === questId)
    if (!chapter || !quest || !await confirm({ title: `删除任务“${quest.title}”？`, message: '引用该任务的前置关系也会一并移除。更改将在保存任务书时写入文件。', confirmLabel: '删除任务', cancelLabel: '保留任务', tone: 'danger', actionIcon: 'delete' })) return
    const quests = chapter.quests.filter((item) => item.id !== questId)
    updateChapter(chapter.id, { quests }); setSelectedQuestId(''); syncCanvas({ ...chapter, quests })
  }
  const deleteQuest = async (): Promise<void> => { await deleteQuestById(selectedQuestId) }
  // 奖励表 CRUD（与游戏 RewardTablesScreen / EditRewardTableScreen 对应，保存时写入 reward_tables/ 目录）。
  const rewardTables = book?.rewardTables ?? []
  const editingRewardTable = rewardTables.find((item) => item.id === editingRewardTableId) ?? null
  const updateRewardTables = (recipe: (current: FtbQuestRewardTable[]) => FtbQuestRewardTable[]): void => {
    if (!book) return
    updateBook((current) => ({ ...current, rewardTables: recipe(current.rewardTables ?? []) }))
  }
  const updateRewardTable = (id: string, patch: Partial<FtbQuestRewardTable>): void => updateRewardTables((list) => list.map((item) => item.id === id ? { ...item, ...patch } : item))
  const createRewardTable = (): void => {
    const used = new Set(rewardTables.map((item) => item.filename.toLowerCase()))
    let index = rewardTables.length + 1
    while (used.has(`table_${index}`)) index += 1
    const table: FtbQuestRewardTable = { id: newTableId(), filename: `table_${index}`, source: '', title: `新奖励表 ${index}`, useTitle: false, hideTooltip: false, emptyWeight: 0, lootSize: 1, lootCrate: null, rewards: [], raw: {} }
    updateRewardTables((list) => [...list, table]); setEditingRewardTableId(table.id); setMessage('已创建奖励表')
  }
  const deleteRewardTable = async (id: string): Promise<void> => {
    const table = rewardTables.find((item) => item.id === id)
    if (!table || !await confirm({ title: `删除奖励表“${table.title}”？`, message: `${table.rewards.length} 个条目会一并移除。引用它的任务奖励需要手动改指向其他表。`, confirmLabel: '删除奖励表', cancelLabel: '保留奖励表', tone: 'danger', actionIcon: 'delete' })) return
    updateRewardTables((list) => list.filter((item) => item.id !== id))
    if (editingRewardTableId === id) setEditingRewardTableId('')
    setMessage('奖励表将在保存时从任务书移除')
  }
  const addRewardTableEntry = (tableId: string, type: string): void => {
    const meta = typeMeta(REWARD_TYPES, type)
    updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: [...item.rewards, { id: newId(), type, title: '', weight: 1, raw: defaultRaw(meta) }] } : item))
  }
  const removeRewardTableEntry = (tableId: string, entryId: string): void => updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: item.rewards.filter((entry) => entry.id !== entryId) } : item))
  const changeRewardTableEntryType = (tableId: string, entryId: string, type: string): void => {
    const meta = typeMeta(REWARD_TYPES, type)
    updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: item.rewards.map((entry) => entry.id === entryId ? { ...entry, type, raw: { ...entry.raw, ...defaultRaw(meta) } } : entry) } : item))
  }
  const setRewardTableEntryField = (tableId: string, entryId: string, key: string, value: unknown): void => updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: item.rewards.map((entry) => entry.id === entryId ? { ...entry, raw: { ...entry.raw, [key]: value } } : entry) } : item))
  const setRewardTableEntryWeight = (tableId: string, entryId: string, weight: number): void => updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: item.rewards.map((entry) => entry.id === entryId ? { ...entry, weight } : entry) } : item))
  const onConnect = useCallback((connection: Connection): void => {
    if (!chapter || !connection.source || !connection.target || connection.source === connection.target) return
    const target = chapter.quests.find((item) => item.id === connection.target)
    const source = chapter.quests.find((item) => item.id === connection.source)
    if (!target || !source || target.dependencies.includes(connection.source)) return
    const next = { ...target, dependencies: [...target.dependencies, connection.source] }
    updateQuest(target.id, { dependencies: next.dependencies }); setEdges((current) => addEdge({ ...connection, id: `${connection.source}:${connection.target}`, type: 'questRoute', style: { stroke: QUEST_EDGE_COLOR, strokeWidth: 2 }, ...directionalHandles({ x: source.x * QUEST_GRID_X, y: source.y * QUEST_GRID_Y }, { x: target.x * QUEST_GRID_X, y: target.y * QUEST_GRID_Y }) }, current)); setMessage('已添加前置任务')
  }, [chapter, setEdges])
  const onEdgesDelete = useCallback((deleted: QuestEdge[]): void => {
    if (!chapter || !deleted.length) return
    updateChapter(chapter.id, { quests: chapter.quests.map((quest) => ({
      ...quest,
      dependencies: quest.dependencies.filter((dependency) => !deleted.some((edge) => edge.target === quest.id && edge.source === dependency))
    })) })
  }, [chapter])
  // 与游戏一致：拖动后吸附到整数网格。
  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: QuestNode): void => updateQuest(node.id, { x: Math.round(node.position.x / QUEST_GRID_X), y: Math.round(node.position.y / QUEST_GRID_Y) }), [chapter])
  const onNodeClick: NodeMouseHandler<QuestNode> = (_event, node) => chooseQuest(node.id)
  // 与游戏一致：悬停任务时，与其相连的前置/后续连线上的箭头流开始流动；移开则恢复静止。
  const setHoveredEdges = useCallback((nodeId: string, animated: boolean): void => {
    setEdges((current) => current.map((item) => {
      const connected = item.source === nodeId || item.target === nodeId
      if (!connected) return item
      const next = { ...item, data: { ...(item.data ?? {}), animated } }
      return item.data?.animated === animated ? item : next
    }))
  }, [setEdges])
  const onNodeMouseEnter: NodeMouseHandler<QuestNode> = useCallback((_event, node) => setHoveredEdges(node.id, true), [setHoveredEdges])
  const onNodeMouseLeave: NodeMouseHandler<QuestNode> = useCallback((_event, node) => setHoveredEdges(node.id, false), [setHoveredEdges])
  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => { setSelectedQuestId(''); setSelectedEdgeId(edge.id); setEdges((current) => current.map((item) => ({ ...item, selected: item.id === edge.id }))) }, [setEdges])
  const removeSelectedEdge = (): void => {
    const edge = edges.find((item) => item.id === selectedEdgeId)
    if (!edge) return
    onEdgesDelete([edge]); setEdges((current) => current.filter((item) => item.id !== edge.id)); setSelectedEdgeId('')
  }
  const addTask = (type: string): void => selectedQuest && updateQuest(selectedQuest.id, { tasks: [...selectedQuest.tasks, { id: newId(), type, raw: defaultRaw(typeMeta(TASK_TYPES, type)) }] })
  const addReward = (type: string): void => selectedQuest && updateQuest(selectedQuest.id, { rewards: [...selectedQuest.rewards, { id: newId(), type, raw: defaultRaw(typeMeta(REWARD_TYPES, type)) }] })
  const removeTask = (taskId: string): void => selectedQuest && updateQuest(selectedQuest.id, { tasks: selectedQuest.tasks.filter((item) => item.id !== taskId) })
  const removeReward = (rewardId: string): void => selectedQuest && updateQuest(selectedQuest.id, { rewards: selectedQuest.rewards.filter((item) => item.id !== rewardId) })
  const changeTaskType = (taskId: string, type: string): void => {
    if (!selectedQuest) return
    const raw = defaultRaw(typeMeta(TASK_TYPES, type))
    updateQuest(selectedQuest.id, { tasks: selectedQuest.tasks.map((item) => item.id !== taskId ? item : { ...item, type, raw: { ...item.raw, ...raw } }) })
  }
  const changeRewardType = (rewardId: string, type: string): void => {
    if (!selectedQuest) return
    const raw = defaultRaw(typeMeta(REWARD_TYPES, type))
    updateQuest(selectedQuest.id, { rewards: selectedQuest.rewards.map((item) => item.id !== rewardId ? item : { ...item, type, raw: { ...item.raw, ...raw } }) })
  }
  const setTaskField = (taskId: string, key: string, value: unknown): void => {
    if (!selectedQuest) return
    updateQuest(selectedQuest.id, { tasks: selectedQuest.tasks.map((item) => {
      if (item.id !== taskId) return item
      const raw = { ...item.raw }
      if (value === undefined || value === '') delete raw[key]
      else raw[key] = value
      return key === 'title' ? { ...item, title: asText(value), raw } : { ...item, raw }
    }) })
  }
  const setRewardField = (rewardId: string, key: string, value: unknown): void => {
    if (!selectedQuest) return
    updateQuest(selectedQuest.id, { rewards: selectedQuest.rewards.map((item) => {
      if (item.id !== rewardId) return item
      const raw = { ...item.raw }
      if (value === undefined || value === '') delete raw[key]
      else raw[key] = value
      return key === 'title' ? { ...item, title: asText(value), raw } : { ...item, raw }
    }) })
  }
  const applyRaw = (): void => {
    if (!selectedQuest) return
    try {
      const next = hydrateQuest(asRecord(JSON.parse(rawValue)))
      if (next.id !== selectedQuest.id && ftbObjectIds(book!).has(next.id)) throw new Error('对象 ID 已存在')
      updateBook(current => rewriteFtbQuestReferences({ ...current, chapters: current.chapters.map(item => ({ ...item, quests: item.quests.map(quest => quest.id === selectedQuest.id ? next : quest) })) }, new Map([[selectedQuest.id, next.id]])))
      setSelectedQuestId(next.id)
      setMessage('已应用高级字段')
    } catch (error) { setMessage(`高级字段无效：${error instanceof Error ? error.message : String(error)}`) }
  }
  const save = async (): Promise<void> => {
    if (!book || busy || loadedProject.current !== project.path || errors.length) return
    const generation = requestGeneration.current
    setBusy('save')
    try {
      const result = await window.modmind.modpack.saveFtbQuestBook(book, project.path)
      if (generation !== requestGeneration.current) return
      const saved = { ...book, baseline: result.baseline }
      savedBook.current = saved
      setBook(current => current === book ? saved : current ? { ...current, baseline: result.baseline } : current)
      undoStack.current = undoStack.current.map(snapshot => ({ ...snapshot, baseline: result.baseline }))
      redoStack.current = redoStack.current.map(snapshot => ({ ...snapshot, baseline: result.baseline }))
      setMessage(`已保存 ${result.written.length} 个文件${result.removed.length ? `，移除 ${result.removed.length} 个章节文件` : ''}`)
    } catch (error) { if (generation === requestGeneration.current) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (generation === requestGeneration.current) setBusy('') }
  }

  const allQuests = useMemo(() => book?.chapters.flatMap((item) => item.quests) ?? [], [book])
  const dependencyObjects = useMemo(() => dependencyIndex(book), [book])
  const bookDependencyQuest = allQuests.find((item) => selectedQuest?.dependencies.includes(item.id))
  const bookDependantQuest = allQuests.find((item) => item.dependencies.includes(selectedQuest?.id ?? ''))
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)
  const questDialog = useModalAccessibility(Boolean(selectedQuestId || selectedEdge) && !showRewardTables, () => { setSelectedQuestId(''); setSelectedEdgeId('') })
  const tableDialog = useModalAccessibility(showRewardTables, () => setShowRewardTables(false))
  const restoreBackup = async (id: string): Promise<void> => {
    if (!book?.baseline || !await confirm({ title: '恢复任务书备份', message: '恢复此备份并替换当前任务书？当前磁盘内容会另存为新备份。', confirmLabel: '恢复', actionIcon: 'restore' })) return
    const generation = requestGeneration.current
    setBusy('save')
    try {
      const next = await window.modmind.modpack.restoreFtbQuestBackup(project.path, id, book.baseline)
      if (generation !== requestGeneration.current) return
      savedBook.current = next; setBook(next)
      undoStack.current = []; redoStack.current = []
      setBackups(null)
      const first = next.chapters[0]
      selectedChapterIdRef.current = first?.id ?? ''; setSelectedChapterId(first?.id ?? '')
      setSelectedQuestId(''); syncCanvas(first); setMessage('已恢复任务书备份')
    } catch (error) { if (generation === requestGeneration.current) setMessage(String(error)) }
    finally { if (generation === requestGeneration.current) setBusy('') }
  }
  const reload = async (): Promise<void> => {
    if (book !== savedBook.current && !await confirm({ title: '重新加载任务书', message: '放弃未保存的修改并重新加载？', confirmLabel: '放弃并加载' })) return
    await load()
  }

  return <FtbResources.Provider value={{ projectPath: project.path, scope: `${project.path}:${project.minecraftVersion}:${resourceRevision}` }}><div className="ftb-quest-editor">
    <header className="ftb-quest-toolbar content-toolbar"><div><h1>FTB 任务书</h1><p>章节、前置依赖、任务条件和奖励在同一张画布中编辑</p></div><div className="ftb-quest-toolbar-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void window.modmind.modpack.listFtbQuestBackups(project.path).then(setBackups).catch(error => setMessage(String(error)))}>备份恢复</button><span className={`ftb-quest-health ${errors.length ? 'error' : ''}`}>{errors.length ? <AlertTriangle size={14} /> : <PackageOpen size={14} />}{errors.length ? `${errors.length} 个问题` : `${book?.chapters.length ?? 0} 个章节`}</span><button className="icon-button" title="撤销" aria-label="撤销" disabled={!undoStack.current.length || Boolean(busy)} onClick={undo}><Undo2 size={15} /></button><button className="icon-button" title="重做" aria-label="重做" disabled={!redoStack.current.length || Boolean(busy)} onClick={redo}><Redo2 size={15} /></button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => { setShowRewardTables(true); setEditingRewardTableId('') }}><Gift size={15} />奖励表{rewardTables.length ? `（${rewardTables.length}）` : ''}</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void reload()}>{busy === 'load' ? <LoaderCircle className="spin" size={15} /> : <RotateCw size={15} />}重新加载</button><button className="primary-button" disabled={!book || Boolean(busy) || errors.length > 0} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存任务书</button></div></header>
    {backups ? <section aria-label="任务书备份"><div className="ftb-quest-panel-title"><strong>任务书备份</strong><button className="icon-button" title="关闭备份列表" onClick={() => setBackups(null)}><X size={16} /></button></div>{backups.length ? backups.map(backup => <div key={backup.id}><time>{new Date(backup.createdAt).toLocaleString()}</time> · {backup.files} 个文件 <button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void restoreBackup(backup.id)}>恢复</button></div>) : <p>暂无备份</p>}</section> : null}
    <div className="ftb-quest-layout">
      <aside className="ftb-quest-chapters"><div className="ftb-quest-panel-title"><span><FolderTree size={16} />章节</span><button className="icon-button" title="新建章节" onClick={createChapter} disabled={!book || Boolean(busy)}><FilePlus2 size={15} /></button></div><div className="ftb-quest-book-meta"><BookOpen size={14} /><span>{book?.format === 'json5' ? 'JSON5 任务书' : 'SNBT 任务书'}</span></div><div className="ftb-quest-chapter-list">{book?.chapters.map((item) => <button key={item.id} className={chapter?.id === item.id ? 'selected' : ''} onClick={() => chooseChapter(item.id)}><BookOpen size={15} /><span><strong>{renderColoredText(item.title)}</strong><small>{item.quests.length} 个任务</small></span><ChevronRight size={14} /></button>)}</div><button className="secondary-button compact ftb-quest-add-chapter" onClick={createChapter} disabled={!book}><Plus size={14} />新建章节</button></aside>
      <section className="ftb-quest-canvas-panel">
        <div className="ftb-quest-canvas-heading">
          <div>{chapter ? <><input aria-label="章节标题" value={chapter.title} onChange={(event) => updateChapter(chapter.id, { title: event.target.value })} /><span>{chapter.quests.length} 个任务</span></> : <span>选择或创建章节</span>}</div>
          <div><button className="icon-button" title="添加任务" disabled={!chapter} onClick={createQuest}><CirclePlus size={16} /></button><button className="icon-button" title="删除当前章节" disabled={!chapter} onClick={deleteChapter}><Trash2 size={15} /></button></div>
        </div>
        <div ref={canvasRef} className="ftb-quest-canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ quest: QuestFlowNode }} edgeTypes={{ questRoute: RoutedQuestEdge }} onNodesChange={onQuestNodesChange} onEdgesChange={onEdgesChange} onEdgesDelete={onEdgesDelete} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick} onNodeMouseEnter={onNodeMouseEnter} onNodeMouseLeave={onNodeMouseLeave} onEdgeClick={onEdgeClick} onConnect={onConnect} onPaneClick={() => { setSelectedEdgeId(''); setCtxMenu(null); setEdges((current) => current.map((item) => ({ ...item, selected: false }))) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setCtxMenu({ kind: 'quest', x: event.clientX, y: event.clientY, questId: node.id }) }} onPaneContextMenu={(event) => { event.preventDefault(); setCtxMenu({ kind: 'pane', x: event.clientX, y: event.clientY }) }} onInit={(instance) => { flowRef.current = instance; syncCanvas(chapter) }} deleteKeyCode={['Backspace', 'Delete']} onlyRenderVisibleElements fitView><MiniMap pannable zoomable /><Controls /><Background gap={26} size={1.3} color="#3a3b42" /></ReactFlow>
          {!chapter?.quests.length ? <div className="ftb-quest-empty"><ClipboardCheck size={20} /><strong>此章节还没有任务</strong><button className="primary-button compact" onClick={createQuest}><Plus size={14} />添加第一个任务</button></div> : null}
        </div>
      </section>
      {/* 任务详情不再使用右侧固定栏；点击任务节点会在画布中央打开书页（与游戏内一致） */}
    </div>
    {selectedQuestId || selectedEdge ? (
          <div className="modal-backdrop ftb-quest-book-overlay" role="presentation" onMouseDown={() => { setSelectedQuestId(''); setSelectedEdgeId(''); setExpandedTaskId(''); setExpandedRewardId('') }}>
            {selectedQuest ? (
              <div ref={questDialog} className="dialog ftb-quest-book" role="dialog" aria-label="任务详情" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
                <div className="ftb-quest-book-head">
                  <div className="ftb-quest-book-nav"><button className="icon-button" title="查看前置任务" disabled={!bookDependencyQuest} onClick={() => { if (bookDependencyQuest) chooseQuest(bookDependencyQuest.id) }}><ChevronLeft size={15} /></button><button className="icon-button" title="查看后续任务" disabled={!bookDependantQuest} onClick={() => { if (bookDependantQuest) chooseQuest(bookDependantQuest.id) }}><ChevronRight size={15} /></button></div>
                  <div className="ftb-quest-book-actions"><button className="icon-button" title="复制任务" onClick={duplicateQuest}><FileCode2 size={15} /></button>
                    <button className="icon-button" title="删除任务" onClick={() => void deleteQuest()}><Trash2 size={15} /></button>
                    <button className="icon-button" title="关闭" onClick={() => { setSelectedQuestId(''); setExpandedTaskId(''); setExpandedRewardId('') }}><X size={16} /></button>
                  </div>
                  <input className="ftb-quest-book-title" aria-label="任务标题" value={selectedQuest.title} placeholder="任务标题" onChange={(event) => updateQuest(selectedQuest.id, { title: event.target.value, titleIsFallback: false })} />
                </div>
                <div className="ftb-quest-book-columns">
                  <div className="ftb-quest-book-column">
                    <div className="ftb-quest-book-col-title"><span>任务</span><small>Tasks</small><select value="" aria-label="添加任务条件" onChange={(event) => { if (event.target.value) addTask(event.target.value); event.target.value = '' }}><option value="">＋ 添加</option>{TASK_TYPES.map((meta) => <option key={meta.value} value={meta.value}>{meta.label}</option>)}</select></div>
                    <div className="ftb-quest-book-tiles">{selectedQuest.tasks.map((task) => { const meta = typeMeta(TASK_TYPES, task.type); const known = TASK_TYPES.some((entry) => entry.value === task.type); const taskItemId = resourceId(task.raw.item) || resourceId(task.raw.fluid); return <div className={`ftb-quest-book-tile ${expandedTaskId === task.id ? 'expanded' : ''}`} key={task.id}><button className="ftb-quest-book-tile-btn" onClick={() => setExpandedTaskId(expandedTaskId === task.id ? '' : task.id)}><span className="ftb-quest-type-glyph" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{task.title ? renderColoredText(task.title) : <FtbItemLabel itemId={taskItemId} mcVersion={project.minecraftVersion} fallback={taskItemId} />}</span><span className="ftb-quest-book-tile-del" title="删除条件" onClick={(event) => { event.stopPropagation(); removeTask(task.id) }}><Trash2 size={12} /></span></button>{expandedTaskId === task.id ? <div className="ftb-quest-book-tile-fields"><label className="ftb-quest-book-type"><span>类型</span><select value={known ? task.type : ''} onChange={(event) => changeTaskType(task.id, event.target.value)}>{TASK_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{!known ? <option value="">{meta.label}</option> : null}</select></label><FtbFieldRow schema={{ key: 'title', label: '标题', kind: 'text', placeholder: '留空使用游戏默认标题' }} value={task.raw.title} onChange={(next) => setTaskField(task.id, 'title', next)} />{meta.fields.map((field) => <FtbFieldRow key={field.key} schema={field} value={task.raw[field.key]} onChange={(next) => setTaskField(task.id, field.key, next)} />)}</div> : null}</div> })}</div>
                  </div>
                  <div className="ftb-quest-book-divider" />
                  <div className="ftb-quest-book-column">
                    <div className="ftb-quest-book-col-title"><span>奖励</span><small>Rewards</small><select value="" aria-label="添加奖励" onChange={(event) => { if (event.target.value) addReward(event.target.value); event.target.value = '' }}><option value="">＋ 添加</option>{REWARD_TYPES.map((meta) => <option key={meta.value} value={meta.value}>{meta.label}</option>)}</select></div>
                    <div className="ftb-quest-book-tiles">{selectedQuest.rewards.map((reward) => { const meta = typeMeta(REWARD_TYPES, reward.type); const known = REWARD_TYPES.some((entry) => entry.value === reward.type); const rewardItemId = resourceId(reward.raw.item); return <div className={`ftb-quest-book-tile ${expandedRewardId === reward.id ? 'expanded' : ''}`} key={reward.id}><button className="ftb-quest-book-tile-btn" onClick={() => setExpandedRewardId(expandedRewardId === reward.id ? '' : reward.id)}><span className="ftb-quest-type-glyph reward" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{reward.title ? renderColoredText(reward.title) : <FtbItemLabel itemId={rewardItemId} mcVersion={project.minecraftVersion} fallback={rewardItemId} />}</span><span className="ftb-quest-book-tile-del" title="删除奖励" onClick={(event) => { event.stopPropagation(); removeReward(reward.id) }}><Trash2 size={12} /></span></button>{expandedRewardId === reward.id ? <div className="ftb-quest-book-tile-fields"><label className="ftb-quest-book-type"><span>类型</span><select value={known ? reward.type : ''} onChange={(event) => changeRewardType(reward.id, event.target.value)}>{REWARD_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{!known ? <option value="">{meta.label}</option> : null}</select></label><FtbFieldRow schema={{ key: 'title', label: '标题', kind: 'text', placeholder: '留空使用游戏默认标题' }} value={reward.raw.title} onChange={(next) => setRewardField(reward.id, 'title', next)} />{meta.fields.map((field) => field.key === 'table_id' ? <label key={field.key} className="ftb-quest-field">{field.label}<select value={asText(reward.raw.table_id)} onChange={(event) => setRewardField(reward.id, 'table_id', event.target.value === '' ? undefined : event.target.value)}><option value="">选择奖励表…</option>{rewardTables.map((table) => <option key={table.id} value={rewardTableIdValue(table)}>{table.title}</option>)}</select></label> : <FtbFieldRow key={field.key} schema={field} value={reward.raw[field.key]} onChange={(next) => setRewardField(reward.id, field.key, next)} />)}</div> : null}</div> })}</div>
                  </div>
                </div>
                <div className="ftb-quest-book-rule" />
                <div className="ftb-quest-book-footer"><input className="ftb-quest-book-subtitle" aria-label="任务副标题" value={selectedQuest.subtitle} placeholder="副标题" onChange={(event) => updateQuest(selectedQuest.id, { subtitle: event.target.value })} /><textarea className="ftb-quest-book-desc" aria-label="任务描述" value={selectedQuest.description} placeholder="输入任务描述…" onChange={(event) => updateQuest(selectedQuest.id, { description: event.target.value })} /></div>
                <details className="ftb-quest-advanced"><summary><Settings2 size={14} />任务设置（图标 / 形状 / 前置 / 解锁）</summary><div className="ftb-quest-settings-body"><label className="field-label">图标<input value={selectedQuest.icon} placeholder="minecraft:book" onChange={(event) => updateQuest(selectedQuest.id, { icon: event.target.value })} /></label><label className="field-label">形状<select value={selectedQuest.shape} onChange={(event) => updateQuest(selectedQuest.id, { shape: event.target.value })}><option value="circle">圆形</option><option value="square">方形</option><option value="rsquare">圆角方形</option><option value="diamond">菱形</option><option value="octagon">八边形</option><option value="hexagon">六边形</option><option value="pentagon">五边形</option><option value="heart">心形</option><option value="gear">齿轮</option><option value="none">无</option>{!['circle', 'square', 'rsquare', 'diamond', 'octagon', 'hexagon', 'pentagon', 'heart', 'gear', 'none'].includes(selectedQuest.shape) ? <option value={selectedQuest.shape}>{selectedQuest.shape}</option> : null}</select></label><div className="ftb-quest-section-title"><span>前置任务</span></div><div className="ftb-quest-dependencies">{selectedQuest.dependencies.map((dependency) => { const object = dependencyObjects.get(dependency); return <span key={dependency}><button title="定位前置对象" onClick={() => { if (object?.questId) chooseQuest(object.questId) }}>{object ? `${object.title}（${object.owner}）` : `未知对象：${dependency}`}</button><button className="icon-button" title="移除前置任务" onClick={() => updateQuest(selectedQuest.id, { dependencies: selectedQuest.dependencies.filter((item) => item !== dependency) })}><Unlink size={12} /></button></span> })}<select value="" aria-label="添加前置任务" onChange={(event) => { if (event.target.value) updateQuest(selectedQuest.id, { dependencies: [...selectedQuest.dependencies, event.target.value] }); event.target.value = '' }}><option value="">添加前置任务…</option>{book?.chapters.map((item) => <optgroup label={item.title} key={item.id}>{item.quests.filter((quest) => quest.id !== selectedQuest.id && !selectedQuest.dependencies.includes(quest.id)).map((quest) => <option value={quest.id} key={quest.id}>{quest.title}</option>)}</optgroup>)}</select></div><label className="field-label">最少完成前置数<small>留空表示需要完成全部前置任务</small><input type="number" min={0} value={selectedQuest.minRequiredTasks ?? ''} placeholder="全部" onChange={(event) => updateQuest(selectedQuest.id, { minRequiredTasks: event.target.value === '' ? undefined : Math.max(0, Math.trunc(Number(event.target.value) || 0)) })} /></label><label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={Boolean(selectedQuest.hideDependencyLines)} onChange={(event) => updateQuest(selectedQuest.id, { hideDependencyLines: event.target.checked })} />隐藏依赖连线（游戏中以图标显示依赖）</label></div></details>
                <details className="ftb-quest-advanced"><summary><Settings2 size={14} />高级字段（JSON）</summary><textarea value={rawValue} onChange={(event) => setRawValue(event.target.value)} /><button className="secondary-button compact" onClick={applyRaw}>应用 JSON 字段</button></details>
              </div>
            ) : (
              <div ref={questDialog} className="dialog ftb-quest-book" role="dialog" aria-label="任务详情" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
                <div className="ftb-quest-book-head">
                  <div className="ftb-quest-book-actions"><button className="icon-button" title="关闭" onClick={() => { setSelectedQuestId(''); setSelectedEdgeId('') }}><X size={16} /></button></div>
                  <div className="ftb-quest-book-edge-title">前置关系</div>
                </div>
                <p className="ftb-quest-book-edge-info">这条连线表示目标任务必须在来源任务完成后才能解锁。</p>
                <button className="secondary-button compact" onClick={removeSelectedEdge}><Unlink size={14} />删除这条前置关系</button>
              </div>
            )}
          </div>
        ) : null}
    {/* 奖励表管理弹层：列表（游戏 RewardTablesScreen）→ 编辑（游戏 EditRewardTableScreen）。 */}
    {showRewardTables ? (
      <div className="modal-backdrop ftb-quest-book-overlay" role="presentation" onMouseDown={() => { setShowRewardTables(false); setEditingRewardTableId('') }}>
        <div ref={tableDialog} className="dialog ftb-quest-book ftb-reward-tables" role="dialog" aria-label="奖励表" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
          <div className="ftb-quest-book-head">
            <div className="ftb-quest-book-nav">{editingRewardTable ? <button className="icon-button" title="返回列表" onClick={() => setEditingRewardTableId('')}><ChevronLeft size={15} /></button> : null}</div>
            <div className="ftb-quest-book-actions">
              {!editingRewardTable ? <button className="icon-button" title="新建奖励表" disabled={!book} onClick={createRewardTable}><CirclePlus size={15} /></button> : null}
              <button className="icon-button" title="关闭" onClick={() => { setShowRewardTables(false); setEditingRewardTableId('') }}><X size={16} /></button>
            </div>
            <div className="ftb-quest-book-edge-title">{editingRewardTable ? renderColoredText(editingRewardTable.title) : `奖励表（${rewardTables.length}）`}</div>
          </div>
          {editingRewardTable ? (() => {
            const table = editingRewardTable
            const knownTypes = REWARD_TYPES.map((meta) => meta.value)
            const crate = table.lootCrate
            return <>
              <div className="ftb-rt-meta">
                <label className="field-label">标题<input value={table.title} onChange={(event) => updateRewardTable(table.id, { title: event.target.value })} /></label>
                <label className="field-label">文件名<small>保存为 reward_tables/{table.filename}.{book?.format === 'json5' ? 'json5' : 'snbt'}</small><input value={table.filename} onChange={(event) => updateRewardTable(table.id, { filename: event.target.value.trim() })} /></label>
                <label className="field-label">空结果权重<small>≥1 时可能抽不到奖励</small><input type="number" min={0} step="0.5" value={table.emptyWeight} onChange={(event) => updateRewardTable(table.id, { emptyWeight: Math.max(0, Number(event.target.value) || 0) })} /></label>
                <label className="field-label">每次抽取数量<input type="number" min={1} step={1} value={table.lootSize} onChange={(event) => updateRewardTable(table.id, { lootSize: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })} /></label>
                <label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={table.hideTooltip} onChange={(event) => updateRewardTable(table.id, { hideTooltip: event.target.checked })} />隐藏任务提示中的表内容</label>
                <label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={table.useTitle} onChange={(event) => updateRewardTable(table.id, { useTitle: event.target.checked })} />用表标题作为奖励名</label>
              </div>
              <details className="ftb-quest-advanced" open={Boolean(crate)}><summary><Settings2 size={14} />战利品箱物品（loot crate）</summary><div className="ftb-quest-settings-body">
                <label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={Boolean(crate)} onChange={(event) => updateRewardTable(table.id, { lootCrate: event.target.checked ? { stringId: '', itemName: '', color: 0xFFFFFF, glow: false, passive: 0, monster: 0, boss: 0 } : null })} />启用（生成可掉落的战利品箱物品）</label>
                {crate ? <>
                  <label className="field-label">物品 ID 后缀<small>如 common → ftbquests:common_crate</small><input value={crate.stringId} placeholder="common" onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, stringId: event.target.value.trim().toLowerCase() } })} /></label>
                  <label className="field-label">物品名称<input value={crate.itemName} placeholder="留空使用默认翻译" onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, itemName: event.target.value } })} /></label>
                  <label className="field-label">颜色（RGB 十进制）<input type="number" value={crate.color} onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, color: Number(event.target.value) || 0 } })} /></label>
                  <label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={crate.glow} onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, glow: event.target.checked } })} />附魔光效</label>
                  <div className="ftb-rt-drops">
                    <label className="field-label">被动生物掉落权重<input type="number" min={0} step="0.5" value={crate.passive} onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, passive: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                    <label className="field-label">怪物掉落权重<input type="number" min={0} step="0.5" value={crate.monster} onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, monster: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                    <label className="field-label">Boss 掉落权重<input type="number" min={0} step="0.5" value={crate.boss} onChange={(event) => updateRewardTable(table.id, { lootCrate: { ...crate, boss: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                  </div>
                </> : null}
              </div></details>
              <div className="ftb-quest-book-col-title"><span>奖励条目</span><small>weighted rewards</small><select value="" aria-label="添加奖励条目" onChange={(event) => { if (event.target.value) addRewardTableEntry(table.id, event.target.value); event.target.value = '' }}><option value="">＋ 添加</option>{REWARD_TYPES.map((meta) => <option key={meta.value} value={meta.value}>{meta.label}</option>)}</select></div>
              <div className="ftb-quest-book-tiles">{table.rewards.map((entry) => {
                const meta = typeMeta(REWARD_TYPES, entry.type)
                const known = knownTypes.includes(entry.type)
                return <div className="ftb-quest-book-tile" key={entry.id}>
                  <button className="ftb-quest-book-tile-btn"><span className="ftb-quest-type-glyph reward" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{entry.title ? renderColoredText(entry.title) : <FtbItemLabel itemId={resourceId(entry.raw.item)} mcVersion={project.minecraftVersion} fallback={resourceId(entry.raw.item)} />}</span><label className="ftb-rt-weight" title="抽取权重" onClick={(event) => event.stopPropagation()}>权重<input type="number" min={0} step="0.5" value={entry.weight} onChange={(event) => setRewardTableEntryWeight(table.id, entry.id, Math.max(0, Number(event.target.value) || 0))} /></label><span className="ftb-quest-book-tile-del" title="删除条目" onClick={(event) => { event.stopPropagation(); removeRewardTableEntry(table.id, entry.id) }}><Trash2 size={12} /></span></button>
                  <div className="ftb-quest-book-tile-fields">
                    <label className="ftb-quest-book-type"><span>类型</span><select value={known ? entry.type : ''} onChange={(event) => changeRewardTableEntryType(table.id, entry.id, event.target.value)}>{REWARD_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{!known ? <option value="">{meta.label}</option> : null}</select></label>
                    <FtbFieldRow schema={{ key: 'title', label: '标题', kind: 'text', placeholder: '留空使用游戏默认标题' }} value={entry.raw.title} onChange={(next) => setRewardTableEntryField(table.id, entry.id, 'title', next)} />
                    {meta.fields.map((field) => <FtbFieldRow key={field.key} schema={field} value={entry.raw[field.key]} onChange={(next) => setRewardTableEntryField(table.id, entry.id, field.key, next)} />)}
                  </div>
                </div>
              })}</div>
              <button className="secondary-button compact" onClick={() => void deleteRewardTable(table.id)}><Trash2 size={13} />删除此奖励表</button>
            </>
          })() : <div className="ftb-rt-list">
            {rewardTables.length ? rewardTables.map((table) => <button key={table.id} className="ftb-rt-row" onClick={() => setEditingRewardTableId(table.id)}><span className="ftb-rt-row-icon" style={{ background: `#${(table.lootCrate?.color ?? 0xFFFFFF).toString(16).padStart(6, '0')}` }} /><span className="ftb-rt-row-title"><strong>{renderColoredText(table.title)}</strong><small>{table.filename} · {table.rewards.length} 个条目{table.lootCrate ? ' · 战利品箱' : ''}</small></span><ChevronRight size={14} /></button>) : <p className="ftb-rt-empty">还没有奖励表。点击右上角 ＋ 新建一个；任务的"随机奖励表 / 多选一 / 全量奖励表"类型会引用这里的表。</p>}
          </div>}
        </div>
      </div>
    ) : null}
    {ctxMenu ? createPortal(<>
      <div className="ftb-ctx-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(event) => { event.preventDefault(); setCtxMenu(null) }} onWheel={() => setCtxMenu(null)} />
      {ctxMenu.kind === 'pane' ? (() => {
        // 与游戏 QuestPanel#mousePressed（右键空白处）一致：列出所有任务条件类型，选择后在该位置创建带该条件的新任务。
        return <div ref={ctxMenuRef} className="ftb-ctx-menu" style={{ left: ctxMenuPosition.left, top: ctxMenuPosition.top }} onMouseDown={(event) => event.stopPropagation()}>
          {TASK_TYPES.map((meta) => <button key={meta.value} disabled={!chapter} onClick={() => { const position = flowRef.current?.screenToFlowPosition({ x: ctxMenu.x, y: ctxMenu.y }); setCtxMenu(null); if (position) createQuestAt(position, meta.value) }}>{meta.label}</button>)}
          <div className="ftb-ctx-sep" />
          <button onClick={() => { setCtxMenu(null); flowRef.current?.fitView({ duration: 180, padding: 0.18, maxZoom: 1.15 }) }}>适应视图</button>
        </div>
      })() : (() => {
        const ctxQuest = ctxMenu.questId ? chapter?.quests.find((item) => item.id === ctxMenu.questId) : null
        const ctxSelectedQuest = selectedQuestId ? chapter?.quests.find((item) => item.id === selectedQuestId) : null
        if (!ctxQuest) return null
        return <div ref={ctxMenuRef} className="ftb-ctx-menu" style={{ left: ctxMenuPosition.left, top: ctxMenuPosition.top }} onMouseDown={(event) => event.stopPropagation()}>
          <button onClick={() => { chooseQuest(ctxQuest.id); setCtxMenu(null) }}>打开任务详情</button>
          <button disabled={!ctxSelectedQuest || ctxSelectedQuest.id === ctxQuest.id || ctxQuest.dependencies.includes(ctxSelectedQuest.id)} title={ctxSelectedQuest ? `让“${ctxSelectedQuest.title}”成为此任务的前置` : '先单击选中另一个任务'} onClick={() => { if (ctxSelectedQuest) addDependency(ctxSelectedQuest.id, ctxQuest.id); setCtxMenu(null) }}>添加前置：选中任务 → 此任务</button>
          <button disabled={!ctxSelectedQuest || ctxSelectedQuest.id === ctxQuest.id || ctxSelectedQuest.dependencies.includes(ctxQuest.id)} title={ctxSelectedQuest ? `让此任务成为“${ctxSelectedQuest.title}”的前置` : '先单击选中另一个任务'} onClick={() => { if (ctxSelectedQuest) addDependency(ctxQuest.id, ctxSelectedQuest.id); setCtxMenu(null) }}>添加前置：此任务 → 选中任务</button>
          <div className="ftb-ctx-sep" />
          <button onClick={() => { setCtxMenu(null); duplicateQuestById(ctxQuest.id) }}>复制任务</button>
          <button onClick={() => { setCtxMenu(null); void deleteQuestById(ctxQuest.id) }}>删除任务</button>
        </div>
      })()}
    </>, document.body) : null}
    <footer className={`ftb-quest-message ${errors.length ? 'error' : ''}`}>{errors.length ? <AlertTriangle size={14} /> : <PackageOpen size={14} />}<span>{errors.length ? errors.map((item) => item.message).join('；') : message}</span></footer>
    {dialog}
  </div></FtbResources.Provider>
}
