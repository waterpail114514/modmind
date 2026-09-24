import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, Check, FileCode2, Folder, LoaderCircle, ShieldCheck, Terminal, X } from 'lucide-react'
import type { AgentApprovalDecision, WorkbenchApprovalRequest } from '../../../shared/agentApproval'
import AgentBrandIcon from './AgentBrandIcon'
import './workbench-approval-dialog.css'

export function ApprovalDialog({ request, remaining, onResolve }: {
  request: WorkbenchApprovalRequest
  remaining: number
  onResolve: (decision: AgentApprovalDecision) => Promise<void>
}): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const id = useId()
  const Icon = request.kind === 'command' ? Terminal : request.kind === 'files' ? FileCode2 : ShieldCheck

  useEffect(() => {
    const panel = panelRef.current!
    const previous = document.activeElement as HTMLElement | null
    denyRef.current?.focus({ preventScroll: true })
    return () => {
      // A non-modal card must not steal focus back from navigation or another control.
      if (previous?.isConnected && (panel.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true })
    }
  }, [])

  const resolve = async (decision: AgentApprovalDecision): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try { await onResolve(decision) }
    catch (error) { setError(error instanceof Error ? error.message : '审批未提交，请重试') }
    finally { submitting.current = false; setBusy(false) }
  }

  return <section ref={panelRef} className="workbench-approval-dialog" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy} onKeyDown={event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    void resolve('deny')
  }}>
    <header className="workbench-approval-header">
      <span className="workbench-approval-symbol"><Icon size={21} strokeWidth={1.7} /></span>
      <div><span className="workbench-approval-eyebrow"><AgentBrandIcon kind={request.engine} size={13} />{request.engine === 'codex' ? 'Codex' : 'Claude Code'}<span>·</span>等待你的审批{remaining > 1 ? <span className="workbench-approval-count">{remaining} 项</span> : null}</span><h2 id={`${id}-title`}>{request.title}</h2></div>
      <button type="button" className="icon-button" aria-label="拒绝并关闭" title="拒绝并关闭（Esc）" disabled={busy} onClick={() => void resolve('deny')}><X size={17} /></button>
    </header>
    <div className="workbench-approval-body">
      {request.fallbackReason ? <div className="workbench-approval-fallback" role="status"><ShieldCheck size={15} /><span>{request.fallbackReason}</span></div> : null}
      <p id={`${id}-description`}>{request.reason || '确认后继续当前任务。你可以只允许这一次，也可以拒绝本次操作。'}</p>
      <div className="workbench-approval-operation"><div><Icon size={13} /><span>{request.kind === 'command' ? '执行命令' : request.kind === 'files' ? '文件变更' : request.kind === 'permissions' ? '请求的权限' : '工具调用'}</span></div><pre tabIndex={0} aria-label="待审批操作"><code>{request.detail}</code></pre></div>
      <div className="workbench-approval-directory"><Folder size={14} /><span>{request.cwd || request.projectPath}</span></div>
      {error ? <p className="workbench-approval-error" role="alert">{error}</p> : null}
    </div>
    <footer className="workbench-approval-footer">
      <button ref={denyRef} type="button" className="secondary-button workbench-approval-deny" disabled={busy} onClick={() => void resolve('deny')}>拒绝</button>
      {request.allowSession ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void resolve('allow-session')}>本会话允许</button> : null}
      <button type="button" className="primary-button" disabled={busy} onClick={() => void resolve('allow')}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}允许本次<ArrowRight size={14} /></button>
    </footer>
  </section>
}

/** Mounted only on the workbench. A snapshot restores requests after navigating back or reloading. */
export default function WorkbenchApprovalDialog({ projectPath, conversationId }: { projectPath: string; conversationId: string }): React.JSX.Element | null {
  const [requests, setRequests] = useState<WorkbenchApprovalRequest[]>([])
  useEffect(() => {
    if (!window.modmind.ai.listApprovals || !window.modmind.ai.onApprovalsChanged) return
    let active = true
    let revision = 0
    const refresh = (): void => {
      const current = ++revision
      void window.modmind.ai.listApprovals().then(items => { if (active && current === revision) setRequests(items) }).catch(() => undefined)
    }
    const unsubscribe = window.modmind.ai.onApprovalsChanged(refresh)
    refresh()
    return () => { active = false; unsubscribe() }
  }, [])
  const queue = requests.filter(item => item.projectPath === projectPath && (!item.conversationId || item.conversationId === conversationId))
  const request = queue[0]
  const resolve = useCallback(async (decision: AgentApprovalDecision): Promise<void> => {
    if (!request) return
    await window.modmind.ai.respondApproval(request.id, decision)
    setRequests(items => items.filter(item => item.id !== request.id))
  }, [request])
  return request ? <ApprovalDialog key={request.id} request={request} remaining={queue.length} onResolve={resolve} /> : null
}
