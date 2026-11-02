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
  if (!Array.isArray(value.questions) || value.questions.length > 3 || !Array.isArray(value.suggestions) || value.suggestions.length > 2) throw new Error('灵感回答选项无效')
  if (!Array.isArray(value.knowledgeCandidates)) throw new Error('项目知识列表格式无效')
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
    if (!object(p) || !keys(p, ['state', 'text', 'blockingQuestionIds']) || p.state !== 'draft' && p.state !== 'ready'
      || !nonempty(p.text) || !strings(p.blockingQuestionIds, 3)) throw new Error('提示词格式无效')
    if (p.blockingQuestionIds.some(id => !questions.some(q => q.id === id && q.blocking))
      || p.state === 'ready' && (p.blockingQuestionIds.length || questions.some(q => q.blocking))) throw new Error('提示词仍有待确认问题')
  }
  for (const c of value.knowledgeCandidates) {
    if (!object(c) || !keys(c, ['id', 'expectedUpdatedAt', 'title', 'content', 'scope', 'sourceMessageIds', 'sourceQuote'])
      || !nonempty(c.title, 120) || !nonempty(c.content) || c.scope !== 'task' && c.scope !== 'project'
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

export function inspirationWorkflowInstruction(): string {
  return `你是需求讨论与提示词整理助手。先判断用户是在制作/修改、讨论还是查询。普通回答直接使用 Markdown，不输出 modmind-inspiration 标签或 JSON 正文，不续写历史回答的旧协议。
需要提示词、知识候选、可点击的问题或建议时，调用 modmind_inspiration_submit。工具字段按需提供；同一轮再次提交会替换本轮整套产物，修正时保留仍需要的字段。纯讨论不强制提交工具或生成提示词。
宿主自动绑定当前项目、会话和消息来源编号，不填写或查找这些编号，不读取内部上下文文件。知识只记录用户明确确定的内容，sourceQuote 必须逐字引用本轮用户原文；建议、猜测和未确认数值保留在讨论中。更新知识前读取原条目，保留无关内容，传入 id 和 expectedUpdatedAt。工具报错后按具体字段修正，最多两次；仍失败则保留正文并说明哪些产物未提交。
提示词能独立交给工作台，包含目标、确定要求、必要材料与验收条件。关键问题未解决时使用 draft，纯查询不生成提示词。详细且无冲突的需求直接整理，不凑问题或建议数量。用户说你决定时在授权范围内采用合理方案。
工具成功只表示产物已登记为草稿；知识是否保存、是否等待确认由宿主回执决定。不要宣称已实施或已验证。遵守本轮分析功能开关和只读边界。`
}

export function inspirationPromptHandoff(text: string, attachmentPaths: string[]): string {
  const paths = [...new Set(attachmentPaths)]
  return text.trim() + (paths.length ? `\n\n参考附件（当前项目相对路径）：\n${paths.join('\n')}` : '')
}
