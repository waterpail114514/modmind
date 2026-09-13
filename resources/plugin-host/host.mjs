// ModMind 插件后端宿主：运行在 utilityProcess 中，被主进程 fork。
// 职责：
//   1. 加载完全可信的 Node 插件入口（backend.entry），注入宿主桥 modmindPlugin
//   2. 通过 MessagePort 与主进程做 JSON-RPC 风格通信（callTool / 内部能力请求）
//
// 启动参数（process.argv）：
//   [2] = 插件入口绝对路径
//   [3] = 能力开关 JSON（permissions / pluginId / storageDirectory）
// 消息通道（parentPort）：
//   主进程 -> 宿主: { id, kind: 'call', tool, input } | { id, kind: 'ctx', op, args }
//   宿主 -> 主进程: { id, ok, result?, error? } | { kind: 'log', level, message }

import { pathToFileURL } from 'node:url'

const entryPath = process.argv[2]
let options = {
  pluginId: 'unknown',
  permissions: [],
  storageDirectory: null,
  projectInfo: null
}
try {
  options = { ...options, ...JSON.parse(process.argv[3] ?? '{}') }
} catch {
  // 忽略非法参数，保持默认
}

const parentPort = typeof process.parentPort !== 'undefined' ? process.parentPort : undefined

let contextSequence = 0

function post(message) {
  if (parentPort) parentPort.postMessage(message)
}

const permissionSet = new Set(Array.isArray(options.permissions) ? options.permissions : [])

const log = {
  info: (message) => post({ kind: 'log', level: 'info', message: String(message) }),
  warn: (message) => post({ kind: 'log', level: 'warn', message: String(message) }),
  error: (message) => post({ kind: 'log', level: 'error', message: String(message) })
}

process.on('uncaughtExceptionMonitor', (error) => {
  log.error(`未捕获异常：${error instanceof Error ? (error.stack || error.message) : String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log.error(`未处理的 Promise 拒绝：${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`)
})

const contextWaiters = new Map()
function requestContext(op, args) {
  if (!parentPort) return Promise.reject(new Error('宿主上下文不可用（无 parentPort）'))
  const id = `ctx-${++contextSequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (contextWaiters.has(id)) {
        contextWaiters.delete(id)
        reject(new Error(`上下文调用超时：${op}`))
      }
    }, 15000)
    contextWaiters.set(id, { resolve, reject, timer })
    post({ id, kind: 'ctx', op, args })
  })
}

function requirePermission(permission) {
  if (!permissionSet.has(permission)) throw new Error(`缺少权限：${permission}`)
}

const ctx = {
  log,
  overlay: {
    getState: () => permittedContext('ui.overlay', 'overlayGetState'),
    close: () => permittedContext('ui.overlay', 'overlayClose'),
    show: () => permittedContext('ui.overlay', 'overlayShow'),
    popOut: () => permittedContext('ui.overlay', 'overlayPopOut'),
    dock: () => permittedContext('ui.overlay', 'overlayDock'),
    setAlwaysOnTop: (alwaysOnTop) => permittedContext('ui.overlay', 'overlaySetAlwaysOnTop', { alwaysOnTop })
  },
  chat: {
    getCurrent: (target) => permittedContext('chat.read', 'chatGetCurrent', { target }),
    setDraft: (text, options = {}) => permittedContext('chat.write', 'chatSetDraft', { ...options, text }),
    setContext: (key, text, target) => permittedContext('chat.context', 'chatSetContext', { key, text, target }),
    removeContext: (key, target) => permittedContext('chat.context', 'chatRemoveContext', { key, target })
  },
  projectInfo() {
    requirePermission('project.read')
    return requestContext('projectInfo', {})
  },
  storage: {
    get(key) {
      requirePermission('storage')
      return requestContext('storageGet', { key })
    },
    set(key, value) {
      requirePermission('storage')
      return requestContext('storageSet', { key, value }).then(() => undefined)
    }
  },
  net: {
    fetch(url, init) {
      requirePermission('net.fetch')
      return requestContext('netFetch', { url, init })
    }
  },
  callTool(toolName, input) {
    return requestContext('pluginTool', { toolName, input })
  }
}

function permittedContext(permission, op, args = {}) {
  requirePermission(permission)
  return requestContext(op, args)
}

const toolHandlers = new Map()

;(globalThis).modmindPlugin = {
  ctx,
  registerTools(handlers) {
    for (const [name, handler] of Object.entries(handlers ?? {})) {
      if (typeof handler === 'function') toolHandlers.set(name, handler)
    }
  }
}

if (!entryPath || !parentPort) {
  post({ kind: 'log', level: 'error', message: '插件宿主启动失败：缺少入口路径或 parentPort' })
} else {
  parentPort.on('message', async (event) => {
    const data = event && typeof event === 'object' ? event.data : undefined
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return

    if (data.kind === 'ctx') {
      const waiter = contextWaiters.get(data.id)
      if (!waiter) return
      contextWaiters.delete(data.id)
      clearTimeout(waiter.timer)
      if (data.ok) waiter.resolve(data.result)
      else waiter.reject(new Error(data.error || '上下文调用失败'))
      return
    }

    if (data.kind === 'call') {
      const handler = toolHandlers.get(String(data.tool))
      if (!handler) {
        post({ id: data.id, ok: false, error: `工具不存在或未注册：${data.tool}` })
        return
      }
      try {
        const result = await handler(data.input)
        post({ id: data.id, ok: true, result: result === undefined ? null : result })
      } catch (error) {
        post({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })

  import(pathToFileURL(entryPath).href)
    .then(() => {
      post({ kind: 'ready', registeredTools: [...toolHandlers.keys()] })
    })
    .catch((error) => {
      post({ kind: 'log', level: 'error', message: `插件入口加载失败：${error instanceof Error ? (error.stack || error.message) : String(error)}` })
      post({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
    })
}
