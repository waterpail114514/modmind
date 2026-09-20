import { describe, expect, it } from 'vitest'
import { rawErrorText } from './rawError'

describe('raw error presentation', () => {
  it('preserves multiline messages, codes, URLs and paths instead of a generic fallback', () => {
    const message = 'Unsupported tool\ncode=unknown_protocol\nC:\\project\\config.json\nhttps://api.example.test/v1'
    expect(rawErrorText(new Error(message))).toBe(message)
    expect(rawErrorText({ code: 'unknown_protocol' })).toBe('{"code":"unknown_protocol"}')
  })
  it('redacts JSON secrets, authorization and URL credentials without removing the cause', () => {
    const message = 'Unexpected response {"apiKey":"sensitive-key"}\nAuthorization: Bearer sensitive-bearer\nhttps://alice:secret@api.example.test/v1?token=secret-token&request_id=req1'
    const output = rawErrorText(message)
    expect(output).toContain('Unexpected response')
    expect(output).toContain('request_id=req1')
    expect(output).not.toMatch(/sensitive-key|sensitive-bearer|alice:secret|secret-token/)
    expect(rawErrorText(output)).toBe(output)
  })
  it('handles empty and circular error payloads without inventing a task failure', () => {
    expect(rawErrorText(null)).toBe('未提供错误详情。')
    const value: Record<string, unknown> = {}; value.self = value
    expect(() => rawErrorText(value)).not.toThrow()
  })
})
