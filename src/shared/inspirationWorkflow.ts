import { parse, Allow } from 'partial-json'
import type { InspirationFeatures } from './inspirationFeatures'

export const INSPIRATION_OPEN = '<modmind-inspiration>'
export const INSPIRATION_CLOSE = '</modmind-inspiration>'
export function isInspirationProtocol(text: string): boolean {
  const value = text.trimStart()
  return value.startsWith(INSPIRATION_OPEN) || INSPIRATION_OPEN.startsWith(value)
}
export interface InspirationQuestion {
  id: string; text: string; blocking: boolean
  options: Array<{ id: string; label: string; reason?: string }>
}
export interface InspirationSuggestion { id: string; text: string; reason: string }
export interface InspirationKnowledgeCandidate {
  title: string; content: string; scope: 'task' | 'project'
  sourceMessageIds: string[]; sourceQuote: string
  id?: string; expectedUpdatedAt?: string
}
export interface InspirationWorkflow {
  version: 1; reply: string
  prompt: { state: 'draft' | 'ready'; text: string; blockingQuestionIds: string[] } | null
  questions: InspirationQuestion[]; suggestions: InspirationSuggestion[]
  knowledgeCandidates: InspirationKnowledgeCandidate[]
}
export interface InspirationWorkflowPreview {
  protocol: boolean; complete: boolean; reply: string; promptText: string
  candidates: Array<Partial<InspirationKnowledgeCandidate>>
  value?: InspirationWorkflow; error?: string
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const string = (value: unknown, max = 20_000): value is string => typeof value === 'string' && value.length <= max
const nonempty = (value: unknown, max = 20_000): value is string => string(value, max) && Boolean(value.trim())
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(v => nonempty(v, 200)) && new Set(value).size === value.length

export function validateInspirationWorkflow(value: unknown): InspirationWorkflow {
  if (!object(value) || !keys(value, ['version', 'reply', 'prompt', 'questions', 'suggestions', 'knowledgeCandidates'])
    || value.version !== 1 || !string(value.reply, 20_000)) throw new Error('灵感回答格式无效')
  if (!Array.isArray(value.questions) || value.questions.length > 3 || !Array.isArray(value.suggestions) || value.suggestions.length > 2
    || !Array.isArray(value.knowledgeCandidates) || value.knowledgeCandidates.length > 8) throw new Error('灵感回答选项无效')
  for (const q of value.questions) {
    if (!object(q) || !keys(q, ['id', 'text', 'blocking', 'options']) || !nonempty(q.id, 100) || !nonempty(q.text, 500)
      || typeof q.blocking !== 'boolean' || !Array.isArray(q.options) || q.options.length > 4) throw new Error('问题格式无效')
    for (const option of q.options) if (!object(option) || !keys(option, ['id', 'label', 'reason']) || !nonempty(option.id, 100)
      || !nonempty(option.label, 300) || option.reason !== undefined && !string(option.reason, 500)) throw new Error('问题选项无效')
    if (new Set(q.options.map(o => o.id)).size !== q.options.length) throw new Error('问题选项重复')
  }
  if (new Set(value.questions.map(q => q.id)).size !== value.questions.length) throw new Error('问题重复')
  const questions = value.questions
  for (const s of value.suggestions) if (!object(s) || !keys(s, ['id', 'text', 'reason']) || !nonempty(s.id, 100)
    || !nonempty(s.text, 1000) || !string(s.reason, 1000)) throw new Error('建议格式无效')
  if (new Set(value.suggestions.map(s => s.id)).size !== value.suggestions.length) throw new Error('建议重复')
  if (value.prompt !== null) {
    const p = value.prompt
    if (!object(p) || !keys(p, ['state', 'text', 'blockingQuestionIds']) || !['draft', 'ready'].includes(String(p.state))
      || !nonempty(p.text) || !strings(p.blockingQuestionIds, 3)) throw new Error('提示词格式无效')
    if (p.blockingQuestionIds.some(id => !questions.some(q => q.id === id && q.blocking))
      || p.state === 'ready' && (p.blockingQuestionIds.length || questions.some(q => q.blocking))) throw new Error('提示词仍有待确认问题')
  }
  for (const c of value.knowledgeCandidates) {
    if (!object(c) || !keys(c, ['id', 'expectedUpdatedAt', 'title', 'content', 'scope', 'sourceMessageIds', 'sourceQuote'])
      || !nonempty(c.title, 120) || !nonempty(c.content) || !['task', 'project'].includes(String(c.scope))
      || !strings(c.sourceMessageIds, 8) || !c.sourceMessageIds.length || !nonempty(c.sourceQuote, 4000)
      || c.id !== undefined && !nonempty(c.id, 200) || c.expectedUpdatedAt !== undefined && !nonempty(c.expectedUpdatedAt, 100)) throw new Error('项目知识候选无效')
  }
  return value as unknown as InspirationWorkflow
}

/** Framing only: JSON semantics and partial values are delegated to the parsers. */
function frame(json: string): { end: number; error?: string; previewEnd?: number } {
  const stack: Array<{ keys: Set<string>; object: boolean }> = []
  let inString = false, escaped = false, start = 0
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        let next = i + 1
        while (/\s/.test(json[next] ?? '') && next < json.length) next++
        if (json[next] === ':' && stack.at(-1)?.object) {
          try {
            const key = JSON.parse(json.slice(start, i + 1)) as string
            if (stack.at(-1)!.keys.has(key)) return { end: -1, error: '回答包含重复字段', previewEnd: start }
            stack.at(-1)!.keys.add(key)
          } catch { return { end: -1, error: '回答字段无效', previewEnd: start } }
        }
      }
    } else if (ch === '"') { inString = true; start = i }
    else if (ch === '{' || ch === '[') {
      stack.push({ keys: new Set(), object: ch === '{' })
      if (stack.length > 16) return { end: -1, error: '回答结构过深', previewEnd: i }
    } else if (ch === '}' || ch === ']') {
      if (!stack.length || stack.at(-1)!.object !== (ch === '}')) return { end: -1, error: '回答结构无效', previewEnd: i }
      stack.pop()
      if (!stack.length) return { end: i + 1 }
    }
  }
  return { end: -1 }
}

