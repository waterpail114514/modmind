import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import type { AiModelInfo } from '../../../shared/types'
import { quotaModelDisplayMetadata, quotaModelOptionKey, type QuotaModelSelection } from '../../../shared/quotaModels'
import { describeAiFailureForUser } from '../../../shared/aiFailure'
import { rawErrorText } from '../../../shared/rawError'
import './model-catalog.css'

export interface CatalogModelGroup { id: string; key: string; routes: AiModelInfo[]; preferred: AiModelInfo }
export interface CatalogProvider { account: string; label: string; billing?: 'quota' | 'free'; kind?: 'paid' | 'free' }
export type ModelRouteChoices = Readonly<Record<string, string>>
const routeChoiceLimit = 1024
const routeChoiceStorageKey = (scope: string): string => `modmind-model-route-choices:${scope}`
export function readModelRouteChoices(raw: string | null): ModelRouteChoices {
  if (!raw || raw.length > 256 * 1024) return {}
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([model, key]) => model.length > 0 && model.length <= 256 && typeof key === 'string' && key.length > 0 && key.length <= 2048).slice(-routeChoiceLimit)) as ModelRouteChoices
  } catch { return {} }
}
const storedRouteChoices = (scope: string): ModelRouteChoices => {
  try { return readModelRouteChoices(localStorage.getItem(routeChoiceStorageKey(scope))) } catch { return {} }
}
const saveRouteChoices = (scope: string, choices: ModelRouteChoices): void => {
  try { localStorage.setItem(routeChoiceStorageKey(scope), JSON.stringify(choices)) } catch { /* Choices remain usable in this view. */ }
}
export function modelCatalogProviders(models: AiModelInfo[], connected?: CatalogProvider[]): CatalogProvider[] {
  if (connected) return connected.map(provider => ({ ...provider, billing: provider.kind === 'free' || provider.billing === 'free' ? 'free' : 'quota' }))
  const providers = new Map<string, CatalogProvider>()
  for (const model of models) if (model.account && !providers.has(model.account)) providers.set(model.account, { account: model.account, label: model.providerLabel || model.account, billing: model.billing })
  return [...providers.values()]
}
export function modelCatalogProvider(models: AiModelInfo[], preferred?: string, browsing?: string, providers = modelCatalogProviders(models)): string | undefined {
  return providers.find(provider => provider.account === browsing)?.account
    ?? providers.find(provider => provider.account === preferred)?.account
    ?? providers.find(provider => models.some(model => model.routeCurrent && model.account === provider.account))?.account
    ?? providers[0]?.account
}
export function modelCatalogForProvider<T extends AiModelInfo>(models: T[], account?: string): T[] { return models.filter(model => model.modelEvidence !== 'unknown' && (account ? model.account === account : !model.account)) }
export function modelCatalogFailure(error: unknown): string {
  const message = rawErrorText(error)
  if (/已切换线路.*不支持|本组不支持所选模型|所选线路.*不支持.*模型/.test(message)) return '该线路暂不支持此模型，请刷新后重新选择。'
  return describeAiFailureForUser(message)
}
const modelGroupKey = (model: AiModelInfo): string => model.id
export function modelCatalogKey(model: AiModelInfo): string { return model.optionKey ?? (model.account ? quotaModelOptionKey(model.id, model.billing ?? 'quota', model.account, model.group) : model.id) }
export function modelCatalogRouteLabel(model: AiModelInfo): string { return [model.providerLabel || model.account, model.groupLabel || model.group].filter(Boolean).join(' · ') }
export function modelCatalogSelection(model: AiModelInfo): QuotaModelSelection {
  return { ...(model.billing ? { billing: model.billing } : {}), ...(model.account ? { account: model.account } : {}), ...(model.billing !== 'free' && typeof model.group === 'string' ? { group: model.group } : {}) }
}
export function modelCatalogCurrent(models: AiModelInfo[], model: string, account?: string, group?: string): AiModelInfo | undefined {
  const matching = models.filter(entry => entry.id === model && (!account || entry.account === account))
  return group !== undefined ? matching.find(entry => entry.group === group) : matching.find(entry => entry.routeCurrent) ?? matching.find(entry => typeof entry.group !== 'string')
}
export function groupModelCatalog(models: AiModelInfo[], currentKey?: string, choices: ModelRouteChoices = {}): CatalogModelGroup[] {
  const grouped = new Map<string, AiModelInfo[]>()
  for (const model of models) {
    const key = modelGroupKey(model), routes = grouped.get(key) ?? []
    if (!routes.some(route => modelCatalogKey(route) === modelCatalogKey(model))) routes.push(model)
    grouped.set(key, routes)
  }
  return [...grouped].map(([key, routes]) => {
    const usable = routes.filter(route => route.available !== false && route.modelEvidence !== 'unknown')
    const preferred = routes.find(route => modelCatalogKey(route) === currentKey)
      ?? routes.find(route => modelCatalogKey(route) === choices[key])
      ?? usable.find(route => route.routeCurrent)
      ?? usable[0] ?? routes.find(route => route.available !== false) ?? routes[0]
    return { id: preferred.id, key, routes, preferred }
  })
}
export function rememberModelRoutes(choices: ModelRouteChoices, groups: CatalogModelGroup[]): ModelRouteChoices {
  const next = new Map(Object.entries(choices))
  let changed = false
  for (const group of groups) {
    if (group.preferred.available === false || group.preferred.modelEvidence === 'unknown') continue
    const key = modelCatalogKey(group.preferred)
    if (next.get(group.key) === key) continue
    next.delete(group.key); next.set(group.key, key); changed = true
  }
  if (!changed) return choices
  return Object.fromEntries([...next].slice(-routeChoiceLimit))
}
export function modelCatalogDefaultSelection(group: CatalogModelGroup): AiModelInfo | undefined {
  return group.preferred.available !== false && group.preferred.modelEvidence !== 'unknown' ? group.preferred : undefined
}
export function partitionModelCatalog(groups: CatalogModelGroup[], currentKey?: string, query = '', errorModel?: string): { primary: CatalogModelGroup[]; additionalGpt: CatalogModelGroup[] } {
  const primary: CatalogModelGroup[] = [], additionalGpt: CatalogModelGroup[] = []
  for (const group of groups) {
    const secondary = !query.trim() && group.id !== errorModel && !group.routes.some(route => modelCatalogKey(route) === currentKey)
      && group.routes.every(route => { const metadata = quotaModelDisplayMetadata(route); return metadata.family === 'GPT' && !metadata.description.trim() && !metadata.recommended })
    if (secondary) additionalGpt.push(group)
    else primary.push(group)
  }
  return { primary, additionalGpt }
}
export function modelCatalogFamilies(models: AiModelInfo[]): string[] {
  const order = ['GPT', 'Kimi', 'GLM', 'Gemini', 'Grok', 'DeepSeek', 'Qwen']
  const families = [...new Set(models.map(model => quotaModelDisplayMetadata(model).family))].filter(family => !['推荐', '全部', '免费'].includes(family))
    .sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b, 'zh-CN'))
  return ['推荐', ...families, '全部']
}
export function filterModelCatalog<T extends AiModelInfo>(models: T[], family: string, query: string, currentKey?: string): T[] {
  const search = query.trim().toLowerCase()
  const recommended = models.some(model => model.available !== false && model.modelEvidence !== 'unknown' && quotaModelDisplayMetadata(model).recommended)
  const matching = new Set(groupModelCatalog(models, currentKey).filter(group => group.routes.some(model => {
    const metadata = quotaModelDisplayMetadata(model)
    if (search) return `${model.id} ${metadata.name} ${metadata.family} ${modelCatalogRouteLabel(model)}`.toLowerCase().includes(search)
    return family === '全部' || (family === '免费' ? model.billing === 'free' : family === '推荐' ? metadata.recommended || !recommended || modelCatalogKey(model) === currentKey : metadata.family === family)
  })).map(group => group.key))
  const order = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'deepseek-v4.1-flash']
  const rank = (id: string): number => order.indexOf(id) < 0 ? 99 : order.indexOf(id)
  return models.filter(model => matching.has(modelGroupKey(model)) && (search || family !== '免费' || model.billing === 'free')).sort((a, b) => rank(a.id) - rank(b.id) || quotaModelDisplayMetadata(b).name.localeCompare(quotaModelDisplayMetadata(a).name, 'zh-CN', { numeric: true }))
}
export default function ModelCatalogRows({ models, catalogModels = models, routeChoiceScope = 'workspace', currentKey, currentModelId, switchingKey, disabled, compact, query = '', selectionRequired, selectionError, onSelect }: {
  models: AiModelInfo[]; currentKey?: string; currentModelId?: string; switchingKey?: string | null; disabled?: boolean; compact?: boolean; query?: string; selectionRequired?: boolean
  catalogModels?: AiModelInfo[]; routeChoiceScope?: 'settings' | 'workspace' | 'inspiration'
  selectionError?: { model: string; account?: string; message: string }; onSelect: (model: AiModelInfo) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [remembered, setRemembered] = useState(() => ({ scope: routeChoiceScope, choices: storedRouteChoices(routeChoiceScope) }))
  const choices = remembered.scope === routeChoiceScope ? remembered.choices : storedRouteChoices(routeChoiceScope)
  const instance = useId()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Pin every model, including those hidden by a family filter. A server-side
    // group change must never move another model's locally prepared route.
    setRemembered(previous => {
      const before = previous.scope === routeChoiceScope ? previous.choices : storedRouteChoices(routeChoiceScope)
      const next = rememberModelRoutes(before, groupModelCatalog(catalogModels, currentKey, before))
      if (next === before && previous.scope === routeChoiceScope) return previous
      saveRouteChoices(routeChoiceScope, next)
      return { scope: routeChoiceScope, choices: next }
    })
  }, [catalogModels, currentKey, routeChoiceScope])
  useEffect(() => { if (selectionError) setExpanded(modelGroupKey(models.find(model => model.id === selectionError.model) ?? { id: selectionError.model })) }, [selectionError?.model, selectionError?.message])
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      const trigger = root.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
      setExpanded(null); trigger?.focus()
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [expanded])
  const groups = groupModelCatalog(models, currentKey, choices)
  const { primary, additionalGpt } = partitionModelCatalog(groups, currentKey, query, selectionError?.model)
  const renderGroup = (group: CatalogModelGroup, index: number): React.JSX.Element => {
    const model = group.preferred, metadata = quotaModelDisplayMetadata(model)
    const multipleProviders = new Set(group.routes.map(route => route.account ?? '')).size > 1
    const routeLabel = multipleProviders || model.billing === 'free' ? modelCatalogRouteLabel(model) : model.groupLabel || model.group || model.providerLabel || ''
    const freeLabel = model.billing === 'free' ? '免费' : group.routes.some(route => route.billing === 'free' && route.available !== false && route.modelEvidence !== 'unknown') ? '可免费' : undefined
    const freeMark = freeLabel ? <sup className="quota-free-mark model-catalog-free" aria-label={freeLabel === '可免费' ? '可选免费线路' : '免费版'} title={freeLabel === '可免费' ? '可选择免费线路' : undefined}>{freeLabel === '免费' ? '免' : freeLabel}</sup> : null
    const selected = group.routes.some(route => modelCatalogKey(route) === currentKey && route.routeCurrent !== false)
    const currentModel = group.id === currentModelId || group.routes.some(route => modelCatalogKey(route) === currentKey)
    const switching = group.routes.some(route => modelCatalogKey(route) === switchingKey)
    const needsChoice = !modelCatalogDefaultSelection(group)
    const unavailable = group.routes.every(route => route.available === false)
    const open = expanded === group.key, choicesId = `${instance}-routes-${index}`
    const choosePreferred = (): void => { if (needsChoice) setExpanded(group.key); else onSelect(model) }
    const label = switching ? '连接中' : selected && !selectionRequired ? '使用中' : unavailable ? '未开放' : needsChoice ? '选线路' : '切换'
    const error = selectionError?.model === group.id ? selectionError.message : undefined
    return <div className="model-catalog-item" key={group.key} data-model-id={group.id} data-provider-account={model.account}>
      <div className={`model-catalog-model-row${compact ? '' : ' quota-model-row'}`} data-option-key={modelCatalogKey(model)}>
        <div className={compact ? 'model-catalog-copy' : 'quota-model-copy'}>
          {compact ? <button type="button" className="model-catalog-title" disabled={disabled || unavailable} onClick={choosePreferred} aria-label={`切换到 ${metadata.name}`}><strong>{metadata.name}{freeMark}</strong></button> : <strong>{metadata.name}{freeMark}{'noCache' in model && model.noCache ? <span className="quota-no-cache-mark">无缓存</span> : null}</strong>}
          {routeLabel && (group.routes.length > 1 || needsChoice ? <button type="button" className="model-catalog-route-trigger" title={routeLabel} aria-label={`选择 ${metadata.name} 的线路`} aria-expanded={open} aria-controls={open ? choicesId : undefined} disabled={disabled} onClick={() => setExpanded(open ? null : group.key)}><span>{routeLabel}</span><ChevronDown size={11} /></button> : <span className="model-catalog-route-static">{routeLabel}</span>)}
          {!compact && metadata.description ? <span>{metadata.description}</span> : null}
        </div>
        {compact ? <span className="model-catalog-check">{switching ? <LoaderCircle size={14} className="spin" /> : selected ? <Check size={14} /> : null}</span> : <button type="button" className="secondary-button compact quota-model-switch" aria-label={`切换到 ${metadata.name}`} aria-current={selected ? 'true' : undefined} title={model.unavailableReason} disabled={disabled || unavailable || (selected && !selectionRequired)} onClick={choosePreferred}>{label}</button>}
      </div>
      {error ? <div className="model-catalog-error" role="status">{error}</div> : null}
      {open ? <div className="model-catalog-routes" id={choicesId} role="group" aria-label={`${metadata.name} 的线路`}>{group.routes.map(route => {
        const key = modelCatalogKey(route), chosen = key === modelCatalogKey(model)
        const chooseRoute = (): void => {
          if (currentModel) {
            if (key !== currentKey || selectionRequired || !selected) onSelect(route)
          } else {
            const next = rememberModelRoutes(choices, [{ ...group, preferred: route }])
            saveRouteChoices(routeChoiceScope, next)
            setRemembered({ scope: routeChoiceScope, choices: next })
            setExpanded(null)
            root.current?.querySelector<HTMLButtonElement>(`button[aria-controls="${choicesId}"]`)?.focus()
          }
        }
        return <button type="button" className="model-catalog-route-option" key={key} data-option-key={key} aria-label={`使用 ${metadata.name} · ${modelCatalogRouteLabel(route)}`} aria-pressed={chosen} disabled={disabled || route.available === false || route.modelEvidence === 'unknown'} title={route.unavailableReason} onClick={chooseRoute}>
          <span className="model-catalog-route-copy">{multipleProviders || route.billing === 'free' ? modelCatalogRouteLabel(route) || metadata.name : route.groupLabel || route.group || metadata.name}{route.available === false && route.unavailableReason ? <small>{route.unavailableReason}</small> : null}</span>
          {route.billing === 'free' ? <span className="model-catalog-free">免费</span> : null}{route.modelEvidence === 'unknown' ? <span className="model-catalog-evidence">待验证</span> : null}{key === switchingKey ? <LoaderCircle size={13} className="spin" /> : chosen ? <Check size={13} /> : null}
        </button>
      })}</div> : null}
    </div>
  }
  return <div ref={root} className={`model-catalog-rows${compact ? ' is-compact' : ' is-settings'}`} role="group" aria-label="可用模型">
    {selectionError && !groups.some(group => group.id === selectionError.model) ? <div className="model-catalog-error" role="status">{selectionError.message}</div> : null}
    {primary.map(renderGroup)}
    {additionalGpt.length > 0 ? <details className="model-catalog-more"><summary><ChevronDown size={13} aria-hidden="true" /><span>更多 GPT 模型</span><span className="model-catalog-more-count">{additionalGpt.length}</span></summary>{additionalGpt.map((group, index) => renderGroup(group, primary.length + index))}</details> : null}
    {!groups.length ? <div className="model-catalog-empty">没有匹配的模型</div> : null}
  </div>
}
export function selectedCatalogKey(model: string, account?: string, billing?: 'quota' | 'free', group?: string): string { return account ? quotaModelOptionKey(model, billing ?? 'quota', account, group) : model }
