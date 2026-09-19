import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import extractZip from 'extract-zip'
import type {
  ModpackContentDelivery,
  ModpackContentDownloadInput,
  ModpackContentDownloadResult,
  ModpackContentImportResult,
  ModpackContentInventory,
  ModpackContentItem,
  ModpackContentKind,
  ModpackContentScope,
  ProjectInfo
} from '../shared/types'
import { recordZipExpansion } from './archiveImportPolicy'
import { verifiedDownload } from './downloadService'

export const MODPACK_CONTENT_INVENTORY_FILE = 'modmind.pack-content.json'

const MAX_CONTENT_FILE_BYTES = 512 * 1024 * 1024
// Large resource packs can legitimately contain tens of thousands of small files.
// Keep the bound finite for directory traversal while avoiding rejection of valid packs.
const MAX_CONTENT_FILE_COUNT = 100_000
const MAX_CONTENT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

const CONTENT_KINDS = new Set<ModpackContentKind>([
  'config', 'scripts', 'datapacks', 'quests', 'resourcepacks', 'shaderpacks', 'ui', 'worlds', 'client', 'server', 'other'
])
const CONTENT_SCOPES = new Set<ModpackContentScope>(['common', 'client', 'server'])
const CONTENT_DELIVERIES = new Set<ModpackContentDelivery>(['embedded', 'remote'])
const RESERVED_TOP_LEVEL = new Set(['mods', 'modules', '.modmind', '.git'])
const INSTANCE_IGNORED_DIRECTORIES = new Set(['mods', 'modules', '.modmind', '.git', '.gradle', 'assets', 'libraries', 'versions', 'natives', 'logs', 'crash-reports', 'screenshots', 'downloads', 'node_modules', 'build', 'out', 'run'])
const INSTANCE_IGNORED_FILES = new Set(['modmind.project.json', 'modmind.pack.json', 'modmind.modpack.lock.json', 'modmind.pack-content.json', 'modrinth.index.json', 'manifest.json', 'minecraftinstance.json', 'modlist.html', 'instance.cfg', 'mmc-pack.json', 'readme.md'])
const MAX_CACHED_INVENTORIES = 4
const inventoryCache = new Map<string, ModpackContentInventory>()
const pendingInventoryLoads = new Map<string, Promise<ModpackContentInventory>>()

function cacheKey(project: ProjectInfo): string {
  const resolved = path.resolve(project.path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function rememberInventory(key: string, inventory: ModpackContentInventory): ModpackContentInventory {
  inventoryCache.delete(key)
  inventoryCache.set(key, inventory)
  while (inventoryCache.size > MAX_CACHED_INVENTORIES) inventoryCache.delete(inventoryCache.keys().next().value!)
  return inventory
}

export function invalidateModpackContentCache(project: ProjectInfo): void {
  inventoryCache.delete(cacheKey(project))
}

function inventoryPath(project: ProjectInfo): string {
  return path.join(project.path, MODPACK_CONTENT_INVENTORY_FILE)
}

function overridesRoot(project: ProjectInfo): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(project.path, 'modmind.pack.json'), 'utf8')) as { source?: { layout?: unknown } }
    if (manifest.source?.layout === 'instance') return project.path
  } catch { /* A malformed manifest is reported by the normal modpack service. */ }
  return path.join(project.path, 'overrides')
}

function normalizeRelative(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || normalized.length > 480 || normalized.startsWith('/') || /^[A-Za-z]:/i.test(normalized)) throw new Error('内容路径无效')
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('内容路径无效')
  if (RESERVED_TOP_LEVEL.has(parts[0].toLowerCase())) throw new Error(`不能由内容工具管理 ${parts[0]} 目录`)
  if (parts.length === 1 && INSTANCE_IGNORED_FILES.has(parts[0].toLowerCase())) throw new Error(`不能由内容工具管理 ${parts[0]} 文件`)
  return normalized
}

function contentTarget(project: ProjectInfo, relative: string): string {
  const root = path.resolve(overridesRoot(project))
  const target = path.resolve(root, ...normalizeRelative(relative).split('/'))
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('内容路径越界')
  return target
}

/** Resolves an inventory path to the project-relative path used by the code editor. */
export function modpackContentProjectPath(project: ProjectInfo, relative: string): string {
  const normalized = normalizeRelative(relative)
  return path.resolve(overridesRoot(project)) === path.resolve(project.path) ? normalized : `overrides/${normalized}`
}

