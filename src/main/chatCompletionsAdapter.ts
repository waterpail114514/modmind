import { createHash, randomUUID } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

type JsonRecord = Record<string, unknown>
type UpstreamProtocol = 'unknown' | 'responses' | 'chat-completions'

interface AdapterRoute {
  id: string
  upstreamBaseUrl: string
  protocol: UpstreamProtocol
}

interface ChatToolDescriptor {
  chatName: string
  name: string
  kind: 'function' | 'custom'
  namespace?: string
}

export interface ChatCompletionTranslation {
  body: JsonRecord
  tools: Map<string, ChatToolDescriptor>
}

const MAX_REQUEST_BYTES = 128 * 1024 * 1024

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Chat Completions 上游必须使用 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('Chat Completions 上游不能在 URL 中包含账号密码')
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, suffix: 'responses' | 'chat/completions' | 'models'): string {
  return `${baseUrl.replace(/\/$/, '')}/${suffix}`
}

function uniqueChatToolName(preferred: string, used: Set<string>): string {
  const cleaned = preferred.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
  let candidate = cleaned.slice(0, 64)
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  const suffix = `_${createHash('sha256').update(preferred).digest('hex').slice(0, 8)}`
  candidate = `${cleaned.slice(0, 64 - suffix.length)}${suffix}`
  let index = 2
  while (used.has(candidate)) {
    const numberedSuffix = `${suffix}_${index++}`
    candidate = `${cleaned.slice(0, 64 - numberedSuffix.length)}${numberedSuffix}`
  }
  used.add(candidate)
  return candidate
}

function translateTools(value: unknown): { tools: JsonRecord[]; descriptors: Map<string, ChatToolDescriptor> } {
  if (!Array.isArray(value)) return { tools: [], descriptors: new Map() }
  const tools: JsonRecord[] = []
  const descriptors = new Map<string, ChatToolDescriptor>()
  const usedNames = new Set<string>()

  const addFunction = (source: JsonRecord, namespace?: string): void => {
    const name = typeof source.name === 'string' ? source.name : ''
    if (!name) return
    const preferred = namespace ? `${namespace}__${name}` : name
    const chatName = uniqueChatToolName(preferred, usedNames)
    descriptors.set(chatName, { chatName, name, kind: 'function', ...(namespace ? { namespace } : {}) })
    tools.push({
      type: 'function',
      function: {
        name: chatName,
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        parameters: isRecord(source.parameters) ? source.parameters : { type: 'object', properties: {} }
      }
    })
  }

  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (entry.type === 'function') {
      addFunction(entry)
      continue
    }
    if (entry.type === 'namespace' && typeof entry.name === 'string' && Array.isArray(entry.tools)) {
      for (const child of entry.tools) if (isRecord(child) && child.type === 'function') addFunction(child, entry.name)
      continue
    }
    if (entry.type === 'custom' && typeof entry.name === 'string') {
      const chatName = uniqueChatToolName(entry.name, usedNames)
      descriptors.set(chatName, { chatName, name: entry.name, kind: 'custom' })
      tools.push({
        type: 'function',
        function: {
          name: chatName,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw input for the tool.' } },
            required: ['input']
          }
        }
      })
    }
  }
  return { tools, descriptors }
}

function descriptorForResponseItem(item: JsonRecord, descriptors: Map<string, ChatToolDescriptor>): ChatToolDescriptor | undefined {
  const name = typeof item.name === 'string' ? item.name : ''
  const namespace = typeof item.namespace === 'string' ? item.namespace : undefined
  return [...descriptors.values()].find((descriptor) => descriptor.name === name && descriptor.namespace === namespace)
    ?? [...descriptors.values()].find((descriptor) => descriptor.name === name)
}

function messageContent(value: unknown): string | JsonRecord[] {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return stringValue(value)
  const parts: JsonRecord[] = []
  for (const part of value) {
    if (!isRecord(part)) continue
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'input_image' && typeof part.image_url === 'string') {
      parts.push({ type: 'image_url', image_url: { url: part.image_url, ...(typeof part.detail === 'string' ? { detail: part.detail } : {}) } })
    } else if (part.type === 'input_audio') {
      parts.push({ type: 'text', text: '[Audio input omitted by the Chat Completions compatibility adapter]' })
    }
  }
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => String(part.text ?? '')).join('')
  return parts
}

