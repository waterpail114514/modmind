import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModpackImportSource, ModpackLocalModule, ModpackManagedMod, ModpackManifest, ModpackModuleSide, ProjectInfo } from '../shared/types'
import { isJavaLoader } from '../shared/projectPlatform'
import { createStoredZip } from './bedrockAddon'
import { MODPACK_LOCK_FILE, auditModpackLock, readModpackLock, writeModpackLock } from './modpackLockService'
import { isSafeModJarFileName, safeModJarFileName } from './modpackFilename'
import { isRemoteModpackContent, readManagedModpackContent } from './modpackContentInventoryService'
import { excludesModsFromOverrides, modpackModsRoot, modpackOverridesRoot } from './modpackPaths'

export const MODPACK_MANIFEST = 'modmind.pack.json'
const manifestListeners = new Set<(projectPath: string) => void>()
export function onModpackManifestChanged(listener: (projectPath: string) => void): () => void {
  manifestListeners.add(listener)
  return () => { manifestListeners.delete(listener) }
}

export function isModpackProject(project: ProjectInfo): boolean {
  return project.kind === 'modpack'
}

function manifestPath(project: ProjectInfo): string {
  return path.join(project.path, MODPACK_MANIFEST)
}

function normalizeModule(value: unknown): ModpackLocalModule | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.name !== 'string'
    || typeof record.namespace !== 'string'
    || typeof record.path !== 'string'
    || typeof record.createdAt !== 'string'
    || !/^[a-z0-9_]{1,64}$/.test(record.namespace)
    || !/^modules\/[a-z0-9_]{1,64}$/.test(record.path.replaceAll('\\', '/'))
  ) return null
  return {
    name: record.name.slice(0, 120),
    namespace: record.namespace,
    path: record.path.replaceAll('\\', '/'),
    createdAt: record.createdAt,
    side: ['client', 'server', 'both', 'unknown'].includes(String(record.side)) ? record.side as ModpackModuleSide : 'both'
  }
}

function normalizeMod(value: unknown): ModpackManagedMod | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.fileName !== 'string'
    || typeof record.sha256 !== 'string'
    || typeof record.size !== 'number'
    || typeof record.addedAt !== 'string'
    || !isSafeModJarFileName(record.fileName)
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.size)
    || record.size < 1
  ) return null
  return { fileName: record.fileName, sha256: record.sha256, size: record.size, addedAt: record.addedAt }
}

function normalizeImportSource(value: unknown): ModpackImportSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const format = record.format
  const layout = record.layout
  if (
    !['workspace', 'instance', 'prism', 'multimc', 'curseforge', 'modrinth', 'hmcl', 'pcl'].includes(String(format))
    || (layout !== 'workspace' && layout !== 'instance' && layout !== 'archive')
    || typeof record.importedAt !== 'string'
  ) return undefined
  const unresolvedDependencies = typeof record.unresolvedDependencies === 'number' && Number.isSafeInteger(record.unresolvedDependencies) && record.unresolvedDependencies > 0
    ? record.unresolvedDependencies
    : undefined
  return { format: format as ModpackImportSource['format'], layout, importedAt: record.importedAt, ...(unresolvedDependencies ? { unresolvedDependencies } : {}) }
}

export function createModpackManifest(project: ProjectInfo): ModpackManifest {
  if (!isJavaLoader(project.loader)) throw new Error('Modpack projects require a Java Edition loader')
  return {
    version: 1,
    name: project.name,
    minecraftVersion: project.minecraftVersion,
    loader: project.loader,
    mods: [],
    modules: []
  }
}

export async function writeModpackManifest(project: ProjectInfo, manifest: ModpackManifest): Promise<ModpackManifest> {
  if (!isModpackProject(project)) throw new Error('The active project is not a modpack')
  validateManifest(manifest)
  const target = manifestPath(project)
  const pending = `${target}.pending`
  await fs.writeFile(pending, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    await fs.rename(pending, target)
  } finally {
    await fs.rm(pending, { force: true }).catch(() => undefined)
  }
  for (const listener of manifestListeners) {
    try { listener(project.path) } catch { /* UI notifications must not fail an already completed write. */ }
  }
  return manifest
}

