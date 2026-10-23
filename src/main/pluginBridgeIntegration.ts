import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, net } from 'electron'
import { PluginService } from './pluginService'
import { PluginRuntime, type PluginRuntimeOptions } from './pluginRuntime'
import { registerPluginProtocol, registerPluginProtocolScheme } from './pluginProtocol'
import { InitialReadiness } from './initialReadiness'
import { requestPluginImportConfirmation } from './pluginImportConfirmation'
import type { ExternalAgentPluginBridgeTarget } from './externalAgents'
import type { PluginDiagnostics, PluginRecord, PluginSnapshot } from '../shared/plugins'

// 模块级单例：index.ts 与各服务通过这里访问插件系统。
let pluginService: PluginService | null = null
let pluginRuntime: PluginRuntime | null = null
let currentProjectRoot: () => string | null = () => null
let initialization: Parameters<typeof initializePlugins>[0] | null = null
interface ProjectPluginContext { service: PluginService; runtime: PluginRuntime; busy: number; timer?: ReturnType<typeof setTimeout> }
const projectContexts = new Map<string, ProjectPluginContext>()
const pluginRegistryReadiness = new InitialReadiness<PluginSnapshot>()

function bundledHostScriptPath(): string {
  // 双路径候选，与 codex-skills / server-pack-creator 同模式：打包后位于
  // process.resourcesPath/plugin-host/host.mjs（asar 外），开发态走仓库 resources 目录。
  const packaged = path.join(process.resourcesPath ?? '', 'plugin-host', 'host.mjs')
  if (app.isPackaged) return packaged
  return path.join(app.getAppPath(), 'resources', 'plugin-host', 'host.mjs')
}

export function initializePlugins(options: {
  userDataDirectory: string
  projectRoot: () => string | null
  projectInfo: () => { name: string; path: string; kind: string } | null
  onSnapshotChanged: (snapshot: PluginSnapshot) => void
  onDiagnosticsChanged?: (diagnostics: PluginDiagnostics) => void
  hostContextOp?: PluginRuntimeOptions['hostContextOp']
}): void {
  if (pluginService) return
  currentProjectRoot = options.projectRoot
  initialization = options
  const globalDirectory = path.join(options.userDataDirectory, 'plugins')
  const dataRoot = path.join(globalDirectory, '.data')

  pluginService = new PluginService({
    globalDirectory,
    projectRoot: options.projectRoot,
    onChange: (snapshot) => options.onSnapshotChanged(snapshot)
  })
  pluginRuntime = new PluginRuntime({
    hostScriptPath: bundledHostScriptPath(),
    dataRootDirectory: dataRoot,
    projectInfo: options.projectInfo,
    netFetch: ((input: string | URL | Request, init?: RequestInit) => net.fetch(input.toString(), init)) as typeof fetch,
    clipboardWrite: (text) => clipboard.writeText(text),
    hostContextOp: options.hostContextOp,
    onRuntimeError: (pluginId, error) => pluginService?.setRuntimeError(pluginId, error),
    onDiagnostics: (diagnostics) => options.onDiagnosticsChanged?.(diagnostics),
    log: (_level, message) => {
      // 接入诊断日志由调用方决定；此处仅 console 以便开发期观察
      console.log(`[plugins] ${message}`)
    }
  })

  registerPluginProtocol({
    getPlugin: (id) => {
      const record = pluginService?.getPlugin(id)
      return record && record.enabled && !record.error ? record : undefined
    }
  })
}

export function registerPluginProtocolSchemeEarly(): void {
  registerPluginProtocolScheme()
}

/** 应用启动/项目切换后刷新注册表并启动目录监听。 */
async function performPluginRegistryRefresh(forceReload: boolean): Promise<PluginSnapshot> {
  if (!pluginService) return { plugins: [] }
  const snapshot = await pluginService.refresh({ forceReload }).catch(() => ({ plugins: [] as PluginRecord[] }))
  pluginRuntime?.syncRecords(new Map(snapshot.plugins.map((record) => [record.manifest.id, record])))
  pluginService.startWatching()
  return snapshot
}

export function refreshPluginRegistry(forceReload = false): Promise<PluginSnapshot> {
  return pluginRegistryReadiness.run(() => performPluginRegistryRefresh(forceReload))
}

/** Early renderer requests wait for the initial cache read/scan instead of observing an empty registry. */
export function waitForPluginRegistry(): Promise<PluginSnapshot> {
  if (!pluginService) return Promise.reject(new Error('插件系统未初始化'))
  return pluginRegistryReadiness.wait(() => performPluginRegistryRefresh(false))
}

export function getPluginService(): PluginService | null {
  return pluginService
}

export function getPluginRuntime(): PluginRuntime | null {
  return pluginRuntime
}

export function shutdownPlugins(): void {
  for (const context of projectContexts.values()) {
    if (context.timer) clearTimeout(context.timer)
    context.runtime.terminateAll()
    context.service.close()
  }
  projectContexts.clear()
  initialization = null
  pluginRuntime?.terminateAll()
  pluginService?.close()
  pluginService = null
  pluginRuntime = null
  pluginRegistryReadiness.reset()
}

