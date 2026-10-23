import type { NativeFeatureHost } from '../../src/main/index'
import { shaderFeatureContext } from '../shader-shared/src/main/shaderFeature'
import { setShaderOptions, shaderInventory, undoShaderChange } from '../shader-shared/src/main/shaderSourceService'

export function activate(options: { host: NativeFeatureHost }) {
  const { project, mutable, actions } = shaderFeatureContext(options.host)
  return {
    actions: actions({
      query: async (input, context) => {
        if (input.operation === 'inventory') return shaderInventory(project(context))
        throw new Error('不支持的光影选项查询')
      },
      edit: async (input, context) => {
        const current = mutable(context)
        if (input.operation === 'options') return setShaderOptions(current, String(input.revision), input.values as Record<string, string>, input.programValues as Record<string, boolean> | undefined)
        if (input.operation === 'undo') return undoShaderChange(current)
        throw new Error('不支持的光影选项编辑')
      }
    })
  }
}
