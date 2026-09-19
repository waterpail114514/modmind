import { describeClientFailure } from './clientFailure'
import { describeAiFailureForUser } from './aiFailure'

/** Present failure fields in IPC results/events, retaining the originals via record first.
 * Success data, state flags and dedicated log/transcript contents are left intact.
 */
export function presentClientResult<T>(value: T, channel: string, record: (path: string, original: unknown) => void): T {
  const format = channel.startsWith('ai:') ? describeAiFailureForUser : describeClientFailure
  const seen = new WeakMap<object, unknown>()
  const visit = (input: unknown, path: string, depth: number): unknown => {
    if (!input || typeof input !== 'object' || depth > 8) return input
    if (seen.has(input)) return seen.get(input)
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer || input instanceof Date) return input
    if (Array.isArray(input)) {
      const result: unknown[] = []
      seen.set(input, result)
      for (let i = 0; i < input.length; i++) result.push(visit(input[i], `${path}[${i}]`, depth + 1))
      return result
    }
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return input
    const object = input as Record<string, unknown>
    const failed = object.success === false || [object.status, object.stage, object.kind, object.phase].some(status => status === 'error' || status === 'failed')
    const result: Record<string, unknown> = Object.create(null)
    seen.set(input, result)
    for (const [key, entry] of Object.entries(object)) {
      const errorField = ['error', 'lastError', 'runtimeError', 'outputError'].includes(key)
      const failureText = failed && ['message', 'detail', 'summary', 'content', 'reason'].includes(key)
      if ((errorField || failureText) && typeof entry === 'string' && entry) {
        record(`${path}.${key}`, entry)
        result[key] = format(entry)
      } else if (/^(?:logs|recentLogs|transcript|stdout|stderr|files|messages|view|input|params|arguments|config|manifest|settings|document)$/.test(key)) {
        result[key] = entry
      } else result[key] = visit(entry, `${path}.${key}`, depth + 1)
    }
    return result
  }
  return visit(value, channel, 0) as T
}
