import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { JavaLoaderKind, ModpackImportFormat, ModpackLayout } from '../shared/types'
import { verifiedDownload } from './downloadService'

const PACK_CONTENT_DIRECTORIES = new Set([
  'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'resourcepacks', 'shaderpacks',
  'datapacks', 'global_packs', 'openloader', 'patchouli_books', 'fancymenu_data', 'paxi', 'defaultoptions'
])
const RUNTIME_DIRECTORIES = new Set([
  '.modmind', '.git', '.gradle', 'assets', 'libraries', 'versions', 'natives', 'logs',
  'crash-reports', 'saves', 'screenshots', 'downloads', 'node_modules', 'build', 'out', 'run'
])
const PACK_METADATA_FILES = new Set(['modmind.project.json', 'modmind.pack.json', 'modrinth.index.json', 'manifest.json', 'minecraftinstance.json', 'modlist.html', 'instance.cfg', 'mmc-pack.json'])
const MAX_REMOTE_FILE_BYTES = 512 * 1024 * 1024
const MAX_REMOTE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_IMPORT_FILE_COUNT = 100_000
const MAX_IMPORT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

interface ModrinthFile {
  path?: unknown
  downloads?: unknown
  hashes?: unknown
}

interface ModrinthIndex {
  name?: unknown
  dependencies?: unknown
  files?: unknown
}

interface CurseForgeManifest {
  name?: unknown
  minecraft?: { version?: unknown; modLoaders?: unknown }
  files?: unknown
}

interface MmcPack {
  components?: unknown
}

export interface ExternalModpackInspection {
  root: string
  format: ModpackImportFormat
  layout: ModpackLayout
  name?: string
  loader?: JavaLoaderKind
  loaderVersion?: string
  minecraftVersion?: string
  localModFiles: string[]
  overrideFiles: string[]
  unresolvedDependencyCount: number
  warnings: string[]
  remoteFiles: Array<{ path: string; downloads: string[]; hashes: Record<string, string> }>
}

export interface ExternalModpackMaterialization {
  copiedFiles: number
  downloadedFiles: number
  unresolvedDependencyCount: number
  warnings: string[]
}

export interface ExternalModpackMaterializationProgress {
  path: string
  fileIndex: number
  fileCount: number
  phase: 'checking' | 'downloading' | 'completed'
  sourceLabel?: string
  attempt?: number
  attemptsPerSource?: number
}

export interface ExternalModpackMaterializationOptions {
  trackDownloadActivities?: boolean
  onProgress?: (progress: ExternalModpackMaterializationProgress) => void
}

function isDirectory(value: Awaited<ReturnType<typeof fs.stat>> | null): boolean {
  return Boolean(value?.isDirectory())
}

async function pathIsDirectory(target: string): Promise<boolean> {
  return isDirectory(await fs.stat(target).catch(() => null))
}

async function readJson<T>(target: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(target, 'utf8')) as T } catch { return null }
}

function minecraftVersion(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : ''
  return text.match(/\b\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\b/)?.[0]
}

function loaderFromText(value: unknown): JavaLoaderKind | undefined {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text.includes('neoforge') || text.includes('neoforged')) return 'neoforge'
  if (text.includes('forge')) return 'forge'
  if (text.includes('quilt')) return 'quilt'
  if (text.includes('fabric')) return 'fabric'
  return undefined
}

function cleanLoaderVersion(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= 120 && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(text) ? text : undefined
}

function inferDependencyLoader(value: unknown): { loader?: JavaLoaderKind; loaderVersion?: string } {
  const dependencies = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const loader = loaderFromText(Object.keys(dependencies).join(' '))
  if (!loader) return {}
  const match = Object.entries(dependencies).find(([key]) => loaderFromText(key) === loader)
  return { loader, loaderVersion: cleanLoaderVersion(match?.[1]) }
}

function loaderVersionFromId(value: unknown, loader: JavaLoaderKind | undefined): string | undefined {
  if (typeof value !== 'string' || !loader) return undefined
  const prefix = loader === 'neoforge'
    ? /^(?:neoforge|neoforged)(?:-loader)?[-_:](.+)$/i
    : loader === 'fabric'
      ? /^fabric(?:-loader)?[-_:](.+)$/i
      : loader === 'quilt'
        ? /^quilt(?:-loader)?[-_:](.+)$/i
        : /^forge(?:-loader)?[-_:](.+)$/i
  return cleanLoaderVersion(value.trim().match(prefix)?.[1])
}

