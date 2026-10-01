import { reportClientFailure } from '../../../src/renderer/src/lib/clientFailure'
import { useEffect, useMemo, useState } from 'react'
import { FileCheck2, Gauge, LoaderCircle, PackageSearch, ShieldCheck, Sparkles } from 'lucide-react'
import type { ModpackProviderInfo, ProjectInfo } from '../../../src/shared/types'

type PlanEntry = { request: string; parent?: string; dependencyKind?: string; blocking?: boolean; selected?: { filename?: string; provider?: string; projectId?: string }; reason?: string }
type ModpackPlanView = { success?: boolean; required?: PlanEntry[]; optional?: PlanEntry[]; dependencies?: PlanEntry[]; conflicts?: string[]; warnings?: string[]; review?: { installCount?: number; providers?: string[]; unresolved?: number; optionalSuggestions?: number } }
type OptimizationProfileView = { id: string; name: string; description?: string }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function commaList(value: string): string[] { return [...new Set(value.split(/[，,\n]/).map(item => item.trim()).filter(Boolean))] }

export default function ModpackToolsWorkspace({ project, section }: { project: ProjectInfo; section: 'automation' }): React.JSX.Element {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [plan, setPlan] = useState<ModpackPlanView | null>(null)
  const [profiles, setProfiles] = useState<OptimizationProfileView[]>([])
  const [selectedProfile, setSelectedProfile] = useState('safe-client')
  const [requiredMods, setRequiredMods] = useState('')
  const [optionalMods, setOptionalMods] = useState('')
  const [excludedMods, setExcludedMods] = useState('')
  const [providers, setProviders] = useState<ModpackProviderInfo[]>([])
  const [enabledProviders, setEnabledProviders] = useState<string[]>([])
  useEffect(() => {
    void Promise.all([window.modmind.modpack.listOptimizationProfiles(), window.modmind.modpack.providers()]).then(([value, available]) => {
      const next = Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => typeof item.id === 'string' && typeof item.name === 'string').map((item) => ({ id: String(item.id), name: String(item.name), description: typeof item.description === 'string' ? item.description : undefined })) : []
      setProfiles(next)
      if (next.length && !next.some((profile) => profile.id === selectedProfile)) setSelectedProfile(next[0].id)
      const nextProviders = Array.isArray(available) ? available as ModpackProviderInfo[] : []
      setProviders(nextProviders)
      setEnabledProviders(nextProviders.map((provider) => provider.id))
    }).catch((error) => setNotice(reportClientFailure(error)))
  }, [section])

  const selectedProfileInfo = useMemo(() => profiles.find((profile) => profile.id === selectedProfile), [profiles, selectedProfile])

  const run = (key: string, action: () => Promise<unknown>, success: (value: unknown) => string): void => {
    if (busy) return
    setBusy(key)
    setNotice('')
    void action().then((value) => {
      if (asRecord(value).success === false) throw new Error(String(asRecord(value).message ?? '验证未通过'))
      setNotice(success(value))
    }).catch((error) => {
      setNotice(reportClientFailure(error))
    }).finally(() => setBusy(''))
  }

  const createPlan = (): void => {
    run('plan', () => window.modmind.modpack.plan({ required: commaList(requiredMods), optional: commaList(optionalMods), excluded: commaList(excludedMods), ...(enabledProviders.length ? { providers: enabledProviders } : {}) }), (value) => {
      const next = value as ModpackPlanView
      setPlan(next)
      const resolved = [...(next.required ?? []), ...(next.optional ?? [])].filter((entry) => entry.selected).length
      return next.success ? `方案已生成，可安装 ${resolved} 个 Mod` : `方案存在未解决项，请先处理 ${next.warnings?.length ?? 0} 条提示`
    })
  }

  const renderAutomation = (): React.JSX.Element => <>
    <h1 className="visually-hidden">依赖与优化</h1>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><PackageSearch size={18} /><div><h2>Mod 方案</h2><p>每行一个名称，或用逗号分隔</p></div></div>
      <div className="modpack-form-grid"><label>必需 Mod<textarea value={requiredMods} onChange={(event) => setRequiredMods(event.target.value)} placeholder="例如：Create，FTB Quests" /></label><label>可选 Mod<textarea value={optionalMods} onChange={(event) => setOptionalMods(event.target.value)} placeholder="例如：JEI，Jade" /></label><label>排除 Mod<textarea value={excludedMods} onChange={(event) => setExcludedMods(event.target.value)} placeholder="例如：OptiFine" /></label></div>
      <div className="modpack-tool-actions"><button className="primary-button" disabled={Boolean(busy) || !commaList(requiredMods).length} onClick={createPlan}>{busy === 'plan' ? <LoaderCircle className="spin" size={16} /> : <PackageSearch size={16} />}生成方案</button><button className="secondary-button" disabled={Boolean(busy) || !plan?.success} onClick={() => run('apply-plan', () => window.modmind.modpack.applyPlan(plan), (value) => `已安装 ${Array.isArray(asRecord(value).installed) ? (asRecord(value).installed as unknown[]).length : 0} 个 Mod，并已完成锁定审计`)}>{busy === 'apply-plan' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}安装方案</button></div>
      {providers.length ? <div className="modpack-provider-options" aria-label="搜索平台">{providers.map((provider) => <label key={provider.id} className="check-row"><input type="checkbox" checked={enabledProviders.includes(provider.id)} onChange={() => setEnabledProviders((current) => current.includes(provider.id) ? current.filter((id) => id !== provider.id) : [...current, provider.id])} />{provider.label}<small>{provider.supportsDependencies ? '支持前置解析' : '仅搜索'}</small></label>)}</div> : null}
      {plan ? <div className={`modpack-result ${plan.success ? 'success' : 'warning'}`}><strong>{plan.success ? '方案可安装' : '方案待处理'}</strong>{[...(plan.required ?? []), ...(plan.optional ?? []), ...(plan.dependencies ?? [])].map((entry) => <span key={`${entry.request}-${entry.selected?.filename ?? entry.reason}`} className={entry.parent ? 'dependency-result' : undefined}>{entry.parent ? `${entry.parent} → ` : ''}{entry.request}：{entry.selected?.filename ?? entry.reason ?? '未解析'}</span>)}{plan.review ? <span>审核摘要：预计安装 {plan.review.installCount ?? 0} 个，未解决 {plan.review.unresolved ?? 0} 项{plan.review.optionalSuggestions ? `，可选前置 ${plan.review.optionalSuggestions} 项` : ''}</span> : null}{plan.conflicts?.map((conflict) => <span key={conflict}>冲突：{conflict}</span>)}{plan.warnings?.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><ShieldCheck size={18} /><div><h2>锁定审计</h2></div></div>
      <div className="modpack-tool-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => run('audit', () => window.modmind.modpack.auditLock(), (value) => { const audit = asRecord(value); return audit.success ? `锁定审计通过，已检查 ${String(audit.checked ?? 0)} 个文件` : `锁定审计失败：${Array.isArray(audit.errors) ? audit.errors.join('；') : '请查看项目日志'}` })}>{busy === 'audit' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}审计锁定</button><button className="icon-button" title="读取锁定清单" disabled={Boolean(busy)} onClick={() => run('read-lock', () => window.modmind.modpack.readLock(), (value) => `当前锁定 ${Array.isArray(asRecord(value).mods) ? (asRecord(value).mods as unknown[]).length : 0} 个 Mod`)}><FileCheck2 size={16} /></button></div>
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><Gauge size={18} /><div><h2>性能优化</h2></div></div>
      <div className="modpack-tool-actions"><label className="inline-field">优化档<select value={selectedProfile} onChange={(event) => setSelectedProfile(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><button className="secondary-button" disabled={Boolean(busy) || !selectedProfile} onClick={() => run('optimization', () => window.modmind.modpack.applyOptimizationProfile({ profileId: selectedProfile }), (value) => { const result = asRecord(value); return `已应用优化档；配置修改 ${Array.isArray(result.appliedPatches) ? result.appliedPatches.length : 0} 项，提示 ${Array.isArray(result.warnings) ? result.warnings.length : 0} 条` })}>{busy === 'optimization' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}应用优化</button></div>
      {selectedProfileInfo?.description ? <p className="modpack-inline-note">{selectedProfileInfo.description}</p> : null}
    </section>
  </>

  return <div className="modpack-tool-workspace" data-section={section}>{renderAutomation()}{notice ? <div className="toast">{notice}</div> : null}</div>
}
