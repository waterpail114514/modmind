import type { InspirationFeatures } from './inspirationFeatures'
import { validateInspirationWorkflow, type InspirationWorkflow } from './inspirationWorkflow'

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
export const INSPIRATION_SUBMISSION_SCHEMA = {
  ...object({
    prompt: { anyOf: [{ type: 'null' }, object({ state: { enum: ['draft', 'ready'] }, text: text(20000),
      blockingQuestionIds: { type: 'array', maxItems: 3, uniqueItems: true, items: text(100) } }, ['state', 'text'])] },
    questions: { type: 'array', maxItems: 3, items: object({ id: text(100), text: text(500), blocking: { type: 'boolean' },
      options: { type: 'array', maxItems: 4, items: object({ id: text(100), label: text(300), reason: text(500) }, ['label']) } }, ['text', 'blocking']) },
    suggestions: { type: 'array', maxItems: 2, items: object({ id: text(100), text: text(1000), reason: { type: 'string', maxLength: 1000 } }, ['text']) },
    knowledge: { type: 'array', items: object({ title: text(120), content: text(20000), sourceQuote: text(4000),
      scope: { enum: ['task', 'project'] }, id: text(200), expectedUpdatedAt: text(100) }, ['title', 'content', 'sourceQuote']) }
  }), minProperties: 1
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra) throw new Error(`${label}.${extra} 不受支持；项目与消息身份由宿主绑定`)
}

/** MCP input is a result artifact, never an assistant answer or a caller-selected identity. */
export function normalizeInspirationSubmission(input: unknown, sourceId: string, question: string, features: InspirationFeatures): InspirationWorkflow {
  if (!record(input) || !Object.keys(input).length) throw new Error('请提交 prompt、knowledge、questions 或 suggestions')
  fields(input, ['prompt', 'knowledge', 'questions', 'suggestions'], 'input')
  if (JSON.stringify(input).length > 128 * 1024) throw new Error('提交内容过长，请缩小本轮范围')
  for (const [key, enabled] of [['prompt', features.promptOptimization], ['knowledge', features.knowledgeOrganization],
    ['questions', features.autoQuestions], ['suggestions', features.suggestions]] as const) {
    if (!enabled && input[key] != null && (!Array.isArray(input[key]) || input[key].length)) throw new Error(`[USER_DISABLED_TOOL] 用户未启用 ${key} 对应的分析功能`)
  }
  const questions = Array.isArray(input.questions) ? input.questions.map((q, i) => record(q) ? {
    ...q, id: (q.id === undefined ? `q${i + 1}` : q.id), options: q.options === undefined ? [] : Array.isArray(q.options)
      ? q.options.map((o, j) => record(o) ? { ...o, id: o.id === undefined ? `o${j + 1}` : o.id } : o) : q.options
  } : q) : input.questions === undefined ? [] : input.questions
  const suggestions = Array.isArray(input.suggestions) ? input.suggestions.map((s, i) => record(s)
    ? { ...s, id: s.id === undefined ? `s${i + 1}` : s.id, reason: s.reason === undefined ? '' : s.reason } : s) : input.suggestions === undefined ? [] : input.suggestions
  const candidates = Array.isArray(input.knowledge) ? input.knowledge.map((c, i) => {
    if (!record(c)) throw new Error(`knowledge[${i}] 必须为知识条目`)
    fields(c, ['id', 'expectedUpdatedAt', 'title', 'content', 'scope', 'sourceQuote'], `knowledge[${i}]`)
    if (typeof c.sourceQuote !== 'string' || !c.sourceQuote.trim() || !question.includes(c.sourceQuote)) {
      throw new Error(`knowledge[${i}].sourceQuote 必须是本轮用户原文中的连续片段；未保存，请修正引用后重新提交`)
    }
    return { ...c, scope: c.scope === undefined ? 'project' : c.scope, sourceMessageIds: [sourceId] }
  }) : input.knowledge === undefined ? [] : input.knowledge
  let prompt = input.prompt ?? null
  if (record(prompt)) prompt = { ...prompt, blockingQuestionIds: prompt.blockingQuestionIds === undefined
    ? (Array.isArray(questions) ? questions.filter(q => record(q) && q.blocking).map(q => q.id) : []) : prompt.blockingQuestionIds }
  return validateInspirationWorkflow({ version: 1, reply: '', prompt, questions, suggestions, knowledgeCandidates: candidates })
}

export interface InspirationArtifact { workflow: InspirationWorkflow; finalized: boolean }
