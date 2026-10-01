import { List, PackagePlus } from 'lucide-react'
import ModpackModListWorkspace from './components/ModpackModListWorkspace'
import ThirdPartyModsWorkspace from './components/ThirdPartyModsWorkspace'
import { modpack, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function ModList(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <ModpackModListWorkspace project={context.project} onOpenModule={context.openProject} onDecompile={jarPath => context.navigate('decompile', { jarPath })} /> : null }
function Downloads(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <ThirdPartyModsWorkspace project={context.project} visible={context.visible} /> : null }
registerFeature('modpack-mods', { apiVersion: 2, pages: [
  { id: 'modpack-mod-list', label: '模组列表', group: '创作', icon: List, supports: modpack, component: ModList },
  { id: 'third-party-mods', label: '模组下载', group: '创作', icon: PackagePlus, supports: modpack, keepAlive: true, className: 'third-party-route', component: Downloads }
] })
