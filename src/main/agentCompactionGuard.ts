import { createHash } from 'node:crypto'

export class ExternalAgentContextStallError extends Error {
  constructor() {
    super('连续整理上下文后仍未取得新进展，任务已暂停。请切换模型后继续。')
    this.name = 'ExternalAgentContextStallError'
  }
}

/** Count native completed compactions, never warning text or assistant promises. */
export class AgentCompactionGuard {
  private compactions: number[] = []
  private readonly completed = new Set<string>()
  private readonly evidence = new Set<string>()

  get stalled(): boolean { return this.compactions.length >= 3 }

  observe(item: Record<string, unknown>, now = Date.now()): boolean {
    if (typeof item.id !== 'string' || this.completed.has(item.id)) return false
    this.completed.add(item.id)
    if (item.type === 'contextCompaction') {
      this.compactions = this.compactions.filter(time => now - time <= 5 * 60_000)
      this.compactions.push(now)
      return this.compactions.length >= 3
    }
    let result: unknown
    let operation: unknown
    if (item.type === 'commandExecution' && item.exitCode === 0) {
      operation = 'commandExecution'
      result = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : undefined
    } else if (item.type === 'fileChange' && item.status === 'completed') {
      operation = 'fileChange'
      result = item.changes
    } else if (item.type === 'mcpToolCall' && item.status === 'completed' && !item.error) {
      if (/update_todo|set_intent/.test(String(item.tool))) return false
      const value = item.result as Record<string, unknown> | undefined
      if (value?.isError === true) return false
      operation = [item.server, item.tool, item.arguments]
      result = value
    } else if (item.type === 'dynamicToolCall' && item.success === true) {
      operation = [item.tool, item.arguments]
      result = item.contentItems
    } else return false
    if (result === undefined || result === null || result === '') return false
    // Exclude event IDs and timing: rereading an unchanged result isn't progress.
    const fingerprint = createHash('sha256').update(JSON.stringify([operation, result])).digest('hex')
    if (!this.evidence.has(fingerprint)) {
      this.evidence.add(fingerprint)
      this.compactions = []
    }
    return false
  }
}
