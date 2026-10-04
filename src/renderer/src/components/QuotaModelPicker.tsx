import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoaderCircle, RotateCcw, Search } from 'lucide-react'
import type { BeginnerAiPreferences, DeviceConnectionState } from '../../../shared/types'
import type { QuotaModelCatalog, QuotaModelOption, QuotaModelSelection } from '../../../shared/quotaModels'
import { QUOTA_MODEL_METADATA, FREE_MODEL_METADATA, FREE_ROUTE_HINTS, quotaModelMetadata, quotaModelOptionKey } from '../../../shared/quotaModels'
import './quota-model-picker.css'
import gptCharacter from '../assets/model-characters/gpt.webp'
import geminiCharacter from '../assets/model-characters/gemini.webp'
import grokCharacter from '../assets/model-characters/grok.webp'
import glmCharacter from '../assets/model-characters/glm.webp'
import kimiCharacter from '../assets/model-characters/kimi.webp'
import deepseekCharacter from '../assets/model-characters/deepseek.webp'
import qwenCharacter from '../assets/model-characters/qwen.webp'
import modmindCharacter from '../assets/model-characters/modmind.webp'
import QuotaModelCharacter from './QuotaModelCharacter'
import QuotaModelFamilies from './QuotaModelFamilies'

const familyCharacters: Record<string, string> = {
  推荐: modmindCharacter,
  GPT: gptCharacter, Gemini: geminiCharacter, Grok: grokCharacter, GLM: glmCharacter,
  Kimi: kimiCharacter, DeepSeek: deepseekCharacter, Qwen: qwenCharacter
}

