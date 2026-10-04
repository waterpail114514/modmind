import { createServer } from 'node:http'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { ChatCompletionsAdapter } from './chatCompletionsAdapter'
import { ModelImageCapabilities } from './modelImageCapabilities'
import { verifyModelImageInput } from './modelImageVerification'

async function readGrid(dataUrl: string): Promise<string[]> {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const colors: Record<string, string> = { '255,0,0': 'R', '0,255,0': 'G', '0,0,255': 'B', '255,255,0': 'Y' }
  return Array.from({ length: 9 }, (_, i) => {
    const pixel = ((Math.floor(i / 3) * 96 + 48) * info.width + i % 3 * 96 + 48) * info.channels
    return colors[Array.from(data.subarray(pixel, pixel + 3)).join(',')]
  })
}

describe('actual color-grid verification', () => {
  it.each(['responses', 'chat-completions'])('checks real image pixels through %s and overrides incorrect metadata', async protocol => {
    const store = new ModelImageCapabilities()
    const adapter = new ChatCompletionsAdapter(observation => store.observe(observation))
    const arrangements: string[][] = []
    const upstream = createServer((request, response) => { void (async () => {
      let raw = ''; for await (const chunk of request) raw += chunk
      if (protocol === 'chat-completions' && request.url === '/responses') {
        response.writeHead(404).end('{"error":{"message":"responses endpoint not found"}}'); return
      }
      const payload = JSON.parse(raw)
      const parts = protocol === 'responses' ? payload.input[0].content : payload.messages[0].content
      const image = parts.find((part: any) => part.type === (protocol === 'responses' ? 'input_image' : 'image_url'))
      const expected = await readGrid(protocol === 'responses' ? image.image_url : image.image_url.url)
      arrangements.push(expected)
      const text = JSON.stringify(expected)
      expect(parts[0].text).not.toContain(text)
      expect(payload.model).toBe('private-alias')
      if (protocol === 'chat-completions') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] })); return
      }
      response.setHeader('Content-Type', 'text/event-stream')
      const event = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }
      // Split the SSE JSON and delimiter across chunks, as real providers do.
      const sse = `data: ${JSON.stringify(event)}\r\n\r\n`
      response.write(sse.slice(0, 18)); response.write(sse.slice(18, -1)); response.end(sse.slice(-1))
    })().catch(error => response.destroy(error)) })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    const connection = { baseUrl, apiKey: 'fixture-key', model: 'private-alias' }
    try {
      await store.enrich([{ id: connection.model, imageInput: { status: 'unsupported', source: 'provider' } }], baseUrl, connection.apiKey)
      const url = await adapter.baseUrl(baseUrl)
      const send = (body: Record<string, unknown>, signal: AbortSignal) => fetch(`${url}/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${connection.apiKey}` }, body: JSON.stringify(body), signal
      })
      for (let i = 0; i < 2; i++) expect(await verifyModelImageInput(connection, store, send)).toMatchObject({ verified: true, imageInput: { status: 'supported', source: 'probe' } })
      expect(arrangements).toHaveLength(2)
      expect(store.resolve(baseUrl, connection.apiKey, connection.model).source).toBe('probe')
      expect(store.resolve(baseUrl, 'other-account', connection.model).status).toBe('unknown')
    } finally { adapter.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
  })

  it.each(['wrong', 'self-report', 'incomplete', 'network'])('does not confirm vision from %s', async mode => {
    const store = new ModelImageCapabilities()
    const connection = { baseUrl: 'https://relay.example/v1', apiKey: 'test', model: 'private-alias' }
    const result = await verifyModelImageInput(connection, store, async () => {
      if (mode === 'network') throw new Error('Network unavailable')
      if (mode === 'incomplete') return new Response('data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n')
      const text = mode === 'wrong' ? '[]' : 'I am a multimodal model and can see images'
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }))
    })
    expect(result.verified).toBe(false)
    expect(result.imageInput.status).toBe('unknown')
    expect(result.reason).toBeTruthy()
  })
  it('withdraws earlier recognition proof after an unsuccessful recheck without claiming no vision', async () => {
    const store = new ModelImageCapabilities()
    const connection = { baseUrl: 'https://relay.example/v1', apiKey: 'test', model: 'private-alias' }
    await store.verified(connection.baseUrl, connection.apiKey, connection.model)
    const result = await verifyModelImageInput(connection, store, async () => new Response(JSON.stringify({ status: 'completed', output_text: '[]' })))
    expect(result).toMatchObject({ verified: false, imageInput: { status: 'supported', source: 'request' } })
  })
})