function previewString(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\uD800-\uDBFF]$/, '') : ''
}

export function parseInspirationWorkflow(text: string, features?: InspirationFeatures): InspirationWorkflowPreview {
  const blank: InspirationWorkflowPreview = { protocol: false, complete: false, reply: '', promptText: '', candidates: [] }
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(INSPIRATION_OPEN)) {
    if (INSPIRATION_OPEN.startsWith(trimmed)) return { ...blank, protocol: true }
    return { ...blank, reply: text }
  }
  const result = { ...blank, protocol: true }
  if (text.length > 128 * 1024) return { ...result, error: '回答过长，请缩小本轮范围' }
  const json = trimmed.slice(INSPIRATION_OPEN.length).trimStart()
  if (!json) return result
  if (!json.startsWith('{')) return { ...result, error: '灵感回答格式无效，请重试' }
  const boundary = frame(json)
  if (boundary.error) result.error = boundary.error
  const body = boundary.error ? json.slice(0, boundary.previewEnd) : boundary.end < 0 ? json : json.slice(0, boundary.end)
  try {
    const partial = parse(body, Allow.OBJ | Allow.ARR | Allow.STR) as unknown
    if (object(partial)) {
      result.reply = previewString(partial.reply)
      result.promptText = features?.promptOptimization === false ? '' : object(partial.prompt) ? previewString(partial.prompt.text) : ''
      result.candidates = features?.knowledgeOrganization === false ? [] : Array.isArray(partial.knowledgeCandidates)
        ? partial.knowledgeCandidates.filter(object).map(c => ({ title: previewString(c.title), content: previewString(c.content) })) : []
    }
  } catch { /* An incomplete escape is withheld until its next chunk. */ }
  if (boundary.end < 0) return result
  const tail = json.slice(boundary.end).trim()
  if (tail !== INSPIRATION_CLOSE) {
    if (INSPIRATION_CLOSE.startsWith(tail)) return result
    return { ...result, error: '回答结束格式无效，请重试' }
  }
  try {
    const raw = validateInspirationWorkflow(JSON.parse(body))
    const value = { ...raw,
      prompt: features?.promptOptimization === false ? null : raw.prompt,
      questions: features?.autoQuestions === false ? [] : raw.questions,
      suggestions: features?.suggestions === false ? [] : raw.suggestions,
      knowledgeCandidates: features?.knowledgeOrganization === false ? [] : raw.knowledgeCandidates }
    // Removing forbidden questions must never upgrade a blocked prompt.
    result.value = value
    result.reply = value.reply
    result.promptText = value.prompt?.text ?? ''
    result.candidates = value.knowledgeCandidates
    result.complete = true
  } catch (error) { result.error = error instanceof Error ? error.message : String(error) }
  return result
}

