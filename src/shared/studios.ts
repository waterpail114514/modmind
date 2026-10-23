import type { FeaturePluginCatalogEntry, FeaturePluginRecord, FeaturePluginInvocationContext } from './featurePlugins'
import type { ProjectInfo, ProjectCreateInput, ExistingProjectAnalysis, ExistingProjectAdoptInput } from './types'

export const STUDIO_API_VERSION = 1
export type StudioSurface = 'workbench' | 'inspiration'
export interface StudioAiProfile {
  instructions: string
  skills: string[]
  greetings?: string[]
  starters?: Array<{ title: string; prompt: string }>
  variants?: Array<{ loaders: string[]; instructions: string; skills: string[] }>
}
export interface StudioActionBinding { pluginId?: string; action: string; input?: Record<string, unknown> }
export interface StudioFormOption { value: string; title: string; when?: Record<string, string[]> }
export interface StudioFormField {
  id: string
  title: string
  type: 'input' | 'options' | 'select'
  bind?: 'name' | 'loader' | 'minecraftVersion'
  default?: string
  required?: boolean
  readOnly?: boolean
  placeholder?: string
  maxLength?: number
  options?: StudioFormOption[]
  source?: { kind: 'loader-versions'; loaderField: string }
  when?: Record<string, string[]>
}
export interface StudioAdoptionPlan { mode: 'in-place' | 'host-managed'; project?: ProjectInfo | null }
export interface StudioDefinition {
  apiVersion: 1
  id: string
  name: string
  projectKind: string
  loaders: string[]
  defaultTarget: { loader: string; version: string }
  templateHandler: string
  skillAssetGroup?: string
  ai: Record<StudioSurface, StudioAiProfile>
  tasks?: Partial<Record<'check' | 'build' | 'test' | 'export', StudioActionBinding>>
  creation?: { fields: StudioFormField[] }
  adoption?: { handler: string; priority: number; markers: string[] }
  navigation?: { hideCoreViews: Array<'build'>; compactSidebar?: boolean }
}
export interface StudioRecord {
  definition: StudioDefinition
  pluginId: string
  available: boolean
  state: FeaturePluginCatalogEntry['state']
  installHint: string
}
export interface StudioTemplateProvider {
  templateFiles?: (project: ProjectInfo, includeStarter: boolean) => Record<string, string>
  scaffold?: (project: ProjectInfo) => Promise<void>
  inspectExisting?: (sourcePath: string) => Promise<ExistingProjectAnalysis | null>
  adoptExisting?: (input: ExistingProjectAdoptInput, analysis: ExistingProjectAnalysis) => Promise<StudioAdoptionPlan>
}

export function studioFieldVisible(when: Record<string, string[]> | undefined, values: Record<string, string>): boolean {
  return !when || Object.entries(when).every(([key, allowed]) => allowed.includes(values[key]))
}

export function studioFormValues(definition: StudioDefinition, input?: Partial<ProjectCreateInput>): Record<string, string> {
  const values = Object.assign(Object.fromEntries((definition.creation?.fields ?? []).map(field => [field.id, field.default ?? ''])), input?.studioValues)
  for (const field of definition.creation?.fields ?? []) if (field.bind && input?.[field.bind] !== undefined) values[field.id] = input[field.bind]!
  for (const field of definition.creation?.fields ?? []) {
    const chosen = field.options?.find(option => option.value === values[field.id])
    for (const [key, allowed] of Object.entries(chosen?.when ?? {})) if (!allowed.includes(values[key])) values[key] = allowed[0]
  }
  return values
}