function appendAssistantToolCall(messages: JsonRecord[], item: JsonRecord, descriptor: ChatToolDescriptor): void {
  const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${randomUUID().replaceAll('-', '')}`
  const rawArguments = descriptor.kind === 'custom'
    ? JSON.stringify({ input: typeof item.input === 'string' ? item.input : stringValue(item.input) })
    : typeof item.arguments === 'string' ? item.arguments : stringValue(item.arguments || {})
  const toolCall = { id: callId, type: 'function', function: { name: descriptor.chatName, arguments: rawArguments } }
  const last = messages.at(-1)
  if (last?.role === 'assistant' && Array.isArray(last.tool_calls)) {
    last.tool_calls.push(toolCall)
  } else {
    messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
  }
}

function translateInput(input: unknown, descriptors: Map<string, ChatToolDescriptor>, instructions: unknown): JsonRecord[] {
  const messages: JsonRecord[] = []
  if (typeof instructions === 'string' && instructions.trim()) messages.push({ role: 'system', content: instructions })
  if (typeof input === 'string') return [...messages, { role: 'user', content: input }]
  if (!Array.isArray(input)) return messages

  for (const entry of input) {
    if (!isRecord(entry)) continue
    if (entry.type === 'message') {
      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'system' || entry.role === 'developer' ? 'system' : 'user'
      messages.push({ role, content: messageContent(entry.content) })
      continue
    }
    if (entry.type === 'function_call' || entry.type === 'custom_tool_call') {
      const descriptor = descriptorForResponseItem(entry, descriptors)
      if (descriptor) appendAssistantToolCall(messages, entry, descriptor)
      continue
    }
    if (entry.type === 'function_call_output' || entry.type === 'custom_tool_call_output') {
      const callId = typeof entry.call_id === 'string' ? entry.call_id : ''
      if (callId) messages.push({ role: 'tool', tool_call_id: callId, content: stringValue(entry.output) })
    }
  }
  return messages
}

export function responsesRequestToChatCompletions(value: unknown): ChatCompletionTranslation {
  if (!isRecord(value)) throw new Error('Responses 请求必须是 JSON 对象')
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!model) throw new Error('Responses 请求缺少模型名')
  const translatedTools = translateTools(value.tools)
  const body: JsonRecord = {
    model,
    messages: translateInput(value.input, translatedTools.descriptors, value.instructions),
    stream: false
  }
  if (translatedTools.tools.length) body.tools = translatedTools.tools
  // Codex can compute a negative remaining-token budget once a thread grows
  // past the model's context window; forwarding it as a negative max_tokens
  // makes providers reject the whole request with invalid_request_error.
  // Only finite positive budgets are worth sending at all.
  if (Number.isFinite(value.max_output_tokens) && (value.max_output_tokens as number) > 0) body.max_tokens = value.max_output_tokens
  if (Number.isFinite(value.max_completion_tokens) && (value.max_completion_tokens as number) > 0) body.max_completion_tokens = value.max_completion_tokens
  if (typeof value.frequency_penalty === 'number') body.frequency_penalty = value.frequency_penalty
  if (typeof value.presence_penalty === 'number') body.presence_penalty = value.presence_penalty
  if (typeof value.seed === 'number') body.seed = value.seed
  if (typeof value.stop === 'string' || Array.isArray(value.stop)) body.stop = value.stop
  if (value.tool_choice === 'auto' || value.tool_choice === 'none' || value.tool_choice === 'required') body.tool_choice = value.tool_choice
  else if (isRecord(value.tool_choice) && value.tool_choice.type === 'function' && typeof value.tool_choice.name === 'string') {
    const toolChoice = value.tool_choice
    const descriptor = [...translatedTools.descriptors.values()].find((item) => item.name === toolChoice.name)
    if (descriptor) body.tool_choice = { type: 'function', function: { name: descriptor.chatName } }
  }
  const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined
  if (reasoning && typeof reasoning.effort === 'string') body.reasoning_effort = reasoning.effort
  if (typeof value.temperature === 'number') body.temperature = value.temperature
  if (typeof value.top_p === 'number') body.top_p = value.top_p
  return { body, tools: translatedTools.descriptors }
}

function chatMessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('')
}

/**
 * Removes non-positive or non-finite token budgets from an agent request.
 * Codex derives max_output_tokens from the remaining context window, so a
 * long thread can yield a negative value; providers then reject the request
 * (invalid_request_error / 请求参数无效) even though the request is otherwise
 * fine. Unparseable bodies pass through untouched — the JSON error later in
 * the pipeline reports malformed input as before.
 */
export function sanitizeTokenBudgets(body: Buffer): Buffer {
  let parsed: unknown
  try { parsed = JSON.parse(body.toString('utf8')) as unknown } catch { return body }
  if (!isRecord(parsed)) return body
  const fields = ['max_tokens', 'max_output_tokens', 'max_completion_tokens']
  let changed = false
  for (const field of fields) {
    const value = parsed[field]
    if (typeof value === 'number' && !(Number.isFinite(value) && value > 0)) {
      delete parsed[field]
      changed = true
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed), 'utf8') : body
}

export function chatCompletionToResponsesEvents(value: unknown, tools: Map<string, ChatToolDescriptor>): JsonRecord[] {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) throw new Error('Chat Completions 上游返回了无效响应')
  const choice = value.choices[0]
  const message = isRecord(choice.message) ? choice.message : {}
  const responseId = typeof value.id === 'string' && value.id ? value.id : `resp_${randomUUID().replaceAll('-', '')}`
  const events: JsonRecord[] = [{ type: 'response.created', response: { id: responseId } }]
  const text = chatMessageText(message.content)
  if (text) {
    events.push({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', id: `msg_${randomUUID().replaceAll('-', '')}`, content: [{ type: 'output_text', text }] }
    })
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function) || typeof rawCall.function.name !== 'string') continue
    const descriptor = tools.get(rawCall.function.name)
    if (!descriptor) continue
    const callId = typeof rawCall.id === 'string' && rawCall.id ? rawCall.id : `call_${randomUUID().replaceAll('-', '')}`
    const rawArguments = typeof rawCall.function.arguments === 'string' ? rawCall.function.arguments : stringValue(rawCall.function.arguments || {})
    if (descriptor.kind === 'custom') {
      let input = rawArguments
      try {
        const parsed = JSON.parse(rawArguments) as unknown
        if (isRecord(parsed) && typeof parsed.input === 'string') input = parsed.input
      } catch { /* Keep the raw arguments as custom tool input. */ }
      events.push({ type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: callId, name: descriptor.name, input } })
    } else {
      events.push({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: callId,
          name: descriptor.name,
          arguments: rawArguments,
          ...(descriptor.namespace ? { namespace: descriptor.namespace } : {})
        }
      })
    }
  }
  if (!toolCalls.length && isRecord(message.function_call) && typeof message.function_call.name === 'string') {
    const descriptor = tools.get(message.function_call.name)
    if (descriptor) {
      events.push({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: `call_${randomUUID().replaceAll('-', '')}`,
          name: descriptor.name,
          arguments: typeof message.function_call.arguments === 'string' ? message.function_call.arguments : '{}',
          ...(descriptor.namespace ? { namespace: descriptor.namespace } : {})
        }
      })
    }
  }
  const usage = isRecord(value.usage) ? value.usage : {}
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
  events.push({
    type: 'response.completed',
    response: {
      id: responseId,
      end_turn: choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'function_call',
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: typeof completionDetails.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : 0 },
        total_tokens: totalTokens
      }
    }
  })
  return events
}

function requestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  const hopByHop = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'content-encoding'])
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (hopByHop.has(lower) || typeof value !== 'string' || !value) continue
    result[lower] = value
  }
  return result
}

function decompressRequest(body: Buffer, encoding: string | string[]): Buffer {
  const value = (Array.isArray(encoding) ? encoding[encoding.length - 1] : encoding).toLowerCase()
  try {
    if (value === 'gzip' || value === 'x-gzip') return gunzipSync(body)
    if (value === 'deflate') return inflateSync(body)
    if (value === 'br') return brotliDecompressSync(body)
    if (value === 'zstd') return zstdDecompressSync(body)
  } catch {
    throw new Error(`Agent 请求解压失败（${value}），内容可能已损坏`)
  }
  throw new Error(`暂不支持 ${value} 压缩的 Agent 请求`)
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('Agent 请求超过 128 MB 限制')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  for (const name of ['content-type', 'x-request-id', 'openai-model', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = upstream.headers.get(name)
    if (value) response.setHeader(name, value)
  }
}

async function relayResponse(upstream: Response, response: ServerResponse): Promise<void> {
  response.statusCode = upstream.status
  copyResponseHeaders(upstream, response)
  if (!upstream.body) {
    response.end()
    return
  }
  try {
    for await (const chunk of upstream.body) response.write(Buffer.from(chunk))
    response.end()
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

function shouldFallbackToChat(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 415 || status === 501) return true
  if (status !== 400 && status !== 422) return false
  if (/(?:\/v1\/responses|responses endpoint|chat completions)/i.test(body)
    && /(?:unsupported|not supported|not found|unknown|unrecognized|not implemented|does not exist|cannot post|only supports|use chat)/i.test(body)) return true
  if (/(?:responses?|endpoint|route|path|url)[\s\S]{0,100}(?:unsupported|not supported|not found|unknown|unrecognized|not implemented|does not exist)|(?:unsupported|not supported|not found|unknown|unrecognized|not implemented|does not exist)[\s\S]{0,100}(?:responses?|endpoint|route|path|url)/i.test(body)) return true
  // A number of OpenAI-compatible relays expose /responses but only accept a
  // Chat Completions-shaped subset. Their error is often deliberately vague,
  // so retry the same request through the local translator once. Authentication
  // and quota failures never reach this branch.
  return /invalid_request|invalid (?:api )?parameter|unsupported parameter|请求(?:格式|参数)无效|参数错误/i.test(body)
}

function shouldFallbackToResponses(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 415 || status === 501) return true
  if (status !== 400 && status !== 422) return false
  if (/(?:chat\/completions|chat completions endpoint|responses api)/i.test(body)
    && /(?:unsupported|not supported|not found|unknown|unrecognized|not implemented|does not exist|cannot post|only supports|use responses)/i.test(body)) return true
  return /invalid_request|invalid (?:api )?parameter|unsupported parameter|请求(?:格式|参数)无效|参数错误/i.test(body)
}

function sseBody(events: JsonRecord[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

export class ChatCompletionsAdapter {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private port = 0
  private readonly routesByIdentity = new Map<string, AdapterRoute>()
  private readonly routesById = new Map<string, AdapterRoute>()

  async baseUrl(upstreamBaseUrl: string, providerIdentity = ''): Promise<string> {
    const normalized = normalizedBaseUrl(upstreamBaseUrl)
    const port = await this.ensureListening()
    const identity = createHash('sha256').update(`${normalized}\n${providerIdentity}`).digest('hex')
    let route = this.routesByIdentity.get(identity)
    if (!route) {
      route = { id: randomUUID().replaceAll('-', ''), upstreamBaseUrl: normalized, protocol: 'unknown' }
      this.routesByIdentity.set(identity, route)
      this.routesById.set(route.id, route)
    }
    return `http://127.0.0.1:${port}/adapter/${route.id}/v1`
  }

  close(): void {
    this.server?.close()
    this.server = null
    this.starting = null
    this.port = 0
    this.routesByIdentity.clear()
    this.routesById.clear()
  }

  private async ensureListening(): Promise<number> {
    if (this.server && this.port) return this.port
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('无法读取 Chat Completions 适配器端口'))
        server.removeListener('error', reject)
        server.on('error', (error) => console.error('[chat-completions-adapter] server error', error))
        server.unref()
        this.server = server
        this.port = address.port
        resolve(address.port)
      })
    }).finally(() => { this.starting = null })
    return this.starting
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const match = /^\/adapter\/([a-f0-9]+)\/v1\/(responses|models)$/.exec(url.pathname)
      const route = match ? this.routesById.get(match[1]) : undefined
      if (!route || !match) {
        sendJson(response, 404, { error: { message: 'Adapter route not found', type: 'invalid_request_error' } })
        return
      }
      if (match[2] === 'models' && request.method === 'GET') {
        const upstream = await fetch(endpoint(route.upstreamBaseUrl, 'models'), { headers: requestHeaders(request.headers), signal: AbortSignal.timeout(20_000) })
        return void await relayResponse(upstream, response)
      }
      if (match[2] !== 'responses' || request.method !== 'POST') {
        sendJson(response, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } })
        return
      }
      const binaryBody = await readBody(request)
      let body: Buffer
      const contentEncoding = request.headers['content-encoding']
      if (contentEncoding) {
        try {
          body = decompressRequest(binaryBody, contentEncoding)
        } catch (error) {
          const detail = error instanceof Error ? error.message : '压缩的 Agent 请求暂不支持自动协议适配'
          sendJson(response, 415, { error: { message: detail, type: 'invalid_request_error' } })
          return
        }
      } else {
        body = binaryBody
      }
      // Strip invalid token budgets (negative/NaN) on every path — including
      // native Responses passthrough — so one bad field cannot make the
      // provider reject an otherwise valid request.
      const sanitizedBody = sanitizeTokenBudgets(body)
      const requestUpstreamResponses = (): Promise<Response> => fetch(endpoint(route.upstreamBaseUrl, 'responses'), {
        method: 'POST',
        headers: requestHeaders(request.headers),
        body: new Uint8Array(sanitizedBody),
        signal: AbortSignal.timeout(300_000)
      })
      let translated: ChatCompletionTranslation | undefined
      const requestUpstreamChat = (): Promise<Response> => {
        translated ??= responsesRequestToChatCompletions(JSON.parse(sanitizedBody.toString('utf8')) as unknown)
        return fetch(endpoint(route.upstreamBaseUrl, 'chat/completions'), {
          method: 'POST',
          headers: requestHeaders(request.headers),
          body: JSON.stringify(translated.body),
          signal: AbortSignal.timeout(300_000)
        })
      }

      // Prefer the last successful protocol, but re-probe the alternative when
      // the relay reports an endpoint/request-shape incompatibility. Provider
      // switches often keep the same public Base URL while changing protocol.
      if (route.protocol === 'chat-completions') {
        const chat = await requestUpstreamChat()
        if (chat.ok) {
          const payload = await chat.json() as unknown
          const output = sseBody(chatCompletionToResponsesEvents(payload, translated!.tools))
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          response.end(output)
          return
        }
        const errorBody = await chat.text()
        if (!shouldFallbackToResponses(chat.status, errorBody)) {
          response.statusCode = chat.status
          copyResponseHeaders(chat, response)
          response.end(errorBody)
          return
        }
        const upstream = await requestUpstreamResponses()
        if (upstream.ok) {
          route.protocol = 'responses'
          return void await relayResponse(upstream, response)
        }
        await relayResponse(upstream, response)
        return
      }

      const upstreamResponses = await requestUpstreamResponses()
      if (upstreamResponses.ok) {
        route.protocol = 'responses'
        return void await relayResponse(upstreamResponses, response)
      }
      const errorBody = await upstreamResponses.text()
      if (!shouldFallbackToChat(upstreamResponses.status, errorBody)) {
        response.statusCode = upstreamResponses.status
        copyResponseHeaders(upstreamResponses, response)
        response.end(errorBody)
        return
      }

      const upstream = await requestUpstreamChat()
      if (!upstream.ok) {
        await relayResponse(upstream, response)
        return
      }
      route.protocol = 'chat-completions'
      const payload = await upstream.json() as unknown
      const output = sseBody(chatCompletionToResponsesEvents(payload, translated!.tools))
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.end(output)
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      sendJson(response, 502, { error: { message: error instanceof Error ? error.message : String(error), type: 'adapter_error' } })
    }
  }
}
