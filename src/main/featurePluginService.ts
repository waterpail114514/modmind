import { diagnosticIpcOperations } from './diagnosticOperations'
import { diagnosticValue } from './diagnosticContext'
import { isFeaturePluginFile as allowedFile, validateFeaturePluginFiles as validate, validateFeaturePluginInput as validateInput, type PreparedPlugin } from './featurePluginPackage'
export { prepareFeaturePlugin, type PreparedPlugin } from './featurePluginPackage'

/** Local imports share the same transactional install/update and trust boundary. */
export async function importLocalFeaturePlugin(service: FeaturePluginService, prepared: PreparedPlugin, expectedId?: string): Promise<FeaturePluginRecord[]> {
  if (expectedId !== undefined && (!/^[a-z][a-z0-9-]{0,63}$/.test(expectedId) || prepared.manifest.id !== expectedId)) throw new Error('所选安装包不是当前功能，请选择相同功能 ID 的更新包')
  if (expectedId !== undefined && !service.list().some(record => record.id === expectedId)) throw new Error('此功能已被卸载，请使用导入功能包重新安装')
  return service.list().some(record => record.id === prepared.manifest.id) ? service.update(prepared) : service.install(prepared)
}
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import { BUILTIN_FEATURE_CATALOG } from '../shared/featurePluginCatalog'
import { sameProjectPath } from './projectPath'
import { retryTransientFileLock } from './fileLockRetry'
import type { ProjectInfo } from '../shared/types'
import { featureActionApplies } from '../shared/featureApplicability'
import { FEATURE_PLUGIN_API, FEATURE_PLUGIN_UNPACKED_LIMIT, type FeaturePluginManifest, type FeaturePluginRecord, type FeaturePluginDefinition, type FeaturePluginCatalogEntry, type FeaturePluginDiscoveredTool, type FeaturePluginInvocationContext, type FeaturePluginRuntime, type FeaturePluginSurface } from '../shared/featurePlugins'

