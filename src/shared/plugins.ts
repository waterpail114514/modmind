// 用户自创插件系统契约：manifest、工具声明、面板消息协议。
// 该文件被主进程（pluginService/pluginRuntime/pluginProtocol）、preload 与渲染进程共享。

export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'
export const PLUGIN_PROTOCOL_SCHEME = 'modmind-plugin'

export type PluginPermission =
  | 'project.read'      // 读取项目元信息快照
  | 'storage'           // 插件私有键值存储（userData/plugins/.data/<id>/）
  | 'net.fetch'         // 通过 ModMind 宿主桥发起 fetch
  | 'clipboard.write'   // 写入系统剪贴板
  | 'ui.overlay'        // 控制本插件的悬浮界面
  | 'chat.read'         // 读取当前工作台对话
  | 'chat.write'        // 填写工作台输入框
  | 'chat.context'      // 为指定对话提供 AI 补充上下文

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'project.read',
  'storage',
  'net.fetch',
  'clipboard.write',
  'ui.overlay',
  'chat.read',
  'chat.write',
  'chat.context'
]

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value)
}

/** 与 mcp-server.mjs 现有四档注解对齐，决定只读模式与审计策略。 */
export type PluginToolAnnotation =
  | 'readOnlyLocal'
  | 'readOnlyRemote'
  | 'safeStateChange'
  | 'managedAction'

export const PLUGIN_TOOL_ANNOTATIONS: readonly PluginToolAnnotation[] = [
  'readOnlyLocal',
  'readOnlyRemote',
  'safeStateChange',
  'managedAction'
]

export interface PluginToolDecl {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  annotations?: Partial<Record<PluginToolAnnotation, boolean>>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  /** 相对插件根目录的图标路径（svg/png），可选。 */
  icon?: string
  permissions: PluginPermission[]
  backend?: {
    entry: string
    tools: PluginToolDecl[]
  }
  panel?: {
    entry: string
  }
  /** 跨页面悬浮界面；可在应用内停靠，也可弹出为透明桌面窗口。 */
  overlay?: {
    entry: string
    mode?: 'floating' | 'pet'
    width?: number
    height?: number
    minWidth?: number
    minHeight?: number
    resizable?: boolean
    alwaysOnTop?: boolean
  }
}

export type PluginScope = 'global' | 'project'

export interface PluginRecord {
  manifest: PluginManifest
  scope: PluginScope
  directory: string
  enabled: boolean
  /** 当前进程内的内容修订号，用于驱动宿主和面板热重载。 */
  revision?: number
  error?: string
  /** 后端入口最近一次启动失败；文件变化后清除并允许重试。 */
  runtimeError?: string
}

export interface PluginSnapshot {
  plugins: PluginRecord[]
}

export type PluginRuntimeStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'failed'

export type PluginLogSource = 'host' | 'backend' | 'panel' | 'overlay'

export interface PluginLogEntry {
  id: string
  time: string
  level: 'info' | 'warn' | 'error'
  source: PluginLogSource
  message: string
}

export interface PluginDiagnostics {
  pluginId: string
  status: PluginRuntimeStatus
  pid?: number
  startedAt?: string
  exitCode?: number
  error?: string
  logs: PluginLogEntry[]
}

