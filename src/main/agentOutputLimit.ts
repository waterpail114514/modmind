import { createHash } from 'node:crypto'

export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 3

export type OutputLimitReason = 'max-output-tokens' | 'suspected-output-limit'

/** Match the runtime's protocol error, not a mention of a request parameter. */
export function isOutputLimitFailure(message: string): boolean {
  return /Incomplete response returned, reason:\s*max_output_tokens\b/i.test(message)
}

/** Compatibility fallback for relays that incorrectly label a capped reply completed.
 * Require BOTH an exact common generation boundary and visibly unfinished long text.
 * Short answers, complete sentences and closed code blocks must never auto-continue.
 */
export function looksLikeCappedReply(text: string, outputTokens?: number): boolean {
  if (!outputTokens || outputTokens < 4096 || outputTokens > 131072 || !Number.isInteger(Math.log2(outputTokens))) return false
  const answer = text.trimEnd()
  if (answer.length < 1000) return false
  return /[\p{L}\p{N},，:：;；\-([{（【]$/u.test(answer)
}

export class ExternalAgentOutputLimitError extends Error {
  constructor(readonly reason: OutputLimitReason, readonly partialAnswer: string, readonly outputTokens?: number) {
    super(reason === 'max-output-tokens' ? '模型输出达到单次上限，任务尚未完成' : '模型输出疑似达到单次上限，回复尚未完整')
    this.name = 'ExternalAgentOutputLimitError'
  }
}

/** One budget per user task, including live route changes and network retries. */
export class AgentOutputLimitRecovery {
  private continuations = 0
  private readonly seen = new Set<string>()

  get active(): boolean { return this.continuations > 0 }

  next(error: ExternalAgentOutputLimitError): number {
    const text = error.partialAnswer.trim()
    const fingerprint = text ? createHash('sha256').update(text).digest('hex') : undefined
    if (this.continuations >= MAX_OUTPUT_LIMIT_CONTINUATIONS || fingerprint && this.seen.has(fingerprint)) {
      throw Object.assign(new Error('模型连续达到输出上限，自动继续未能完成任务。已保留当前修改和会话，请检查后继续或切换模型。'), { name: 'ExternalAgentOutputLimitExhaustedError' })
    }
    if (fingerprint) this.seen.add(fingerprint)
    return ++this.continuations
  }
}

export function outputLimitContinuationPrompt(originalTask: string): string {
  return `上一轮生成因输出上限而未完整结束。请在同一会话继续原任务，从中断处推进到完成；避免重复长篇推演，优先执行下一项必要操作并验证结果。保留已有修改与工具结果，不要重新执行已完成的写入、构建、下载等操作；结果不明时先查询状态。最后汇总完整交付结果和仍未完成的事项。\n\n原始任务：\n${originalTask}`
}
