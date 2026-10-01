import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import yauzl from 'yauzl'
import Ajv, { type ValidateFunction } from 'ajv'
import { BUILTIN_FEATURE_CATALOG } from '../shared/featurePluginCatalog'
import { sameProjectPath } from './projectPath'
import { retryTransientFileLock } from './fileLockRetry'
import { FEATURE_PLUGIN_API, FEATURE_PLUGIN_HOST, type FeaturePluginManifest, type FeaturePluginRecord, type FeaturePluginDefinition, type FeaturePluginCatalogEntry, type FeaturePluginDiscoveredTool, type FeaturePluginInvocationContext, type FeaturePluginSchema, type FeaturePluginRuntime, type FeaturePluginSurface } from '../shared/featurePlugins'

const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const allowedFiles = new Set(['manifest.json', 'main.cjs', 'renderer.js', 'renderer.css'])
const limit = 128 * 1024 * 1024
const archiveLimit = 64 * 1024 * 1024
function allowedFile(name: string): boolean {
  if (allowedFiles.has(name)) return true
  if (!name.startsWith('assets/') || name.length > 512) return false
  return name.split('/').every(part => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
}
export type PreparedPlugin = { manifest: FeaturePluginManifest; files: Map<string, Buffer> }
export interface FeaturePluginHost {
  requireFrom: string
  capabilities: object
  options: (id: string) => unknown
  busy: () => boolean
  changed: () => void
  catalog?: FeaturePluginDefinition[]
  projectRoot?: () => string | null
  authorize?: (pluginId: string, action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) => boolean | Promise<boolean>
  event?: (pluginId: string, event: string, value: unknown, windowId?: number) => void
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function definition(manifest: FeaturePluginManifest): FeaturePluginDefinition {
  const { files: _files, ...value } = manifest
  return structuredClone(value)
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function text(value: unknown, maximum = 300): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum }
function validateContributions(manifest: FeaturePluginManifest): void {
  if (manifest.events !== undefined && (!Array.isArray(manifest.events) || manifest.events.length > 64 || manifest.events.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,79}$/.test(name)) || new Set(manifest.events).size !== manifest.events.length)) throw new Error('插件事件声明无效')
  for (const name of ['capabilities', 'views', 'settings', 'actions', 'tools'] as const) {
    const entries = manifest[name]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.length > 128 || entries.some(entry => !object(entry))) throw new Error(`插件声明无效：${name}`)
    const identifiers = entries.map(entry => 'id' in entry ? entry.id : entry.name)
    if (identifiers.some(id => !text(id, 80) || !/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(id)) || new Set(identifiers).size !== identifiers.length) throw new Error(`插件声明标识无效：${name}`)
  }
  for (const capability of manifest.capabilities ?? []) if (!text(capability.name, 80) || !text(capability.description, 2000)) throw new Error('插件能力说明无效')
  for (const view of manifest.views ?? []) if (!text(view.label, 80) || !text(view.component, 80) || !text(view.icon, 80) || (view.order !== undefined && !Number.isFinite(view.order)) || (view.loaders !== undefined && (!Array.isArray(view.loaders) || view.loaders.some(loader => !text(loader, 80))))) throw new Error('插件页面声明无效')
  for (const setting of manifest.settings ?? []) if (!text(setting.label, 80) || !text(setting.component, 80) || !['general', 'ai', 'development', 'integrations', 'about'].includes(setting.category)) throw new Error('插件设置声明无效')
  for (const action of manifest.actions ?? []) {
    if (action.inspirationOutput !== undefined && typeof action.inspirationOutput !== 'boolean') throw new Error('插件灵感台产物声明无效')
    if (!text(action.handler, 80) || !/^[A-Za-z][A-Za-z0-9:._-]*$/.test(action.handler) || !object(action.inputSchema) || action.inputSchema.type !== 'object' || !['read', 'write', 'network', 'process'].includes(action.permission) || (action.projectRequired !== undefined && typeof action.projectRequired !== 'boolean') || (action.surfaces !== undefined && (!Array.isArray(action.surfaces) || !action.surfaces.length || action.surfaces.some(surface => !['workbench', 'inspiration'].includes(surface))))) throw new Error('插件动作声明无效')
    validateSchema(action.inputSchema)
  }
  for (const tool of manifest.tools ?? []) if (!text(tool.description, 3000) || !/^modmind_[a-z0-9_]+$/.test(tool.name) || !manifest.actions?.some(action => action.id === tool.action)) throw new Error('插件工具声明无效')
  for (const key of ['dependencies', 'hostCapabilities'] as const) if (manifest[key] !== undefined && (!Array.isArray(manifest[key]) || manifest[key]!.length > 32 || manifest[key]!.some(id => typeof id !== 'string' || !(key === 'dependencies' ? idPattern : /^[A-Za-z][A-Za-z0-9_-]{0,63}$/).test(id)) || new Set(manifest[key]).size !== manifest[key]!.length)) throw new Error(`插件依赖声明无效：${key}`)
  if (manifest.dependencies?.includes(manifest.id)) throw new Error('插件不能依赖自身')
  if (manifest.target && (!object(manifest.target) || manifest.target.platform !== process.platform || manifest.target.arch !== process.arch)) throw new Error('插件与当前操作系统或架构不兼容')
}
const schemaValidator = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, validateFormats: false, ownProperties: true, addUsedSchema: false })
const compiledSchemas = new Map<string, ValidateFunction>()
function validator(schema: FeaturePluginSchema): ValidateFunction {
  const key = JSON.stringify(schema)
  let compiled = compiledSchemas.get(key)
  if (!compiled) {
    try { compiled = schemaValidator.compile(schema) } catch (error) { throw new Error(`插件参数 schema 无效：${String(error)}`) }
    if (compiledSchemas.size >= 256) compiledSchemas.delete(compiledSchemas.keys().next().value!)
    compiledSchemas.set(key, compiled)
  }
  return compiled
}
function validateSchema(schema: FeaturePluginSchema): void { validator(schema) }
function validateInput(value: unknown, schema: FeaturePluginSchema): void {
  const check = validator(schema)
  if (!check(value)) {
    const error = check.errors?.[0]
    const reason = error?.keyword === 'required' ? '插件缺少参数' : error?.keyword === 'additionalProperties' ? '插件包含未知参数' : '插件参数无效'
    throw new Error(`${reason}：${error?.instancePath || 'input'} ${error?.message ?? ''}`)
  }
}
function validate(files: Map<string, Buffer>): FeaturePluginManifest {
  const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}') as FeaturePluginManifest
  if (manifest.format !== 'modmind-feature' || manifest.apiVersion !== FEATURE_PLUGIN_API || manifest.hostVersion !== FEATURE_PLUGIN_HOST) throw new Error('应用功能插件接口或版本不兼容，请使用 API 2 的 1.5.0-plugintest 插件包')
  if (!idPattern.test(manifest.id) || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 || typeof manifest.version !== 'string' || manifest.version.length > 80) throw new Error('插件标识或名称无效')
  if (manifest.main !== 'main.cjs' || manifest.renderer !== 'renderer.js' || manifest.style !== 'renderer.css') throw new Error('插件入口无效')
  if (!manifest.files || Object.keys(manifest.files).length > 512 || ['main.cjs', 'renderer.css', 'renderer.js'].some(name => !Object.hasOwn(manifest.files, name)) || files.size !== Object.keys(manifest.files).length + 1 || Object.keys(manifest.files).some(name => !allowedFile(name) || name === 'manifest.json') || new Set([...files.keys()].map(name => name.toLowerCase())).size !== files.size) throw new Error('插件文件清单无效')
  if ([...files.values()].reduce((size, bytes) => size + bytes.length, 0) > limit) throw new Error('插件解压内容超过 128 MiB')
  for (const [name, digest] of Object.entries(manifest.files)) {
    const bytes = files.get(name)
    if (!bytes || hash(bytes) !== digest) throw new Error(`插件文件损坏：${name}`)
  }
  validateContributions(manifest)
  return manifest
}

