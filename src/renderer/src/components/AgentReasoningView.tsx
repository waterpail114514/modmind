import { useEffect, useState, type ReactNode } from 'react'
import { Brain, ChevronRight, LoaderCircle } from 'lucide-react'
import type { AgentReasoningContent } from '../../../shared/types'
import './agent-reasoning.css'

export default function AgentReasoningView({ reasoning, running, expandWhileRunning = false, renderContent }: {
  reasoning?: AgentReasoningContent; running: boolean; expandWhileRunning?: boolean; renderContent(content:string):ReactNode
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(running && expandWhileRunning)
  const summary = reasoning?.summary.filter(Boolean).join('\n\n') ?? ''
  const text = reasoning?.text.filter(Boolean).join('\n\n') ?? ''
  useEffect(() => { if (!running) setExpanded(false) }, [running])
  if (!running && !summary && !text) return null
  return <section className="agent-thinking agent-reasoning">
    <button type="button" className="agent-disclosure-header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="agent-disclosure-icon">{running ? <LoaderCircle className="spin" size={12} /> : <Brain size={14} />}</span><span>{running ? '正在思考' : '查看思考'}</span><ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded && (summary || text) ? <div className="agent-disclosure-body">
      {summary ? <div className="agent-reasoning-content"><div className="agent-reasoning-label">思考概要</div>{renderContent(summary)}</div> : null}
      {text ? <details className="agent-reasoning-content" open={running && expandWhileRunning}><summary>思考过程</summary>{renderContent(text)}</details> : null}
    </div> : null}
  </section>
}