export function studioFormInput(definition: StudioDefinition, values: Record<string, string>): ProjectCreateInput {
  const input: ProjectCreateInput = { studioId: definition.id, kind: definition.projectKind, name: '', loader: definition.defaultTarget.loader as ProjectCreateInput['loader'], minecraftVersion: definition.defaultTarget.version, studioValues: { ...values } }
  for (const field of definition.creation?.fields ?? []) if (field.bind && studioFieldVisible(field.when, values)) Object.assign(input, { [field.bind]: values[field.id] })
  return input
}
export interface StudioRuntime { studios: Record<string, StudioTemplateProvider> }
export interface StudioApi {
  list: () => Promise<StudioRecord[]>
  context: (surface: StudioSurface, projectPath: string) => Promise<StudioContext>
}
export interface StudioContext {
  id: string | null
  name?: string
  available: boolean
  surface: StudioSurface
  instructions: string
  skills: string[]
  pluginId?: string
  state?: StudioRecord['state']
  installHint?: string
}
export type StudioInvocationContext = FeaturePluginInvocationContext & { surface: StudioSurface }

export function studioRecords(catalog: FeaturePluginCatalogEntry[]): StudioRecord[] {
  return catalog.flatMap(plugin => (plugin.manifest?.studios ?? []).map(definition => ({
    definition, pluginId: plugin.id, available: plugin.available, state: plugin.state, installHint: plugin.installHint
  })))
}

export function studioCreationRecords(installed: FeaturePluginRecord[], catalog: FeaturePluginCatalogEntry[]): StudioRecord[] {
  return studioRecords(installed.flatMap(plugin => {
    const status = catalog.find(entry => entry.id === plugin.id)
    return plugin.enabled && !plugin.error && status?.installed && status.available
      ? [{ ...status, manifest: plugin.manifest }] : []
  })).filter(record => record.definition.creation)
}

export function projectStudioRequirement(records: StudioRecord[], project: ProjectInfo): { available: boolean; name: string; pluginId?: string } {
  if (project.draft) return { available: true, name: '' }
  const record = resolveStudio(records, project)
  const legacy: Record<string, string> = { mod: '模组工作台', modpack: '整合包工作台', 'server-plugin': '服务端插件工作台' }
  return { available: Boolean(record?.available), name: record?.definition.name ?? project.studioName ?? legacy[project.kind ?? 'mod'] ?? project.studioId ?? project.kind ?? '未知工作台', pluginId: record?.pluginId }
}

export function resolveStudio(records: StudioRecord[], project: Pick<ProjectInfo, 'kind' | 'loader' | 'studioId' | 'draft'>): StudioRecord | undefined {
  if (project.draft) return undefined
  if (project.studioId) return records.find(record => record.definition.id === project.studioId && record.definition.projectKind === (project.kind ?? 'mod') && record.definition.loaders.includes(project.loader))
  const kind = project.kind ?? 'mod'
  const legacyIds: Record<string, string> = { mod: 'minecraft-mod', modpack: 'minecraft-modpack', 'server-plugin': 'minecraft-server-plugin' }
  const matches = records.filter(record => record.definition.projectKind === kind && record.definition.loaders.includes(project.loader))
  if (Object.prototype.hasOwnProperty.call(legacyIds, kind)) return matches.find(record => record.definition.id === legacyIds[kind])
  return matches.length === 1 ? matches[0] : undefined
}

export function studioContext(records: StudioRecord[], project: ProjectInfo, surface: StudioSurface): StudioContext {
  const record = resolveStudio(records, project)
  if (!record) return { id: project.studioId ?? null, available: false, surface, instructions: '', skills: [] }
  const { definition } = record
  const profile = definition.ai[surface]
  const variant = profile.variants?.find(value => value.loaders.includes(project.loader))
  const values: Record<string, string> = {
    name: project.name, loader: project.loader, version: project.minecraftVersion,
    apiVersion: project.apiVersion ?? project.minecraftVersion, javaVersion: String(project.javaVersion ?? 'resolve from build')
  }
  const instructions = [profile.instructions, variant?.instructions].filter(Boolean).join('\n\n')
    .replace(/\{\{(name|loader|version|apiVersion|javaVersion)\}\}/g, (_match, key: string) => values[key])
  return {
    id: definition.id, name: definition.name, pluginId: record.pluginId, available: record.available,
    state: record.state, installHint: record.installHint, surface,
    instructions: record.available ? instructions : '',
    skills: record.available ? [...new Set(variant?.skills ?? profile.skills)] : []
  }
}
