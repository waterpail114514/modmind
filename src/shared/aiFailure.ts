import { describeClientFailure } from './clientFailure'
import { rawErrorText } from './rawError'

export const AGENT_TOOL_RECOVERY_GUIDANCE = '建议先重试；仍失败请重启 ModMind；重启后仍无法恢复，可重新安装最新版 ModMind。'

function readMessage(error: unknown): string {
  return rawErrorText(error)
}

function statusIn(message: string, status: number): boolean {
  // A request id or token count containing 429/500 is not an HTTP failure.
  return new RegExp(`(?:\\b(?:HTTP(?:/\\d(?:\\.\\d)?)?|status(?:_code)?)[\\s"':=]*${status}\\b|^${status}(?:\\s|$)|[（(]${status}(?:[）)，,]|\\s)|\\b${status}\\s+(?:Too Many Requests|Unauthorized|Forbidden|Not Found|Bad Request|Payment Required|Payload Too Large|Request Entity Too Large|Content Too Large|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\\b)`, 'i').test(message)
}

/** Converts provider/Agent failures into a user-facing cause and next step. */
export function describeAiFailureForUser(error: unknown): string {
  const message = readMessage(error).replace(/\s+/g, ' ').trim()

  // Tool preparation failures have their own recovery path. Preserve it through
  // repeated IPC/UI formatting instead of suggesting a model or network change.
  if (/工具尚未准备好，本轮对话未开始|ModMind 工具连接已中断/.test(message)) {
    return message.includes(AGENT_TOOL_RECOVERY_GUIDANCE) ? message : `${message}${AGENT_TOOL_RECOVERY_GUIDANCE}`
  }

  if (statusIn(message, 413)) {
    return 'AI 请求内容过大（413），超过了服务或网关的大小限制。请新建会话并精简历史、附件或日志；如仍失败，请联系线路管理员调整请求大小限制。'
  }
  if (/no-output-timeout|没有任何操作|没有返回(?:任何内容|可显示的(?:回答|内容))|did not respond|no output|empty response|响应超时|响应.*超时/i.test(message)) {
    const duration = message.match(/(?:连续|等待)\s*([0-9]+\s*(?:分钟|秒))/i)?.[1]
    return `AI${duration ? `在 ${duration} 内` : ''}没有返回任何内容，请重试或切换模型。`
  }
  if (/ResumedPromptRejection|会话.*(?:拒绝|失效|不存在)|session.*(?:reject|invalid|not found)|(?:rollout|thread|history).*(?:invalid|not found)|\bno\s+(?:rollout|thread|session|history)\s+found\b/i.test(message)) {
    return '会话已失效，请重新发送任务。项目进度已保留。'
  }
  if (statusIn(message, 500) || statusIn(message, 502) || statusIn(message, 503) || statusIn(message, 504)) {
    const status = message.match(/(?:^|\D)(50[0-4])(?:\D|$)/)?.[1]
    return `AI 服务暂时异常（HTTP ${status ?? '5xx'}），请稍后重试。`
  }
  if (statusIn(message, 429) || /rate.?limit|线路繁忙|模型线路仍在冷却/i.test(message)) {
    return 'AI 线路繁忙，请稍后重试或切换模型。'
  }
  if (/服务暂时不可用|temporarily unavailable|service unavailable/i.test(message)) {
    return 'AI 服务暂时不可用，请稍后重试。'
  }
  if (statusIn(message, 401) || /凭证已失效|authentication fails|unauthorized|api key.*invalid/i.test(message)) {
    return 'AI 凭证无效或已过期，请重新连接账号。'
  }
  if (statusIn(message, 402) || /额度不足|余额不足|payment required/i.test(message)) {
    return 'AI 余额或额度不足，请检查账号用量。'
  }
  if (statusIn(message, 403) || /没有.*模型.*访问权限|forbidden|model.{0,30}permission/i.test(message)) {
    return '没有所选模型的访问权限，请切换模型。'
  }
  if (statusIn(message, 404) || /模型接口或所选模型不存在|(?:model|endpoint|route|api).{0,40}not found|not found.{0,40}(?:model|endpoint|route|api)/i.test(message)) {
    return '模型接口或所选模型不存在，请检查线路配置。'
  }
  if (/stream disconnected|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|ENOTFOUND|network error|fetch failed|连接中断/i.test(message)) {
    return 'AI 连接中断，请检查网络或切换线路。'
  }
  if (/Review Agent rejected completion|Mandatory workflow incomplete|工作流未完成|审查.*未通过/i.test(message)) {
    return `ModMind 完成检查未通过，请继续任务完成验证。`
  }
  if (statusIn(message, 400) || statusIn(message, 422) || /invalid_request|invalid (?:api )?parameter|请求参数无效|参数错误|协议不兼容|bad request/i.test(message)) {
    return 'AI 请求未被接受，请检查模型接口配置或切换模型后继续。'
  }
  if (/外部代理任务已停止|任务已停止/i.test(message)) {
    return '任务已停止，当前进度已保留。'
  }
  return describeClientFailure(error)
}