function defaultScope(kind: ModpackContentKind): ModpackContentScope {
  if (['resourcepacks', 'shaderpacks', 'ui', 'client'].includes(kind)) return 'client'
  if (kind === 'server') return 'server'
  return 'common'
}

function defaultDirectory(kind: ModpackContentKind): string {
  switch (kind) {
    case 'config': return 'config'
    case 'scripts': return 'kubejs'
    case 'datapacks': return 'datapacks'
    case 'quests': return 'config/ftbquests'
    case 'resourcepacks': return 'resourcepacks'
    case 'shaderpacks': return 'shaderpacks'
    case 'ui': return 'fancymenu_data'
    case 'worlds': return 'saves'
    case 'server': return 'serverconfig'
    default: return ''
  }
}

function classifyPath(relative: string): ModpackContentKind {
  const normalized = relative.toLowerCase()
  if (normalized.startsWith('config/ftbquests/')) return 'quests'
  if (normalized.startsWith('config/fancymenu/')) return 'ui'
  if (/^(config\/)?openloader\/data\//.test(normalized)) return 'datapacks'
  if (/^(config\/)?openloader\/resources\//.test(normalized)) return 'resourcepacks'
  const top = relative.split('/')[0].toLowerCase()
  if (top === 'config' || top === 'defaultconfigs' || top === 'serverconfig' || top === 'global_packs') return 'config'
  if (top === 'kubejs' || top === 'scripts') return 'scripts'
  if (['datapacks', 'openloader', 'paxi'].includes(top)) return 'datapacks'
  if (top === 'resourcepacks') return 'resourcepacks'
  if (top === 'shaderpacks') return 'shaderpacks'
  if (top === 'saves') return 'worlds'
  if (['fancymenu_data', 'defaultoptions'].includes(top)) return 'ui'
  if (top === 'server.properties' || top === 'serverconfig') return 'server'
  if (top === 'options.txt') return 'client'
  return 'other'
}

/** Register verified downloads without dropping content the user already manages. */
export async function registerImportedPackContent(project: ProjectInfo, files: Array<{ path: string; sha1: string; sourceUrl: string; size: number; scope?: ModpackContentScope }>): Promise<void> {
  const inventory = await readStoredInventory(project)
  const items = new Map(inventory.items.map(item => [item.path, item]))
  for (const file of files) {
    const kind = classifyPath(file.path)
    const hashes = await hashFile(contentTarget(project, file.path))
    if (hashes.sha1 !== file.sha1 || hashes.size !== file.size) throw new Error(`导入内容校验失败：${file.path}`)
    items.set(file.path, { id: itemId(file.path), path: file.path, kind, scope: file.scope ?? defaultScope(kind), delivery: 'remote', ...hashes, sourceUrl: file.sourceUrl, addedAt: new Date().toISOString() })
  }
  if (files.length) await writeStoredInventory(project, { version: 1, items: [...items.values()] })
}

function itemId(relative: string): string {
  return `content:${normalizeRelative(relative)}`
}

function validHash(value: unknown, length: number): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)
}

function normalizeItem(value: unknown): ModpackContentItem | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (
    typeof entry.path !== 'string'
    || !CONTENT_KINDS.has(entry.kind as ModpackContentKind)
    || !CONTENT_SCOPES.has(entry.scope as ModpackContentScope)
    || !CONTENT_DELIVERIES.has(entry.delivery as ModpackContentDelivery)
    || typeof entry.addedAt !== 'string'
  ) return null
  let relative: string
  try { relative = normalizeRelative(entry.path) } catch { return null }
  if (entry.sourceUrl !== undefined && (typeof entry.sourceUrl !== 'string' || !/^https:\/\//i.test(entry.sourceUrl))) return null
  if (entry.sha1 !== undefined && !validHash(entry.sha1, 40)) return null
  if (entry.sha512 !== undefined && !validHash(entry.sha512, 128)) return null
  if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 1 || (entry.size as number) > MAX_CONTENT_FILE_BYTES)) return null
  return {
    id: itemId(relative),
    path: relative,
    kind: entry.kind as ModpackContentKind,
    scope: entry.scope as ModpackContentScope,
    delivery: entry.delivery as ModpackContentDelivery,
    ...(entry.directory === true ? { directory: true } : {}),
    ...(typeof entry.sourceUrl === 'string' ? { sourceUrl: entry.sourceUrl } : {}),
    ...(typeof entry.sha1 === 'string' ? { sha1: entry.sha1.toLowerCase() } : {}),
    ...(typeof entry.sha512 === 'string' ? { sha512: entry.sha512.toLowerCase() } : {}),
    ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    addedAt: entry.addedAt
  }
}

