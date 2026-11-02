import { Package } from 'lucide-react'
import ResourcePackWorkspace from './components/ResourcePackWorkspace'
import type { ResourceImageTarget } from '../../src/shared/resourcePack'
import { anyProject, registerFeature, routeData, type FeaturePageContext } from '../sdk/renderer'
function Packs(context: FeaturePageContext): React.JSX.Element | null {
  const selection = routeData<ResourceImageTarget>(context)
  return context.project ? <ResourcePackWorkspace project={context.project} darkMode={context.darkMode} initialSelection={selection ?? undefined} onFilesChanged={context.filesChanged} onImages={context.hasPage('image-studio') ? target => context.navigate('image-studio', target) : undefined} onModels={context.hasPage('blockbench') ? target => context.navigate('blockbench', target) : undefined} onTest={() => context.navigate(context.project?.kind === 'server-plugin' ? 'modpack-server' : 'minecraft')} /> : null
}
registerFeature('resource-packs', { apiVersion: 2, pages: [{ id: 'modpack-resourcepacks', label: '资源包', group: '资源', icon: Package, order: 40, supports: anyProject, component: Packs }] })