export interface PluginOverlayWindowState {
  pluginId: string
  /** 关闭后不再显示应用内悬浮界面，直到显式恢复。 */
  hidden?: boolean
  open: boolean
  alwaysOnTop: boolean
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface PluginChatTarget {
  projectPath: string
  conversationId: string
}

export interface PluginChatSnapshot extends PluginChatTarget {
  title: string
  busy: boolean
  draft: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
}

export interface PluginWorkbenchRequest {
  requestId: string
  operation: 'getCurrent' | 'setDraft'
  target?: PluginChatTarget
  text?: string
  mode?: 'replace' | 'append'
}

export type PluginWorkbenchResult =
  | { requestId: string; ok: true; result: PluginChatSnapshot | { updated: true } }
  | { requestId: string; ok: false; error: string }

export interface PluginToolDescriptor {
  /** MCP 工具全名：modmind_plugin_<pluginId>_<toolName> */
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  annotations?: Partial<Record<PluginToolAnnotation, boolean>>
  pluginId: string
  toolName: string
  scope: PluginScope
}

export type PluginScaffoldKind = 'panel-only' | 'tools-only' | 'panel-and-tools'

export interface PluginScaffoldInput {
  kind: PluginScaffoldKind
  id: string
  name: string
  description?: string
  author?: string
  tools?: PluginToolDecl[]
  targetDirectory?: string
}

export interface PluginWriteFilesInput {
  pluginId: string
  files: Array<{ path: string; content: string }>
}

export interface PluginImportPreview {
  manifest: PluginManifest
  fileName: string
  conflictsWith?: { id: string; scope: PluginScope; directory: string }
}

// ---------------------------------------------------------------------------
// 面板 iframe <-> 宿主消息协议（经 postMessage 与 IPC 中转）
// ---------------------------------------------------------------------------

export interface PluginPanelHostInfo {
  pluginId: string
  panelVersion: number
  theme: 'light' | 'dark'
  surface?: 'panel' | 'overlay'
  project?: {
    name: string
    path: string
    kind: string
  } | null
}

/** 面板 -> 宿主的请求消息（window.postMessage）。 */
export type PluginPanelRequest =
  | { type: 'ready' }
  | { type: 'invokeTool'; requestId: string; toolName: string; input?: unknown }
  | { type: 'getProjectInfo'; requestId: string }
  | { type: 'netFetch'; requestId: string; url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }
  | { type: 'copyToClipboard'; requestId: string; text: string }
  | { type: 'context'; requestId: string; op: string; args?: Record<string, unknown> }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export interface PluginPanelResponse {
  type: 'hostInfo'
  hostInfo: PluginPanelHostInfo
}

export type PluginPanelResult = {
  type: 'result'
  requestId: string
  ok: true
  result: unknown
} | {
  type: 'result'
  requestId: string
  ok: false
  error: string
}

export function isPluginPanelMessage(value: unknown): value is PluginPanelRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'ready':
      return true
    case 'invokeTool':
      return typeof record.requestId === 'string' && typeof record.toolName === 'string'
    case 'getProjectInfo':
      return typeof record.requestId === 'string'
    case 'netFetch':
      return typeof record.requestId === 'string' && typeof record.url === 'string'
    case 'copyToClipboard':
      return typeof record.requestId === 'string' && typeof record.text === 'string'
    case 'context':
      return typeof record.requestId === 'string' && typeof record.op === 'string'
        && (record.args === undefined || Boolean(record.args && typeof record.args === 'object' && !Array.isArray(record.args)))
    case 'log':
      return (
        typeof record.message === 'string' &&
        (record.level === 'info' || record.level === 'warn' || record.level === 'error')
      )
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Manifest 校验（手写校验器，返回规范化后的 manifest 或错误列表）
// ---------------------------------------------------------------------------

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*[\\:])(?!\.\.(\/|$))[^\0]+$/

export interface ManifestValidationResult {
  manifest?: PluginManifest
  errors: string[]
}

function validateRelativePath(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || !RELATIVE_PATH_PATTERN.test(value)) {
    errors.push(`${field} 必须是插件目录内的相对路径`)
    return undefined
  }
  return value
}

