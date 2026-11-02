import { useState, type ReactNode } from 'react'
import { Pencil, Trash2, Undo2 } from 'lucide-react'

/** Both chat surfaces use the same message, actions and long-prompt presentation. */
export default function AgentMessage({ role, content, children, time, separateAnswer, onEdit, onDelete, onRewind }: {
  role: 'user' | 'assistant'; content?: string; children?: ReactNode; time?: string; separateAnswer?: boolean
  onEdit?: () => void; onDelete?: () => void; onRewind?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const text = content ?? ''
  const long = role === 'user' && (text.length > 1000 || text.split('\n').length > 12)
  const rewindLabel = role === 'user' ? '从这条提问重新开始' : '保留此回答并截断后续对话'
  return <article className={`agent-message-row ${role}${long ? ' is-long' : ''}`}>
    {separateAnswer ? <hr className="agent-answer-divider" aria-label="最终回答" /> : null}
    <div className={`agent-message agent-message-${role}${long && !expanded ? ' is-collapsed' : ''}`}>
      {role === 'user' ? <p>{long && !expanded ? `${text.slice(0, 1200)}…` : text}</p> : children}
    </div>
    {long ? <button type="button" className="agent-message-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开全文'}</button> : null}
    {onEdit || onDelete || onRewind ? <div className="agent-message-actions">
      {onEdit ? <button type="button" title="编辑并重新发送" aria-label="编辑并重新发送" onClick={onEdit}><Pencil size={12} /></button> : null}
      {onDelete ? <button type="button" title="删除这轮对话" aria-label="删除这轮对话" onClick={onDelete}><Trash2 size={12} /></button> : null}
      {onRewind ? <button type="button" title={rewindLabel} aria-label={rewindLabel} onClick={onRewind}><Undo2 size={12} /></button> : null}
    </div> : null}
    {time && Number.isFinite(new Date(time).getTime()) ? <time>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(time))}</time> : null}
  </article>
}
