import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { addEdge, Background, BaseEdge, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, useStore, type Connection, type Edge, type EdgeMouseHandler, type EdgeProps, type Node, type NodeChange, type NodeMouseHandler, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, BookOpen, ChevronLeft, ChevronRight, CirclePlus, ClipboardCheck, FileCode2, FilePlus2, FolderTree, Gift, LoaderCircle, PackageOpen, Plus, Redo2, RotateCw, Save, Settings2, Trash2, Undo2, Unlink, X } from 'lucide-react'
import type { FtbQuestBook, FtbQuestDocumentChapter, FtbQuestDocumentQuest, FtbQuestIconResult, FtbQuestRewardDocument, FtbQuestRewardTable, FtbQuestShapeSet, FtbQuestTaskDocument, ProjectInfo } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

type QuestNodeData = { title: string; subtitle: string; icon: string; iconFallback: string[]; shape: string; tasks: number; rewards: number; mcVersion: string }
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
// 任务节点形状（取自 ftbquests 模组 jar textures/shapes/{id}/）的全局加载态。
const ftbShapesState: { map: Record<string, FtbQuestShapeSet> | null; started: boolean; listeners: Set<(map: Record<string, FtbQuestShapeSet> | null) => void> } = { map: null, started: false, listeners: new Set() }
function useFtbShapes(): Record<string, FtbQuestShapeSet> | null {
  const [map, setMap] = useState<Record<string, FtbQuestShapeSet> | null>(null)
  useEffect(() => {
    if (ftbShapesState.started) { setMap(ftbShapesState.map); return }
    ftbShapesState.started = true
    const handler = (next: Record<string, FtbQuestShapeSet> | null): void => setMap(next)
    ftbShapesState.listeners.add(handler)
    window.modmind.modpack.ftbQuestShapes().then((next) => {
      ftbShapesState.map = next
      ftbShapesState.listeners.forEach((listener) => listener(next))
    }).catch(() => {
      ftbShapesState.map = null
      ftbShapesState.listeners.forEach((listener) => listener(null))
    })
    return () => { ftbShapesState.listeners.delete(handler) }
  }, [])
  return map
}
// 主进程从 mod jar 解析出的物品图标缓存（targetId → 图标结果 | null）。
const ftbQuestIconCache = new Map<string, FtbQuestIconResult | null>()
// 依赖连线贴图 dependency.png（白色箭头，渲染端用主题色做遮罩染色）的全局加载态。
const ftbDepTextureState: { url: string | null; started: boolean; listeners: Set<(url: string | null) => void> } = { url: null, started: false, listeners: new Set() }
function useFtbDependencyTexture(): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (ftbDepTextureState.started) { setUrl(ftbDepTextureState.url); return }
    ftbDepTextureState.started = true
    const handler = (next: string | null): void => setUrl(next)
    ftbDepTextureState.listeners.add(handler)
    window.modmind.modpack.ftbDependencyTexture().then((next) => {
      ftbDepTextureState.url = next
      ftbDepTextureState.listeners.forEach((listener) => listener(next))
    }).catch(() => {
      ftbDepTextureState.url = null
      ftbDepTextureState.listeners.forEach((listener) => listener(null))
    })
    return () => { ftbDepTextureState.listeners.delete(handler) }
  }, [])
  return url
}

function newId(): string { return crypto.randomUUID().replaceAll('-', '').toUpperCase() }
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
  const objectForm = clean.match(/^\{\s*id\s*:\s*"([a-z0-9_.-]+:[a-z0-9_.-]+)"\s*,/i)
  if (objectForm) clean = objectForm[1]
  return clean.split(/[[({]/)[0]?.trim().toLowerCase() ?? clean.toLowerCase()
}

/** 解析物品/流体 ID（自动剥离 NBT）的显示名；未知返回 null。 */
function useFtbItemName(itemId: string, mcVersion: string): string | null {
  const clean = cleanItemId(itemId)
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!clean) { setName(null); return }
    const cached = ftbItemNameCache.get(clean)
    if (cached !== undefined) { setName(cached); return }
    const [namespace = 'minecraft', ...rest] = clean.split(':')
    const shortName = rest.join(':')
    const resolve = namespace === 'minecraft'
      ? vanillaLang(mcVersion).then((lang) => lang[`item.minecraft.${shortName}`] ?? lang[`block.minecraft.${shortName}`] ?? null)
      : window.modmind.modpack.ftbQuestItemNames([clean]).then((map) => map[clean] ?? null)
    let alive = true
    resolve.then((value) => { ftbItemNameCache.set(clean, value); if (alive) setName(value) })
      .catch(() => { ftbItemNameCache.set(clean, null); if (alive) setName(null) })
    return () => { alive = false }
  }, [clean, mcVersion])
  return name
}
/** Minecraft 颜色代码 &0-&f 的实际颜色（§ 变体同样支持）。 */
const MC_COLOR_CODES: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF'
}
/** 把语言文件名中的颜色/格式代码（&b、§5、&l…）渲染成带样式的节点，如 "&b钻石" → 青色"钻石"。 */
function renderColoredText(text: string): React.JSX.Element {
  const segments = text.split(/([§&][0-9a-fk-orx])/i).filter(Boolean)
  if (segments.length <= 1) return <>{text}</>
  let color = ''
  let bold = false
  let italic = false
  let underline = false
  let strike = false
  const parts: React.JSX.Element[] = []
  let buffer = ''
  const flush = (key: string): void => {
    if (buffer) parts.push(<span key={key} style={{ color: color || undefined, fontWeight: bold ? 700 : undefined, fontStyle: italic ? 'italic' : undefined, textDecoration: [underline ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined }}>{buffer}</span>)
    buffer = ''
  }
  segments.forEach((segment, index) => {
    const code = segment.match(/^[§&]([0-9a-fk-orx])$/i)?.[1]?.toLowerCase()
    if (!code) { buffer += segment; return }
    flush(`s${index}`)
    if (MC_COLOR_CODES[code]) { color = MC_COLOR_CODES[code]; bold = false; italic = false; underline = false; strike = false }
    else if (code === 'l') bold = true
    else if (code === 'o') italic = true
    else if (code === 'n') underline = true
    else if (code === 'm') strike = true
    else if (code === 'r') { color = ''; bold = false; italic = false; underline = false; strike = false }
  })
  flush('end')
  return <>{parts}</>
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
    { key: 'table_id', label: '奖励表 ID', kind: 'number' }
  ] },
  { value: 'random', label: '随机奖励表', fields: [
    { key: 'table_id', label: '奖励表 ID', kind: 'number' }
  ] },
  { value: 'all_table', label: '全量奖励表', fields: [
    { key: 'table_id', label: '奖励表 ID', kind: 'number' }
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

function defaultRaw(meta: FtbTypeMeta): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const field of meta.fields) if (field.default !== undefined) raw[field.key] = field.default
  return raw
}

