import { createServer } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatCompletionsAdapter, chatCompletionToResponsesEvents, decompressRequest, normalizeHistoryMessageIds, normalizeResponsesTools, responsesRequestToChatCompletions, sanitizeTokenBudgets } from './chatCompletionsAdapter'

const adapters: ChatCompletionsAdapter[] = []

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close()
})

describe('Chat Completions compatibility adapter', () => {
  const nativeTools = { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'exec', description: 'Call tools from ALL_TOOLS', format: { type: 'text' } },
    { type: 'function', name: 'wait', parameters: { type: 'object', properties: { cell_id: { type: 'string' } } } }
  ] }] }

  it('preserves namespaced custom tools and their results across a resumed Chat Completions turn', () => {
    const code = 'text(await tools.mcp__modmind__modmind_web_read({url:"https://example.org"}))'
    const request = { model: 'test', input: [nativeTools,
      { type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'call-web', input: code },
      { type: 'custom_tool_call_output', call_id: 'call-web', output: 'Retrieved official page' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }
    ] }
    const translated = responsesRequestToChatCompletions(request)
    expect(translated.body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'functions__exec' }) })]))
    expect(translated.body.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-web', type: 'function', function: { name: 'functions__exec', arguments: JSON.stringify({ input: code }) } }] },
      { role: 'tool', tool_call_id: 'call-web', content: 'Retrieved official page' },
      { role: 'user', content: 'Continue' }
    ])
    const events = chatCompletionToResponsesEvents({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call-next', function: { name: 'functions__exec', arguments: JSON.stringify({ input: code }) } }] } }] }, translated.tools)
    expect(events).toContainEqual({ type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'call-next', namespace: 'functions', name: 'exec', input: code } })
  })

  it('merges repeated tool declarations without duplicating names or mutating history', () => {
    const updated = { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'Updated catalog' }] }] }
    const request = { model: 'test', input: [nativeTools, updated], tools: [{ type: 'function', name: 'lookup', parameters: {} }] }
    const result = normalizeResponsesTools(request)
    expect(result.tools).toMatchObject([{ name: 'lookup' }, { name: 'functions', tools: [{ name: 'exec', description: 'Updated catalog' }, { name: 'wait' }] }])
    expect(result.input).toEqual([])
    expect(request.input).toHaveLength(2)
    expect(normalizeResponsesTools(result)).toEqual(result)
  })

  it.each(['responses', 'chat-completions'])('sends native input tool declarations to the upstream (%s)', async protocol => {
    const received: Record<string, unknown>[] = []
    const upstream = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      response.setHeader('Content-Type', 'application/json')
      if (protocol === 'chat-completions' && request.url === '/responses') { response.writeHead(404).end('{"error":{"message":"responses endpoint not found"}}'); return }
      received.push(body)
      response.end(protocol === 'responses' ? '{"output":[]}' : '{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const adapter = new ChatCompletionsAdapter(); adapters.push(adapter)
      const base = await adapter.baseUrl(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`)
      for (let turn = 0; turn < 2; turn++) {
        const response = await fetch(`${base}/responses`, { method: 'POST', body: JSON.stringify({ model: 'test', input: [nativeTools, { type: 'message', role: 'user', content: 'read a webpage' }] }) })
        expect(response.ok).toBe(true); await response.text()
      }
      expect(received).toHaveLength(2)
      for (const body of received) {
        expect(body.tools).toEqual(expect.arrayContaining([protocol === 'responses'
          ? expect.objectContaining({ name: 'functions', tools: expect.arrayContaining([expect.objectContaining({ type: 'custom', name: 'exec' })]) })
          : expect.objectContaining({ function: expect.objectContaining({ name: 'functions__exec' }) })]))
        expect(JSON.stringify(body.input ?? body.messages)).not.toContain('additional_tools')
      }
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
  })

  it.each(['responses', 'chat-completions'])('binds resumed requests to the new group model with the same key (%s)', async (protocol) => {
    let availableModel = 'gpt-6-astra'
    const received: Array<{ model: string; authorization: string | undefined; input: unknown }> = []
    const upstream = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      response.setHeader('Content-Type', 'application/json')
      if (protocol === 'chat-completions' && request.url === '/responses') {
        response.writeHead(404)
        response.end('{"error":{"message":"responses endpoint not found"}}')
        return
      }
      received.push({ model: body.model, authorization: request.headers.authorization, input: body.input ?? body.messages })
      if (body.model !== availableModel) {
        response.writeHead(404)
        response.end(JSON.stringify({ error: { message: `Model "${body.model}" is not supported by any configured account in this group` } }))
        return
      }
      response.end(protocol === 'responses' ? JSON.stringify({ output: 'ok' }) : JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address() as { port: number }
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const send = async (url: string) => {
        const response = await fetch(`${url}/responses`, {
          method: 'POST', headers: { Authorization: 'Bearer unchanged-key' },
          body: JSON.stringify({ model: 'gpt-6-astra', input: 'continue existing work' })
        })
        await response.text()
        expect(response.status).toBe(200)
      }
      const first = await adapter.baseUrl(`http://127.0.0.1:${address.port}`, 'same-key', undefined, undefined, availableModel)
      await send(first)
      availableModel = 'grok-4.5'
      const second = await adapter.baseUrl(`http://127.0.0.1:${address.port}`, 'same-key', undefined, undefined, availableModel)
      expect(second).not.toBe(first)
      await send(second)
      await send(second) // Also exercise the cached protocol with stale CLI model metadata.
      expect(received.map(x => x.model)).toEqual(['gpt-6-astra', 'grok-4.5', 'grok-4.5'])
      expect(received.every(x => x.authorization === 'Bearer unchanged-key')).toBe(true)
      expect(received[1].input).toEqual(received[0].input)
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('falls back only the dedicated approval model through both upstream protocols', async () => {
    const models: string[] = []
    const upstream = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      models.push(`${request.url}:${body.model}`)
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/responses') {
        response.writeHead(404)
        response.end('{"error":{"message":"responses endpoint not found"}}')
      } else if (body.model === 'codex-auto-review') {
        response.writeHead(404)
        response.end('{"error":{"code":"model_not_found"}}')
      } else {
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"approved":false}' } }] }))
      }
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const url = await adapter.baseUrl(`http://127.0.0.1:${address.port}`, 'review', undefined, 'selected-model', 'selected-model')
      const result = await fetch(`${url}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'codex-auto-review', input: 'Review this operation' })
      })
      expect(result.status).toBe(200)
      expect(await result.text()).toContain('approved')
      expect(models).toEqual(['/responses:codex-auto-review', '/chat/completions:codex-auto-review', '/chat/completions:selected-model'])
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    }
  })

  it('normalizes foreign message ids and references without changing tool call identity or text', () => {
    const body = Buffer.from(JSON.stringify({ model: 'qwen', input: [
      { type: 'message', id: 'item_foreign', role: 'assistant', content: [{ type: 'output_text', text: 'item_foreign' }] },
      { type: 'item_reference', id: 'item_foreign' },
      { type: 'function_call', id: 'item_tool', call_id: 'call_a', name: 'write', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'written once' },
      { type: 'message', id: 'msg_existing', role: 'user', content: 'continue' }
    ] }))
    const normalized = normalizeHistoryMessageIds(body)
    const parsed = JSON.parse(normalized.toString())
    expect(parsed.input[0].id).toMatch(/^msg_[a-f0-9]{32}$/)
    expect(parsed.input[1].id).toBe(parsed.input[0].id)
    expect(parsed.input[0].content[0].text).toBe('item_foreign')
    expect(parsed.input.slice(2)).toEqual(JSON.parse(body.toString()).input.slice(2))
    expect(normalizeHistoryMessageIds(normalized)).toEqual(normalized)
    expect(body.toString()).toContain('"id":"item_foreign"')
  })

  it('cancels old upstream work and rejects later requests on an invalidated route', async () => {
    let received!: () => void
    const started = new Promise<void>(resolve => { received = resolve })
    let disconnected!: () => void
    const closed = new Promise<void>(resolve => { disconnected = resolve })
    let requests = 0
    const upstream = createServer((request, response) => {
      requests++
      request.resume()
      response.once('close', disconnected)
      received()
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const adapter = new ChatCompletionsAdapter()
    adapters.push(adapter)
    const controller = new AbortController()
    try {
      const address = upstream.address() as { port: number }
      const base = await adapter.baseUrl(`http://127.0.0.1:${address.port}`, 'A', controller.signal)
      const pending = fetch(`${base}/responses`, { method: 'POST', body: JSON.stringify({ model: 'A', input: 'test' }) })
      await started
      controller.abort()
      const result = await pending
      await result.text()
      await closed
      expect((await fetch(`${base}/responses`, { method: 'POST', body: '{}' })).status).toBe(409)
      expect(requests).toBe(1)
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
  })
  it('drops invalid token budgets instead of forwarding them to the provider', () => {
    // A long Codex thread can compute a negative remaining budget; forwarding
    // it makes providers reject the whole request with invalid_request_error.
    const negative = responsesRequestToChatCompletions({ model: 'm', input: 'hi', max_output_tokens: -3721 })
    expect(negative.body.max_tokens).toBeUndefined()
    expect(sanitizeTokenBudgets(Buffer.from(JSON.stringify({ model: 'm', max_tokens: -5, max_output_tokens: 0 }))).toString('utf8'))
      .toBe('{"model":"m"}')
    // NaN and Infinity arrive as JSON null via typeof checks, so they simply
    // do not match the positive-number guard; valid budgets pass through.
    expect(responsesRequestToChatCompletions({ model: 'm', input: 'hi', max_output_tokens: 4096 }).body.max_tokens).toBe(4096)
    expect(sanitizeTokenBudgets(Buffer.from('not json'))).toBeDefined()
    const untouched = Buffer.from(JSON.stringify({ model: 'm', max_tokens: 128 }))
    expect(sanitizeTokenBudgets(untouched).equals(untouched)).toBe(true)
  })

  it('translates Responses messages and namespace tools to Chat Completions', () => {
    const translated = responsesRequestToChatCompletions({
      model: 'test-model',
      instructions: 'Be concise.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] }
      ],
      tools: [{
        type: 'namespace',
        name: 'modmind',
        tools: [{ type: 'function', name: 'list_files', description: 'List project files', parameters: { type: 'object', properties: {} } }]
      }]
    })
    expect(translated.body).toMatchObject({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'List files' }
      ],
      tools: [{ type: 'function', function: { name: 'modmind__list_files', description: 'List project files' } }]
    })
    expect(translated.tools.get('modmind__list_files')).toMatchObject({ name: 'list_files', namespace: 'modmind' })
  })

  it('translates Chat Completions text and tool calls back to Responses events', () => {
    const tools = new Map([
      ['read_file', { chatName: 'read_file', name: 'read_file', kind: 'function' as const }]
    ])
    const events = chatCompletionToResponsesEvents({
      id: 'chatcmpl-1',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'I will inspect it.',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
        }
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }, tools)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ type: 'message' }) }),
      expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'read_file' }) }),
      expect.objectContaining({ type: 'response.completed', response: expect.objectContaining({ usage: expect.objectContaining({ total_tokens: 7 }) }) })
    ]))
  })

  it('decompresses Node 20 codecs and a static zstd frame', async () => {
    const payload = Buffer.from('{"model":"m","input":"hi"}')
    await expect(decompressRequest(gzipSync(payload), 'gzip')).resolves.toEqual(payload)
    await expect(decompressRequest(deflateSync(payload), 'deflate')).resolves.toEqual(payload)
    await expect(decompressRequest(brotliCompressSync(payload), 'br')).resolves.toEqual(payload)
    const zstdFixture = Buffer.from('KLUv/SAa0QAAeyJtb2RlbCI6Im0iLCJpbnB1dCI6ImhpIn0=', 'base64')
    await expect(decompressRequest(zstdFixture, 'zstd')).resolves.toEqual(payload)
  })

  it('rejects unsupported, corrupt, and oversized decompressed requests', async () => {
    await expect(decompressRequest(Buffer.from('bad'), 'snappy')).rejects.toThrow(/暂不支持 snappy/)
    await expect(decompressRequest(Buffer.from('bad'), 'gzip')).rejects.toThrow(/解压失败/)
    await expect(decompressRequest(gzipSync(Buffer.alloc(512)), 'gzip', 64)).rejects.toThrow(/解压后超过/)
  })

  it('falls back from an unsupported Responses endpoint and caches the Chat protocol', async () => {
    let chatRequests = 0
    let receivedBody: Record<string, unknown> | undefined
    let receivedContentType = ''
    const upstream = createServer((request, response) => {
      if (request.url === '/responses') {
        receivedContentType = request.headers['content-type'] ?? ''
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'The /responses endpoint is not supported' } }))
        return
      }
      if (request.url === '/chat/completions') {
        chatRequests += 1
        const chunks: Buffer[] = []
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
          receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }))
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`)
      const request = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] })
      })
      const stream = await request.text()
      expect(request.status).toBe(200)
      expect(stream).toContain('response.output_item.done')
      expect(stream).toContain('ok')
      expect(chatRequests).toBe(1)
      expect(receivedContentType).toBe('application/json')
      expect(receivedBody).toMatchObject({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false })

      const second = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', input: 'again' })
      })
      expect(second.status).toBe(200)
      expect(chatRequests).toBe(2)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('re-probes a cached Responses route after a later 404', async () => {
    let responsesRequests = 0
    let chatRequests = 0
    const upstream = createServer((request, response) => {
      if (request.url === '/responses') {
        responsesRequests += 1
        response.writeHead(responsesRequests === 1 ? 200 : 404, { 'Content-Type': 'application/json' })
        response.end(responsesRequests === 1
          ? 'data: {"type":"response.completed","response":{"id":"first"}}\n\ndata: [DONE]\n\n'
          : JSON.stringify({ error: { message: 'route not found' } }))
        return
      }
      if (request.url === '/chat/completions') {
        chatRequests += 1
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }] }))
        return
      }
      response.writeHead(404); response.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`)
      const send = () => fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', input: 'hi' })
      })
      expect((await send()).status).toBe(200)
      expect(await (await send()).text()).toContain('recovered')
      expect(responsesRequests).toBe(2)
      expect(chatRequests).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('accepts zstd requests through the adapter on the Electron-compatible decoder', async () => {
    let receivedBody = ''
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: {"type":"response.completed","response":{"id":"zstd-ok"}}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`)
      const zstdFixture = Buffer.from('KLUv/SAa0QAAeyJtb2RlbCI6Im0iLCJpbnB1dCI6ImhpIn0=', 'base64')
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'zstd' }, body: zstdFixture
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('zstd-ok')
      expect(receivedBody).toBe('{"model":"m","input":"hi"}')
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('does not treat a generic 415 media-type error as a protocol switch', async () => {
    let chatRequests = 0
    const upstream = createServer((request, response) => {
      if (request.url === '/responses') {
        response.writeHead(415, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Expected request with Content-Type: application/json' } }))
        return
      }
      if (request.url === '/chat/completions') chatRequests += 1
      response.writeHead(500); response.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`)
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"m","input":"hi"}'
      })
      expect(response.status).toBe(415)
      expect(chatRequests).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('re-probes a cached Chat route when the provider switches to Responses', async () => {
    let chatRequests = 0
    let responsesRequests = 0
    const upstream = createServer((request, response) => {
      if (request.url === '/responses') {
        responsesRequests += 1
        response.writeHead(responsesRequests === 1 ? 404 : 200, { 'Content-Type': responsesRequests === 1 ? 'application/json' : 'text/event-stream' })
        response.end(responsesRequests === 1
          ? JSON.stringify({ error: { message: 'responses endpoint not supported' } })
          : 'data: {"type":"response.completed","response":{"id":"switched"}}\n\ndata: [DONE]\n\n')
        return
      }
      if (request.url === '/chat/completions') {
        chatRequests += 1
        if (chatRequests === 1) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'chat-first' } }] }))
        } else {
          response.writeHead(404, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'chat completions endpoint not supported; use responses' } }))
        }
        return
      }
      response.writeHead(404); response.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`, 'provider-a')
      const send = () => fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', input: 'hi' })
      })
      expect(await (await send()).text()).toContain('chat-first')
      expect(await (await send()).text()).toContain('switched')
      expect(chatRequests).toBe(2)
      expect(responsesRequests).toBe(2)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('isolates protocol routes by provider identity', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const upstreamUrl = `http://127.0.0.1:${address.port}`
      const first = await adapter.baseUrl(upstreamUrl, 'key-a:model-a')
      const repeated = await adapter.baseUrl(upstreamUrl, 'key-a:model-a')
      const switched = await adapter.baseUrl(upstreamUrl, 'key-b:model-b')
      expect(repeated).toBe(first)
      expect(switched).not.toBe(first)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('falls back when a Responses relay returns a generic invalid-parameter error', async () => {
    let chatRequests = 0
    const upstream = createServer((request, response) => {
      if (request.url === '/responses') {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid API parameter' } }))
        return
      }
      if (request.url === '/chat/completions') {
        chatRequests += 1
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'compatible' } }] }))
        return
      }
      response.writeHead(404); response.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const adapter = new ChatCompletionsAdapter()
      adapters.push(adapter)
      const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${address.port}`)
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', input: 'hi' })
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('compatible')
      expect(chatRequests).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })
})
