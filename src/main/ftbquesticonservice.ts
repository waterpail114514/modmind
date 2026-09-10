import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { ftbIconDescriptor, ftbIconKey, type FtbIconDescriptor } from '../shared/ftbIcon'
import type { FtbQuestIconInspection, FtbQuestIconResult, FtbQuestShapeSet, ProjectInfo } from '../shared/types'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import { constantSpawnEggColors } from './ftbSpawnEggColors'

type RecordValue = Record<string, unknown>
const record = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {}
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): V {
  map.delete(key); map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
  return value
}
interface ResourceIndex {
  generation: number
  entries: Map<string, string[]>
  reads: Map<string, Promise<Buffer | null>>
  icons: Map<string, Promise<FtbQuestIconInspection>>
  sources: string[]
  warnings: string[]
  version: string
  remote?: boolean
  remoteIndex?: ResourceIndex
  decoded: Map<string, Promise<Texture>>
  eggColors?: Promise<Map<string, number[]>>
  models?: Map<string, RecordValue>
  languages?: Map<string, Promise<Record<string, unknown>>>
}
const indexes = new Map<string, Promise<ResourceIndex>>()
let nextGeneration = 0
const projectKey = (project: ProjectInfo): string => `${path.resolve(project.path).toLowerCase()}:${project.minecraftVersion}`
const stat = (file: string) => fs.stat(file).catch(() => null)

