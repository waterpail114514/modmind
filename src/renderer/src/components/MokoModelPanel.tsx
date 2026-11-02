import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import type { BeginnerAiPreferences, DeviceConnectionState } from '../../../shared/types'
import type { QuotaModelCatalog, QuotaModelOption } from '../../../shared/quotaModels'
import type { OnboardingModelChoice } from '../onboarding'
import type { MokoLine } from '../mokoDialogue'
import { groupModelCatalog, modelCatalogDefaultSelection, modelCatalogFailure, modelCatalogSelection } from './ModelCatalogRows'
import { loadQuotaModelCatalog } from '../loadQuotaModelCatalog'
import gptCharacter from '../assets/model-characters/gpt.webp'
import deepseekCharacter from '../assets/model-characters/deepseek.webp'

const choices = [
  { key: 'sol', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', nickname: '大白龙', billing: 'quota', art: gptCharacter },
  { key: 'deepseek', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', nickname: '大肥鱼', billing: 'free', art: deepseekCharacter }
] as const

function routeFor(catalog: QuotaModelCatalog | null, choice: typeof choices[number]): QuotaModelOption | undefined {
  const routes = (catalog?.models ?? []).filter(option => option.id === choice.id && option.billing === choice.billing && option.available !== false && option.modelEvidence !== 'unknown')
  const group = groupModelCatalog(routes, catalog?.currentOptionKey)[0]
  return group ? modelCatalogDefaultSelection(group) as QuotaModelOption | undefined : undefined
}

export default function MokoModelPanel({ account, onAccountChange, onApplied, onSelected, onNarrative, onBusyChange }: {
  account: DeviceConnectionState
  onAccountChange: (state: DeviceConnectionState) => void
  onApplied: (preferences: BeginnerAiPreferences) => void
  onSelected: (choice: OnboardingModelChoice) => void
  onNarrative: (line: MokoLine | null) => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<QuotaModelCatalog | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<OnboardingModelChoice>(), [needsBalance, setNeedsBalance] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true), inFlight = useRef(false)
  const identity = JSON.stringify([account.siteUrl, account.username, account.provider, account.providerId])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setCatalog(null); setSelected(undefined); setNeedsBalance(false)
    if (account.status !== 'connected' || account.provider === 'custom') { setLoading(false); return }
    void loadQuotaModelCatalog(saved => { if (active) setCatalog(saved) }).then(value => { if (active) setCatalog(value) })
      .catch(reason => { if (active) setError(modelCatalogFailure(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [identity, account.status])

  const readBalance = async (snapshot = catalog): Promise<boolean> => {
    const state = await window.modmind.device.refreshUsage({ force: true, account: routeFor(snapshot, choices[0])?.account })
    if (!mounted.current) return false
    onAccountChange(state)
    if (state.status !== 'connected' || state.provider === 'custom') throw new Error('账号连接已变化，请重新登录后选择模型。')
    if (!state.balanceCents || !/^\d+$/.test(state.balanceCents)) throw new Error('暂时没能读到余额，请刷新后再试。')
    const empty = /^0+$/.test(state.balanceCents)
    setNeedsBalance(empty)
    if (empty) onNarrative({ text: '大白龙可是要钱的哟！\n你的余额还是 0，先去官网充点值，再回来找她帮忙吧。', pose: 'think' })
    return !empty
  }

  const choose = async (choice: typeof choices[number]): Promise<void> => {
    if (inFlight.current || loading) return
    inFlight.current = true; setBusy(true); setError(''); setSelected(choice.key); setNeedsBalance(false)
    onNarrative({ text: choice.key === 'sol' ? '让我看看余额……' : '我去请大肥鱼来帮忙。', pose: 'think' })
    try {
      if (account.status !== 'connected' || account.provider === 'custom') throw new Error('连接 ModMind 账号后，再来选择模型吧。')
      if (choice.key === 'sol' && !await readBalance()) return
      if (!mounted.current) return
      const option = routeFor(catalog, choice)
      if (!option) throw new Error(choice.key === 'sol' ? '账号暂时没有可用的 Sol 线路，请刷新连接，或在官网同步后重试。' : '账号暂时没有可用的 DeepSeek 免费线路，请刷新连接，或换大白龙试试。')
      if (!catalog?.canSwitch) throw new Error(catalog?.message || '现在暂时不能切换模型，请稍后再试。')
      const result = await window.modmind.device.selectModel(option.id, { ...modelCatalogSelection(option), scope: 'settings' })
      if (!mounted.current) return
      setCatalog(result.catalog)
      if (result.preferences) onApplied(result.preferences)
      if (result.status !== 'ok') throw new Error(result.message)
      onSelected(choice.key)
    } catch (reason) {
      if (mounted.current) {
        setError(modelCatalogFailure(reason))
        onNarrative(choice.key === 'deepseek'
          ? { text: '大肥鱼这条免费线路暂时没连上。\n可以刷新连接再试一次，或者找大白龙来帮忙。', pose: 'think' }
          : { text: '暂时没能请到大白龙。\n重新检查一下连接，再来试试吧。', pose: 'think' })
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }

  const refresh = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const value = catalog?.protocolVersion === 2 ? await window.modmind.device.refreshConnections() : await window.modmind.device.getModelCatalog(true)
      if (!mounted.current) return
      setCatalog(value)
      if (needsBalance) {
        if (await readBalance(value)) onNarrative({ text: '余额已经有啦。\n点「请她帮忙」，就可以继续啦！', pose: 'welcome' })
      } else onNarrative(null)
    } catch (reason) { if (mounted.current) setError(modelCatalogFailure(reason)) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const openSite = async (): Promise<void> => {
    try { await window.modmind.device.openSite() }
    catch (reason) { if (mounted.current) setError(modelCatalogFailure(reason)) }
  }

  return <section className="moko-workflow-panel moko-model-panel" aria-label="选择帮忙的模型">
    <div className="moko-model-grid" role="group" aria-label="模型选项">{choices.map(choice => {
      const available = Boolean(routeFor(catalog, choice))
      return <button className={`moko-model-choice${selected === choice.key ? ' selected' : ''}`} type="button" key={choice.key} aria-pressed={selected === choice.key} aria-label={`选择 ${choice.name}，${choice.nickname}`} disabled={loading || busy} onClick={() => { setSelected(current => current === choice.key ? undefined : choice.key); setNeedsBalance(false); setError(''); onNarrative(null) }}>
        <span className="moko-model-art"><img className="moko-model-glow" src={choice.art} alt="" draggable={false} /><img className="moko-model-silhouette" src={choice.art} alt="" draggable={false} /><img className="moko-model-lit" src={choice.art} alt="" draggable={false} /></span>
        <span className="moko-model-copy"><strong>{choice.name}</strong><span>{choice.nickname} · {choice.billing === 'free' ? '免费额度' : '按用量付费'}</span><span className="moko-model-availability">{loading ? '正在读取线路…' : busy && selected === choice.key ? '正在连接…' : !catalog ? '列表暂不可用' : available ? '可选择' : choice.billing === 'free' ? '暂无免费线路' : '暂无线路'}</span></span>
        {selected === choice.key ? <Check className="moko-model-check" size={20} /> : null}
      </button>
    })}</div>
    <div className="moko-panel-actions">
      {needsBalance ? <button className="primary-button" disabled={busy} onClick={() => void openSite()}><ExternalLink size={16} />去官网充值</button> : null}
      {!needsBalance ? <button className="primary-button" disabled={loading || busy || !selected} onClick={() => { const choice = choices.find(value => value.key === selected); if (choice) void choose(choice) }}>{busy ? <LoaderCircle size={16} className="spin" /> : null}{busy ? '正在请她帮忙…' : '请她帮忙'}</button> : null}
      <button className="moko-text-button" disabled={busy || loading} onClick={() => void refresh()}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{needsBalance ? '刷新余额' : '刷新连接'}</button>
      {error ? <div className="moko-model-feedback"><p className="moko-panel-error" role="alert"><CircleAlert size={16} />{error}</p></div> : null}
    </div>
  </section>
}
