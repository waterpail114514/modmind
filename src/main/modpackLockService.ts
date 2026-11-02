import { createHash, randomUUID } from 'node:crypto'
import { recordDiagnosticManifest } from './diagnosticArtifacts'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { JavaLoaderKind, ProjectInfo } from '../shared/types'
import type { ModDependency, ModFile, ModPlatform, ModSide } from './modProviderService'
import { isSafeModJarFileName } from './modpackFilename'
import { modpackModsRoot } from './modpackPaths'
import { readModpackManifest } from './modpackService'
import { assertContentTarget } from './contentInstallTransaction'
import { serializeProjectMutation, withProjectMutation } from './projectMutation'
import type { ModpackLockResult } from '../shared/modpackLock'

export const MODPACK_LOCK_FILE = 'modmind.modpack.lock.json'

export interface LockedModIdentity {
  provider: ModPlatform
  projectId: string
  versionId: string
  versionName: string
}

export interface LockedMod extends LockedModIdentity {
  aliases?: LockedModIdentity[]
  fileName: string
  sha256: string
  size: number
  side: ModSide
  sources: string[]
  installedAt: string
  dependencies?: ModDependency[]
  publishedAt?: string
}

export interface ModpackLock {
  version: 1
  minecraftVersion: string
  loader: JavaLoaderKind
  generatedAt: string
  mods: LockedMod[]
  repairNeeded?: boolean
}

function lockPath(project: ProjectInfo): string { return path.join(project.path, MODPACK_LOCK_FILE) }

function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) }

function validSource(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (/^https:\/\//i.test(value)) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
  } catch { return false }
}

function validDependency(value: unknown): value is ModDependency {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (entry.provider === 'modrinth' || entry.provider === 'curseforge')
    && typeof entry.projectId === 'string'
    && /^[A-Za-z0-9._-]{1,160}$/.test(entry.projectId)
    && (entry.versionId === undefined || typeof entry.versionId === 'string')
    && (entry.fileName === undefined || typeof entry.fileName === 'string')
    && ['required', 'optional', 'incompatible', 'embedded'].includes(String(entry.kind))
}

function normalizeMod(value: unknown): LockedMod | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (!['modrinth', 'curseforge', 'mcmod'].includes(String(entry.provider)) || typeof entry.projectId !== 'string' || typeof entry.versionId !== 'string' || typeof entry.versionName !== 'string' || !isSafeModJarFileName(entry.fileName) || !validHash(entry.sha256) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 1 || !['client', 'server', 'both', 'unknown'].includes(String(entry.side)) || !Array.isArray(entry.sources) || entry.sources.some((source) => !validSource(source)) || typeof entry.installedAt !== 'string') return null
  if (entry.dependencies !== undefined && (!Array.isArray(entry.dependencies) || entry.dependencies.some((dependency) => !validDependency(dependency)))) return null
  if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => !validIdentity(alias)))) return null
  return { provider: entry.provider as ModPlatform, projectId: entry.projectId, versionId: entry.versionId, versionName: entry.versionName.slice(0, 180), fileName: entry.fileName, sha256: entry.sha256.toLowerCase(), size: entry.size, side: entry.side as ModSide, sources: entry.sources, installedAt: entry.installedAt, ...(Array.isArray(entry.aliases) && entry.aliases.length ? { aliases: entry.aliases as LockedModIdentity[] } : {}), ...(Array.isArray(entry.dependencies) && entry.dependencies.length ? { dependencies: entry.dependencies as ModDependency[] } : {}), ...(typeof entry.publishedAt === 'string' ? { publishedAt: entry.publishedAt } : {}) }
}

function validIdentity(value: unknown): value is LockedModIdentity {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return ['modrinth', 'curseforge', 'mcmod'].includes(String(entry.provider))
    && typeof entry.projectId === 'string' && typeof entry.versionId === 'string' && typeof entry.versionName === 'string'
}

