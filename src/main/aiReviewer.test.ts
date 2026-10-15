vi.mock('./networkRequest', async (importOriginal) => ({ ...(await importOriginal<typeof import('./networkRequest')>()), networkFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init) }))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewAiAction, reviewAiCompletion } from './aiReviewer'

const project = { name: 'Review Test', path: 'C:/review-test', loader: 'fabric' as const, minecraftVersion: '1.21.1', namespace: 'review_test', createdAt: new Date().toISOString() }

afterEach(() => vi.unstubAllGlobals())

describe('AI review agent', () => {
  it('parses an approval decision from an OpenAI-compatible response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"approved":false,"complete":false,"risk":"high","feedback":"不要覆盖用户配置","dangerousOperations":["config"]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(reviewAiAction({ baseUrl: 'https://review.example/v1', apiKey: 'key', model: 'reviewer' }, { project, request: 'Add an item', action: 'apply_edits', input: { path: 'config/user.json' } })).resolves.toMatchObject({ approved: false, complete: false, risk: 'high', dangerousOperations: ['config'] })
  })

  it('keeps the task available when no reviewer credentials are configured', async () => {
    await expect(reviewAiCompletion(null, { project, request: 'Finish the item', changedFiles: [] })).resolves.toMatchObject({ approved: true, complete: true, unavailable: true })
  })

  it('retries a transient reviewer failure before accepting a remote decision', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"approved":true,"complete":true,"risk":"low","feedback":"ok","dangerousOperations":[]}' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)

    const decision = await reviewAiAction({ baseUrl: 'https://review.example/v1', apiKey: 'key', model: 'reviewer' }, { project, request: 'Add an item', action: 'apply_edits', input: { path: 'config/user.json' } })
    expect(decision).toMatchObject({ approved: true })
    expect(decision.unavailable).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('falls back to local rules and blocks project-boundary edits when the reviewer is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    await expect(reviewAiAction({ baseUrl: 'https://review.example/v1', apiKey: 'key', model: 'reviewer' }, { project, request: 'Edit config', action: 'apply_edits', input: { edits: [{ path: '../outside.txt', newText: 'blocked' }] } })).resolves.toMatchObject({ approved: false, fallback: 'local-rules', dangerousOperations: ['project-boundary path'] })
  })

  it('uses the per-task local fallback without issuing another network request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    await expect(reviewAiCompletion({ baseUrl: 'https://review.example/v1', apiKey: 'key', model: 'reviewer', forceLocalFallback: true }, { project, request: 'Finish the item', changedFiles: [] })).resolves.toMatchObject({ approved: true, complete: true, fallback: 'local-rules' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps Codex Auto-review independent when the local review runner is unavailable', async () => {
    await expect(reviewAiCompletion({ reviewMode: 'codex-auto' }, { project, request: 'Finish the item', changedFiles: [] }))
      .resolves.toMatchObject({ approved: true, complete: true, fallback: 'local-rules' })
  })
})
