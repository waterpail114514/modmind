import { WandSparkles } from 'lucide-react'
import Settings from './Settings'
import Workspace from './src/renderer/src/components/ImageStudioWorkspace'
import type { ResourceImageTarget } from '../../src/shared/resourcePack'
import { registerFeature, routeData, type FeaturePageContext } from '../sdk/renderer'

function Studio(context: FeaturePageContext): React.JSX.Element {
  const target = routeData<ResourceImageTarget>(context)
  return <Workspace visible={context.visible} darkMode={context.darkMode} onOpenSettings={() => context.openSettings('settings-image')} resourceTarget={target} onCloseResource={() => context.navigate('modpack-resourcepacks', target)} />
}
function StudioSettings(context: FeaturePageContext): React.JSX.Element {
  return <Settings deviceState={context.deviceState} setNotice={context.setNotice} onOpenStudio={() => context.navigate('image-studio')} />
}
registerFeature('image-studio', {
  apiVersion: 2,
  pages: [{ id: 'image-studio', label: '图像工坊', group: '资源', icon: WandSparkles, order: 20, keepAlive: true, scope: 'application', className: 'image-studio-host', component: Studio, exportName: 'Workspace' }],
  settings: [{ id: 'settings-image', category: 'ai', keywords: '图片模型 图像服务 自定义图像 API Key Base URL 模型 额度 图像工坊 image', className: 'image-settings-section', component: StudioSettings, exportName: 'Settings' }]
})
