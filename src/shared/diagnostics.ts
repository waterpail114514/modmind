export function isExpectedCancellation(value: unknown): boolean {
  const name = value instanceof Error
    ? value.name
    : value && typeof value === 'object' && 'name' in value ? String((value as { name?: unknown }).name ?? '') : ''
  const message = value instanceof Error
    ? value.message
    : value && typeof value === 'object' && 'message' in value ? String((value as { message?: unknown }).message ?? '') : String(value ?? '')
  return name === 'AbortError'
    || /(?:^|\b)(?:aborted|cancelled|canceled)(?:\b|$)/i.test(message)
    || /(?:已停止|已取消|取消请求已处理|构建取消)/.test(message)
}

export interface DiagnosticErrorPayload {
  name: string
  message: string
  stack?: string
  componentStack?: string
  details?: unknown
}

/** Make Error's non-enumerable fields survive the renderer's structured-clone boundary. */
export function diagnosticErrorPayload(error: unknown): DiagnosticErrorPayload {
  const seen = new WeakSet<object>()
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value)
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return '[CIRCULAR]'
    if (depth >= 6) return '[MAX_DEPTH]'
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 100).map(item => copy(item, depth + 1))
    const result: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value).slice(0, 100)) {
      try { result[key] = copy((value as Record<string, unknown>)[key], depth + 1) }
      catch { result[key] = '[UNREADABLE]' }
    }
    return result
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error
      : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    details: copy(error, 0)
  }
}
