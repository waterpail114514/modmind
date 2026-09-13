import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { parse as parseToml } from 'smol-toml'
import type { AddonApiProfile, AddonRelationshipDependency } from '../shared/production'
import type { JavaLoaderKind } from '../shared/types'
import { inspectLegacyForgeAnnotations, type LegacyForgeAnnotation } from './legacyForgeAnnotations'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import type { ModConfigIdentity } from '../shared/contentFileFilters'

export interface InspectedModJar {
  filePath: string
  fileName: string
  size: number
  sha1: string
  sha256: string
  sha512: string
  profile: AddonApiProfile
  dependencies: AddonRelationshipDependency[]
  /** Minecraft versions declared by the loader descriptor (when available). */
  minecraftVersions: string[]
  warnings: string[]
}

interface DescriptorResult {
  loader: JavaLoaderKind
  primaryModId: string
  modIds: string[]
  displayName: string
  version: string
  dependencies: AddonRelationshipDependency[]
  minecraftVersions?: string[]
  warnings?: string[]
}

interface LegacyForgeMod {
  id: string
  name: string
  version: string
  dependencies: AddonRelationshipDependency[]
}

const builtinIds = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'fabric-api', 'quilt_loader',
  'quilted_fabric_api', 'forge', 'neoforge', 'fml', 'mcp'
])

function cleanText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, 240) || fallback : fallback
}

function cleanVersion(value: unknown): string {
  const text = cleanText(value, 'unknown')
  return /^(?:\$\{[^}]+\}|@[A-Za-z0-9_.-]+@)$/.test(text) ? 'unknown' : text
}

const MINECRAFT_VERSION_PATTERN = /\d{1,2}\.\d{1,2}(?:\.\d{1,2})?/g

function minecraftVersionsFromValue(value: unknown): string[] {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : ''
  const matches = text.match(MINECRAFT_VERSION_PATTERN) ?? []
  return [...new Set(matches)]
}

function minecraftVersionsFromDependencyMap(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return minecraftVersionsFromValue((value as Record<string, unknown>).minecraft)
}

function validModId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,127}$/.test(value)
}

function dependency(modId: unknown, kind: AddonRelationshipDependency['kind']): AddonRelationshipDependency[] {
  return validModId(modId) && !builtinIds.has(modId.toLowerCase()) ? [{ modId, kind }] : []
}

function validLegacyModId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+|$-]{0,127}$/.test(value)
}

function legacyDependency(value: unknown, fallbackKind: AddonRelationshipDependency['kind']): AddonRelationshipDependency[] {
  if (typeof value !== 'string') return []
  const declaration = value.trim()
  if (!declaration) return []
  const match = declaration.match(/^(?:(required-)?(?:before|after):)?([^@]+)(?:@.*)?$/i)
  const modId = match?.[2]?.trim() ?? ''
  const kind = match?.[1] ? 'required' : fallbackKind
  return validLegacyModId(modId) && !builtinIds.has(modId.toLowerCase()) ? [{ modId, kind }] : []
}

function uniqueDependencies(values: AddonRelationshipDependency[]): AddonRelationshipDependency[] {
  const priority: Record<AddonRelationshipDependency['kind'], number> = { optional: 0, incompatible: 1, required: 2, embedded: 3 }
  const byId = new Map<string, AddonRelationshipDependency>()
  for (const value of values) {
    if (!value.modId) continue
    const current = byId.get(value.modId)
    if (!current || priority[value.kind] > priority[current.kind]) byId.set(value.modId, value)
  }
  return [...byId.values()]
}

function fabricDescriptor(raw: string): DescriptorResult {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (!validModId(value.id)) throw new Error('fabric.mod.json 缺少有效的模组 ID')
  const dependencies: AddonRelationshipDependency[] = []
  const addObject = (entry: unknown, kind: AddonRelationshipDependency['kind']): void => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    for (const id of Object.keys(entry as Record<string, unknown>)) dependencies.push(...dependency(id, kind))
  }
  addObject(value.depends, 'required')
  addObject(value.recommends, 'optional')
  addObject(value.suggests, 'optional')
  addObject(value.breaks, 'incompatible')
  addObject(value.conflicts, 'incompatible')
  return {
    loader: 'fabric',
    primaryModId: value.id,
    modIds: [value.id],
    displayName: cleanText(value.name, value.id),
    version: cleanVersion(value.version),
    dependencies,
    minecraftVersions: minecraftVersionsFromDependencyMap(value.depends)
  }
}

