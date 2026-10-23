import type { NativeFeatureHost } from '../../src/main/index'
import type { StudioRuntime } from '../sdk/studio'
import { inspectShaderSource } from './src/main/shaderAdoption'
import { shaderTemplateFiles } from './src/main/shaderTemplates'

export function activate(_options: { host: NativeFeatureHost }): StudioRuntime {
  return {
    studios: {
      shader: {
        templateFiles: shaderTemplateFiles,
        inspectExisting: inspectShaderSource,
        adoptExisting: async () => ({ mode: 'in-place' })
      }
    }
  }
}
