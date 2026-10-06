export function sameApiBaseUrl(left?: string, right?: string): boolean {
  if (!left?.trim() || !right?.trim()) return false
  try {
    const normalize = (value: string) => new URL(value.trim()).toString().replace(/\/$/, '')
    return normalize(left) === normalize(right)
  } catch { return false }
}