function quiltDescriptor(raw: string): DescriptorResult {
  const value = JSON.parse(raw) as { quilt_loader?: Record<string, unknown> }
  const loader = value.quilt_loader
  if (!loader || !validModId(loader.id)) throw new Error('quilt.mod.json 缺少有效的模组 ID')
  const metadata = loader.metadata && typeof loader.metadata === 'object' ? loader.metadata as Record<string, unknown> : {}
  const dependencies: AddonRelationshipDependency[] = []
  const minecraftVersions: string[] = []
  const addList = (entry: unknown, kind: AddonRelationshipDependency['kind']): void => {
    if (!Array.isArray(entry)) return
    for (const item of entry) {
      if (typeof item === 'string') {
        dependencies.push(...dependency(item, kind))
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        dependencies.push(...dependency(record.id, kind))
        if (record.id === 'minecraft') minecraftVersions.push(...minecraftVersionsFromValue(record.version ?? record.versions))
      }
    }
  }
  addList(loader.depends, 'required')
  addList(loader.breaks, 'incompatible')
  return {
    loader: 'quilt',
    primaryModId: loader.id,
    modIds: [loader.id],
    displayName: cleanText(metadata.name, loader.id),
    version: cleanVersion(loader.version),
    dependencies,
    minecraftVersions: [...new Set(minecraftVersions)]
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function forgeDescriptor(raw: string, loader: 'forge' | 'neoforge'): DescriptorResult {
  const value = parseToml(raw) as Record<string, unknown>
  const mods = (Array.isArray(value.mods) ? value.mods : [])
    .map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: cleanText(entry.modId),
      name: cleanText(entry.displayName),
      version: cleanText(entry.version)
    }))
    .filter((entry) => validModId(entry.id))
  if (!mods.length) throw new Error('mods.toml 缺少有效的模组 ID')
  const dependencies: AddonRelationshipDependency[] = []
  const minecraftVersions: string[] = []
  const dependencyGroups = record(value.dependencies)
  const dependencyEntries = dependencyGroups
    ? Object.values(dependencyGroups).flatMap((group) => Array.isArray(group) ? group : [])
    : []
  for (const entry of dependencyEntries.map(record).filter((item): item is Record<string, unknown> => Boolean(item))) {
    const id = cleanText(entry.modId)
    const type = cleanText(entry.type).toLowerCase()
    const mandatory = entry.mandatory === true
    if (id.toLowerCase() === 'minecraft') minecraftVersions.push(...minecraftVersionsFromValue(entry.versionRange ?? entry.version))
    dependencies.push(...dependency(id, type === 'incompatible' ? 'incompatible' : type === 'optional' || (!type && !mandatory) ? 'optional' : 'required'))
  }
  return {
    loader,
    primaryModId: mods[0].id,
    modIds: mods.map((entry) => entry.id),
    displayName: mods[0].name || mods[0].id,
    version: cleanVersion(mods[0].version),
    dependencies,
    minecraftVersions: [...new Set(minecraftVersions)]
  }
}

function legacyDependencyList(value: unknown, kind: AddonRelationshipDependency['kind']): AddonRelationshipDependency[] {
  return Array.isArray(value) ? value.flatMap((entry) => legacyDependency(entry, kind)) : []
}

function metadataMods(parsed: unknown): LegacyForgeMod[] {
  const root = record(parsed)
  const values = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.modList)
      ? root.modList
      : root && Array.isArray(root.modlist)
        ? root.modlist
        : [parsed]
  return values.map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry)).flatMap((entry) => {
    const id = cleanText(entry.modid)
    if (!validLegacyModId(id)) return []
    return [{
      id,
      name: cleanText(entry.name),
      version: cleanVersion(entry.version),
      dependencies: uniqueDependencies([
        ...legacyDependencyList(entry.requiredMods, 'required'),
        ...legacyDependencyList(entry.dependencies, 'optional'),
        ...legacyDependencyList(entry.dependants, 'optional')
      ])
    }]
  })
}

