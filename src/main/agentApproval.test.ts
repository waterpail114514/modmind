import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexApprovalPolicy, normalizeAgentApprovalMode } from '../shared/agentApproval'
import { fetchWithApprovalModelFallback, isAutomaticApprovalFailure } from './agentApproval'

afterEach(() => vi.unstubAllGlobals())

describe('approval policy', () => {
  it('defaults old or invalid settings to automatic review and keeps YOLO read-only tasks restricted', () => {
    for (const value of [undefined, null, '', 'never', {}]) expect(normalizeAgentApprovalMode(value)).toBe('auto-review')
    expect(codexApprovalPolicy(false, 'yolo')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(codexApprovalPolicy(true, 'yolo')).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' })
  })

  it('distinguishes service failure from a risk denial or an echoed command', () => {
    expect(isAutomaticApprovalFailure('This action was rejected due to unacceptable risk.\nReason: Automatic approval review failed: stream disconnected before completion')).toBe(true)
    expect(isAutomaticApprovalFailure('Reason: This command deletes unrelated files')).toBe(false)
    expect(isAutomaticApprovalFailure('echo "Automatic approval review failed: stream disconnected"')).toBe(false)
  })

  it.each([404, 503])('uses the selected model for unavailable dedicated review requests (%s)', async (status) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"code":"model_not_found"}}', { status }))
      .mockResolvedValueOnce(new Response('{"approved":false}'))
    vi.stubGlobal('fetch', fetcher)
    const body = { model: 'codex-auto-review', input: 'review the operation', text: { format: { type: 'json_schema' } } }
    const response = await fetchWithApprovalModelFallback('https://provider.test/responses', {}, body, 'selected-model')
    expect(await response.json()).toEqual({ approved: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...body, model: 'selected-model' })
    expect(body.model).toBe('codex-auto-review')
  })

  it.each([
    ['coding-model', 503, 'unavailable'],
    ['codex-auto-review', 401, 'invalid key'],
    ['codex-auto-review', 403, 'account suspended'],
    ['codex-auto-review', 404, 'endpoint not found'],
    ['codex-auto-review', 200, '{"approved":false}']
  ])('does not replace %s for status %s: %s', async (model, status, message) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(message, { status }))
    vi.stubGlobal('fetch', fetcher)
    await fetchWithApprovalModelFallback('https://provider.test/responses', {}, { model }, 'selected-model')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('tries only one fallback and preserves its failure', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    expect((await fetchWithApprovalModelFallback('https://provider.test/responses', {}, { model: 'codex-auto-review' }, 'selected-model')).status).toBe(503)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
