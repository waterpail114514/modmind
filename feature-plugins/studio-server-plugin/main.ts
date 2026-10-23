import { pluginTemplateFiles } from './src/main/pluginTemplates'
import type { StudioRuntime } from '../sdk/studio'
import { builtinAdoptionProvider, type BuiltinStudioHost } from '../sdk/builtinAdoption'

export function activate(options: { host: BuiltinStudioHost }): StudioRuntime {
  return { studios: { 'server-plugin': { templateFiles: pluginTemplateFiles, ...builtinAdoptionProvider(options.host, 'server-plugin') } } }
}
