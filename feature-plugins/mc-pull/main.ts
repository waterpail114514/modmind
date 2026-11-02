import { activate as createCapture } from '../../vendor/mc-offline-tool/pull-feature/backend/main.js'
import { bindProjectRuntime } from '../../vendor/mc-offline-tool/src/host-runtime.mjs'
import { dialog } from 'electron'
import { captureIcons, captureSources } from './src/main/captureCatalogService'

export function activate() {
  const core = createCapture()
  core.pull_sources = (input: { projectPath: string }) => captureSources(input.projectPath)
  core.pull_icons = (input: { projectPath: string; ids: string[] }) => captureIcons(input.projectPath, input.ids)
  core.pull_choose_instance = async () => {
    if (!dialog) throw new Error('请在建筑预览或物品选择器的资源来源中选择实例')
    const result = await dialog.showOpenDialog({ title: '选择含客户端 jar 的 Minecraft 实例目录', properties: ['openDirectory'] })
    return { instanceDir: result.canceled ? null : result.filePaths[0] ?? null }
  }
  core.pull_choose_probe = async () => {
    const result = await dialog.showOpenDialog({ title: '选择已有探针结果目录（含 index.json）', properties: ['openDirectory'] })
    return { probeDir: result.canceled ? null : result.filePaths[0] ?? null }
  }
  return bindProjectRuntime(core)
}
