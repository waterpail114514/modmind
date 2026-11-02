import { Pickaxe } from 'lucide-react'
import ItemEditorWorkspace from './components/ItemEditorWorkspace'
import { javaMod, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Items(context: FeaturePageContext): React.JSX.Element | null {
  return context.project ? <ItemEditorWorkspace project={context.project} onOpenImages={context.hasPage('image-studio') ? () => context.navigate('image-studio') : undefined} onBuild={() => context.navigate('build')} onTest={() => context.navigate('minecraft')} onFilesChanged={context.filesChanged} /> : null
}
registerFeature('item-editor', { apiVersion: 2, pages: [{ id: 'item-editor', label: '物品与装备', group: '资源', icon: Pickaxe, order: 10, supports: javaMod, component: Items }] })
