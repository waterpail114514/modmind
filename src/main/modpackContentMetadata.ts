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
} from "../shared/types"
import path from 'node:path'
import { createReadStream, promises as fs, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

export const MODPACK_CONTENT_INVENTORY_FILE = 'modmind.pack-content.json'

export const MAX_CONTENT_FILE_BYTES = 512 * 1024 * 1024

export const CONTENT_KINDS = new Set<ModpackContentKind>([
  'config', 'scripts', 'datapacks', 'quests', 'resourcepacks', 'shaderpacks', 'ui', 'worlds', 'client', 'server', 'other'
])

export const CONTENT_SCOPES = new Set<ModpackContentScope>(['common', 'client', 'server'])

export const CONTENT_DELIVERIES = new Set<ModpackContentDelivery>(['embedded', 'remote'])

export const RESERVED_TOP_LEVEL = new Set(['mods', 'modules', '.modmind', '.git'])

export const INSTANCE_IGNORED_FILES = new Set(['modmind.project.json', 'modmind.pack.json', 'modmind.modpack.lock.json', 'modmind.pack-content.json', 'modrinth.index.json', 'manifest.json', 'minecraftinstance.json', 'modlist.html', 'instance.cfg', 'mmc-pack.json', 'readme.md'])

export const inventoryCache = new Map<string, ModpackContentInventory>()

export function cacheKey(project: ProjectInfo): string {
  const resolved = path.resolve(project.path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function invalidateModpackContentCache(project: ProjectInfo): void {
  inventoryCache.delete(cacheKey(project))
}

export function inventoryPath(project: ProjectInfo): string {
  return path.join(project.path, MODPACK_CONTENT_INVENTORY_FILE)
}

export function overridesRoot(project: ProjectInfo): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(project.path, 'modmind.pack.json'), 'utf8')) as { source?: { layout?: unknown } }
    if (manifest.source?.layout === 'instance') return project.path
  } catch { /* A malformed manifest is reported by the normal modpack service. */ }
  return path.join(project.path, 'overrides')
}

export function normalizeRelative(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || normalized.length > 480 || normalized.startsWith('/') || /^[A-Za-z]:/i.test(normalized)) throw new Error('内容路径无效')
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('内容路径无效')
  if (RESERVED_TOP_LEVEL.has(parts[0].toLowerCase())) throw new Error(`不能由内容工具管理 ${parts[0]} 目录`)
  if (parts.length === 1 && INSTANCE_IGNORED_FILES.has(parts[0].toLowerCase())) throw new Error(`不能由内容工具管理 ${parts[0]} 文件`)
  return normalized
}

export function contentTarget(project: ProjectInfo, relative: string): string {
  const root = path.resolve(overridesRoot(project))
  const target = path.resolve(root, ...normalizeRelative(relative).split('/'))
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('内容路径越界')
  return target
}

export function defaultScope(kind: ModpackContentKind): ModpackContentScope {
  if (['resourcepacks', 'shaderpacks', 'ui', 'client'].includes(kind)) return 'client'
  if (kind === 'server') return 'server'
  return 'common'
}

export function classifyPath(relative: string): ModpackContentKind {
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

export function itemId(relative: string): string {
  return `content:${normalizeRelative(relative)}`
}

export function validHash(value: unknown, length: number): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)
}

export function normalizeItem(value: unknown): ModpackContentItem | null {
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

export async function readStoredInventory(project: ProjectInfo): Promise<ModpackContentInventory> {
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

export async function writeStoredInventory(project: ProjectInfo, inventory: ModpackContentInventory): Promise<ModpackContentInventory> {
  if (inventory.version !== 1 || inventory.items.some((item) => !normalizeItem(item))) throw new Error('内容清单格式无效')
  const target = inventoryPath(project)
  const pending = `${target}.pending-${process.pid}`
  await fs.writeFile(pending, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  try { await fs.rename(pending, target) } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
  invalidateModpackContentCache(project)
  return readStoredInventory(project)
}

export async function hashFile(filePath: string): Promise<{ sha1: string; sha512: string; size: number }> {
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

export async function readManagedModpackContent(project: ProjectInfo): Promise<ModpackContentInventory> {
  return readStoredInventory(project)
}

export function isRemoteModpackContent(item: ModpackContentItem): boolean {
  return item.delivery === 'remote' && Boolean(item.sourceUrl && item.sha1 && item.sha512) && !item.directory
}
