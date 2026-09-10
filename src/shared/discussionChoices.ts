export interface DiscussionChoice {
  label: string
  prompt: string
  action: 'discussion' | 'engineering'
}

export const DISCUSSION_CHOICES_INSTRUCTION = `最终回答末尾必须给出恰好三个可点击选项，选项由你根据当前问题生成。
需要用户补充信息时，提供三个具体回答或不同方向，prompt 是用户选择后发送的完整中文内容，包含明确的版本、平台或类型，不能只写“第一个”。
方案已明确且用户可以动工时，最多一个选项可以是“按这个方案制作”，action 为 engineering，prompt 明确表达用户确认实施哪一个方案；其余选项继续讨论，action 为 discussion。不要将咨询、比较、推荐、补充信息标记为 engineering。
不要在正文重复列出同一组选项，不要另加独立的开始制作提示。先正常回答，再另起一行追加以下 JSON，不要代码围栏：
<modmind-choices>[{"label":"简短选项名称","prompt":"完整用户回复","action":"discussion"},{"label":"另一个选项","prompt":"完整用户回复","action":"discussion"},{"label":"第三个选项","prompt":"完整用户回复","action":"discussion"}]</modmind-choices>
label 不超过24字，prompt 不超过300字。三个选项必须不同。`

export function splitDiscussionChoices(text: string): { content: string; choices: DiscussionChoice[] } {
  for (const tag of ['modmind-choices', 'modmind-followups']) {
    const marker = `<${tag}>`
    const start = text.lastIndexOf(marker)
    if (start < 0) continue
    const content = text.slice(0, start).trimEnd()
    const end = text.indexOf(`</${tag}>`, start + marker.length)
    if (end < 0) return { content, choices: [] }
    const raw = text.slice(start + marker.length, end)
    if (raw.length > 5000) return { content, choices: [] }
    try {
      const values: unknown = JSON.parse(raw)
      if (!Array.isArray(values) || values.length !== 3) return { content, choices: [] }
      const choices: DiscussionChoice[] = []
      for (const value of values) {
        const item = typeof value === 'string' ? { label: value, prompt: value, action: 'discussion' } : value
        if (!item || typeof item.label !== 'string' || typeof item.prompt !== 'string' || !['discussion', 'engineering'].includes(item.action)) return { content, choices: [] }
        const label = item.label.trim(), prompt = item.prompt.trim()
        if (!label || label.length > 120 || !prompt || prompt.length > 600) return { content, choices: [] }
        // Engineering can only come from a typed choice with visible implementation wording.
        const action = item.action === 'engineering' && /制作|实现|实施|开工|动工|生成工程/.test(label) ? 'engineering' : 'discussion'
        choices.push({ label, prompt, action })
      }
      if (new Set(choices.map(item => item.label)).size !== 3 || new Set(choices.map(item => item.prompt)).size !== 3 || choices.filter(item => item.action === 'engineering').length > 1) return { content, choices: [] }
      return { content, choices }
    } catch { return { content, choices: [] } }
  }
  const partial = text.lastIndexOf('<')
  if (partial >= 0 && ['<modmind-choices>', '<modmind-followups>'].some(marker => marker.startsWith(text.slice(partial)))) return { content: text.slice(0, partial).trimEnd(), choices: [] }
  // Older replies used a trailing numbered choice list. Never infer engineering permission from it.
  const legacy = text.match(/(?:^|\n)((?:\s*(?:[1-3][.、)]|[A-C][.、)])\s+[^\n]+\n?){3})\s*$/)
  if (legacy && /选择|选项|哪[个种一]|你想/.test(text.slice(0, legacy.index))) {
    const labels = legacy[1].trim().split('\n').map(line => line.replace(/^\s*(?:[1-3A-C][.、)])\s+/, '').replace(/\*\*/g, '').trim())
    if (labels.length === 3 && new Set(labels).size === 3 && labels.every(label => label.length <= 120)) return { content: text.slice(0, legacy.index).trimEnd(), choices: labels.map(label => ({ label, prompt: label, action: 'discussion' })) }
  }
  return { content: text, choices: [] }
}
