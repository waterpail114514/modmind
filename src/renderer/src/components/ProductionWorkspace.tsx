import { useEffect, useId, useState } from 'react'
import { Check, CircleAlert, CloudUpload, Download, LoaderCircle, Settings2, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { ReleasePreflightResult, ReleasePublishResult, ReleaseSettings } from '../../../shared/production'
import type { ProjectInfo } from '../../../shared/types'
import { reportClientFailure as errorMessage } from '../lib/clientFailure'
import { useConfirmDialog } from './InteractionDialogs'
import { defaultRelease, RELEASE_SETTINGS_CHANGED } from './releaseSettings'
import { useReleaseDraft } from './useReleaseDraft'
import './workspace-tabs.css'
import './authoring-pages.css'
import MoreActions from './MoreActions'

type PublishTarget = 'modrinth' | 'curseforge' | 'github'

function ReleasePane({ project, active, onOpenSettings }: { project: ProjectInfo; active: boolean; onOpenSettings: () => void }): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const { settings, update: updateDraft, save: saveDraft, loading, error, dirty } = useReleaseDraft(project, active)
  const [targets, setTargets] = useState<PublishTarget[]>([])
  const [preflight, setPreflight] = useState<ReleasePreflightResult | null>(null)
  const [results, setResults] = useState<ReleasePublishResult[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeTone, setNoticeTone] = useState<'success' | 'error'>('success')
  const statusId = useId()

  useEffect(() => {
    const invalidate = (): void => setPreflight(null)
    invalidate()
    window.addEventListener(RELEASE_SETTINGS_CHANGED, invalidate)
    return () => window.removeEventListener(RELEASE_SETTINGS_CHANGED, invalidate)
  }, [active])

  const update = <K extends keyof ReleaseSettings>(key: K, value: ReleaseSettings[K]): void => {
    updateDraft(key, value)
    setPreflight(null)
    setResults([])
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setPreflight(null)
    setNotice('')
    try {
      await saveDraft()
      setNoticeTone('success')
      setNotice('草稿已保存')
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const check = async (): Promise<void> => {
    setBusy('check')
    setResults([])
    setPreflight(null)
    setNotice('')
    try {
      await saveDraft()
      setPreflight(await window.modmind.production.release.preflight())
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const publish = async (): Promise<void> => {
    if (!preflight?.ready) {
      setNotice('请先完成预检并修复失败项')
      return
    }
    if (!targets.length || !await requestConfirm({ title: `确认发布 ${settings.version}？`, message: `目标：${targets.join('、')}\n\n这是不可自动撤销的外部操作`, confirmLabel: '确认发布', tone: 'danger', actionIcon: 'continue' })) return
    setBusy('publish')
    setResults([])
    setNotice('')
    try {
      setResults(await window.modmind.production.release.publish({ targets, confirmed: true }))
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const toggle = (target: PublishTarget): void => {
    setTargets(current => current.includes(target) ? current.filter(item => item !== target) : [...current, target])
    setResults([])
  }

  const platforms = [
    { id: 'modrinth' as const, label: 'Modrinth', binding: settings.modrinthProjectId, configured: Boolean(settings.modrinthProjectId && settings.hasModrinthToken) },
    { id: 'curseforge' as const, label: 'CurseForge', binding: settings.curseForgeProjectId, configured: Boolean(settings.curseForgeProjectId && settings.hasCurseForgeToken) },
    { id: 'github' as const, label: 'GitHub', binding: settings.githubRepository, configured: Boolean(settings.githubRepository && settings.hasGithubToken) }
  ]
  const status = loading ? '正在读取配置…' : busy === 'check' ? '正在保存并预检…' : busy === 'publish' ? '正在发布…' : busy === 'save' ? '正在保存草稿…'
    : results.length ? results.every(result => result.success) ? '发布完成' : '发布未全部成功' : dirty ? '未保存，预检时保存' : !targets.length ? '请选择发布平台' : !preflight ? '请先完成预检' : !preflight.ready ? '预检未通过' : '可以发布'

  return <div className="production-pane release-pane authoring-workspace">
    <h2 className="visually-hidden">发布</h2>
    <fieldset className="authoring-fields authoring-release-fields" disabled={loading || Boolean(error) || Boolean(busy)}>
      <label>版本<input value={settings.version} onChange={event => update('version', event.target.value)} /></label>
      <label>显示名称<input value={settings.displayName} onChange={event => update('displayName', event.target.value)} /></label>
      <label>通道<select aria-label="通道" value={settings.channel} onChange={event => update('channel', event.target.value as ReleaseSettings['channel'])}><option value="release">Release</option><option value="beta">Beta</option><option value="alpha">Alpha</option></select></label>
      <label className="authoring-field-wide">更新日志<textarea aria-label="更新日志" value={settings.changelog} onChange={event => update('changelog', event.target.value)} /></label>
      <details className="authoring-details authoring-field-wide"><summary>摘要</summary><div className="authoring-fields"><label className="authoring-field-wide"><span className="visually-hidden">摘要</span><textarea aria-label="摘要" value={settings.summary ?? ''} onChange={event => update('summary', event.target.value)} /></label></div></details>
    </fieldset>
    <section className="authoring-platforms" aria-label="发布平台">
      <div className="authoring-section-heading"><h3>发布平台</h3><button className="icon-button" type="button" title="配置发布平台" aria-label="配置发布平台" disabled={Boolean(busy)} onClick={onOpenSettings}><Settings2 size={16} /></button></div>
      <div className="authoring-platform-options">{platforms.map(platform => <label key={platform.id}>
        <input type="checkbox" aria-label={platform.label} checked={targets.includes(platform.id)} disabled={loading || Boolean(busy)} onChange={() => toggle(platform.id)} />
        <span className="authoring-platform-name">{platform.label}</span><span className={platform.configured ? 'authoring-platform-binding' : 'authoring-platform-missing'} title={platform.configured ? platform.binding : undefined}>{platform.configured ? platform.binding : '未配置'}</span>
      </label>)}</div>
    </section>
    {preflight ? <div className="release-checks" aria-label="预检结果">{preflight.checks.map(item => <div className={item.status} key={item.id}>
      <span title={item.status === 'pass' ? '通过' : item.status === 'fail' ? '失败' : '提示'}>{item.status === 'pass' ? <Check size={14} /> : <CircleAlert size={14} />}</span><strong>{item.label}</strong><p>{item.detail}</p>
    </div>)}</div> : null}
    <div className="authoring-actions authoring-release-actions">
      <span id={statusId} className="authoring-status" role="status">{status}</span>
      <MoreActions label="发布更多操作"><button type="button" disabled={loading || Boolean(error) || Boolean(busy)} onClick={() => void save()}><Check size={15} />保存草稿</button></MoreActions>
      <button className="secondary-button" disabled={loading || Boolean(error) || Boolean(busy)} onClick={() => void check()}>{busy === 'check' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}保存并预检</button>
      <button className="primary-button" aria-describedby={statusId} disabled={loading || Boolean(error) || !targets.length || Boolean(busy) || !preflight?.ready} onClick={() => void publish()}>{busy === 'publish' ? <LoaderCircle className="spin" size={15} /> : <CloudUpload size={15} />}确认发布</button>
    </div>
    {error || notice ? <div className={`authoring-feedback ${error ? 'error' : noticeTone}`} role={error || noticeTone === 'error' ? 'alert' : 'status'}>{error || noticeTone === 'error' ? <CircleAlert size={15} /> : <Check size={15} />}<span>{error || notice}</span></div> : null}
    {results.length ? <div className="publish-results">{results.map(result => <div className={result.success ? 'success' : 'error'} key={result.target}>{result.success ? <Check size={14} /> : <X size={14} />}<strong>{platforms.find(platform => platform.id === result.target)?.label ?? result.target}</strong><span>{result.detail}{result.url ? <> · <a href={result.url} target="_blank" rel="noreferrer">查看发布</a></> : null}</span></div>)}</div> : null}
    {confirmDialog}
  </div>
}

function ModpackDeliveryPane({ project }: { project: ProjectInfo }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [settings, setSettings] = useState<ReleaseSettings>(() => defaultRelease(project))

  useEffect(() => {
    void window.modmind.production.release.getSettings().then(setSettings).catch((error) => setNotice(errorMessage(error)))
  }, [project.path])

  const update = <K extends keyof ReleaseSettings>(key: K, value: ReleaseSettings[K]): void => setSettings((current) => ({ ...current, [key]: value }))

  const suggestSummary = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      const draft = await window.modmind.production.release.suggestSummary()
      setSettings((current) => ({ ...current, summary: draft.summary, changelog: draft.changelog || current.changelog }))
      setNotice(draft.generatedBy === 'ai' ? 'AI 已生成可编辑的摘要和更新日志草稿' : '已根据本地整合包内容生成摘要草稿；连接 AI 后可获得更精炼的文案')
    } catch (error) {
      setNotice(`生成摘要失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const exportPack = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      await window.modmind.production.release.saveSettings(settings)
      const target = await window.modmind.project.exportArtifact()
      if (target) {
        setSettings(await window.modmind.production.release.getSettings())
        setNotice(`整合包已导出到 ${target}`)
      }
    } catch (error) {
      setNotice(`导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const exportServerPack = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      const target = await window.modmind.modpack.exportServerPack()
      if (target) setNotice(`服务端包已导出：${target}`)
    } catch (error) {
      setNotice(`服务端包导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return <div className="production-page">
    <h1 className="visually-hidden">交付</h1>
    <section className="production-pane modpack-delivery-pane">
      <div><h2>版本与导出</h2></div>
      <div className="release-form modpack-release-form">
        <label>版本<input value={settings.version} onChange={(event) => update('version', event.target.value)} /></label>
        <label>显示名称<input value={settings.displayName} onChange={(event) => update('displayName', event.target.value)} /></label>
        <label>自动递增<select value={settings.bumpMode ?? 'patch'} onChange={(event) => update('bumpMode', event.target.value as NonNullable<ReleaseSettings['bumpMode']>)}><option value="patch">Patch</option><option value="minor">Minor</option><option value="major">Major</option></select></label>
        <label className="check-row"><input type="checkbox" checked={settings.autoBump !== false} onChange={(event) => update('autoBump', event.target.checked)} />导出成功后自动递增</label>
        <label className="release-changelog">摘要<textarea aria-label="摘要" value={settings.summary ?? ''} onChange={(event) => update('summary', event.target.value)} placeholder="用于 Modrinth 整合包摘要" /></label>
        <label className="release-changelog">更新日志<textarea aria-label="更新日志" value={settings.changelog} onChange={(event) => update('changelog', event.target.value)} placeholder="说明这次交付的变化" /></label>
      </div>
      <div className="modpack-delivery-actions"><button className="secondary-button" disabled={busy} onClick={() => void suggestSummary()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}AI 草拟摘要</button><button className="secondary-button" disabled={busy} onClick={() => void exportServerPack()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导出服务端包</button><button className="primary-button" disabled={busy} onClick={() => void exportPack()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导出 .mrpack</button></div>
      {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    </section>
  </div>
}

export default function ProductionWorkspace({ project, active = true, onOpenSettings }: { project: ProjectInfo; active?: boolean; onOpenSettings: () => void }): React.JSX.Element {
  if (project.kind === 'modpack') return <ModpackDeliveryPane project={project} />
  return <div className="production-page"><ReleasePane project={project} active={active} onOpenSettings={onOpenSettings} /></div>
}
