import { createModpackTemplate } from '../../src/main/modpackService'
import type { StudioRuntime } from '../sdk/studio'
import { builtinAdoptionProvider, type BuiltinStudioHost } from '../sdk/builtinAdoption'

export function activate(options: { host: BuiltinStudioHost }): StudioRuntime {
  return { studios: { modpack: { scaffold: createModpackTemplate, ...builtinAdoptionProvider(options.host, 'modpack') } } }
}
