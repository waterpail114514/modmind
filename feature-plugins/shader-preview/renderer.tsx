import { Sun } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'
import ShaderPreview from './components/ShaderPreview'
registerFeature('shader-preview', { apiVersion: 2, pages: [
  { id: 'shader-preview', exportName: 'ShaderPreview', label: '效果预览', group: '测试与构建', icon: Sun, component: ShaderPreview }
] })

