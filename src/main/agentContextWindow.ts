import { validModelContext } from '../shared/modelContext'


/** The protocol reports one code per failure; the payload sits under that key. */
function errorType(codexErrorInfo: unknown): string | undefined {
  if (typeof codexErrorInfo === 'string') return codexErrorInfo
  if (!codexErrorInfo || typeof codexErrorInfo !== 'object') return undefined
  const record = codexErrorInfo as Record<string, unknown>
  return Object.keys(record)[0]
}

function errorDetails(codexErrorInfo: unknown): Record<string, unknown> | undefined {
  if (!codexErrorInfo || typeof codexErrorInfo !== 'object' || Array.isArray(codexErrorInfo)) return undefined
  const record = codexErrorInfo as Record<string, unknown>
  const type = Object.keys(record)[0]
  const nested = type ? record[type] : undefined
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>
  return record
}

/**
 * Wording carries the signal in practice: the managed Codex app-server reports a
 * provider's context_length_exceeded as codexErrorInfo "other" and preserves only
 * the raw message, so a code-only check would never fire. The typed code is still
 * read first for runtimes that do set it.
 *
 * The wording check requires a context keyword on purpose: "too many tokens"
 * alone is also how a per-minute rate limit is phrased, and shrinking the
 * window would not help there.
 */
const CONTEXT_OVERFLOW = /(?:maximum context length|context (?:window|length)[^.\n]{0,60}(?:exceed|too (?:long|large|many)|maximum|limit)|exceed(?:s|ed)?[^.\n]{0,40}context (?:window|length)|prompt is too long|input (?:is )?too long|reduce the length of the messages)/i

export function isContextWindowFailure(message: string, codexErrorInfo?: unknown): boolean {
  if (errorType(codexErrorInfo) === 'contextWindowExceeded') return true
  return CONTEXT_OVERFLOW.test(message)
}

/**
 * Numbers only count when they sit next to a capacity keyword: request ids,
 * timestamps and token counts from unrelated sentences must not become a limit.
 */
const DECLARED_LIMIT_PATTERNS = [
  /maximum context length is\s*([\d,]{4,12})/i,
  /context (?:window|length)(?: of| is|:)?\s*(?:only\s*)?([\d,]{4,12})/i,
  /(?:limit|maximum)(?: of)?\s*([\d,]{4,12})\s*tokens/i,
  // "… requested 210,000 tokens but 200,000 maximum" states the ceiling after
  // the request size, so the trailing superlative identifies the right number.
  /([\d,]{4,12})\s*(?:tokens?\s*)?(?:maximum|max)\b/i,
  // A lone number after "prompt is too long" is the request size, never the
  // ceiling; only accept it when the sentence also mentions a maximum.
  /prompt is too long[^\n]{0,80}?([\d,]{4,12})\s*(?:tokens?\s*)?maximum/i
]

/**
 * Some providers name the capacity they rejected the prompt against, and a few
 * report it as structured error data. That number describes this deployment,
 * unlike any bundled catalog, so it is worth reading before guessing.
 */
export function parseAdvertisedContextLimit(message: string, codexErrorInfo?: unknown): number | undefined {
  const details = errorDetails(codexErrorInfo)
  // Only keys that name a context capacity: a bare `limit` in error details can
  // describe requests per minute, and using it would corrupt the window.
  for (const key of ['maxContextWindow', 'max_context_window', 'maxContextTokens', 'max_context_tokens', 'contextWindow', 'context_window', 'maxTokens']) {
    const value = details?.[key]
    if (validModelContext(value)) return value
  }
  for (const pattern of DECLARED_LIMIT_PATTERNS) {
    const match = pattern.exec(message)
    if (!match) continue
    const value = Number(match[1].replace(/,/g, ''))
    if (validModelContext(value)) return value
  }
  return undefined
}

const formatTokens = (value: number): string => value.toLocaleString('zh-CN')

/**
 * Typed so the host can correct the saved configuration instead of showing the
 * provider's raw text, which says nothing about what the user should change.
 */
export class ExternalAgentContextWindowError extends Error {
  constructor(
    readonly model: string | undefined,
    readonly configured: number | undefined,
    readonly observed: number | undefined,
    readonly detail: string
  ) {
    super(observed === undefined
      ? `模型无法容纳当前上下文${configured === undefined ? '' : `（已配置 ${formatTokens(configured)}）`}，本轮请求被拒绝`
      : `模型装不下当前上下文：模型上限约 ${formatTokens(observed)}${configured === undefined ? '' : `，当前配置 ${formatTokens(configured)}`}`)
    this.name = 'ExternalAgentContextWindowError'
  }
}
