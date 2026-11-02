import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, MessageCircleQuestion, Pencil, X } from 'lucide-react'
import type { AgentQuestionAnswers, WorkbenchQuestionRequest } from '../../../shared/agentQuestion'
import './workbench-questions.css'

export default function AgentQuestionCard({ request, active, remaining = 1, mode = 'request', requiredIds = [], onEdit, onAnswer, onDismiss }: {
  request: Pick<WorkbenchQuestionRequest, 'id' | 'questions' | 'replyBy'>
  active: boolean
  remaining?: number
  mode?: 'request' | 'followup'
  requiredIds?: string[]
  onEdit?: () => void
  onAnswer: (answers: AgentQuestionAnswers) => Promise<void> | void
  onDismiss?: () => Promise<void> | void
}): React.JSX.Element {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [remainingSeconds, setRemainingSeconds] = useState(() => request.replyBy === undefined ? 0 : Math.max(0, Math.ceil((request.replyBy - Date.now()) / 1000)))
  const [choices, setChoices] = useState<AgentQuestionAnswers>({})
  const [drafts, setDrafts] = useState<AgentQuestionAnswers>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const draftInput = useRef<HTMLTextAreaElement>(null)
  const question = request.questions[questionIndex]
  const draft = drafts[question.id] ?? ''
  const answerLimit = mode === 'followup' ? 2_000 : 16_000
  useEffect(() => {
    const input = draftInput.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 84)}px`
  }, [draft, question.id])
  useEffect(() => {
    const update = (): void => setRemainingSeconds(request.replyBy === undefined ? 0 : Math.max(0, Math.ceil((request.replyBy - Date.now()) / 1000)))
    update()
    if (request.replyBy === undefined) return
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [request.replyBy])
  const waiting = mode === 'request' && active && remainingSeconds > 0
  const answers = Object.fromEntries(request.questions.map(question => [question.id, drafts[question.id]?.trim() || choices[question.id] || '']))
  const hasAnswer = Object.values(answers).some(Boolean) && requiredIds.every(id => Boolean(answers[id]))
  const submit = async (): Promise<void> => {
    if (submitting.current || !hasAnswer) return
    submitting.current = true
    setBusy(true)
    setError('')
    try { await onAnswer(answers) }
    catch (error) { setError(error instanceof Error ? error.message : '回答未发送，请重试') }
    finally { submitting.current = false; setBusy(false) }
  }
  const dismiss = (): void => { void Promise.resolve().then(onDismiss).catch(() => setError('未能关闭，请重试')) }
  return <section className="workbench-questions" aria-label={mode === 'followup' ? '需求追问' : '等待你的回答'}>
    <div className="workbench-questions-heading">
      <span className="workbench-questions-title"><MessageCircleQuestion size={14} />问题{remaining > 1 ? <span> · {remaining} 组</span> : null}</span>
      {request.questions.length > 1 ? <div className="workbench-question-navigation" aria-label="切换问题">
        <button type="button" aria-label="上一题" disabled={busy || questionIndex === 0} onClick={() => setQuestionIndex(index => index - 1)}><ChevronLeft size={14} /></button>
        <span aria-live="polite">{questionIndex + 1} / {request.questions.length}</span>
        <button type="button" aria-label="下一题" disabled={busy || questionIndex === request.questions.length - 1} onClick={() => setQuestionIndex(index => index + 1)}><ChevronRight size={14} /></button>
      </div> : null}
      <small className="workbench-question-status" aria-live="off">{mode === 'followup' ? '' : waiting ? `${remainingSeconds} 秒后自动继续` : active ? '任务继续中 · 可补答' : '任务已结束'}</small>
      {onDismiss ? <button type="button" className="workbench-question-close" title="关闭问题" aria-label="关闭问题" disabled={busy} onClick={dismiss}><X size={14} /></button> : null}
    </div>
    <form onChange={onEdit} onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="workbench-questions-body">
        <fieldset key={question.id} disabled={busy}>
          <legend>{question.question}</legend>
          {question.options.length ? <div className="workbench-question-options">{question.options.map((option, index) => <label key={index} className={!draft.trim() && choices[question.id] === option.label ? 'selected' : undefined}>
            <input type="radio" name={`${request.id}:${question.id}`} checked={!drafts[question.id]?.trim() && choices[question.id] === option.label} onChange={() => { setChoices(value => ({ ...value, [question.id]: option.label })); setDrafts(value => ({ ...value, [question.id]: '' })) }} />
            <span className="workbench-question-number" aria-hidden="true">{index + 1}</span>
            <span className="workbench-question-option-text">{option.label}{option.description ? <small>{option.description}</small> : null}</span>
          </label>)}</div> : null}
        </fieldset>
      </div>
      <div className="workbench-questions-footer">
        <label className="workbench-question-draft"><Pencil size={15} aria-hidden="true" />{question.isSecret
          ? <input key={question.id} type="password" autoComplete="off" aria-label={question.question} placeholder="或自行撰写回复" maxLength={answerLimit} disabled={busy} value={draft} onChange={event => setDrafts(value => ({ ...value, [question.id]: event.target.value }))} />
          : <textarea key={question.id} ref={draftInput} rows={1} aria-label={question.question} placeholder="或自行撰写回复" maxLength={answerLimit} disabled={busy} value={draft} onChange={event => setDrafts(value => ({ ...value, [question.id]: event.target.value }))} />}</label>
        {onDismiss ? <button type="button" className="workbench-question-skip" disabled={busy} onClick={dismiss}>跳过</button> : null}
        <button type="submit" className="workbench-question-send" title={requiredIds.some(id => !answers[id]) ? '请先回答全部关键问题' : undefined} disabled={busy || !hasAnswer}>{busy ? '发送中…' : mode === 'followup' ? '继续整理' : active ? '发送' : '放入输入框'}</button>
      </div>
      {error ? <div className="workbench-question-error" role="alert">{error}</div> : null}
    </form>
  </section>
}