function cleanName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : undefined
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (normalized.length > 480 || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null
  const top = normalized.split('/')[0].toLowerCase()
  if (RUNTIME_DIRECTORIES.has(top) || PACK_METADATA_FILES.has(top)) return null
  return normalized
}

function isPackContentFile(relative: string): boolean {
  const top = relative.split('/')[0].toLowerCase()
  if (PACK_CONTENT_DIRECTORIES.has(top)) return true
  if (relative.includes('/') || PACK_METADATA_FILES.has(top) || top.startsWith('.')) return false
  return ['.cfg', '.conf', '.json', '.toml', '.properties', '.txt', '.yml', '.yaml', '.mcmeta', '.dat'].includes(path.extname(top).toLowerCase())
}

async function scanFiles(root: string, predicate: (relative: string) => boolean): Promise<string[]> {
  const output: string[] = []
  const queue = [{ directory: root, relative: '' }]
  while (queue.length) {
    const current = queue.shift()!
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = path.posix.join(current.relative, entry.name)
      if (entry.isDirectory()) {
        const top = relative.split('/')[0].toLowerCase()
        if (!RUNTIME_DIRECTORIES.has(top)) queue.push({ directory: path.join(current.directory, entry.name), relative })
      } else if (entry.isFile() && predicate(relative)) {
        if (output.length >= MAX_IMPORT_FILE_COUNT) throw new Error(`整合包文件数超过 ${MAX_IMPORT_FILE_COUNT} 个安全限制`)
        output.push(relative)
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right))
}

async function findInstanceRoot(source: string): Promise<{ root: string; format: ModpackImportFormat }> {
  const nested = path.join(source, '.minecraft')
  if (await pathIsDirectory(nested)) {
    const format: ModpackImportFormat = await pathIsDirectory(path.join(source, 'prismlauncher.cfg')) || await fs.access(path.join(source, 'mmc-pack.json')).then(() => true).catch(() => false)
      ? 'prism'
      : await fs.access(path.join(source, 'instance.cfg')).then(() => true).catch(() => false)
        ? 'multimc'
        : 'instance'
    return { root: nested, format }
  }
  return { root: source, format: 'instance' }
}