function annotationMods(annotations: LegacyForgeAnnotation[]): LegacyForgeMod[] {
  return annotations.flatMap((entry) => {
    const id = cleanText(entry.modId)
    if (!validLegacyModId(id)) return []
    return [{
      id,
      name: cleanText(entry.name),
      version: cleanVersion(entry.version),
      dependencies: uniqueDependencies(entry.dependencies.split(';').flatMap((value) => legacyDependency(value, 'optional')))
    }]
  })
}

function mergeLegacyMods(metadata: LegacyForgeMod[], annotations: LegacyForgeMod[]): LegacyForgeMod[] {
  const merged = new Map<string, LegacyForgeMod>()
  for (const mod of [...metadata, ...annotations]) {
    const current = merged.get(mod.id)
    if (!current) {
      merged.set(mod.id, mod)
      continue
    }
    merged.set(mod.id, {
      id: mod.id,
      name: current.name || mod.name,
      version: current.version !== 'unknown' ? current.version : mod.version,
      dependencies: uniqueDependencies([...current.dependencies, ...mod.dependencies])
    })
  }
  return [...merged.values()]
}

function legacyForgeDescriptor(raw: string | null, annotations: LegacyForgeAnnotation[]): DescriptorResult {
  const warnings: string[] = []
  let metadata: LegacyForgeMod[] = []
  if (raw !== null) {
    try {
      metadata = metadataMods(JSON.parse(raw) as unknown)
    } catch {
      warnings.push('mcmod.info 格式无效，已改用 Forge @Mod 注解识别')
    }
  }
  const declared = annotationMods(annotations)
  const mods = mergeLegacyMods(metadata, declared)
  if (!mods.length) {
    if (raw !== null) throw new Error('mcmod.info 缺少有效的模组 ID，且未找到 Forge @Mod 注解')
    throw new Error('JAR 中没有找到 Forge 模组描述信息或 @Mod 注解')
  }
  if (raw !== null && !metadata.length && declared.length && !warnings.length) {
    warnings.push('mcmod.info 未声明模组 ID，已通过 Forge @Mod 注解识别')
  }
  const first = mods[0]
  return {
    loader: 'forge',
    primaryModId: first.id,
    modIds: mods.map((entry) => entry.id),
    displayName: first.name || first.id,
    version: first.version,
    dependencies: uniqueDependencies(mods.flatMap((entry) => entry.dependencies)),
    minecraftVersions: [],
    warnings
  }
}

async function hashFile(filePath: string): Promise<{ sha1: string; sha256: string; sha512: string; size: number }> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024) throw new Error('JAR 文件大小必须介于 1 B 和 256 MB 之间')
  const hashes = [createHash('sha1'), createHash('sha256'), createHash('sha512')]
  for await (const chunk of createReadStream(filePath)) hashes.forEach((hash) => hash.update(chunk as Buffer))
  return { sha1: hashes[0].digest('hex'), sha256: hashes[1].digest('hex'), sha512: hashes[2].digest('hex'), size: stat.size }
}

async function scanFiles(root: string): Promise<{ files: string[]; classNames: string[]; packages: string[] }> {
  const files: string[] = []
  const classes: string[] = []
  const packageCounts = new Map<string, number>()
  const queue = [root]
  while (queue.length) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) {
        if (files.length >= 100_000) throw new Error('JAR 内文件数量异常，已停止分析')
        const relative = path.relative(root, absolute).replaceAll('\\', '/')
        files.push(relative)
        if (relative.endsWith('.class') && !relative.startsWith('META-INF/versions/')) {
          const className = relative.slice(0, -6).replaceAll('/', '.')
          classes.push(className)
          const packageName = className.split('.').slice(0, -1).join('.')
          if (packageName) packageCounts.set(packageName, (packageCounts.get(packageName) ?? 0) + 1)
        }
      }
    }
  }
  const packages = [...packageCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 80).map(([name]) => name)
  return { files, classNames: classes, packages }
}

