import { Gamepad2 } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'
import ShaderTesting from './components/ShaderTesting'
registerFeature('shader-testing', { apiVersion: 2, pages: [
  { id: 'shader-test', exportName: 'ShaderTesting', label: '游戏验证', group: '测试与构建', icon: Gamepad2, component: ShaderTesting }
] })

