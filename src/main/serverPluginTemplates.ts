import type { ProjectInfo } from '../shared/types'
import { projectTemplateFiles } from './projectTemplates'
export { PLUGIN_GRADLE_VERSION, PLUGIN_REPOSITORIES, bundledPluginVersions, pluginVersionOption } from './serverPluginMetadata'

export function pluginTemplateFiles(project: ProjectInfo, includeStarter = true): Record<string, string> {
  if (project.kind !== 'server-plugin') throw new Error('插件工程类型与平台不匹配')
  return projectTemplateFiles(project, includeStarter)
}
