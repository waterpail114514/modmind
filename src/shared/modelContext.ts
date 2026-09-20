export const MAX_MODEL_CONTEXT = 100_000_000

export function validModelContext(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024 && value <= MAX_MODEL_CONTEXT
}

/** Overrides belong to exact model IDs so switching models cannot reuse a larger limit. */
export function normalizeModelContextWindows(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(([id, window]) => id.length > 0 && id.length <= 512 && !/[\x00-\x1f]/.test(id) && validModelContext(window)).slice(0, 500)
  return entries.length ? Object.fromEntries(entries) : undefined
}