/** 奖励表 ID（十六进制）→ 游戏 table_id 引用用的十进制整数。 */
function rewardTableNumericId(id: string): number {
  if (!/^[0-9A-Fa-f]+$/.test(id)) return NaN
  try { return Number(BigInt(`0x${id}`)) } catch { return NaN }
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
    id, title: explicitTitle || fallbackTitle, titleIsFallback: !explicitTitle, subtitle: asText(raw.subtitle), description: Array.isArray(raw.description) ? raw.description.map((entry) => asText(entry)).join('\n') : asText(raw.description), icon: asText(raw.icon), shape: asText(raw.shape, 'circle'), x: asNumber(raw.x), y: asNumber(raw.y),
    minRequiredTasks: raw.min_required_tasks === undefined ? undefined : asNumber(raw.min_required_tasks), hideDependencyLines: raw.hide_dependency_lines === undefined ? undefined : Boolean(raw.hide_dependency_lines),
    dependencies, tasks, rewards, raw
  }
}

function QuestFlowNode({ data }: { data: QuestNodeData }): React.JSX.Element {
  // 与游戏内一致：任务节点中央显示真实物品贴图（icon 为空时回退到提交物品任务的图标，取首个物品）。
  // 原版物品走 mcmeta 贴图（item → block 两级回退），模组物品由主进程从整合包 mod jar 中提取。
  // targetId 统一剥离 NBT（mod:item{...} → mod:item）：图标与名称解析都用基础 ID。
  const targetId = useMemo(() => (data.icon || data.iconFallback[0] || '').split('{')[0].trim(), [data.icon, data.iconFallback])
  const glyph = targetId.split(':').pop()?.replace(/_/g, ' ').trim() ?? ''
  const itemName = useFtbItemName(targetId, data.mcVersion)
  // 同一任务含多个不同物品时，在图标右下角显示数量角标（与游戏内任务节点叠堆风格一致）。
  const itemCount = data.iconFallback.length
  const modPart = useMemo(() => {
    const clean = targetId.split(/[[()]/)[0] ?? targetId
    const [namespace = 'minecraft', name = ''] = clean.split(':')
    return { namespace: namespace.trim().toLowerCase(), name: name.trim().toLowerCase() }
  }, [targetId])
  const sources = useMemo(() => {
    if (!modPart.name || modPart.namespace !== 'minecraft') return []
    // 与 vanillaLang 相同：mcmeta 版本标签需带 -assets 后缀（如 1.20.1-assets）。
    const base = `https://cdn.jsdelivr.net/gh/misode/mcmeta@${data.mcVersion}-assets/assets/minecraft/textures`
    return [`${base}/item/${modPart.name}.png`, `${base}/block/${modPart.name}.png`]
  }, [modPart, data.mcVersion])
  const [imageIndex, setImageIndex] = useState(0)
  useEffect(() => { setImageIndex(0) }, [sources[0]])
  const [modIcon, setModIcon] = useState<FtbQuestIconResult | null>(null)
  useEffect(() => {
    let alive = true
    if (!modPart.name || modPart.namespace === 'minecraft') { setModIcon(null); return }
    const cached = ftbQuestIconCache.get(targetId)
    if (cached !== undefined) { setModIcon(cached); return }
    window.modmind.modpack.ftbQuestIcon(targetId).then((result) => {
      ftbQuestIconCache.set(targetId, result)
      if (alive) setModIcon(result)
    }).catch(() => { ftbQuestIconCache.set(targetId, null); if (alive) setModIcon(null) })
    return () => { alive = false }
  }, [targetId, modPart.namespace, modPart.name])
  // 动画贴图渲染元数据：以整张精灵图做背景，每次 steps() 恰好前进一帧高，避免百分比下每步偏移不足一帧导致的滑动。
interface SpriteMeta { url: string; frameWidth: number; frameHeight: number; frameCount: number; frametimeMs: number }
function spriteTileStyle(meta: SpriteMeta): CSSProperties {
  const scale = Math.min(42 / meta.frameWidth, 42 / meta.frameHeight)
  const frameW = meta.frameWidth * scale
  const frameH = meta.frameHeight * scale
  const shift = (meta.frameCount - 1) * frameH
  const style: Record<string, string | number> = {
    width: frameW, height: frameH,
    backgroundImage: `url(${meta.url})`,
    backgroundSize: `${frameW}px ${frameH * meta.frameCount}px`,
    backgroundRepeat: 'no-repeat',
    '--fqi-shift': `-${shift}px`,
    animation: `ftb-quest-icon-flow ${meta.frametimeMs * meta.frameCount}ms steps(${meta.frameCount}) infinite`
  }
  return style as CSSProperties
}
/** 解析动画 mcmeta（与主进程规则一致：frames 缺省时帧数 = 高/宽）。 */
function parseSpriteMeta(raw: unknown, naturalWidth: number, naturalHeight: number): { frameCount: number; frametimeMs: number } | null {
  const animation = (raw && typeof raw === 'object' && 'animation' in raw ? (raw as { animation?: unknown }).animation : null)
  if (!animation || typeof animation !== 'object') return null
  const anim = animation as { frametime?: unknown; frames?: unknown }
  const frames = anim.frames
  const explicit = Array.isArray(frames) && frames.length > 1 ? frames.length : null
  const estimated = naturalWidth > 0 ? Math.floor(naturalHeight / naturalWidth) : 0
  const frameCount = explicit ?? (estimated > 1 ? estimated : 1)
  if (frameCount < 2 || naturalHeight % frameCount !== 0) return null
  const frametime = typeof anim.frametime === 'number' && Number.isFinite(anim.frametime) && anim.frametime > 0 ? anim.frametime : 1
  return { frameCount, frametimeMs: frametime * 50 }
}

  const imageSrc = modPart.namespace !== 'minecraft' ? modIcon?.url ?? null : sources[imageIndex]
  // 原版物品的动画：拉取贴图同名 .mcmeta，img 加载后按自然尺寸推算帧数并切换为精灵图播放。
  const [vanillaMeta, setVanillaMeta] = useState<unknown>(null)
  const [vanillaSprite, setVanillaSprite] = useState<SpriteMeta | null>(null)
  useEffect(() => {
    let alive = true
    setVanillaSprite(null)
    if (modPart.namespace !== 'minecraft' || imageIndex >= sources.length) { setVanillaMeta(null); return }
    const metaUrl = `${sources[imageIndex]}.mcmeta`
    fetch(metaUrl, { mode: 'cors' }).then((response) => response.ok ? response.json() : null).then((json) => { if (alive) setVanillaMeta(json) }).catch(() => { if (alive) setVanillaMeta(null) })
    return () => { alive = false }
  }, [modPart.namespace, sources, imageIndex])
  const animatedSprite: SpriteMeta | null = useMemo<SpriteMeta | null>(() => {
    if (modPart.namespace !== 'minecraft') {
      if (!modIcon?.animated || modIcon.frameCount < 2 || modIcon.frameHeight <= 0) return null
      return { url: modIcon.url, frameWidth: modIcon.frameWidth, frameHeight: modIcon.frameHeight, frameCount: modIcon.frameCount, frametimeMs: modIcon.frametimeMs }
    }
    return vanillaSprite
  }, [modPart.namespace, modIcon, vanillaSprite])
  // 模组图标走主进程数据；原版动画需在 img onLoad 拿到自然尺寸后推算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const animatedStyle = useMemo<CSSProperties | null>(() => (animatedSprite ? spriteTileStyle(animatedSprite) : null), [animatedSprite])
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
    <div className="ftb-quest-tile">{imageSrc ? (animatedStyle ? <div className="ftb-quest-tile-img animated" style={animatedStyle} /> : <img className="ftb-quest-tile-img" src={imageSrc} alt="" draggable={false} onLoad={(event) => { if (modPart.namespace === 'minecraft' && vanillaMeta) { const meta = parseSpriteMeta(vanillaMeta, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight); setVanillaSprite(meta ? { url: event.currentTarget.src, frameWidth: event.currentTarget.naturalWidth, frameHeight: event.currentTarget.naturalHeight / meta.frameCount, ...meta } : null) } }} onError={() => { if (modPart.namespace !== 'minecraft') { ftbQuestIconCache.set(targetId, null); setModIcon(null) } else { setVanillaSprite(null); setVanillaMeta(null); setImageIndex((current) => Math.min(current + 1, sources.length)) } }} />) : <span title={targetId}>{itemName ? renderColoredText(itemName) : glyph || '?'}</span>}{itemCount > 1 ? <span className="ftb-quest-tile-count">{itemCount > 99 ? '99+' : itemCount}</span> : null}</div>
    <div className="ftb-quest-node-tooltip"><strong>{data.title}</strong>{data.subtitle ? <small>{data.subtitle}</small> : null}{data.tasks || data.rewards ? <em>{data.tasks} 个条件 · {data.rewards} 个奖励</em> : null}</div>
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
function questIconFallback(quest: FtbQuestDocumentQuest): string[] {
  const icons: string[] = []
  for (const task of quest.tasks) {
    const raw = asRecord(task.raw)
    // 带 NBT 的物品 ID（mod:item{...}）只取 { 前的基础 ID 用于图标与名称解析。
    if (task.type === 'item') { const item = asText(raw.item).split('{')[0].trim(); if (item) icons.push(item) }
    if (task.type === 'fluid') { const fluid = asText(raw.fluid).split('{')[0].trim(); if (fluid) icons.push(fluid) }
  }
  return icons
}

function questNodes(chapter: FtbQuestDocumentChapter | undefined, mcVersion: string): QuestNode[] {
  return (chapter?.quests ?? []).map((quest) => ({ id: quest.id, type: 'quest', position: { x: quest.x * QUEST_GRID_X, y: quest.y * QUEST_GRID_Y }, data: { title: quest.title, subtitle: quest.subtitle, icon: quest.icon, iconFallback: questIconFallback(quest), shape: quest.shape, tasks: quest.tasks.length, rewards: quest.rewards.length, mcVersion } }))
}

function questEdges(chapter: FtbQuestDocumentChapter | undefined): QuestEdge[] {
  const local = new Set((chapter?.quests ?? []).map((quest) => quest.id))
  const positions = new Map((chapter?.quests ?? []).map((quest) => [quest.id, { x: quest.x * QUEST_GRID_X, y: quest.y * QUEST_GRID_Y }]))
  // 与游戏 drawOffsetBackground 一致：设置了 hide_dependency_lines 的任务不画依赖线。
  const edges: QuestEdge[] = (chapter?.quests ?? []).filter((quest) => !quest.hideDependencyLines).flatMap((quest) => quest.dependencies.filter((dependency) => local.has(dependency)).map((dependency): QuestEdge => ({ id: `${dependency}:${quest.id}`, source: dependency, target: quest.id, type: 'questRoute', style: { stroke: QUEST_EDGE_COLOR, strokeWidth: 2 }, ...directionalHandles(positions.get(dependency) ?? { x: 0, y: 0 }, positions.get(quest.id) ?? { x: 0, y: 0 }) })))
  return edges
}

export default function FtbQuestEditor({ project }: { project: ProjectInfo }): React.JSX.Element {
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
  const undoStack = useRef<FtbQuestBook[]>([])
  const redoStack = useRef<FtbQuestBook[]>([])
  const [, setHistoryVersion] = useState(0)

  const chapter = book?.chapters.find((item) => item.id === selectedChapterId) ?? book?.chapters[0]
  const selectedQuest = chapter?.quests.find((item) => item.id === selectedQuestId) ?? chapter?.quests[0]
  const diagnostics = book?.diagnostics ?? []
  const errors = diagnostics.filter((item) => item.severity === 'error')
  const onQuestNodesChange = useCallback((changes: NodeChange<QuestNode>[]): void => onNodesChange(changes.filter((change) => change.type !== 'remove')), [onNodesChange])

  const syncCanvas = useCallback((nextChapter: FtbQuestDocumentChapter | undefined): void => {
    setNodes(questNodes(nextChapter, project.minecraftVersion)); setEdges(questEdges(nextChapter)); setSelectedEdgeId('')
    window.requestAnimationFrame(() => flowRef.current?.fitView({ duration: 180, padding: 0.18, maxZoom: 1.15 }))
  }, [project.minecraftVersion, setEdges, setNodes])

  const load = useCallback(async (): Promise<void> => {
    setBusy('load')
    try {
      const next = await window.modmind.modpack.readFtbQuestBook()
      setBook(next)
      undoStack.current = []; redoStack.current = []; setHistoryVersion((current) => current + 1)
      const nextChapter = next.chapters.find((item) => item.id === selectedChapterIdRef.current) ?? next.chapters[0]
      selectedChapterIdRef.current = nextChapter?.id ?? ''
      setSelectedChapterId(selectedChapterIdRef.current)
      setSelectedQuestId('')
      syncCanvas(nextChapter)
      setMessage(next.chapters.length ? `已载入 ${next.chapters.length} 个章节` : '未发现任务章节，可以从这里创建第一章')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }, [syncCanvas])

  useEffect(() => { void load() }, [load, project.path])
  // 预取：书加载后一次性批量解析全书中模组物品的中文名，写入全局缓存；
  // 避免每个任务/奖励/节点块各自发一次 IPC（首次还会并发触发主进程扫描全部 mod jar，造成卡顿）。
  const itemNamesPreloadKey = useRef('')
  useEffect(() => {
    if (!book) return
    const ids = new Set<string>()
    const add = (rawId: string): void => { const clean = cleanItemId(rawId); if (clean && !clean.startsWith('minecraft:')) ids.add(clean) }
    for (const ch of book.chapters) for (const q of ch.quests) {
      if (q.icon) add(q.icon)
      for (const t of q.tasks) { const raw = asRecord(t.raw); add(asText(raw.item)); add(asText(raw.fluid)) }
      for (const rw of q.rewards) add(asText(asRecord(rw.raw).item))
    }
    for (const table of book.rewardTables ?? []) for (const entry of table.rewards) add(asText(asRecord(entry.raw).item))
    const key = [...ids].sort().join('|')
    if (itemNamesPreloadKey.current === key) return
    itemNamesPreloadKey.current = key
    const pending = [...ids].filter((id) => !ftbItemNameCache.has(id))
    if (!pending.length) return
    window.modmind.modpack.ftbQuestItemNames(pending).then((map) => { for (const [id, name] of Object.entries(map)) ftbItemNameCache.set(id, name) }).catch(() => { /* 离线/扫描失败时保持 ID 兜底显示 */ })
  }, [book])
  useEffect(() => { if (selectedQuest) setRawValue(formatRaw(selectedQuest.raw)) }, [selectedQuest?.id])
  useEffect(() => { setNodes(questNodes(chapter, project.minecraftVersion)); setEdges(questEdges(chapter)) }, [chapter, project.minecraftVersion, setEdges, setNodes])

  const updateBook = (recipe: (current: FtbQuestBook) => FtbQuestBook): void => {
    if (!book) return
    const next = recipe(book)
    undoStack.current = [...undoStack.current, book].slice(-80)
    redoStack.current = []
    setHistoryVersion((current) => current + 1)
    setBook(next)
  }
  const undo = (): void => {
    if (!book) return
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(book); setBook(previous); setHistoryVersion((current) => current + 1); setMessage('已撤销上一步编辑')
  }
  const redo = (): void => {
    if (!book) return
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(book); setBook(next); setHistoryVersion((current) => current + 1); setMessage('已重做编辑')
  }
  const updateChapter = (id: string, patch: Partial<FtbQuestDocumentChapter>): void => updateBook((current) => ({ ...current, chapters: current.chapters.map((item) => item.id === id ? { ...item, ...patch } : item) }))
  const updateQuest = (questId: string, patch: Partial<FtbQuestDocumentQuest>): void => updateBook((current) => ({ ...current, chapters: current.chapters.map((item) => item.id !== chapter?.id ? item : { ...item, quests: item.quests.map((quest) => quest.id === questId ? { ...quest, ...patch } : quest) }) }))

  const chooseChapter = (id: string): void => {
    const next = book?.chapters.find((item) => item.id === id)
    selectedChapterIdRef.current = id
    setSelectedChapterId(id); setSelectedQuestId(''); syncCanvas(next)
  }
  const chooseQuest = (id: string): void => { setSelectedQuestId(id); setSelectedEdgeId('') }

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
    const quests = chapter.quests.filter((item) => item.id !== questId).map((item) => ({ ...item, dependencies: item.dependencies.filter((dependency) => dependency !== questId) }))
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
    const table: FtbQuestRewardTable = { id: newId(), filename: `table_${index}`, source: '', title: `新奖励表 ${index}`, useTitle: false, hideTooltip: false, emptyWeight: 0, lootSize: 1, lootCrate: null, rewards: [], raw: {} }
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
    updateRewardTables((list) => list.map((item) => item.id === tableId ? { ...item, rewards: item.rewards.map((entry) => entry.id === entryId ? { ...entry, type, raw: defaultRaw(meta) } : entry) } : item))
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
    for (const edge of deleted) if (edge.source && edge.target) {
      const target = chapter?.quests.find((item) => item.id === edge.target)
      if (target) updateQuest(target.id, { dependencies: target.dependencies.filter((dependency) => dependency !== edge.source) })
    }
  }, [chapter])
  // 与游戏一致：拖动后吸附到整数网格。
  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: QuestNode): void => updateQuest(node.id, { x: Math.round(node.position.x / QUEST_GRID_X), y: Math.round(node.position.y / QUEST_GRID_Y) }), [])
  const onNodeClick: NodeMouseHandler<QuestNode> = useCallback((_event, node) => chooseQuest(node.id), [])
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
    updateQuest(selectedQuest.id, { tasks: selectedQuest.tasks.map((item) => item.id !== taskId ? item : { ...item, type, raw: { ...raw, ...(item.raw.title !== undefined ? { title: item.raw.title } : {}), ...(item.raw.icon !== undefined ? { icon: item.raw.icon } : {}) } }) })
  }
  const changeRewardType = (rewardId: string, type: string): void => {
    if (!selectedQuest) return
    const raw = defaultRaw(typeMeta(REWARD_TYPES, type))
    updateQuest(selectedQuest.id, { rewards: selectedQuest.rewards.map((item) => item.id !== rewardId ? item : { ...item, type, raw: { ...raw, ...(item.raw.title !== undefined ? { title: item.raw.title } : {}), ...(item.raw.icon !== undefined ? { icon: item.raw.icon } : {}) } }) })
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
    try { const next = hydrateQuest(asRecord(JSON.parse(rawValue))); updateQuest(selectedQuest.id, next); setMessage('已应用高级字段') } catch (error) { setMessage(`高级字段无效：${error instanceof Error ? error.message : String(error)}`) }
  }
  const save = async (): Promise<void> => {
    if (!book) return
    setBusy('save')
    try {
      const result = await window.modmind.modpack.saveFtbQuestBook(book)
      setMessage(`已保存 ${result.written.length} 个文件${result.removed.length ? `，移除 ${result.removed.length} 个章节文件` : ''}`)
      await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }

  const sourceOptions = useMemo(() => chapter?.quests.filter((item) => item.id !== selectedQuest?.id) ?? [], [chapter?.quests, selectedQuest?.id])
  // 书页头部与游戏内 ViewQuestPanel 一致的前置/后续箭头：在本章节内找到第一个前置任务 / 依赖当前任务的任务
  const bookDependencyQuest = useMemo(() => chapter?.quests.find((item) => selectedQuest?.dependencies.includes(item.id)), [chapter, selectedQuest])
  const bookDependantQuest = useMemo(() => chapter?.quests.find((item) => item.dependencies.includes(selectedQuest?.id ?? '')), [chapter, selectedQuest])
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)

  return <div className="ftb-quest-editor">
    <header className="ftb-quest-toolbar content-toolbar"><div><h1>FTB 任务书</h1><p>章节、前置依赖、任务条件和奖励在同一张画布中编辑</p></div><div className="ftb-quest-toolbar-actions"><span className={`ftb-quest-health ${errors.length ? 'error' : ''}`}>{errors.length ? <AlertTriangle size={14} /> : <PackageOpen size={14} />}{errors.length ? `${errors.length} 个问题` : `${book?.chapters.length ?? 0} 个章节`}</span><button className="icon-button" title="撤销" aria-label="撤销" disabled={!undoStack.current.length || Boolean(busy)} onClick={undo}><Undo2 size={15} /></button><button className="icon-button" title="重做" aria-label="重做" disabled={!redoStack.current.length || Boolean(busy)} onClick={redo}><Redo2 size={15} /></button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => { setShowRewardTables(true); setEditingRewardTableId('') }}><Gift size={15} />奖励表{rewardTables.length ? `（${rewardTables.length}）` : ''}</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void load()}>{busy === 'load' ? <LoaderCircle className="spin" size={15} /> : <RotateCw size={15} />}重新加载</button><button className="primary-button" disabled={!book || Boolean(busy) || errors.length > 0} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存任务书</button></div></header>
    <div className="ftb-quest-layout">
      <aside className="ftb-quest-chapters"><div className="ftb-quest-panel-title"><span><FolderTree size={16} />章节</span><button className="icon-button" title="新建章节" onClick={createChapter} disabled={!book || Boolean(busy)}><FilePlus2 size={15} /></button></div><div className="ftb-quest-book-meta"><BookOpen size={14} /><span>{book?.format === 'json5' ? 'JSON5 任务书' : 'SNBT 任务书'}</span></div><div className="ftb-quest-chapter-list">{book?.chapters.map((item) => <button key={item.id} className={chapter?.id === item.id ? 'selected' : ''} onClick={() => chooseChapter(item.id)}><BookOpen size={15} /><span><strong>{item.title}</strong><small>{item.quests.length} 个任务</small></span><ChevronRight size={14} /></button>)}</div><button className="secondary-button compact ftb-quest-add-chapter" onClick={createChapter} disabled={!book}><Plus size={14} />新建章节</button></aside>
      <section className="ftb-quest-canvas-panel">
        <div className="ftb-quest-canvas-heading">
          <div>{chapter ? <><input aria-label="章节标题" value={chapter.title} onChange={(event) => updateChapter(chapter.id, { title: event.target.value })} /><span>{chapter.quests.length} 个任务</span></> : <span>选择或创建章节</span>}</div>
          <div><button className="icon-button" title="添加任务" disabled={!chapter} onClick={createQuest}><CirclePlus size={16} /></button><button className="icon-button" title="删除当前章节" disabled={!chapter} onClick={deleteChapter}><Trash2 size={15} /></button></div>
        </div>
        <div className="ftb-quest-canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ quest: QuestFlowNode }} edgeTypes={{ questRoute: RoutedQuestEdge }} onNodesChange={onQuestNodesChange} onEdgesChange={onEdgesChange} onEdgesDelete={onEdgesDelete} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick} onNodeMouseEnter={onNodeMouseEnter} onNodeMouseLeave={onNodeMouseLeave} onEdgeClick={onEdgeClick} onConnect={onConnect} onPaneClick={() => { setSelectedEdgeId(''); setCtxMenu(null); setEdges((current) => current.map((item) => ({ ...item, selected: false }))) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setCtxMenu({ kind: 'quest', x: event.clientX, y: event.clientY, questId: node.id }) }} onPaneContextMenu={(event) => { event.preventDefault(); setCtxMenu({ kind: 'pane', x: event.clientX, y: event.clientY }) }} onInit={(instance) => { flowRef.current = instance; syncCanvas(chapter) }} deleteKeyCode={['Backspace', 'Delete']} fitView><MiniMap pannable zoomable /><Controls /><Background gap={26} size={1.3} color="#3a3b42" /></ReactFlow>
          {!chapter?.quests.length ? <div className="ftb-quest-empty"><ClipboardCheck size={20} /><strong>此章节还没有任务</strong><button className="primary-button compact" onClick={createQuest}><Plus size={14} />添加第一个任务</button></div> : null}
        </div>
      </section>
      {/* 任务详情不再使用右侧固定栏；点击任务节点会在画布中央打开书页（与游戏内一致） */}
    </div>
    {selectedQuestId || selectedEdge ? (
          <div className="ftb-quest-book-overlay" onMouseDown={() => { setSelectedQuestId(''); setSelectedEdgeId(''); setExpandedTaskId(''); setExpandedRewardId('') }}>
            {selectedQuest ? (
              <div className="ftb-quest-book" onMouseDown={(event) => event.stopPropagation()}>
                <div className="ftb-quest-book-head">
                  <div className="ftb-quest-book-nav"><button className="icon-button" title="查看前置任务" disabled={!bookDependencyQuest} onClick={() => { if (bookDependencyQuest) setSelectedQuestId(bookDependencyQuest.id) }}><ChevronLeft size={15} /></button><button className="icon-button" title="查看后续任务" disabled={!bookDependantQuest} onClick={() => { if (bookDependantQuest) setSelectedQuestId(bookDependantQuest.id) }}><ChevronRight size={15} /></button></div>
                  <div className="ftb-quest-book-actions"><button className="icon-button" title="复制任务" onClick={duplicateQuest}><FileCode2 size={15} /></button>
                    <button className="icon-button" title="删除任务" onClick={() => void deleteQuest()}><Trash2 size={15} /></button>
                    <button className="icon-button" title="关闭" onClick={() => { setSelectedQuestId(''); setExpandedTaskId(''); setExpandedRewardId('') }}><X size={16} /></button>
                  </div>
                  <input className="ftb-quest-book-title" aria-label="任务标题" value={selectedQuest.title} placeholder="任务标题" onChange={(event) => updateQuest(selectedQuest.id, { title: event.target.value, titleIsFallback: false })} />
                </div>
                <div className="ftb-quest-book-columns">
                  <div className="ftb-quest-book-column">
                    <div className="ftb-quest-book-col-title"><span>任务</span><small>Tasks</small><select value="" aria-label="添加任务条件" onChange={(event) => { if (event.target.value) addTask(event.target.value); event.target.value = '' }}><option value="">＋ 添加</option>{TASK_TYPES.map((meta) => <option key={meta.value} value={meta.value}>{meta.label}</option>)}</select></div>
                    <div className="ftb-quest-book-tiles">{selectedQuest.tasks.map((task) => { const meta = typeMeta(TASK_TYPES, task.type); const known = TASK_TYPES.some((entry) => entry.value === task.type); return <div className={`ftb-quest-book-tile ${expandedTaskId === task.id ? 'expanded' : ''}`} key={task.id}><button className="ftb-quest-book-tile-btn" onClick={() => setExpandedTaskId(expandedTaskId === task.id ? '' : task.id)}><span className="ftb-quest-type-glyph" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{task.title || <FtbItemLabel itemId={asText(task.raw.item) || asText(task.raw.fluid)} mcVersion={project.minecraftVersion} fallback={asText(task.raw.item) || asText(task.raw.fluid)} />}</span><span className="ftb-quest-book-tile-del" title="删除条件" onClick={(event) => { event.stopPropagation(); removeTask(task.id) }}><Trash2 size={12} /></span></button>{expandedTaskId === task.id ? <div className="ftb-quest-book-tile-fields"><label className="ftb-quest-book-type"><span>类型</span><select value={known ? task.type : ''} onChange={(event) => changeTaskType(task.id, event.target.value)}>{TASK_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{!known ? <option value="">{meta.label}</option> : null}</select></label><FtbFieldRow schema={{ key: 'title', label: '标题', kind: 'text', placeholder: '留空使用游戏默认标题' }} value={task.raw.title} onChange={(next) => setTaskField(task.id, 'title', next)} />{meta.fields.map((field) => <FtbFieldRow key={field.key} schema={field} value={task.raw[field.key]} onChange={(next) => setTaskField(task.id, field.key, next)} />)}</div> : null}</div> })}</div>
                  </div>
                  <div className="ftb-quest-book-divider" />
                  <div className="ftb-quest-book-column">
                    <div className="ftb-quest-book-col-title"><span>奖励</span><small>Rewards</small><select value="" aria-label="添加奖励" onChange={(event) => { if (event.target.value) addReward(event.target.value); event.target.value = '' }}><option value="">＋ 添加</option>{REWARD_TYPES.map((meta) => <option key={meta.value} value={meta.value}>{meta.label}</option>)}</select></div>
                    <div className="ftb-quest-book-tiles">{selectedQuest.rewards.map((reward) => { const meta = typeMeta(REWARD_TYPES, reward.type); const known = REWARD_TYPES.some((entry) => entry.value === reward.type); return <div className={`ftb-quest-book-tile ${expandedRewardId === reward.id ? 'expanded' : ''}`} key={reward.id}><button className="ftb-quest-book-tile-btn" onClick={() => setExpandedRewardId(expandedRewardId === reward.id ? '' : reward.id)}><span className="ftb-quest-type-glyph reward" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{reward.title || <FtbItemLabel itemId={asText(reward.raw.item)} mcVersion={project.minecraftVersion} fallback={asText(reward.raw.item)} />}</span><span className="ftb-quest-book-tile-del" title="删除奖励" onClick={(event) => { event.stopPropagation(); removeReward(reward.id) }}><Trash2 size={12} /></span></button>{expandedRewardId === reward.id ? <div className="ftb-quest-book-tile-fields"><label className="ftb-quest-book-type"><span>类型</span><select value={known ? reward.type : ''} onChange={(event) => changeRewardType(reward.id, event.target.value)}>{REWARD_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{!known ? <option value="">{meta.label}</option> : null}</select></label><FtbFieldRow schema={{ key: 'title', label: '标题', kind: 'text', placeholder: '留空使用游戏默认标题' }} value={reward.raw.title} onChange={(next) => setRewardField(reward.id, 'title', next)} />{meta.fields.map((field) => field.key === 'table_id' ? <label key={field.key} className="ftb-quest-field">{field.label}<select value={asText(reward.raw.table_id)} onChange={(event) => setRewardField(reward.id, 'table_id', event.target.value === '' ? undefined : Number(event.target.value))}><option value="">选择奖励表…</option>{rewardTables.map((table) => <option key={table.id} value={rewardTableNumericId(table.id)}>{table.title}</option>)}</select></label> : <FtbFieldRow key={field.key} schema={field} value={reward.raw[field.key]} onChange={(next) => setRewardField(reward.id, field.key, next)} />)}</div> : null}</div> })}</div>
                  </div>
                </div>
                <div className="ftb-quest-book-rule" />
                <div className="ftb-quest-book-footer"><input className="ftb-quest-book-subtitle" aria-label="任务副标题" value={selectedQuest.subtitle} placeholder="副标题" onChange={(event) => updateQuest(selectedQuest.id, { subtitle: event.target.value })} /><textarea className="ftb-quest-book-desc" aria-label="任务描述" value={selectedQuest.description} placeholder="输入任务描述…" onChange={(event) => updateQuest(selectedQuest.id, { description: event.target.value })} /></div>
                <details className="ftb-quest-advanced"><summary><Settings2 size={14} />任务设置（图标 / 形状 / 前置 / 解锁）</summary><div className="ftb-quest-settings-body"><label className="field-label">图标<input value={selectedQuest.icon} placeholder="minecraft:book" onChange={(event) => updateQuest(selectedQuest.id, { icon: event.target.value })} /></label><label className="field-label">形状<select value={selectedQuest.shape} onChange={(event) => updateQuest(selectedQuest.id, { shape: event.target.value })}><option value="circle">圆形</option><option value="square">方形</option><option value="rsquare">圆角方形</option><option value="diamond">菱形</option><option value="octagon">八边形</option><option value="hexagon">六边形</option><option value="pentagon">五边形</option><option value="heart">心形</option><option value="gear">齿轮</option><option value="none">无</option>{!['circle', 'square', 'rsquare', 'diamond', 'octagon', 'hexagon', 'pentagon', 'heart', 'gear', 'none'].includes(selectedQuest.shape) ? <option value={selectedQuest.shape}>{selectedQuest.shape}</option> : null}</select></label><div className="ftb-quest-section-title"><span>前置任务</span></div><div className="ftb-quest-dependencies">{selectedQuest.dependencies.map((dependency) => <button key={dependency} title="移除前置任务" onClick={() => updateQuest(selectedQuest.id, { dependencies: selectedQuest.dependencies.filter((item) => item !== dependency) })}>{chapter?.quests.find((item) => item.id === dependency)?.title ?? dependency}<Unlink size={12} /></button>)}<select value="" aria-label="添加前置任务" onChange={(event) => { if (event.target.value) updateQuest(selectedQuest.id, { dependencies: [...selectedQuest.dependencies, event.target.value] }); event.target.value = '' }}><option value="">添加前置任务…</option>{sourceOptions.filter((item) => !selectedQuest.dependencies.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></div><label className="field-label">最少完成前置数<small>留空表示需要完成全部前置任务</small><input type="number" min={0} value={selectedQuest.minRequiredTasks ?? ''} placeholder="全部" onChange={(event) => updateQuest(selectedQuest.id, { minRequiredTasks: event.target.value === '' ? undefined : Math.max(0, Math.trunc(Number(event.target.value) || 0)) })} /></label><label className="field-label ftb-quest-checkbox"><input type="checkbox" checked={Boolean(selectedQuest.hideDependencyLines)} onChange={(event) => updateQuest(selectedQuest.id, { hideDependencyLines: event.target.checked })} />隐藏依赖连线（游戏中以图标显示依赖）</label></div></details>
                <details className="ftb-quest-advanced"><summary><Settings2 size={14} />高级字段（JSON）</summary><textarea value={rawValue} onChange={(event) => setRawValue(event.target.value)} /><button className="secondary-button compact" onClick={applyRaw}>应用 JSON 字段</button></details>
              </div>
            ) : (
              <div className="ftb-quest-book" onMouseDown={(event) => event.stopPropagation()}>
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
      <div className="ftb-quest-book-overlay" onMouseDown={() => { setShowRewardTables(false); setEditingRewardTableId('') }}>
        <div className="ftb-quest-book ftb-reward-tables" onMouseDown={(event) => event.stopPropagation()}>
          <div className="ftb-quest-book-head">
            <div className="ftb-quest-book-nav">{editingRewardTable ? <button className="icon-button" title="返回列表" onClick={() => setEditingRewardTableId('')}><ChevronLeft size={15} /></button> : null}</div>
            <div className="ftb-quest-book-actions">
              {!editingRewardTable ? <button className="icon-button" title="新建奖励表" disabled={!book} onClick={createRewardTable}><CirclePlus size={15} /></button> : null}
              <button className="icon-button" title="关闭" onClick={() => { setShowRewardTables(false); setEditingRewardTableId('') }}><X size={16} /></button>
            </div>
            <div className="ftb-quest-book-edge-title">{editingRewardTable ? editingRewardTable.title : `奖励表（${rewardTables.length}）`}</div>
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
                  <button className="ftb-quest-book-tile-btn"><span className="ftb-quest-type-glyph reward" aria-hidden>{meta.label.slice(0, 1)}</span><span className="ftb-quest-book-tile-label">{meta.label}</span><span className="ftb-quest-book-tile-title">{entry.title || <FtbItemLabel itemId={asText(entry.raw.item)} mcVersion={project.minecraftVersion} fallback={asText(entry.raw.item)} />}</span><label className="ftb-rt-weight" title="抽取权重" onClick={(event) => event.stopPropagation()}>权重<input type="number" min={0} step="0.5" value={entry.weight} onChange={(event) => setRewardTableEntryWeight(table.id, entry.id, Math.max(0, Number(event.target.value) || 0))} /></label><span className="ftb-quest-book-tile-del" title="删除条目" onClick={(event) => { event.stopPropagation(); removeRewardTableEntry(table.id, entry.id) }}><Trash2 size={12} /></span></button>
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
            {rewardTables.length ? rewardTables.map((table) => <button key={table.id} className="ftb-rt-row" onClick={() => setEditingRewardTableId(table.id)}><span className="ftb-rt-row-icon" style={{ background: `#${(table.lootCrate?.color ?? 0xFFFFFF).toString(16).padStart(6, '0')}` }} /><span className="ftb-rt-row-title"><strong>{table.title}</strong><small>{table.filename} · {table.rewards.length} 个条目{table.lootCrate ? ' · 战利品箱' : ''}</small></span><ChevronRight size={14} /></button>) : <p className="ftb-rt-empty">还没有奖励表。点击右上角 ＋ 新建一个；任务的"随机奖励表 / 多选一 / 全量奖励表"类型会引用这里的表。</p>}
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
  </div>
}
