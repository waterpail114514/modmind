const blocked = /key|token|authorization|cookie|password|secret|credential/i
export function uiDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return /^data:/.test(value) || value.length > 300 ? { chars: value.length } : value
  if (!value || typeof value !== 'object' || depth >= 4) return undefined
  if (Array.isArray(value)) return value.slice(0, 30).map(item => uiDiagnosticValue(item, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, blocked.test(key) ? '[REDACTED]' : uiDiagnosticValue(item, depth + 1)]))
}
export function recordUiDiagnostic(operation: string, data: unknown): void {
  try { window.modmind?.diagnostics?.reportEvent?.({ operation, data: uiDiagnosticValue(data) as Record<string, unknown> }) } catch { /* Diagnostics never interrupt user interaction. */ }
}

export function recordUiContentDiagnostic(operation: string, data: Record<string, unknown>, content: string): void {
  const capturedAt = new Date().toISOString(), chars = content.length
  if (chars > 8 * 1024 * 1024) { recordUiDiagnostic(operation, { ...data, capturedAt, chars, hashOmitted: 'content exceeds hashing budget' }); return }
  try { void crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)).then(hash => {
    recordUiDiagnostic(operation, { ...data, capturedAt, chars, sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') })
  }).catch(() => recordUiDiagnostic(operation, { ...data, capturedAt, chars, hashOmitted: 'hash unavailable' })) }
  catch { recordUiDiagnostic(operation, { ...data, capturedAt, chars, hashOmitted: 'hash unavailable' }) }
}
