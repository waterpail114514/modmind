import path from 'node:path'
import type { NativeFeatureHost } from '../../../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../../../src/shared/featurePlugins'
import type { ProjectInfo } from '../../../../src/shared/types'
import { assertShaderProject } from './shaderFiles'

export type ShaderFeatureAction = (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => Promise<unknown>

export function shaderFeatureContext(host: NativeFeatureHost) {
  const project = (context: FeaturePluginInvocationContext): ProjectInfo => {
    const current = host.requireProject()
    assertShaderProject(current)
    if (!context.projectPath || path.resolve(context.projectPath).toLowerCase() !== path.resolve(current.path).toLowerCase()) throw new Error('光影项目已切换，请刷新后重试')
    return current
  }
  const mutable = (context: FeaturePluginInvocationContext): ProjectInfo => {
    if (context.readOnly) throw new Error('灵感台只允许读取光影工程')
    const current = project(context)
    host.assertProjectMutationAllowed(current.path, '修改光影工程')
    return current
  }
  const actions = (handlers: Record<string, ShaderFeatureAction>): Record<string, ShaderFeatureAction> => Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input, context) => {
    const current = project(context)
    if (input.projectPath && String(input.projectPath) !== current.path) throw new Error('光影项目已切换，请刷新后重试')
    return handler(input, context)
  }]))
  return { project, mutable, actions }
}
