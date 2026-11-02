import { randomUUID } from 'node:crypto'
import { normalizeQuestionAnswers, questionAnswerText, type AgentQuestion, type AgentQuestionInteraction, type WorkbenchQuestionContext, type WorkbenchQuestionRequest } from '../shared/agentQuestion'

export const WORKBENCH_QUESTION_WAIT_MS = 20_000

/** Native questions wait at most 20 seconds. Late answers steer their still-active turn. */
export class WorkbenchQuestions {
  /** Keep a small question snapshot after execution ends, without retaining its native process. */
  private readonly ended = new Map<string, { owner: number; request: WorkbenchQuestionRequest }>()
  private readonly pending = new Map<string, {
    owner: number; request: WorkbenchQuestionRequest; interaction: AgentQuestionInteraction; remove: () => void; continue: () => void; submitting: boolean
  }>()

  constructor(private readonly changed: (owner: number) => void) {}

  list(owner: number): WorkbenchQuestionRequest[] {
    return [...this.pending.values(), ...this.ended.values()].filter(entry => entry.owner === owner).map(entry => entry.request)
  }

  add(owner: number, context: Pick<WorkbenchQuestionRequest, 'projectPath' | 'conversationId' | 'runId' | 'surface'>, questions: AgentQuestion[], signal: AbortSignal, interaction: AgentQuestionInteraction): boolean {
    if (signal.aborted || !questions.length) return false
    const request: WorkbenchQuestionRequest = { ...context, questions, id: randomUUID(),
      ...(interaction.reply && !interaction.waiting?.aborted ? { replyBy: Date.now() + WORKBENCH_QUESTION_WAIT_MS } : {}) }
    let timer: ReturnType<typeof setTimeout> | undefined
    const continued = (): void => {
      if (timer) clearTimeout(timer)
      interaction.waiting?.removeEventListener('abort', continued)
      if (request.replyBy === undefined) return
      delete request.replyBy
      this.changed(owner)
    }
    const continueWithoutAnswer = (): void => {
      if (request.replyBy !== undefined) interaction.reply?.({})
      continued()
    }
    const remove = (): void => {
      signal.removeEventListener('abort', end)
      continueWithoutAnswer()
      const removed = this.pending.delete(request.id)
      const removedSnapshot = this.ended.delete(request.id)
      if (removed || removedSnapshot) this.changed(owner)
    }
    const end = (): void => {
      remove()
      const snapshots = [...this.ended.values()].filter(entry => entry.owner === owner)
      if (snapshots.length >= 16) this.ended.delete(snapshots[0].request.id)
      this.ended.set(request.id, { owner, request: { ...request, replyBy: undefined, ended: true } })
      this.changed(owner)
    }
    // A misbehaving provider cannot keep an unbounded queue alive.
    const queue = [...this.pending.values()].filter(entry => entry.owner === owner && entry.request.runId === context.runId)
    if (queue.length >= 16) queue[0].remove()
    this.pending.set(request.id, { owner, request, interaction, remove, continue: continueWithoutAnswer, submitting: false })
    signal.addEventListener('abort', end, { once: true })
    interaction.waiting?.addEventListener('abort', continued, { once: true })
    if (request.replyBy !== undefined) {
      timer = setTimeout(continueWithoutAnswer, WORKBENCH_QUESTION_WAIT_MS)
      timer.unref?.()
    }
    this.changed(owner)
    return true
  }

  private owned(owner: number, context: WorkbenchQuestionContext) {
    const entry = context && this.pending.get(context.id)
    return entry && entry.owner === owner && entry.request.projectPath === context.projectPath
      && entry.request.conversationId === context.conversationId && entry.request.runId === context.runId
      && (entry.request.surface ?? 'workspace') === (context.surface ?? 'workspace') ? entry : undefined
  }

  async answer(owner: number, context: WorkbenchQuestionContext, answers: unknown): Promise<boolean> {
    const entry = this.owned(owner, context)
    if (!entry) throw new Error('当前问题已结束，请在对话中补充')
    if (entry.submitting) return false
    const normalized = normalizeQuestionAnswers(entry.request.questions, answers)
    entry.submitting = true
    try {
      if (entry.request.replyBy !== undefined && Date.now() >= entry.request.replyBy) entry.continue()
      if (entry.request.replyBy === undefined || !entry.interaction.reply?.(normalized)) await entry.interaction.steer(questionAnswerText(entry.request.questions, normalized))
      entry.remove()
      return true
    }
    finally { entry.submitting = false }
  }

  dismiss(owner: number, context: WorkbenchQuestionContext): boolean {
    const entry = this.owned(owner, context)
    if (!entry) {
      const ended = context && this.ended.get(context.id)
      if (!ended || ended.owner !== owner || ended.request.projectPath !== context.projectPath
        || ended.request.conversationId !== context.conversationId || ended.request.runId !== context.runId
        || (ended.request.surface ?? 'workspace') !== (context.surface ?? 'workspace')) return false
      this.ended.delete(context.id)
      this.changed(owner)
      return true
    }
    if (entry.submitting) return false
    entry.remove()
    return true
  }

  cancelOwner(owner: number): void {
    for (const entry of [...this.pending.values()]) if (entry.owner === owner) entry.remove()
    for (const [id, entry] of this.ended) if (entry.owner === owner) this.ended.delete(id)
  }
}
