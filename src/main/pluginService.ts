import { mkdirSync, promises as fs, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { extractSevenZipArchive } from './sevenZipArchive'
import { createStoredZip } from './bedrockAddon'
import { createPluginPanelHtml } from '../shared/pluginUi'
import {
  PLUGIN_MANIFEST_FILENAME,
  validatePluginManifest,
  type PluginManifest,
  type PluginRecord,
  type PluginScope,
  type PluginSnapshot,
  type PluginScaffoldInput
} from '../shared/plugins'

export interface PluginServiceOptions {
  /** 全局插件目录（通常为 userData/plugins）。 */
  globalDirectory: string
  /** 当前项目根目录（可为 null 表示无项目）。 */
  projectRoot: () => string | null
  /** 注册表或某插件变化时的通知回调。 */
  onChange?: (snapshot: PluginSnapshot) => void
}

interface WatcherEntry {
  watcher: ReturnType<typeof fsWatch>
  directory: string
  pluginId: string | null // null = 目录级监听（新插件出现）
}

interface PluginRegistryCacheEntry {
  fingerprint: string
  records: PluginRecord[]
}

interface PluginRegistryCache {
  version: 1
  scopes: Record<string, PluginRegistryCacheEntry>
}

interface PluginPreferences {
  version: 1
  enabled: Record<string, boolean>
}

const DEBOUNCE_MS = 250
const MAX_PLUGIN_ARCHIVE_FILES = 2_000
const MAX_PLUGIN_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_PLUGIN_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024

function isValidPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)
}

