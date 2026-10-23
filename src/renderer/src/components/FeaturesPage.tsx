import { useEffect, useMemo, useRef, useState } from 'react'
import * as icons from 'lucide-react'
import { Check, Download, LayoutGrid, LoaderCircle, PackagePlus, RefreshCw, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import { orderedFeatureGroups, type FeatureStoreEntry } from '../../../shared/featureStore'
import { featureDefinitionApplies, featurePageApplies, featureProjectStudioId } from '../../../shared/featureApplicability'
import type { ProjectInfo, UiMode } from '../../../shared/types'
import { useFeatureStore } from '../useFeatureStore'
import { refreshFeaturePlugins, useFeaturePlugins } from '../featurePlugins'
import { canSelectFeature, featureBundles, featureInstallPlan, isStudioEntry, isSupportEntry } from '../featureInstallPlan'
import { useConfirmDialog } from './InteractionDialogs'
import './features-page.css'

const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`
function status(entry: FeatureStoreEntry): string {
  if (entry.builtin && entry.available) return '内置'
  return entry.incompatible ?? (entry.state === 'error' ? '加载失败' : entry.state === 'dependency-missing' ? '缺少依赖' : entry.updateAvailable ? '可更新' : entry.state === 'ready' ? '已启用' : entry.state === 'disabled' ? '已停用' : '未安装')
}
function FeatureIcon({ entry }: { entry: FeatureStoreEntry }): React.JSX.Element {
  const name = entry.manifest?.views?.[0]?.icon
  const studioIcon = entry.id === 'studio-shader' ? icons.Sun : entry.id === 'studio-modpack' ? icons.Layers : entry.id === 'studio-server-plugin' ? icons.Server : icons.Blocks
  const Icon = isStudioEntry(entry) ? studioIcon : name ? (icons as unknown as Record<string, icons.LucideIcon>)[name] ?? icons.Package : icons.Package
  return <span className="feature-store-icon"><Icon size={22} /></span>
}

export default function FeaturesPage({ project, uiMode, tutorialActive = false, onOpen, onSettings }: { project: ProjectInfo | null; uiMode: UiMode; tutorialActive?: boolean; onOpen: (id: string) => void; onSettings: (id: string) => void }): React.JSX.Element {
  const store = useFeatureStore(), local = useFeaturePlugins()
  const [view, setView] = useState<'features' | 'studios'>('features')
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [category, setCategory] = useState('推荐组合')
  const [filter, setFilter] = useState<'all' | 'installed' | 'updates'>('all')
  const [query, setQuery] = useState(''), [bundleId, setBundleId] = useState('mod')
  const [selection, setSelection] = useState<string | null>(null), [showDetail, setShowDetail] = useState(false)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [checked, setChecked] = useState<string[]>([])
  const [batch, setBatch] = useState<{ total: number; completed: number; running: boolean; failed: string[]; cancelled: boolean } | null>(null)
  const cancelBatch = useRef(false)
  const detailRef = useRef<HTMLDialogElement>(null)
  const { confirm, dialog } = useConfirmDialog()
  const studioId = featureProjectStudioId(project)
  useEffect(() => {
    setScope('current'); setCategory('推荐组合'); setSelection(null); setShowDetail(false); setChecked([])
    setBundleId(featureBundles.find(bundle => bundle.studioId === studioId)?.id ?? 'mod')
    return () => { cancelBatch.current = true }
  }, [project?.path, studioId])

  const workbenchEntries = useMemo(() => store.entries.filter(entry => !project || scope === 'all' || featureDefinitionApplies(entry.manifest, project)), [store.entries, project, scope])
  const studios = store.entries.filter(isStudioEntry)
  const tools = workbenchEntries.filter(entry => !isStudioEntry(entry) && !isSupportEntry(entry))
  const supports = workbenchEntries.filter(isSupportEntry)
  const groups = orderedFeatureGroups(tools)
  const bundles = featureBundles.filter(bundle => !project || scope === 'all' || bundle.ids.some(id => tools.some(entry => entry.id === id)))
  const bundle = bundles.find(value => value.id === bundleId) ?? bundles[0]
  const recommended = bundle ? tools.filter(entry => bundle.ids.includes(entry.id)) : []
  const activeCategory = ['推荐组合', '全部功能', '支持组件', ...groups].includes(category) ? category : '全部功能'
  const scoped = view === 'studios' ? studios : activeCategory === '推荐组合' ? recommended : activeCategory === '支持组件' ? supports : activeCategory === '全部功能' ? tools : tools.filter(entry => entry.groups.includes(activeCategory))
  const matchesFilter = (entry: FeatureStoreEntry): boolean => filter === 'all' || filter === 'installed' && entry.installed || filter === 'updates' && entry.updateAvailable
  const shown = scoped.filter(entry => matchesFilter(entry) && `${entry.name} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => view === 'studios' ? Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.name.localeCompare(b.name, 'zh-CN') : Number(b.updateAvailable) - Number(a.updateAvailable) || a.name.localeCompare(b.name, 'zh-CN'))
  const selected = shown.find(entry => entry.id === selection)
  useEffect(() => {
    const detail = detailRef.current
    if (showDetail && selected && !detail?.open) detail?.show()
    else if ((!showDetail || !selected) && detail?.open) detail.close()
  }, [showDetail, selected?.id])
  useEffect(() => {
    if (!showDetail) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog:modal,[aria-modal="true"]')) return
      event.preventDefault()
      setShowDetail(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showDetail])
  const loading = Boolean(store.job && ['downloading', 'installing'].includes(store.job.phase))
  const locked = busy || loading
  const pending = checked.filter(id => store.entries.some(entry => entry.id === id && canSelectFeature(entry)))
  const plan = featureInstallPlan(store.entries, pending)
  const recommendationPlan = featureInstallPlan(store.entries, recommended.filter(canSelectFeature).map(entry => entry.id))
  const selectables = shown.filter(canSelectFeature)
  const allChecked = selectables.length > 0 && selectables.every(entry => pending.includes(entry.id))
  const toggle = (id: string): void => setChecked(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setNotice('')
    try { await operation(); await refreshFeaturePlugins() }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const install = (entry: FeatureStoreEntry): void => { void run(async () => {
    if (entry.installed && entry.available && entry.updateAvailable && !await confirm({ title: `更新${entry.name}？`, message: '请先保存正在编辑的内容。更新会保留已保存的项目文件和设置。', confirmLabel: '更新功能' })) return
    await window.modmind.featurePlugins.installOfficial(entry.id)
  }) }
  const installBatch = (): void => { void run(async () => {
    if (!pending.length || plan.error) return
    if (pending.some(id => store.entries.some(entry => entry.id === id && entry.updateAvailable)) && !await confirm({ title: `安装或更新 ${pending.length} 项功能？`, message: '请先保存正在编辑的内容。已保存的项目文件和设置会保留。', confirmLabel: '开始安装' })) return
    cancelBatch.current = false
    const progress = { total: pending.length, completed: 0, running: true, failed: [] as string[], cancelled: false }
    setBatch({ ...progress })
    for (const id of pending) {
      if (cancelBatch.current) break
      try {
        const current = (await window.modmind.featurePlugins.store()).entries.find(entry => entry.id === id)
        if (!current) throw new Error('功能已从目录移除')
        if (current.installed && !current.enabled && !current.error && !current.updateAvailable) await window.modmind.featurePlugins.setEnabled(id, true)
        else if (!current.available || current.updateAvailable) await window.modmind.featurePlugins.installOfficial(id)
        setChecked(values => values.filter(value => value !== id))
      } catch (error) {
        if (!cancelBatch.current) { progress.failed.push(id); setNotice(`${store.entries.find(entry => entry.id === id)?.name ?? id}：${error instanceof Error ? error.message : String(error)}`) }
      }
      progress.completed++
      setBatch({ ...progress, failed: [...progress.failed] })
    }
    setBatch({ ...progress, running: false, cancelled: cancelBatch.current })
  }) }
  const stopBatch = (): void => { cancelBatch.current = true; void window.modmind.featurePlugins.cancelDownload().catch(error => setNotice(String(error))) }
  const change = (entry: FeatureStoreEntry, remove: boolean): void => { void run(async () => {
    if (!await confirm({ title: `${remove ? '卸载' : '停用'}${entry.name}？`, message: '请先保存正在编辑的内容。已保存的项目文件与功能设置会保留。', confirmLabel: remove ? '卸载功能' : '停用功能', tone: remove ? 'danger' : 'default' })) return
    await (remove ? window.modmind.featurePlugins.uninstall(entry.id) : window.modmind.featurePlugins.setEnabled(entry.id, false))
  }) }
  const openPage = (entry: FeatureStoreEntry): string | undefined => local.modules[entry.id]?.pages.find(page => featurePageApplies(page, project, uiMode))?.id
  const settingsSection = (entry: FeatureStoreEntry): string | undefined => local.modules[entry.id]?.settings?.find(section => featurePageApplies(section, project, uiMode))?.id
  const primary = (entry: FeatureStoreEntry, prominent = false): React.JSX.Element => {
    const className = prominent && !pending.length && !batch?.running ? 'primary-button compact' : 'secondary-button compact'
    if (entry.builtin) return <span className="feature-installed"><Check size={13} />{entry.available ? '内置' : '请修复软件安装'}</span>
    const page = entry.available ? openPage(entry) : undefined
    if (page) return <div className="feature-open-actions"><button className={className} onClick={() => onOpen(page)}>打开</button>{entry.updateAvailable && <button className="icon-button" title={`更新至 ${entry.release?.version}`} aria-label={`更新${entry.name}`} disabled={locked} onClick={() => install(entry)}><Download size={14} /></button>}</div>
    if (entry.available && !entry.updateAvailable) return <span className="feature-installed"><Check size={13} />{!project || featureDefinitionApplies(entry.manifest, project) ? '已安装' : '其他工作台'}</span>
    if (entry.installed && !entry.enabled && !entry.updateAvailable && !entry.error) return <button className={className} disabled={locked} onClick={() => void run(() => window.modmind.featurePlugins.setEnabled(entry.id, true))}>启用</button>
    return <button className={className} disabled={locked || !entry.release || Boolean(entry.incompatible)} onClick={() => install(entry)} title={entry.incompatible ?? (!entry.release ? '官方功能源尚未发布此安装包' : undefined)}>{prominent && <Download size={14} />}{entry.updateAvailable ? prominent ? `更新至 ${entry.release!.version}` : '更新' : entry.installed ? '修复' : '安装'}</button>
  }
  const dependencies = (selected?.release?.dependencies ?? selected?.manifest?.dependencies ?? []).map(id => store.entries.find(entry => entry.id === id)).filter((entry): entry is FeatureStoreEntry => Boolean(entry))
  const error = notice || store.error
  const activeJob = store.job && ['downloading', 'installing', 'error'].includes(store.job.phase) ? store.job : undefined
  const showSelectionBar = Boolean(batch?.running) || pending.length > 0 && (!activeJob || tutorialActive && activeJob.phase === 'error')
  const changeView = (next: 'features' | 'studios'): void => { setView(next); setFilter('all'); setQuery(''); setSelection(null); setShowDetail(false); setChecked([]) }
  const viewDependency = (entry: FeatureStoreEntry): void => {
    setView(isStudioEntry(entry) ? 'studios' : 'features'); setScope('all'); setCategory(isSupportEntry(entry) ? '支持组件' : '全部功能'); setFilter('all'); setQuery(''); setSelection(entry.id)
  }
  return <div className={`features-page${view === 'studios' ? ' feature-studios-view' : ''}`}>
    <h1 className="visually-hidden">功能</h1>
    <header className="feature-store-topbar">
      <div className="feature-store-navigation">
        <div className="feature-store-tabs" role="tablist" aria-label="功能与工作台">
          <button data-onboarding="features-tab" role="tab" aria-selected={view === 'features'} onClick={() => changeView('features')}><LayoutGrid size={16} />功能<span>{store.entries.filter(entry => !isStudioEntry(entry) && !isSupportEntry(entry)).length}</span></button>
          <button data-onboarding="studios-tab" role="tab" aria-selected={view === 'studios'} onClick={() => changeView('studios')}><icons.PanelsTopLeft size={16} />工作台<span>{studios.length}</span></button>
        </div>
        <button className="feature-store-import" disabled={locked} title="导入自制功能（.mmfeature）或工作台（.mmstudio）" onClick={() => void run(() => window.modmind.featurePlugins.install())}><PackagePlus size={16} />导入自制</button>
      </div>
      <label className="feature-store-search"><Search size={15} /><input data-onboarding="feature-search" aria-label="搜索功能" placeholder={view === 'studios' ? '搜索工作台' : '搜索功能'} value={query} onChange={event => { setQuery(event.target.value); setShowDetail(false) }} />{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
      <button className="secondary-button compact" disabled={locked || store.checking} onClick={() => void run(() => window.modmind.featurePlugins.refreshStore())}><RefreshCw size={14} className={store.checking ? 'spin' : ''} />{store.checking ? '正在检查' : '检查更新'}</button>
    </header>
    {error && <div className="feature-store-notice" role="alert"><span>{error}</span><button disabled={locked || store.checking} onClick={() => notice ? setNotice('') : void run(() => window.modmind.featurePlugins.refreshStore())}>{notice ? '关闭' : '重试'}</button></div>}
    <div className={`feature-store-body${showDetail && selected ? ' detail-active' : ''}`}>
      {view === 'features' && <nav className="feature-store-categories" aria-label="功能分类">
        <button data-onboarding="recommended-features" className={activeCategory === '推荐组合' ? 'active' : ''} aria-pressed={activeCategory === '推荐组合'} onClick={() => { setCategory('推荐组合'); setShowDetail(false) }}><Sparkles size={15} /><span>推荐组合</span></button>
        <button data-onboarding="all-features" className={activeCategory === '全部功能' ? 'active' : ''} aria-pressed={activeCategory === '全部功能'} onClick={() => { setCategory('全部功能'); setShowDetail(false) }}><LayoutGrid size={15} /><span>全部功能</span><small>{tools.length}</small></button>
        <span className="feature-category-caption">分类</span>
        {groups.map(group => <button key={group} aria-pressed={activeCategory === group} className={activeCategory === group ? 'active' : ''} onClick={() => { setCategory(group); setShowDetail(false) }}><span>{group}</span><small>{tools.filter(entry => entry.groups.includes(group)).length}</small></button>)}
        <button className={`feature-support-category${activeCategory === '支持组件' ? ' active' : ''}`} aria-pressed={activeCategory === '支持组件'} onClick={() => { setCategory('支持组件'); setShowDetail(false) }}><icons.Settings2 size={14} /><span>支持组件</span><small>{supports.length}</small></button>
      </nav>}
      <section className="feature-store-list" aria-label={view === 'studios' ? '工作台列表' : '功能列表'}>
        {view === 'features' && activeCategory === '推荐组合' && bundle && <div data-onboarding-bundle={bundle.id} className="feature-bundle-band">
          <div className="feature-bundle-heading"><Sparkles size={17} /><strong>推荐安装</strong></div>
          <div className="feature-bundle-picker" role="group" aria-label="推荐组合">{bundles.map(value => <button data-onboarding-bundle-option={value.id} key={value.id} aria-pressed={bundle.id === value.id} onClick={() => { setBundleId(value.id); setSelection(null); setShowDetail(false); setChecked([]) }}>{value.name}</button>)}</div>
          <div className="feature-bundle-summary"><span>{recommended.length} 项功能 · {recommended.filter(entry => entry.available).length} 项已就绪 · {recommendationPlan.error ? '部分组件暂不可用' : `${bytes(recommendationPlan.bytes)}（含依赖）`}</span><button data-onboarding="bundle-select" className="secondary-button compact" disabled={locked || !recommended.some(canSelectFeature)} onClick={() => setChecked(recommended.filter(canSelectFeature).map(entry => entry.id))}>选择组合</button></div>
        </div>}
        <div className="feature-list-controls">
          <div data-onboarding="feature-filters" className="feature-store-filters" role="group" aria-label="功能状态">{([['all', '全部'], ['installed', '已安装'], ['updates', '可更新']] as const).map(([id, label]) => <button data-onboarding-filter={id} key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => { setFilter(id); setShowDetail(false) }}>{label}<span>{scoped.filter(entry => id === 'all' || id === 'installed' && entry.installed || id === 'updates' && entry.updateAvailable).length}</span></button>)}</div>
          {project && view === 'features' && <select data-onboarding="feature-scope" className="feature-scope-select" aria-label="工作台范围" value={scope} onChange={event => { setScope(event.target.value as 'current' | 'all'); setSelection(null); setChecked([]); setShowDetail(false) }}><option value="current">当前工作台</option><option value="all">全部工作台</option></select>}
        </div>
        {view === 'studios' ? <div className="feature-store-list-heading"><strong>选择你的创作工作台</strong><span>{studios.filter(entry => entry.builtin).length} 个内置 · {studios.filter(entry => !entry.builtin).length} 个扩展</span></div> : <div className="feature-store-list-heading"><label className="feature-select-all"><input type="checkbox" aria-label="选择当前列表" checked={allChecked} disabled={locked || !selectables.length} onChange={() => setChecked(values => allChecked ? values.filter(id => !selectables.some(entry => entry.id === id)) : [...new Set([...values, ...selectables.map(entry => entry.id)])])} /><span>{activeCategory === '推荐组合' ? bundle?.name ?? '推荐组合' : activeCategory}</span></label><span>{shown.length} 项</span></div>}
        {!store.entries.length ? <div className="feature-store-empty" role="status">{store.error ? '功能目录暂不可用，请重试' : '正在读取功能目录…'}</div> : !shown.length ? <div className="feature-store-empty" role="status">没有符合条件的{view === 'studios' ? '工作台' : '功能'}<button className="secondary-button compact" onClick={() => { setQuery(''); setFilter('all'); setCategory('全部功能') }}>清除筛选</button></div> : <div className={view === 'studios' ? 'feature-studio-grid' : undefined}>{shown.map(entry => <article data-onboarding-feature={entry.id} className={`feature-store-row${view === 'studios' ? ' feature-studio-card' : ''}${selected?.id === entry.id ? ' selected' : ''}${pending.includes(entry.id) ? ' checked' : ''}`} key={entry.id}>
          {view === 'features' && <input className="feature-row-checkbox" type="checkbox" aria-label={`选择${entry.name}`} disabled={locked || !canSelectFeature(entry)} checked={pending.includes(entry.id)} onChange={() => toggle(entry.id)} />}
          <button className="feature-store-select" aria-label={`查看${entry.name}`} aria-pressed={selected?.id === entry.id} onClick={() => { setSelection(entry.id); setShowDetail(true) }}><FeatureIcon entry={entry} /><span className="feature-store-copy"><span className="feature-store-name">{entry.name}{entry.updateAvailable && <small>可更新</small>}{view === 'studios' && <small className="feature-studio-kind">{entry.builtin ? '内置' : '扩展工作台'}</small>}</span><span className="feature-store-description">{entry.description}</span><span className="feature-store-meta">{view === 'studios' ? entry.builtin ? '随软件提供' : entry.release ? `${entry.release.version} · ${bytes(entry.release.size)}` : entry.version : `${entry.installed ? entry.version : entry.release?.version ?? '待发布'}${entry.updateAvailable ? ` → ${entry.release!.version}` : ''}`}</span></span></button>
          <div className="feature-store-row-action">{primary(entry)}{view === 'features' && <span>{entry.incompatible ? '不兼容' : entry.available ? '已就绪' : entry.release ? bytes(entry.release.size) : entry.installed ? status(entry) : '未发布'}</span>}</div>
        </article>)}</div>}
      </section>
      <dialog data-onboarding-detail={selected?.id} ref={detailRef} className="feature-store-detail" aria-label="功能详情" onClose={event => { if (!event.currentTarget.open) setShowDetail(false) }} onCancel={() => setShowDetail(false)}>{selected && <>
        <div className="feature-detail-controls"><button data-onboarding="close-feature-detail" className="icon-button" title="关闭详情" aria-label="关闭详情" onClick={() => setShowDetail(false)}><X size={18} /></button></div>
        <div className="feature-store-detail-heading"><FeatureIcon entry={selected} /><div><h2>{selected.name}</h2><span><ShieldCheck size={12} />{selected.builtin ? 'ModMind 内置工作台' : selected.release ? 'ModMind 官方' : '本地安装'}</span></div></div>
        <p className="feature-store-intro">{selected.description}</p>
        <div data-onboarding="feature-primary" className="feature-store-primary">{primary(selected, true)}</div>
        {isStudioEntry(selected) && <section className="feature-studio-recommendation"><h3>配套工具</h3><div className="feature-store-tags">{featureBundles.find(value => value.studioId === selected.manifest?.studios?.[0]?.id || value.id === 'shader' && selected.id === 'studio-shader')?.ids.map(id => store.entries.find(entry => entry.id === id)).filter((entry): entry is FeatureStoreEntry => Boolean(entry)).map(entry => <span key={entry.id}>{entry.name}</span>)}</div>{featureBundles.some(value => value.studioId === selected.manifest?.studios?.[0]?.id || value.id === 'shader' && selected.id === 'studio-shader') ? <button className="secondary-button compact" onClick={() => { const preset = featureBundles.find(value => value.studioId === selected.manifest?.studios?.[0]?.id || value.id === 'shader' && selected.id === 'studio-shader')!; setView('features'); setScope('all'); setBundleId(preset.id); setCategory('推荐组合'); setFilter('all'); setQuery(''); setSelection(null); setShowDetail(false) }}>查看推荐组合<icons.ArrowRight size={14} /></button> : <p>此工作台尚未提供推荐组合。</p>}</section>}
        <dl className="feature-store-metadata"><div><dt>已安装版本</dt><dd>{selected.installed ? selected.version : '未安装'}</dd></div><div><dt>下载大小</dt><dd>{selected.builtin ? '随软件提供' : selected.release ? bytes(selected.release.size) : '待发布'}</dd></div><div><dt>当前状态</dt><dd>{status(selected)}</dd></div><div><dt>ModMind 版本</dt><dd>{selected.release?.hostVersion ?? selected.manifest?.hostVersion ?? '未知'}</dd></div></dl>
        {selected.error && <p className="feature-store-inline-error" role="alert">{selected.error}</p>}
        {!selected.builtin && <section><h3>本次更新</h3>{selected.release ? <><div className="feature-store-release-meta">{selected.release.version}<time>{new Date(selected.release.publishedAt).toLocaleDateString('zh-CN')}</time></div>{selected.release.changelog.length ? <ul>{selected.release.changelog.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>此版本未提供更新说明。</p>}</> : <p>官方源尚未发布更新信息。</p>}</section>}
        <section><h3>{isStudioEntry(selected) ? '支持平台' : '可以在哪里使用'}</h3><div className="feature-store-tags">{(selected.manifest?.studioIds ?? []).map(id => <span key={id}>{store.entries.flatMap(entry => entry.manifest?.studios ?? []).find(studio => studio.id === id)?.name ?? id}</span>)}{isStudioEntry(selected) ? selected.manifest?.studios?.flatMap(studio => studio.loaders).map(loader => <span key={loader}>{loader}</span>) ?? <span>安装后读取平台信息</span> : <>{(selected.manifest?.views ?? []).map(page => <span key={page.id}>{page.label}</span>)}{selected.manifest?.tools?.length ? <span>工作台 AI</span> : null}{selected.manifest?.actions?.some(action => action.surfaces?.includes('inspiration')) ? <span>灵感台</span> : null}</>}</div></section>
        <section><h3>所需组件</h3>{dependencies.length ? <ul className="feature-store-dependencies">{dependencies.map(entry => <li key={entry.id}><button onClick={() => viewDependency(entry)}>{entry.name}</button><span>{entry.available ? '已就绪' : '安装时自动下载'}</span></li>)}</ul> : <p>无需额外下载</p>}</section>
        {selected.installed && !selected.builtin && <div className="feature-store-maintenance">{settingsSection(selected) && <button onClick={() => onSettings(settingsSection(selected)!)}>功能设置</button>}<button disabled={locked} onClick={() => selected.enabled ? change(selected, false) : void run(() => window.modmind.featurePlugins.setEnabled(selected.id, true))}>{selected.enabled ? '停用' : '启用'}</button><button className="feature-uninstall" disabled={locked} onClick={() => change(selected, true)}>卸载</button></div>}
      </>}</dialog>
    </div>
    {showSelectionBar && <div data-onboarding="feature-batch" data-onboarding-pending={pending.join(',')} data-onboarding-running={Boolean(batch?.running)} data-onboarding-completed={batch?.completed ?? 0} data-onboarding-total={batch?.total ?? 0} className={`feature-selection-bar${pending.length ? ' has-selection' : ''}`} aria-live="polite">
      {batch?.running ? <><span><LoaderCircle size={15} className="spin" />正在处理 {batch.completed + 1} / {batch.total} 项</span><button className="secondary-button compact" onClick={stopBatch}>取消剩余</button></> : <><div className="feature-selection-summary"><strong>已选 {pending.length} 项</strong><span>{plan.error ?? `${bytes(plan.bytes)}${plan.dependencies.length ? ` · 含 ${plan.dependencies.length} 个依赖组件` : ''}`}</span></div><button className="feature-clear-selection" disabled={locked} onClick={() => setChecked([])}>清除选择</button><button data-onboarding="bundle-install" className="primary-button compact" disabled={locked || Boolean(plan.error)} onClick={installBatch}><Download size={14} />{filter === 'updates' ? '更新所选' : '安装所选'}</button></>}
    </div>}
    {activeJob && !batch?.running && <div data-onboarding="feature-job" className={`feature-store-job ${activeJob.phase}`} role="status"><span>{loading ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}<strong>{activeJob.name}</strong>{activeJob.phase === 'downloading' ? `下载中 ${bytes(activeJob.downloaded)}${activeJob.total ? ` / ${bytes(activeJob.total)}` : ''}` : activeJob.phase === 'installing' ? '正在校验并安装' : activeJob.message}</span>{activeJob.phase === 'downloading' && <button onClick={() => void window.modmind.featurePlugins.cancelDownload()}>取消</button>}{activeJob.phase === 'error' && <button disabled={busy} onClick={() => void run(() => window.modmind.featurePlugins.installOfficial(activeJob.id))}>重试</button>}</div>}
    {dialog}
  </div>
}