async function readStoredInventory(project: ProjectInfo): Promise<ModpackContentInventory> {
  const parsed = await fs.readFile(inventoryPath(project), 'utf8').then((value) => JSON.parse(value) as Record<string, unknown>).catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT') return null
    throw error
  })
  if (!parsed) return { version: 1, items: [] }
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error(`${MODPACK_CONTENT_INVENTORY_FILE} 格式无效`)
  const items = parsed.items.map(normalizeItem)
  if (items.some((item) => !item)) throw new Error(`${MODPACK_CONTENT_INVENTORY_FILE} 包含无效内容记录`)
  const normalized = items.filter((item): item is ModpackContentItem => Boolean(item))
  if (new Set(normalized.map((item) => item.path)).size !== normalized.length) throw new Error(`${MODPACK_CONTENT_INVENTORY_FILE} 包含重复路径`)
  return { version: 1, items: normalized }
}

async function writeStoredInventory(project: ProjectInfo, inventory: ModpackContentInventory): Promise<ModpackContentInventory> {
  if (inventory.version !== 1 || inventory.items.some((item) => !normalizeItem(item))) throw new Error('内容清单格式无效')
  const target = inventoryPath(project)
  const pending = `${target}.pending-${process.pid}`
  await fs.writeFile(pending, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  try { await fs.rename(pending, target) } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
  invalidateModpackContentCache(project)
  return readStoredInventory(project)
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false)
}

async function hashFile(filePath: string): Promise<{ sha1: string; sha512: string; size: number }> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CONTENT_FILE_BYTES) throw new Error('内容文件大小无效')
  const sha1 = createHash('sha1')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) {
    sha1.update(chunk as Buffer)
    sha512.update(chunk as Buffer)
  }
  return { sha1: sha1.digest('hex'), sha512: sha512.digest('hex'), size: stat.size }
}

async function copyFileChecked(source: string, destination: string, budget: { files: number; bytes: number }): Promise<void> {
  const stat = await fs.stat(source)
  if (!stat.isFile() || stat.size > MAX_CONTENT_FILE_BYTES || budget.bytes + stat.size > MAX_CONTENT_TOTAL_BYTES) throw new Error('导入内容超过大小限制')
  budget.files += 1
  if (budget.files > MAX_CONTENT_FILE_COUNT) throw new Error('导入内容文件数超过安全限制')
  budget.bytes += stat.size
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
}

async function copyDirectoryChecked(source: string, destination: string, budget: { files: number; bytes: number }): Promise<void> {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyDirectoryChecked(from, to, budget)
    else if (entry.isFile()) await copyFileChecked(from, to, budget)
  }
}

function filenameFromUrl(value: string): string {
  const parsed = new URL(value)
  const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  return name && name.length <= 160 ? name : `download-${Date.now()}`
}

function worldDirectoryName(value: string): string {
  const name = value.replace(/\.(?:zip|mcworld)$/i, '').trim()
  return name || `world-${Date.now()}`
}

function targetForDownload(input: ModpackContentDownloadInput): string {
  if (input.targetPath?.trim()) return normalizeRelative(input.targetPath)
  const base = defaultDirectory(input.kind)
  const downloadedName = filenameFromUrl(input.url)
  const fileName = input.kind === 'worlds' && input.extract ? worldDirectoryName(downloadedName) : downloadedName
  return normalizeRelative(base ? `${base}/${fileName}` : fileName)
}

async function validateImportedContent(kind: ModpackContentKind, source: string, directory: boolean): Promise<void> {
  if (kind === 'worlds') {
    if (!directory) throw new Error('世界存档需要选择世界目录')
    const levelDat = await fs.stat(path.join(source, 'level.dat')).catch(() => null)
    if (!levelDat?.isFile()) throw new Error('所选目录不是有效的 Minecraft 世界：缺少 level.dat')
    return
  }

  if (!directory && ['resourcepacks', 'shaderpacks'].includes(kind) && path.extname(source).toLowerCase() !== '.zip') {
    throw new Error(kind === 'resourcepacks' ? '资源包必须导入 ZIP 文件' : '光影包必须导入 ZIP 文件')
  }
}