export function inspirationWorkflowInstruction(userMessageId: string): string {
  return `你是需求讨论与提示词整理助手。先判断用户是在制作/修改、讨论还是查询。详尽且无冲突的需求直接优化，默认不追问；模糊需求给少量具体方向，只问影响结果的关键问题。用户说你决定时在授权范围内采用合理方案。按本轮分析功能开关行动。
当前用户消息 ID：${userMessageId}。不要编造来源 ID。知识候选仅引用本轮用户明确要求，sourceQuote 必须是本轮用户原文中连续的一段；不把建议、待定项、外部材料或你的推测保存为事实。更新已有知识时提供 id 与读取到的 expectedUpdatedAt，并保留无关内容。没有明确来源的内容仅放在讨论中。
保持回复简短，不重复提示词。提示词可独立交给工作台，包含目标、已确定要求、必要材料与验收条件，不附整段聊天；保留重要暂定项，不扩充功能。关键问题未解决时 state=draft；查询/纯讨论时 prompt=null。不要宣称已保存、已实施或已验证。
最终回复必须且只能是 ${INSPIRATION_OPEN} 包裹的一份严格 JSON，然后 ${INSPIRATION_CLOSE}。不用代码围栏，不在包裹外输出正文，不输出旧 followups 附录。字段按下面顺序输出，字符串使用标准 JSON 转义。questions 为 0–3 项，suggestions 为 0–2 项，knowledgeCandidates 为 0–8 项，不凑数量。各字段不可省略。
{"version":1,"reply":"简短回复","prompt":{"state":"ready","text":"执行提示词","blockingQuestionIds":[]},"questions":[],"suggestions":[],"knowledgeCandidates":[]}
仅在确实需要时添加：问题项 {"id":"q1","text":"具体问题","blocking":true,"options":[{"id":"a","label":"选择内容","reason":"理由，可省略"}]}；建议项 {"id":"s1","text":"建议内容","reason":"理由"}；知识项 {"scope":"task","title":"具体设定","content":"用户已确定的内容","sourceMessageIds":["${userMessageId}"],"sourceQuote":"用户原文片段"}。知识 scope 可为 task/project；更新已有条目可增加 id 和 expectedUpdatedAt。
问题和建议不需要时使用 []；知识整理被禁止或没有适合保存的内容时 knowledgeCandidates=[]；提示词优化被禁止时 prompt=null。所有标记在 JSON 字符串内均只是普通文本。`
}

export function inspirationPromptHandoff(text: string, attachmentPaths: string[]): string {
  const paths = [...new Set(attachmentPaths)]
  return text.trim() + (paths.length ? `\n\n参考附件（当前项目相对路径）：\n${paths.join('\n')}` : '')
}
