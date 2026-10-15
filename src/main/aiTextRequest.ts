import { networkFetch } from './networkRequest'
import { apiEndpoint } from './apiEndpoint'
import { shouldFallbackToResponses } from './chatCompletionsAdapter'

/** Shared text-only request for naming, reviews and remote routing. */
export async function requestAiTextResponse(
  config: { baseUrl: string; apiKey: string; model: string },
  messages: Array<{ role: string; content: string }>,
  options: { signal?: AbortSignal; reasoningEffort?: string; temperature?: number } = {}
): Promise<Response> {
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
  const common = { model: config.model, stream: false, ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) }
  const response = await networkFetch(apiEndpoint(config.baseUrl, 'chat/completions'), {
    method: 'POST', headers, signal: options.signal,
    body: JSON.stringify({ ...common, messages, ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}) })
  })
  if (response.ok || !shouldFallbackToResponses(response.status, await response.clone().text())) return response
  await response.body?.cancel()
  options.signal?.throwIfAborted()
  const fallback = await networkFetch(apiEndpoint(config.baseUrl, 'responses'), {
    method: 'POST', headers, signal: options.signal,
    body: JSON.stringify({ ...common, input: messages.map(message => ({ type: 'message', ...message })), ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}) })
  })
  if (!fallback.ok) return fallback
  const payload = await fallback.json() as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; error?: unknown; status?: string }
  if (payload.error || payload.status === 'failed' || payload.status === 'incomplete') throw new Error('AI 服务未完成请求')
  const content = payload.output_text ?? (payload.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('')
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
