/** Mirrors the question fields exposed by the pinned Codex app-server. */
export interface AgentQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  options: { label: string; description: string }[]
}

export interface WorkbenchQuestionRequest {
  id: string
  projectPath: string
  conversationId?: string
  surface?: 'workspace' | 'inspiration'
  runId: string
  questions: AgentQuestion[]
  /** Host deadline. Omitted once native execution has continued. */
  replyBy?: number
  ended?: boolean
}

export type AgentQuestionAnswers = Record<string, string>
export interface AgentQuestionInteraction {
  /** A native request can be answered once before it resolves; false means use steer. */
  reply?: (answers: AgentQuestionAnswers) => boolean
  waiting?: AbortSignal
  steer: (text: string) => Promise<void>
}
export type WorkbenchQuestionContext = Pick<WorkbenchQuestionRequest, 'id' | 'projectPath' | 'conversationId' | 'runId' | 'surface'>

export function normalizeAgentQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.slice(0, 8).flatMap(question => {
    if (!question || typeof question !== 'object' || typeof question.id !== 'string' || !question.id || ids.has(question.id)
      || typeof question.question !== 'string' || !question.question.trim()) return []
    ids.add(question.id)
    return [{ id: question.id, header: typeof question.header === 'string' ? question.header : '', question: question.question,
      isSecret: question.isSecret === true,
      options: Array.isArray(question.options) ? question.options.slice(0, 16).flatMap((option: unknown) => {
        if (!option || typeof option !== 'object' || !('label' in option) || typeof option.label !== 'string') return []
        return [{ label: option.label, description: 'description' in option && typeof option.description === 'string' ? option.description : '' }]
      }) : [] }]
  })
}

/** Only explicit, nonempty user answers are forwarded. An omission is never consent. */
export function normalizeQuestionAnswers(questions: AgentQuestion[], value: unknown): AgentQuestionAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('回答格式无效')
  const answers = value as Record<string, unknown>
  if (Object.keys(answers).some(id => !questions.some(question => question.id === id))) throw new Error('问题已变化，请刷新后重试')
  const parts = questions.flatMap(question => {
    const answer = Object.prototype.hasOwnProperty.call(answers, question.id) ? answers[question.id] : undefined
    if (answer === undefined || answer === '') return []
    if (typeof answer !== 'string' || answer.length > 16_000) throw new Error('回答内容无效或过长')
    return answer.trim() ? [[question.id, answer.trim()]] : []
  })
  if (!parts.length) throw new Error('请先填写回答')
  return Object.fromEntries(parts)
}

export function questionAnswerText(questions: AgentQuestion[], value: unknown): string {
  const answers = normalizeQuestionAnswers(questions, value)
  const parts = questions.flatMap(question => answers[question.id] ? [`${question.question}\n回答：${answers[question.id]}`] : [])
  return `我补充回答刚才的问题：\n\n${parts.join('\n\n')}`
}
