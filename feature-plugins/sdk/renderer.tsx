import type { FeatureRendererModule, FeaturePageContext } from '../../src/renderer/src/featurePluginTypes'
import type { ProjectInfo } from '../../src/shared/types'
import { isJavaLoader } from '../../src/shared/projectPlatform'

export type { FeatureRendererModule, FeaturePageContext }
export const javaMod = (project: ProjectInfo | null): boolean => Boolean(project && project.kind !== 'modpack' && project.kind !== 'server-plugin' && isJavaLoader(project.loader))
export const modpack = (project: ProjectInfo | null): boolean => project?.kind === 'modpack'
export const anyProject = (project: ProjectInfo | null): boolean => Boolean(project)
export function registerFeature(id: string, module: FeatureRendererModule): void {
  const exports = Object.fromEntries([...module.pages, ...(module.settings ?? [])].map(entry => [entry.exportName ?? entry.id, entry.component]))
  ;(window as unknown as { __modmindRegisterFeature: (id: string, value: unknown) => void }).__modmindRegisterFeature(id, { ...module, ...exports })
}
export function routeData<T>(context: FeaturePageContext): T | null {
  const value = context.routeData
  if (!value || typeof value !== 'object') return null
  const projectPath = (value as { projectPath?: string }).projectPath
  return !projectPath || projectPath === context.project?.path ? value as T : null
}
