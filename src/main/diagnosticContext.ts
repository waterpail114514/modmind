import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { redactDiagnosticText } from '../shared/redactDiagnosticText'
import argumentContracts from './diagnosticIpcArguments.json'

export const diagnosticContext = new AsyncLocalStorage<{ requestId: string; parentRequestId?: string; operation: string; projectPath?: string }>()
const secret = /authorization|cookie|credential|api.?key|password|secret|encrypted|token|captcha/i
const identity = /^(?:path|.*Path|file|fileName|from|to|id|.*Ids?|namespace|loader|.*Version|version|.*Model|model|backend|protocol|method|mode|encoding|format|mimeType|contentType|quality|moderation|background|style|action|toolName|size|operation|status|phase|stage|source|target|type|kind|scope|.*Revision|generation|baseline|sha\d*|hash|url|baseUrl|endpoint|code|param|title|name|branch|remote|enabled|success|error|message|reason)$/i

/** Retain identity and content fingerprints, never arbitrary prompts, source, secrets or blobs. */
export function diagnosticValue(value: unknown, key = '', depth = 0, seen = new WeakSet<object>()): unknown {
  if (secret.test(key)) return typeof value === 'boolean' && /^(?:has|is)/i.test(key) ? value : { present: Boolean(value) }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if ((identity.test(key) || /^(?:provider|role|side|repository|layout)$/.test(key)) && !/^data:|^blob:/i.test(value)) {
      let text = value
      if (/url|endpoint/i.test(key)) {
        try { const url = new URL(text); text = `${url.protocol}//${url.host}${url.pathname}` } catch { /* retain a bounded invalid address */ }
      }
      return redactDiagnosticText(text).slice(0, 1500)
    }
    return { chars: value.length, sha256: createHash('sha256').update(value).digest('hex') }
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { bytes: value.byteLength }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[CIRCULAR]'
  if (depth >= 5) return '[DEPTH_LIMIT]'
  seen.add(value)
  if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 20).map(item => diagnosticValue(item, key, depth + 1, seen)), truncated: value.length > 20 }
  const result: Record<string, unknown> = {}
  const entries = Object.entries(value)
  for (const [name, item] of entries.slice(0, 50)) result[name] = diagnosticValue(item, name, depth + 1, seen)
  if (entries.length > 50) result.__omittedKeys = entries.length - 50
  return result
}

const argumentNames: Record<string, string[]> = argumentContracts
export function diagnosticArguments(channel: string, args: unknown[]): Record<string, unknown> {
  return Object.fromEntries(args.slice(0, 12).map((value, index) => {
    const key = argumentNames[channel]?.[index] ?? `argument${index}`
    return [key, diagnosticValue(value, key)]
  }))
}
