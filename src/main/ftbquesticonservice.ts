import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { path7za } from '7zip-bin'
import type { FtbQuestIconResult, FtbQuestShapeSet, ProjectInfo } from '../shared/types'

const execFileAsync = promisify(execFile)
const LISTING_LIMIT = 64 * 1024 * 1024
const EXTRACT_LIMIT = 16 * 1024 * 1024

function executablePath(): string {
  // electron-builder places native binaries under app.asar.unpacked.
  return path7za.includes('app.asar') ? path7za.replace('app.asar', 'app.asar.unpacked') : path7za
}

function safeItemParts(itemId: string): { namespace: string; name: string } | null {
  // NBT 形式（mod:item{display:{...}} 或 {id:"mod:item",Count:...}）与容器形式（mod:item[..., ...]）都截到 { 或 [ 为止。
  let clean = itemId.trim()
  const objectForm = clean.match(/^\{\s*id\s*:\s*"([a-z0-9_.-]+:[a-z0-9_.-]+)"\s*,/i)
  if (objectForm) clean = objectForm[1]
  clean = clean.split(/[[({]/)[0]?.trim() ?? clean
  const [namespace, ...rest] = clean.split(':')
  const name = rest.join(':')
  if (!namespace || !name) return null
  if (!/^[a-z0-9_.-]+$/i.test(namespace) || !/^[a-z0-9_.-]+$/i.test(name)) return null
  return { namespace: namespace.toLowerCase(), name: name.toLowerCase() }
}

interface JarIndex {
  signature: string
  // 归一化资源路径（小写） → 所属 jar 文件
  textures: Map<string, string>
  models: Map<string, string>
}

async function collectJars(root: string, depth: number, output: string[]): Promise<void> {
  if (depth > 2) return
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) output.push(full)
    else if (entry.isDirectory() && !entry.name.startsWith('.')) await collectJars(full, depth + 1, output)
  }
}

function jarSignature(jars: string[]): string {
  return jars.join('|')
}

async function listJarEntries(jar: string): Promise<string[]> {
  try {
    const result = await execFileAsync(executablePath(), ['l', '-slt', '-sccUTF-8', jar], { windowsHide: true, maxBuffer: LISTING_LIMIT })
    const paths: string[] = []
    // -slt 输出的第一个块是归档本身（带 Type 字段），文件夹块带 Folder = +，均需跳过。
    for (const block of result.stdout.split(/\r?\n\r?\n/)) {
      const entryPath = block.match(/^Path = (.+)$/m)?.[1]?.trim()
      const folder = block.match(/^Folder = (.)$/m)?.[1]
      if (!entryPath || block.match(/^Type = /m) || (folder && folder !== '-')) continue
      paths.push(entryPath)
    }
    return paths
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to list jar with 7-Zip: ${detail}`)
  }
}

async function readJarEntry(jar: string, entryPath: string): Promise<Buffer> {
  try {
    const result = await execFileAsync(executablePath(), ['x', '-so', '-bd', '-sccUTF-8', jar, entryPath], { windowsHide: true, maxBuffer: EXTRACT_LIMIT, encoding: 'buffer' })
    return result.stdout as Buffer
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to extract jar entry with 7-Zip: ${detail}`)
  }
}

async function buildIndex(jars: string[], onProgress?: (processed: number, total: number) => void): Promise<JarIndex> {
  const textures = new Map<string, string>()
  const models = new Map<string, string>()
  for (let index = 0; index < jars.length; index += 1) {
    const jar = jars[index]
    onProgress?.(index + 1, jars.length)
    let entries: string[] = []
    try { entries = await listJarEntries(jar) } catch { continue }
    for (const raw of entries) {
      const entry = raw.toLowerCase().replaceAll('\\', '/')
      const match = entry.match(/^assets\/([a-z0-9_.-]+)\/(textures\/item\/.+\.png|textures\/block\/.+\.png|models\/item\/.+\.json)$/)
      if (!match) continue
      const target = match[0].startsWith('assets/') ? match[0] : entry
      if (match[2].startsWith('textures/')) { if (!textures.has(target)) textures.set(target, jar) }
      else if (!models.has(target)) models.set(target, jar)
    }
  }
  return { signature: jarSignature(jars), textures, models }
}

const indexCache = new Map<string, JarIndex>()
const building = new Map<string, Promise<JarIndex>>()

async function jarIndexFor(project: ProjectInfo): Promise<JarIndex> {
  const candidates = [path.join(project.path, 'mods'), path.join(project.path, 'overrides', 'mods')]
  const jars: string[] = []
  for (const candidate of candidates) await collectJars(candidate, 0, jars)
  const signature = jarSignature(jars)
  const cached = indexCache.get(project.path)
  if (cached && cached.signature === signature) return cached
  const inflight = building.get(project.path)
  if (inflight) return inflight
  const task = Promise.resolve().then(async () => {
    const index = await buildIndex(jars)
    indexCache.set(project.path, index)
    return index
  }).finally(() => building.delete(project.path))
  building.set(project.path, task)
  return task
}

function textureCandidates(namespace: string, name: string): string[] {
  return [
    `assets/${namespace}/textures/item/${name}.png`,
    `assets/${namespace}/textures/block/${name}.png`
  ]
}

/** 递归解析物品/方块模型，收集指向贴图的候选路径（含 parent 链，如 item → block 模型）。 */
async function collectModelTexturePaths(index: JarIndex, type: 'item' | 'block', namespace: string, name: string, visited: Set<string>, candidates: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  const modelPath = `assets/${namespace}/models/${type}/${name}.json`
  const key = modelPath.toLowerCase()
  if (visited.has(key) || depth === 6) return
  visited.add(key)
  const jar = index.models.get(key)
  if (!jar) return
  const raw = await readJarEntry(jar, modelPath).catch(() => Buffer.alloc(0))
  if (!raw.length) return
  let model: Record<string, unknown>
  try { model = JSON.parse(raw.toString('utf8')) as Record<string, unknown> } catch { return }
  const textures = model.textures
  if (textures && typeof textures === 'object' && !Array.isArray(textures)) {
    for (const value of Object.values(textures)) {
      if (typeof value !== 'string') continue
      const [ns = namespace, ...rest] = value.split(':')
      const texturePath = rest.join(':')
      if (!texturePath) continue
      candidates.push(`assets/${ns.toLowerCase()}/textures/${texturePath.toLowerCase()}.png`)
    }
  }
  const parent = model.parent
  if (typeof parent !== 'string') return
  const [parentNs = namespace, ...parentRest] = parent.split(':')
  const parentName = parentRest.join(':')
  if (!parentName) return
  const ns = parentNs.toLowerCase()
  if (ns === 'minecraft') return // 原版模型不含贴图资源，交给渲染端 mcmeta 兜底
  if (parentName.startsWith('block/')) await collectModelTexturePaths(index, 'block', ns, parentName.slice('block/'.length), visited, candidates, depth + 1)
  else if (parentName.startsWith('item/')) await collectModelTexturePaths(index, 'item', ns, parentName.slice('item/'.length), visited, candidates, depth + 1)
}

/** 从整合包 mod jar 中解析物品图标，返回贴图与动画元数据（无匹配返回 null）。 */
export async function resolveFtbQuestIcon(project: ProjectInfo, itemId: string): Promise<FtbQuestIconResult | null> {
  const parts = safeItemParts(itemId)
  if (!parts) return null
  const { namespace, name } = parts
  const index = await jarIndexFor(project)
  const visited = new Set<string>()

  const findTexture = (texturePath: string): string | null => {
    const key = texturePath.toLowerCase()
    if (visited.has(key)) return null
    visited.add(key)
    return index.textures.get(key) ?? null
  }

  const directCandidates = textureCandidates(namespace, name)
  for (const candidate of directCandidates) {
    const jar = findTexture(candidate)
    if (jar) {
      const result = await buildIconResult(jar, candidate)
      if (result) return result
    }
  }

  // 直接贴图路径（item/block）未命中时，通过 item 模型 + parent 链递归定位真实贴图。
  const candidates: string[] = []
  await collectModelTexturePaths(index, 'item', namespace, name, new Set<string>(), candidates)
  for (const candidate of candidates) {
    const jar = findTexture(candidate)
    if (jar) {
      const result = await buildIconResult(jar, candidate)
      if (result) return result
    }
  }
  return null
}

/** 直接解析 PNG 的 IHDR 块读取宽高（无需引入图像库）。 */
function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!buffer || buffer.length < 24) return null
  if (buffer.readUInt32BE(12) !== 0x49484452) return null // 'IHDR'
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 解析贴图同名的 .mcmeta 动画元数据；无动画返回 null。frames 为帧数（未显式列出时由调用方用 高/宽 推算）。 */
function readAnimationMeta(raw: string): { frames: number | null; frametimeMs: number } | null {
  let meta: { animation?: { frametime?: unknown; frames?: unknown } }
  try { meta = JSON.parse(raw) as typeof meta } catch { return null }
  const animation = meta?.animation
  if (!animation || typeof animation !== 'object') return null
  const frames = animation.frames
  const frameCount = Array.isArray(frames) && frames.length > 1 ? frames.length : null
  const frametime = typeof animation.frametime === 'number' && Number.isFinite(animation.frametime) && animation.frametime > 0 ? animation.frametime : 1
  // 原版动画帧时长单位：1 = 50ms。
  let frametimeMs = frametime * 50
  // 部分贴图 frames 数组每项为 {index, time}（逐帧时长），取平均作为统一帧时长。
  if (Array.isArray(frames) && frames.length > 1) {
    const times = (frames as { time?: unknown }[]).filter((entry): entry is { time: number } => !!entry && typeof entry === 'object' && typeof entry.time === 'number' && entry.time > 0).map((entry) => entry.time)
    if (times.length === frames.length) frametimeMs = (times.reduce((sum, time) => sum + time, 0) / times.length) * 50
  }
  return { frames: frameCount, frametimeMs }
}

