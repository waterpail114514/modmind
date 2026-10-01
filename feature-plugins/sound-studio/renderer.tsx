import { Music } from 'lucide-react'
import SoundWorkspace from './components/SoundWorkspace'
import SoundRenderBridge from './components/SoundRenderBridge'
import { javaMod, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Sounds(context: FeaturePageContext): React.JSX.Element | null {
  return context.project ? <SoundWorkspace projectPath={context.project.path} projectNamespace={context.project.namespace} onFilesChanged={context.filesChanged} /> : null
}
registerFeature('sound-studio', { apiVersion: 2, pages: [{ id: 'sounds', label: '声音', group: '资源', icon: Music, order: 50, supports: javaMod, keepAlive: true, className: 'production-page', component: Sounds }], backgroundComponents: [SoundRenderBridge] })
