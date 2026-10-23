import type { ExistingProjectAdoptInput, ExistingProjectAnalysis, ProjectInfo } from '../../src/shared/types'
import type { StudioTemplateProvider } from './studio'

export interface BuiltinStudioHost {
  inspectBuiltinStudio: (kind: string, sourcePath: string) => Promise<ExistingProjectAnalysis | null>
  adoptBuiltinStudio: (input: ExistingProjectAdoptInput) => Promise<ProjectInfo | null>
}
export function builtinAdoptionProvider(host: BuiltinStudioHost, kind: string): Pick<StudioTemplateProvider, 'inspectExisting' | 'adoptExisting'> {
  return {
    inspectExisting: sourcePath => host.inspectBuiltinStudio(kind, sourcePath),
    adoptExisting: async input => ({ mode: 'host-managed', project: await host.adoptBuiltinStudio(input) })
  }
}