export function validatePluginManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['plugin.json 的顶层必须是对象'] }
  }
  const raw = input as Record<string, unknown>

  if (typeof raw.id !== 'string' || !PLUGIN_ID_PATTERN.test(raw.id)) {
    errors.push('id 必须是 3-64 位小写字母/数字/连字符，且不以连字符开头或结尾')
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length < 1 || raw.name.length > 80) {
    errors.push('name 必须是 1-80 位字符')
  }
  if (typeof raw.version !== 'string' || !SEMVER_PATTERN.test(raw.version)) {
    errors.push('version 必须是语义化版本号（如 0.1.0）')
  }
  if (typeof raw.description !== 'string' || raw.description.trim().length < 1 || raw.description.length > 400) {
    errors.push('description 必须是 1-400 位字符')
  }
  if (raw.author !== undefined && typeof raw.author !== 'string') {
    errors.push('author 若存在必须是字符串')
  }

  let icon: string | undefined
  if (raw.icon !== undefined) {
    icon = validateRelativePath(raw.icon, 'icon', errors)
  }

  const permissions: PluginPermission[] = []
  if (!Array.isArray(raw.permissions)) {
    errors.push('permissions 必须是数组')
  } else {
    for (const entry of raw.permissions) {
      if (!isPluginPermission(entry)) {
        errors.push(`未知权限：${JSON.stringify(entry)}，允许值：${PLUGIN_PERMISSIONS.join(', ')}`)
      } else if (!permissions.includes(entry)) {
        permissions.push(entry)
      }
    }
  }

  let backend: PluginManifest['backend']
  if (raw.backend !== undefined && raw.backend !== null) {
    if (typeof raw.backend !== 'object' || Array.isArray(raw.backend)) {
      errors.push('backend 必须是对象')
    } else {
      const rawBackend = raw.backend as Record<string, unknown>
      const entry = validateRelativePath(rawBackend.entry, 'backend.entry', errors)
      const tools: PluginToolDecl[] = []
      if (!Array.isArray(rawBackend.tools) || rawBackend.tools.length < 1) {
        errors.push('backend.tools 必须是非空数组')
      } else {
        for (let i = 0; i < rawBackend.tools.length; i += 1) {
          const toolErrors: string[] = []
          const decl = validateToolDecl(rawBackend.tools[i], `backend.tools[${i}]`, toolErrors)
          errors.push(...toolErrors)
          if (decl) tools.push(decl)
        }
        const seen = new Set<string>()
        for (const tool of tools) {
          if (seen.has(tool.name)) errors.push(`backend.tools 存在重复工具名：${tool.name}`)
          seen.add(tool.name)
        }
      }
      if (entry && tools.length > 0) {
        backend = { entry, tools }
      }
    }
  }

  let panel: PluginManifest['panel']
  if (raw.panel !== undefined && raw.panel !== null) {
    if (typeof raw.panel !== 'object' || Array.isArray(raw.panel)) {
      errors.push('panel 必须是对象')
    } else {
      const rawPanel = raw.panel as Record<string, unknown>
      const entry = validateRelativePath(rawPanel.entry, 'panel.entry', errors)
      if (entry) panel = { entry }
    }
  }

  let overlay: PluginManifest['overlay']
  if (raw.overlay !== undefined && raw.overlay !== null) {
    if (typeof raw.overlay !== 'object' || Array.isArray(raw.overlay)) {
      errors.push('overlay 必须是对象')
    } else {
      const rawOverlay = raw.overlay as Record<string, unknown>
      const entry = validateRelativePath(rawOverlay.entry, 'overlay.entry', errors)
      const mode = rawOverlay.mode === undefined || rawOverlay.mode === 'floating' || rawOverlay.mode === 'pet'
        ? rawOverlay.mode as 'floating' | 'pet' | undefined
        : undefined
      if (rawOverlay.mode !== undefined && mode === undefined) errors.push('overlay.mode 必须是 floating 或 pet')

      const dimension = (key: 'width' | 'height' | 'minWidth' | 'minHeight', minimum: number, maximum: number): number | undefined => {
        const value = rawOverlay[key]
        if (value === undefined) return undefined
        if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
          errors.push(`overlay.${key} 必须是 ${minimum}-${maximum} 的整数`)
          return undefined
        }
        return value as number
      }
      const width = dimension('width', 120, 1200)
      const height = dimension('height', 100, 1000)
      const minWidth = dimension('minWidth', 100, 1200)
      const minHeight = dimension('minHeight', 80, 1000)
      if (rawOverlay.resizable !== undefined && typeof rawOverlay.resizable !== 'boolean') errors.push('overlay.resizable 必须是布尔值')
      if (rawOverlay.alwaysOnTop !== undefined && typeof rawOverlay.alwaysOnTop !== 'boolean') errors.push('overlay.alwaysOnTop 必须是布尔值')
      if (entry) {
        overlay = {
          entry,
          ...(mode ? { mode } : {}),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          ...(minWidth ? { minWidth } : {}),
          ...(minHeight ? { minHeight } : {}),
          ...(typeof rawOverlay.resizable === 'boolean' ? { resizable: rawOverlay.resizable } : {}),
          ...(typeof rawOverlay.alwaysOnTop === 'boolean' ? { alwaysOnTop: rawOverlay.alwaysOnTop } : {})
        }
      }
    }
  }

  if (!backend && !panel && !overlay) {
    errors.push('插件必须声明 backend、panel 或 overlay 至少其一')
  }
  if (backend && permissions.includes('clipboard.write')) {
    // 允许：后端也可写剪贴板
  }
  if (permissions.includes('project.read') && !backend && !panel) {
    // 已由上方"至少其一"覆盖
  }

  if (errors.length > 0) return { errors }

  return {
    manifest: {
      id: raw.id as string,
      name: (raw.name as string).trim(),
      version: raw.version as string,
      description: (raw.description as string).trim(),
      ...(raw.author ? { author: raw.author as string } : {}),
      ...(icon ? { icon } : {}),
      permissions,
      ...(backend ? { backend } : {}),
      ...(panel ? { panel } : {}),
      ...(overlay ? { overlay } : {})
    },
    errors: []
  }
}

