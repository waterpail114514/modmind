import { modTemplateFiles } from './src/main/modTemplates'
import type { StudioRuntime } from '../sdk/studio'
import { builtinAdoptionProvider, type BuiltinStudioHost } from '../sdk/builtinAdoption'

export function activate(options: { host: BuiltinStudioHost }): StudioRuntime {
  return { studios: { mod: { templateFiles: modTemplateFiles, ...builtinAdoptionProvider(options.host, 'mod') } } }
}