function parseModrinthFiles(value: unknown): Array<{ path: string; downloads: string[]; hashes: Record<string, string> }> {
  if (!Array.isArray(value)) throw new Error('Modrinth 清单缺少有效的 files 数组')
  const files: Array<{ path: string; downloads: string[]; hashes: Record<string, string> }> = []
  for (const [index, entry] of (value as ModrinthFile[]).entries()) {
    const relative = safeRelativePath(entry?.path)
    if (!relative) throw new Error(`Modrinth 清单第 ${index + 1} 个文件路径无效`)
    if (!Array.isArray(entry.downloads) || entry.downloads.some((url) => typeof url !== 'string' || !/^https:\/\//i.test(url))) {
      throw new Error(`Modrinth 文件 ${relative} 只能使用 HTTPS 下载地址`)
    }
    const downloads = Array.isArray(entry.downloads)
      ? entry.downloads.filter((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url))
      : []
    if (!downloads.length) throw new Error(`Modrinth 文件 ${relative} 没有 HTTPS 下载地址`)
    const hashes = entry.hashes && typeof entry.hashes === 'object'
      ? Object.fromEntries(Object.entries(entry.hashes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[a-f0-9]{32,128}$/i.test(entry[1]))
        .map(([algorithm, hash]) => [algorithm.toLowerCase(), hash.toLowerCase()]))
      : {}
    const sha1 = hashes.sha1
    const sha512 = hashes.sha512
    if (!sha1 && !sha512) throw new Error(`Modrinth 文件 ${relative} 缺少 sha1 或 sha512 校验值`)
    if (sha1 && !/^[a-f0-9]{40}$/i.test(sha1)) throw new Error(`Modrinth 文件 ${relative} 的 sha1 无效`)
    if (sha512 && !/^[a-f0-9]{128}$/i.test(sha512)) throw new Error(`Modrinth 文件 ${relative} 的 sha512 无效`)
    // 国内网络经常无法直连 Modrinth CDN。保留官方地址作为首选，追加可用的
    // 代理镜像；镜像通过环境变量可替换，便于发行版按地区配置稳定节点。
    const mirror = (process.env.MODMIND_MODRINTH_MIRROR ?? '').trim().replace(/\/+$/, '')
    const fallbackMirrors = mirror ? [mirror] : ['https://ghproxy.net/https://cdn.modrinth.com']
    const expandedDownloads = [...downloads]
    for (const url of downloads) {
      for (const base of fallbackMirrors) {
        if (!base || url.startsWith(base)) continue
        try {
          const parsed = new URL(url)
          const mirrored = base.includes('ghproxy.net/https://') ? `${base}${parsed.pathname}${parsed.search}` : `${base}${parsed.pathname}${parsed.search}`
          if (!expandedDownloads.includes(mirrored)) expandedDownloads.push(mirrored)
        } catch { /* validated HTTPS URL above */ }
      }
    }
    files.push({ path: relative, downloads: expandedDownloads, hashes: Object.fromEntries(Object.entries(hashes).filter(([algorithm]) => algorithm === 'sha1' || algorithm === 'sha512')) })
  }
  return files
}

function inferMmcLoader(value: MmcPack | null): { loader?: JavaLoaderKind; loaderVersion?: string; minecraftVersion?: string } {
  const components = Array.isArray(value?.components) ? value!.components : []
  let loader: JavaLoaderKind | undefined
  let loaderVersion: string | undefined
  let version: string | undefined
  for (const component of components) {
    if (!component || typeof component !== 'object') continue
    const record = component as Record<string, unknown>
    const uid = typeof record.uid === 'string' ? record.uid : ''
    const componentLoader = loaderFromText(uid)
    if (!loader && componentLoader) {
      loader = componentLoader
      loaderVersion = cleanLoaderVersion(record.version)
    }
    if (uid === 'net.minecraft') version ||= minecraftVersion(record.version)
  }
  return { loader, loaderVersion, minecraftVersion: version }
}

export async function inspectExternalModpack(sourcePath: string): Promise<ExternalModpackInspection | null> {
  const selectedRoot = path.resolve(sourcePath)
  const looksLikeJavaMod = (await Promise.all(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].map((file) => fs.access(path.join(selectedRoot, file)).then(() => true).catch(() => false)))).some(Boolean)
    && await pathIsDirectory(path.join(selectedRoot, 'src', 'main'))
    && (await Promise.all(['fabric.mod.json', 'quilt.mod.json', 'mods.toml', 'neoforge.mods.toml'].map((file) => fs.access(path.join(selectedRoot, 'src', 'main', 'resources', file)).then(() => true).catch(() => false)))).some(Boolean)
  if (looksLikeJavaMod) return null
  const modrinth = await readJson<ModrinthIndex>(path.join(selectedRoot, 'modrinth.index.json'))
  const curseforge = await readJson<CurseForgeManifest>(path.join(selectedRoot, 'manifest.json'))
  const hasModrinthIndex = await fs.access(path.join(selectedRoot, 'modrinth.index.json')).then(() => true).catch(() => false)
  const hasCurseForgeManifest = await fs.access(path.join(selectedRoot, 'manifest.json')).then(() => true).catch(() => false)
  if (hasModrinthIndex && !modrinth) throw new Error('Modrinth 清单无法解析，未创建或覆盖任何项目文件')
  if (hasCurseForgeManifest && !curseforge) throw new Error('CurseForge 清单无法解析，未创建或覆盖任何项目文件')
  const instance = await findInstanceRoot(selectedRoot)
  const mmc = await readJson<MmcPack>(path.join(selectedRoot, 'mmc-pack.json'))
  const hasContent = await Promise.all([...PACK_CONTENT_DIRECTORIES].map((name) => pathIsDirectory(path.join(instance.root, name))))
  const directContent = hasContent.some(Boolean) || await fs.access(path.join(instance.root, 'options.txt')).then(() => true).catch(() => false)
  if (!modrinth && !curseforge && !directContent) {
    const bareEntries = await fs.readdir(selectedRoot, { withFileTypes: true }).catch(() => [])
    const bareJars = bareEntries.filter((entry) => entry.isFile() && /^.+\.jar$/i.test(entry.name))
    if (!bareJars.length) return null
    const bareRoot = path.dirname(selectedRoot)
    const relative = bareJars.map((entry) => `mods/${entry.name}`)
    return {
      root: bareRoot,
      format: 'instance',
      layout: 'instance',
      name: path.basename(bareRoot),
      localModFiles: relative,
      overrideFiles: [],
      unresolvedDependencyCount: 0,
      warnings: ['仅检测到裸 mods 文件夹，Minecraft 版本和 Loader 无法从 JAR 可靠推断；接管前必须确认'],
      remoteFiles: []
    }
  }

  let format: ModpackImportFormat = instance.format
  let root = instance.root
  let name = path.basename(selectedRoot)
  let loader: JavaLoaderKind | undefined
  let loaderVersion: string | undefined
  let version: string | undefined
  let remoteFiles: ExternalModpackInspection['remoteFiles'] = []
  let unresolvedDependencyCount = 0
  const warnings: string[] = []

  if (modrinth) {
    format = 'modrinth'
    root = selectedRoot
    name = cleanName(modrinth.name) ?? name
    const dependencies = modrinth.dependencies && typeof modrinth.dependencies === 'object' ? modrinth.dependencies as Record<string, unknown> : {}
    version = minecraftVersion(dependencies.minecraft)
    const inferred = inferDependencyLoader(dependencies)
    loader = inferred.loader
    loaderVersion = inferred.loaderVersion
    remoteFiles = parseModrinthFiles(modrinth.files)
    if (!remoteFiles.length) warnings.push('Modrinth 清单没有可下载的远程文件')
  } else if (curseforge) {
    format = 'curseforge'
    root = selectedRoot
    name = cleanName(curseforge.name) ?? name
    version = minecraftVersion(curseforge.minecraft?.version)
    const loaders = Array.isArray(curseforge.minecraft?.modLoaders) ? curseforge.minecraft!.modLoaders : []
    const loaderIds = loaders.map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).id ?? '') : '')
    loader = loaderFromText(loaderIds.join(' '))
    loaderVersion = loaderVersionFromId(loaderIds.find((id) => loaderFromText(id) === loader), loader)
    const listedFiles = Array.isArray(curseforge.files) ? curseforge.files.length : 0
    unresolvedDependencyCount = listedFiles
    if (listedFiles) warnings.push(`CurseForge 清单引用 ${listedFiles} 个依赖；只有选择已安装的实例目录或配置 CurseForge API 后才能下载这些 JAR`)
  } else {
    const inferred = inferMmcLoader(mmc)
    loader = inferred.loader
    loaderVersion = inferred.loaderVersion
    version = inferred.minecraftVersion
    if (mmc) format = await fs.access(path.join(selectedRoot, 'instance.cfg')).then(() => 'multimc' as const).catch(() => 'prism' as const)
    if (instance.format === 'instance' && await fs.access(path.join(selectedRoot, 'hmclversion.json')).then(() => true).catch(() => false)) format = 'hmcl'
    if (instance.format === 'instance' && await fs.access(path.join(selectedRoot, 'PCL')).then(() => true).catch(() => false)) format = 'pcl'
  }

  const archiveLayout = Boolean((modrinth || curseforge)
    && await pathIsDirectory(path.join(root, 'overrides'))
    && !await pathIsDirectory(path.join(root, 'mods')))
  const localModFiles = archiveLayout
    ? await scanFiles(path.join(root, 'overrides'), (relative) => /^mods\/[^/]+\.jar$/i.test(relative)).then((files) => files.map((relative) => `overrides/${relative}`))
    : await scanFiles(root, (relative) => /^mods\/[^/]+\.jar$/i.test(relative))
  const overrideFiles = (modrinth || archiveLayout)
    ? (await Promise.all((modrinth ? ['overrides', 'client-overrides', 'server-overrides'] : ['overrides']).map(async (prefix) => (await scanFiles(path.join(root, prefix), (relative) => !/^mods(?:\/|$)/i.test(relative)).catch(() => [])).map((entry) => `${prefix}/${entry}`)))).flat()
    : await scanFiles(root, isPackContentFile).then((files) => files.filter((relative) => !/^mods\/[^/]+\.jar$/i.test(relative)))
  if (!localModFiles.length && !remoteFiles.length && !overrideFiles.length) return null

  if (!loader) warnings.push('未能自动识别加载器，请在接管前确认 Fabric、Forge、NeoForge 或 Quilt')
  if (!version) warnings.push('未能自动识别 Minecraft 版本，请在接管前确认')
  if (curseforge && localModFiles.length) unresolvedDependencyCount = Math.max(0, unresolvedDependencyCount - localModFiles.length)
  return {
    root,
    format,
    layout: archiveLayout ? 'archive' : 'instance',
    name,
    loader,
    loaderVersion,
    minecraftVersion: version,
    localModFiles,
    overrideFiles,
    unresolvedDependencyCount,
    warnings,
    remoteFiles
  }
}

