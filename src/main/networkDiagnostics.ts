import { channel } from 'node:diagnostics_channel'
import { randomUUID } from 'node:crypto'
import { diagnosticJournal } from './diagnosticLog'
import { diagnosticContext, diagnosticValue } from './diagnosticContext'
import type { Readable } from 'node:stream'

let installed = false
export function installNetworkDiagnostics(): void {
  if (installed) return
  installed = true
  const requests = new WeakMap<object, { requestId: string; startedAt: number; projectPath?: string; context: unknown; target: unknown }>()
  const observe = (name: string, listener: (message: Record<string, any>) => void) => channel(name).subscribe(value => {
    try { listener(value as Record<string, any>) } catch { /* A diagnostic subscriber must never alter transport. */ }
  })
  observe('undici:request:create', ({ request }) => {
    const context = diagnosticContext.getStore()
    const entry = { requestId: randomUUID(), startedAt: Date.now(), context, projectPath: context?.projectPath, target: { method: request.method, url: diagnosticValue(`${request.origin}${request.path}`, 'url') } }
    requests.set(request, entry)
    diagnosticJournal.record({ subsystem: 'network', operation: 'request', phase: 'start', message: 'HTTP request started', data: entry })
  })
  observe('undici:request:headers', ({ request, response }) => {
    const entry = requests.get(request)
    const headers: Record<string, string> = {}
    for (let index = 0; index < response.headers.length; index += 2) {
      const name = String(response.headers[index]).toLowerCase()
      if (/^(?:x-request-id|request-id|x-amzn-requestid|traceparent|cf-ray|retry-after|content-type|content-length)$/.test(name)) headers[name] = String(response.headers[index + 1]).slice(0, 1000)
    }
    diagnosticJournal.record({ subsystem: 'network', operation: 'request', phase: 'headers', level: response.statusCode >= 400 ? 'warning' : 'info', message: `HTTP ${response.statusCode}`, durationMs: entry ? Date.now() - entry.startedAt : undefined, data: { ...entry, status: response.statusCode, headers } })
  })
  observe('undici:request:trailers', ({ request }) => {
    const entry = requests.get(request)
    diagnosticJournal.record({ subsystem: 'network', operation: 'request', phase: 'complete', message: 'HTTP response body completed', durationMs: entry ? Date.now() - entry.startedAt : undefined, data: entry })
    requests.delete(request)
  })
  observe('undici:request:error', ({ request, error }) => {
    const entry = requests.get(request)
    diagnosticJournal.record({ subsystem: 'network', operation: 'request', phase: 'error', message: 'HTTP request failed', durationMs: entry ? Date.now() - entry.startedAt : undefined, data: entry, error })
    requests.delete(request)
  })
  observe('undici:client:connectError', ({ connectParams, error }) => {
    diagnosticJournal.record({ subsystem: 'network', operation: 'connect', phase: 'error', message: 'Connection handshake failed', data: { host: String(connectParams?.hostname ?? '').slice(0, 300), port: connectParams?.port, protocol: connectParams?.protocol }, error })
  })
}

/** Bound error bodies; unlike response.text(), a hostile gateway cannot allocate an unbounded body. */
export async function readDiagnosticResponse(response: Response, limit = 64 * 1024, timeoutMs = 5000): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined) }, timeoutMs)
  try {
    while (length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const part = value.subarray(0, limit - length)
      chunks.push(part); length += part.byteLength
    }
    return Buffer.concat(chunks).toString('utf8') + (timedOut ? '\n[RESPONSE_BODY_TIMEOUT]' : length >= limit ? '\n[RESPONSE_TRUNCATED]' : '')
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined) }
}

/** Preserve the HTTP rejection even if its diagnostic body stalls or disconnects. */
export async function readDiagnosticNodeResponse(body: Readable, limit = 32 * 1024, timeoutMs = 5000): Promise<{ text: string; truncated: boolean; timedOut: boolean; incomplete: boolean }> {
  const chunks: Buffer[] = []
  let length = 0, timedOut = false, incomplete = false
  const timer = setTimeout(() => { timedOut = true; body.destroy() }, timeoutMs)
  try {
    for await (const chunk of body) {
      const part = Buffer.from(chunk).subarray(0, limit - length)
      chunks.push(part); length += part.length
      if (length >= limit) break
    }
  } catch { incomplete = true }
  finally { clearTimeout(timer) }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: length >= limit, timedOut, incomplete }
}
