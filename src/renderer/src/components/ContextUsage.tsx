import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiTokenUsage } from '../../../shared/types'
import { workbenchContextUsageState } from '../workbenchTimeline'

export default function ContextUsage({ usage }: { usage?: AiTokenUsage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const state = useMemo(() => workbenchContextUsageState(usage), [usage?.inputTokens, usage?.cachedInputTokens, usage?.outputTokens, usage?.contextTokens, usage?.contextWindow, usage?.cumulative])
  const level = state.kind === 'capacity' ? state.ratio > .92 ? 'critical' : state.ratio > .8 ? 'warning' : 'ok' : 'unknown'
  const label = state.kind === 'capacity' ? `上下文 ${state.percent}%` : usage?.contextWindow ? `上下文窗口 ${usage.contextWindow.toLocaleString('zh-CN')} tokens` : '上下文等待统计'
  const progress = state.kind === 'capacity' ? `${Math.min(100, Math.max(0, state.ratio * 100))}%` : '0%'
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const format = (value?: number): string => value === undefined ? '未报告' : value.toLocaleString('zh-CN')
  return <div ref={root} className={`agent-context-control ${open ? 'open' : ''}`} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
    <button type="button" className={`context-usage-trigger ${level}`} style={{ '--context-progress': progress } as React.CSSProperties} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="context-usage-ring" aria-hidden="true" />
    </button>
    {open ? <div className="agent-context-popover context-usage-details" role="status"><strong>{label}</strong>
      <span>已用 {format(usage?.contextTokens ?? (usage?.cumulative ? undefined : usage?.inputTokens))} tokens</span>
      <span>窗口 {format(usage?.contextWindow)} tokens</span>
      {usage?.model ? <small>{usage.model}</small> : null}
    </div> : null}
  </div>
}
