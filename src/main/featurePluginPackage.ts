import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import yauzl from 'yauzl'
import Ajv, { type ValidateFunction } from 'ajv'
import { STUDIO_DEFINITION_SCHEMA } from '../shared/studioSchema'
import { FEATURE_PLUGIN_API, FEATURE_PLUGIN_HOST, FEATURE_PLUGIN_ARCHIVE_LIMIT, FEATURE_PLUGIN_UNPACKED_LIMIT, type FeaturePluginManifest, type FeaturePluginSchema } from '../shared/featurePlugins'

// Archive format validation only: importing a package never activates its code.
const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const packageEntryFiles = new Set(['manifest.json', 'main.cjs', 'renderer.js', 'renderer.css'])
const limit = FEATURE_PLUGIN_UNPACKED_LIMIT
const archiveLimit = FEATURE_PLUGIN_ARCHIVE_LIMIT
export function isFeaturePluginFile(name: string): boolean {
  if (packageEntryFiles.has(name)) return true
  if (!name.startsWith('assets/') || name.length > 512) return false
  return name.split('/').every(part => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
}
export type PreparedPlugin = { manifest: FeaturePluginManifest; files: Map<string, Buffer> }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function text(value: unknown, maximum = 300): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum }
function validateScope(scope: { studioIds?: string[]; loaders?: string[] }): void {
  for (const key of ['studioIds', 'loaders'] as const) {
    const values = scope[key]
    if (values !== undefined && (!Array.isArray(values) || !values.length || values.length > 32 || values.some(value => typeof value !== 'string' || !idPattern.test(value)) || new Set(values).size !== values.length)) throw new Error('插件工作台或平台范围无效')
  }
}
function validateContributions(manifest: FeaturePluginManifest): void {
  validateScope(manifest)
  if (manifest.events !== undefined && (!Array.isArray(manifest.events) || manifest.events.length > 64 || manifest.events.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,79}$/.test(name)) || new Set(manifest.events).size !== manifest.events.length)) throw new Error('插件事件声明无效')
  for (const name of ['capabilities', 'views', 'settings', 'actions', 'tools', 'studios'] as const) {
    const entries = manifest[name]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.length > 128 || entries.some(entry => !object(entry))) throw new Error(`插件声明无效：${name}`)
    const identifiers = entries.map(entry => 'id' in entry ? entry.id : entry.name)
    if (identifiers.some(id => !text(id, 80) || !/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(id)) || new Set(identifiers).size !== identifiers.length) throw new Error(`插件声明标识无效：${name}`)
  }
  for (const capability of manifest.capabilities ?? []) if (!text(capability.name, 80) || !text(capability.description, 2000)) throw new Error('插件能力说明无效')
  for (const view of manifest.views ?? []) if (!text(view.label, 80) || !text(view.component, 80) || !text(view.icon, 80) || (view.order !== undefined && !Number.isFinite(view.order)) || (view.loaders !== undefined && (!Array.isArray(view.loaders) || view.loaders.some(loader => !text(loader, 80))))) throw new Error('插件页面声明无效')
  for (const setting of manifest.settings ?? []) if (!text(setting.label, 80) || !text(setting.component, 80) || !['general', 'ai', 'development', 'integrations', 'about'].includes(setting.category)) throw new Error('插件设置声明无效')
  for (const contribution of [...(manifest.views ?? []), ...(manifest.settings ?? []), ...(manifest.actions ?? [])]) validateScope(contribution)
  for (const action of manifest.actions ?? []) {
    if (action.studioIds && (!Array.isArray(action.studioIds) || !action.studioIds.length || action.studioIds.length > 32 || action.studioIds.some(id => !idPattern.test(id)) || !action.projectRequired)) throw new Error('插件动作的工作台范围无效')
    if (action.inspirationOutput !== undefined && typeof action.inspirationOutput !== 'boolean') throw new Error('插件灵感台产物声明无效')
    if (!text(action.handler, 80) || !/^[A-Za-z][A-Za-z0-9:._-]*$/.test(action.handler) || !object(action.inputSchema) || action.inputSchema.type !== 'object' || !['read', 'write', 'network', 'process'].includes(action.permission) || (action.projectRequired !== undefined && typeof action.projectRequired !== 'boolean') || (action.surfaces !== undefined && (!Array.isArray(action.surfaces) || !action.surfaces.length || action.surfaces.some(surface => !['workbench', 'inspiration'].includes(surface))))) throw new Error('插件动作声明无效')
    validateSchema(action.inputSchema)
  }
  for (const tool of manifest.tools ?? []) if (!text(tool.description, 3000) || !/^modmind_[a-z0-9_]+$/.test(tool.name) || !manifest.actions?.some(action => action.id === tool.action)) throw new Error('插件工具声明无效')
  for (const studio of manifest.studios ?? []) {
    validateFeaturePluginInput(studio, STUDIO_DEFINITION_SCHEMA)
    if (!studio.loaders.includes(studio.defaultTarget.loader)) throw new Error('工作台默认平台不在支持范围内')
    const fields = studio.creation?.fields ?? []
    if (new Set(fields.map(field => field.id)).size !== fields.length || new Set(fields.filter(field => field.bind).map(field => field.bind)).size !== fields.filter(field => field.bind).length) throw new Error('工作台表单字段或绑定重复')
    for (const field of fields) {
      if (field.readOnly && (field.default === undefined || field.source || (field.options && !field.options.some(option => option.value === field.default)))) throw new Error('工作台只读字段需要有效的固定默认值')
      if (field.type !== 'input' && !field.options && !field.source) throw new Error('工作台选项字段缺少选项来源')
      if (field.options && new Set(field.options.map(option => option.value)).size !== field.options.length) throw new Error('工作台表单选项重复')
      if (field.source && (field.type !== 'select' || field.options || !fields.some(candidate => candidate.id === field.source!.loaderField && candidate.bind === 'loader'))) throw new Error('工作台动态选项来源无效')
      const references = [...Object.keys(field.when ?? {}), ...(field.options ?? []).flatMap(option => Object.keys(option.when ?? {}))]
      if (references.some(key => key === field.id || !fields.some(candidate => candidate.id === key))) throw new Error('工作台表单条件引用无效')
    }
    if (studio.adoption?.markers.some(marker => marker.split('/').some(segment => !segment || segment === '.' || segment === '..'))) throw new Error('工作台接管标记路径无效')
    for (const profile of Object.values(studio.ai)) {
      const variantLoaders = profile.variants?.flatMap(variant => variant.loaders) ?? []
      if (variantLoaders.some(loader => !studio.loaders.includes(loader)) || new Set(variantLoaders).size !== variantLoaders.length) throw new Error('工作台 AI 平台分支存在重复或不支持的平台')
    }
    if (studio.skillAssetGroup && !Object.hasOwn(manifest.assets ?? {}, studio.skillAssetGroup)) throw new Error('工作台 skill 资源组未声明')
    for (const binding of Object.values(studio.tasks ?? {})) {
      if (binding.pluginId && binding.pluginId !== manifest.id) {
        if (!idPattern.test(binding.pluginId)) throw new Error('工作台任务引用的插件标识无效')
      } else if (!manifest.actions?.some(action => action.id === binding.action)) throw new Error('工作台任务引用未知动作')
    }
  }
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
export function validateFeaturePluginInput(value: unknown, schema: FeaturePluginSchema): void {
  const check = validator(schema)
  if (!check(value)) {
    const error = check.errors?.[0]
    const reason = error?.keyword === 'required' ? '插件缺少参数' : error?.keyword === 'additionalProperties' ? '插件包含未知参数' : '插件参数无效'
    throw new Error(`${reason}：${error?.instancePath || 'input'} ${error?.message ?? ''}`)
  }
}
export function validateFeaturePluginFiles(files: Map<string, Buffer>): FeaturePluginManifest {
  const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}') as FeaturePluginManifest
  if (manifest.format !== 'modmind-feature' || manifest.apiVersion !== FEATURE_PLUGIN_API || manifest.hostVersion !== FEATURE_PLUGIN_HOST) throw new Error(`应用功能插件接口或版本不兼容，请使用 API ${FEATURE_PLUGIN_API} 的 ${FEATURE_PLUGIN_HOST} 插件包`)
  if (!idPattern.test(manifest.id) || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 || typeof manifest.version !== 'string' || manifest.version.length > 80) throw new Error('插件标识或名称无效')
  if (manifest.main !== 'main.cjs' || manifest.renderer !== 'renderer.js' || manifest.style !== 'renderer.css') throw new Error('插件入口无效')
  if (!manifest.files || Object.keys(manifest.files).length > 512 || ['main.cjs', 'renderer.css', 'renderer.js'].some(name => !Object.hasOwn(manifest.files, name)) || files.size !== Object.keys(manifest.files).length + 1 || Object.keys(manifest.files).some(name => !isFeaturePluginFile(name) || name === 'manifest.json') || new Set([...files.keys()].map(name => name.toLowerCase())).size !== files.size) throw new Error('插件文件清单无效')
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
        if (!isFeaturePluginFile(entry.fileName) || files.size >= 513 || files.has(entry.fileName) || (type !== 0 && type !== 0o100000) || entry.uncompressedSize > limit || (total += entry.uncompressedSize) > limit) return fail(new Error('插件包包含不允许的路径、重复文件或过大的内容'))
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
      zip.on('end', () => { try {
        const manifest = validateFeaturePluginFiles(files)
        if (path.extname(archive).toLowerCase() === '.mmstudio' && !manifest.studios?.length) throw new Error('工作台包未声明领域工作台')
        resolve({ manifest, files })
      } catch (error) { reject(error) } })
      zip.readEntry()
    })
  })
}

