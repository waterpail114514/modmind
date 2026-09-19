export interface LogIssue {
  title: string
  count: number
  firstLine: number
  lastLine: number
  stack: string
}
export interface LogDigest {
  diagnostic: boolean
  issues: LogIssue[]
  observations: string
  context: string[]
  totalLines: number
}

const prefix = /^(?:\[[^\]\r\n]{1,160}\]\s*)+(?:(?:\[[^\]]+\])\s*)?/
const exception = /(?:[\w.$]+(?:Exception|Error)(?::|\s|$)|(?:^|\s)(?:ERROR|FATAL)(?:\s|\]))/
const frame = /^\s*(?:at\s+[\w.$]+\(|Caused by:|Suppressed:|\.\.\.\s+\d+\s+more)/
const logLine = /^(?:\[\d{2}:\d{2}:\d{2}|\[\d{4}-\d{2}-\d{2}|\[.*\/(?:INFO|WARN|ERROR)|\d{4}-\d{2}-\d{2}[ T]|\s*at\s+[\w.$]+\(|Caused by:|Suppressed:|\s*\.\.\. \d+ more|> Task |BUILD (?:SUCCESSFUL|FAILED))/
const normal = (line: string): string => line.replace(prefix, '').replace(/Task #\d+/g, 'Task #*').trimEnd()

/** Group whole exception chains, retaining prose and independent failures. */
export function summarizeLog(text: string): LogDigest {
  const lines = text.split(/\r?\n/)
  const groups = new Map<string, LogIssue>()
  const observations: string[] = []
  const context: string[] = []
  let diagnostic = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (exception.test(line) && !/^\s*at\s/.test(line)) {
      diagnostic = true
      const start = i
      const chain = [line]
      while (i + 1 < lines.length && frame.test(normal(lines[i + 1]))) chain.push(lines[++i])
      const key = chain.map(normal).join('\n')
      const prior = groups.get(key)
      if (prior) { prior.count++; prior.lastLine = i + 1 }
      else groups.set(key, { title: normal(line), count: 1, firstLine: start + 1, lastLine: i + 1, stack: chain.join('\n') })
    } else if (logLine.test(line) || frame.test(line)) {
      diagnostic = true
      if (/version|enabl|load.*plugin|joined|logged in|Done \(|BUILD |FAILURE|error:|错误[:：]|not found|disconnect/i.test(line)) context.push(line)
    } else observations.push(line)
  }
  return { diagnostic, issues: [...groups.values()], observations: observations.join('\n').trim(), context: [...new Set(context)], totalLines: lines.length }
}

export function logDigestText(digest: LogDigest, reference: string): string {
  if (!digest.diagnostic) return digest.observations
  let budget = 12_000
  const blocks: string[] = []
  for (const issue of digest.issues) {
    const block = `异常 ${issue.title}\n出现 ${issue.count} 次；原文行 ${issue.firstLine}–${issue.lastLine}\n${issue.stack}`
    if (block.length > budget) {
      blocks.push(`其余异常/堆栈请读取原文；下一异常起于第 ${issue.firstLine} 行。`)
      break
    }
    blocks.push(block); budget -= block.length
  }
  return [digest.observations, `日志证据：${reference}（${digest.totalLines} 行；${digest.issues.length} 类异常，摘要不是根因判断）`, ...blocks,
    digest.context.slice(0, 12).join('\n'), `需要更多上下文时按证据编号读取原文；未列出的日志不表示没有问题。`].filter(Boolean).join('\n\n')
}

export function isFailureFeedback(value: string): boolean {
  return /还是.{0,12}(?:不行|失败|崩溃|没|无法|不能)|仍然.{0,12}(?:不|没|失败|崩溃)|未解决|又(?:崩溃|报错)|still.{0,20}(?:fail|broken|not work)/i.test(value)
}

export interface CreationRequirement {
  id: string
  text: string
  sourceMessageId: string
  status: 'active' | 'superseded' | 'cancelled'
  replaces?: string
  author: 'user' | 'assistant'
}
export interface CreationLogRecord { id: string; source: string; createdAt: string; digest: LogDigest }
export interface CreationBuild { id: string; path: string; sha256?: string; createdAt: string; configurationHash: string; sourceHash?: string; status: 'running' | 'built' | 'failed' | 'cancelled' | 'stale'; detail?: string }
export interface CreationCheck { id: string; buildId?: string; sessionId?: string; stage: 'startup' | 'joined' | 'interaction' | 'visual' | 'user'; passed: boolean; detail: string; createdAt: string; evidenceId?: string }
export type CreationDeliveryStatus = 'partial' | 'awaiting-verification' | 'blocked' | 'complete' | 'cancelled'
export interface CreationTaskRecord { id: string; conversationId?: string; requestEvidence: string; observations: string; createdAt: string; failure: boolean; latestBuildIdAtRequest?: string; answer?: string; hypothesis?: string; delivery?: { status: CreationDeliveryStatus; remaining: string[]; evidenceIds: string[] }; targets?: CreationTargetRecord[]; usage?: { input: number; cached: number; output: number }; elapsedMs?: number }
export interface CreationTargetRecord { path: string; projectId?: string; before: Record<string, string>; changedFiles?: string[]; artifacts?: Array<{ path: string; sha256: string }>; missing?: string[] }
export interface CreationState { revision: number; requirements: CreationRequirement[]; logs: CreationLogRecord[]; builds: CreationBuild[]; checks: CreationCheck[]; tasks: CreationTaskRecord[] }