const identityKey = (identity: Pick<LockedModIdentity, 'provider' | 'projectId'>): string => `${identity.provider}:${identity.projectId}`
export function lockedModIdentities(mod: LockedMod): LockedModIdentity[] {
  const { provider, projectId, versionId, versionName } = mod
  return [{ provider, projectId, versionId, versionName }, ...(mod.aliases ?? [])]
}

export function matchesLockedMod(mod: LockedMod, identity: Pick<LockedModIdentity, 'provider' | 'projectId'> & { versionId?: string }): boolean {
  return lockedModIdentities(mod).some((entry) => identityKey(entry) === identityKey(identity) && (identity.versionId === undefined || entry.versionId === identity.versionId))
}

function mergeArtifact(left: LockedMod, right: LockedMod): LockedMod {
  const identities = new Map([...lockedModIdentities(left), ...lockedModIdentities(right)].map((entry) => [identityKey(entry), entry]))
  const primary = identities.get(identityKey(left))!
  const aliases = [...identities.values()].filter((entry) => identityKey(entry) !== identityKey(primary))
  const dependencies = [...new Map([...(left.dependencies ?? []), ...(right.dependencies ?? [])].map((entry) => [JSON.stringify(entry), entry])).values()]
  const side = left.side === 'unknown' ? right.side : right.side === 'unknown' || left.side === right.side ? left.side : 'both'
  return { ...left, ...primary, side, sources: [...new Set([...left.sources, ...right.sources])], aliases, dependencies }
}

/** One physical filename owns its hashes; equivalent provider identities remain discoverable. */
export function mergeLockedMods(mods: LockedMod[]): LockedMod[] {
  const files = new Map<string, LockedMod>()
  for (const mod of mods) {
    const key = mod.fileName.toLowerCase()
    const previous = files.get(key)
    if (previous && (previous.sha256 !== mod.sha256 || previous.size !== mod.size)) {
      throw new Error(`模组锁文件冲突：${mod.fileName} 的 ${identityKey(previous)} 与 ${identityKey(mod)} 内容不同（SHA-256 ${previous.sha256} / ${mod.sha256}）；请使用“修复模组锁”核验现有文件，或明确选择所需版本`)
    }
    files.set(key, previous ? mergeArtifact(previous, mod) : { ...mod })
  }
  const projects = new Map<string, string>()
  for (const mod of files.values()) {
    const identities = new Map(lockedModIdentities(mod).map((entry) => [identityKey(entry), entry]))
    mod.aliases = [...identities.values()].filter((entry) => identityKey(entry) !== identityKey(mod))
    for (const key of identities.keys()) {
      const previous = projects.get(key)
      if (previous) throw new Error(`模组锁包含重复平台项目：${key} 同时指向 ${previous} 和 ${mod.fileName}；请使用“修复模组锁”检查`)
      projects.set(key, mod.fileName)
    }
  }
  return [...files.values()]
}

/** A requested upgrade replaces its old artifact; unrelated same-name bytes never overwrite it. */
export function upsertLockedMod(mods: LockedMod[], incoming: LockedMod): LockedMod[] {
  const previous = mods.filter((mod) => matchesLockedMod(mod, { provider: incoming.provider, projectId: incoming.projectId }))
  const retained = mods.filter((mod) => !previous.includes(mod))
  const equivalents = previous.filter((mod) => mod.fileName.toLowerCase() === incoming.fileName.toLowerCase() && mod.sha256 === incoming.sha256 && mod.size === incoming.size)
  return mergeLockedMods([...retained, ...equivalents, incoming])
}

export function withoutLockedModProjects(mods: LockedMod[], provider: ModPlatform, projectIds: Set<string>): LockedMod[] {
  return mods.flatMap((mod) => {
    const remaining = lockedModIdentities(mod).filter((entry) => entry.provider !== provider || !projectIds.has(entry.projectId))
    return remaining.length ? [{ ...mod, ...remaining[0], aliases: remaining.slice(1) }] : []
  })
}

export function createEmptyModpackLock(project: ProjectInfo): ModpackLock {
  if (!project.minecraftVersion || !['fabric', 'quilt', 'forge', 'neoforge'].includes(project.loader)) throw new Error('a Java modpack project is required')
  return { version: 1, minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind, generatedAt: new Date().toISOString(), mods: [] }
}

