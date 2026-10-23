import { activate as createCapture } from '../../vendor/mc-offline-tool/pull-feature/backend/main.js'
import { bindProjectRuntime } from '../../vendor/mc-offline-tool/src/host-runtime.mjs'
import { dialog } from 'electron'

export function activate() {
  const core = createCapture()
  core.pull_choose_instance = async () => {
    if (!dialog) throw new Error('请在 ModMind 项目中的游戏数据采集页面选择实例')
    const result = await dialog.showOpenDialog({ title: '选择含客户端 jar 的 Minecraft 实例目录', properties: ['openDirectory'] })
    return { instanceDir: result.canceled ? null : result.filePaths[0] ?? null }
  }
  return bindProjectRuntime(core)
}