export async function readModpackManifest(project: ProjectInfo): Promise<ModpackManifest> {
  if (!isModpackProject(project)) throw new Error('The active project is not a modpack')
  const fallback = createModpackManifest(project)
  let value: Record<string, unknown>
  try {
    value = JSON.parse(await fs.readFile(manifestPath(project), 'utf8')) as Record<string, unknown>
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT') throw new Error(`整合包缺少 ${MODPACK_MANIFEST}，请先恢复或重新导入整合包；为避免覆盖源文件，ModMind 未创建空清单`)
    throw new Error(`无法读取 ${MODPACK_MANIFEST}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (
    value.version !== 1
    || typeof value.name !== 'string'
    || !value.name.trim()
    || typeof value.minecraftVersion !== 'string'
    || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(value.minecraftVersion)
    || !isJavaLoader(value.loader)
    || !Array.isArray(value.mods)
    || !Array.isArray(value.modules)
  ) {
    throw new Error(`${MODPACK_MANIFEST} 格式无效（需要完整的版本、名称、Minecraft、Loader 和数组字段）；源清单未被修改`)
  }
  const mods = value.mods.map(normalizeMod)
  if (mods.some((entry) => !entry)) throw new Error(`${MODPACK_MANIFEST} 包含无效的 Mod 记录；源清单未被修改`)
  const normalizedMods = mods.filter((entry): entry is ModpackManagedMod => Boolean(entry))
  if (new Set(normalizedMods.map((entry) => entry.fileName.toLowerCase())).size !== normalizedMods.length) {
    throw new Error(`${MODPACK_MANIFEST} 包含重复的 Mod 文件名；源清单未被修改`)
  }
  const modules = value.modules.map(normalizeModule)
  if (modules.some((entry) => !entry)) throw new Error(`${MODPACK_MANIFEST} 包含无效的自制 Mod 记录；源清单未被修改`)
  const normalizedModules = modules.filter((entry): entry is ModpackLocalModule => Boolean(entry))
  if (new Set(normalizedModules.map((entry) => entry.namespace)).size !== normalizedModules.length) {
    throw new Error(`${MODPACK_MANIFEST} 包含重复的自制 Mod namespace；源清单未被修改`)
  }
  const source = normalizeImportSource(value.source)
  if (value.source !== undefined && !source) throw new Error(`${MODPACK_MANIFEST} 的 source 字段无效；源清单未被修改`)
  const manifest = {
    ...fallback,
    name: value.name.slice(0, 120),
    minecraftVersion: value.minecraftVersion,
    loader: value.loader,
    mods: normalizedMods,
    modules: normalizedModules,
    ...(source ? { source } : {})
  }
  validateManifest(manifest)
  return manifest
}

function validateManifest(manifest: ModpackManifest): void {
  if (manifest.version !== 1 || !Array.isArray(manifest.mods) || !Array.isArray(manifest.modules)) throw new Error(`${MODPACK_MANIFEST} 格式无效`)
  if (manifest.mods.some((entry) => !normalizeMod(entry))) throw new Error(`${MODPACK_MANIFEST} 包含无效的 Mod 记录`)
  if (manifest.modules.some((entry) => !normalizeModule(entry))) throw new Error(`${MODPACK_MANIFEST} 包含无效的自制 Mod 记录`)
  if (new Set(manifest.mods.map((entry) => entry.fileName.toLowerCase())).size !== manifest.mods.length) throw new Error(`${MODPACK_MANIFEST} 包含重复的 Mod 文件名`)
  if (new Set(manifest.modules.map((entry) => entry.namespace)).size !== manifest.modules.length) throw new Error(`${MODPACK_MANIFEST} 包含重复的自制 Mod namespace`)
  if (manifest.source && !normalizeImportSource(manifest.source)) throw new Error(`${MODPACK_MANIFEST} 的 source 字段无效`)
}

export async function createModpackTemplate(project: ProjectInfo): Promise<void> {
  const manifest = createModpackManifest(project)
  await fs.mkdir(path.join(project.path, 'mods'), { recursive: true })
  await fs.mkdir(path.join(project.path, 'modules'), { recursive: true })
  await fs.mkdir(path.join(project.path, 'overrides', 'config'), { recursive: true })
  await fs.writeFile(manifestPath(project), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(project.path, 'README.md'), '# Modpack workspace\n\nManage third-party JARs in `mods/`, pack overrides in `overrides/`, and editable self-made mods in `modules/`.\n', 'utf8')
}

export async function adoptExternalModpack(project: ProjectInfo, source: ModpackImportSource): Promise<ModpackManifest> {
  if (!isModpackProject(project)) throw new Error('The active project is not a modpack')
  const modsDirectory = modpackModsRoot(project, source)
  await fs.mkdir(modsDirectory, { recursive: true })
  await fs.mkdir(path.join(project.path, 'modules'), { recursive: true })
  const entries = await fs.readdir(modsDirectory, { withFileTypes: true }).catch(() => [])
  const mods = (await Promise.all(entries
    .filter((entry) => entry.isFile() && isSafeModJarFileName(entry.name))
    .map(async (entry) => {
      const sourcePath = path.join(modsDirectory, entry.name)
      const stat = await fs.stat(sourcePath)
      return stat.size >= 1_024 ? fileRecord(sourcePath, entry.name) : null
    }))).filter((entry): entry is ModpackManagedMod => Boolean(entry))
  return writeModpackManifest(project, { ...createModpackManifest(project), mods: mods.sort((left, right) => left.fileName.localeCompare(right.fileName)), source })
}

function safeJarFileName(filePath: string): string {
  return safeModJarFileName(path.basename(filePath))
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function fileRecord(filePath: string, fileName: string): Promise<ModpackManagedMod> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size < 1_024) throw new Error(`${fileName} is too small to be a Minecraft mod JAR`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return {
    fileName,
    sha256: hash.digest('hex'),
    size: stat.size,
    addedAt: new Date().toISOString()
  }
}

export async function addModpackFiles(project: ProjectInfo, sources: string[]): Promise<ModpackManifest> {
  const manifest = await readModpackManifest(project)
  const additions = await Promise.all(sources.map(async (source) => {
    const fileName = safeJarFileName(source)
    const target = modpackModsRoot(project, manifest)
    const destination = path.join(target, fileName)
    await fs.mkdir(target, { recursive: true })
    if (path.resolve(source) !== path.resolve(destination)) await fs.copyFile(source, destination)
    return fileRecord(destination, fileName)
  }))
  const mods = new Map(manifest.mods.map((entry) => [entry.fileName.toLowerCase(), entry]))
  for (const entry of additions) mods.set(entry.fileName.toLowerCase(), entry)
  return writeModpackManifest(project, { ...manifest, mods: [...mods.values()].sort((left, right) => left.fileName.localeCompare(right.fileName)) })
}

export async function removeModpackFile(project: ProjectInfo, fileName: string): Promise<ModpackManifest> {
  if (!isSafeModJarFileName(fileName)) throw new Error('Invalid mod file name')
  const manifest = await readModpackManifest(project)
  await fs.rm(path.join(modpackModsRoot(project, manifest), fileName), { force: true })
  const nextManifest = await writeModpackManifest(project, { ...manifest, mods: manifest.mods.filter((entry) => entry.fileName !== fileName) })
  const lock = await readModpackLock(project)
  const normalizedFileName = fileName.toLowerCase()
  if (lock.mods.some((mod) => mod.fileName.toLowerCase() === normalizedFileName)) {
    await writeModpackLock(project, { ...lock, mods: lock.mods.filter((mod) => mod.fileName.toLowerCase() !== normalizedFileName) })
  }
  return nextManifest
}

export async function addModpackModule(project: ProjectInfo, module: ModpackLocalModule): Promise<ModpackManifest> {
  const manifest = await readModpackManifest(project)
  const modules = [...manifest.modules.filter((entry) => entry.namespace !== module.namespace), { ...module, side: module.side ?? 'both' }]
  return writeModpackManifest(project, { ...manifest, modules })
}

export async function updateModpackModuleSide(project: ProjectInfo, namespace: string, side: ModpackModuleSide): Promise<ModpackManifest> {
  if (!/^[a-z0-9_]{1,64}$/.test(namespace) || !['client', 'server', 'both', 'unknown'].includes(side)) throw new Error('invalid self-made mod side')
  const manifest = await readModpackManifest(project)
  if (!manifest.modules.some((module) => module.namespace === namespace)) throw new Error('self-made mod was not found')
  return writeModpackManifest(project, { ...manifest, modules: manifest.modules.map((module) => module.namespace === namespace ? { ...module, side } : module) })
}

async function collectPackEntries(root: string, prefix: string, include: (relative: string) => boolean = () => true): Promise<Array<{ name: string; path: string }>> {
  const entries: Array<{ name: string; path: string }> = []
  const visit = async (directory: string, relative = ''): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true })
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.isSymbolicLink()) continue
      const absolute = path.join(directory, child.name)
      const childRelative = path.posix.join(relative, child.name)
      if (child.isDirectory()) await visit(absolute, childRelative)
      else if (child.isFile() && include(childRelative)) entries.push({ name: path.posix.join(prefix, childRelative), path: absolute })
    }
  }
  await visit(root)
  return entries
}

function isInstanceOverride(relative: string): boolean {
  const top = relative.split('/')[0].toLowerCase()
  return !['.modmind', '.git', 'mods', 'modules', 'logs', 'crash-reports', 'saves', 'screenshots', 'assets', 'libraries', 'versions', 'natives', 'downloads', 'build', 'out', 'run'].includes(top)
    && !['modmind.project.json', 'modmind.pack.json', 'modrinth.index.json', 'manifest.json', 'minecraftinstance.json', 'modlist.html', 'instance.cfg', 'mmc-pack.json'].includes(top)
}

async function collectOverrideFiles(root: string, excludeMods: boolean, managedPaths: Set<string>, relative = ''): Promise<string[]> {
  const files: string[] = []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const childRelative = path.posix.join(relative, entry.name)
    const managed = [...managedPaths].some((value) => childRelative === value || childRelative.startsWith(`${value}/`))
    if (excludeMods && !isInstanceOverride(childRelative) && !managed) continue
    const source = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await collectOverrideFiles(source, excludeMods, managedPaths, childRelative))
    else if (entry.isFile()) files.push(childRelative)
  }
  return files
}

function managedDestination(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'))
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid modpack override path')
  return target
}

/** Copies pack configuration and assets to a managed test instance without touching user-owned files. */
export async function syncModpackOverrides(project: ProjectInfo, destinationRoot: string, previousFiles: string[] = []): Promise<string[]> {
  const manifest = await readModpackManifest(project)
  const sourceRoot = modpackOverridesRoot(project, manifest)
  const managedPaths = new Set((await readManagedModpackContent(project)).items.map((item) => item.path))
  const previous = previousFiles.filter((value) => typeof value === 'string' && safeRelativeOverride(value))
  const files = await collectOverrideFiles(sourceRoot, excludesModsFromOverrides(manifest), managedPaths)
  const current = new Set(files)
  await Promise.all(previous.filter((relative) => !current.has(relative)).map((relative) => fs.rm(managedDestination(destinationRoot, relative), { force: true })))
  for (const relative of files) {
    const source = managedDestination(sourceRoot, relative)
    const destination = managedDestination(destinationRoot, relative)
    const sourceStat = await fs.stat(source)
    const destinationStat = await fs.stat(destination).catch(() => null)
    if (destinationStat?.size === sourceStat.size && await sha256File(source) === await sha256File(destination)) continue
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
  }
  return files
}

function safeRelativeOverride(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return Boolean(normalized) && !normalized.startsWith('/') && !normalized.includes('../') && normalized.split('/').every(Boolean)
}

async function latestModuleJar(project: ProjectInfo, module: ModpackLocalModule): Promise<{ path: string; name: string } | null> {
  const root = path.resolve(project.path, ...module.path.split('/'))
  if (!root.startsWith(`${path.resolve(project.path)}${path.sep}`)) return null
  const output = path.join(root, 'build', 'libs')
  const entries = await fs.readdir(output, { withFileTypes: true }).catch(() => [])
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !/(sources|javadoc|dev|shadow)/i.test(entry.name))
    .map(async (entry) => {
      const source = path.join(output, entry.name)
      return { source, stat: await fs.stat(source) }
    }))
  const latest = candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
  return latest ? { path: latest.source, name: `modmind-local-${module.namespace}.jar` } : null
}

export interface ModpackModuleArtifact {
  module: ModpackLocalModule
  path: string
  fileName: string
}

/** Returns every local module artifact that must accompany the pack at runtime. */
export async function collectBuiltModpackModuleArtifacts(project: ProjectInfo): Promise<ModpackModuleArtifact[]> {
  const manifest = await readModpackManifest(project)
  const artifacts: ModpackModuleArtifact[] = []
  for (const module of manifest.modules) {
    const artifact = await latestModuleJar(project, module)
    if (!artifact) throw new Error(`自制 Mod ${module.name} 尚未构建，请先构建并同步整合包`)
    artifacts.push({ module, path: artifact.path, fileName: artifact.name })
  }
  return artifacts
}

const MAX_MODPACK_EXPORT_FILES = 10_000
const MAX_MODPACK_EXPORT_BYTES = 256 * 1024 * 1024

interface ExportBudget { files: number; bytes: number }

async function readExportEntry(filePath: string, name: string, budget: ExportBudget): Promise<{ name: string; data: Buffer }> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) throw new Error(`整合包导出缺少文件：${name}`)
  if (stat.size > MAX_MODPACK_EXPORT_BYTES || budget.bytes + stat.size > MAX_MODPACK_EXPORT_BYTES) {
    throw new Error(`整合包导出超过 ${MAX_MODPACK_EXPORT_BYTES / 1024 / 1024} MB 安全上限；请移除大型运行时文件后再导出`)
  }
  budget.files += 1
  if (budget.files > MAX_MODPACK_EXPORT_FILES) throw new Error(`整合包导出文件数超过 ${MAX_MODPACK_EXPORT_FILES} 个安全上限`)
  budget.bytes += stat.size
  return { name, data: await fs.readFile(filePath) }
}

function modrinthLoaderDependency(loader: ProjectInfo['loader']): string {
  return loader === 'fabric' ? 'fabric-loader' : loader === 'quilt' ? 'quilt-loader' : loader
}

function modrinthEnvironment(side: 'client' | 'server' | 'both' | 'unknown'): { client: 'required' | 'unsupported'; server: 'required' | 'unsupported' } {
  return {
    client: side === 'server' ? 'unsupported' : 'required',
    server: side === 'client' ? 'unsupported' : 'required'
  }
}

/** Builds a Modrinth pack archive with remote file records where a locked source is available. */
export async function createModrinthPackArchive(project: ProjectInfo, release: { version?: string; summary?: string } = {}): Promise<Buffer> {
  const manifest = await readModpackManifest(project)
  if (await fs.access(path.join(project.path, MODPACK_LOCK_FILE)).then(() => true).catch(() => false)) {
    const lockAudit = await auditModpackLock(project)
    if (!lockAudit.success) throw new Error(`整合包锁定清单审计失败，无法导出：${lockAudit.errors.join('; ')}`)
  }
  if (manifest.source?.unresolvedDependencies) {
    throw new Error(`当前接管的整合包仍缺少 ${manifest.source.unresolvedDependencies} 个外部 Mod 依赖；请从已安装实例补齐 JAR 后再导出`)
  }
  const entries: Array<{ name: string; data: Buffer }> = []
  const budget: ExportBudget = { files: 0, bytes: 0 }
  const lock = await readModpackLock(project)
  const lockedByFile = new Map(lock.mods.map((entry) => [entry.fileName.toLowerCase(), entry]))
  const content = await readManagedModpackContent(project)
  const remoteContent = content.items.filter(isRemoteModpackContent)
  const remotePaths = new Set(remoteContent.map((item) => item.path))
  const files: Array<Record<string, unknown>> = []
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: release.version?.trim() || '0.1.0',
    name: manifest.name,
    summary: release.summary?.trim() || `ModMind modpack for Minecraft ${manifest.minecraftVersion}`,
    dependencies: {
      minecraft: manifest.minecraftVersion,
      [modrinthLoaderDependency(manifest.loader)]: project.loaderVersion ?? ''
    },
    files
  }
  for (const mod of manifest.mods) {
    const source = path.join(modpackModsRoot(project, manifest), mod.fileName)
    const record = await fileRecord(source, mod.fileName).catch((error) => { throw new Error(`整合包清单中的 Mod ${mod.fileName} 无法读取：${error instanceof Error ? error.message : String(error)}`) })
    if (record.size !== mod.size || record.sha256 !== mod.sha256) throw new Error(`整合包清单中的 Mod ${mod.fileName} 已被修改，请重新导入或更新清单`)
    const locked = lockedByFile.get(mod.fileName.toLowerCase())
    if (locked?.sources.length) {
      const hashes = await hashModrinthFile(source)
      files.push({ path: `mods/${mod.fileName}`, hashes: { sha1: hashes.sha1, sha512: hashes.sha512 }, downloads: locked.sources, fileSize: hashes.size, env: modrinthEnvironment(locked.side) })
    } else {
      entries.push(await readExportEntry(source, `overrides/mods/${mod.fileName}`, budget))
    }
  }
  for (const artifact of await collectBuiltModpackModuleArtifacts(project)) {
    entries.push(await readExportEntry(artifact.path, `overrides/mods/${artifact.fileName}`, budget))
  }
  for (const item of remoteContent) {
    files.push({
      path: item.path,
      hashes: { sha1: item.sha1, sha512: item.sha512 },
      downloads: [item.sourceUrl],
      ...(item.size ? { fileSize: item.size } : {}),
      env: modrinthEnvironment(item.scope === 'client' ? 'client' : item.scope === 'server' ? 'server' : 'both')
    })
  }
  const overrides = modpackOverridesRoot(project, manifest)
  if (await fs.stat(overrides).then((stat) => stat.isDirectory()).catch(() => false)) {
    const include = (relative: string): boolean => {
      if (remotePaths.has(relative)) return false
      if (!excludesModsFromOverrides(manifest) || isInstanceOverride(relative)) return true
      return content.items.some((item) => relative === item.path || relative.startsWith(`${item.path}/`))
    }
    const overrideEntries = await collectPackEntries(overrides, 'overrides', include)
    for (const entry of overrideEntries) entries.push(await readExportEntry(entry.path, entry.name, budget))
  }
  entries.push({ name: 'modrinth.index.json', data: Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8') })
  const duplicateNames = entries.map((entry) => entry.name).filter((name, index, all) => all.indexOf(name) !== index)
  if (duplicateNames.length) throw new Error(`整合包导出存在重复路径：${[...new Set(duplicateNames)].slice(0, 3).join('、')}`)
  return createStoredZip(entries.sort((left, right) => left.name.localeCompare(right.name)))
}

async function hashModrinthFile(filePath: string): Promise<{ sha1: string; sha512: string; size: number }> {
  const stat = await fs.stat(filePath)
  const sha1 = createHash('sha1')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) {
    sha1.update(chunk as Buffer)
    sha512.update(chunk as Buffer)
  }
  return { sha1: sha1.digest('hex'), sha512: sha512.digest('hex'), size: stat.size }
}
