export async function requestAiName(input: {
  prompt: string
  config: { baseUrl?: string; apiKey?: string; model?: string } | null
  model?: string
  runLocal?: () => Promise<string>
}): Promise<string> {
  const { config } = input
  if (config?.baseUrl && config.apiKey && config.model) {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.model || config.model, messages: [{ role: 'user', content: input.prompt }] }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error('AI naming request failed')
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI returned no name')
    return content
  }
  if (input.runLocal) {
    const content = await input.runLocal()
    if (!content.trim()) throw new Error('AI returned no name')
    return content
  }
  throw new Error('AI naming is unavailable')
}
