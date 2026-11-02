import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoaderCircle, RotateCcw, Search } from 'lucide-react'
import type { AiModelInfo, BeginnerAiPreferences, DeviceConnectionState } from '../../../shared/types'
import type { QuotaModelCatalog } from '../../../shared/quotaModels'
import { quotaModelDisplayMetadata, quotaModelOptionKey } from '../../../shared/quotaModels'
import { deviceModelCatalogKey } from '../../../shared/deviceModelCatalog'
import { loadQuotaModelCatalog } from '../loadQuotaModelCatalog'
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
import ModelCatalogRows, { filterModelCatalog, modelCatalogFamilies, modelCatalogFailure, modelCatalogKey, modelCatalogRouteLabel, modelCatalogSelection } from './ModelCatalogRows'

const familyCharacters: Record<string, string> = {
  推荐: modmindCharacter, 全部: modmindCharacter,
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
  const [scanning, setScanning] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [selectionError, setSelectionError] = useState<{ model: string; account?: string; message: string }>()
  const request = useRef(0)
  const mounted = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout>>()
  const discovery = useRef(false)
  const catalogIdentity = useRef<string>()
  const catalogOwner = useRef<string>()
  const ownerIdentity = device.status === 'disconnected' ? undefined : JSON.stringify([device.siteUrl, device.username, device.provider, device.providerId])
  if (device.status === 'connected') catalogIdentity.current = deviceModelCatalogKey(device)
  else if (device.status === 'disconnected') catalogIdentity.current = undefined
  const load = useCallback(async (force = false, discover = false) => {
    if (discovery.current) return
    if (discover) { discovery.current = true; setScanning(true) }
    const sequence = ++request.current
    setLoading(true)
    try {
      const value = await loadQuotaModelCatalog(saved => {
        if (mounted.current && sequence === request.current) setCatalog(saved)
      }, discover, force)
      if (mounted.current && sequence === request.current) { setCatalog(value); setFeedback(value.stale ? value.message || '无法更新模型列表，请重试' : ''); setFailed(value.stale) }
    } catch {
      if (mounted.current && sequence === request.current) { setFeedback('无法读取模型列表，请重试'); setFailed(true) }
    } finally {
      if (discover) { discovery.current = false; if (mounted.current) setScanning(false) }
      if (mounted.current && sequence === request.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++; clearTimeout(retryTimer.current) }
  }, [])
  useEffect(() => {
    if (catalogOwner.current !== ownerIdentity) { request.current++; setCatalog(null); setSelectionError(undefined) }
    catalogOwner.current = ownerIdentity
  }, [ownerIdentity])
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
    if (device.provider === 'custom' || !catalogIdentity.current) return
    let started = false
    const observer = new IntersectionObserver(entries => {
      if (!started && entries.some(entry => entry.isIntersecting)) { started = true; void load(); observer.disconnect() }
    })
    if (root.current) observer.observe(root.current)
    return () => { observer.disconnect(); if (!discovery.current) request.current++ }
  }, [catalogIdentity.current, preferences.model, preferences.account, preferences.group, load])
  useLayoutEffect(() => {
    const element = list.current, content = rows.current
    if (!element || !content || device.provider === 'custom' || query.trim()) return
    const measure = (): void => {
      // Measure the rows, never the frame whose minimum height we update. Keep
      // the last useful size during loading and in empty/search states.
      const bottom = content.getBoundingClientRect().height
      if (bottom > 0) element.style.setProperty('--character-frame-height', `${Math.max(560, Math.ceil(bottom) + 16)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [device.provider, family, query, catalog])
  if (device.provider === 'custom') return <>{children}</>
  const models = (catalog?.models ?? []).filter(model => model.modelEvidence !== 'unknown')
  const families = modelCatalogFamilies(models)
  const activeFamily = families.includes(family) ? family : '推荐'
  const current = catalog?.currentModel ?? preferences.model
  const currentKey = catalog?.currentOptionKey ?? quotaModelOptionKey(current, device.billing === 'free' ? 'free' : 'quota', preferences.account, preferences.group)
  const currentOption = models.find(model => model.optionKey === currentKey)
  const visible = filterModelCatalog(models, activeFamily, query, currentKey)
  const busy = disabled || Boolean(switching) || scanning
  const character = !query.trim() && visible.length > 0 ? familyCharacters[activeFamily] : undefined
  const switchModel = async (option: AiModelInfo) => {
    if (busy) return
    const model = option.id, selection = modelCatalogSelection(option)
    request.current++
    clearTimeout(retryTimer.current)
    setLoading(false); setSwitching(modelCatalogKey(option)); setFailed(false); setSelectionError(undefined); setFeedback(`正在切换到 ${quotaModelDisplayMetadata(option).name}…`)
    try {
      const result = await window.modmind.device.selectModel(model, { ...selection, scope: 'settings' })
      if (!mounted.current) return
      setCatalog(result.catalog); setFailed(result.status !== 'ok'); setFeedback(result.status === 'ok' ? '' : modelCatalogFailure(result.message))
      if (result.status !== 'ok') setSelectionError({ model, account: option.account, message: modelCatalogFailure(result.message) })
      if (result.preferences) onApplied(result.preferences)
      if (result.status !== 'ok' && !result.requiresProviderSync) retryTimer.current = setTimeout(() => { void load(true) }, 3500)
    } catch (error) {
      if (mounted.current) { const message = modelCatalogFailure(error); setFailed(true); setSelectionError({ model, account: option.account, message }); setFeedback(message); void load(true) }
    } finally { if (mounted.current) setSwitching(null) }
  }
  return <div className="quota-model-picker" ref={root} data-family-motion={animateFamily} data-family-direction={familyDirection}>
    <div className="quota-model-current"><span>当前 <strong>{quotaModelDisplayMetadata(currentOption ?? { id: current }).name}{catalog?.billing === 'free' && <sup className="quota-free-mark" aria-label="免费版">免</sup>}{currentOption?.noCache && <span className="quota-no-cache-mark" title="上游明确标注此线路无缓存">无缓存</span>}</strong>{currentOption && <span className="quota-model-current-source" title={modelCatalogRouteLabel(currentOption)}>{modelCatalogRouteLabel(currentOption)}</span>}{catalog?.selectionRequired ? <span>请重新选择模型</span> : null}</span></div>
    <div className="quota-model-filter">
      <QuotaModelFamilies animated={animateFamily}>{families.map(value => <button type="button" key={value} aria-label={value} title={models.some(m => m.billing === 'free' && m.family === value) ? '包含免费版模型' : undefined} aria-pressed={activeFamily === value && !query} onClick={event => {
        if (value !== family || query) {
          setAnimateFamily(event.detail > 0)
          setFamilyDirection(families.indexOf(value) > families.indexOf(family) ? 'next' : 'previous')
          setFamily(value); setQuery('')
        }
      }}>{value}{value !== '推荐' && models.some(m => m.billing === 'free' && m.family === value) && <sup className="quota-free-mark" aria-hidden="true">免</sup>}</button>)}</QuotaModelFamilies>
      <div className="quota-model-search-actions"><label className="quota-model-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => { setAnimateFamily(false); setQuery(event.target.value) }} /></label><button type="button" className="icon-button" title="刷新模型与连接" aria-label="刷新模型与连接" disabled={loading || busy} onClick={() => { setFeedback(''); setFailed(false); setSelectionError(undefined); void load(true, true) }}>{loading ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}</button></div>
    </div>
    <div className={`quota-model-list${character ? ' has-model-character' : ''}`} ref={list} aria-busy={loading}>
      {character && <QuotaModelCharacter family={activeFamily} src={character} animated={animateFamily} direction={familyDirection} />}
      <div className="quota-model-rows" ref={rows} key={query.trim() ? 'search' : activeFamily}>
        {failed && feedback && !selectionError ? <div className="model-catalog-error" role="status">{feedback}</div> : null}
        {models.length ? <ModelCatalogRows models={visible} catalogModels={models} routeChoiceScope="settings" query={query} currentKey={currentKey} currentModelId={current} switchingKey={switching} disabled={busy || !catalog?.canSwitch} selectionRequired={catalog?.selectionRequired || catalog?.recoveryRequired} selectionError={selectionError} onSelect={option => void switchModel(option)} /> : <div className="quota-model-empty">{loading ? '正在读取模型列表…' : catalog?.stale ? '模型列表暂不可用，请刷新重试' : device.status === 'connected' ? '暂无可用模型，请刷新重试' : '连接账号后查看可用模型'}</div>}
        {device.status !== 'connected' && <button type="button" className="secondary-button compact" onClick={() => void window.modmind.device.authorize().catch(() => { setFailed(true); setFeedback('无法开始授权，请从账号入口重试') })}>连接账号</button>}
      </div>
    </div>
    <details className="quota-model-advanced"><summary>高级设置</summary><fieldset disabled={busy || catalog?.recoveryRequired} aria-label="模型高级设置">
      {children}</fieldset></details>
  </div>
}
