import type { ProjectInfo, ProjectCreateInput, ExistingProjectAnalysis, ExistingProjectAdoptInput } from '../shared/types'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { FeaturePluginCatalogEntry, FeaturePluginInvocationContext } from '../shared/featurePlugins'
import { studioRecords, resolveStudio, studioContext, studioFormValues, studioFieldVisible, type StudioRuntime, type StudioRecord, type StudioSurface } from '../shared/studios'

export function validateStudioTemplateFiles(files: Record<string, string>): Record<string, string> {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 4096) throw new Error('工作台模板文件集合无效')
  let bytes = 0
  for (const [relative, content] of Object.entries(files)) {
    if (!relative || relative.length > 512 || relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) throw new Error('工作台模板包含无效文件路径')
    if (typeof content !== 'string' || (bytes += Buffer.byteLength(content)) > 32 * 1024 * 1024) throw new Error('工作台模板内容无效或超过 32 MiB')
  }
  return files
}

export class StudioRegistry {
  constructor(
    private readonly catalog: () => FeaturePluginCatalogEntry[],
    private readonly runtime: (id: string) => StudioRuntime,
    private readonly assetDirectory?: (id: string, group: string) => string,
    private readonly invoke?: (id: string, action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) => Promise<unknown>
  ) {}
  list(): StudioRecord[] { return studioRecords(this.catalog()) }
  resolve(project: ProjectInfo): StudioRecord | undefined { return resolveStudio(this.list(), project) }
  context(project: ProjectInfo, surface: StudioSurface) { return studioContext(this.list(), project, surface) }
  async invokeTask(project: ProjectInfo, task: 'check' | 'build' | 'test' | 'export', input: Record<string, unknown>, context: FeaturePluginInvocationContext): Promise<unknown> {
    const record = this.require(project), binding = record.definition.tasks?.[task]
    if (!binding || !this.invoke) throw new Error('STUDIO_TASK_UNAVAILABLE: 此工作台未提供该任务入口')
    return this.invoke(binding.pluginId ?? record.pluginId, binding.action, { ...binding.input, ...input }, { ...context, projectPath: project.path })
  }
  skillDirectories(project: ProjectInfo): string[] {
    const record = this.resolve(project)
    return record?.available && record.definition.skillAssetGroup && this.assetDirectory ? [this.assetDirectory(record.pluginId, record.definition.skillAssetGroup)] : []
  }
  require(project: ProjectInfo): StudioRecord {
    const record = this.resolve(project)
    if (!record) throw new Error(`STUDIO_NOT_FOUND: 需要下载${project.studioName ?? project.studioId ?? project.kind ?? '模组工作台'}`)
    if (!record.available) throw new Error(`STUDIO_UNAVAILABLE: 请在功能页安装或启用“${record.definition.name}”工作台`)
    if (record.definition.projectKind !== (project.kind ?? 'mod') || !record.definition.loaders.includes(project.loader)) throw new Error('STUDIO_TARGET_MISMATCH: 工作台与项目类型或平台不匹配')
    return record
  }
  select(input: ProjectCreateInput): StudioRecord {
    const record = resolveStudio(this.list(), { ...input, kind: input.kind ?? 'mod' })
    if (!record || !record.available) throw new Error('STUDIO_UNAVAILABLE: 请先在功能页安装或启用所选工作台')
    if (record.definition.projectKind !== (input.kind ?? 'mod') || !record.definition.loaders.includes(input.loader)) throw new Error('STUDIO_TARGET_MISMATCH: 工作台与目标不匹配')
    this.validateCreation(record, input)
    return record
  }
  validateCreation(record: StudioRecord, input: ProjectCreateInput): void {
    const fields = record.definition.creation?.fields
    if (!fields) return
    if (input.studioValues && (typeof input.studioValues !== 'object' || Array.isArray(input.studioValues)
      || Object.keys(input.studioValues).some(key => !fields.some(field => field.id === key))
      || Object.values(input.studioValues).some(value => typeof value !== 'string' || value.length > 2000))) throw new Error('STUDIO_FORM_INVALID: 工作台字段无效')
    const values = studioFormValues(record.definition, input)
    for (const field of fields) if (input.studioValues?.[field.id] !== undefined && input.studioValues[field.id] !== values[field.id]) throw new Error(`STUDIO_FORM_INVALID: ${field.title}与项目目标或条件不一致`)
    for (const field of fields) {
      const value = values[field.id] ?? ''
      if (field.readOnly && value !== field.default) throw new Error(`STUDIO_FORM_INVALID: ${field.title}为固定值，不可修改`)
      if (!studioFieldVisible(field.when, values)) continue
      if (field.required && !value.trim()) throw new Error(`STUDIO_FORM_REQUIRED: 请填写${field.title}`)
      if (value.length > (field.maxLength ?? 2000)) throw new Error(`STUDIO_FORM_INVALID: ${field.title}过长`)
      if (field.options && !field.options.some(option => option.value === value && studioFieldVisible(option.when, values))) throw new Error(`STUDIO_FORM_INVALID: ${field.title}选项无效`)
      if (field.bind && input[field.bind] !== value) throw new Error(`STUDIO_FORM_INVALID: ${field.title}与项目目标不一致`)
    }
  }
  async inspectExisting(sourcePath: string): Promise<ExistingProjectAnalysis> {
    const root = await fs.realpath(sourcePath)
    const records = this.list().filter(record => record.definition.adoption).sort((a, b) => b.definition.adoption!.priority - a.definition.adoption!.priority || a.definition.id.localeCompare(b.definition.id))
    for (const record of records) {
      const declaration = record.definition.adoption!
      const markers = await Promise.all(declaration.markers.map(async marker => {
        const file = path.resolve(root, marker), relative = path.relative(root, file)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('STUDIO_MARKER_INVALID: 项目标记路径无效')
        const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (!stat?.isFile() || stat.isSymbolicLink()) return false
        const canonicalRelative = path.relative(root, await fs.realpath(file))
        if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error('STUDIO_MARKER_INVALID: 项目标记越过实际目录边界')
        return true
      }))
      if (declaration.markers.length && !markers.some(Boolean)) continue
      if (!record.available) {
        if (!markers.some(Boolean)) continue
        return { sourcePath: root, sourceName: path.basename(root), kind: 'complete', fileCount: 0, sourceFileCount: 0, documentCount: 0,
          detectedFiles: declaration.markers.filter((_marker, i) => markers[i]), reasons: [`需要下载${record.definition.name}`],
          studio: { id: record.definition.id, name: record.definition.name, pluginId: record.pluginId, available: false },
          inferred: { name: path.basename(root), namespace: path.basename(root).toLowerCase().replace(/[^a-z0-9_]/g, '_'), kind: record.definition.projectKind, studioId: record.definition.id, loader: record.definition.defaultTarget.loader as ProjectInfo['loader'], minecraftVersion: record.definition.defaultTarget.version } }
      }
      const provider = this.runtime(record.pluginId).studios?.[declaration.handler]
      if (!provider?.inspectExisting || !provider.adoptExisting) throw new Error('STUDIO_ADOPTION_HANDLER_MISSING: 工作台未实现接管接口')
      const result = await provider.inspectExisting(root)
      if (!result) continue
      const resultRoot = await fs.realpath(result.sourcePath)
      const relativeRoot = path.relative(root, resultRoot)
      if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot) || !(await fs.stat(resultRoot)).isDirectory() || !['complete', 'partial', 'api-docs', 'modpack'].includes(result.kind)
        || !Array.isArray(result.reasons) || !Array.isArray(result.detectedFiles) || result.reasons.length > 128 || result.detectedFiles.length > 6000
        || [result.fileCount, result.sourceFileCount, result.documentCount].some(value => !Number.isSafeInteger(value) || value < 0)
        || !result.inferred || !record.definition.loaders.includes(result.inferred.loader)
        || (result.inferred.kind ?? 'mod') !== record.definition.projectKind) throw new Error('STUDIO_ADOPTION_RESULT_INVALID: 工作台识别结果无效')
      return { ...result, studio: { id: record.definition.id, name: record.definition.name, pluginId: record.pluginId, available: true },
        inferred: { ...result.inferred, studioId: record.definition.id, kind: record.definition.projectKind } }
    }
    throw new Error('STUDIO_ADOPTION_NO_MATCH: 没有可接管此项目的工作台，请先安装对应工作台')
  }
  async adoptExisting(input: ExistingProjectAdoptInput, analysis: ExistingProjectAnalysis) {
    const record = this.select(input)
    if (analysis.studio?.id !== record.definition.id || !analysis.studio.available) throw new Error('STUDIO_ADOPTION_MISMATCH: 项目识别结果与所选工作台不匹配')
    if (analysis.kind === 'complete' && input.loader !== analysis.inferred.loader) throw new Error('STUDIO_ADOPTION_TARGET_MISMATCH: 完整工程必须保留原平台；更换平台需要迁移')
    const handler = record.definition.adoption?.handler
    if (!handler) throw new Error('STUDIO_ADOPTION_UNSUPPORTED: 此工作台未声明接管能力')
    const provider = this.runtime(record.pluginId).studios?.[handler]
    if (!provider?.adoptExisting) throw new Error('STUDIO_ADOPTION_HANDLER_MISSING: 接管实现不存在')
    const result = await provider.adoptExisting(input, analysis)
    if (!result || !['in-place', 'host-managed'].includes(result.mode)) throw new Error('STUDIO_ADOPTION_RESULT_INVALID: 接管计划无效')
    return result
  }
  private provider(project: ProjectInfo) {
    const record = this.require(project)
    const provider = this.runtime(record.pluginId).studios?.[record.definition.templateHandler]
    if (!provider) throw new Error('STUDIO_HANDLER_MISSING: 工作台未提供工程创建实现')
    return provider
  }
  templateFiles(project: ProjectInfo, includeStarter = true): Record<string, string> {
    const provider = this.provider(project)
    if (!provider.templateFiles) throw new Error('STUDIO_TEMPLATE_UNSUPPORTED: 此工作台使用异步创建入口')
    return validateStudioTemplateFiles(provider.templateFiles(project, includeStarter))
  }
  async scaffold(project: ProjectInfo, writeFiles: (files: Record<string, string>) => Promise<void>): Promise<void> {
    const provider = this.provider(project)
    if (provider.scaffold) await provider.scaffold(project)
    else if (provider.templateFiles) await writeFiles(validateStudioTemplateFiles(provider.templateFiles(project, true)))
    else throw new Error('STUDIO_HANDLER_MISSING: 工作台缺少创建入口')
  }
}

let registry: StudioRegistry | undefined
export function configureStudios(value: StudioRegistry): void { registry = value }
export function studios(): StudioRegistry {
  if (!registry) throw new Error('STUDIO_REGISTRY_UNAVAILABLE: 工作台宿主尚未初始化')
  return registry
}
