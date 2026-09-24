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
  pluginRuntime?.terminateAll()
  pluginService?.close()
  pluginService = null
  pluginRuntime = null
  pluginRegistryReadiness.reset()
}

/** 构造注入 ModMindBridge 的插件目标；未初始化时返回 undefined（零插件行为不变）。 */
export function createPluginBridgeTarget(): ExternalAgentPluginBridgeTarget | undefined {
  const service = getPluginService()
  const runtime = getPluginRuntime()
  if (!service || !runtime) return undefined

  return {
    listTools: async () => ({ tools: runtime.listToolDescriptors() }),
    callTool: async (toolName, input, readOnlyMode) => {
      const found = runtime.findTool(toolName)
      if (!found) throw new Error(`插件工具不存在：${toolName}`)
      if (readOnlyMode && !PluginRuntime.isReadOnlyAllowed(found.descriptor)) {
        throw new Error('只读会话禁止调用非只读插件工具')
      }
      return runtime.callTool(found.descriptor.pluginId, found.descriptor.toolName, input)
    },
    scaffold: async (input) => {
      const result = await service.scaffold({
        kind: input.kind === 'tools-only' ? 'tools-only' : input.kind === 'panel-only' ? 'panel-only' : 'panel-and-tools',
        id: String(input.id ?? ''),
        name: String(input.name ?? input.id ?? ''),
        description: typeof input.description === 'string' ? input.description : undefined,
        author: typeof input.author === 'string' ? input.author : undefined,
        ...(Array.isArray(input.tools) ? { tools: input.tools as never[] } : {})
      })
      return { success: true, directory: result.directory, manifest: result.manifest }
    },
    readSource: async (pluginId) => ({ files: await service.readPluginSource(pluginId) }),
    writeFiles: async (input) => {
      await service.writePluginFiles(String(input.pluginId ?? ''), Array.isArray(input.files) ? input.files as Array<{ path: string; content: string }> : [])
      return { success: true }
    },
    reload: async () => {
      const snapshot = await refreshPluginRegistry(true)
      return snapshot
    }
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