function validateToolDecl(input: unknown, field: string, errors: string[]): PluginToolDecl | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push(`${field} 必须是对象`)
    return undefined
  }
  const raw = input as Record<string, unknown>
  const toolErrors: string[] = []

  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(raw.name)) {
    toolErrors.push(`${field}.name 必须是 2-49 位小写字母/数字/下划线/连字符`)
  }
  if (typeof raw.description !== 'string' || raw.description.trim().length < 4 || raw.description.length > 600) {
    toolErrors.push(`${field}.description 必须是 4-600 位字符`)
  }
  if (raw.inputSchema !== undefined && (typeof raw.inputSchema !== 'object' || raw.inputSchema === null || Array.isArray(raw.inputSchema))) {
    toolErrors.push(`${field}.inputSchema 必须是 JSON Schema 对象`)
  }
  const annotations: Partial<Record<PluginToolAnnotation, boolean>> = {}
  if (raw.annotations !== undefined) {
    if (typeof raw.annotations !== 'object' || raw.annotations === null || Array.isArray(raw.annotations)) {
      toolErrors.push(`${field}.annotations 必须是对象`)
    } else {
      for (const [key, value] of Object.entries(raw.annotations as Record<string, unknown>)) {
        if (!(PLUGIN_TOOL_ANNOTATIONS as readonly string[]).includes(key)) {
          toolErrors.push(`${field}.annotations 含未知注解 ${key}`)
          continue
        }
        if (typeof value !== 'boolean') {
          toolErrors.push(`${field}.annotations.${key} 必须是布尔值`)
          continue
        }
        annotations[key as PluginToolAnnotation] = value
      }
    }
  }

  if (toolErrors.length > 0) {
    errors.push(...toolErrors)
    return undefined
  }
  return {
    name: raw.name as string,
    description: (raw.description as string).trim(),
    ...(raw.inputSchema ? { inputSchema: raw.inputSchema as Record<string, unknown> } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  }
}

/** MCP 工具全名与 (pluginId, toolName) 的双向换算。 */
export function pluginMcpToolName(pluginId: string, toolName: string): string {
  return `modmind_plugin_${pluginId}_${toolName}`
}

export function parsePluginMcpToolName(name: string): { pluginId: string; toolName: string } | undefined {
  if (!name.startsWith('modmind_plugin_')) return undefined
  const rest = name.slice('modmind_plugin_'.length)
  const separatorIndex = rest.indexOf('_')
  if (separatorIndex <= 0 || separatorIndex >= rest.length - 1) return undefined
  return { pluginId: rest.slice(0, separatorIndex), toolName: rest.slice(separatorIndex + 1) }
}

/** 判断某工具在只读模式下是否放行（对齐 READ_ONLY_DENIED_ACTIONS 语义）。 */
export function isReadOnlySafeTool(decl: PluginToolDecl): boolean {
  const annotations = decl.annotations ?? {}
  return Boolean(annotations.readOnlyLocal || annotations.readOnlyRemote)
}
