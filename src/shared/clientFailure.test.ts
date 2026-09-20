import { describe, expect, it } from 'vitest'
import { describeClientFailure } from './clientFailure'
import { presentClientResult } from './clientResult'
import { diagnosticErrorPayload } from './diagnostics'

describe('client failure presentation', () => {
  it('removes IPC wrappers and keeps useful validation messages', () => {
    expect(describeClientFailure(new Error("Error invoking remote method 'project:rename': Error: 项目名称不能为空"))).toBe('项目名称不能为空')
    expect(describeClientFailure(new Error('ENOENT: no such file or directory C:\\private\\project.json'))).toBe('找不到文件，请确认文件仍然存在。')
    expect(describeClientFailure('unexpected provider payload\n' + 'x'.repeat(300))).toBe('unexpected provider payload\n' + 'x'.repeat(300))
    expect(describeClientFailure('HTTP 503: <html>upstream unavailable</html>')).toBe('服务暂时不可用，请稍后重试。')
  })

  it('retains the unknown cause and request ID while redacting credentials, including after IPC presentation twice', () => {
    const raw = 'Unsupported tool schema\nrequest_id=req-123 api_key=private-value'
    const result = presentClientResult({ kind: 'error', content: raw }, 'ai:output', () => undefined)
    expect(result.content).toBe('Unsupported tool schema\nrequest_id=req-123 api_key=[REDACTED]')
    expect(describeClientFailure(result.content)).toBe(result.content)
    expect(describeClientFailure({ code: 'unsupported_model', message: 'This model cannot use tools' })).toBe('This model cannot use tools')
  })

  it('retains returned and streamed failure originals without changing state or logs', () => {
    const original = { activities: [{ id: 'one', status: 'failed', error: 'ECONNRESET: request-id=abc', detail: 'fetch failed for https://host.test/private' }], logs: [{ level: 'error', message: 'raw stack' }], successfulResult: { message: 'unmodified successful content' } }
    const records: unknown[] = []
    const result = presentClientResult(original, 'downloads:changed', (path, error) => records.push({ path, error }))
    expect(result.activities[0]).toEqual({ id: 'one', status: 'failed', error: '连接失败，请检查网络后重试。', detail: '连接失败，请检查网络后重试。' })
    expect(records).toContainEqual({ path: 'downloads:changed.activities[0].error', error: original.activities[0].error })
    expect(result.logs).toEqual(original.logs)
    expect(result.successfulResult).toEqual(original.successfulResult)
    expect(original.activities[0].error).toContain('request-id=abc')
    const action = { input: { error: 'user-authored data' }, settings: { error: 'user-authored setting' } }
    expect(presentClientResult(action, 'plugins:result', () => { throw new Error('Not a failure') })).toEqual(action)
  })

  it('preserves error causes, response bodies and request IDs across structured clone', () => {
    const error = Object.assign(new Error('provider failed'), { cause: { code: 'invalid_request', param: 'tools[0]', request_id: 'req-123' }, status: 400, responseBody: '{"error":"unsupported tool"}' })
    const payload = structuredClone(diagnosticErrorPayload(error))
    expect(payload).toMatchObject({ message: 'provider failed', stack: expect.any(String), details: { status: 400, responseBody: '{"error":"unsupported tool"}', cause: { request_id: 'req-123', param: 'tools[0]' } } })
  })
})
