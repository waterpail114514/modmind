import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, RotateCcw, Search, LoaderCircle } from 'lucide-react'
import ModelCatalogRows, { filterModelCatalog, modelCatalogCurrent, modelCatalogFailure, modelCatalogKey, modelCatalogProviders, modelCatalogSelection, selectedCatalogKey, type CatalogProvider } from './ModelCatalogRows'
import { quotaModelDisplayMetadata, type QuotaModelSelection } from '../../../shared/quotaModels'
import type { AiModelInfo, BeginnerReasoningLevel, CodingBackend, ReasoningEffort } from '../../../shared/types'
import './composer-ai-control.css'

const titles: Record<BeginnerReasoningLevel, string> = { auto: '默认', none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' }

export default function ComposerAiControl({ model, effort, models, connectedProviders, scanning, allowedEfforts, disabled, onModelChange, onEffortChange, onRefresh, onReset, backend, followWorkbench, onBackendChange, onFollowWorkbench, account, group, switching, message, onCancelWaiting, routeChoiceScope = 'workspace' }: {
  model: string; effort: BeginnerReasoningLevel; models: AiModelInfo[]; disabled?: boolean
  allowedEfforts?: ReasoningEffort[]
  connectedProviders?: CatalogProvider[]
  scanning?: boolean
  onModelChange?: (model: string, selection?: QuotaModelSelection) => void | boolean | Promise<void | boolean>; onEffortChange?: (effort: BeginnerReasoningLevel) => void; onRefresh?: () => void
  account?: string; group?: string; switching?: boolean; message?: string
  onCancelWaiting?: () => void
  routeChoiceScope?: 'workspace' | 'inspiration'
  onReset?: () => void
  backend?: CodingBackend; followWorkbench?: boolean; onBackendChange?: (backend: CodingBackend) => void; onFollowWorkbench?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false), [choosingModel, setChoosingModel] = useState(false), [query, setQuery] = useState('')
  const [draft, setDraft] = useState(effort)
  const [filter, setFilter] = useState('推荐')
  const [position, setPosition] = useState({ left: 0, bottom: 0 })
  const [selectingKey, setSelectingKey] = useState<string | null>(null)
  const [failedModel, setFailedModel] = useState<string>()
  const [failedAccount, setFailedAccount] = useState<string>()
  const [localError, setLocalError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), range = useRef<HTMLInputElement>(null)
  const id = useId()
  const currentModel = modelCatalogCurrent(models, model, account, group)
  const capabilities = currentModel?.routeCurrent === false ? undefined : currentModel?.reasoning
  const options = allowedEfforts ?? capabilities?.efforts ?? []
  const index = Math.max(0, options.indexOf(draft === 'auto' ? capabilities?.defaultEffort ?? 'medium' : draft))
  const modelName = quotaModelDisplayMetadata(currentModel ?? { id: model }).name || '选择模型'
  const providers = modelCatalogProviders(models, connectedProviders)
  const availableModels = models.filter(entry => entry.modelEvidence !== 'unknown')
  const missingProvider = Boolean(account && connectedProviders && !providers.some(provider => provider.account === account))
  const displayMessage = missingProvider ? '原供应商已变更，请重新选择模型。' : message
  const bindingUnavailable = missingProvider || Boolean(account && (models.length || connectedProviders) && (!currentModel || currentModel.routeCurrent === false || currentModel.available === false))
  const compactName = scanning ? '正在读取线路…' : switching || selectingKey ? '正在切换…' : bindingUnavailable ? '重新选择模型' : modelName
  const currentKey = currentModel ? modelCatalogKey(currentModel) : selectedCatalogKey(model, account, account?.startsWith('trial:') ? 'free' : 'quota', group)
  const filters = ['推荐', '全部']
  const activeFilter = filters.includes(filter) ? filter : '推荐'
  const choose = async (entry: AiModelInfo): Promise<void> => {
    if (switching || selectingKey || scanning || entry.available === false) return
    setSelectingKey(modelCatalogKey(entry)); setFailedModel(undefined); setFailedAccount(entry.account); setLocalError('')
    try {
      const applied = await onModelChange?.(entry.id, modelCatalogSelection(entry))
      if (applied === false) { setFailedModel(entry.id); return }
      setOpen(false)
      window.requestAnimationFrame(() => trigger.current?.closest('.agent-composer,.inspiration-composer')?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    } catch (error) { setFailedModel(entry.id); setLocalError(modelCatalogFailure(error)) }
    finally { setSelectingKey(null) }
  }
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const commit = (value = draft): void => { if (value !== effort && !disabled) onEffortChange?.(value) }
  useEffect(() => { setDraft(effort) }, [effort, model])
  useEffect(() => {
    const reset = (): void => { setFailedModel(undefined); setFailedAccount(undefined); setLocalError('') }
    window.addEventListener('modmind-ai-defaults-applied', reset)
    return () => window.removeEventListener('modmind-ai-defaults-applied', reset)
  }, [])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPosition({
        left: Math.max(8, Math.min(rect.right - 340, window.innerWidth - 348)),
        bottom: Math.max(8, Math.min(window.innerHeight - rect.top + 10, window.innerHeight - (panel.current?.offsetHeight ?? 0) - 8))
      })
    }
    place()
    const resize = new ResizeObserver(place)
    if (panel.current) resize.observe(panel.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { resize.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, choosingModel])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [open])
  return <>
    <button ref={trigger} type="button" className="composer-ai-pill" aria-label={`模型与思考强度：${model || '跟随工作台'}，${titles[effort]}`} aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      title={displayMessage} onClick={() => { setChoosingModel(true); setOpen(value => !value) }}>
      {switching || scanning ? <LoaderCircle size={12} className="spin" /> : null}<span>{compactName}</span><strong>{titles[effort]}</strong><ChevronDown size={12} />
    </button>
    {displayMessage ? <span className="composer-ai-feedback" role="status">{displayMessage}{displayMessage.startsWith('等待模型')&&onCancelWaiting?<button type="button" onClick={onCancelWaiting}>取消发送</button>:!switching && !scanning ? <button type="button" onClick={() => { setChoosingModel(true); setOpen(true) }}>重新选择</button> : null}</span> : null}
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label="模型与思考强度" className="composer-ai-panel" style={position}>
      {onBackendChange ? <div className="composer-ai-engines" role="group" aria-label="灵感台 AI 引擎">
        <button type="button" aria-pressed={followWorkbench} onClick={onFollowWorkbench}>默认</button>
        {(['quota', 'codex'] as const).map(value => <button type="button" key={value} aria-pressed={!followWorkbench && backend === value} onClick={() => onBackendChange(value)}>{value === 'quota' ? 'ModMind' : 'Codex'}</button>)}
      </div> : null}
      <div className="composer-ai-heading"><div><strong>{titles[draft]}{draft !== 'auto' ? <small>{draft}</small> : null}</strong>
        <button type="button" className="composer-ai-model" onClick={() => { setChoosingModel(value => !value); setQuery('') }}>{modelName}<ChevronDown size={12} /></button></div>
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
        <div className="composer-model-toolbar"><label className="composer-model-search"><Search size={13} /><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} /></label>{onRefresh ? <button type="button" aria-label="刷新模型与连接" title="刷新模型与连接" disabled={scanning || switching || Boolean(selectingKey)} onClick={onRefresh}>{scanning ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}</button> : null}</div>
        <nav className="composer-model-filters" aria-label="模型筛选">{filters.map(value => <button type="button" key={value} aria-pressed={activeFilter === value} onClick={() => setFilter(value)}>{value}</button>)}</nav>
        <ModelCatalogRows models={filterModelCatalog(availableModels,activeFilter,query,currentKey)} catalogModels={availableModels} routeChoiceScope={routeChoiceScope} query={query} currentKey={currentKey} currentModelId={model} switchingKey={selectingKey} compact disabled={switching || scanning || Boolean(selectingKey)} selectionRequired={bindingUnavailable} selectionError={failedModel ? { model: failedModel, account: failedAccount, message: localError || message || '切换未完成，请重试' } : undefined} onSelect={entry => void choose(entry)}/>
        {!availableModels.length ? <p className="composer-ai-caption">模型列表尚未就绪{onRefresh ? <button type="button" onClick={onRefresh}>刷新重试</button> : null}</p> : null}
        {query.trim() && !connectedProviders && !account && !models.some(entry => entry.account) && !models.some(entry => entry.id === query.trim()) ? <button type="button" onClick={() => choose({ id: query.trim() })}>使用 {query.trim()}</button> : null}
      </div> : null}
    </div>, document.body) : null}
  </>
}
