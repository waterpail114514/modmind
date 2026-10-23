const MAX_IMAGE_ERROR_BODY_BYTES = 64 * 1024

/** Error text can reflect both site sessions and temporary upstream credentials. */
export function sanitizeImageServiceError(value: string, secrets: readonly string[] = [], maxLength = 1000): string {
  let safe = value
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) safe = safe.replaceAll(secret, '[REDACTED]')
  return safe.replace(/\b(?:mdr_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/g, '[REDACTED]').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** Avoid buffering arbitrarily large reflected errors or malformed lease metadata. */
export async function readImageServiceErrorBody(response: Response, signal?: AbortSignal): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_ERROR_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: string[] = []
  const decoder = new TextDecoder()
  let received = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_IMAGE_ERROR_BODY_BYTES) return null
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  } finally { await reader.cancel().catch(() => undefined) }
}