/** 读取贴图并附加动画元数据。动画贴图为纵向精灵图：帧高 = 贴图高 / 帧数。 */
async function buildIconResult(jar: string, entryPath: string): Promise<FtbQuestIconResult | null> {
  const data = await readJarEntry(jar, entryPath).catch(() => null)
  if (!data || !data.length) return null
  const dims = pngDimensions(data)
  if (!dims || dims.width <= 0 || dims.height <= 0) return null
  const url = `data:image/png;base64,${data.toString('base64')}`
  let animated = false
  let frameCount = 1
  let frameHeight = dims.height
  let frametimeMs = 50
  const metaRaw = await readJarEntry(jar, `${entryPath}.mcmeta`).catch(() => null)
  if (metaRaw && metaRaw.length) {
    const meta = readAnimationMeta(metaRaw.toString('utf8'))
    // 未显式声明 frames 时按原版规则推算：帧数 = 贴图高 / 贴图宽。
    const estimated = Number.isInteger(dims.height / dims.width) && dims.height / dims.width > 1 ? dims.height / dims.width : null
    const count = meta?.frames ?? estimated
    if (count && count > 1 && dims.height % count === 0 && meta) {
      frameHeight = dims.height / count
      frameCount = count
      frametimeMs = meta.frametimeMs
      animated = true
    }
  }
  return { url, frameWidth: dims.width, frameHeight, frameCount, frametimeMs, animated }
}

