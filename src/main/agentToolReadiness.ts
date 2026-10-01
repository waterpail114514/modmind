import { setTimeout as delay } from 'node:timers/promises'
import { awaitWithAbort, throwIfAborted } from './asyncControl'
import { AGENT_TOOL_RECOVERY_GUIDANCE } from '../shared/aiFailure'

export const MCP_PROBE_TOOL = 'modmind_mcp_probe'
export const MCP_PROBE_MARKER = 'modmind-mcp-ready-v1'
export const CORE_AGENT_TOOLS = ['modmind_project_info', 'modmind_project_files', 'modmind_read_project_file'] as const

export function agentProbeResultReady(value: unknown): boolean {
  const response = record(value)
  if (response.isError === true || !Array.isArray(response.content)) return false
  return response.content.some(item => {
    const block = record(item)
    if (block.type !== 'text' || typeof block.text !== 'string') return false
    try {
      const payload = record(JSON.parse(block.text))
      return payload.ok === true && payload.marker === MCP_PROBE_MARKER
    } catch { return false }
  })
}

export function agentReportsMissingTools(answer: string): boolean {
  const unavailable = /(?:没有|缺少|未提供|无法使用|不可用|未连接|连接已中断|缺失).{0,24}(?:工具|接口)|(?:tools? (?:are |is )?(?:unavailable|missing|not provided|not connected))|(?:no (?:available|callable) tools?)/i
  const taskBlocked = /(?:无法|不能|暂时无法|尚未|未能).{0,30}(?:读取|读写|修改|编辑|构建|执行|操作|访问)|(?:unable|cannot|can't).{0,40}(?:read|write|edit|build|access|execute|modify)/i
  return unavailable.test(answer) && taskBlocked.test(answer)
}

/** Only preparation failures may restart automatically: no user turn has been sent. */
export class AgentToolsNotReadyError extends Error {
  pendingPrompt?: string
  constructor(detail: string) {
    super(`工具尚未准备好，本轮对话未开始。这是工具连接故障，不是用户禁用。${detail}${AGENT_TOOL_RECOVERY_GUIDANCE}`)
    this.name = 'AgentToolsNotReadyError'
  }
}

export class AgentToolsDisconnectedError extends Error {
  readonly reportedByModel: boolean
  constructor(reportedByModel = false) {
    super(reportedByModel
      ? '模型回复称本轮没有可用的项目工具，且没有发起工具调用；当前任务未完成。已保留会话和项目改动。请重试；若持续出现，请切换模型或线路并导出诊断信息。'
      : `ModMind 工具连接已中断，当前会话和已完成操作已保留。${AGENT_TOOL_RECOVERY_GUIDANCE}`)
    this.name = 'AgentToolsDisconnectedError'
    this.reportedByModel = reportedByModel
  }
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' ? value as RecordValue : {}
}

export function agentToolInventoryReady(value: unknown): boolean {
  const summary = agentToolInventorySummary(value)
  return summary.missing.length === 0 && (summary.status === 'connected' || summary.status === 'unknown')
}

export function agentToolInventorySummary(value: unknown): { status: string; count: number; missing: string[] } {
  const server = record(value)
  const state = server.runtimeStatus
  const names = Array.isArray(server.tools)
    ? server.tools.map(tool => typeof tool === 'string' ? tool : record(tool).name)
    : Object.entries(record(server.tools)).flatMap(([key, tool]) => [key, record(tool).name])
  const required = [MCP_PROBE_TOOL, ...CORE_AGENT_TOOLS]
  return {
    status: server.toolsError || server.error ? 'error' : state == null ? 'unknown' : String(state),
    count: new Set(names.filter((name): name is string => typeof name === 'string')).size,
    missing: required.filter(name => !names.includes(name) && !names.includes(`mcp__modmind__${name}`))
  }
}

/** Query the client's actual catalog, including pagination; a host HTTP listener alone isn't readiness. */
export async function waitForAgentTools(options: {
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
        const servers = response.data
        if (!Array.isArray(servers)) throw new Error('客户端未返回有效工具目录，请检查 Agent 版本。')
        server = servers.map(record).find(item => item.name === 'modmind')
        if (server) break
        cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined
        if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('工具目录分页无效。')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (server && agentToolInventoryReady(server)) return
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