async function readRawModpackLock(project: ProjectInfo): Promise<{ lock: ModpackLock; bytes: string | null }> {
  const fallback = createEmptyModpackLock(project)
  await assertContentTarget(project.path, lockPath(project))
  const bytes = await fs.readFile(lockPath(project), 'utf8').catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT') return null
    throw error
  })
  if (bytes === null) return { lock: fallback, bytes }
  const parsed = JSON.parse(bytes) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object') throw new Error(`${MODPACK_LOCK_FILE} contains invalid metadata`)
  if (parsed.version !== 1 || parsed.minecraftVersion !== project.minecraftVersion || parsed.loader !== project.loader || !Array.isArray(parsed.mods)) throw new Error(`${MODPACK_LOCK_FILE} does not match the current project`)
  const mods = parsed.mods.map(normalizeMod)
  if (mods.some((mod) => !mod)) throw new Error(`${MODPACK_LOCK_FILE} contains an invalid mod record`)
  const normalized = mods.filter((mod): mod is LockedMod => Boolean(mod))
  return { lock: { ...fallback, generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : fallback.generatedAt, mods: normalized }, bytes }
}

export async function readModpackLock(project: ProjectInfo): Promise<ModpackLock> {
  const { lock } = await readRawModpackLock(project)
  const mods = mergeLockedMods(lock.mods)
  return { ...lock, mods, ...(mods.length !== lock.mods.length ? { repairNeeded: true } : {}) }
}

async function backupModpackLock(project: ProjectInfo, bytes: string): Promise<string> {
  const target = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'lock-backups', `${Date.now()}-${randomUUID()}.json`)
  await assertContentTarget(project.path, target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes, { encoding: 'utf8', flag: 'wx' })
  return target
}

export const writeModpackLock = serializeProjectMutation(async function writeModpackLock(project: ProjectInfo, lock: ModpackLock): Promise<ModpackLock> {
  if (lock.version !== 1 || lock.minecraftVersion !== project.minecraftVersion || lock.loader !== project.loader) throw new Error('lock metadata does not match the current project')
  const mods = lock.mods.map((mod) => {
    const normalized = normalizeMod(mod)
    if (!normalized) throw new Error(`invalid locked mod: ${mod.fileName}`)
    return normalized
  })
  const next: ModpackLock = { version: 1, minecraftVersion: lock.minecraftVersion, loader: lock.loader, generatedAt: new Date().toISOString(), mods: mergeLockedMods(mods) }
  const target = lockPath(project)
  await assertContentTarget(project.path, target)
  if (lock.repairNeeded) {
    const previous = await fs.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (previous !== null) await backupModpackLock(project, previous)
  }
  const pending = `${target}.pending-${randomUUID()}`
  const previousEvidence = await fs.readFile(target,'utf8').then(text => JSON.parse(text)).catch(() => null)
  if (previousEvidence && Array.isArray(previousEvidence.mods)) await recordDiagnosticManifest(project, 'pack-lock-before-write', previousEvidence)
  try {
    await fs.writeFile(pending, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(pending, target)
  } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
  await recordDiagnosticManifest(project, 'pack-lock-committed', next)
  return next
})

export async function hashModpackFile(project: ProjectInfo, target: string): Promise<{ sha256: string; size: number }> {
  await assertContentTarget(project.path, target)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(target)) { hash.update(chunk); size += chunk.length }
  return { sha256: hash.digest('hex'), size }
}

