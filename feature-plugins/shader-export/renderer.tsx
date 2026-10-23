import { PackageCheck } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'
import ShaderExport from './components/ShaderExport'
registerFeature('shader-export', { apiVersion: 2, pages: [
  { id: 'shader-export', exportName: 'ShaderExport', label: '检查与导出', group: '测试与构建', icon: PackageCheck, component: ShaderExport }
] })