async function replacePath(source: string, destination: string): Promise<void> {
  const pending = `${destination}.pending-${randomUUID()}`
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.rm(pending, { recursive: true, force: true }).catch(() => undefined)
  await fs.rename(source, pending)
  try {
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(pending, destination)
  } finally {
    await fs.rm(pending, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function discoverContent(project: ProjectInfo, indexed: Set<string>): Promise<ModpackContentItem[]> {
  const root = overridesRoot(project)
  const output: ModpackContentItem[] = []
  let files = 0
  const visit = async (directory: string, relative = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const child = relative ? `${relative}/${entry.name}` : entry.name
      const source = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (child.split('/')[0].toLowerCase() === 'mods') continue
        if (root === project.path && INSTANCE_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        const parts = child.split('/')
        if (parts[0] === 'saves' && parts.length === 2) {
          if (!indexed.has(child)) output.push({ id: itemId(child), path: child, kind: 'worlds', scope: 'common', delivery: 'embedded', directory: true, addedAt: new Date().toISOString() })
          continue
        }
        await visit(source, child)
      } else if (entry.isFile()) {
        if (root === project.path && INSTANCE_IGNORED_FILES.has(entry.name.toLowerCase())) continue
        files += 1
        if (files > MAX_CONTENT_FILE_COUNT) throw new Error('覆盖内容文件数超过安全限制')
        if (!indexed.has(child)) {
          const stat = await fs.stat(source).catch(() => null)
          if (!stat?.isFile()) continue
          output.push({ id: itemId(child), path: child, kind: classifyPath(child), scope: defaultScope(classifyPath(child)), delivery: 'embedded', size: stat.size, addedAt: stat.mtime.toISOString() })
        }
      }
    }
  }
  await visit(root)
  return output
}

export async function listModpackContent(project: ProjectInfo, refresh = false): Promise<ModpackContentInventory> {
  const key = cacheKey(project)
  const cached = inventoryCache.get(key)
  if (cached && !refresh) return rememberInventory(key, cached)
  const pending = pendingInventoryLoads.get(key)
  if (pending) return pending
  const request = (async (): Promise<ModpackContentInventory> => {
    const stored = await readStoredInventory(project)
    const live = await discoverContent(project, new Set(stored.items.map((item) => item.path)))
    return rememberInventory(key, { version: 1, items: [...stored.items, ...live].sort((left, right) => left.path.localeCompare(right.path)) })
  })()
  pendingInventoryLoads.set(key, request)
  try {
    return await request
  } finally {
    if (pendingInventoryLoads.get(key) === request) pendingInventoryLoads.delete(key)
  }
}

/** Returns only entries explicitly added through a ModMind content tool. */
export async function readManagedModpackContent(project: ProjectInfo): Promise<ModpackContentInventory> {
  return readStoredInventory(project)
}

export async function importModpackContent(
  project: ProjectInfo,
  kind: ModpackContentKind,
  sources: string[],
  scope: ModpackContentScope = defaultScope(kind)
): Promise<ModpackContentImportResult> {
  if (!CONTENT_KINDS.has(kind) || !CONTENT_SCOPES.has(scope)) throw new Error('内容类型或作用域无效')
  if (!sources.length) return { items: [], copiedFiles: 0 }
  const stored = await readStoredInventory(project)
  const additions: ModpackContentItem[] = []
  const budget = { files: 0, bytes: 0 }
  for (const source of sources) {
    const stat = await fs.stat(source)
    const directory = stat.isDirectory()
    if (!directory && !stat.isFile()) throw new Error('只能导入普通文件或目录')
    await validateImportedContent(kind, source, directory)
    const base = defaultDirectory(kind)
    const relative = normalizeRelative(base ? `${base}/${path.basename(source)}` : path.basename(source))
    const destination = contentTarget(project, relative)
    const staging = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'content-import', randomUUID())
    await fs.mkdir(staging, { recursive: true })
    try {
      const staged = path.join(staging, path.basename(source))
      if (directory) await copyDirectoryChecked(source, staged, budget)
      else await copyFileChecked(source, staged, budget)
      await replacePath(staged, destination)
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    if (directory) {
      additions.push({ id: itemId(relative), path: relative, kind, scope, delivery: 'embedded', directory: true, size: budget.bytes, addedAt: new Date().toISOString() })
    } else {
      const hashes = await hashFile(destination)
      additions.push({ id: itemId(relative), path: relative, kind, scope, delivery: 'embedded', sha1: hashes.sha1, sha512: hashes.sha512, size: hashes.size, addedAt: new Date().toISOString() })
    }
  }
  const paths = new Set(additions.map((item) => item.path))
  await writeStoredInventory(project, { version: 1, items: [...stored.items.filter((item) => !paths.has(item.path)), ...additions] })
  return { items: additions, copiedFiles: budget.files }
}

export async function downloadModpackContent(project: ProjectInfo, input: ModpackContentDownloadInput): Promise<ModpackContentDownloadResult> {
  if (!CONTENT_KINDS.has(input.kind) || !/^https:\/\//i.test(input.url)) throw new Error('只允许使用 HTTPS 下载地址')
  const scope = input.scope && CONTENT_SCOPES.has(input.scope) ? input.scope : defaultScope(input.kind)
  const relative = targetForDownload(input)
  const extractWorld = Boolean(input.extract && input.kind === 'worlds')
  if (input.extract && !extractWorld) throw new Error('只有世界存档允许下载后解压')
  if (extractWorld && !relative.startsWith('saves/')) throw new Error('世界存档必须保存到 saves/ 目录')
  const staging = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'content-downloads', randomUUID())
  await fs.mkdir(staging, { recursive: true })
  const downloaded = path.join(staging, filenameFromUrl(input.url))
  try {
    const result = await verifiedDownload.download({
      sources: [{ id: 'content-url', label: new URL(input.url).host, url: input.url }],
      destination: downloaded,
      maxBytes: MAX_CONTENT_FILE_BYTES,
      retriesPerSource: 2,
      timeoutMs: 120_000
    })
    const hashes = await hashFile(downloaded)
    let item: ModpackContentItem
    let extractedFiles: number | undefined
    if (extractWorld) {
      const extracted = path.join(staging, 'extracted')
      const state = { entryCount: 0, expandedBytes: 0 }
      await extractZip(downloaded, {
        dir: extracted,
        onEntry: (entry) => recordZipExpansion(state, { fileName: entry.fileName, uncompressedSize: entry.uncompressedSize })
      })
      const roots = (await fs.readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      const source = roots.length === 1 ? path.join(extracted, roots[0].name) : extracted
      await validateImportedContent('worlds', source, true)
      const destination = contentTarget(project, relative)
      await replacePath(source, destination)
      extractedFiles = state.entryCount
      item = { id: itemId(relative), path: relative, kind: input.kind, scope, delivery: 'embedded', directory: true, sourceUrl: input.url, sha1: hashes.sha1, sha512: hashes.sha512, size: hashes.size, addedAt: new Date().toISOString() }
    } else {
      const destination = contentTarget(project, relative)
      await replacePath(downloaded, destination)
      item = { id: itemId(relative), path: relative, kind: input.kind, scope, delivery: 'remote', sourceUrl: input.url, sha1: hashes.sha1, sha512: hashes.sha512, size: hashes.size, addedAt: new Date().toISOString() }
    }
    const stored = await readStoredInventory(project)
    await writeStoredInventory(project, { version: 1, items: [...stored.items.filter((entry) => entry.path !== item.path), item] })
    return { item, downloadedBytes: result.bytes, ...(extractedFiles ? { extractedFiles } : {}) }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function removeModpackContent(project: ProjectInfo, id: string): Promise<ModpackContentInventory> {
  const inventory = await listModpackContent(project)
  const target = inventory.items.find((item) => item.id === id)
  if (!target) throw new Error('找不到内容记录')
  await fs.rm(contentTarget(project, target.path), { recursive: true, force: true })
  const stored = await readStoredInventory(project)
  await writeStoredInventory(project, { version: 1, items: stored.items.filter((item) => item.path !== target.path) })
  return listModpackContent(project)
}

export function isRemoteModpackContent(item: ModpackContentItem): boolean {
  return item.delivery === 'remote' && Boolean(item.sourceUrl && item.sha1 && item.sha512) && !item.directory
}
