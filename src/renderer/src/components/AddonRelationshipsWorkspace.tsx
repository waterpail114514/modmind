import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Binary,
  Check,
  CircleAlert,
  FileArchive,
  FolderGit2,
  Link2,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type {
  AddonImportMatch,
  AddonImportReview,
  AddonImportSelection,
  AddonRelationship,
  AddonRelationshipManifest,
  AddonRelationshipRole,
  AddonSearchHit,
  AddonSearchProvider,
  AddonVersionOption
} from '../../../shared/production'
import type { ProjectInfo } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

function errorMessage(error: unknown): string { return reportClientFailure(error) }
function formatBytes(value: number): string { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB` }
function roleLabel(role: AddonRelationshipRole): string { return role === 'required' ? '必须安装' : role === 'optional' ? '可选联动' : '仅测试' }
function providerLabel(provider: AddonRelationship['provider'] | AddonSearchProvider): string {
  if (provider === 'modrinth') return 'Modrinth'
  if (provider === 'curseforge') return 'CurseForge'
  if (provider === 'mcmod') return 'MC百科'
  if (provider === 'modmind-project') return 'ModMind 项目'
  return '私人定制'
}

type ImportChoice = { role: AddonRelationshipRole; value: string }

function matchValue(match: Pick<AddonImportMatch, 'provider' | 'projectId' | 'versionId'>): string {
  return `${match.provider}|${match.projectId}|${match.versionId}`
}

function importMatches(review: AddonImportReview, itemId: string): AddonImportMatch[] {
  const item = review.items.find((entry) => entry.id === itemId)
  return item ? [...(item.match ? [item.match] : []), ...item.candidates] : []
}

function AddonSearchSkeleton(): React.JSX.Element {
  return <div className="addon-search-skeleton" role="status" aria-label="正在加载搜索结果">
    {Array.from({ length: 6 }, (_, index) => <div className="addon-search-skeleton-row" key={index}>
      <span className="addon-skeleton-block addon-skeleton-icon" />
      <span className="addon-skeleton-copy"><i className="addon-skeleton-block" /><i className="addon-skeleton-block" /></span>
    </div>)}
  </div>
}

export default function AddonRelationshipsWorkspace({ project, beginner, onFilesChanged, onDecompile }: { project: ProjectInfo; beginner: boolean; onFilesChanged?: () => void; onDecompile?: (jarPath: string) => void }): React.JSX.Element {
  const { confirm, dialog } = useConfirmDialog()
  const [manifest, setManifest] = useState<AddonRelationshipManifest | null>(null)
  const [providers, setProviders] = useState<Array<{ id: AddonSearchProvider; label: string }>>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<AddonSearchHit[]>([])
  const [recommendations, setRecommendations] = useState<AddonSearchHit[]>([])
  const [resultsLoading, setResultsLoading] = useState(true)
  const [selected, setSelected] = useState<AddonSearchHit | null>(null)
  const [versions, setVersions] = useState<AddonVersionOption[]>([])
  const [versionId, setVersionId] = useState('')
  const [role, setRole] = useState<AddonRelationshipRole>('required')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [review, setReview] = useState<AddonImportReview | null>(null)
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({})
  const [mcmodCaptcha, setMcmodCaptcha] = useState<{ sessionId: string; captchaDataUrl: string; attemptsRemaining: number } | null>(null)
  const [mcmodCaptchaInput, setMcmodCaptchaInput] = useState('')

  const refresh = async (): Promise<void> => {
    setResultsLoading(true)
    try {
      const [nextManifest, nextProviders] = await Promise.all([
        window.modmind.production.relationships.list(),
        window.modmind.production.relationships.providers()
      ])
      setManifest(nextManifest)
      setProviders(nextProviders)
      const recommended = await window.modmind.production.relationships.recommendations().catch(() => [])
      setRecommendations(recommended)
      setHits(recommended)
    } finally {
      setResultsLoading(false)
    }
  }

  useEffect(() => {
    setManifest(null); setHits([]); setRecommendations([]); setSelected(null); setVersions([]); setNotice(''); setResultsLoading(true)
    void refresh().catch((error) => setNotice(errorMessage(error)))
  }, [project.path])

  const direct = useMemo(() => manifest?.relationships.filter((entry) => !entry.automatic) ?? [], [manifest])
  const automatic = useMemo(() => manifest?.relationships.filter((entry) => entry.automatic) ?? [], [manifest])

  const changed = async (next: AddonRelationshipManifest, message: string): Promise<void> => {
    setManifest(next)
    setNotice(message)
    onFilesChanged?.()
  }

  const search = async (): Promise<void> => {
    if (!query.trim() || busy) return
    setBusy('search'); setNotice(''); setSelected(null); setVersions([]); setResultsLoading(true)
    try {
      const result = await window.modmind.production.relationships.search(query, providers.map((entry) => entry.id))
      setHits(result)
      if (!result.length) setNotice(`没有找到适配 ${project.minecraftVersion} / ${project.loader} 的模组`)
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy(''); setResultsLoading(false) }
  }

  const chooseHit = async (hit: AddonSearchHit): Promise<void> => {
    if (busy) return
    setSelected(hit); setVersions([]); setVersionId(''); setBusy(`versions:${hit.provider}:${hit.projectId}`); setNotice('')
    try {
      const result = await window.modmind.production.relationships.versions(hit.provider, hit.projectId)
      setVersions(result)
      setVersionId(result[0]?.versionId ?? '')
      if (!result.length) setNotice('没有可用的兼容版本')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const installSelected = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy('install'); setNotice('')
    try {
      if (selected.provider === 'mcmod') {
        const version = versions.find((entry) => entry.versionId === versionId)
        if (!version?.fileKey) throw new Error('MC百科版本文件无效')
        setMcmodCaptcha(await window.modmind.production.relationships.beginMcmodDownload(selected.projectId, version.fileKey))
        setMcmodCaptchaInput('')
        return
      }
      const next = await window.modmind.production.relationships.installPlatform({ provider: selected.provider, projectId: selected.projectId, versionId: versionId || undefined, name: selected.name, role })
      await changed(next, `${selected.name} 及所需前置已经准备完成`)
      setHits([]); setSelected(null); setVersions([]); setQuery('')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const submitMcmodCaptcha = async (): Promise<void> => {
    if (!mcmodCaptcha || !selected || busy) return
    setBusy('mcmod-captcha')
    try {
      const result = await window.modmind.production.relationships.submitMcmodCaptcha(mcmodCaptcha.sessionId, mcmodCaptchaInput, role)
      if (!result.success) { setNotice(result.message); if (result.captchaDataUrl) setMcmodCaptcha({ ...mcmodCaptcha, captchaDataUrl: result.captchaDataUrl, attemptsRemaining: result.attemptsRemaining }); return }
      setMcmodCaptcha(null); setSelected(null); setVersions([]); setHits([]); setQuery(''); await refresh(); setNotice(result.message)
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const refreshMcmodCaptcha = async (): Promise<void> => {
    if (!mcmodCaptcha || busy) return
    setBusy('mcmod-refresh')
    try { setMcmodCaptcha(await window.modmind.production.relationships.refreshMcmodCaptcha(mcmodCaptcha.sessionId)) } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const beginImport = async (): Promise<void> => {
    if (busy) return
    setBusy('import'); setNotice('')
    try {
      const next = await window.modmind.production.relationships.beginImport()
      if (!next) return
      setReview(next)
      setChoices(Object.fromEntries(next.items.map((item) => [item.id, { role: 'required' as const, value: item.match ? matchValue(item.match) : '' }])))
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const cancelImport = async (): Promise<void> => {
    if (review) await window.modmind.production.relationships.cancelImport(review.batchId).catch(() => undefined)
    setReview(null); setChoices({})
  }

  const confirmImport = async (): Promise<void> => {
    if (!review || busy) return
    const selections: AddonImportSelection[] = review.items.map((item) => {
      const choice = choices[item.id]
      if (choice?.value === 'private') return { itemId: item.id, role: choice.role, privateMod: true }
      const match = importMatches(review, item.id).find((entry) => matchValue(entry) === choice?.value)
      return { itemId: item.id, role: choice?.role ?? 'required', ...(match ? { match } : {}) }
    })
    if (selections.some((entry) => !entry.match && !entry.privateMod)) { setNotice('请处理列表中的每个 JAR'); return }
    setBusy('confirm-import'); setNotice('')
    try {
      const next = await window.modmind.production.relationships.confirmImport(review.batchId, selections)
      setReview(null); setChoices({})
      await changed(next, `已识别并加入 ${selections.length} 个目标模组`)
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const linkProject = async (): Promise<void> => {
    if (busy) return
    setBusy('link'); setNotice('')
    try {
      const next = await window.modmind.production.relationships.linkProject()
      if (next) await changed(next, 'ModMind 项目已经构建并关联')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const updateRole = async (relationship: AddonRelationship, nextRole: AddonRelationshipRole): Promise<void> => {
    setBusy(`role:${relationship.id}`); setNotice('')
    try { await changed(await window.modmind.production.relationships.setRole(relationship.id, nextRole), `${relationship.name} 已改为${roleLabel(nextRole)}`) }
    catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const remove = async (relationship: AddonRelationship): Promise<void> => {
    if (!await confirm({ title: `移除“${relationship.name}”？`, message: '会同步更新构建、成品前置声明和测试环境。自动前置会重新计算。', confirmLabel: '移除', tone: 'danger' })) return
    setBusy(`remove:${relationship.id}`); setNotice('')
    try { await changed(await window.modmind.production.relationships.remove(relationship.id), `${relationship.name} 已移除`) }
    catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const importSource = async (relationship: AddonRelationship, sourceType: 'archive' | 'folder'): Promise<void> => {
    setBusy(`source:${relationship.id}`); setNotice('')
    try {
      const next = await window.modmind.production.relationships.importSource(relationship.id, sourceType)
      if (next) await changed(next, `${relationship.name} 的源码已经关联`)
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  const audit = async (): Promise<void> => {
    setBusy('audit'); setNotice('')
    try {
      const result = await window.modmind.production.relationships.audit()
      setNotice(result.success ? `检查完成：${result.checked} 个目标可用${result.warnings.length ? `；${result.warnings.join('；')}` : ''}` : result.errors.join('；'))
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }

  return <div className={`addon-relationships-page ${beginner ? 'beginner' : 'advanced'}`}>
    <header className="content-toolbar addon-relationships-toolbar">
      <h1 className="visually-hidden">{beginner ? '联动模组' : '前置与联动'}</h1>
      <div className="addon-toolbar-actions">
        {!beginner ? <button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void audit()}>{busy === 'audit' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}检查</button> : null}
        <button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void beginImport()}>{busy === 'import' ? <LoaderCircle className="spin" size={14} /> : <FileArchive size={14} />}导入 JAR</button>
        <button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void linkProject()}>{busy === 'link' ? <LoaderCircle className="spin" size={14} /> : <FolderGit2 size={14} />}关联项目</button>
      </div>
    </header>

    {notice ? <div className="addon-relationship-notice" role="status"><CircleAlert size={15} /><span>{notice}</span></div> : null}

    <section className="addon-targets-section">
      <div className="addon-section-heading"><div><h2>{beginner ? '当前联动' : '目标模组'}</h2><p>{direct.length ? `${direct.length} 个直接目标` : '尚未添加目标模组'}</p></div><span>{manifest ? `${manifest.relationships.length} 个文件` : '读取中'}</span></div>
      <div className="addon-target-list">
        {direct.map((relationship) => <article className="addon-target-row" key={relationship.id}>
          <span className={`addon-target-status ${relationship.api.sourceKind}`}><Check size={15} /></span>
          <div className="addon-target-main"><strong>{relationship.name}</strong><small>{providerLabel(relationship.provider)} · {relationship.version} · {relationship.primaryModId}</small></div>
          {!beginner ? <div className="addon-api-state"><span>{relationship.api.sourceKind === 'project' ? '项目源码' : relationship.api.sourceKind === 'sources' ? relationship.api.sourceMatched ? '同版本源码' : '参考源码' : '读取 JAR'}</span><small>{relationship.api.classCount} 个类</small></div> : <span className="addon-simple-ready">已准备</span>}
          <select aria-label={`${relationship.name} 的关系`} disabled={Boolean(busy)} value={relationship.role} onChange={(event) => void updateRole(relationship, event.target.value as AddonRelationshipRole)}><option value="required">必须安装</option><option value="optional">可选联动</option><option value="test">仅测试</option></select>
          {!beginner ? <div className="addon-row-actions"><button className="icon-button" title="反编译查看源码" disabled={Boolean(busy) || !onDecompile} onClick={() => { if (onDecompile) onDecompile(`${project.path}/${relationship.relativePath}`.replaceAll('\\', '/')) }}><Binary size={14} /></button><button className="icon-button" title="导入源码归档" disabled={Boolean(busy)} onClick={() => void importSource(relationship, 'archive')}><FileArchive size={14} /></button><button className="icon-button" title="关联源码目录" disabled={Boolean(busy)} onClick={() => void importSource(relationship, 'folder')}><FolderGit2 size={14} /></button><button className="icon-button danger" title="移除目标" disabled={Boolean(busy)} onClick={() => void remove(relationship)}>{busy === `remove:${relationship.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div> : <button className="icon-button danger" title="移除目标" disabled={Boolean(busy)} onClick={() => void remove(relationship)}><Trash2 size={14} /></button>}
          {!beginner && relationship.api.packages.length ? <details className="addon-package-details"><summary>可用代码范围</summary><div>{relationship.api.packages.slice(0, 24).map((packageName) => <code key={packageName}>{packageName}</code>)}</div></details> : null}
        </article>)}
        {!direct.length ? <div className="addon-empty"><Link2 size={22} /><span>搜索一个模组，或导入本地 JAR</span></div> : null}
      </div>
      {automatic.length ? <details className="addon-auto-dependencies"><summary>自动前置 <span>{automatic.length}</span></summary><div>{automatic.map((relationship) => <span key={relationship.id}><Check size={12} />{relationship.name} {relationship.version}</span>)}</div></details> : null}
    </section>

    <section className="addon-browser-section">
      <div className="addon-section-heading"><div><h2>{query.trim() ? '搜索结果' : '下载前置模组'}</h2><p>适配 {project.minecraftVersion} / {project.loader}</p></div></div>
      <form className="addon-search" onSubmit={(event) => { event.preventDefault(); void search() }}><Search size={16} /><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (!value.trim()) { setHits(recommendations); setSelected(null); setVersions([]) } }} placeholder="搜索模组名称" maxLength={120} /><button className="primary-button compact" disabled={Boolean(busy) || !query.trim()}>{busy === 'search' ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}搜索</button></form>
      <div className="addon-search-layout">
        <div className="addon-search-results" aria-busy={resultsLoading}>{resultsLoading ? <AddonSearchSkeleton /> : hits.map((hit) => <button key={`${hit.provider}:${hit.projectId}`} className={selected?.provider === hit.provider && selected.projectId === hit.projectId ? 'selected' : ''} onClick={() => void chooseHit(hit)}><span className="addon-result-icon">{hit.iconUrl ? <img src={hit.iconUrl} alt="" referrerPolicy="no-referrer" /> : <PackagePlus size={16} />}</span><span><strong>{hit.name}</strong><small>{hit.englishName && hit.englishName !== hit.name ? `${hit.englishName} · ` : ''}{providerLabel(hit.provider)} · {hit.downloads.toLocaleString()} 次下载</small></span></button>)}</div>
        {selected ? <div className="addon-version-panel"><div><span>{providerLabel(selected.provider)}</span><h3>{selected.name}</h3><p>{selected.summary}</p></div>{busy.startsWith('versions:') ? <div className="addon-inline-loading"><LoaderCircle className="spin" size={16} />读取版本</div> : versions.length ? <><label>版本<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((version) => <option value={version.versionId} key={version.versionId}>{version.versionName}</option>)}</select></label><label>关系<select value={role} onChange={(event) => setRole(event.target.value as AddonRelationshipRole)}><option value="required">必须安装</option><option value="optional">可选联动</option><option value="test">仅测试</option></select></label><button className="primary-button" disabled={Boolean(busy) || !versionId} onClick={() => void installSelected()}>{busy === 'install' ? <LoaderCircle className="spin" size={15} /> : <PackagePlus size={15} />}加入项目</button></> : <div className="addon-inline-loading">没有兼容版本</div>}</div> : null}
      </div>
    </section>

    {review ? createPortal(<div className="modal-backdrop addon-import-backdrop" role="presentation" onMouseDown={() => { if (!busy) void cancelImport() }}><div className="dialog addon-import-dialog" role="dialog" aria-modal="true" aria-labelledby="addon-import-title" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-header"><div><h2 id="addon-import-title">确认导入的模组</h2><p>{review.items.length} 个 JAR 已完成批量识别</p></div><button className="icon-button" title="关闭" disabled={Boolean(busy)} onClick={() => void cancelImport()}><X size={18} /></button></div><div className="addon-import-list">{review.items.map((item) => { const available = importMatches(review, item.id); const choice = choices[item.id] ?? { role: 'required' as const, value: '' }; return <div className="addon-import-row" key={item.id}><div><strong>{item.detectedName}</strong><small>{item.fileName} · {item.detectedVersion} · {formatBytes(item.size)}</small></div><select aria-label={`${item.fileName} 的识别结果`} value={choice.value} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: { ...choice, value: event.target.value } }))}><option value="">选择匹配结果</option>{available.map((match) => <option key={matchValue(match)} value={matchValue(match)}>{match.exact ? '准确匹配' : '候选'}：{match.name} {match.versionName} · {providerLabel(match.provider)}</option>)}<option value="private">私人或定制模组</option></select><select aria-label={`${item.fileName} 的关系`} value={choice.role} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: { ...choice, role: event.target.value as AddonRelationshipRole } }))}><option value="required">主要目标</option><option value="optional">可选联动</option><option value="test">仅测试</option></select>{item.warnings.length ? <span className="addon-import-warning">{item.warnings.join('；')}</span> : <span className="addon-import-ok"><Check size={12} />{item.match?.exact ? '文件指纹已确认' : '等待确认'}</span>}</div> })}</div><div className="dialog-footer"><span>{review.items.length} 个文件等待确认</span><div><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void cancelImport()}>取消</button><button className="primary-button" disabled={Boolean(busy) || review.items.some((item) => !choices[item.id]?.value)} onClick={() => void confirmImport()}>{busy === 'confirm-import' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}确认并加入</button></div></div></div></div>, document.querySelector('.app-shell') ?? document.body) : null}
    {mcmodCaptcha ? createPortal(<div className="modal-backdrop" role="presentation"><div className="dialog" role="dialog" aria-modal="true"><div className="dialog-header"><h2>MC百科验证码</h2><button className="icon-button" onClick={() => setMcmodCaptcha(null)}><X size={18} /></button></div><div className="dialog-body"><img src={mcmodCaptcha.captchaDataUrl} alt="MC百科验证码" style={{ maxWidth: '100%' }} /><input value={mcmodCaptchaInput} onChange={(event) => setMcmodCaptchaInput(event.target.value)} placeholder="输入验证码" autoFocus /><div className="dialog-footer"><span>剩余尝试 {mcmodCaptcha.attemptsRemaining} 次</span><div><button className="secondary-button" onClick={() => void refreshMcmodCaptcha()}><RefreshCw size={14} />换一张</button><button className="primary-button" disabled={!mcmodCaptchaInput.trim()} onClick={() => void submitMcmodCaptcha()}><Check size={14} />提交并加入</button></div></div></div></div></div>, document.querySelector('.app-shell') ?? document.body) : null}
    {dialog}
  </div>
}
