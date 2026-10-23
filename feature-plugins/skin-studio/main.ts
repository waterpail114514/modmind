import { dialog } from 'electron'
import { SkinService } from './src/main/skinService'
import type { NativeFeatureHost } from '../../src/main/index'
import { nativeActions } from '../sdk/native'
import type { FeaturePluginInvocationContext, FeaturePluginRuntime } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }): FeaturePluginRuntime & { skinService: SkinService } {
  const host = options.host
  const service = new SkinService({ host })
  const { actions, handle } = nativeActions(host)
  actions.query = async (input) => {
    const operation = String(input.operation ?? 'list')
    if (operation === 'list') return service.list()
    if (operation === 'read') return service.read(String(input.path ?? input.name ?? ''))
    if (operation === 'validate') return service.validate(input as { dataUrl?: unknown; model?: unknown })
    throw new Error('不支持的皮肤查询操作')
  }
  actions.manage = async (input, context: FeaturePluginInvocationContext) => {
    const project = host.requireProject()
    if (context.projectPath && context.projectPath !== project.path) throw new Error('项目已经切换，请重新打开皮肤工坊')
    const operation = String(input.operation ?? '')
    if (operation === 'save') {
      host.assertProjectMutationAllowed(project.path, '保存皮肤')
      return service.save(String(input.name ?? ''), input.dataUrl, input.model)
    }
    if (operation === 'export') {
      const dataUrl = input.dataUrl
      let targetPath = typeof input.targetPath === 'string' && input.targetPath.trim() ? input.targetPath : undefined
      if (!targetPath) {
        const picked = await dialog.showSaveDialog(host.mainWindow!, { title: '导出 Minecraft 皮肤', defaultPath: `${String(input.name || 'minecraft-skin').replace(/[^a-z0-9._-]+/gi, '-')}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
        if (picked.canceled || !picked.filePath) return null
        targetPath = picked.filePath
      }
      return service.exportData(dataUrl, String(input.name || 'minecraft-skin'), targetPath, input.model)
    }
    throw new Error('不支持的皮肤管理操作')
  }
  handle('skin-studio:list', () => service.list())
  handle('skin-studio:read', (_, name: string) => service.read(name))
  handle('skin-studio:validate', (_, input: { dataUrl?: unknown; model?: unknown }) => service.validate(input))
  handle('skin-studio:save', (_, name: string, dataUrl: string, model: string) => { const project = host.requireProject(); host.assertProjectMutationAllowed(project.path, '保存皮肤'); return service.save(name, dataUrl, model) })
  return { actions, skinService: service }
}

