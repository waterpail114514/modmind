import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NativeFeatureHost } from '../../src/main/index'
import { shaderFeatureContext } from '../shader-shared/src/main/shaderFeature'
import { shaderInventory } from '../shader-shared/src/main/shaderSourceService'
import { validateShader } from '../shader-shared/src/main/shaderValidationService'
import { exportShader } from '../shader-shared/src/main/shaderExportService'

export function activate(options: { host: NativeFeatureHost }) {
  const host = options.host
  const { project, mutable, actions } = shaderFeatureContext(host)
  return {
    actions: actions({
      query: async (input, context) => {
        const current = project(context)
        if (input.operation === 'inventory') return shaderInventory(current)
        if (input.operation === 'validate') return validateShader(current)
        throw new Error('不支持的光影导出查询')
      },
      package: async (_input, context) => exportShader(mutable(context)),
      export: async (_input, context) => {
        const current = mutable(context)
        const artifact = await exportShader(current)
        if (!context.windowId) return artifact
        const window = host.mainWindow
        if (!window || window.isDestroyed()) throw new Error('请先打开光影检查与导出页面')
        const selected = await dialog.showSaveDialog(window, { title: '导出光影包', defaultPath: `${current.namespace}.zip`, filters: [{ name: 'Java Shader Pack', extensions: ['zip'] }] })
        if (selected.canceled || !selected.filePath) return null
        if (host.requireProject().path !== current.path) throw new Error('导出时工程已切换，请重试')
        if (path.resolve(selected.filePath) !== path.resolve(artifact.path)) await fs.copyFile(artifact.path, selected.filePath)
        return { ...artifact, path: selected.filePath }
      }
    })
  }
}