async function copyFile(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}

async function copyDirectory(source: string, target: string, budget: { files: number; bytes: number } = { files: 0, bytes: 0 }): Promise<number> {
  let copied = 0
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copied += await copyDirectory(from, to, budget)
    else if (entry.isFile()) {
      const stat = await fs.stat(from)
      if (stat.size > MAX_REMOTE_FILE_BYTES || budget.bytes + stat.size > MAX_IMPORT_TOTAL_BYTES) throw new Error(`整合包本地文件超过 ${MAX_IMPORT_TOTAL_BYTES / 1024 / 1024 / 1024} GB 安全限制`)
      if (budget.files >= MAX_IMPORT_FILE_COUNT) throw new Error(`整合包文件数超过 ${MAX_IMPORT_FILE_COUNT} 个安全限制`)
      await copyFile(from, to)
      copied += 1
      budget.files += 1
      budget.bytes += stat.size
    }
  }
  return copied
}

async function downloadRemoteFile(
  entry: ExternalModpackInspection['remoteFiles'][number],
  target: string,
  budget: { bytes: number },
  options: ExternalModpackMaterializationOptions,
  fileIndex: number,
  fileCount: number
): Promise<void> {
  const existingStat = await fs.stat(target).catch(() => null)
  if (existingStat?.isFile() && existingStat.size > MAX_REMOTE_FILE_BYTES) throw new Error(`existing file exceeds the single-file limit: ${entry.path}`)
  if (await matchesRemoteHash(target, entry)) return
  const expectedHash = entry.hashes.sha512 ? { algorithm: 'sha512' as const, value: entry.hashes.sha512 } : entry.hashes.sha1 ? { algorithm: 'sha1' as const, value: entry.hashes.sha1 } : undefined
  const remaining = MAX_REMOTE_TOTAL_BYTES - budget.bytes
  if (remaining <= 0) throw new Error('pack download total exceeds the safety limit')
  const result = await verifiedDownload.download({
    sources: entry.downloads.map((url, index) => ({ id: `pack-${index + 1}`, label: `pack source ${index + 1}`, url })),
    destination: target,
    expectedHash,
    maxBytes: Math.min(MAX_REMOTE_FILE_BYTES, remaining),
    retriesPerSource: 2,
    timeoutMs: 120_000,
    trackActivity: options.trackDownloadActivities !== false,
    onAttempt: ({ source, attempt, attemptsPerSource }) => options.onProgress?.({
      path: entry.path,
      fileIndex,
      fileCount,
      phase: 'downloading',
      sourceLabel: source.label,
      attempt,
      attemptsPerSource
    })
  })
  budget.bytes += result.bytes
}

