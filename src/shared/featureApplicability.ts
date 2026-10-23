import type { FeaturePluginAction, FeaturePluginDefinition, FeaturePluginScope } from './featurePlugins'
import type { ProjectInfo, UiMode } from './types'

type FeatureProject = Pick<ProjectInfo, 'studioId' | 'kind' | 'loader' | 'draft'>

/** Legacy projects predate studioId; explicit providers always take precedence. */
export function featureProjectStudioId(project: FeatureProject | null | undefined): string | undefined {
  if (!project || project.draft) return undefined
  if (project.studioId) return project.studioId
  const legacy: Record<string, string> = { mod: 'minecraft-mod', modpack: 'minecraft-modpack', 'server-plugin': 'minecraft-server-plugin' }
  return legacy[project.kind ?? 'mod']
}

export function featureScopeApplies(scope: FeaturePluginScope | undefined, project: FeatureProject | null | undefined): boolean {
  if (!scope?.studioIds?.length && !scope?.loaders?.length) return true
  if (!project || project.draft) return false
  return (!scope.studioIds?.length || scope.studioIds.includes(featureProjectStudioId(project) ?? ''))
    && (!scope.loaders?.length || scope.loaders.includes(project.loader))
}

/** Used by the catalog, renderer and tool host, without loading optional code. */
export function featureDefinitionApplies(definition: FeaturePluginDefinition | undefined, project: FeatureProject | null | undefined): boolean {
  if (!definition || !featureScopeApplies(definition, project)) return !definition
  if (definition.studioIds?.length || definition.loaders?.length) return true
  if (definition.studios?.length) return Boolean(project && !project.draft && definition.studios.some(studio =>
    studio.id === featureProjectStudioId(project) && studio.projectKind === (project.kind ?? 'mod') && studio.loaders.includes(project.loader)))
  const contributions: FeaturePluginScope[] = [...(definition.views ?? []), ...(definition.settings ?? []), ...(definition.actions ?? [])]
  return !contributions.length || contributions.some(contribution => featureScopeApplies(contribution, project))
}

export function featureActionApplies(definition: FeaturePluginDefinition, action: FeaturePluginAction, project: FeatureProject | null | undefined): boolean {
  // Import and inspect actions also run from the project launcher.
  if (!project && !action.projectRequired && !action.studioIds?.length && !action.loaders?.length) return true
  return featureScopeApplies(definition, project) && featureScopeApplies(action, project)
}

export function featurePageApplies(page: { supports?: (project: ProjectInfo | null, uiMode: UiMode) => boolean }, project: ProjectInfo | null, uiMode: UiMode): boolean {
  return !page.supports || page.supports(project, uiMode)
}
