import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, RotateCcw, Search, LoaderCircle } from 'lucide-react'
import ModelCatalogRows, { filterModelCatalog, selectedCatalogKey } from './ModelCatalogRows'
import { quotaModelMetadata, type QuotaModelSelection } from '../../../shared/quotaModels'
import type { AiModelInfo, BeginnerReasoningLevel, CodingBackend, ReasoningEffort } from '../../../shared/types'
import './composer-ai-control.css'

const titles: Record<BeginnerReasoningLevel, string> = { auto: '默认', none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' }

export default function ComposerAiControl({ model, effort, models, allowedEfforts, disabled, onModelChange, onEffortChange, onRefresh, onReset, backend, followWorkbench, onBackendChange, onFollowWorkbench, account, switching, message, onCancelWaiting }: {
  model: string; effort: BeginnerReasoningLevel; models: AiModelInfo[]; disabled?: boolean
  allowedEfforts?: ReasoningEffort[]
  onModelChange?: (model: string, selection?: QuotaModelSelection) => void; onEffortChange?: (effort: BeginnerReasoningLevel) => void; onRefresh?: () => void
  account?: string; switching?: boolean; message?: string
  onCancelWaiting?: () => void
  onReset?: () => void
  backend?: CodingBackend; followWorkbench?: boolean; onBackendChange?: (backend: CodingBackend) => void; onFollowWorkbench?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false), [choosingModel, setChoosingModel] = useState(false), [query, setQuery] = useState('')
  const [draft, setDraft] = useState(effort)
  const [filter, setFilter] = useState('推荐')
  const [position, setPosition] = useState({ left: 0, bottom: 0 })
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), range = useRef<HTMLInputElement>(null)
  const id = useId()
  const capabilities = models.find(entry => entry.id === model)?.reasoning
  const options = allowedEfforts ?? capabilities?.efforts ?? []
  const index = Math.max(0, options.indexOf(draft === 'auto' ? capabilities?.defaultEffort ?? 'medium' : draft))
  const compactName = switching ? '正在切换…' : quotaModelMetadata(model).name || '选择模型'
  const currentKey = models.find(m=>m.id===model&&(!account||m.account===account))?.optionKey ?? selectedCatalogKey(model,account)
  const choose = (entry: AiModelInfo): void => {
    if (switching || entry.available === false) return
    onModelChange?.(entry.id, { ...(entry.billing ? { billing: entry.billing } : {}), ...(entry.account ? { account: entry.account } : {}) })
    setOpen(false)
    window.requestAnimationFrame(() => trigger.current?.closest('.agent-composer,.inspiration-composer')?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
  }
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const commit = (value = draft): void => { if (value !== effort && !disabled) onEffortChange?.(value) }
  useEffect(() => { setDraft(effort) }, [effort, model])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.right - 340, window.innerWidth - 348)), bottom: Math.max(8, window.innerHeight - rect.top + 10) })
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
      title={message} onClick={() => { setChoosingModel(true); setOpen(value => !value) }}>
      {switching ? <LoaderCircle size={12} className="spin" /> : null}<span>{compactName}</span><strong>{titles[effort]}</strong><ChevronDown size={12} />
    </button>
    {message ? <span className="composer-ai-feedback" role="status">{message}{message.startsWith('等待模型')&&onCancelWaiting?<button type="button" onClick={onCancelWaiting}>取消发送</button>:!switching ? <button type="button" onClick={() => { setChoosingModel(true); setOpen(true) }}>重新选择</button> : null}</span> : null}
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label="模型与思考强度" className="composer-ai-panel" style={position}>
      {onBackendChange ? <div className="composer-ai-engines" role="group" aria-label="灵感台 AI 引擎">
        <button type="button" aria-pressed={followWorkbench} onClick={onFollowWorkbench}>默认</button>
        {(['quota', 'codex'] as const).map(value => <button type="button" key={value} aria-pressed={!followWorkbench && backend === value} onClick={() => onBackendChange(value)}>{value === 'quota' ? 'ModMind' : 'Codex'}</button>)}
      </div> : null}
      <div className="composer-ai-heading"><div><strong>{titles[draft]}{draft !== 'auto' ? <small>{draft}</small> : null}</strong>
        <button type="button" className="composer-ai-model" onClick={() => { setChoosingModel(value => !value); setQuery('') }}>{quotaModelMetadata(model).name || '选择模型'}<ChevronDown size={12} /></button></div>
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
        <div><Search size={14} /><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />{onRefresh ? <button type="button" aria-label="刷新模型与连接" title="刷新模型与连接" onClick={onRefresh}><RotateCcw size={14} /></button> : null}</div>
        <nav className="composer-model-filters" aria-label="模型筛选">{['推荐','全部','免费'].map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</nav>
        <ModelCatalogRows models={filterModelCatalog(models,filter,query,currentKey)} currentKey={currentKey} compact disabled={switching} onSelect={choose}/>
        {!models.length ? <p className="composer-ai-caption">模型列表尚未就绪{onRefresh ? <button type="button" onClick={onRefresh}>重试</button> : null}</p> : null}
        {query.trim() && !models.some(entry => entry.account) && !models.some(entry => entry.id === query.trim()) ? <button type="button" onClick={() => choose({ id: query.trim() })}>使用 {query.trim()}</button> : null}
      </div> : null}
    </div>, document.body) : null}
  </>
}