const DEPENDENCY_TEXTURE_ENTRY = 'assets/ftbquests/textures/gui/dependency.png'
const dependencyTextureCache = new Map<string, string | null>()

/**
 * dependency.png 是无 alpha 通道的 RGB 灰度斜条纹（mcmeta 标记 blur 渲染），
 * 游戏中靠"纹理 RGB × 顶点色"乘法着色。为让渲染端 mask（按 alpha）生效，
 * 这里用 sharp 把亮度转为 alpha、RGB 置白，生成等效白色 alpha 纹理。
 */
async function dependencyTextureToAlphaMask(raw: Buffer): Promise<string | null> {
  try {
    // flop() 水平镜像：游戏纹理 u 轴与编辑器 pattern 平铺方向相反，翻转后条纹走向与游戏一致。
    const { data, info } = await sharp(raw).removeAlpha().flop().raw().toBuffer({ resolveWithObject: true })
    const pixels = info.width * info.height
    const out = Buffer.alloc(pixels * 4)
    for (let i = 0; i < pixels; i += 1) {
      const r = data[i * info.channels] ?? 0
      const g = data[i * info.channels + 1] ?? 0
      const b = data[i * info.channels + 2] ?? 0
      out[i * 4] = 255
      out[i * 4 + 1] = 255
      out[i * 4 + 2] = 255
      out[i * 4 + 3] = Math.round(r * 0.299 + g * 0.587 + b * 0.114)
    }
    const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch { return null }
}

/** 从整合包 mod jar 提取 FTB 依赖连线贴图 dependency.png（亮度→alpha 的白色斜条纹，渲染端用主题色做遮罩染色），返回 PNG data URL。 */
export async function resolveFtbQuestDependencyTexture(project: ProjectInfo): Promise<string | null> {
  const cached = dependencyTextureCache.get(project.path)
  if (cached !== undefined) return cached
  const jars: string[] = []
  for (const candidate of [path.join(project.path, 'mods'), path.join(project.path, 'overrides', 'mods')]) {
    await collectJars(candidate, 0, jars)
  }
  // ftb-quests 相关 jar 优先尝试，避免大量无关 jar 触发 7-Zip 子进程。
  const ordered = [...jars].sort((a, b) => Number(path.basename(b).toLowerCase().includes('ftb-quest')) - Number(path.basename(a).toLowerCase().includes('ftb-quest')))
  let result: string | null = null
  for (const jar of ordered) {
    try {
      const raw = await readJarEntry(jar, DEPENDENCY_TEXTURE_ENTRY)
      if (raw.length) { result = await dependencyTextureToAlphaMask(raw) ?? `data:image/png;base64,${raw.toString('base64')}`; break }
    } catch { /* jar 内无该资源，继续下一个 */ }
  }
  dependencyTextureCache.set(project.path, result)
  return result
}

const SHAPES_DIR_PREFIX = 'assets/ftbquests/textures/shapes/'
const SHAPES_FILES = ['shape', 'background', 'outline'] as const
const shapesCache = new Map<string, Record<string, FtbQuestShapeSet>>()

// 语言文件索引：命名空间 → 可用的 lang 文件（zh_cn/en_us），翻译按需读取并缓存。
interface LangIndex {
  signature: string
  // 命名空间 → 该命名空间下存在的语言文件（同一 jar 内可能同时有 zh_cn 与 en_us）
  files: Map<string, Array<{ jar: string; file: 'zh_cn' | 'en_us' }>>
  // 命名空间 → 翻译表（zh_cn 优先，en_us 兜底），已合并
  translations: Map<string, Map<string, string>>
}
const langIndexCache = new Map<string, LangIndex>()
// in-flight 去重：并发请求共享同一次索引构建，避免同时起几百个 7-Zip 子进程导致卡顿。
const langIndexBuilding = new Map<string, Promise<LangIndex>>()

async function langIndexFor(project: ProjectInfo): Promise<LangIndex> {
  const jars: string[] = []
  for (const candidate of [path.join(project.path, 'mods'), path.join(project.path, 'overrides', 'mods')]) {
    await collectJars(candidate, 0, jars)
  }
  const signature = jarSignature(jars)
  const cached = langIndexCache.get(project.path)
  if (cached && cached.signature === signature) return cached
  const inflight = langIndexBuilding.get(project.path)
  if (inflight) return inflight
  const task = Promise.resolve().then(async () => {
    const files = new Map<string, Array<{ jar: string; file: 'zh_cn' | 'en_us' }>>()
    for (const jar of jars) {
      let entries: string[] = []
      try { entries = await listJarEntries(jar) } catch { continue }
      for (const raw of entries) {
        const entry = raw.toLowerCase().replaceAll('\\', '/')
        const match = entry.match(/^assets\/([a-z0-9_.-]+)\/lang\/(zh_cn|en_us)\.json$/)
        if (!match) continue
        const list = files.get(match[1]) ?? []
        // zh_cn 记录在前：合并时先读 en_us 打底、再用 zh_cn 覆盖。
        if (match[2] === 'zh_cn') list.unshift({ jar, file: 'zh_cn' })
        else list.push({ jar, file: 'en_us' })
        files.set(match[1], list)
      }
    }
    const index: LangIndex = { signature, files, translations: new Map() }
    langIndexCache.set(project.path, index)
    return index
  }).finally(() => langIndexBuilding.delete(project.path))
  langIndexBuilding.set(project.path, task)
  return task
}

/** 读取某命名空间的语言文件并合并（en_us 打底 + zh_cn 覆盖），结果缓存。 */
async function translationsFor(index: LangIndex, namespace: string): Promise<Map<string, string>> {
  const cached = index.translations.get(namespace)
  if (cached) return cached
  const merged = new Map<string, string>()
  const files = [...(index.files.get(namespace) ?? [])].reverse() // 后读的覆盖先读的 → 反转后 en_us 先、zh_cn 后
  for (const entry of files) {
    const raw = await readJarEntry(entry.jar, `assets/${namespace}/lang/${entry.file}.json`).catch(() => null)
    if (!raw || !raw.length) continue
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown> } catch { continue }
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && value) merged.set(key, value)
  }
  index.translations.set(namespace, merged)
  return merged
}

