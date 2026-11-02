import { useEffect, useState } from 'react'
import { questionAnswerText, type WorkbenchQuestionRequest } from '../../../shared/agentQuestion'
import type { AiSurface } from '../../../shared/types'
import AgentQuestionCard from './AgentQuestionCard'

/** Non-modal. A host deadline bounds waiting, while late replies remain available. */
export default function WorkbenchQuestions({ projectPath, conversationId, surface = 'workspace', onDraft }: {
  projectPath: string; conversationId: string; surface?: AiSurface; onDraft: (text: string) => void
}): React.JSX.Element | null {
  const [requests, setRequests] = useState<WorkbenchQuestionRequest[]>([])
  const [editing, setEditing] = useState<WorkbenchQuestionRequest>()
  useEffect(() => {
    if (!window.modmind.ai.listQuestions || !window.modmind.ai.onQuestionsChanged) return
    let live = true
    let revision = 0
    const refresh = (): void => {
      const current = ++revision
      void window.modmind.ai.listQuestions().then(items => { if (live && current === revision) setRequests(items) }).catch(() => undefined)
    }
    const unsubscribe = window.modmind.ai.onQuestionsChanged(refresh)
    refresh()
    return () => { live = false; unsubscribe() }
  }, [])
  const queue = requests.filter(request => request.projectPath === projectPath && request.conversationId === conversationId && (request.surface ?? 'workspace') === surface)
  const request = (editing && queue.find(item => item.id === editing.id)) ?? editing ?? queue[0]
  if (!request) return null
  const present = queue.some(item => item.id === request.id)
  const active = present && !request.ended
  const forget = (): void => { setEditing(undefined); setRequests(items => items.filter(item => item.id !== request.id)) }
  return <AgentQuestionCard key={request.id} request={request} active={active} remaining={queue.length} onEdit={() => setEditing(request)} onAnswer={async answers => {
    if (active) {
      if (!await window.modmind.ai.answerQuestion(request, answers)) throw new Error('回答正在发送，请稍候')
    } else {
      const text = questionAnswerText(request.questions, answers)
      if (present) await window.modmind.ai.dismissQuestion(request)
      onDraft(text)
    }
    forget()
  }} onDismiss={async () => {
    if (present && !await window.modmind.ai.dismissQuestion(request)) throw new Error('当前问题正在提交')
    forget()
  }} />
}
