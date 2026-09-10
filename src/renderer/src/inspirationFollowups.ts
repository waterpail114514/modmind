export const INSPIRATION_FOLLOWUPS_INSTRUCTION = `在最终回答末尾，基于本次回答为用户提出恰好三个不同的后续提问，供用户点击继续讨论。
每项是可以直接发送的中文提问，简洁具体，不超过60字，保持只读讨论，不承诺修改项目。不要重复本次已经解答的问题。
先正常回答，再另起一行严格附加以下格式（JSON 字符串数组，不要使用代码围栏或额外解释）：
<modmind-followups>["后续提问一", "后续提问二", "后续提问三"]</modmind-followups>`

/** Keep the model's appendix in durable history, render only validated options as controls. */
export function splitInspirationFollowups(text: string): { content: string; options: string[] } {
  const marker = '<modmind-followups>'
  const start = text.lastIndexOf(marker)
  if (start < 0) {
    // Avoid flashing an unfinished protocol tag during streaming.
    const partial = text.lastIndexOf('<')
    return { content: partial >= 0 && marker.startsWith(text.slice(partial)) ? text.slice(0, partial).trimEnd() : text, options: [] }
  }
  const content = text.slice(0, start).trimEnd()
  const end = text.indexOf('</modmind-followups>', start + marker.length)
  if (end < 0) return { content, options: [] }
  const json = text.slice(start + marker.length, end)
  if (json.length > 2_000) return { content, options: [] }
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 120)) return { content, options: [] }
    const options = parsed.map((value: string) => value.trim())
    return { content, options: new Set(options).size === 3 ? options : [] }
  } catch { return { content, options: [] } }
}
