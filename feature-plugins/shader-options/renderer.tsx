import { SlidersHorizontal } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'
import ShaderOptions from './components/ShaderOptions'
registerFeature('shader-options', { apiVersion: 2, pages: [
  { id: 'shader-options', exportName: 'ShaderOptions', label: '光影选项', group: '开发', icon: SlidersHorizontal, component: ShaderOptions, keepAlive: true }
] })