/** 构造注入 ModMindBridge 的插件目标；未初始化时返回 undefined（零插件行为不变）。 */
export function createPluginBridgeTarget(projectRoot: string): ExternalAgentPluginBridgeTarget | undefined {
  if (!initialization) return undefined
  const options = initialization
  const projectInfo = options.projectInfo()
  const fixedProject = { name: projectInfo?.path === projectRoot ? projectInfo.name : path.basename(projectRoot), path: projectRoot, kind: projectInfo?.path === projectRoot ? projectInfo.kind : 'mod' }
  const key = process.platform === 'win32' ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot)
  const assertProject = (): void => {
    const normalize = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const current = currentProjectRoot()
    if (!current || normalize(current) !== normalize(projectRoot)) throw new Error('插件操作所属项目当前未激活；操作已保留在原项目，未使用另一项目的插件')
  }

  const withContext = async <T>(operation: (context: ProjectPluginContext) => Promise<T>): Promise<T> => {
    if (initialization !== options) throw new Error('插件系统已关闭')
    let context = projectContexts.get(key)
    if (!context) {
      if (projectContexts.size >= 8) {
        for (const [oldKey, oldContext] of projectContexts) {
          if (oldContext.busy) continue
          if (oldContext.timer) clearTimeout(oldContext.timer)
          oldContext.runtime.terminateAll(); oldContext.service.close(); projectContexts.delete(oldKey)
          break
        }
        if (projectContexts.size >= 8) throw new Error('后台插件并发项目已达上限，请稍后自动重试')
      }
      const globalDirectory = path.join(options.userDataDirectory, 'plugins')
      const service = new PluginService({ globalDirectory, projectRoot: () => projectRoot, passiveRegistry: true })
      const runtime = new PluginRuntime({
        hostScriptPath: bundledHostScriptPath(), dataRootDirectory: path.join(globalDirectory, '.data'),
        projectInfo: () => fixedProject,
        netFetch: ((input: string | URL | Request, init?: RequestInit) => net.fetch(input.toString(), init)) as typeof fetch,
        clipboardWrite: text => clipboard.writeText(text),
        hostContextOp: async (plugin, op, args) => {
          // UI/game operations still target the foreground UI; never route A's request into B.
          assertProject()
          if (!options.hostContextOp) throw new Error('宿主上下文能力未配置')
          return options.hostContextOp(plugin, op, args)
        },
        onRuntimeError: (id, error) => service.setRuntimeError(id, error)
      })
      context = { service, runtime, busy: 0 }
      projectContexts.set(key, context)
    }
    const selected = context
    if (selected.timer) clearTimeout(selected.timer)
    selected.busy++
    try {
      const snapshot = await selected.service.refresh()
      selected.runtime.syncRecords(new Map(snapshot.plugins.map(record => [record.manifest.id, record])))
      return await operation(selected)
    } finally {
      selected.busy--
      if (!selected.busy) {
        selected.timer = setTimeout(() => {
          if (selected.busy || projectContexts.get(key) !== selected) return
          selected.runtime.terminateAll(); selected.service.close(); projectContexts.delete(key)
        }, 120_000)
        selected.timer.unref()
      }
    }
  }
  return {
    listTools: () => withContext(async ({ runtime }) => ({ tools: runtime.listToolDescriptors() })),
    callTool: (toolName, input, readOnlyMode) => withContext(async ({ runtime }) => {
      const found = runtime.findTool(toolName)
      if (!found) throw new Error(`插件工具不存在：${toolName}`)
      if (readOnlyMode && !PluginRuntime.isReadOnlyAllowed(found.descriptor)) {
        throw new Error('只读会话禁止调用非只读插件工具')
      }
      return runtime.callTool(found.descriptor.pluginId, found.descriptor.toolName, input)
    }),
    scaffold: (input) => withContext(async ({ service }) => {
      const result = await service.scaffold({
        kind: input.kind === 'tools-only' ? 'tools-only' : input.kind === 'panel-only' ? 'panel-only' : 'panel-and-tools',
        id: String(input.id ?? ''),
        name: String(input.name ?? input.id ?? ''),
        description: typeof input.description === 'string' ? input.description : undefined,
        author: typeof input.author === 'string' ? input.author : undefined,
        ...(Array.isArray(input.tools) ? { tools: input.tools as never[] } : {})
      })
      return { success: true, directory: result.directory, manifest: result.manifest }
    }),
    readSource: (pluginId) => withContext(async ({ service }) => ({ files: await service.readPluginSource(pluginId) })),
    writeFiles: (input) => withContext(async ({ service }) => {
      await service.writePluginFiles(String(input.pluginId ?? ''), Array.isArray(input.files) ? input.files as Array<{ path: string; content: string }> : [])
      return { success: true }
    }),
    reload: () => withContext(async ({ service, runtime }) => {
      const snapshot = await service.refresh({ forceReload: true })
      runtime.syncRecords(new Map(snapshot.plugins.map(record => [record.manifest.id, record])))
      return snapshot
    })
  }
}

/** 导入 .zip 的完整流程：选择文件 → 解压校验 → 确认对话框 → 落盘。 */
export async function importPluginZipInteractive(scope: 'global' | 'project', window: BrowserWindow, requestId: string, projectRoot: () => string | null): Promise<{ imported: string } | { cancelled: true }> {
  const service = getPluginService()
  if (!service || !app) throw new Error('插件系统未初始化')
  const originalProject = projectRoot()
  const result = await dialog.showOpenDialog(window, {
    title: '导入 ModMind 插件',
    filters: [{ name: 'ModMind 插件', extensions: ['zip'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return { cancelled: true }

  const preview = await service.previewZipImport(result.filePaths[0], scope)
  try {
    const accepted = await requestPluginImportConfirmation(window.webContents, requestId, {
      manifest: preview.manifest,
      fileName: path.basename(result.filePaths[0]),
      scope,
      conflictsWith: preview.conflictsWith
    })
    if (!accepted) return { cancelled: true }
    if (scope === 'project' && projectRoot() !== originalProject) throw new Error('当前项目已切换，请重新导入插件')
    const manifest = await service.confirmImport(preview.stagedDirectory, scope)
    await refreshPluginRegistry()
    return { imported: manifest.id }
  } finally {
    await service.cancelImport(preview.stagedDirectory)
  }
}
