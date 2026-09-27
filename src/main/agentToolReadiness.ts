import { setTimeout as delay } from 'node:timers/promises'
import { awaitWithAbort, throwIfAborted } from './asyncControl'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AGENT_TOOL_RECOVERY_GUIDANCE } from '../shared/aiFailure'

export const CORE_AGENT_TOOLS = ['modmind_project_info', 'modmind_project_files', 'modmind_read_project_file'] as const

/** Only preparation failures may restart automatically: no user turn has been sent. */
export class AgentToolsNotReadyError extends Error {
  pendingPrompt?: string
  constructor(detail: string) {
    super(`工具尚未准备好，本轮对话未开始。这是工具连接故障，不是用户禁用。${detail}${AGENT_TOOL_RECOVERY_GUIDANCE}`)
    this.name = 'AgentToolsNotReadyError'
  }
}

export class AgentToolsDisconnectedError extends Error {
  constructor() {
    super(`ModMind 工具连接已中断，当前会话和已完成操作已保留。${AGENT_TOOL_RECOVERY_GUIDANCE}`)
    this.name = 'AgentToolsDisconnectedError'
  }
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' ? value as RecordValue : {}
}

export function agentToolInventoryReady(value: unknown, kind: 'codex' | 'claude'): boolean {
  const server = record(value)
  const state = kind === 'codex' ? server.runtimeStatus : server.status
  if (state != null && state !== 'connected') return false
  if (server.toolsError || server.error) return false
  const names = Array.isArray(server.tools)
    ? server.tools.map(tool => typeof tool === 'string' ? tool : record(tool).name)
    : Object.entries(record(server.tools)).flatMap(([key, tool]) => [key, record(tool).name])
  return CORE_AGENT_TOOLS.every(name => names.includes(name) || names.includes(`mcp__modmind__${name}`))
}

/** Query the client's actual catalog, including pagination; a host HTTP listener alone isn't readiness. */
export async function waitForAgentTools(options: {
  kind: 'codex' | 'claude'
  list: (cursor?: string) => Promise<unknown>
  signal: AbortSignal
  timeoutMs?: number
  pollMs?: number
}): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const signal = AbortSignal.any([options.signal, timeout])
  try {
    for (;;) {
      throwIfAborted(signal)
      let cursor: string | undefined
      const cursors = new Set<string>()
      let server: RecordValue | undefined
      do {
        const response = record(await awaitWithAbort(options.list(cursor), signal))
        const servers = options.kind === 'codex' ? response.data : response.mcpServers
        if (!Array.isArray(servers)) throw new Error('客户端未返回有效工具目录，请检查 Agent 版本。')
        server = servers.map(record).find(item => item.name === 'modmind')
        if (server) break
        cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined
        if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('工具目录分页无效。')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (server && agentToolInventoryReady(server, options.kind)) return
      const state = server?.runtimeStatus ?? server?.status
      if (['failed', 'cancelled', 'disabled', 'authenticationRequired', 'needs-auth'].includes(String(state))) {
        throw new Error(`ModMind 工具连接状态：${String(state)}。`)
      }
      // Startup and empty/incomplete inventories can settle asynchronously.
      await delay(options.pollMs ?? 200, undefined, { signal })
    }
  } catch (error) {
    throwIfAborted(options.signal)
    throw new AgentToolsNotReadyError(timeout.aborted ? '等待工具目录超时。' : error instanceof Error ? error.message : String(error))
  }
}

/** Claude streaming-input control protocol; never send the user message during initialization. */
export async function prepareClaudeTools(child: ChildProcessWithoutNullStreams, signal: AbortSignal, timeoutMs = 20_000): Promise<void> {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const timeout = AbortSignal.timeout(timeoutMs)
  const lifetime = AbortSignal.any([signal, timeout])
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const consume = (chunk: Buffer): void => {
    buffer += decoder.write(chunk)
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      let message: RecordValue
      try { message = record(JSON.parse(line)) } catch { continue }
      if (message.type !== 'control_response') continue
      const response = record(message.response)
      const waiter = pending.get(String(response.request_id))
      if (!waiter) continue
      pending.delete(String(response.request_id))
      if (response.subtype === 'success') waiter.resolve(response.response)
      else waiter.reject(new Error('Claude Code 无法确认工具状态，请检查 Agent 版本与工具配置。'))
    }
  }
  const closed = (): void => {
    for (const waiter of pending.values()) waiter.reject(new Error('Claude Code 在工具准备完成前退出。'))
    pending.clear()
  }
  const request = (subtype: string): Promise<unknown> => awaitWithAbort(new Promise((resolve, reject) => {
    const id = randomUUID()
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`, error => {
      if (error) { pending.delete(id); reject(error) }
    })
  }), lifetime)
  child.stdout.on('data', consume)
  child.once('close', closed)
  child.once('error', closed)
  try {
    await request('initialize')
    await waitForAgentTools({ kind: 'claude', signal: lifetime, timeoutMs, list: () => request('mcp_status') })
  } catch (error) {
    throwIfAborted(signal)
    throw new AgentToolsNotReadyError(timeout.aborted ? '等待 Claude Code 工具目录超时。' : error instanceof Error ? error.message : String(error))
  } finally {
    child.stdout.off('data', consume)
    child.off('close', closed)
    child.off('error', closed)
    pending.clear()
  }
}
