import { FileCode2 } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'
import ShaderSources from './components/ShaderSources'
registerFeature('shader-source', { apiVersion: 2, pages: [
  { id: 'shader-source', exportName: 'ShaderSources', label: '光影源码', group: '开发', icon: FileCode2, component: ShaderSources, keepAlive: true }
] })

