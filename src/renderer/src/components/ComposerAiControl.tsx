import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, RotateCcw } from 'lucide-react'
import type { AiModelInfo, BeginnerReasoningLevel, CodingBackend, ReasoningEffort } from '../../../shared/types'
import './composer-ai-control.css'

const titles: Record<BeginnerReasoningLevel, string> = { auto: '默认', none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' }

export default function ComposerAiControl({ model, effort, models, allowedEfforts, disabled, onModelChange, onEffortChange, onRefresh, onReset, backend, followWorkbench, onBackendChange, onFollowWorkbench }: {
  model: string; effort: BeginnerReasoningLevel; models: AiModelInfo[]; disabled?: boolean
  allowedEfforts?: ReasoningEffort[]
  onModelChange?: (model: string) => void; onEffortChange?: (effort: BeginnerReasoningLevel) => void; onRefresh?: () => void
  onReset?: () => void
  backend?: CodingBackend; followWorkbench?: boolean; onBackendChange?: (backend: CodingBackend) => void; onFollowWorkbench?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false), [choosingModel, setChoosingModel] = useState(false), [query, setQuery] = useState('')
  const [draft, setDraft] = useState(effort)
  const [position, setPosition] = useState({ left: 0, bottom: 0 })
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), range = useRef<HTMLInputElement>(null)
  const id = useId()
  const capabilities = models.find(entry => entry.id === model)?.reasoning
  const options = allowedEfforts ?? capabilities?.efforts ?? []
  const index = Math.max(0, options.indexOf(draft === 'auto' ? capabilities?.defaultEffort ?? 'medium' : draft))
  const compactName = model || '选择模型'
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const commit = (value = draft): void => { if (value !== effort && !disabled) onEffortChange?.(value) }
  useEffect(() => { setDraft(effort) }, [effort, model])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), bottom: Math.max(8, window.innerHeight - rect.top + 10) })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [open])
  return <>
    <button ref={trigger} type="button" className="composer-ai-pill" aria-label={`模型与思考强度：${model || '跟随工作台'}，${titles[effort]}`} aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => { setChoosingModel(false); setOpen(value => !value) }}>
      <span>{compactName}</span><strong>{titles[effort]}</strong><ChevronDown size={12} />
    </button>
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label="模型与思考强度" className="composer-ai-panel" style={position}>
      {onBackendChange ? <div className="composer-ai-engines" role="group" aria-label="灵感台 AI 引擎">
        <button type="button" aria-pressed={followWorkbench} onClick={onFollowWorkbench}>默认</button>
        {(['quota', 'codex'] as const).map(value => <button type="button" key={value} aria-pressed={!followWorkbench && backend === value} onClick={() => onBackendChange(value)}>{value === 'quota' ? 'ModMind' : 'Codex'}</button>)}
      </div> : null}
      <div className="composer-ai-heading"><div><strong>{titles[draft]}{draft !== 'auto' ? <small>{draft}</small> : null}</strong>
        <button type="button" className="composer-ai-model" onClick={() => { setChoosingModel(value => !value); setQuery('') }}>{model || '选择模型'}<ChevronDown size={12} /></button></div>
        <button type="button" className="composer-ai-reset" aria-label="恢复设置中的默认配置" title="恢复设置中的默认配置" onClick={() => { onReset?.(); setOpen(false) }} disabled={!onReset}><RotateCcw size={15} /></button>
      </div>
      <div className="composer-ai-slider" style={{ '--reasoning-progress': `${options.length > 1 ? index / (options.length - 1) * 100 : 0}%` } as React.CSSProperties}>
        <div className="composer-ai-dots" aria-hidden="true">{options.map(option => <i key={option} />)}</div>
        <input ref={range} type="range" aria-label="思考强度" min={0} max={Math.max(0, options.length - 1)} step={1} value={index} aria-valuetext={`${titles[draft]} (${draft})`} disabled={options.length < 2 || !onEffortChange}
          onChange={event => setDraft(options[Number(event.target.value)])} onPointerUp={event => commit(options[Number(event.currentTarget.value)])}
          onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) commit(options[Number(event.currentTarget.value)]) }} onBlur={() => commit()} />
      </div>
      {effort !== 'auto' && !options.includes(effort) ? <p className="composer-ai-caption">{effort} 暂不可用，请重新选择</p> : null}
      {choosingModel ? <div className="composer-ai-models">
        <div><input aria-label="搜索或输入模型 ID" placeholder="搜索或输入模型 ID" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && query.trim()) { onModelChange?.(query.trim()); setChoosingModel(false) } }} />{onRefresh ? <button type="button" aria-label="刷新模型能力" onClick={onRefresh}><RotateCcw size={14} /></button> : null}</div>
        <div role="group" aria-label="可用模型">{models.filter(entry => entry.id.toLowerCase().includes(query.toLowerCase())).map(entry => <button type="button" key={entry.id} aria-pressed={entry.id === model} onClick={() => { onModelChange?.(entry.id); setChoosingModel(false) }}>{entry.id}</button>)}</div>
        {query.trim() && !models.some(entry => entry.id === query.trim()) ? <button type="button" onClick={() => { onModelChange?.(query.trim()); setChoosingModel(false) }}>使用 {query.trim()}</button> : null}
      </div> : null}
    </div>, document.body) : null}
  </>
}
