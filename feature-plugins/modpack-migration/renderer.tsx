import { ArrowRightLeft } from 'lucide-react'
import ModpackMigrationWorkspace from './components/ModpackMigrationWorkspace'
import { modpack, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Migration(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <ModpackMigrationWorkspace project={context.project} onDecompile={jarPath => context.navigate('decompile', { jarPath })} /> : null }
registerFeature('modpack-migration', { apiVersion: 2, pages: [{ id: 'modpack-migration', label: '版本迁移', group: '运行', icon: ArrowRightLeft, supports: modpack, keepAlive: true, component: Migration }] })