/** Repair metadata only when every retained identity matches bytes already on disk. */
export async function manageModpackLock(project: ProjectInfo, input: Record<string, unknown>): Promise<ModpackLockResult> {
  if (project.kind !== 'modpack') throw new Error('只有整合包项目支持模组锁管理')
  if (!input || typeof input !== 'object' || !['inspect', 'repair'].includes(String(input.operation)) || Object.keys(input).some((key) => key !== 'operation')) throw new Error('模组锁操作仅支持 inspect 或 repair，不接受外部路径')
  return withProjectMutation(project.path, async () => {
    const { lock, bytes } = await readRawModpackLock(project)
    const manifest = await readModpackManifest(project)
    const modsRoot = modpackModsRoot(project, manifest)
    await assertContentTarget(project.path, path.join(modsRoot, '.lock-inspection'))
    const entries = await fs.readdir(modsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    const groups = new Map<string, LockedMod[]>()
    for (const mod of lock.mods) { const key = mod.fileName.toLowerCase(); groups.set(key, [...(groups.get(key) ?? []), mod]) }
    const selected: LockedMod[] = []
    const errors: ModpackLockResult['errors'] = []
    for (const records of groups.values()) {
      const physical = entries.filter((entry) => entry.name.toLowerCase() === records[0].fileName.toLowerCase())
      const fileName = physical[0]?.name ?? records[0].fileName
      if (physical.length > 1) { errors.push({ fileName, message: '存在多个仅大小写不同的实体文件，请先明确保留哪一个文件' }); continue }
      let actual: { sha256: string; size: number }
      try { actual = await hashModpackFile(project, path.join(modsRoot, fileName)) }
      catch (error) { errors.push({ fileName, message: `无法核验文件：${error instanceof Error ? error.message : String(error)}` }); continue }
      const matching = records.filter((mod) => mod.sha256 === actual.sha256 && mod.size === actual.size)
      if (!matching.length) errors.push({ fileName, message: '磁盘文件与所有锁记录的哈希或大小均不一致，请重新安装所需版本', actualSha256: actual.sha256 })
      else selected.push(...matching.map((mod) => ({ ...mod, fileName })))
    }
    let mods: LockedMod[] = []
    try { mods = mergeLockedMods(selected) } catch (error) { errors.push({ fileName: '', message: error instanceof Error ? error.message : String(error) }) }
    const duplicateFiles = [...groups.values()].filter((records) => records.length > 1).map((records) => records[0].fileName)
    const result: ModpackLockResult = { success: !errors.length && !duplicateFiles.length, canRepair: !errors.length, repaired: false, records: lock.mods.length, files: groups.size, duplicateFiles, errors }
    if (input.operation !== 'repair' || errors.length || !duplicateFiles.length) return result
    const backupPath = await backupModpackLock(project, bytes!)
    // Refuse an external editor's change after inspection rather than overwriting it.
    if (await fs.readFile(lockPath(project), 'utf8') !== bytes) throw new Error('模组锁在核验后发生变化，请重新检查')
    await writeModpackLock(project, { ...lock, mods })
    return { ...result, success: true, repaired: true, records: mods.length, backupPath }
  })
}

export function lockedModFromFile(file: ModFile, result: { sha256: string; size: number }, fileName: string): LockedMod {
  return { provider: file.provider, projectId: file.projectId, versionId: file.versionId, versionName: file.versionName, fileName, sha256: result.sha256, size: result.size, side: file.side, sources: file.sources.map((source) => source.url), installedAt: new Date().toISOString(), ...(file.dependencies?.length ? { dependencies: file.dependencies } : {}), ...(file.publishedAt ? { publishedAt: file.publishedAt } : {}) }
}

export async function auditModpackLock(project: ProjectInfo): Promise<{ success: boolean; checked: number; errors: string[] }> {
  const lock = await readModpackLock(project)
  const manifest = await readModpackManifest(project)
  const modsRoot = modpackModsRoot(project, manifest)
  const errors: string[] = []
  for (const mod of lock.mods) {
    const target = path.join(modsRoot, mod.fileName)
    const bytes = await fs.readFile(target).catch(() => null)
    if (!bytes) { errors.push(`missing ${mod.fileName}`); continue }
    if (bytes.length !== mod.size) { errors.push(`size mismatch ${mod.fileName}`); continue }
    const { createHash } = await import('node:crypto')
    if (createHash('sha256').update(bytes).digest('hex') !== mod.sha256) errors.push(`sha256 mismatch ${mod.fileName}`)
  }
  return { success: !errors.length, checked: lock.mods.length, errors }
}
