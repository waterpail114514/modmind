import { createServer, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { requestAiTextResponse } from './aiTextRequest'
import { apiEndpoint } from './apiEndpoint'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })

it('keeps query parameters after the route and removes fragments', () => {
  expect(apiEndpoint('https://provider.test/v1/?api-version=2026#models', 'responses')).toBe('https://provider.test/v1/responses?api-version=2026')
})

it.each([true, false])('supports text helpers on a responses-only provider (responsesOnly=%s)', async responsesOnly => {
  const requests: Array<{ url: string; body: any }> = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    requests.push({ url: request.url!, body: JSON.parse(body) })
    if (responsesOnly && request.url?.includes('/chat/completions')) { response.writeHead(404); response.end('use responses'); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(responsesOnly ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '可用的结果' }] }] } : { choices: [{ message: { content: '可用的结果' } }] }))
  })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1?revision=1#ignored`
  const result = await requestAiTextResponse({ baseUrl, apiKey: 'fixture', model: 'selected' }, [{ role: 'user', content: 'name' }], { reasoningEffort: 'high', signal: AbortSignal.timeout(5_000) })
  expect(await result.json()).toMatchObject({ choices: [{ message: { content: '可用的结果' } }] })
  expect(requests.map(item => item.url)).toEqual(responsesOnly ? ['/v1/chat/completions?revision=1', '/v1/responses?revision=1'] : ['/v1/chat/completions?revision=1'])
  if (responsesOnly) expect(requests[1].body).toMatchObject({ reasoning: { effort: 'high' }, input: [{ type: 'message', role: 'user', content: 'name' }] })
})
