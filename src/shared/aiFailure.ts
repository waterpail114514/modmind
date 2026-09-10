function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusIn(message: string, status: number): boolean {
  return new RegExp(`(?:^|\\D)${status}(?:\\D|$)`).test(message)
}

/** Converts provider/Agent failures into a user-facing cause and next step. */
export function describeAiFailureForUser(error: unknown): string {
  const message = readMessage(error).replace(/\s+/g, ' ').trim()
  if (!message) return '上游模型没有返回错误详情，请稍后重试或导出诊断日志。'

  if (/no-output-timeout|没有任何操作|没有返回(?:任何内容|可显示的(?:回答|内容))|did not respond|no output|empty response|响应超时|响应.*超时/i.test(message)) {
    const duration = message.match(/(?:连续|等待)\s*([0-9]+\s*(?:分钟|秒))/i)?.[1]
    return `上游模型${duration ? `在 ${duration} 内` : ''}没有返回任何内容。你的问题没有被判定为有误；请稍后重试，或切换模型/线路。`
  }
  if (/ResumedPromptRejection|会话.*(?:拒绝|失效|不存在)|session.*(?:reject|invalid|not found)|(?:rollout|thread|history).*(?:invalid|not found)|\bno\s+(?:rollout|thread|session|history)\s+found\b/i.test(message)) {
    return '之前保存的会话记录已丢失或被拒绝，该会话已失效。ModMind 会保留项目进度并尝试用新会话继续；若仍失败，请重新发送任务或导出诊断日志。'
  }
  if (statusIn(message, 500) || statusIn(message, 502) || statusIn(message, 503) || statusIn(message, 504)) {
    const status = message.match(/(?:^|\D)(50[0-4])(?:\D|$)/)?.[1]
    return `上游模型服务异常（HTTP ${status ?? '5xx'}），不是你的需求描述错误。请稍后重试或切换线路。`
  }
  if (statusIn(message, 429) || /rate.?limit|线路繁忙|模型线路仍在冷却/i.test(message)) {
    return '上游模型线路繁忙（HTTP 429/临时不可用），请求未能完成。请等待冷却结束后重试，或切换模型/线路。'
  }
  if (/服务暂时不可用|temporarily unavailable|service unavailable/i.test(message)) {
    return '上游模型服务暂时不可用，请稍后重试或切换线路。你的需求没有被判定为有误。'
  }
  if (statusIn(message, 401) || /凭证已失效|authentication fails|unauthorized|api key.*invalid/i.test(message)) {
    return '上游模型凭证无效或已过期（HTTP 401）。请重新连接账号或更新 API Key。'
  }
  if (statusIn(message, 402) || /额度不足|余额不足|payment required/i.test(message)) {
    return '上游模型账号余额或额度不足（HTTP 402）。请检查用量或充值后再试。'
  }
  if (statusIn(message, 403) || /没有.*模型.*访问权限|forbidden|model.{0,30}permission/i.test(message)) {
    return '当前账号没有所选模型的访问权限（HTTP 403）。请切换可用模型或账号。'
  }
  if (statusIn(message, 404) || /模型接口或所选模型不存在|(?:model|endpoint|route|api).{0,40}not found|not found.{0,40}(?:model|endpoint|route|api)/i.test(message)) {
    return '上游模型接口或所选模型不存在（HTTP 404）。请重新扫描模型，或检查线路地址。'
  }
  if (/stream disconnected|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|ENOTFOUND|network error|fetch failed|连接中断/i.test(message)) {
    return '与上游模型服务的连接中断，请检查网络后重试，或切换线路。'
  }
  if (/Review Agent rejected completion|Mandatory workflow incomplete|工作流未完成|审查.*未通过/i.test(message)) {
    const missing = message.match(/(?:Missing stages|缺少阶段)[:：]?\s*([^.;。]+)/i)?.[1]
    return `ModMind 完成检查未通过${missing ? `，还缺少：${missing}` : ''}。已保留当前进度，请继续任务完成验证。`
  }
  if (statusIn(message, 400) || statusIn(message, 422) || /invalid_request|invalid (?:api )?parameter|请求参数无效|参数错误|协议不兼容|bad request/i.test(message)) {
    return '上游模型接口拒绝了 Agent 请求（HTTP 400/422）：当前线路或模型不兼容这类请求，这通常不是你的需求内容错误。请切换线路或模型，或更新 ModMind。'
  }
  if (/外部代理任务已停止|任务已停止/i.test(message)) {
    return '任务已停止，停止前收到的内容已保留。你可以稍后继续，或重新发送任务。'
  }
  if (/provider returned error|internal server error|unknown error|未知错误|未分类错误|异常退出（退出码/i.test(message)) {
    return '上游模型服务返回了未分类错误，未能完成回答。请稍后重试，或切换模型/线路；这不是你的需求内容错误。'
  }
  return message
}
