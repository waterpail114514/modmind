import { invalidateModpackContentCache, inventoryCache, cacheKey, registerImportedPackContent, readStoredInventory, inventoryPath, MODPACK_CONTENT_INVENTORY_FILE, normalizeItem, CONTENT_KINDS, CONTENT_SCOPES, CONTENT_DELIVERIES, normalizeRelative, RESERVED_TOP_LEVEL, INSTANCE_IGNORED_FILES, validHash, MAX_CONTENT_FILE_BYTES, itemId, classifyPath, hashFile, contentTarget, overridesRoot, defaultScope, writeStoredInventory, readManagedModpackContent, isRemoteModpackContent } from '../../../../src/main/modpackContentMetadata'
export { invalidateModpackContentCache, registerImportedPackContent, MODPACK_CONTENT_INVENTORY_FILE, readManagedModpackContent, isRemoteModpackContent } from '../../../../src/main/modpackContentMetadata'
import { serializeProjectMutation } from '../../../../src/main/projectMutation'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import extractZip from '../../../../src/main/safeExtractZip'
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
} from '../../../../src/shared/types'
import { recordZipExpansion } from '../../../../src/main/archiveImportPolicy'
import { verifiedDownload } from '../../../../src/main/downloadService'
import { assertContentTarget, installContentTransaction } from '../../../../src/main/contentInstallTransaction'
// Large resource packs can legitimately contain tens of thousands of small files.
// Keep the bound finite for directory traversal while avoiding rejection of valid packs.
const MAX_CONTENT_FILE_COUNT = 100_000
const MAX_CONTENT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const INSTANCE_IGNORED_DIRECTORIES = new Set(['mods', 'modules', '.modmind', '.git', '.gradle', 'assets', 'libraries', 'versions', 'natives', 'logs', 'crash-reports', 'screenshots', 'downloads', 'node_modules', 'build', 'out', 'run'])
const MAX_CACHED_INVENTORIES = 4
const pendingInventoryLoads = new Map<string, Promise<ModpackContentInventory>>()

function rememberInventory(key: string, inventory: ModpackContentInventory): ModpackContentInventory {
  inventoryCache.delete(key)
  inventoryCache.set(key, inventory)
  while (inventoryCache.size > MAX_CACHED_INVENTORIES) inventoryCache.delete(inventoryCache.keys().next().value!)
  return inventory
}

/** Resolves an inventory path to the project-relative path used by the code editor. */
export function modpackContentProjectPath(project: ProjectInfo, relative: string): string {
  const normalized = normalizeRelative(relative)
  return path.resolve(overridesRoot(project)) === path.resolve(project.path) ? normalized : `overrides/${normalized}`
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

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false)
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
  await fs.mkdir(destination, { recursive: true })
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

export const importModpackContent = serializeProjectMutation(async function importModpackContent(
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
  const staging = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'content-import', randomUUID())
  await assertContentTarget(project.path, staging)
  await fs.mkdir(staging, { recursive: true })
  const replacements: Array<{ source: string; destination: string }> = []
  try {
    for (const [index, source] of sources.entries()) {
      const stat = await fs.lstat(source)
      const directory = stat.isDirectory()
      if (stat.isSymbolicLink() || !directory && !stat.isFile()) throw new Error('只能导入普通文件或目录')
      await validateImportedContent(kind, source, directory)
      const base = defaultDirectory(kind)
      const relative = normalizeRelative(base ? `${base}/${path.basename(source)}` : path.basename(source))
      const destination = contentTarget(project, relative)
      await assertContentTarget(project.path, destination)
      const staged = path.join(staging, String(index), path.basename(source))
      const initialBytes = budget.bytes
      if (directory) await copyDirectoryChecked(source, staged, budget)
      else await copyFileChecked(source, staged, budget)
      replacements.push({ source: staged, destination })
      if (directory) {
        additions.push({ id: itemId(relative), path: relative, kind, scope, delivery: 'embedded', directory: true, size: budget.bytes - initialBytes, addedAt: new Date().toISOString() })
      } else {
        const hashes = await hashFile(staged)
        additions.push({ id: itemId(relative), path: relative, kind, scope, delivery: 'embedded', ...hashes, addedAt: new Date().toISOString() })
      }
    }
    const paths = new Set(additions.map((item) => item.path))
    const next = { version: 1 as const, items: [...stored.items.filter((item) => !paths.has(item.path)), ...additions] }
    if (next.items.some(item => !normalizeItem(item))) throw new Error('内容清单格式无效')
    await installContentTransaction(project.path, replacements, () => writeStoredInventory(project, next))
    return { items: additions, copiedFiles: budget.files }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
})

