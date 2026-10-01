import { Gauge } from 'lucide-react'
import ModpackToolsWorkspace from './components/ModpackToolsWorkspace'
import { modpack, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Automation(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <ModpackToolsWorkspace project={context.project} section="automation" /> : null }
registerFeature('modpack-automation', { apiVersion: 2, pages: [{ id: 'modpack-automation', label: '依赖与优化', group: '运行', icon: Gauge, supports: modpack, keepAlive: true, component: Automation }] })
