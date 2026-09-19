import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { CLAUDE_REQUIRED_FLAGS, claudeCompatibilityProblem, claudeFailureMessage, claudeHostedEnvironment, claudeSessionHome, fetchClaudeModels } from './claudeCompatibility'

afterEach(() => vi.unstubAllGlobals())

describe('Claude protocol compatibility', () => {
  const help = CLAUDE_REQUIRED_FLAGS.join('\n') + '\n choices: manual, dontAsk, plan'
  it('requires capabilities instead of relying on a release number or auto mode', () => {
    expect(claudeCompatibilityProblem(help)).toBeUndefined()
    expect(claudeCompatibilityProblem(help.replace('--strict-mcp-config', ''))).toContain('--strict-mcp-config')
    expect(claudeCompatibilityProblem(help.replace('dontAsk', 'auto'))).toContain('dontAsk')
    expect(claudeCompatibilityProblem(help, true)).toContain('--bare')
    expect(claudeCompatibilityProblem(help + '\n--bare', true)).toBeUndefined()
  })

  it('isolates hosted credentials without mutating inherited local settings', () => {
    const original = { ANTHROPIC_AUTH_TOKEN: 'local-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'local-home' }
    const env = { ...original, ...claudeHostedEnvironment({ apiKey: 'hosted-key', model: 'claude-test', baseUrl: 'https://example.com/gateway/v1/' }, 'isolated-home') }
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'hosted-key', ANTHROPIC_BASE_URL: 'https://example.com/gateway', CLAUDE_CONFIG_DIR: path.resolve('isolated-home') })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(original.ANTHROPIC_AUTH_TOKEN).toBe('local-token')
    expect(claudeSessionHome({ CLAUDE_CONFIG_DIR: 'custom-home' })).toBe(path.resolve('custom-home'))
  })

  it('keeps structured errors instead of losing the actual failure', () => {
    expect(claudeFailureMessage({ type: 'result', subtype: 'error_during_execution', errors: ['No conversation found with session ID abc'] })).toContain('session ID abc')
    expect(claudeFailureMessage({ type: 'result', subtype: 'success', result: 'done' })).toBe('')
  })

  it('uses Anthropic auth and follows model-list pagination', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'first' }], has_more: true, last_id: 'first' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'second' }], has_more: false })))
    vi.stubGlobal('fetch', fetcher)
    expect(await fetchClaudeModels('https://example.com/gateway/v1', 'key')).toEqual({ data: [{ id: 'first' }, { id: 'second' }] })
    expect(String(fetcher.mock.calls[0][0])).toContain('/gateway/v1/models')
    expect(String(fetcher.mock.calls[1][0])).toContain('after_id=first')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { 'x-api-key': 'key', 'anthropic-version': '2023-06-01' }, redirect: 'error' })
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('does not fall back to another protocol or leak credentials through redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchClaudeModels('https://example.com', 'key')).rejects.toThrow('HTTP 401')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
