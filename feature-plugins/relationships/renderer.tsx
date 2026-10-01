import { Link2 } from 'lucide-react'
import AddonRelationshipsWorkspace from './components/AddonRelationshipsWorkspace'
import { ServerPluginDependencies } from '../../src/renderer/src/components/ServerPluginTools'
import { isJavaLoader } from '../../src/shared/projectPlatform'
import { registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Dependencies(context: FeaturePageContext): React.JSX.Element | null {
  const project = context.project
  if (!project) return null
  return project.kind === 'server-plugin' ? <ServerPluginDependencies project={project} onOpenCode={() => context.navigate('code')} /> : <AddonRelationshipsWorkspace project={project} beginner={context.uiMode === 'beginner'} onFilesChanged={context.filesChanged} onDecompile={jarPath => context.navigate('decompile', { jarPath })} />
}
registerFeature('relationships', { apiVersion: 2, pages: [{ id: 'relationships', label: '前置与联动', group: '开发', icon: Link2, supports: project => Boolean(project && (project.kind === 'server-plugin' || project.kind !== 'modpack' && isJavaLoader(project.loader))), component: Dependencies }] })