/** One instance root supplies mods, options and packs. Never merge unrelated instances. */
async function resourceSources(project: ProjectInfo): Promise<{ sources: string[]; warnings: string[] }> {
  const roots = [path.join(project.path, 'overrides'), project.path, path.join(project.path, '.minecraft'), path.join(project.path, '.modmind/minecraft')]
  const root = (await Promise.all(roots.map(async candidate => (await stat(path.join(candidate, 'mods')))?.isDirectory() ? candidate : null))).find(Boolean) ?? project.path
  const sources: string[] = []
  const warnings: string[] = []
  const version = project.minecraftVersion
  if (/^[a-z0-9_.-]+$/i.test(version)) {
    for (const candidate of [path.join(root, 'versions', version, `${version}.jar`), path.join(project.path, 'versions', version, `${version}.jar`), path.join(root, 'client.jar'), ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'modmind/minecraft-runtime/game/versions', version, `${version}.jar`), path.join(process.env.APPDATA, '.minecraft/versions', version, `${version}.jar`)] : [])]) {
      if (!(await stat(candidate))?.isFile()) continue
      try {
        const metadata = JSON.parse((await archiveRead(candidate, 'version.json')).toString('utf8'))
        if (metadata.id === version) { sources.push(candidate); break }
      } catch { warnings.push(`Client jar version could not be verified: ${candidate}`) }
    }
  }
  const mods = path.join(root, 'mods')
  for (const entry of (await fs.readdir(mods, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.jar')) sources.push(path.join(mods, entry.name))
  }
  if ((await stat(path.join(root, 'kubejs/assets')))?.isDirectory()) sources.push(path.join(root, 'kubejs'))
  const options = await fs.readFile(path.join(root, 'options.txt'), 'utf8').catch(() => '')
  let enabled: unknown = []
  try { enabled = JSON.parse(options.match(/^resourcePacks:(.*)$/m)?.[1] ?? '[]') } catch { warnings.push('Invalid resourcePacks in options.txt') }
  if (Array.isArray(enabled)) for (const pack of enabled) {
    if (typeof pack !== 'string') continue
    if (pack.startsWith('file/')) {
      const name = pack.slice(5)
      if (!name || name.includes('/') || name.includes('\\') || name === '..') continue
      const candidate = path.join(root, 'resourcepacks', name)
      if (await stat(candidate)) sources.push(candidate)
      else warnings.push(`Enabled pack unavailable: ${pack}`)
    } else if (pack === 'quest_enhance' || pack === 'visual_loot_edit') {
      const candidate = path.join(root, 'config', pack)
      if ((await stat(path.join(candidate, 'pack.mcmeta')))?.isFile()) sources.push(candidate)
    } else if (!['vanilla', 'mod_resources', 'fabric'].includes(pack)) warnings.push(`Runtime resource pack not reconstructed: ${pack}`)
  }
  return { sources: [...new Set(sources.reverse())], warnings }
}

async function indexFor(project: ProjectInfo): Promise<ResourceIndex> {
  const key = projectKey(project)
  const cached = indexes.get(key)
  if (cached) return cached
  const generation = ++nextGeneration
  const task = (async () => {
    const { sources, warnings } = await resourceSources(project)
    const entries = new Map<string, string[]>()
    const expanded: string[] = []
    const expand = async (source: string, depth = 0): Promise<void> => {
      expanded.push(source)
      if (depth > 2) return
      try {
        const files = await archiveEntries(source)
        if (!files.includes('META-INF/jarjar/metadata.json')) return
        const metadata = JSON.parse((await archiveRead(source, 'META-INF/jarjar/metadata.json')).toString('utf8'))
        for (const nested of Array.isArray(metadata.jars) ? metadata.jars : []) {
          if (typeof nested.path === 'string' && nested.path.startsWith('META-INF/jarjar/') && files.includes(nested.path)) await expand(`${source}!/${nested.path}`, depth + 1)
        }
      } catch (error) { warnings.push(`${source}: ${String(error)}`) }
    }
    for (const source of sources) await expand(source)
    for (const source of expanded) {
      try {
        for (const entry of await archiveEntries(source)) {
          if (!entry.startsWith('assets/')) continue
          const owners = entries.get(entry) ?? []
          owners.push(source); entries.set(entry, owners)
        }
      } catch (error) { warnings.push(`${source}: ${String(error)}`) }
    }
    return { generation, entries, sources: expanded, warnings, version: project.minecraftVersion, reads: new Map(), icons: new Map(), decoded: new Map() } as ResourceIndex
  })().catch(error => { if (indexes.get(key) === task) indexes.delete(key); throw error })
  return boundedSet(indexes, key, task, 8)
}

export async function refreshFtbQuestResources(project: ProjectInfo, input?: unknown): Promise<void> {
  if (input === undefined) { indexes.delete(projectKey(project)); return }
  const index = await indexFor(project)
  index.icons.delete(ftbIconKey(input))
  index.reads.clear(); index.decoded.clear()
  index.models?.clear(); index.languages?.clear()
  index.remoteIndex = undefined
}
export async function ftbQuestResourceReport(project: ProjectInfo): Promise<{ generation: number; sources: string[]; warnings: string[] }> {
  const index = await indexFor(project)
  return { generation: index.generation, sources: index.sources, warnings: index.warnings }
}

async function read(index: ResourceIndex, entry: string): Promise<Buffer | null> {
  const cached = index.reads.get(entry)
  if (cached) return cached
  const source = index.entries.get(entry)?.[0]
  const task = (source ? archiveRead(source, entry).catch(() => null) : index.remote && entry.startsWith('assets/minecraft/') && /^[a-z0-9_.-]+$/i.test(index.version) ? remoteRead(index.version, entry) : Promise.resolve(null)).then(buffer => {
    if (buffer && buffer.length > 256 * 1024 && index.reads.get(entry) === task) index.reads.delete(entry)
    return buffer
  }, error => { if (index.reads.get(entry) === task) index.reads.delete(entry); throw error })
  return boundedSet(index.reads, entry, task, 512)
}
async function remoteRead(version: string, entry: string): Promise<Buffer | null> {
  try {
    const response = await fetch(`https://cdn.jsdelivr.net/gh/misode/mcmeta@${version}-assets/${entry}`, { signal: AbortSignal.timeout(8000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const chunks: Buffer[] = []
    const reader = response.body?.getReader()
    if (!reader) return null
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16 * 1024 * 1024) throw new Error('Resource exceeds 16 MiB')
        chunks.push(Buffer.from(value))
      }
    } finally { await reader.cancel() }
    return Buffer.concat(chunks)
  } catch (error) { throw new Error(`Remote network failure (${entry}): ${String(error)}`) }
}
function location(value: string, kind: 'models' | 'textures'): string {
  const parts = value.includes(':') ? value.split(':') : ['minecraft', value]
  if (parts.length !== 2 || !/^[a-z0-9_.-]+$/.test(parts[0]) || !/^[a-z0-9_./-]+$/.test(parts[1]) || parts[1].split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Invalid resource location: ${value}`)
  return `assets/${parts[0]}/${kind}/${parts[1]}.${kind === 'models' ? 'json' : 'png'}`
}
function predicateValue(descriptor: FtbIconDescriptor, key: string): number | undefined {
  const name = key.replace(/^minecraft:/, '')
  if (descriptor.predicates && Object.hasOwn(descriptor.predicates, key)) return descriptor.predicates[key]
  if (name === 'custom_model_data') return Number(descriptor.tag?.CustomModelData ?? descriptor.components?.['minecraft:custom_model_data'] ?? 0)
  if (name === 'damaged') return Number(descriptor.tag?.Damage ?? 0) > 0 ? 1 : 0
  // Context dependent properties (pulling, cooldown, time, damage/maxDamage) require runtime data.
  return undefined
}
interface Model { textures: Record<string, string>; generated: boolean; entity: boolean; elements?: unknown[]; loader?: string; trace: string[]; tint: boolean; display?: Record<string, unknown> }
async function modelFor(index: ResourceIndex, name: string, descriptor: FtbIconDescriptor, active = new Set<string>()): Promise<Model> {
  if (active.size > 32 || active.has(name)) throw new Error(`Model parent/override cycle: ${name}`)
  const next = new Set(active).add(name)
  if (['minecraft:builtin/generated', 'minecraft:item/generated', 'minecraft:item/handheld', 'minecraft:item/handheld_rod'].includes(name)) {
    // Read resource-pack overrides of these parents when available.
    if (!index.entries.has(location(name, 'models'))) return { textures: {}, generated: true, entity: false, trace: [name], tint: false }
  }
  if (name === 'minecraft:builtin/entity') return { textures: {}, generated: false, entity: true, trace: [name], tint: false }
  const entry = location(name, 'models')
  const raw = await read(index, entry)
  if (!raw) throw new Error(`Model unavailable: ${entry}`)
  index.models ??= new Map()
  const model = index.models.get(entry) ?? boundedSet(index.models, entry, record(JSON.parse(raw.toString('utf8'))), 512)
  const overrides = Array.isArray(model.overrides) ? model.overrides : []
  for (const value of [...overrides].reverse()) {
    const override = record(value)
    if (typeof override.model !== 'string') continue
    const predicates = record(override.predicate)
    if (Object.entries(predicates).every(([key, threshold]) => {
      const actual = predicateValue(descriptor, key)
      return typeof threshold === 'number' && actual !== undefined && actual >= threshold
    })) {
      const result = await modelFor(index, qualify(override.model), descriptor, next)
      return { ...result, trace: [entry, ...result.trace] }
    }
  }
  const parent = typeof model.parent === 'string' ? await modelFor(index, qualify(model.parent), descriptor, next) : { textures: {}, generated: false, entity: false, trace: [], tint: false }
  const textures = { ...parent.textures }
  for (const [key, value] of Object.entries(record(model.textures))) if (typeof value === 'string') textures[key] = value
  return { ...parent, textures, display: { ...parent.display, ...record(model.display) }, elements: Array.isArray(model.elements) ? model.elements : parent.elements, loader: typeof model.loader === 'string' ? model.loader : parent.loader, trace: [entry, ...parent.trace], tint: parent.tint || name === 'minecraft:item/template_spawn_egg' }
}
const qualify = (name: string): string => name.includes(':') ? name : `minecraft:${name}`
function textureReference(value: string, textures: Record<string, string>, seen = new Set<string>()): string {
  if (!value.startsWith('#')) return location(value, 'textures')
  if (seen.has(value) || !textures[value.slice(1)]) throw new Error(`Unresolved texture variable: ${value}`)
  return textureReference(textures[value.slice(1)], textures, new Set(seen).add(value))
}

interface Texture { frames: Buffer[]; times: number[]; width: number; height: number; interpolation: boolean }
async function decodeTexture(index: ResourceIndex, entry: string): Promise<Texture> {
  const cached = index.decoded.get(entry)
  if (cached) return cached
  const task = decodeTextureUncached(index, entry).then(texture => {
    if (texture.frames.reduce((size, buffer) => size + buffer.length, 0) > 256 * 1024) index.decoded.delete(entry)
    return texture
  })
  return boundedSet(index.decoded, entry, task, 128)
}
async function decodeTextureUncached(index: ResourceIndex, entry: string): Promise<Texture> {
  const raw = await read(index, entry)
  if (!raw) throw new Error(`Texture unavailable: ${entry}`)
  // Full decoding catches truncated/corrupt PNGs; pixel limits bound decompression.
  const { data, info } = await sharp(raw, { failOn: 'warning', limitInputPixels: 16_777_216 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const metadata = await read(index, `${entry}.mcmeta`)
  const animation = metadata ? record(record(JSON.parse(metadata.toString('utf8'))).animation) : {}
  const animated = Object.keys(animation).length > 0 || Boolean(metadata && Object.hasOwn(record(JSON.parse(metadata.toString('utf8'))), 'animation'))
  const integer = (v: unknown, fallback: number): number => {
    if (v === undefined) return fallback
    if (!Number.isInteger(v) || Number(v) <= 0) throw new Error('Invalid animation dimension/time')
    return Number(v)
  }
  const width = animated ? integer(animation.width, animation.height === undefined ? Math.min(info.width, info.height) : info.width) : info.width
  const height = animated ? integer(animation.height, animation.width === undefined ? Math.min(info.width, info.height) : info.height) : info.height
  if (info.width % width || info.height % height) throw new Error('Animation frame dimensions do not divide texture')
  if (!animated && width !== height) throw new Error('Non-square texture without animation metadata is not an item preview')
  const count = info.width / width * (info.height / height)
  const sequence = Array.isArray(animation.frames) ? animation.frames : Array.from({ length: count }, (_, i) => i)
  if (!sequence.length || sequence.length > 1024) throw new Error('Invalid animation frame count')
  const frames: Buffer[] = [], times: number[] = []
  for (const item of sequence) {
    const frame = typeof item === 'number' ? item : Number(record(item).index)
    if (!Number.isInteger(frame) || frame < 0 || frame >= count) throw new Error('Animation frame index out of bounds')
    const left = frame % (info.width / width) * width, top = Math.floor(frame / (info.width / width)) * height
    frames.push(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract({ left, top, width, height }).png().toBuffer())
    times.push(integer(record(item).time, integer(animation.frametime, 1)))
  }
  return { frames, times, width, height, interpolation: animation.interpolate === true }
}

async function render(index: ResourceIndex, descriptor: FtbIconDescriptor): Promise<FtbQuestIconInspection> {
  const trace: string[] = []
  const result = (icon: FtbQuestIconResult | null, reason: string): FtbQuestIconInspection => ({ icon, reason, generation: index.generation, sources: trace.map(entry => `${index.entries.get(entry)?.[0] ?? (index.remote && entry.startsWith('assets/minecraft/') ? `https://cdn.jsdelivr.net/gh/misode/mcmeta@${index.version}-assets` : 'builtin')} :: ${entry}`) })
  try {
    const [namespace, name] = descriptor.id.split(':')
    const model = await modelFor(index, `${namespace}:item/${name}`, descriptor)
    trace.push(...model.trace)
    if (model.entity || model.loader) return result(null, model.loader ? `Custom model loader requires renderer: ${model.loader}` : 'builtin/entity requires the item/block entity renderer')
    if (model.elements?.length) {
      if (model.elements.length > 512) return result(null, 'Model exceeds geometry preview limit')
      const textures: Record<string, string> = {}
      const used = new Set<string>()
      for (const element of model.elements) for (const face of Object.values(record(record(element).faces))) {
        const texture = record(face).texture
        if (typeof texture === 'string') used.add(texture)
      }
      for (const reference of used) {
        const entry = textureReference(reference, model.textures)
        trace.push(entry)
        const decoded = await decodeTexture(index, entry)
        textures[reference] = `data:image/png;base64,${decoded.frames[0].toString('base64')}`
      }
      const reason = 'Static model geometry preview; game lighting, animated surfaces and biome tint may differ'
      const inspection = result(null, reason)
      inspection.icon = { url: '', frameWidth: 64, frameHeight: 64, frameCount: 1, frametimeMs: 50, animated: false, quality: 'approximate', reason, sources: inspection.sources, modelPreview: { elements: model.elements, display: model.display ?? {}, textures } }
      return inspection
    }
    const layers = Object.keys(model.textures).filter(key => /^layer\d+$/.test(key)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    let approximate = !model.generated || Boolean(model.elements?.length)
    let reason = approximate ? 'Model geometry is shown as a texture preview' : 'Generated item layers resolved'
    if (descriptor.tag?.Enchantments || descriptor.tag?.StoredEnchantments || descriptor.components?.['minecraft:enchantments']) { approximate = true; reason = 'Base item layers resolved; enchantment glint not rendered' }
    const keys = layers.length ? layers : Object.keys(model.textures).filter(key => key !== 'particle').slice(0, 1)
    if (!keys.length) return result(null, 'Model has no renderable item layers')
    const textures: Texture[] = []
    for (const key of keys) {
      const entry = textureReference(model.textures[key], model.textures)
      trace.push(entry)
      textures.push(await decodeTexture(index, entry))
    }
    const tintColors = [...(descriptor.tint ?? [])]
    if (model.tint && !tintColors.length) {
      if (!index.eggColors) index.eggColors = (async () => {
        const colors = new Map<string, number[]>()
        for (const source of index.sources.filter(source => source.endsWith('.jar'))) {
          for (const entry of (await archiveEntries(source)).filter(entry => /\/init\/[^/]+ModItems\.class$/.test(entry))) {
            const namespace = entry.match(/^net\/mcreator\/([^/]+)\//)?.[1]
            if (!namespace) continue
            for (const [id, pair] of constantSpawnEggColors(await archiveRead(source, entry))) if (!colors.has(`${namespace}:${id}`)) colors.set(`${namespace}:${id}`, pair)
          }
        }
        return colors
      })()
      const colors = (await index.eggColors).get(descriptor.id)
      if (colors) tintColors.push(...colors)
    }
    const leatherColor = record(descriptor.tag?.display).color ?? descriptor.components?.['minecraft:dyed_color']
    const potionColor = descriptor.tag?.CustomPotionColor ?? record(descriptor.components?.['minecraft:potion_contents']).custom_color
    if (typeof leatherColor === 'number') tintColors[0] = leatherColor
    if (typeof potionColor === 'number') tintColors[0] = potionColor
    if ((model.tint || descriptor.tag?.Potion || descriptor.tag?.CustomPotionEffects || descriptor.id.startsWith('minecraft:leather_') || /minecraft:(splash_potion|lingering_potion|potion|tipped_arrow)$/.test(descriptor.id)) && !tintColors.length) {
      approximate = true; reason = 'Item color provider is unavailable; untinted layer preview'
    }
    const first = textures[0]
    const multipleAnimations = textures.slice(1).some(t => t.frames.length > 1)
    if (multipleAnimations || textures.some(t => t.interpolation)) { approximate = true; reason = 'Animation interpolation or independent layer timelines require runtime rendering' }
    const frames: Buffer[] = []
    for (let i = 0; i < first.frames.length; i++) {
      const inputs: Buffer[] = []
      for (let layer = 0; layer < textures.length; layer++) {
        const texture = textures[layer]
        let input = texture.frames[layer === 0 ? i : 0]
        const color = tintColors[layer]
        if (color !== undefined) {
          const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          for (let pixel = 0; pixel < data.length; pixel += 4) {
            data[pixel] = Math.round(data[pixel] * ((color >> 16) & 255) / 255)
            data[pixel + 1] = Math.round(data[pixel + 1] * ((color >> 8) & 255) / 255)
            data[pixel + 2] = Math.round(data[pixel + 2] * (color & 255) / 255)
          }
          input = await sharp(data, { raw: info }).png().toBuffer()
        }
        inputs.push(await sharp(input).resize(first.width, first.height, { kernel: 'nearest' }).png().toBuffer())
      }
      frames.push(await sharp(inputs[0]).composite(inputs.slice(1).map(input => ({ input }))).png().toBuffer())
    }
    // Expand durations in ticks into a uniform strip consumed by the existing steps() animation.
    const total = first.times.reduce((sum, time) => sum + time, 0)
    if (total > 2048 || first.width * first.height * total > 16_777_216) throw new Error('Animation exceeds preview pixel budget')
    const expanded: Buffer[] = []
    frames.forEach((frame, i) => { for (let tick = 0; tick < first.times[i]; tick++) expanded.push(frame) })
    const output = await sharp({ create: { width: first.width, height: first.height * expanded.length, channels: 4, background: '#00000000' } }).composite(expanded.map((input, i) => ({ input, left: 0, top: i * first.height }))).png().toBuffer()
    const inspection = result(null, reason)
    inspection.icon = { url: `data:image/png;base64,${output.toString('base64')}`, frameWidth: first.width, frameHeight: first.height, frameCount: expanded.length, frametimeMs: 50, animated: frames.length > 1, quality: approximate ? 'approximate' : 'resolved', reason, sources: inspection.sources }
    return inspection
  } catch (error) { return result(null, error instanceof Error ? error.message : String(error)) }
}
export async function inspectFtbQuestIcon(project: ProjectInfo, input: unknown, remote = false): Promise<FtbQuestIconInspection> {
  const local = await indexFor(project)
  if (remote && !local.remoteIndex) local.remoteIndex = { ...local, remote: true, reads: new Map(), icons: new Map(), decoded: new Map() }
  const index = remote ? local.remoteIndex! : local
  const descriptor = ftbIconDescriptor(input)
  if (!descriptor) return { icon: null, reason: 'Invalid item descriptor', sources: [], generation: index.generation }
  const key = ftbIconKey(descriptor)
  const cached = index.icons.get(key)
  if (cached) return cached
  const task = render(index, descriptor).then(result => {
    if ((result.icon?.url.length ?? 0) > 512 * 1024) index.icons.delete(key)
    if (result.reason.includes('network failure')) {
      const timer = setTimeout(() => { if (index.icons.get(key) === task) index.icons.delete(key) }, 10_000)
      timer.unref()
    }
    return result
  })
  return boundedSet(index.icons, key, task, 512)
}
export async function resolveFtbQuestIcon(project: ProjectInfo, input: unknown): Promise<FtbQuestIconResult | null> {
  return (await inspectFtbQuestIcon(project, input)).icon
}
export async function resolveFtbQuestDependencyTexture(project: ProjectInfo): Promise<string | null> {
  const index = await indexFor(project)
  const raw = await read(index, 'assets/ftbquests/textures/gui/dependency.png')
  if (!raw) return null
  try {
    const { data, info } = await sharp(raw).removeAlpha().flop().raw().toBuffer({ resolveWithObject: true })
    const out = Buffer.alloc(info.width * info.height * 4, 255)
    for (let i = 0; i < info.width * info.height; i++) out[i * 4 + 3] = Math.round(data[i * info.channels] * .299 + data[i * info.channels + 1] * .587 + data[i * info.channels + 2] * .114)
    return `data:image/png;base64,${(await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()).toString('base64')}`
  } catch { return null }
}
export async function resolveFtbQuestShapes(project: ProjectInfo): Promise<Record<string, FtbQuestShapeSet>> {
  const index = await indexFor(project)
  const result: Record<string, FtbQuestShapeSet> = {}
  const prefix = 'assets/ftbquests/textures/shapes/'
  const names = new Set([...index.entries.keys()].filter(entry => entry.startsWith(prefix)).map(entry => entry.slice(prefix.length).split('/')[0]))
  for (const name of names) {
    const set: Partial<FtbQuestShapeSet> = {}
    for (const kind of ['shape', 'background', 'outline'] as const) {
      const raw = await read(index, `${prefix}${name}/${kind}.png`)
      if (raw) { try { set[kind] = `data:image/png;base64,${(await sharp(raw).png().toBuffer()).toString('base64')}` } catch { /* Invalid shape stays absent. */ } }
    }
    if (set.shape && set.background && set.outline) result[name] = set as FtbQuestShapeSet
  }
  return result
}
export async function resolveFtbQuestItemNames(project: ProjectInfo, ids: string[]): Promise<Record<string, string>> {
  const index = await indexFor(project)
  const result: Record<string, string> = {}
  for (const namespace of new Set(ids.map(id => ftbIconDescriptor(id)?.id.split(':')[0]).filter(Boolean))) {
    index.languages ??= new Map()
    let language = index.languages.get(namespace!)
    if (!language) {
      language = (async () => {
        const translations: Record<string, unknown> = {}
        for (const locale of ['en_us', 'zh_cn']) {
          const entry = `assets/${namespace}/lang/${locale}.json`
          for (const owner of [...(index.entries.get(entry) ?? [])].reverse()) {
            try { Object.assign(translations, JSON.parse((await archiveRead(owner, entry)).toString('utf8'))) } catch { /* Continue lower-priority translations. */ }
          }
        }
        return translations
      })()
      boundedSet(index.languages, namespace!, language, 128)
      }
    const translations = await language
    for (const id of ids) {
      const descriptor = ftbIconDescriptor(id)
      if (!descriptor?.id.startsWith(`${namespace}:`)) continue
      for (const kind of ['item', 'block', 'fluid']) {
        const name = translations[`${kind}.${namespace}.${descriptor.id.split(':')[1].replaceAll('/', '.')}`]
        if (typeof name === 'string') { result[id] = name; break }
      }
    }
  }
  return result
}