async function matchesRemoteHash(filePath: string, entry: ExternalModpackInspection['remoteFiles'][number]): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size > MAX_REMOTE_FILE_BYTES) return false
  const hashes = Object.fromEntries(Object.entries(entry.hashes).map(([algorithm, expected]) => [algorithm, { expected, hash: createHash(algorithm) }]))
  for await (const chunk of createReadStream(filePath)) {
    for (const value of Object.values(hashes)) value.hash.update(chunk as Buffer)
  }
  const values = Object.values(hashes)
  return values.length > 0 && values.every((value) => value.hash.digest('hex') === value.expected)
}

function destinationFor(targetRoot: string, relative: string): string {
  const target = path.resolve(targetRoot, ...relative.split('/'))
  if (!target.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) throw new Error('整合包文件路径无效')
  return target
}

export async function materializeExternalModpack(
  inspection: ExternalModpackInspection,
  targetRoot: string,
  options: ExternalModpackMaterializationOptions = {}
): Promise<ExternalModpackMaterialization> {
  const target = path.resolve(targetRoot)
  const source = path.resolve(inspection.root)
  let copiedFiles = 0
  let downloadedFiles = 0
  const localBudget = { files: 0, bytes: 0 }
  if (source !== target) {
    const installedInstance = (inspection.format === 'modrinth' || inspection.format === 'curseforge') && inspection.layout !== 'archive' && await pathIsDirectory(path.join(source, 'mods'))
    if (inspection.layout === 'archive') {
      const from = path.join(source, 'overrides')
      if (await pathIsDirectory(from)) copiedFiles += await copyDirectory(from, path.join(target, 'overrides'), localBudget)
      for (const directory of ['client-overrides', 'server-overrides']) {
        const scoped = path.join(source, directory)
        if (await pathIsDirectory(scoped)) copiedFiles += await copyDirectory(scoped, path.join(target, 'overrides'), localBudget)
      }
    } else if ((inspection.format === 'modrinth' || inspection.format === 'curseforge') && !installedInstance) {
      for (const directory of ['overrides', 'client-overrides', 'server-overrides']) {
        const from = path.join(source, directory)
        if (await pathIsDirectory(from)) copiedFiles += await copyDirectory(from, target, localBudget)
      }
    } else {
      const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isSymbolicLink() || RUNTIME_DIRECTORIES.has(entry.name.toLowerCase()) || PACK_METADATA_FILES.has(entry.name.toLowerCase())) continue
        const from = path.join(source, entry.name)
        const to = path.join(target, entry.name)
        if (entry.isDirectory()) copiedFiles += await copyDirectory(from, to, localBudget)
        else if (entry.isFile()) {
          const stat = await fs.stat(from)
          if (stat.size > MAX_REMOTE_FILE_BYTES || localBudget.bytes + stat.size > MAX_IMPORT_TOTAL_BYTES) throw new Error(`整合包本地文件超过 ${MAX_IMPORT_TOTAL_BYTES / 1024 / 1024 / 1024} GB 安全限制`)
          if (localBudget.files >= MAX_IMPORT_FILE_COUNT) throw new Error(`整合包文件数超过 ${MAX_IMPORT_FILE_COUNT} 个安全限制`)
          await copyFile(from, to)
          copiedFiles += 1
          localBudget.files += 1
          localBudget.bytes += stat.size
        }
      }
    }
  }
  const budget = { bytes: 0 }
  const remoteStaging = source === target ? await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-remote-')) : ''
  const downloadedPaths: Array<{ staged: string; target: string }> = []
  try {
    for (const [index, entry] of inspection.remoteFiles.entries()) {
      const fileIndex = index + 1
      const fileCount = inspection.remoteFiles.length
      options.onProgress?.({ path: entry.path, fileIndex, fileCount, phase: 'checking' })
      const relative = inspection.layout === 'archive' ? `overrides/${entry.path}` : entry.path
      const finalPath = destinationFor(target, relative)
      if (source === target && await matchesRemoteHash(finalPath, entry)) {
        options.onProgress?.({ path: entry.path, fileIndex, fileCount, phase: 'completed' })
        continue
      }
      const stagedPath = remoteStaging ? destinationFor(remoteStaging, relative) : finalPath
      await downloadRemoteFile(entry, stagedPath, budget, options, fileIndex, fileCount)
      downloadedPaths.push({ staged: stagedPath, target: finalPath })
      downloadedFiles += 1
      options.onProgress?.({ path: entry.path, fileIndex, fileCount, phase: 'completed' })
    }
    for (const entry of downloadedPaths) {
      await fs.mkdir(path.dirname(entry.target), { recursive: true })
      await fs.rm(entry.target, { force: true })
      await fs.rename(entry.staged, entry.target)
    }
  } finally {
    if (remoteStaging) await fs.rm(remoteStaging, { recursive: true, force: true }).catch(() => undefined)
  }
  return { copiedFiles, downloadedFiles, unresolvedDependencyCount: inspection.unresolvedDependencyCount, warnings: inspection.warnings }
}