/**
 * 从整合包 mod jar 的语言文件解析物品/流体显示名（zh_cn 优先，en_us 兜底）。
 * 原版 minecraft 命名空间不在 mod jar 中，由渲染端走 CDN 语言文件，这里跳过。
 */
export async function resolveFtbQuestItemNames(project: ProjectInfo, itemIds: string[]): Promise<Record<string, string>> {
  const index = await langIndexFor(project)
  const result: Record<string, string> = {}
  const namespaces = new Map<string, string[]>()
  for (const rawId of itemIds) {
    const parts = safeItemParts(rawId)
    if (!parts || parts.namespace === 'minecraft' || !parts.name) continue
    const list = namespaces.get(parts.namespace) ?? []
    list.push(parts.name)
    namespaces.set(parts.namespace, list)
  }
  for (const [namespace, names] of namespaces) {
    if (!index.files.has(namespace)) continue
    const translations = await translationsFor(index, namespace)
    for (const name of names) {
      // 1.13+ 语言键：item.<ns>.<name> / block.<ns>.<name> / fluid.<ns>.<name>。
      for (const prefix of ['item', 'block', 'fluid']) {
        const value = translations.get(`${prefix}.${namespace}.${name}`)
        if (value) { result[`${namespace}:${name}`] = value; break }
      }
    }
  }
  return result
}

