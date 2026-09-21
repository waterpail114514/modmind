import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Globe2, LoaderCircle, PackagePlus, RefreshCw, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { McmodCaptchaChallenge, McmodFileInfo, McmodManualRequirement, McmodSearchResult, ModpackFileOption, ModpackProviderInfo, ModpackSearchHit, ProjectInfo } from '../../../shared/types'

type ProviderId = 'all' | 'modrinth' | 'curseforge' | 'mcmod'
type SearchItem = ModpackSearchHit | (McmodSearchResult & { provider: 'mcmod'; slug: string; projectUrl: string; downloads: number; clientSide: 'unknown'; serverSide: 'unknown' })
type FileOption = ModpackFileOption | (McmodFileInfo & { provider: 'mcmod' })

const providerLabels: Record<ProviderId, string> = { all: '全部平台', modrinth: 'Modrinth', curseforge: 'CurseForge', mcmod: 'MC 百科' }

function errorMessage(error: unknown): string { return reportClientFailure(error) }
function formatBytes(value?: number): string {
  if (!value) return '大小未知'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${Math.ceil(value / 1024)} KB`
}
function isAutomatic(item: SearchItem): item is ModpackSearchHit { return item.provider !== 'mcmod' }
function providerLabel(provider: ProviderId): string { return providerLabels[provider] ?? provider }
function downloadLabel(item: SearchItem): string {
  if (!isAutomatic(item) || !Number.isFinite(item.downloads)) return ''
  return ` · ${item.downloads.toLocaleString()} 次下载`
}

function normalizedName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '') }
function mcmodEnglishName(item: McmodSearchResult): string {
  return item.englishName ?? item.name.match(/\(([A-Za-z][A-Za-z0-9 ._':-]{1,100})\)/)?.[1] ?? ''
}
function mcmodChineseName(item: McmodSearchResult): string {
  return item.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || item.name
}
function localizeAutomaticHits(hits: ModpackSearchHit[], translations: McmodSearchResult[]): ModpackSearchHit[] {
  return hits.map((hit) => {
    const names = [hit.name, hit.slug].map(normalizedName).filter(Boolean)
    const translation = translations.find((item) => {
      const translatedNames = [mcmodEnglishName(item), item.name].map(normalizedName).filter(Boolean)
      return translatedNames.some((name) => names.includes(name))
    })
    return translation ? { ...hit, name: mcmodChineseName(translation), summary: translation.summary || hit.summary, ...(translation.iconUrl ? { iconUrl: translation.iconUrl } : {}) } : hit
  })
}
function toMcmodSearchItem(item: McmodSearchResult): SearchItem {
  return { ...item, provider: 'mcmod', slug: item.projectId, projectUrl: item.pageUrl, downloads: 0, clientSide: 'unknown', serverSide: 'unknown' }
}
function compatibleMcmodFile(file: McmodFileInfo, project: ProjectInfo): boolean {
  const version = file.minecraftVersion.split('/').map((value) => value.trim())
  const loader = project.loader.toLowerCase()
  return (!version.length || version.includes(project.minecraftVersion)) && (!file.loaders.length || file.loaders.some((value) => value.toLowerCase().replaceAll(' ', '').includes(loader)))
}
function fileKey(file: FileOption): string { return file.provider === 'mcmod' ? file.fileKey : file.versionId }
function ModIcon({ item }: { item: SearchItem }): React.JSX.Element {
  return <span className={`third-party-result-icon ${item.provider}`}>
    {item.iconUrl ? <img src={item.iconUrl} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <PackagePlus size={16} />}
  </span>
}

export default function ThirdPartyModsWorkspace({ project, visible }: { project: ProjectInfo; visible: boolean }): React.JSX.Element {
  const [provider, setProvider] = useState<ProviderId>('all')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [results, setResults] = useState<SearchItem[]>([])
  const [providerErrors, setProviderErrors] = useState<Array<{ provider: string; message: string }>>([])
  const [recommended, setRecommended] = useState<SearchItem[]>([])
  const [selected, setSelected] = useState<SearchItem | null>(null)
  const [files, setFiles] = useState<FileOption[]>([])
  const [requirements, setRequirements] = useState<McmodManualRequirement[]>([])
  const [providers, setProviders] = useState<ModpackProviderInfo[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [challenge, setChallenge] = useState<McmodCaptchaChallenge | null>(null)
  const [captcha, setCaptcha] = useState('')
  const captchaInputRef = useRef<HTMLInputElement>(null)
  const providerTabRefs = useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({})
  const requestGenerationRef = useRef(0)
  const activatedRef = useRef(false)
  const visibleRef = useRef(visible)
  const providerPanelId = useId().replaceAll(':', '')
  visibleRef.current = visible

  const isCurrentRequest = (generation: number): boolean => generation === requestGenerationRef.current

  const automaticProviders = useMemo(() => providers.map((entry) => entry.id).filter((id): id is 'modrinth' | 'curseforge' => id === 'modrinth' || id === 'curseforge'), [providers])
  const providerTabs = useMemo(() => (['all', ...providers.map((entry) => entry.id), 'mcmod'].filter((value, index, values) => values.indexOf(value) === index) as ProviderId[]), [providers])
  const visibleResults = useMemo(() => provider === 'all' ? results : results.filter((item) => item.provider === provider), [provider, results])
  const compatibleFiles = useMemo(() => files.filter((file) => file.provider === 'mcmod' ? compatibleMcmodFile(file, project) : true), [files, project])
  const pendingResults = useMemo(() => requirements.flatMap((entry) => entry.matches.map((match) => ({ ...match, provider: 'mcmod' as const, slug: match.projectId, projectUrl: match.pageUrl, downloads: 0, clientSide: 'unknown' as const, serverSide: 'unknown' as const }))), [requirements])
  const displayResults = useMemo(() => searchedQuery ? visibleResults : results.length ? visibleResults : provider === 'mcmod' || provider === 'all' ? pendingResults : [], [pendingResults, provider, results.length, searchedQuery, visibleResults])
  const noCompatibleResults = Boolean(searchedQuery) && !busy && !visibleResults.length

  const refresh = async (): Promise<void> => {
    const generation = requestGenerationRef.current
    if (!isCurrentRequest(generation)) return
    const [providerList, manual, recommendations, mcmodRecommendations] = await Promise.all([
      window.modmind.modpack.providers().catch(() => []),
      window.modmind.modpack.listManualMods().catch(() => []),
      window.modmind.modpack.recommendProviders().catch(() => []),
      window.modmind.modpack.recommendMcmod().catch(() => [])
    ])
    if (!isCurrentRequest(generation)) return
    setProviders(Array.isArray(providerList) ? providerList : [])
    setRequirements(Array.isArray(manual) ? manual : [])
    const automaticRecommendations = Array.isArray(recommendations) ? recommendations.flatMap((entry) => Array.isArray(entry.hits) ? entry.hits : []) : []
    const mcmodItems = Array.isArray(mcmodRecommendations) ? mcmodRecommendations : []
    const localizedAutomatic = localizeAutomaticHits(automaticRecommendations, mcmodItems)
    const automaticNames = new Set(localizedAutomatic.flatMap((entry) => [entry.name, entry.slug].map(normalizedName)))
    const manualRecommendations = mcmodItems.filter((entry) => !automaticNames.has(normalizedName(mcmodEnglishName(entry)))).map(toMcmodSearchItem)
    setRecommended([...localizedAutomatic, ...manualRecommendations])
  }

  useEffect(() => {
    if (!visible || activatedRef.current) return
    activatedRef.current = true
    requestGenerationRef.current += 1
    setProvider('all')
    setQuery('')
    setSearchedQuery('')
    setResults([])
    setProviderErrors([])
    setRecommended([])
    setSelected(null)
    setFiles([])
    setChallenge(null)
    setNotice('')
    const generation = requestGenerationRef.current
    void refresh().catch((error) => {
      if (generation === requestGenerationRef.current) setNotice(errorMessage(error))
    })
  }, [visible])

  useEffect(() => {
    if (!challenge) return
    const frame = requestAnimationFrame(() => captchaInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [challenge?.sessionId])

  const search = async (nextQuery = query): Promise<void> => {
    const value = nextQuery.trim()
    if (!value || busy || !visibleRef.current) return
    const generation = requestGenerationRef.current
    setBusy('search')
    setNotice('')
    try {
      const selectedAutomatic = provider === 'mcmod' ? [] : provider === 'all' ? automaticProviders : [provider]
      const mcmod = provider === 'mcmod' || provider === 'all' ? await window.modmind.modpack.searchMcmod(value).catch(() => []) : []
      const aliases = [...new Set([value, ...mcmod.map(mcmodEnglishName).filter(Boolean)])]
      const automatic = selectedAutomatic.length
        ? (await Promise.all(aliases.map((alias) => window.modmind.modpack.searchProviders(alias, selectedAutomatic)))).flat()
        : []
      const automaticHits = automatic.flatMap((entry) => entry.error ? [] : entry.hits)
      const nextProviderErrors = [...new Map(automatic.filter((entry) => entry.error).map((entry) => [entry.provider, { provider: entry.provider, message: entry.error ?? '' }])).values()]
      const localizedAutomatic = localizeAutomaticHits(automaticHits, mcmod)
      const automaticNames = new Set(localizedAutomatic.flatMap((entry) => [entry.name, entry.slug].map(normalizedName)))
      const mcmodHits = mcmod.filter((entry) => !automaticNames.has(normalizedName(mcmodEnglishName(entry)))).map(toMcmodSearchItem)
      const next = [...localizedAutomatic, ...mcmodHits]
      if (!isCurrentRequest(generation)) return
      setResults(next)
      setProviderErrors(nextProviderErrors)
      setSearchedQuery(value)
      setSelected(null)
      setFiles([])
    } catch (error) {
      if (isCurrentRequest(generation)) setNotice(errorMessage(error))
    } finally {
      if (isCurrentRequest(generation)) setBusy('')
    }
  }

  const selectProject = async (item: SearchItem): Promise<void> => {
    if (busy || !visibleRef.current) return
    const generation = requestGenerationRef.current
    setSelected(item)
    setFiles([])
    setNotice('')
    setBusy('files')
    try {
      const nextFiles = item.provider === 'mcmod' ? (await window.modmind.modpack.listMcmodFiles(item.projectId)).map((file) => ({ ...file, provider: 'mcmod' as const })) : await window.modmind.modpack.listProviderFiles(item.provider, item.projectId)
      if (!isCurrentRequest(generation)) return
      setFiles(nextFiles)
    } catch (error) {
      if (isCurrentRequest(generation)) setNotice(errorMessage(error))
    } finally {
      if (isCurrentRequest(generation)) setBusy('')
    }
  }

  const beginDownload = async (file: FileOption): Promise<void> => {
    if (busy || !visibleRef.current) return
    const generation = requestGenerationRef.current
    setBusy(`download:${fileKey(file)}`)
    setNotice('Downloading: ' + file.filename)
    try {
      if (file.provider === 'mcmod') {
        setCaptcha('')
        setNotice('正在准备验证码：' + file.filename)
        const nextChallenge = await window.modmind.modpack.beginMcmodDownload(file.projectId, file.fileKey)
        if (!isCurrentRequest(generation)) return
        setChallenge(nextChallenge)
      } else {
        await window.modmind.modpack.installProviderFile(file.provider, file.projectId, file.versionId)
        if (!isCurrentRequest(generation)) return
        setNotice('下载完成：' + file.filename)
        void refresh().catch(() => undefined)
      }
    } catch (error) {
      if (isCurrentRequest(generation)) setNotice(errorMessage(error))
    } finally {
      if (isCurrentRequest(generation)) setBusy('')
    }
  }

  const refreshCaptcha = async (): Promise<void> => {
    if (!challenge || busy || !visibleRef.current) return
    const generation = requestGenerationRef.current
    setBusy('captcha-refresh')
    try {
      setCaptcha('')
      const nextChallenge = await window.modmind.modpack.refreshMcmodCaptcha(challenge.sessionId)
      if (!isCurrentRequest(generation)) return
      setChallenge(nextChallenge)
    } catch (error) {
      if (isCurrentRequest(generation)) {
        setNotice(errorMessage(error))
        setChallenge(null)
      }
    } finally {
      if (isCurrentRequest(generation)) setBusy('')
    }
  }

  const submitCaptcha = async (): Promise<void> => {
    if (!challenge || busy || !captcha.trim() || !visibleRef.current) return
    const generation = requestGenerationRef.current
    setBusy('captcha-submit')
    try {
      const result = await window.modmind.modpack.submitMcmodCaptcha(challenge.sessionId, captcha)
      if (!isCurrentRequest(generation)) return
      if (result.success) {
        setNotice(result.message)
        setChallenge(null)
        setCaptcha('')
        void refresh().catch(() => undefined)
      } else if (result.captchaDataUrl) {
        setChallenge({ ...challenge, captchaDataUrl: result.captchaDataUrl, attemptsRemaining: result.attemptsRemaining })
        setCaptcha('')
        setNotice(result.message)
      } else {
        setChallenge(null)
        setNotice(result.message)
      }
    } catch (error) {
      if (isCurrentRequest(generation)) setNotice(errorMessage(error))
    } finally {
      if (isCurrentRequest(generation)) setBusy('')
    }
  }

  const selectProvider = (nextProvider: ProviderId): void => {
    setProvider(nextProvider)
    setSelected(null)
    setFiles([])
    setProviderErrors([])
  }

  const moveProviderFocus = (event: React.KeyboardEvent<HTMLButtonElement>, current: ProviderId): void => {
    const currentIndex = providerTabs.indexOf(current)
    if (currentIndex < 0) return
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? providerTabs.length - 1 : direction ? (currentIndex + direction + providerTabs.length) % providerTabs.length : -1
    if (nextIndex < 0) return
    event.preventDefault()
    const nextProvider = providerTabs[nextIndex]
    selectProvider(nextProvider)
    providerTabRefs.current[nextProvider]?.focus()
  }

  return <div className="third-party-mods-page">
    <h1 className="visually-hidden">模组下载</h1>
    <div className="third-party-layout">
      <aside className="third-party-browser">
        <div className="third-party-provider-tabs" role="tablist" aria-label="Mod 平台">
          {providerTabs.map((value) => <button ref={(element) => { providerTabRefs.current[value] = element }} id={`${providerPanelId}-${value}-tab`} key={value} type="button" role="tab" aria-selected={provider === value} aria-controls={`${providerPanelId}-panel`} tabIndex={provider === value ? 0 : -1} className={provider === value ? 'active' : ''} onClick={() => selectProvider(value)} onKeyDown={(event) => moveProviderFocus(event, value)}>{value === 'all' ? <Globe2 size={14} /> : value === 'mcmod' ? <PackagePlus size={14} /> : <Sparkles size={14} />}{providerLabel(value)}</button>)}
        </div>
        <div id={`${providerPanelId}-panel`} role="tabpanel" aria-labelledby={`${providerPanelId}-${provider}-tab`} tabIndex={0}>
          <form className="third-party-search" onSubmit={(event) => { event.preventDefault(); void search() }}>
            <Search size={15} /><input value={query} disabled={busy === 'search'} onChange={(event) => { const nextQuery = event.target.value; setQuery(nextQuery); if (nextQuery.trim() !== searchedQuery) { setSearchedQuery(''); setResults([]); setSelected(null); setFiles([]) } }} placeholder="搜索 Mod 名称或功能" maxLength={120} /><button className="icon-button" type="submit" title="搜索" disabled={Boolean(busy) || !query.trim()}>{busy === 'search' ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}</button>
          </form>
          {!query.trim() && !results.length ? <section className="third-party-recommendations"><div className="third-party-list-heading"><span>下载前置模组</span><small>适配 {project.minecraftVersion}</small></div>{recommended.filter((item) => provider === 'all' || item.provider === provider).map((item) => <button type="button" key={`${item.provider}:${item.projectId}`} onClick={() => void selectProject(item)}><ModIcon item={item} /><span><strong>{item.name}</strong><small>{item.provider === 'mcmod' ? 'MC百科' : providerLabel(item.provider)}</small></span><Download size={14} /></button>)}{!recommended.length ? <div className="third-party-empty"><LoaderCircle className="spin" size={18} /><span>正在读取推荐</span></div> : null}</section> : null}
          {displayResults.length ? <div className="third-party-list-heading"><span>{searchedQuery ? '搜索结果' : results.length ? '搜索结果' : '待处理依赖'}</span><small>{displayResults.length}</small></div> : null}
          <div className="third-party-results">{displayResults.map((item) => <button type="button" key={`${item.provider}:${item.projectId}`} className={selected?.provider === item.provider && selected.projectId === item.projectId ? 'selected' : ''} onClick={() => void selectProject(item)}><ModIcon item={item} /><span><strong>{item.name}</strong><small>{item.provider === 'mcmod' ? 'MC百科' : providerLabel(item.provider)}{downloadLabel(item)}</small></span></button>)}</div>
          {noCompatibleResults ? <div className="third-party-empty"><PackagePlus size={22} /><span>没有找到适配 {project.minecraftVersion} / {project.loader} 的 Mod</span></div> : null}
          {providerErrors.length ? <div className="third-party-provider-errors" role="alert">{providerErrors.map((entry) => <p key={entry.provider}><strong>{providerLabels[entry.provider as ProviderId] ?? entry.provider} 搜索失败</strong>{entry.message ? `：${entry.message}` : ''}。可在 设置 → 网络 配置代理后重试</p>)}</div> : null}
          {!searchedQuery && !results.length && !pendingResults.length && query.trim() ? <div className="third-party-empty"><PackagePlus size={22} /><span>输入关键词开始搜索</span></div> : null}
        </div>
      </aside>
      <main className="third-party-files">
        {notice ? <div className="third-party-feedback" role="status" aria-live="polite">{notice}</div> : null}
        {challenge ? <section className="captcha-dialog third-party-captcha-panel" role="dialog" aria-labelledby="captcha-title"><header><div><span>MC 百科</span><h2 id="captcha-title">完成验证码后下载</h2></div><button className="icon-button" type="button" title="关闭" disabled={Boolean(busy)} onClick={() => setChallenge(null)}><X size={16} /></button></header><div className="captcha-file"><strong>{challenge.file.filename}</strong><small>{challenge.file.minecraftVersion} · {challenge.file.loaders.join(' / ') || 'Loader 未知'}</small></div><div className="captcha-image-row"><img src={challenge.captchaDataUrl} alt="验证码" /><button className="icon-button" type="button" title="刷新验证码" disabled={Boolean(busy)} onClick={() => void refreshCaptcha()}>{busy === 'captcha-refresh' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div><label className="captcha-input"><span>验证码</span><input ref={captchaInputRef} value={captcha} onChange={(event) => setCaptcha(event.target.value.slice(0, 8))} onKeyDown={(event) => { if (event.key === 'Enter') void submitCaptcha() }} autoComplete="off" maxLength={8} /></label><footer><span>还可尝试 {challenge.attemptsRemaining} 次</span><button className="primary-button" type="button" disabled={Boolean(busy) || !captcha.trim()} onClick={() => void submitCaptcha()}>{busy === 'captcha-submit' ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载</button></footer></section> : <>
          {!selected ? <div className="third-party-welcome"><div className="third-party-welcome-icon"><Globe2 size={28} /></div><h2>选择一个 Mod</h2></div> : <>
          <div className="third-party-files-head"><div className="third-party-selected-heading"><ModIcon item={selected} /><div><span>{providerLabel(selected.provider)} · 兼容版本</span><h2>{selected.name}</h2><p>{selected.summary || '查看当前项目可以安装的版本'}</p></div></div><a className="secondary-button compact" href={selected.projectUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开平台页面</a></div>
          {busy === 'files' ? <div className="third-party-loading"><LoaderCircle className="spin" size={18} />正在读取版本</div> : null}
          {!busy && !compatibleFiles.length ? <div className="third-party-empty large"><PackagePlus size={26} /><span>没有找到适配 {project.minecraftVersion} / {project.loader} 的文件</span></div> : null}
          {compatibleFiles.length ? <div className="third-party-file-table" role="table" aria-label="兼容文件"><div className="third-party-file-row header" role="row"><span>文件与版本</span><span>运行侧</span><span>大小</span><span /></div>{compatibleFiles.map((file) => <div className="third-party-file-row" role="row" key={fileKey(file)}><span><strong>{file.filename}</strong><small>{file.provider === 'mcmod' ? `${file.minecraftVersion} · ${file.loaders.join(' / ') || 'Loader 未知'}` : file.versionName}</small></span><span>{file.provider === 'mcmod' ? '未知' : file.side}</span><span>{formatBytes(file.size)}</span><button className="icon-button" type="button" title="下载并加入整合包" disabled={Boolean(busy)} onClick={() => void beginDownload(file)}>{busy === `download:${fileKey(file)}` ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}</button></div>)}</div> : null}
          </>}
        </>}
      </main>
    </div>
  </div>
}
