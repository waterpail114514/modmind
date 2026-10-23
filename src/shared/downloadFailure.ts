export function downloadFailureText(error: unknown, depth = 0): string {
  if (depth >= 5) return '下载失败'
  if (!error || typeof error !== 'object') return String(error ?? '下载失败')
  const value = error as { message?: string; name?: string; code?: string; statusCode?: number; errors?: unknown[]; cause?: unknown }
  const children = value.errors?.slice(0, 8).map(cause => downloadFailureText(cause, depth + 1))
  if (children?.length) return [...new Set(children)].join('; ')
  const message = value.message?.trim() || value.name || '下载失败'
  const label = value.name && value.name !== 'Error' && !message.startsWith(value.name) ? `${value.name}: ${message}` : message
  return [label, value.code, value.statusCode ? `HTTP ${value.statusCode}` : '', value.cause ? downloadFailureText(value.cause, depth + 1) : '']
    .filter(Boolean).join(': ')
}