/** Metadata-only path for file grouping: reuse descriptor parsers without unpacking or scanning classes. */
export async function readModJarIdentities(filePath: string): Promise<ModConfigIdentity[]> {
  const entries = await archiveEntries(filePath)
  const candidates: Array<[string, (raw: string) => DescriptorResult]> = [
    ['fabric.mod.json', fabricDescriptor], ['quilt.mod.json', quiltDescriptor],
    ['META-INF/neoforge.mods.toml', raw => forgeDescriptor(raw, 'neoforge')],
    ['META-INF/mods.toml', raw => forgeDescriptor(raw, 'forge')],
    ['mcmod.info', raw => legacyForgeDescriptor(raw, [])]
  ]
  for (const [entry, parse] of candidates) if (entries.includes(entry)) {
    try {
      const raw = await archiveRead(filePath, entry)
      if (raw.length > 1024 * 1024) continue
      const descriptor = parse(raw.toString('utf8'))
      return descriptor.modIds.map(id => ({ id, name: id === descriptor.primaryModId ? descriptor.displayName : id }))
    } catch { /* Try another declared format; unidentified JARs remain unassigned. */ }
  }
  return []
}

export async function inspectModJar(filePath: string, expectedLoader?: JavaLoaderKind): Promise<InspectedModJar> {
  if (path.extname(filePath).toLowerCase() !== '.jar') throw new Error('只能分析 Minecraft Mod JAR')
  const hashes = await hashFile(filePath)
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-addon-jar-'))
  try {
    await extractZip(filePath, { dir: temporary })
    const scanned = await scanFiles(temporary)
    let descriptor: DescriptorResult
    if (scanned.files.includes('fabric.mod.json')) descriptor = fabricDescriptor(await fs.readFile(path.join(temporary, 'fabric.mod.json'), 'utf8'))
    else if (scanned.files.includes('quilt.mod.json')) descriptor = quiltDescriptor(await fs.readFile(path.join(temporary, 'quilt.mod.json'), 'utf8'))
    else if (scanned.files.includes('META-INF/neoforge.mods.toml')) descriptor = forgeDescriptor(await fs.readFile(path.join(temporary, 'META-INF', 'neoforge.mods.toml'), 'utf8'), 'neoforge')
    else if (scanned.files.includes('META-INF/mods.toml')) descriptor = forgeDescriptor(await fs.readFile(path.join(temporary, 'META-INF', 'mods.toml'), 'utf8'), expectedLoader === 'neoforge' ? 'neoforge' : 'forge')
    else {
      const annotations = await inspectLegacyForgeAnnotations(temporary, scanned.files)
      const metadata = scanned.files.includes('mcmod.info') ? await fs.readFile(path.join(temporary, 'mcmod.info'), 'utf8') : null
      if (metadata === null && !annotations.length) throw new Error('JAR 中没有找到 Fabric、Quilt、Forge 或 NeoForge 模组描述文件')
      descriptor = legacyForgeDescriptor(metadata, annotations)
    }
    const warnings: string[] = [...(descriptor.warnings ?? [])]
    if (expectedLoader && descriptor.loader !== expectedLoader) warnings.push(`JAR 使用 ${descriptor.loader}，当前项目使用 ${expectedLoader}`)
    if (!scanned.classNames.length) warnings.push('JAR 中没有可供分析的 Java 类')
    return {
      filePath,
      fileName: path.basename(filePath),
      ...hashes,
      dependencies: descriptor.dependencies,
      minecraftVersions: descriptor.minecraftVersions ?? [],
      warnings,
      profile: {
        primaryModId: descriptor.primaryModId,
        modIds: descriptor.modIds,
        displayName: descriptor.displayName,
        version: descriptor.version,
        loader: descriptor.loader,
        classCount: scanned.classNames.length,
        packages: scanned.packages,
        sourceKind: 'jar'
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取 ${path.basename(filePath)}：${message}`)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}
