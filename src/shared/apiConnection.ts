export function sameApiBaseUrl(left?: string, right?: string): boolean {
  if (!left?.trim() || !right?.trim()) return false
  try {
    const normalize = (value: string) => new URL(value.trim()).toString().replace(/\/$/, '')
    return normalize(left) === normalize(right)
  } catch { return false }
}

/**
 * Canonical form of an AI API base: HTTP(S) only, no credentials, no query or
 * fragment, and no trailing slash. Version segments are left untouched so the
 * model scan can still probe both the bare base and its `/v1` variant.
 */
export function normalizeAiApiBase(value: string, label = 'API URL'): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS`)
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials`)
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/** True when the pathname already ends in an OpenAI-style version segment. */
export function hasApiVersionPath(baseUrl: string): boolean {
  let pathname = ''
  try { pathname = new URL(baseUrl.trim()).pathname } catch { return false }
  return /\/v\d+(?:beta\d*)?$/i.test(pathname.replace(/\/+$/, ''))
}

/**
 * Append `/v1` only when the base is not already versioned. Providers that
 * publish `/v2` or `/v1beta` must not be doubled into `/v2/v1`.
 */
export function ensureOpenAiV1Base(baseUrl: string, label = 'API URL'): string {
  const base = normalizeAiApiBase(baseUrl, label)
  return hasApiVersionPath(base) ? base : `${base}/v1`
}
