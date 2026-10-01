import { CloudUpload } from 'lucide-react'
import ProductionWorkspace from './components/ProductionWorkspace'
import ReleasePlatformSettings from './components/ReleasePlatformSettings'
import { anyProject, javaMod, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Publishing(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <ProductionWorkspace project={context.project} active={context.visible} onOpenSettings={() => context.openSettings('settings-release')} /> : null }
function Settings(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <><div className="settings-heading"><h2>发布平台</h2></div><ReleasePlatformSettings project={context.project} /></> : null }
registerFeature('publishing', { apiVersion: 2, pages: [{ id: 'production', label: '发布', group: '项目', icon: CloudUpload, supports: anyProject, keepAlive: true, component: Publishing }], settings: [{ id: 'settings-release', category: 'integrations', keywords: '发布平台 平台绑定 Modrinth CurseForge GitHub Token 令牌 项目 ID 仓库 release publish', supports: javaMod, component: Settings }] })
