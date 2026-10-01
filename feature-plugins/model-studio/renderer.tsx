import { Box } from 'lucide-react'
import { useEffect } from 'react'
import BlockbenchWorkspace from './components/BlockbenchWorkspace'
import type { ResourceModelTarget } from '../../src/shared/modelSource'
import { anyProject, registerFeature, routeData, type FeaturePageContext } from '../sdk/renderer'
function Models(context: FeaturePageContext): React.JSX.Element | null {
  useEffect(() => { if (!context.visible) void window.modmind.blockbench.hide().catch(() => undefined) }, [context.visible])
  const target = routeData<ResourceModelTarget>(context)
  return context.project ? <BlockbenchWorkspace visible={context.visible} darkMode={context.darkMode} project={context.project} resourceTarget={target} onDetachResource={() => context.navigate('blockbench', null)} onCloseResource={() => context.navigate('modpack-resourcepacks', target)} /> : null
}
registerFeature('model-studio', { apiVersion: 2, pages: [{ id: 'blockbench', label: '模型', group: '资源', icon: Box, order: 30, supports: anyProject, keepAlive: true, className: 'blockbench-page', component: Models }] })