const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const limit = FEATURE_PLUGIN_UNPACKED_LIMIT
export interface FeaturePluginHost {
  requireFrom: string
  capabilities: object
  options: (id: string) => unknown
  busy: () => boolean
  changed: () => void
  catalog?: FeaturePluginDefinition[]
  projectRoot?: () => string | null
  project?: () => ProjectInfo | null
  authorize?: (pluginId: string, action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) => boolean | Promise<boolean>
  event?: (pluginId: string, event: string, value: unknown, windowId?: number) => void
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function definition(manifest: FeaturePluginManifest): FeaturePluginDefinition {
  const { files: _files, ...value } = manifest
  return structuredClone(value)
}
/** Trusted native application features, deliberately separate from iframe third-party plugins. */
export class FeaturePluginService {
  private records = new Map<string, FeaturePluginRecord>()
  private manifests = new Map<string, FeaturePluginManifest>()
  private services = new Map<string, object>()
  private runtimes = new Map<string, FeaturePluginRuntime>()
  private emitters = new Map<string, symbol>()
  private activeCalls = 0
  private changing = false
  private revision = 0
  private projectPath: string | null = null
  private builtinDirectories = new Map<string, string>()
  private directory(id: string): string { return this.builtinDirectories.get(id) ?? path.join(this.root, id) }
  private assertMutable(id: string): void { if (this.builtinDirectories.has(id)) throw new Error('内置工作台随软件更新，不能停用、替换或卸载') }
  constructor(private readonly root: string, private readonly host: FeaturePluginHost) {}
  list(): FeaturePluginRecord[] { return [...this.records.values()].map(record => ({ ...structuredClone(record), contentHash: this.fingerprint(record.id) })) }
  canChange(): boolean { return !this.changing && !this.activeCalls && !this.host.busy() && !this.hasBusyRuntime() }
  activeService<T extends object>(id: string): T | undefined { return this.enabled(id) ? this.services.get(id) as T | undefined : undefined }
  fingerprint(id: string): string | undefined { const manifest = this.manifests.get(id); return manifest ? hash(Buffer.from(JSON.stringify(manifest))) : undefined }
  manifest(id: string): FeaturePluginDefinition | undefined { const manifest = this.manifests.get(id); return manifest ? definition(manifest) : undefined }
  assetDirectory(id: string, group: string): string {
    if (!this.enabled(id) || !Object.hasOwn(this.manifests.get(id)?.assets ?? {}, group) || !/^[a-z0-9-]+$/.test(group)) throw new Error('插件资源组不可用')
    return path.join(this.directory(id), 'assets', group)
  }
  enabled(id: string, ancestors = new Set<string>()): boolean {
    const record = this.records.get(id)
    if (!record?.enabled || record.error || ancestors.has(id)) return false
    const seen = new Set(ancestors).add(id)
    return (this.manifests.get(id)?.dependencies ?? []).every(dependency => this.enabled(dependency, seen))
  }
  catalog(): FeaturePluginCatalogEntry[] {
    const definitions = new Map((this.host.catalog ?? BUILTIN_FEATURE_CATALOG).map(entry => [entry.id, entry]))
    for (const manifest of this.manifests.values()) definitions.set(manifest.id, definition(manifest))
    const ids = new Set([...definitions.keys(), ...this.records.keys()])
    return [...ids].sort().map(id => {
      const record = this.records.get(id), manifest = definitions.get(id)
      const available = this.enabled(id)
      return {
        id, name: record?.name ?? manifest?.name ?? id, version: record?.version ?? manifest?.version ?? '',
        enabled: record?.enabled ?? false, error: record?.error, manifest: manifest ? structuredClone(manifest) : undefined,
        installed: Boolean(record), available, builtin: record?.builtin,
        state: !record ? 'not-installed' : record.error ? 'error' : !record.enabled ? 'disabled' : available ? 'ready' : 'dependency-missing',
        installHint: '侧边栏 → 功能，按名称搜索并安装或启用'
      }
    })
  }
  discoverInstalled(): FeaturePluginRecord[] { return this.list() }
  snapshot(): { revision: number; plugins: FeaturePluginCatalogEntry[] } { return { revision: this.revision, plugins: this.catalog() } }
  tools(surface: FeaturePluginSurface = 'workbench', project?: ProjectInfo): FeaturePluginDiscoveredTool[] {
    const currentProject = project ?? this.host.project?.()
    const result: FeaturePluginDiscoveredTool[] = []
    for (const manifest of this.manifests.values()) {
      if (!this.enabled(manifest.id)) continue
      for (const tool of manifest.tools ?? []) {
        const action = manifest.actions?.find(action => action.id === tool.action)
        if (!action || (action.surfaces && !action.surfaces.includes(surface))) continue
        if (!featureActionApplies(manifest, action, currentProject)) continue
        const scenarioReader = manifest.id === 'testing' && action.id === 'modpack_run_server_scenario' && surface === 'inspiration'
        const inputSchema = scenarioReader ? { ...structuredClone(action.inputSchema), properties: { ...structuredClone(action.inputSchema.properties as Record<string, unknown>), operation: { type: 'string', enum: ['state', 'files'] } }, required: ['operation'] } : structuredClone(action.inputSchema)
        result.push({ ...structuredClone(tool), pluginId: manifest.id, inputSchema, permission: scenarioReader ? 'read' : action.permission, projectRequired: action.projectRequired ?? false, inspirationOutput: action.inspirationOutput })
      }
    }
    return result
  }
  async invoke(id: string, actionId: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext = {}): Promise<unknown> {
    const action = this.manifests.get(id)?.actions?.find(action => action.id === actionId)
    if (!action) throw new Error('FEATURE_PLUGIN_ACTION_NOT_FOUND: 插件动作不存在')
    if (!this.enabled(id) || this.changing) throw new Error('FEATURE_PLUGIN_UNAVAILABLE: 应用功能插件未启用')
    if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024) throw new Error('插件参数过大或无效')
    const checkedInput = structuredClone(input)
    validateInput(checkedInput, action.inputSchema)
    const scenarioRead = id === 'testing' && action.id === 'modpack_run_server_scenario' && ['state', 'files'].includes(String(checkedInput.operation))
    if (context.readOnly && !scenarioRead && action.permission !== 'read' && !(action.inspirationOutput && context.surface === 'inspiration' && context.allowInspirationOutput === true)) throw new Error('FEATURE_PLUGIN_READ_ONLY: 当前会话只允许读取')
    if (context.surface && action.surfaces && !action.surfaces.includes(context.surface)) throw new Error('FEATURE_PLUGIN_SURFACE_DENIED: 当前工作区不支持此动作')
    const currentProject = this.host.projectRoot?.() ?? null
    if (!featureActionApplies(this.manifests.get(id)!, action, this.host.project?.())) throw new Error('FEATURE_PLUGIN_STUDIO_MISMATCH: 此工具不适用于当前工作台')
    if (this.host.projectRoot && context.projectPath && (!currentProject || !sameProjectPath(context.projectPath, currentProject))) throw new Error('FEATURE_PLUGIN_PROJECT_MISMATCH: 项目已切换')
    if (action.projectRequired && !(currentProject ?? context.projectPath)) throw new Error('FEATURE_PLUGIN_PROJECT_REQUIRED: 请先打开项目')
    const invocation = { ...context, projectPath: currentProject ?? context.projectPath ?? null }
    const runtime = this.service<FeaturePluginRuntime & Record<string, unknown>>(id)
    const handler = runtime.actions?.[action.handler] ?? runtime[action.handler]
    if (typeof handler !== 'function') throw new Error('FEATURE_PLUGIN_ACTION_NOT_FOUND: 插件未提供声明的动作')
    this.activeCalls++
    try {
      if (this.host.authorize && !await this.host.authorize(id, actionId, structuredClone(checkedInput), invocation)) throw new Error('FEATURE_PLUGIN_PERMISSION_DENIED: 插件动作未获批准')
      const latestProject = this.host.projectRoot?.() ?? null
      if (this.host.projectRoot && latestProject !== currentProject && (!latestProject || !currentProject || !sameProjectPath(latestProject, currentProject))) throw new Error('FEATURE_PLUGIN_PROJECT_MISMATCH: 项目已切换')
      if (!featureActionApplies(this.manifests.get(id)!, action, this.host.project?.())) throw new Error('FEATURE_PLUGIN_STUDIO_MISMATCH: 此工具不适用于当前工作台')
      return await diagnosticIpcOperations.run('feature-plugin', actionId, { pluginId: id, projectPath: invocation.projectPath, input: diagnosticValue(checkedInput) }, () => handler.call(runtime, checkedInput, invocation))
    } finally { this.activeCalls-- }
  }
  async initialize(builtins: Array<{ id: string; directory: string }> = []): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    for (const entry of builtins) {
      if (!idPattern.test(entry.id) || this.builtinDirectories.has(entry.id)) throw new Error('内置工作台索引无效')
      this.builtinDirectories.set(entry.id, entry.directory)
    }
    const entries = [...builtins.map(entry => ({ name: entry.id, directory: entry.directory, builtin: true })),
      ...(await fs.readdir(this.root, { withFileTypes: true })).filter(entry => entry.isDirectory() && idPattern.test(entry.name) && !this.builtinDirectories.has(entry.name)).map(entry => ({ name: entry.name, directory: path.join(this.root, entry.name), builtin: false }))]
    for (const entry of entries) {
      try {
        const files = new Map<string, Buffer>()
        const directory = entry.directory
        const manifestBytes = await fs.readFile(path.join(directory, 'manifest.json'))
        if (manifestBytes.length > limit) throw new Error('插件清单过大')
        const declared = JSON.parse(manifestBytes.toString('utf8')) as FeaturePluginManifest
        if (!declared.files || Object.keys(declared.files).length > 512) throw new Error('插件文件清单无效')
        files.set('manifest.json', manifestBytes)
        let total = manifestBytes.length
        const canonicalRoot = await fs.realpath(directory)
        for (const name of Object.keys(declared.files)) {
          if (!allowedFile(name) || name === 'manifest.json') throw new Error('插件文件路径无效')
          const file = path.join(directory, name)
          const stat = await fs.lstat(file)
          const relative = path.relative(canonicalRoot, await fs.realpath(file))
          if (!stat.isFile() || (total += stat.size) > limit || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('插件文件无效')
          files.set(name, await fs.readFile(file))
        }
        const manifest = validate(files)
        if (manifest.id !== entry.name) throw new Error('插件目录与标识不匹配')
        this.checkConflicts(manifest)
        const disabled = !entry.builtin && await fs.stat(path.join(directory, 'disabled')).then(() => true, () => false)
        this.manifests.set(manifest.id, manifest)
        this.records.set(manifest.id, { id: manifest.id, name: manifest.name, version: manifest.version, enabled: !disabled, builtin: entry.builtin, manifest: definition(manifest) })
      } catch (error) { this.records.set(entry.name, { id: entry.name, name: entry.name, version: '', enabled: false, builtin: entry.builtin, error: String(error) }) }
    }
  }
  service<T extends object>(id: string): T {
    if (!this.enabled(id)) throw new Error(`应用功能插件 ${this.records.get(id)?.name ?? id} 未启用，请在侧边栏 → 功能中安装或启用`)
    if (!this.services.has(id)) {
      try {
        const file = path.join(this.directory(id), 'main.cjs')
        const hostRequire = createRequire(this.host.requireFrom)
        const pluginRequire = createRequire(file)
        const localRequest = (name: string): boolean => name.startsWith('.') || path.isAbsolute(name)
        const requirePlugin = Object.assign((name: string) => name === '@modmind/host' ? this.host.capabilities : (localRequest(name) ? pluginRequire(name) : hostRequire(name)), {
          resolve: Object.assign((name: string) => (localRequest(name) ? pluginRequire : hostRequire).resolve(name), { paths: pluginRequire.resolve.paths }),
          cache: hostRequire.cache, extensions: hostRequire.extensions, main: hostRequire.main
        })
        // Native plugins run with application privileges; installation explicitly asks for trust.
        const bytes = hostRequire('node:fs').readFileSync(file) as Buffer
        if (hash(bytes) !== this.manifests.get(id)!.files['main.cjs']) throw new Error('插件文件校验失败')
        const module = { exports: {} as { activate?: (options: unknown) => object } }
        compileFunction(bytes.toString('utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file })(module.exports, requirePlugin, module, file, path.dirname(file))
        if (typeof module.exports.activate !== 'function') throw new Error('插件缺少 activate 入口')
        const declared = this.manifests.get(id)!.hostCapabilities ?? []
        if (declared.some(name => !Object.hasOwn(this.host.capabilities, name))) throw new Error('宿主缺少插件所需的公共能力')
        const configured = this.host.options(id)
        const emitter = Symbol(id)
        this.emitters.set(id, emitter)
        const emitEvent = (event: string, value: unknown, windowId?: number): void => {
          if (!this.enabled(id) || this.changing || this.emitters.get(id) !== emitter) return
          if (!this.manifests.get(id)?.events?.includes(event)) throw new Error('插件事件未声明')
          if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 * 1024) throw new Error('插件事件超过 1 MiB')
          this.host.event?.(id, event, value, windowId)
        }
        const service = module.exports.activate(object(configured) ? { ...configured, pluginId: id, pluginDirectory: path.dirname(file), assetBaseUrl: `modmind-feature://${id}/assets/`, emitEvent } : configured)
        if (!service || typeof service !== 'object') throw new Error('插件服务无效')
        for (const studio of this.manifests.get(id)!.studios ?? []) {
          const provider = (service as unknown as import('../shared/studios').StudioRuntime).studios?.[studio.templateHandler]
          if (!provider || (typeof provider.templateFiles !== 'function' && typeof provider.scaffold !== 'function')) throw new Error('工作台创建实现与清单不一致')
          if (studio.adoption) {
            const adapter = (service as unknown as import('../shared/studios').StudioRuntime).studios?.[studio.adoption.handler]
            if (typeof adapter?.inspectExisting !== 'function' || typeof adapter.adoptExisting !== 'function') throw new Error('工作台接管实现与清单不一致')
          }
        }
        if (this.manifests.get(id)!.apiVersion === FEATURE_PLUGIN_API && (this.manifests.get(id)!.actions ?? []).some(action => typeof (service as FeaturePluginRuntime).actions?.[action.handler] !== 'function' && typeof Reflect.get(service, action.handler) !== 'function')) throw new Error('插件动作实现与清单不一致')
        const guarded = (target: object, value: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
            if (!this.enabled(id) || this.changing || this.services.get(id) !== proxy) throw new Error('插件已停用或正在更改')
            this.activeCalls++
            try { const result = value.apply(target, args); if (result && typeof (result as Promise<unknown>).then === 'function') return Promise.resolve(result).finally(() => { this.activeCalls-- }); this.activeCalls--; return result }
            catch (error) { this.activeCalls--; throw error }
        }
        const actions = (service as FeaturePluginRuntime).actions
        const guardedActions = actions ? new Proxy(actions, { get: (target, property) => { const value = Reflect.get(target, property); return typeof value === 'function' ? guarded(target, value) : value } }) : undefined
        const studioProviders = (service as unknown as Partial<import('../shared/studios').StudioRuntime>).studios
        const guardedStudios = studioProviders ? Object.fromEntries(Object.entries(studioProviders).map(([key, provider]) => [key, new Proxy(provider, { get: (target, property) => {
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? guarded(target, value) : value
        } })])) : undefined
        const proxy: object = new Proxy(service, { get: (target, property) => {
          if (property === 'actions') return guardedActions
          if (property === 'studios') return guardedStudios
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? guarded(target, value) : value
        } })
        this.services.set(id, proxy)
        this.runtimes.set(id, service)
      } catch (error) { this.records.get(id)!.error = String(error); this.revision++; this.host.changed(); throw error }
    }
    return this.services.get(id) as T
  }
  private async change(action: () => Promise<void>, additiveAgentInstall = false): Promise<FeaturePluginRecord[]> {
    if (this.changing || this.activeCalls || (!additiveAgentInstall && (this.host.busy() || this.hasBusyRuntime()))) throw new Error('请等待当前插件任务或工作台任务完成后再更改插件')
    this.changing = true
    try { await action(); this.revision++; this.host.changed(); return this.list() } finally { this.changing = false }
  }
  private checkConflicts(manifest: FeaturePluginManifest): void {
    const visiting = new Set<string>(), visited = new Set<string>()
    const walk = (id: string): void => {
      if (visiting.has(id)) throw new Error('插件依赖包含循环')
      if (visited.has(id)) return
      visiting.add(id)
      const entry = id === manifest.id ? manifest : this.manifests.get(id)
      for (const dependency of entry?.dependencies ?? []) walk(dependency)
      visiting.delete(id); visited.add(id)
    }
    walk(manifest.id)
    for (const installed of this.manifests.values()) {
      if (installed.id === manifest.id) continue
      for (const key of ['views', 'settings', 'tools', 'studios'] as const) {
        const identifiers = new Set((installed[key] ?? []).map(entry => 'id' in entry ? entry.id : entry.name))
        if ((manifest[key] ?? []).some(entry => identifiers.has('id' in entry ? entry.id : entry.name))) throw new Error(`插件贡献与 ${installed.name} 冲突：${key}`)
      }
    }
  }
  private assertNoDependents(id: string): void {
    const dependent = [...this.manifests.values()].find(manifest => manifest.dependencies?.includes(id) && this.records.get(manifest.id)?.enabled)
    if (dependent) throw new Error(`请先停用依赖此插件的 ${dependent.name}`)
  }
  private async deactivate(id: string): Promise<void> {
    this.emitters.delete(id)
    const runtime = this.runtimes.get(id)
    if (runtime?.dispose) await runtime.dispose()
    this.runtimes.delete(id); this.services.delete(id)
    const cache = createRequire(this.host.requireFrom).cache
    const directory = this.directory(id)
    for (const name of Object.keys(cache)) { const relative = path.relative(directory, name); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) delete cache[name] }
  }
  async shutdown(): Promise<void> {
    this.changing = true
    const results = await Promise.allSettled([...this.runtimes.keys()].map(id => this.deactivate(id)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  async projectChanged(projectPath: string | null): Promise<void> {
    if (this.projectPath === projectPath || this.projectPath && projectPath && sameProjectPath(this.projectPath, projectPath)) return
    this.projectPath = projectPath
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.projectChanged?.(projectPath)))
  }
  async stopForSignal(signal: AbortSignal): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.stopForSignal?.(signal)))
  }
  hasBusyRuntime(): boolean { return [...this.runtimes.values()].some(runtime => runtime.isBusy?.()) }
  async install(prepared: PreparedPlugin, additiveAgentInstall = false): Promise<FeaturePluginRecord[]> {
    return this.change(async () => {
      const manifest = validate(prepared.files)
      if (this.records.has(manifest.id)) throw new Error('此插件已安装；更新前请先卸载，已有项目数据和设置会保留')
      this.checkConflicts(manifest)
      const staging = path.join(this.root, '.install-' + randomUUID())
      await fs.mkdir(staging)
      try {
        for (const [name, bytes] of prepared.files) { const target = path.join(staging, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes) }
        await retryTransientFileLock(() => fs.rename(staging, path.join(this.root, manifest.id)))
      } finally { await retryTransientFileLock(() => fs.rm(staging, { recursive: true, force: true })) }
      this.manifests.set(manifest.id, manifest)
      this.records.set(manifest.id, { id: manifest.id, name: manifest.name, version: manifest.version, enabled: true, manifest: definition(manifest) })
    }, additiveAgentInstall)
  }
  /** Replace one verified package; keep the old directory until the new runtime loads. */
  async update(prepared: PreparedPlugin): Promise<FeaturePluginRecord[]> {
    return this.change(async () => {
      const manifest = validate(prepared.files), previous = this.manifests.get(manifest.id), record = this.records.get(manifest.id)
      this.assertMutable(manifest.id)
      if (!previous || !record) throw new Error('请先安装此功能')
      this.checkConflicts(manifest)
      const directory = path.join(this.root, manifest.id), staging = path.join(this.root, '.install-' + randomUUID()), backup = path.join(this.root, '.backup-' + randomUUID())
      await fs.mkdir(staging)
      let moved = false, replaced = false
      try {
        for (const [name, bytes] of prepared.files) { const target = path.join(staging, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes) }
        if (!record.enabled) await fs.writeFile(path.join(staging, 'disabled'), '')
        // Dependants may hold references to this runtime. Dispose them before replacing it.
        const affected = new Set([manifest.id])
        for (let changed = true; changed;) { changed = false; for (const value of this.manifests.values()) if (!affected.has(value.id) && value.dependencies?.some(id => affected.has(id))) { affected.add(value.id); changed = true } }
        for (const id of [...affected].reverse()) await this.deactivate(id)
        await retryTransientFileLock(() => fs.rename(directory, backup)); moved = true
        await retryTransientFileLock(() => fs.rename(staging, directory)); replaced = true
        this.manifests.set(manifest.id, manifest)
        this.records.set(manifest.id, { id: manifest.id, name: manifest.name, version: manifest.version, enabled: record.enabled, manifest: definition(manifest) })
        if (this.enabled(manifest.id)) this.service(manifest.id)
      } catch (error) {
        if (replaced) { await this.deactivate(manifest.id).catch(() => undefined); await retryTransientFileLock(() => fs.rm(directory, { recursive: true, force: true })) }
        if (moved) await retryTransientFileLock(() => fs.rename(backup, directory))
        this.manifests.set(manifest.id, previous); this.records.set(manifest.id, record)
        this.host.changed()
        throw error
      } finally { await retryTransientFileLock(() => fs.rm(staging, { recursive: true, force: true })) }
      // A locked retired file must not turn a successful activation into a false failure.
      await retryTransientFileLock(() => fs.rm(backup, { recursive: true, force: true })).catch(() => undefined)
    })
  }
  async setEnabled(id: string, enabled: boolean, additiveAgentInstall = false): Promise<FeaturePluginRecord[]> {
    this.assertMutable(id)
    return this.change(async () => {
      if (!idPattern.test(id) || !this.records.has(id) || !this.manifests.has(id)) throw new Error('插件不可用，请重新安装')
      if (!enabled) this.assertNoDependents(id)
      if (enabled && this.manifests.get(id)!.dependencies?.some(dependency => !this.enabled(dependency))) throw new Error('请先安装并启用插件依赖')
      await this.deactivate(id)
      const marker = path.join(this.root, id, 'disabled')
      if (enabled) await fs.rm(marker, { force: true }); else await fs.writeFile(marker, '')
      Object.assign(this.records.get(id)!, { enabled, error: undefined })
    }, enabled && additiveAgentInstall)
  }
  async uninstall(id: string): Promise<FeaturePluginRecord[]> {
    this.assertMutable(id)
    return this.change(async () => {
      if (!idPattern.test(id) || !this.records.has(id)) throw new Error('插件不存在')
      this.assertNoDependents(id)
      await this.deactivate(id)
      const retired = path.join(this.root, '.removed-' + randomUUID())
      await retryTransientFileLock(() => fs.rename(path.join(this.root, id), retired))
      this.services.delete(id); this.records.delete(id); this.manifests.delete(id)
      await retryTransientFileLock(() => fs.rm(retired, { recursive: true, force: true }))
    })
  }
  async serve(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), name = decodeURIComponent(url.pathname.slice(1))
      if (request.method !== 'GET' || !this.enabled(url.hostname) || !allowedFile(name) || !(['renderer.js', 'renderer.css'].includes(name) || name.startsWith('assets/')) || !Object.hasOwn(this.manifests.get(url.hostname)?.files ?? {}, name)) return new Response(null, { status: 404 })
      const bytes = await fs.readFile(path.join(this.directory(url.hostname), name))
      if (hash(bytes) !== this.manifests.get(url.hostname)!.files[name]) throw new Error('插件文件校验失败')
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } })
    } catch { return new Response('插件文件不可用，请重新安装', { status: 500 }) }
  }
}
