import type { NativeFeatureHost } from '../../src/main/index'
import { shaderFeatureContext } from '../shader-shared/src/main/shaderFeature'
import { readShaderFile, saveShaderFile, shaderInventory, undoShaderChange } from '../shader-shared/src/main/shaderSourceService'

export function activate(options: { host: NativeFeatureHost }) {
  const { project, mutable, actions } = shaderFeatureContext(options.host)
  return {
    actions: actions({
      query: async (input, context) => {
        const current = project(context)
        if (input.operation === 'inventory') return shaderInventory(current)
        if (input.operation === 'read') return readShaderFile(current, String(input.path))
        throw new Error('不支持的光影源码查询')
      },
      edit: async (input, context) => {
        const current = mutable(context)
        if (input.operation === 'save') return saveShaderFile(current, String(input.path), String(input.content), String(input.revision))
        if (input.operation === 'undo') return undoShaderChange(current)
        throw new Error('不支持的光影源码编辑')
      }
    })
  }
}