async function readManifestFile(directory: string): Promise<{ manifest: PluginManifest; error?: string } | { manifest?: PluginManifest; error: string }> {
  const manifestPath = path.join(directory, PLUGIN_MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return { error: '缺少 plugin.json' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = validatePluginManifest(parsed)
    if (!result.manifest) return { error: result.errors.join('；') }
    return { manifest: result.manifest }
  } catch (error) {
    return { error: `plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 校验 backend/panel 入口文件真实存在。 */
async function verifyEntries(manifest: PluginManifest, directory: string): Promise<string[]> {
  const errors: string[] = []
  const targets: Array<[string | undefined, string]> = [
    [manifest.backend?.entry, 'backend.entry'],
    [manifest.panel?.entry, 'panel.entry'],
    [manifest.overlay?.entry, 'overlay.entry'],
    [manifest.icon, 'icon']
  ]
  for (const [entry, field] of targets) {
    if (!entry) continue
    const resolved = path.resolve(directory, entry)
    if (!resolved.startsWith(path.resolve(directory) + path.sep)) {
      errors.push(`${field} 越界`)
      continue
    }
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isFile()) errors.push(`${field} 指向的文件不存在：${entry}`)
  }
  return errors
}

export class PluginService {
  private readonly options: PluginServiceOptions
  private records = new Map<string, PluginRecord>()
  private watchers: WatcherEntry[] = []
  private enabledOverrides = new Map<string, boolean>()
  private preferencesLoaded = false
  private preferenceWriteTail = Promise.resolve()
  private revisions = new Map<string, number>()
  private runtimeErrors = new Map<string, string>()
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private registryCache: PluginRegistryCache = { version: 1, scopes: {} }
  private cacheWriteTail = Promise.resolve()
  private closed = false

  constructor(options: PluginServiceOptions) {
    this.options = options
  }

  /** 全局 + 项目级合并注册表；同名 id 项目级优先。 */
  async refresh(options: { forceReload?: boolean } = {}): Promise<PluginSnapshot> {
    await this.loadPreferences()
    if (options.forceReload) this.bumpAllRevisions()
    const scanned = new Map<string, PluginRecord>()
    const cached = await this.readRegistryCache()
    const nextScopes: Record<string, PluginRegistryCacheEntry> = {}

    for (const [scope, directory] of this.scopeDirectories()) {
      const cachedRecords = this.validCachedRecords(cached.scopes[directory]?.records, scope, directory)
      const fingerprint = await this.scopeFingerprint(directory, cachedRecords)
      const cachedEntry = cached.scopes[directory]
      const cacheHit = Boolean(cachedEntry && cachedEntry.fingerprint === fingerprint && cachedRecords)
      const found = cacheHit ? cachedRecords! : await this.scanScope(scope, directory)
      for (const record of found) {
        const preferenceKey = this.preferenceKey(scope, record.manifest.id)
        const preferred = this.enabledOverrides.get(preferenceKey)
        if (preferred !== undefined) record.enabled = preferred
        else if (record.enabled === false) this.enabledOverrides.set(preferenceKey, false)
        record.revision = this.revisions.get(record.manifest.id) ?? 0
      }
      nextScopes[directory] = {
        fingerprint: cacheHit ? fingerprint : await this.scopeFingerprint(directory, found),
        records: found
      }
      for (const record of found) {
        const existing = scanned.get(record.manifest.id)
        // 项目级优先于全局
        if (!existing || (existing.scope === 'global' && record.scope === 'project')) {
          scanned.set(record.manifest.id, record)
        }
      }
    }

    this.records = scanned
    this.registryCache = { version: 1, scopes: nextScopes }
    await this.persistRegistryCache()
    await this.persistPreferences()
    const snapshot: PluginSnapshot = { plugins: [...scanned.values()] }
    return snapshot
  }

  private registryCachePath(): string {
    // Keep the cache outside the watched plugins directory so writing it does
    // not trigger another root-level plugin reload.
    return path.join(path.dirname(this.options.globalDirectory), 'plugin-registry-cache.json')
  }

  private preferencesPath(): string {
    return path.join(path.dirname(this.options.globalDirectory), 'plugin-preferences.json')
  }

  private preferenceKey(scope: PluginScope, pluginId: string): string {
    return `${scope}:${pluginId}`
  }

  private async loadPreferences(): Promise<void> {
    if (this.preferencesLoaded) return
    this.preferencesLoaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.preferencesPath(), 'utf8')) as Partial<PluginPreferences>
      if (parsed.version !== 1 || !parsed.enabled || typeof parsed.enabled !== 'object') return
      for (const [key, enabled] of Object.entries(parsed.enabled)) {
        if (/^(global|project):[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(key) && typeof enabled === 'boolean') {
          this.enabledOverrides.set(key, enabled)
        }
      }
    } catch {
      // 首次运行没有偏好文件。
    }
  }

  private async persistPreferences(): Promise<void> {
    if (!this.preferencesLoaded) return
    const target = this.preferencesPath()
    const pending = `${target}.pending-${process.pid}`
    const enabled = Object.fromEntries(this.enabledOverrides)
    const content = `${JSON.stringify({ version: 1, enabled } satisfies PluginPreferences, null, 2)}\n`
    this.preferenceWriteTail = this.preferenceWriteTail.then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(pending, content, 'utf8')
      await fs.rename(pending, target).catch(async () => {
        await fs.writeFile(target, content, 'utf8')
        await fs.rm(pending, { force: true }).catch(() => undefined)
      })
    }).catch(() => undefined)
    await this.preferenceWriteTail
  }

  private async readRegistryCache(): Promise<PluginRegistryCache> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.registryCachePath(), 'utf8')) as Partial<PluginRegistryCache>
      if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== 'object') return { version: 1, scopes: {} }
      return { version: 1, scopes: parsed.scopes as Record<string, PluginRegistryCacheEntry> }
    } catch {
      return { version: 1, scopes: {} }
    }
  }

  private async persistRegistryCache(): Promise<void> {
    const content = `${JSON.stringify(this.registryCache, null, 2)}\n`
    const target = this.registryCachePath()
    const pending = `${target}.pending-${process.pid}`
    this.cacheWriteTail = this.cacheWriteTail.then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(pending, content, 'utf8')
      await fs.rename(pending, target).catch(async () => {
        await fs.writeFile(target, content, 'utf8')
        await fs.rm(pending, { force: true }).catch(() => undefined)
      })
    }).catch(() => undefined)
    await this.cacheWriteTail
  }

  private validCachedRecords(value: unknown, scope: PluginScope, directory: string): PluginRecord[] | null {
    if (!Array.isArray(value)) return null
    const root = path.resolve(directory)
    const records: PluginRecord[] = []
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object') return null
      const record = candidate as Partial<PluginRecord>
      if (!record.manifest || typeof record.manifest !== 'object' || typeof record.directory !== 'string') return null
      const pluginDirectory = path.resolve(record.directory)
      if (!pluginDirectory.startsWith(`${root}${path.sep}`)) return null
      const validatedManifest = validatePluginManifest(record.manifest).manifest
      const cachedManifest = record.manifest as Partial<PluginManifest>
      const manifest = validatedManifest ?? (typeof record.error === 'string'
        && typeof cachedManifest.id === 'string'
        && isValidPluginId(cachedManifest.id)
        && typeof cachedManifest.name === 'string'
        && typeof cachedManifest.version === 'string'
        && typeof cachedManifest.description === 'string'
        && Array.isArray(cachedManifest.permissions)
        ? cachedManifest as PluginManifest
        : undefined)
      if (!manifest || manifest.id !== path.basename(pluginDirectory)) return null
      records.push({
        manifest,
        scope,
        directory: pluginDirectory,
        enabled: record.enabled !== false,
        ...(typeof record.error === 'string' && record.error ? { error: record.error } : {})
      })
    }
    return records
  }

  private async scopeFingerprint(directory: string, cachedRecords: PluginRecord[] | null): Promise<string> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    const cachedById = new Map((cachedRecords ?? []).map((record) => [record.manifest.id, record]))
    const parts: string[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isValidPluginId(entry.name)) continue
      const pluginDirectory = path.join(directory, entry.name)
      const record = cachedById.get(entry.name)
      const files = [
        path.join(pluginDirectory, PLUGIN_MANIFEST_FILENAME),
        ...(record?.manifest.backend?.entry ? [path.join(pluginDirectory, record.manifest.backend.entry)] : []),
        ...(record?.manifest.panel?.entry ? [path.join(pluginDirectory, record.manifest.panel.entry)] : []),
        ...(record?.manifest.overlay?.entry ? [path.join(pluginDirectory, record.manifest.overlay.entry)] : [])
      ]
      const stats = await Promise.all(files.map(async (file) => {
        const stat = await fs.stat(file).catch(() => null)
        return stat ? `${file.slice(pluginDirectory.length)}:${stat.size}:${stat.mtimeMs}` : `${file.slice(pluginDirectory.length)}:missing`
      }))
      const directoryStat = await fs.stat(pluginDirectory).catch(() => null)
      parts.push(`${entry.name}:${directoryStat?.mtimeMs ?? 0}:${stats.join(',')}`)
    }
    return parts.join('|')
  }

  private scopeDirectories(): Array<[PluginScope, string]> {
    const list: Array<[PluginScope, string]> = [['global', this.options.globalDirectory]]
    const projectRoot = this.options.projectRoot()
    if (projectRoot) {
      list.push(['project', path.join(projectRoot, '.modmind', 'plugins')])
    }
    return list
  }

  private async scanScope(scope: PluginScope, directory: string): Promise<PluginRecord[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    const records: PluginRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isValidPluginId(entry.name)) continue
      const pluginDirectory = path.join(directory, entry.name)
      const loaded = await readManifestFile(pluginDirectory)
      if ('error' in loaded || !loaded.manifest) {
        records.push({
          manifest: {
            id: entry.name,
            name: entry.name,
            version: '0.0.0',
            description: '',
            permissions: []
          },
          scope,
          directory: pluginDirectory,
          enabled: false,
          error: loaded.error ?? '未知错误'
        })
        continue
      }
      const manifest = loaded.manifest
      // 目录名与 manifest id 不一致时视为错误，避免歧义
      if (manifest.id !== entry.name) {
        records.push({ manifest, scope, directory: pluginDirectory, enabled: false, error: `manifest id "${manifest.id}" 与目录名 "${entry.name}" 不一致` })
        continue
      }
      const entryErrors = await verifyEntries(manifest, pluginDirectory)
      records.push({
        manifest,
        scope,
        directory: pluginDirectory,
        enabled: this.enabledOverrides.get(this.preferenceKey(scope, manifest.id)) ?? true,
        revision: this.revisions.get(manifest.id) ?? 0,
        ...(entryErrors.length > 0 ? { error: entryErrors.join('；') } : {})
      })
    }
    return records
  }

  getSnapshot(): PluginSnapshot {
    return {
      plugins: [...this.records.values()].map((record) => ({
        ...record,
        revision: this.revisions.get(record.manifest.id) ?? record.revision ?? 0,
        ...(this.runtimeErrors.get(record.manifest.id) ? { runtimeError: this.runtimeErrors.get(record.manifest.id) } : {})
      }))
    }
  }

  getPlugin(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  getEnabledPlugin(id: string): PluginRecord | undefined {
    const record = this.records.get(id)
    return record && record.enabled && !record.error && !this.runtimeErrors.has(id) ? record : undefined
  }

  setEnabled(id: string, enabled: boolean): void {
    const record = this.records.get(id)
    if (record) {
      this.enabledOverrides.set(this.preferenceKey(record.scope, id), enabled)
      record.enabled = enabled
      if (enabled) this.runtimeErrors.delete(id)
      this.bumpRevision(id)
      void this.persistRegistryCache()
      void this.persistPreferences()
      this.options.onChange?.(this.getSnapshot())
    }
  }

  setRuntimeError(id: string, error: string | null): void {
    const previous = this.runtimeErrors.get(id)
    if (error) this.runtimeErrors.set(id, error)
    else this.runtimeErrors.delete(id)
    if ((previous ?? null) !== error) this.options.onChange?.(this.getSnapshot())
  }

  // -------------------------------------------------------------------------
  // 热重载监听
  // -------------------------------------------------------------------------

  startWatching(): void {
    if (this.closed) return
    const directories = this.scopeDirectories().map(([, directory]) => path.resolve(directory))
    const watched = this.watchers.map((entry) => path.resolve(entry.directory))
    if (directories.length === watched.length && directories.every((directory) => watched.includes(directory))) return
    this.stopWatching()
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true })
      this.watchDirectory(directory, null)
    }
  }

  private watchDirectory(directory: string, pluginId: string | null): void {
    if (this.closed) return
    try {
      const watcher = fsWatch(directory, { recursive: true }, (_event, fileName) => {
        if (this.closed) return
        const target = pluginId ?? (typeof fileName === 'string' ? fileName.split(path.sep)[0] : null)
        this.scheduleReload(target)
      })
      watcher.on('error', () => { /* 目录可能被删除；忽略 */ })
      this.watchers.push({ watcher, directory, pluginId })
    } catch {
      // 目录不存在时不监视；refresh 后会重建
    }
  }

  stopWatching(): void {
    for (const entry of this.watchers) {
      try { entry.watcher.close() } catch { /* 忽略 */ }
    }
    this.watchers = []
    for (const timer of this.reloadTimers.values()) clearTimeout(timer)
    this.reloadTimers.clear()
  }

  private scheduleReload(pluginId: string | null): void {
    const key = pluginId ?? '__root__'
    const existing = this.reloadTimers.get(key)
    if (existing) clearTimeout(existing)
    this.reloadTimers.set(key, setTimeout(() => {
      this.reloadTimers.delete(key)
      void this.handleWatchedChange(pluginId)
    }, DEBOUNCE_MS))
  }

  private async handleWatchedChange(pluginId: string | null): Promise<void> {
    if (pluginId && isValidPluginId(pluginId)) {
      this.runtimeErrors.delete(pluginId)
      this.bumpRevision(pluginId)
    } else {
      this.runtimeErrors.clear()
      this.bumpAllRevisions()
    }
    await this.refresh()
    this.restartWatchers()
    this.options.onChange?.(this.getSnapshot())
  }

  /** 目录集合随项目切换会变，重建全部监听。 */
  restartWatchers(): void {
    this.stopWatching()
    this.startWatching()
  }

  close(): void {
    this.closed = true
    this.stopWatching()
    this.records.clear()
  }

  private bumpRevision(pluginId: string): void {
    this.revisions.set(pluginId, (this.revisions.get(pluginId) ?? 0) + 1)
  }

  private bumpAllRevisions(): void {
    for (const id of this.records.keys()) this.bumpRevision(id)
    this.runtimeErrors.clear()
  }

  // -------------------------------------------------------------------------
  // 导入 / 导出
  // -------------------------------------------------------------------------

  scopeDirectoryFor(scope: PluginScope): string {
    const directories = this.scopeDirectories().filter(([candidate]) => candidate === scope)
    if (!directories.length) throw new Error(`${scope} 作用域当前不可用（无打开的项目）`)
    return directories[0][1]
  }

  /**
   * 从 .zip 导入：解压到临时目录、读取并校验 manifest、返回预览信息。
   * 实际落盘由 {@link confirmImport} 完成。
   */
  async previewZipImport(zipPath: string, scope: PluginScope): Promise<{
    manifest: PluginManifest
    stagedDirectory: string
    conflictsWith?: { id: string; scope: PluginScope; directory: string }
  }> {
    const stagingRoot = path.join(this.options.globalDirectory, '.staging', `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await fs.mkdir(stagingRoot, { recursive: true })
    try {
      let entryCount = 0
      let expandedBytes = 0
      await extractSevenZipArchive(zipPath, stagingRoot, (entry) => {
        entryCount += 1
        expandedBytes += entry.uncompressedSize
        if (entryCount > MAX_PLUGIN_ARCHIVE_FILES) throw new Error(`插件压缩包文件数超过 ${MAX_PLUGIN_ARCHIVE_FILES}`)
        if (entry.uncompressedSize > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES) throw new Error(`插件文件过大：${entry.fileName}`)
        if (expandedBytes > MAX_PLUGIN_ARCHIVE_TOTAL_BYTES) throw new Error('插件压缩包展开后超过 256 MiB')
      })
      const pluginDirectory = await this.locateManifestRoot(stagingRoot)
      const loaded = await readManifestFile(pluginDirectory)
      if (!loaded.manifest) throw new Error(loaded.error ?? 'manifest 无效')
      if (pluginDirectory !== stagingRoot && loaded.manifest.id !== path.basename(pluginDirectory)) {
        throw new Error(`manifest id "${loaded.manifest.id}" 与压缩包顶层目录 "${path.basename(pluginDirectory)}" 不一致`)
      }
      const entryErrors = await verifyEntries(loaded.manifest, pluginDirectory)
      if (entryErrors.length > 0) throw new Error(entryErrors.join('；'))
      const destination = path.join(this.scopeDirectoryFor(scope), loaded.manifest.id)
      const existingManifest = await readManifestFile(destination)
      const hasExisting = await fs.stat(destination).then((stat) => stat.isDirectory()).catch(() => false)
      return {
        manifest: loaded.manifest,
        stagedDirectory: pluginDirectory,
        ...(hasExisting ? {
          conflictsWith: {
            id: existingManifest.manifest?.id ?? loaded.manifest.id,
            scope,
            directory: destination
          }
        } : {})
      }
    } catch (error) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async locateManifestRoot(stagingRoot: string): Promise<string> {
    const direct = path.join(stagingRoot, PLUGIN_MANIFEST_FILENAME)
    if (await fs.stat(direct).then((s) => s.isFile()).catch(() => false)) return stagingRoot
    const entries = await fs.readdir(stagingRoot, { withFileTypes: true })
    const directories = entries.filter((e) => e.isDirectory())
    if (directories.length === 1) {
      const nested = path.join(stagingRoot, directories[0].name, PLUGIN_MANIFEST_FILENAME)
      if (await fs.stat(nested).then((s) => s.isFile()).catch(() => false)) {
        return path.join(stagingRoot, directories[0].name)
      }
    }
    throw new Error('压缩包中未找到 plugin.json（应位于顶层或唯一子目录）')
  }

  /** 把 previewZipImport 暂存的目录移动到目标作用域。 */
  async confirmImport(stagedDirectory: string, scope: PluginScope): Promise<PluginManifest> {
    const loaded = await readManifestFile(stagedDirectory)
    if (!loaded.manifest) throw new Error(loaded.error ?? 'manifest 无效')
    const manifest = loaded.manifest
    const entryErrors = await verifyEntries(manifest, stagedDirectory)
    if (entryErrors.length > 0) throw new Error(entryErrors.join('；'))
    const destination = path.join(this.scopeDirectoryFor(scope), manifest.id)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await this.replaceDirectoryAtomically(stagedDirectory, destination)
    await this.cleanupStagingDirectory(stagedDirectory)
    this.runtimeErrors.delete(manifest.id)
    this.bumpRevision(manifest.id)
    await this.refresh()
    this.options.onChange?.(this.getSnapshot())
    return manifest
  }

  async cancelImport(stagedDirectory: string): Promise<void> {
    await this.cleanupStagingDirectory(stagedDirectory)
  }

  /** 直接导入一个已存在的文件夹（开发场景）。 */
  async importFolder(sourceDirectory: string, scope: PluginScope): Promise<PluginManifest> {
    const loaded = await readManifestFile(sourceDirectory)
    if (!loaded.manifest) throw new Error(loaded.error ?? 'manifest 无效')
    const manifest = loaded.manifest
    if (manifest.id !== path.basename(sourceDirectory)) {
      throw new Error(`manifest id "${manifest.id}" 与文件夹名 "${path.basename(sourceDirectory)}" 不一致`)
    }
    const destination = path.join(this.scopeDirectoryFor(scope), manifest.id)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const entryErrors = await verifyEntries(manifest, sourceDirectory)
    if (entryErrors.length > 0) throw new Error(entryErrors.join('；'))
    const incoming = `${destination}.incoming-${process.pid}-${Date.now()}`
    try {
      await copyDirectory(sourceDirectory, incoming)
      await this.replaceDirectoryAtomically(incoming, destination)
    } finally {
      await fs.rm(incoming, { recursive: true, force: true }).catch(() => undefined)
    }
    this.runtimeErrors.delete(manifest.id)
    this.bumpRevision(manifest.id)
    await this.refresh()
    this.options.onChange?.(this.getSnapshot())
    return manifest
  }

  async exportZip(pluginId: string, destinationZip: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`未找到插件 ${pluginId}`)
    const entries: Array<{ name: string; data: Buffer }> = []
    const walk = async (relative: string): Promise<void> => {
      const absolute = path.join(record.directory, relative)
      for (const entry of await fs.readdir(absolute, { withFileTypes: true }).catch(() => [])) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(childRelative)
        else if (entry.isFile()) {
          entries.push({ name: `${record.manifest.id}/${childRelative}`, data: await fs.readFile(path.join(absolute, entry.name)) })
        }
      }
    }
    await walk('')
    await fs.writeFile(destinationZip, createStoredZip(entries))
  }

  async deletePlugin(pluginId: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (!record) return
    await fs.rm(record.directory, { recursive: true, force: true })
    this.enabledOverrides.delete(this.preferenceKey(record.scope, pluginId))
    void this.persistPreferences()
    this.runtimeErrors.delete(pluginId)
    this.revisions.delete(pluginId)
    await this.refresh()
    this.options.onChange?.(this.getSnapshot())
  }

  // -------------------------------------------------------------------------
  // 脚手架（工作台 Agent 制作流）
  // -------------------------------------------------------------------------

  async scaffold(input: PluginScaffoldInput): Promise<{ directory: string; manifest: PluginManifest }> {
    const id = input.id.trim().toLowerCase()
    if (!isValidPluginId(id)) throw new Error(`插件 id 非法：${id}`)
    if (this.records.has(id)) throw new Error(`插件 id 已存在：${id}`)

    const wantsPanel = input.kind !== 'tools-only'
    const wantsBackend = input.kind !== 'panel-only'

    const tools = wantsBackend
      ? (input.tools && input.tools.length > 0
        ? input.tools
        : [{
            name: 'example',
            description: `${input.name} 的示例工具，请在 plugin.json 中替换为真实工具声明。`,
            inputSchema: { type: 'object' as const, properties: {} as Record<string, unknown> },
            annotations: { readOnlyLocal: true }
          }])
      : []

    const candidateManifest: PluginManifest = {
      id,
      name: input.name.trim() || id,
      version: '0.1.0',
      description: input.description?.trim() || `${input.name} 插件`,
      ...(input.author ? { author: input.author } : {}),
      permissions: wantsBackend ? ['project.read', 'storage'] : ['project.read'],
      ...(wantsBackend ? { backend: { entry: 'backend/main.mjs', tools } } : {}),
      ...(wantsPanel ? { panel: { entry: 'panel/index.html' } } : {})
    }
    const validation = validatePluginManifest(candidateManifest)
    if (!validation.manifest) throw new Error(validation.errors.join('；'))
    const manifest = validation.manifest

    // 默认落在全局目录；targetDirectory 仅内部测试使用
    const baseDirectory = input.targetDirectory ?? this.options.globalDirectory
    const directory = path.join(baseDirectory, id)
    if (input.targetDirectory) {
      // 测试路径：直接写入指定位置
      await fs.mkdir(directory, { recursive: true })
    } else {
      await fs.mkdir(directory, { recursive: true })
    }

    await fs.writeFile(path.join(directory, PLUGIN_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    if (wantsPanel) {
      await fs.mkdir(path.join(directory, 'panel'), { recursive: true })
      await fs.writeFile(path.join(directory, 'panel', 'index.html'), createPluginPanelHtml(manifest.name), 'utf8')
    }
    if (wantsBackend) {
      await fs.mkdir(path.join(directory, 'backend'), { recursive: true })
      const handlerNames = tools.map((tool) => tool.name)
      const handlers = handlerNames.map((name) => `  async ${JSON.stringify(name)}(input) {\n    return { tool: ${JSON.stringify(name)}, input: input ?? {} }\n  }`).join(',\n')
      await fs.writeFile(
        path.join(directory, 'backend', 'main.mjs'),
        BACKEND_TEMPLATE_MJS.replace('GENERATED_HANDLERS', handlers).replace(/HANDLER_NAMES/g, JSON.stringify(handlerNames)).replace(/PLUGIN_ID/g, id),
        'utf8'
      )
    }

    this.bumpRevision(id)
    await this.refresh()
    this.options.onChange?.(this.getSnapshot())
    return { directory, manifest }
  }

  /** 工作台制作流：按相对路径写入插件内文件（防越界）。 */
  async writePluginFiles(pluginId: string, files: Array<{ path: string; content: string }>): Promise<void> {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`未找到插件 ${pluginId}`)
    for (const file of files) {
      const normalized = file.path.replaceAll('\\', '/')
      const resolved = path.resolve(record.directory, normalized)
      if (!resolved.startsWith(path.resolve(record.directory) + path.sep)) {
        throw new Error(`文件路径越界：${file.path}`)
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, file.content, 'utf8')
    }
    this.runtimeErrors.delete(pluginId)
    this.bumpRevision(pluginId)
    await this.refresh()
    this.options.onChange?.(this.getSnapshot())
  }

  /** 工作台制作流：回读插件源码（限制大小）。 */
  async readPluginSource(pluginId: string): Promise<Array<{ path: string; content: string; truncated: boolean }>> {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`未找到插件 ${pluginId}`)
    const results: Array<{ path: string; content: string; truncated: boolean }> = []
    const MAX_FILE_BYTES = 256 * 1024
    const MAX_FILES = 200
    let truncated = false

    const walk = async (relative: string): Promise<void> => {
      if (results.length >= MAX_FILES) {
        truncated = true
        return
      }
      const absolute = path.join(record.directory, relative)
      const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (results.length >= MAX_FILES) {
          truncated = true
          return
        }
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(childRelative)
        } else if (entry.isFile()) {
          const stat = await fs.stat(path.join(absolute, entry.name))
          if (stat.size > MAX_FILE_BYTES) {
            results.push({ path: childRelative, content: '', truncated: true })
            continue
          }
          const content = await fs.readFile(path.join(absolute, entry.name), 'utf8').catch(() => '')
          results.push({ path: childRelative, content, truncated: false })
        }
      }
    }
    await walk('')
    return results.map((entry) => ({ ...entry, truncated: entry.truncated || truncated && false }))
  }

  private async replaceDirectoryAtomically(incomingDirectory: string, destination: string): Promise<void> {
    const prepared = `${destination}.prepared-${process.pid}-${Date.now()}`
    const backup = `${destination}.backup-${process.pid}-${Date.now()}`
    await fs.rm(prepared, { recursive: true, force: true })
    await fs.rename(incomingDirectory, prepared).catch(async () => {
      await copyDirectory(incomingDirectory, prepared)
    })
    const hadExisting = await fs.stat(destination).then((stat) => stat.isDirectory()).catch(() => false)
    let movedExisting = false
    try {
      if (hadExisting) {
        await fs.rename(destination, backup)
        movedExisting = true
      }
      await fs.rename(prepared, destination)
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      if (movedExisting) {
        await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined)
        await fs.rename(backup, destination).catch(() => undefined)
      }
      await fs.rm(prepared, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async cleanupStagingDirectory(stagedDirectory: string): Promise<void> {
    const stagingBase = path.resolve(this.options.globalDirectory, '.staging')
    const resolved = path.resolve(stagedDirectory)
    const transactionRoot = path.basename(resolved).startsWith('import-') ? resolved : path.dirname(resolved)
    if (!transactionRoot.startsWith(`${stagingBase}${path.sep}`)) throw new Error('暂存目录越界')
    await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

const BACKEND_TEMPLATE_MJS = `// PLUGIN_ID 后端入口。插件经用户确认后作为完全可信的 Node 扩展运行。
// 宿主注入全局 modmindPlugin 对象。
modmindPlugin.registerTools({
GENERATED_HANDLERS
})
modmindPlugin.ctx.log.info('backend started, handlers: ' + JSON.stringify(HANDLER_NAMES))
`


async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyDirectory(from, to)
    else await fs.copyFile(from, to)
  }
}