export const downloadModpackContent = serializeProjectMutation(async function downloadModpackContent(project: ProjectInfo, input: ModpackContentDownloadInput, signal?: AbortSignal): Promise<ModpackContentDownloadResult> {
  signal?.throwIfAborted()
  if (!CONTENT_KINDS.has(input.kind) || !/^https:\/\//i.test(input.url)) throw new Error('只允许使用 HTTPS 下载地址')
  const scope = input.scope && CONTENT_SCOPES.has(input.scope) ? input.scope : defaultScope(input.kind)
  const relative = targetForDownload(input)
  const extractWorld = Boolean(input.extract && input.kind === 'worlds')
  if (input.extract && !extractWorld) throw new Error('只有世界存档允许下载后解压')
  if (extractWorld && !relative.startsWith('saves/')) throw new Error('世界存档必须保存到 saves/ 目录')
  const stored = await readStoredInventory(project)
  const destination = contentTarget(project, relative)
  await assertContentTarget(project.path, destination)
  const staging = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'content-downloads', randomUUID())
  await assertContentTarget(project.path, staging)
  await fs.mkdir(staging, { recursive: true })
  const downloaded = path.join(staging, filenameFromUrl(input.url))
  try {
    const result = await verifiedDownload.download({
      sources: [{ id: 'content-url', label: new URL(input.url).host, url: input.url }],
      destination: downloaded,
      maxBytes: MAX_CONTENT_FILE_BYTES,
      retriesPerSource: 2,
      timeoutMs: 120_000,
      signal
    })
    signal?.throwIfAborted()
    const hashes = await hashFile(downloaded)
    let item: ModpackContentItem
    let stagedSource = downloaded
    let extractedFiles: number | undefined
    if (extractWorld) {
      const extracted = path.join(staging, 'extracted')
      const state = { entryCount: 0, expandedBytes: 0 }
      await extractZip(downloaded, {
        dir: extracted,
        onEntry: (entry) => { signal?.throwIfAborted(); recordZipExpansion(state, { fileName: entry.fileName, uncompressedSize: entry.uncompressedSize }, {
          maxEntries: 20_000,
          maxEntryBytes: 256 * 1024 * 1024,
          maxExpandedBytes: 2 * 1024 * 1024 * 1024
        }) }
      })
      const roots = (await fs.readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      const source = roots.length === 1 ? path.join(extracted, roots[0].name) : extracted
      await validateImportedContent('worlds', source, true)
      stagedSource = source
      extractedFiles = state.entryCount
      item = { id: itemId(relative), path: relative, kind: input.kind, scope, delivery: 'embedded', directory: true, sourceUrl: input.url, sha1: hashes.sha1, sha512: hashes.sha512, size: hashes.size, addedAt: new Date().toISOString() }
    } else {
      item = { id: itemId(relative), path: relative, kind: input.kind, scope, delivery: 'remote', sourceUrl: input.url, sha1: hashes.sha1, sha512: hashes.sha512, size: hashes.size, addedAt: new Date().toISOString() }
    }
    signal?.throwIfAborted()
    await installContentTransaction(project.path, [{ source: stagedSource, destination }], () => {
      signal?.throwIfAborted()
      return writeStoredInventory(project, { version: 1, items: [...stored.items.filter((entry) => entry.path !== item.path), item] })
    })
    return { item, downloadedBytes: result.bytes, ...(extractedFiles ? { extractedFiles } : {}) }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
})

export const removeModpackContent = serializeProjectMutation(async function removeModpackContent(project: ProjectInfo, id: string): Promise<ModpackContentInventory> {
  const inventory = await listModpackContent(project)
  const target = inventory.items.find((item) => item.id === id)
  if (!target) throw new Error('找不到内容记录')
  await fs.rm(contentTarget(project, target.path), { recursive: true, force: true })
  const stored = await readStoredInventory(project)
  await writeStoredInventory(project, { version: 1, items: stored.items.filter((item) => item.path !== target.path) })
  return listModpackContent(project)
})
