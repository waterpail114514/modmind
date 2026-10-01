const OPERATIONAL_STATUS_PATTERNS = [
  /模型服务暂时不可用.{0,120}(?:自动)?重试/i,
  /(?:线路繁忙|连接中断|响应超时).{0,120}(?:自动)?重试/i,
  /(?:正在|稍后|后|将于).{0,40}(?:自动)?重试(?:并继续)?/i,
  /第\s*\d+\s*次.{0,30}最多\s*\d+\s*次/i,
  /(?:rate\s*limit|service\s*unavailable|connection\s*(?:lost|closed|reset)|request\s*timed?\s*out).{0,160}(?:retry|attempt)/i,
  /(?:retrying|retry\s+attempt|will\s+retry|retries?\s+exhausted|retry\s+limit)/i,
  /^(?:external\s+agent|codex).{0,100}(?:waiting|reconnecting|retrying)/i,
  /^外部(?:代理| Agent)任务已停止/i,
  /^(?:我会先|我先|我将|我正在|接下来我会|现在我会).{0,180}(?:读取|检查|定位|调用|重试|继续|切换|验证|处理)/i,
  /^(?:我已|.{0,40}已确认).{0,180}(?:接下来|下一步|现在).{0,120}(?:读取|检查|定位|调用|重试|继续|切换|验证|处理|实现)/i,
  /^(?:i(?:'ll| will| need to| must)|we(?:'ll| need to| must)|let's).{0,180}(?:read|inspect|check|retry|continue|switch|call|validate|fix)/i,
  /^(?:i(?:'m| am)|we(?:'re| are)).{0,180}(?:reading|inspecting|checking|retrying|continuing|switching|calling|validating|fixing)/i,
  /^(?:pattern limit hit|tool failure repeats|we(?:'re| are) cycling|i must stop repeating)/i
]

/** Provider/CLI lifecycle text is useful status, but never a user answer. */
export function isAiOperationalStatusText(value: string): boolean {
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text || text.length > 800) return false
  return OPERATIONAL_STATUS_PATTERNS.some((pattern) => pattern.test(text))
}

export function isUsableAiAnswer(value: string | undefined | null): value is string {
  return Boolean(value?.trim()) && !isAiOperationalStatusText(value!)
}

export function selectFinalAiAnswer(
  bufferedResponse: string | undefined,
  summary: string | undefined,
  deliveredProgress: ReadonlySet<string>
): string {
  const buffered = bufferedResponse?.trim() ?? ''
  if (isUsableAiAnswer(buffered)) return buffered
  const fallback = summary?.trim() ?? ''
  if (!isUsableAiAnswer(fallback) || deliveredProgress.has(fallback)) return ''
  return fallback
}