export async function prepareFeaturePlugin(archive: string): Promise<PreparedPlugin> {
  if ((await fs.stat(archive)).size > archiveLimit) throw new Error('插件包超过 64 MiB')
  const bytes = await fs.readFile(archive)
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('插件包无法读取'))
      const files = new Map<string, Buffer>()
      let total = 0
      const fail = (error: unknown): void => { zip.close(); reject(error) }
      zip.on('error', fail)
      zip.on('entry', entry => {
        const type = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!allowedFile(entry.fileName) || files.size >= 513 || files.has(entry.fileName) || (type !== 0 && type !== 0o100000) || entry.uncompressedSize > limit || (total += entry.uncompressedSize) > limit) return fail(new Error('插件包包含不允许的路径、重复文件或过大的内容'))
        files.set(entry.fileName, Buffer.alloc(0))
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error('插件文件无法读取'))
          const chunks: Buffer[] = []
          let size = 0
          stream.on('error', fail)
          stream.on('data', chunk => { size += chunk.length; if (size > entry.uncompressedSize || size > limit) { stream.destroy(); fail(new Error('插件文件大小无效')) } else chunks.push(chunk) })
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
        })
      })
      zip.on('end', () => { try { resolve({ manifest: validate(files), files }) } catch (error) { reject(error) } })
      zip.readEntry()
    })
  })
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
  constructor(private readonly root: string, private readonly host: FeaturePluginHost) {}
  list(): FeaturePluginRecord[] { return [...this.records.values()].map(record => structuredClone(record)) }
  manifest(id: string): FeaturePluginDefinition | undefined { const manifest = this.manifests.get(id); return manifest ? definition(manifest) : undefined }
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
        installed: Boolean(record), available,
        state: !record ? 'not-installed' : record.error ? 'error' : !record.enabled ? 'disabled' : available ? 'ready' : 'dependency-missing',
        installHint: '设置 → 集成 → 应用功能插件'
      }
    })
  }
  discoverInstalled(): FeaturePluginRecord[] { return this.list() }
  snapshot(): { revision: number; plugins: FeaturePluginCatalogEntry[] } { return { revision: this.revision, plugins: this.catalog() } }
  tools(surface: FeaturePluginSurface = 'workbench'): FeaturePluginDiscoveredTool[] {
    const result: FeaturePluginDiscoveredTool[] = []
    for (const manifest of this.manifests.values()) {
      if (!this.enabled(manifest.id)) continue
      for (const tool of manifest.tools ?? []) {
        const action = manifest.actions?.find(action => action.id === tool.action)
        if (!action || (action.surfaces && !action.surfaces.includes(surface))) continue
        result.push({ ...structuredClone(tool), pluginId: manifest.id, inputSchema: structuredClone(action.inputSchema), permission: action.permission, projectRequired: action.projectRequired ?? false, inspirationOutput: action.inspirationOutput })
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
    if (context.readOnly && action.permission !== 'read' && !(action.inspirationOutput && context.surface === 'inspiration' && context.allowInspirationOutput === true)) throw new Error('FEATURE_PLUGIN_READ_ONLY: 当前会话只允许读取')
    if (context.surface && action.surfaces && !action.surfaces.includes(context.surface)) throw new Error('FEATURE_PLUGIN_SURFACE_DENIED: 当前工作区不支持此动作')
    const currentProject = this.host.projectRoot?.() ?? null
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
      return await handler.call(runtime, checkedInput, invocation)
    } finally { this.activeCalls-- }
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue
      try {
        const files = new Map<string, Buffer>()
        const directory = path.join(this.root, entry.name)
        const manifestBytes = await fs.readFile(path.join(directory, 'manifest.json'))
        if (manifestBytes.length > limit) throw new Error('插件清单过大')
        const declared = JSON.parse(manifestBytes.toString('utf8')) as FeaturePluginManifest
        if (!declared.files || Object.keys(declared.files).length > 512) throw new Error('插件文件清单无效')
        files.set('manifest.json', manifestBytes)
        let total = manifestBytes.length
        const canonicalRoot = await fs.realpath(directory)
        for (const name of Object.keys(declared.files)) {
          if (!allowedFile(name) || name === 'manifest.json') throw new Error('插件文件路径无效')
          const file = path.join(this.root, entry.name, name)
          const stat = await fs.lstat(file)
          const relative = path.relative(canonicalRoot, await fs.realpath(file))
          if (!stat.isFile() || (total += stat.size) > limit || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('插件文件无效')
          files.set(name, await fs.readFile(file))
        }
        const manifest = validate(files)
        if (manifest.id !== entry.name) throw new Error('插件目录与标识不匹配')
        const disabled = await fs.stat(path.join(this.root, entry.name, 'disabled')).then(() => true, () => false)
        this.manifests.set(manifest.id, manifest)
        this.records.set(manifest.id, { id: manifest.id, name: manifest.name, version: manifest.version, enabled: !disabled, manifest: definition(manifest) })
      } catch (error) { this.records.set(entry.name, { id: entry.name, name: entry.name, version: '', enabled: false, error: String(error) }) }
    }
  }
  service<T extends object>(id: string): T {
    if (!this.enabled(id)) throw new Error(`应用功能插件 ${this.records.get(id)?.name ?? id} 未启用，请在设置 → 集成 → 应用功能插件中安装或启用`)
    if (!this.services.has(id)) {
      try {
        const file = path.join(this.root, id, 'main.cjs')
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
        if (this.manifests.get(id)!.apiVersion === FEATURE_PLUGIN_API && (this.manifests.get(id)!.actions ?? []).some(action => typeof (service as FeaturePluginRuntime).actions?.[action.handler] !== 'function' && typeof Reflect.get(service, action.handler) !== 'function')) throw new Error('插件动作实现与清单不一致')
        const guarded = (target: object, value: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
            if (!this.enabled(id) || this.changing || this.services.get(id) !== proxy) throw new Error('插件已停用或正在更改')
            this.activeCalls++
            try { const result = value.apply(target, args); if (result && typeof (result as Promise<unknown>).then === 'function') return Promise.resolve(result).finally(() => { this.activeCalls-- }); this.activeCalls--; return result }
            catch (error) { this.activeCalls--; throw error }
        }
        const actions = (service as FeaturePluginRuntime).actions
        const guardedActions = actions ? new Proxy(actions, { get: (target, property) => { const value = Reflect.get(target, property); return typeof value === 'function' ? guarded(target, value) : value } }) : undefined
        const proxy: object = new Proxy(service, { get: (target, property) => {
          if (property === 'actions') return guardedActions
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? guarded(target, value) : value
        } })
        this.services.set(id, proxy)
        this.runtimes.set(id, service)
      } catch (error) { this.records.get(id)!.error = String(error); this.revision++; this.host.changed(); throw error }
    }
    return this.services.get(id) as T
  }
  private async change(action: () => Promise<void>): Promise<FeaturePluginRecord[]> {
    if (this.changing || this.activeCalls || this.host.busy()) throw new Error('请等待当前插件任务或工作台任务完成后再更改插件')
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
      for (const key of ['views', 'settings', 'tools'] as const) {
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
    const directory = path.join(this.root, id)
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
  async install(prepared: PreparedPlugin): Promise<FeaturePluginRecord[]> {
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
    })
  }
  async setEnabled(id: string, enabled: boolean): Promise<FeaturePluginRecord[]> {
    return this.change(async () => {
      if (!idPattern.test(id) || !this.records.has(id) || !this.manifests.has(id)) throw new Error('插件不可用，请重新安装')
      if (!enabled) this.assertNoDependents(id)
      if (enabled && this.manifests.get(id)!.dependencies?.some(dependency => !this.enabled(dependency))) throw new Error('请先安装并启用插件依赖')
      await this.deactivate(id)
      const marker = path.join(this.root, id, 'disabled')
      if (enabled) await fs.rm(marker, { force: true }); else await fs.writeFile(marker, '')
      Object.assign(this.records.get(id)!, { enabled, error: undefined })
    })
  }
  async uninstall(id: string): Promise<FeaturePluginRecord[]> {
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
      const bytes = await fs.readFile(path.join(this.root, url.hostname, name))
      if (hash(bytes) !== this.manifests.get(url.hostname)!.files[name]) throw new Error('插件文件校验失败')
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } })
    } catch { return new Response('插件文件不可用，请重新安装', { status: 500 }) }
  }
}
