import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FeaturePluginService } from '../featurePluginService'
import { prepareFeaturePlugin } from '../featurePluginPackage'
import type { NativeFeatureHost } from '../index'
import type { FeaturePluginInvocationContext } from '../../shared/featurePlugins'
import type { ProjectInfo } from '../../shared/types'
import { ipcMain } from 'electron'

export function configureDeveloperHost(kit: string, service: FeaturePluginService, host: NativeFeatureHost): void {
  let plugin = '', project: ProjectInfo
  let projectRoot = ''
  const allowed = new Set<string>()
  const runner = require(path.join(kit, 'runtime.cjs'))
  const contents = host.mainWindow!.webContents
  contents.send = (channel: string, ...args: unknown[]) => { process.send?.({ type: 'renderer-event', channel, args }) }
  const refreshProject = async (): Promise<void> => {
    const metadata = await fs.readFile(path.join(projectRoot, 'modmind.project.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (metadata) { project = { ...metadata, path: projectRoot }; host.currentProject = project }
  }
  runner.configureHost({
    async initialize(config: { archive: string; projectPath: string }) {
      projectRoot = config.projectPath
      project = await fs.readFile(path.join(config.projectPath, 'modmind.project.json'), 'utf8').then(JSON.parse).catch(() => ({ name: '示例项目', kind: 'mod', loader: 'fabric', minecraftVersion: '1.20.1', namespace: 'devtest', createdAt: new Date().toISOString() }))
      project.path = config.projectPath
      host.currentProject = project
      const prepared = await prepareFeaturePlugin(config.archive)
      plugin = prepared.manifest.id
      await host.aiProjectContext.run(project, () => service.list().some(item => item.id === plugin) ? service.update(prepared) : service.install(prepared))
      const include = (id: string): void => { if (allowed.has(id)) return; allowed.add(id); for (const dependency of service.manifest(id)?.dependencies ?? []) include(dependency) }
      include(plugin)
      return service.service(plugin)
    },
    async invoke(action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) {
      await refreshProject()
      return host.aiProjectContext.run(project, () => service.invoke(plugin, action, input, context))
    },
    async api(channel: string, args: unknown[], context: FeaturePluginInvocationContext) {
      await refreshProject()
      if (channel === 'feature-plugins:catalog') return service.catalog().filter(item => allowed.has(item.id))
      if (channel === 'feature-plugins:list') return service.list().filter(item => allowed.has(item.id))
      if (channel === 'project:current') return project
      if (channel === 'sounds:renderComplete' && service.enabled('sound-studio')) {
        if (context.readOnly) throw new Error('FEATURE_PLUGIN_READ_ONLY: 当前会话只允许读取')
        ipcMain.emit(channel, { sender: contents }, ...args)
        return null
      }
      if (channel === 'feature-plugins:invoke') {
        const [id, action, input] = args as [string, string, Record<string, unknown>]
        // Only this package and its declared dependency closure are installed in this profile.
        if (!allowed.has(id) || !service.enabled(id)) throw new Error('预览所需的功能包未启用或未声明为依赖：' + id)
        return host.aiProjectContext.run(project, () => service.invoke(id, action, input, context))
      }
      throw new Error('独立预览未开放此宿主操作：' + channel)
    }
  })
}
