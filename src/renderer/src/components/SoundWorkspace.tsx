import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Download, FolderPlus, LoaderCircle, Music, Play, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trash2, Upload, Volume2, X } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { ContentValidationResult } from '../../../shared/production'
import type { SoundEvent, SoundLibraryItem, SoundLibraryResult } from '../../../shared/soundLibrary'
import { reportClientFailure } from '../lib/clientFailure'
import MoreActions from './MoreActions'
import WorkspaceTabs from './WorkspaceTabs'
import SoundEventEditor from './SoundEventEditor'
import SoundStudio from './SoundStudio'
import './authoring-pages.css'
import './sound-workspace.css'

function localAudioUrl(dataUrl: string): string {
  const separator = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:audio/') || separator < 0) throw new Error('声音预览格式无效')
  const mime = dataUrl.slice(5, separator).split(';')[0]
  const decoded = atob(dataUrl.slice(separator + 1))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export default function SoundWorkspace({ projectPath, projectNamespace, onFilesChanged }: { projectPath: string; projectNamespace: string; onFilesChanged: () => void }): React.JSX.Element {
  return <WorkspaceTabs label="声音工作台" sections={[
    { id: 'library', label: '声音库', render: () => <SoundBrowsePane projectPath={projectPath} onFilesChanged={onFilesChanged} /> },
    { id: 'events', label: '事件', render: () => <SoundEventEditor projectPath={projectPath} projectNamespace={projectNamespace} onFilesChanged={onFilesChanged} /> },
    { id: 'studio', label: '制作', render: () => <SoundStudio projectPath={projectPath} onFilesChanged={onFilesChanged} /> }
  ]} />
}

function SoundBrowsePane({ projectPath, onFilesChanged }: { projectPath: string; onFilesChanged: () => void }): React.JSX.Element {
  const api = window.modmind.production.sounds
  const [library, setLibrary] = useState<SoundLibraryResult | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<SoundEvent | null>(null)
  const [selectedAudio, setSelectedAudio] = useState<SoundLibraryItem | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [kind, setKind] = useState('all')
  const [view, setView] = useState<'events' | 'tracks'>('events')
  const [audioUrl, setAudioUrl] = useState('')
  const [audioError, setAudioError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [groupImport, setGroupImport] = useState(false)
  const [eventId, setEventId] = useState('')
  const [validation, setValidation] = useState<ContentValidationResult | null>(null)
  const [processOpen, setProcessOpen] = useState(false)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState('')
  const [fadeIn, setFadeIn] = useState(0)
  const [fadeOut, setFadeOut] = useState(0)
  const [gain, setGain] = useState(1)
  const [mono, setMono] = useState(false)
  const [reverse, setReverse] = useState(false)
  const [outputId, setOutputId] = useState('')
  const audio = useRef<HTMLAudioElement>(null)
  const blobUrl = useRef('')
  const generation = useRef(0)
  const setLocalAudio = (dataUrl: string): void => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current)
    blobUrl.current = dataUrl ? localAudioUrl(dataUrl) : ''
    setAudioUrl(blobUrl.current)
  }
  useEffect(() => () => { if (blobUrl.current) URL.revokeObjectURL(blobUrl.current) }, [])
  const loadLibrary = async (refresh = false): Promise<void> => {
    setBusy('load')
    try {
      const result = await api.list(projectPath, refresh)
      setLibrary(result)
      setSelectedEvent(current => result.events.find(item => item.key === current?.key) ?? null)
      setSelectedAudio(current => result.items.find(item => item.id === current?.id) ?? null)
      setNotice('')
    } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') }
  }
  useEffect(() => { void loadLibrary() }, [projectPath])
  useEffect(() => {
    audio.current?.pause(); setLocalAudio(''); setAudioError('')
    const current = ++generation.current
    if (!selectedAudio) return
    void api.preview(projectPath, selectedAudio.id).then(result => { if (generation.current === current) setLocalAudio(result.dataUrl) }).catch(error => { if (generation.current === current) setAudioError(reportClientFailure(error)) })
  }, [selectedAudio?.id, projectPath])
  const selectedTracks = useMemo(() => selectedEvent ? (library?.items ?? []).filter(item => item.eventKey === selectedEvent.key) : [], [library, selectedEvent])
  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const accepts = (item: { sourceId?: string; source: string; kind?: string; name?: string; id?: string; eventId?: string; subtitle?: string; path?: string }): boolean => (source === 'all' || source === (item.sourceId ?? item.source)) && (kind === 'all' || kind === item.kind) && (!needle || [item.name, item.id, item.eventId, item.subtitle, item.path].some(text => text?.toLowerCase().includes(needle)))
    if (view === 'tracks') return (library?.items ?? []).filter(accepts)
    return (library?.events ?? []).filter(item => (source === 'all' || item.sourceId === source) && (kind === 'all' || (library?.items.some(audio => audio.eventKey === item.key && audio.kind === kind) ?? false)) && (!needle || [item.id, item.namespace, item.subtitle, ...item.definition.sounds.map(raw => typeof raw === 'string' ? raw : raw.name)].some(text => text?.toLowerCase().includes(needle))))
  }, [library, query, source, kind, view])
  const selectEvent = (event: SoundEvent): void => { setSelectedEvent(event); setSelectedAudio(null) }
  const selectAudio = (item: SoundLibraryItem): void => { setSelectedAudio(item); setSelectedEvent(library?.events.find(event => event.key === item.eventKey) ?? null); setOutputId('edit/' + item.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_.-]/g, '_')); setProcessOpen(false) }
  const download = async (): Promise<void> => {
    if (!selectedAudio) return
    const current = ++generation.current; setBusy('download'); setAudioError('')
    try {
      const result = await api.preview(projectPath, selectedAudio.id, true)
      if (generation.current === current) { setLocalAudio(result.dataUrl); setSelectedAudio({ ...selectedAudio, available: true }); setNotice('音频已就绪') }
    } catch (error) { setAudioError(reportClientFailure(error)) } finally { setBusy('') }
  }
  const importAudio = async (): Promise<void> => {
    setBusy('import'); setNotice('')
    try {
      const result = await api.import(projectPath, { group: groupImport, eventId, stream: false })
      if (result) { setNotice('已导入 ' + result.imported + ' 个声音' + (result.errors.length ? '；' + result.errors.join('；') : '')); onFilesChanged(); await loadLibrary(true) }
    } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') }
  }
  const addFolder = async (minecraft = false): Promise<void> => { setBusy('folder'); try { if (await api.addFolder(projectPath, minecraft)) await loadLibrary(true) } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') } }
  const fetchVanilla = async (): Promise<void> => { setBusy('catalog'); try { await api.fetchVanilla(projectPath); await loadLibrary(true) } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') } }
  const validate = async (): Promise<void> => { setBusy('validate'); try { setValidation(await window.modmind.production.content.validate()) } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') } }
  const processAudio = async (): Promise<void> => {
    if (!selectedAudio) return
    setBusy('process'); setNotice('')
    try {
      await api.process(projectPath, { id: selectedAudio.id, eventId: outputId.trim(), start, end: end ? Number(end) : undefined, fadeIn, fadeOut, gain, mono, reverse })
      onFilesChanged(); await loadLibrary(true); setNotice('已生成到项目事件 ' + outputId.trim())
    } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') }
  }
  const removeFolder = async (): Promise<void> => { if (!source.startsWith('library:')) return; setBusy('folder'); try { await api.removeFolder(projectPath, source); setSource('all'); await loadLibrary(true) } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy('') } }
  return <div className="production-pane sound-library-pane authoring-workspace">
    <div className="sound-library-toolbar">
      <label className="sound-search"><Search size={15} /><span className="visually-hidden">搜索声音</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事件、曲目或字幕" /></label>
      <select aria-label="声音来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option>{library?.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="声音类型" value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部类型</option><option value="effect">音效</option><option value="music">音乐</option><option value="unknown">未分类</option></select>
      <div className="sound-mode sound-browse-mode" role="group" aria-label="浏览方式"><button type="button" className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>事件</button><button type="button" className={view === 'tracks' ? 'active' : ''} onClick={() => setView('tracks')}>曲目</button></div>
      <button className="icon-button" type="button" title="刷新声音库" aria-label="刷新声音库" disabled={Boolean(busy)} onClick={() => void loadLibrary(true)}><RefreshCw size={15} className={busy === 'load' ? 'spin' : ''} /></button>
      <button className="primary-button compact" type="button" disabled={Boolean(busy) || groupImport && !eventId.trim()} onClick={() => void importAudio()}><Upload size={14} />导入音频</button>
      <MoreActions label="声音库更多操作"><button type="button" onClick={() => void addFolder()}><FolderPlus size={14} />添加素材目录</button><button type="button" onClick={() => void addFolder(true)}><FolderPlus size={14} />添加 Minecraft 目录</button>{source.startsWith('library:') ? <button type="button" onClick={() => void removeFolder()}><Trash2 size={14} />移除素材目录</button> : null}<button type="button" onClick={() => void fetchVanilla()}><Download size={14} />获取当前版本原版目录</button><button type="button" onClick={() => void validate()}><ShieldCheck size={14} />验证项目资源</button><button type="button" onClick={() => void api.clearCache(projectPath).then(() => setNotice('已清理原版试听缓存')).catch(error => setNotice(reportClientFailure(error)))}><Trash2 size={14} />清理试听缓存</button></MoreActions>
    </div>
    {groupImport ? <div className="sound-import-options"><label>随机变体事件 ID<input value={eventId} onChange={event => setEventId(event.target.value)} placeholder="ambient/wind" /></label></div> : null}
    <label className="sound-import-toggle"><input type="checkbox" checked={groupImport} onChange={event => setGroupImport(event.target.checked)} />将导入的音频作为同一事件的随机变体</label>
    <div className="sound-library-grid">
      <section className="sound-library-list" aria-label={view === 'events' ? '声音事件列表' : '音频曲目列表'}>
        <div className="sound-library-list-heading"><strong>{matched.length} {view === 'events' ? '个事件' : '个音频'}</strong><span>{library?.sourceStatus.project ?? '读取中'}</span></div>
        {view === 'events' ? <Virtuoso className="sound-library-items" data={matched as SoundEvent[]} itemContent={(_, item) => <button className={'sound-library-item ' + (selectedEvent?.key === item.key ? 'selected' : '')} type="button" onClick={() => selectEvent(item)}><span className="sound-item-icon">{item.id.startsWith('music.') || item.id.startsWith('music_disc.') ? <Music size={15} /> : <Volume2 size={15} />}</span><span className="sound-item-copy"><strong>{item.subtitle && !item.subtitle.startsWith('subtitles.') ? item.subtitle : item.id}</strong><span>{item.namespace}:{item.id} · {item.sourceLabel}</span></span></button>} /> : <Virtuoso className="sound-library-items" data={matched as SoundLibraryItem[]} itemContent={(_, item) => <button className={'sound-library-item ' + (selectedAudio?.id === item.id ? 'selected' : '')} type="button" onClick={() => selectAudio(item)}><span className="sound-item-icon">{item.kind === 'music' ? <Music size={15} /> : <Volume2 size={15} />}</span><span className="sound-item-copy"><strong>{item.name}</strong><span>{item.eventId || item.path} · {item.sourceLabel}</span></span><span className={'sound-item-state ' + (item.available ? 'available' : '')} title={item.available ? '可试听' : '按需下载或本地缺失'}>{item.available ? <Play size={12} /> : <CircleAlert size={12} />}</span></button>} />}
      </section>
      <section className="sound-library-detail" aria-label="声音预览">
        {selectedEvent ? <><div className="sound-detail-heading"><div><strong>{selectedEvent.subtitle && !selectedEvent.subtitle.startsWith('subtitles.') ? selectedEvent.subtitle : selectedEvent.id}</strong><span>{selectedEvent.namespace}:{selectedEvent.id} · {selectedEvent.sourceLabel}</span></div></div><div className="sound-event-tracks">{selectedTracks.map(item => <button key={item.id} type="button" className={'sound-event-track ' + (selectedAudio?.id === item.id ? 'selected' : '')} onClick={() => selectAudio(item)}><span>{item.name}</span><span>{item.kind === 'music' ? '音乐' : '音效'}{item.weight !== undefined ? ' · 权重 ' + item.weight : ''}</span></button>)}{!selectedTracks.length ? <p className="sound-library-empty">此事件没有直接音频，可能引用了其他事件。</p> : null}</div></> : selectedAudio ? <div className="sound-detail-heading"><div><strong>{selectedAudio.name}</strong><span>{selectedAudio.eventId || selectedAudio.path} · {selectedAudio.sourceLabel}</span></div></div> : <p className="sound-library-empty">选择事件或曲目查看声音</p>}
        {selectedAudio ? <div className="sound-audio-player"><div className="sound-player-row">{audioUrl ? <audio key={selectedAudio.id} ref={audio} controls src={audioUrl} /> : selectedAudio.source === 'vanilla' ? <button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void download()}>{busy === 'download' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}下载并试听{selectedAudio.size ? ' · ' + (selectedAudio.size / 1024 / 1024).toFixed(1) + ' MiB' : ''}</button> : <span>本地音频缺失</span>}</div>{audioError ? <p className="sound-player-error" role="alert">{audioError}</p> : null}<div className="sound-detail-meta"><span>{selectedAudio.stream ? '流式播放' : '短音效'}</span>{selectedAudio.volume !== undefined ? <span>音量 {selectedAudio.volume}</span> : null}{selectedAudio.pitch !== undefined ? <span>音调 {selectedAudio.pitch}</span> : null}<span>{selectedAudio.path}</span></div><button className="secondary-button compact" type="button" disabled={!audioUrl} onClick={() => setProcessOpen(value => !value)}><SlidersHorizontal size={14} />加工音频</button>{processOpen ? <div className="sound-process-fields"><label>起点 秒<input type="number" min={0} max={3600} step={0.1} value={start} onChange={event => setStart(Number(event.target.value))} /></label><label>终点 秒<input type="number" min={0} max={3600} step={0.1} value={end} onChange={event => setEnd(event.target.value)} placeholder="文件末尾" /></label><label>淡入 秒<input type="number" min={0} max={3600} step={0.1} value={fadeIn} onChange={event => setFadeIn(Number(event.target.value))} /></label><label>淡出 秒<input type="number" min={0} max={3600} step={0.1} value={fadeOut} onChange={event => setFadeOut(Number(event.target.value))} /></label><label>音量倍数<input type="number" min={0} max={4} step={0.1} value={gain} onChange={event => setGain(Number(event.target.value))} /></label><label>输出事件 ID<input value={outputId} onChange={event => setOutputId(event.target.value)} /></label><label className="sound-process-check"><input type="checkbox" checked={mono} onChange={event => setMono(event.target.checked)} />单声道</label><label className="sound-process-check"><input type="checkbox" checked={reverse} onChange={event => setReverse(event.target.checked)} />倒放</label><button className="primary-button compact" type="button" disabled={Boolean(busy) || !outputId.trim()} onClick={() => void processAudio()}>{busy === 'process' ? <LoaderCircle className="spin" size={14} /> : <SlidersHorizontal size={14} />}生成项目音频</button></div> : null}</div> : null}
        <div className="sound-vanilla-status">{library?.sourceStatus.vanilla ?? '正在读取原版目录'}</div>
      </section>
    </div>
    {busy === 'catalog' ? <div className="authoring-feedback" role="status"><LoaderCircle className="spin" size={14} />正在获取当前版本原版目录 <button className="secondary-button compact" onClick={() => void api.cancel(projectPath)}><X size={14} />取消</button></div> : null}
    {notice ? <div className="authoring-feedback" role="status"><CircleAlert size={14} />{notice}</div> : null}
    {library?.sources.some(item => item.error) ? <details className="authoring-details sound-source-issues"><summary>部分声音来源不可用</summary>{library.sources.filter(item => item.error).map(item => <p key={item.id}>{item.name}：{item.error}</p>)}</details> : null}
    {validation ? <div className={'authoring-validation ' + (validation.success ? 'success' : 'error')}><div className="authoring-feedback" role="status"><ShieldCheck size={15} /><strong>{validation.success ? '资源验证通过' : '资源验证失败'}</strong><span>{validation.checkedFiles} 个文件 · {validation.errors.length} 个错误 · {validation.warnings.length} 个警告</span></div>{[...validation.errors, ...validation.warnings].map((message, index) => <p key={index}>{message}</p>)}</div> : null}
  </div>
}
