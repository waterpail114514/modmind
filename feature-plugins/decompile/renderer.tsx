import { Binary } from 'lucide-react'
import DecompileWorkspace from './components/DecompileWorkspace'
import AdoptJarLauncher from './AdoptJarLauncher'
import { registerFeature, routeData, type FeaturePageContext } from '../sdk/renderer'
function Decompile(context: FeaturePageContext): React.JSX.Element {
  const target = routeData<{ jarPath: string }>(context)
  return <DecompileWorkspace key={target?.jarPath ?? 'none'} initialJarPath={target?.jarPath ?? null} projectContext={context.project} darkMode={context.darkMode} onProjectCreated={context.openProject} />
}
registerFeature('decompile', { apiVersion: 2, pages: [{ id: 'decompile', label: '反编译', group: '开发', icon: Binary, keepAlive: true, component: Decompile }], launcherActions: [AdoptJarLauncher] })