export default function QuotaModelPicker({ preferences, device, disabled, onApplied, children }: {
  preferences: BeginnerAiPreferences; device: DeviceConnectionState; disabled: boolean
  onApplied: (preferences: BeginnerAiPreferences) => void; children: ReactNode
}) {
  const [catalog, setCatalog] = useState<QuotaModelCatalog | null>(null)
  const [family, setFamily] = useState('推荐')
  const [animateFamily, setAnimateFamily] = useState(false)
  const [familyDirection, setFamilyDirection] = useState<'next' | 'previous'>('next')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const request = useRef(0)
  const mounted = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout>>()
  const load = useCallback(async (force = false) => {
    const sequence = ++request.current
    setLoading(true)
    try {
      const value = await window.modmind.device.getModelCatalog(force)
      if (mounted.current && sequence === request.current) setCatalog(value)
    } catch {
      if (mounted.current && sequence === request.current) { setFeedback('无法读取模型列表，请重试'); setFailed(true) }
    } finally { if (mounted.current && sequence === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++; clearTimeout(retryTimer.current) }
  }, [])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const gap = Math.max(0, entry.contentRect.width - 515)
      element.style.setProperty('--character-opacity', String(Math.min(1, gap / 280)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [device.provider])
  useEffect(() => {
    if (device.provider === 'custom') return
    let started = false
    const observer = new IntersectionObserver(entries => {
      if (!started && entries.some(entry => entry.isIntersecting)) { started = true; void load(); observer.disconnect() }
    })
    if (root.current) observer.observe(root.current)
    return () => { observer.disconnect(); request.current++ }
  }, [device.status, device.username, device.siteUrl, preferences.model, device.provider, device.billing, load])
  if (device.provider === 'custom') return <>{children}</>
  const models: QuotaModelOption[] = catalog?.models ?? [
    ...QUOTA_MODEL_METADATA.map(model => ({ ...model, optionKey: quotaModelOptionKey(model.id, 'quota'), billing: 'quota' as const, available: false })),
    ...FREE_MODEL_METADATA.map(model => ({ ...model, optionKey: quotaModelOptionKey(model.id, 'free', FREE_ROUTE_HINTS[0].account), billing: 'free' as const, account: FREE_ROUTE_HINTS[0].account, available: false }))
  ]
  const familyOrder = ['GPT', 'Kimi', 'GLM', 'Gemini', 'Grok', 'DeepSeek', 'Qwen']
  const families = ['推荐', ...new Set(models.map(model => model.family).sort((a, b) => (familyOrder.includes(a) ? familyOrder.indexOf(a) : 99) - (familyOrder.includes(b) ? familyOrder.indexOf(b) : 99)))]
  const current = catalog?.currentModel ?? preferences.model
  const currentKey = catalog?.currentOptionKey ?? quotaModelOptionKey(current, device.billing === 'free' ? 'free' : 'quota')
  const currentOption = models.find(model => model.optionKey === currentKey)
  const visible = models.filter(model => query.trim()
    ? `${model.name} ${model.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    : family === '推荐' ? model.recommended : model.family === family
  ).sort((a, b) => {
    const priority = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'deepseek-v4.1-flash']
    const rank = (id: string) => priority.includes(id) ? priority.indexOf(id) : 99
    return rank(a.id) - rank(b.id) || b.name.localeCompare(a.name, 'zh-CN', { numeric: true })
  })
  const busy = disabled || Boolean(switching)
  const character = !query.trim() && visible.length > 0 ? familyCharacters[family] : undefined
  const switchModel = async (model: string, selection: QuotaModelSelection = {}) => {
    if (busy) return
    request.current++
    clearTimeout(retryTimer.current)
    setLoading(false); setSwitching(quotaModelOptionKey(model, selection.billing ?? 'quota', selection.account)); setFailed(false); setFeedback(`正在切换到 ${quotaModelMetadata(model).name}${selection.billing === 'free' ? '（免费版）' : ''}…`)
    try {
      const result = await window.modmind.device.selectModel(model, selection)
      if (!mounted.current) return
      setCatalog(result.catalog); setFailed(result.status !== 'ok'); setFeedback(result.status === 'ok' ? '' : result.message)
      if (result.preferences) onApplied(result.preferences)
      if (result.status !== 'ok') retryTimer.current = setTimeout(() => { void load(true) }, 3500)
    } catch (error) {
      if (mounted.current) { setFailed(true); setFeedback(error instanceof Error ? error.message : '切换未完成，请重试'); void load(true) }
    } finally { if (mounted.current) setSwitching(null) }
  }
  return <div className="quota-model-picker" ref={root} data-family-motion={animateFamily} data-family-direction={familyDirection}>
    <div className="quota-model-current"><span>当前 <strong>{quotaModelMetadata(current).name}{catalog?.billing === 'free' && <sup className="quota-free-mark" aria-label="免费版">免</sup>}{currentOption?.noCache && <span className="quota-no-cache-mark" title="上游明确标注此线路无缓存">无缓存</span>}</strong></span><span>{catalog?.billing === 'free' ? '当前使用免费套餐' : '消耗 ModMind 额度'}</span></div>
    <div className="quota-model-filter">
      <QuotaModelFamilies animated={animateFamily}>{families.map(value => <button type="button" key={value} aria-label={value} title={models.some(m => m.billing === 'free' && m.family === value) ? '包含免费版模型' : undefined} aria-pressed={family === value && !query} onClick={event => {
        if (value !== family || query) {
          setAnimateFamily(event.detail > 0)
          setFamilyDirection(families.indexOf(value) > families.indexOf(family) ? 'next' : 'previous')
          setFamily(value); setQuery('')
        }
      }}>{value}{value !== '推荐' && models.some(m => m.billing === 'free' && m.family === value) && <sup className="quota-free-mark" aria-hidden="true">免</sup>}</button>)}</QuotaModelFamilies>
      <div className="quota-model-search-actions"><label className="quota-model-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索额度模型" placeholder="搜索模型" value={query} onChange={event => { setAnimateFamily(false); setQuery(event.target.value) }} /></label><button type="button" className="icon-button" title="刷新额度模型" aria-label="刷新额度模型" disabled={loading || busy} onClick={() => { setFeedback(''); setFailed(false); void load(true) }}>{loading ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}</button></div>
    </div>
    <div className={`quota-model-list${character ? ' has-model-character' : ''}${character && visible.length > 6 ? ' has-many-models' : ''}`} aria-busy={loading}>
      {character && <QuotaModelCharacter family={family} src={character} animated={animateFamily} direction={familyDirection} />}
      <div className="quota-model-rows" key={query.trim() ? 'search' : family}>
      {visible.map(model => <div className="quota-model-row" key={model.optionKey} data-option-key={model.optionKey}>
        <div className="quota-model-copy"><strong>{model.name}{model.billing === 'free' && <sup className="quota-free-mark" aria-label="免费版">免</sup>}{model.noCache && <span className="quota-no-cache-mark" title="上游明确标注此线路无缓存">无缓存</span>}</strong>{model.description && <span>{model.description}</span>}</div>
        <button className="secondary-button compact quota-model-switch" type="button" aria-label={`切换到 ${model.name}${model.billing === 'free' ? ' 免费版' : ''}`} aria-current={currentKey === model.optionKey ? 'true' : undefined} title={model.unavailableReason}
          disabled={busy || !model.available || !catalog?.canSwitch || (currentKey === model.optionKey && !catalog?.recoveryRequired)} onClick={() => void switchModel(model.id, { billing: model.billing, ...(model.account ? { account: model.account } : {}) })}>
          {switching === model.optionKey ? '连接中' : currentKey === model.optionKey && !catalog?.recoveryRequired ? '使用中' : !model.available && catalog && !catalog.stale ? '未开放' : '切换'}
        </button>
      </div>)}
      {!visible.length && <div className="quota-model-empty">没有匹配的模型<button type="button" className="secondary-button compact" onClick={() => { setQuery(''); setFamily('推荐') }}>清除筛选</button></div>}
      </div>
    </div>
    <div className={`quota-model-feedback${failed ? ' is-error' : ''}`} role="status" aria-live="polite">{feedback || (loading ? '正在读取模型列表…' : '')}
      {device.status !== 'connected' && <button type="button" className="secondary-button compact" onClick={() => void window.modmind.device.authorize().catch(() => { setFailed(true); setFeedback('无法开始授权，请从账号入口重试') })}>连接账号</button>}
    </div>
    <details className="quota-model-advanced"><summary>高级设置</summary><fieldset disabled={busy || catalog?.recoveryRequired} aria-label="模型高级设置">
      {children}</fieldset></details>
  </div>
}
