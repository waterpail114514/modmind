import { afterEach, expect, it, vi } from 'vitest'
import { requestAiName } from './aiNaming'

afterEach(() => vi.unstubAllGlobals())

it('shares the configured naming request while honoring model selection', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '{"namespace":"lightning_sword"}' } }] })))
  vi.stubGlobal('fetch', fetcher)
  const result = await requestAiName({ prompt: 'name this project', config: { baseUrl: 'https://naming.invalid/v1/', apiKey: 'test', model: 'default' }, model: 'selected' })
  expect(result).toBe('{"namespace":"lightning_sword"}')
  expect(fetcher.mock.calls[0][0]).toBe('https://naming.invalid/v1/chat/completions')
  expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ model: 'selected', messages: [{ role: 'user', content: 'name this project' }] })
})

it('supports the local naming runner and rejects unavailable or empty results', async () => {
  expect(await requestAiName({ prompt: 'title', config: null, runLocal: async () => 'A title' })).toBe('A title')
  await expect(requestAiName({ prompt: 'title', config: null })).rejects.toThrow('unavailable')
  await expect(requestAiName({ prompt: 'title', config: null, runLocal: async () => '' })).rejects.toThrow('no name')
})