/**
 * 从整合包 mod jar 提取任务节点形状的三层贴图（shape 深灰底 / background 白色高光 / outline 状态色描边）。
 * 与游戏 QuestShape 一致：textures/shapes/{id}/{shape,background,outline}.png。
 */
export async function resolveFtbQuestShapes(project: ProjectInfo): Promise<Record<string, FtbQuestShapeSet>> {
  const cached = shapesCache.get(project.path)
  if (cached !== undefined) return cached
  const jars: string[] = []
  for (const candidate of [path.join(project.path, 'mods'), path.join(project.path, 'overrides', 'mods')]) {
    await collectJars(candidate, 0, jars)
  }
  // ftb-quests 相关 jar 优先（形状贴图只存在于该 jar 中），避免扫描大量无关 jar。
  const ftbJars = jars.filter((jar) => path.basename(jar).toLowerCase().includes('ftb-quest'))
  const ordered = ftbJars.length ? ftbJars : jars
  const result: Record<string, FtbQuestShapeSet> = {}
  for (const jar of ordered) {
    let entries: string[] = []
    try { entries = await listJarEntries(jar) } catch { continue }
    const shapeIds = new Set<string>()
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/').toLowerCase()
      const match = normalized.match(/^assets\/ftbquests\/textures\/shapes\/([a-z0-9_.-]+)\/(shape|background|outline)\.png$/)
      if (match) shapeIds.add(match[1])
    }
    if (!shapeIds.size) continue
    for (const id of shapeIds) {
      const set: Partial<Record<typeof SHAPES_FILES[number], string>> = {}
      let complete = true
      for (const file of SHAPES_FILES) {
        const raw = await readJarEntry(jar, `${SHAPES_DIR_PREFIX}${id}/${file}.png`).catch(() => null)
        if (!raw || !raw.length) { complete = false; break }
        set[file] = `data:image/png;base64,${raw.toString('base64')}`
      }
      if (!complete || !set.shape || !set.background || !set.outline) continue
      result[id] = { shape: set.shape, background: set.background, outline: set.outline }
    }
    if (Object.keys(result).length) break
  }
  shapesCache.set(project.path, result)
  return result
}
