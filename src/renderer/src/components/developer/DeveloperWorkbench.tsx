import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Braces, Check, CircleAlert, Code2, Download, Eye, FileCode2, FolderOpen, LoaderCircle, MessagesSquare, Moon, Play, Plus, RefreshCw, Save, Search, Square, Sun, Trash2, Undo2, Upload, X } from 'lucide-react'
import MoreActions from '../MoreActions'
import MonacoCodeEditor from '../MonacoCodeEditor'
import { useConfirmDialog, usePromptDialog } from '../InteractionDialogs'
import { waitForAppLoadingCover } from '../../useAppLoading'
import DeveloperAiPane, { type DeveloperAiProps } from './DeveloperAiPane'
import PackageConfiguration from './PackageConfiguration'
import type { DeveloperDebugInput, DeveloperDebugResult, DeveloperPreview, DeveloperState, DeveloperText, DeveloperProject } from '../../../../shared/developerWorkbench'
import './developer-workbench.css'

const api = () => window.modmind.developer
const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
type Buffer = DeveloperText & { saved: string; readOnly: boolean }
type View = 'source' | 'preview' | 'debug'
export default function DeveloperWorkbench({ darkMode, ai, onClose, onLoadingChange }: { darkMode: boolean; ai: DeveloperAiProps; onClose: () => void; onLoadingChange: (loading: boolean) => void }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<DeveloperState | null>(null)
  const [recent, setRecent] = useState<Omit<DeveloperProject, 'session'>[]>([])
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [kind, setKind] = useState<'feature' | 'studio'>('feature')
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const [file, setFile] = useState('renderer.tsx')
  const [view, setView] = useState<View>('source')
  const [formView, setFormView] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [aiRunning, setAiRunning] = useState(false)
  const [showAi, setShowAi] = useState(true)
  const [preview, setPreview] = useState<DeveloperPreview | null>(null)
  const [previewPage, setPreviewPage] = useState('')
  const [previewDark, setPreviewDark] = useState(darkMode)
  const [previewWidth, setPreviewWidth] = useState('fit')
  const [previewStatus, setPreviewStatus] = useState('尚未运行')
  const [readOnly, setReadOnly] = useState(false)
  const [operation, setOperation] = useState<DeveloperDebugInput['operation']>('action')
  const [debugName, setDebugName] = useState('')
  const [debugInput, setDebugInput] = useState('{\n  "text": "你好 ModMind"\n}')
  const [debugResult, setDebugResult] = useState<DeveloperDebugResult | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const current = useRef({ workspace, buffers, aiRunning, busy }); current.current = { workspace, buffers, aiRunning, busy }
  const livePreview = useRef(preview); livePreview.current = preview
  const draftReady = useRef('')
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const { prompt: requestPrompt, dialog: promptDialog } = usePromptDialog()
  const selected = buffers[file]
  const changed = Object.values(buffers).some(buffer => buffer.content !== buffer.saved)
  const locked = !!busy || aiRunning
  const fail = (error: unknown): void => { setError(message(error)); setStatus('') }
  const perform = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (current.current.busy) return
    setBusy(label); setError(''); setStatus('')
    try { await action() } catch (error) { fail(error) } finally { setBusy('') }
  }
  useEffect(() => {
    let disposed = false
    void api().recent().then(value => { if (!disposed) setRecent(value) }).catch(error => { if (!disposed) fail(error) }).finally(() => { if (!disposed) onLoadingChange(false) })
    return () => { disposed = true }
  }, [onLoadingChange])
  useEffect(() => {
    if (!workspace) return
    let disposed = false
    const cleanups: (() => void)[] = []
    void Promise.all([import('monaco-editor'), api().editorTypes()]).then(([monaco, libraries]) => {
      if (disposed) return
      const defaults = monaco.typescript.typescriptDefaults
      const previous = defaults.getCompilerOptions()
      defaults.setCompilerOptions({ ...previous, jsx: monaco.typescript.JsxEmit.ReactJSX, moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs, allowNonTsExtensions: true, esModuleInterop: true })
      cleanups.push(() => defaults.setCompilerOptions(previous))
      for (const library of libraries) { const handle = defaults.addExtraLib(library.content, library.path); cleanups.push(() => handle.dispose()) }
    }).catch(fail)
    return () => { disposed = true; for (const cleanup of cleanups.reverse()) cleanup() }
  }, [workspace?.project.session])
  useEffect(() => {
    if (!workspace) return
    let disposed = false
    const handles: { dispose: () => void }[] = []
    void import('monaco-editor').then(monaco => {
      if (disposed) return
      for (const buffer of Object.values(buffers)) if (/\.tsx?$/.test(buffer.path)) handles.push(monaco.typescript.typescriptDefaults.addExtraLib(buffer.content, `file:///modmind-developer/${workspace.project.session}/${buffer.path}`))
    })
    return () => { disposed = true; for (const handle of handles) handle.dispose() }
  }, [buffers, workspace?.project.session])
  useEffect(() => { setPreview(null); setPreviewStatus('调试模式已变化，请运行预览') }, [readOnly])
  const openFile = async (target: string, state = current.current.workspace): Promise<void> => {
    if (!state) return
    setFile(target); setView('source')
    if (current.current.buffers[target]) return
    const text = await api().read(state.project.session, target)
    if (current.current.workspace?.project.session !== state.project.session) return
    const readOnly = !!state.files.find(file => file.path === target)?.readOnly
    setBuffers(items => ({ ...items, [target]: { ...text, saved: text.content, readOnly } }))
  }
  const activate = async (state: DeveloperState | null): Promise<void> => {
    if (!state) return
    onLoadingChange(true)
    try {
      await waitForAppLoadingCover()
      draftReady.current = ''; current.current.workspace = state; current.current.buffers = {}
      setWorkspace(state); setBuffers({}); setPreview(null); setDebugResult(null); setStatus(''); setQuery(''); setView('source'); setCreateOpen(false); setError('')
      const entry = state.project.sourceMode === 'package' ? 'renderer.js' : 'renderer.tsx'
      const text = await api().read(state.project.session, entry)
      const restored: Record<string, Buffer> = { [entry]: { ...text, saved: text.content, readOnly: false } }
      const drafts = await api().drafts(state.project.session)
      for (const draft of drafts) {
        try {
          const existing = await api().read(state.project.session, draft.path)
          if (existing.content !== draft.content) restored[draft.path] = { ...draft, saved: existing.content, readOnly: false }
        } catch { /* Removed files stay untouched. */ }
      }
      draftReady.current = state.project.session
      setFile(drafts.find(draft => restored[draft.path])?.path ?? entry); setBuffers(restored)
      if (drafts.length) setStatus('已恢复未保存草稿；文件冲突会在保存时提示')
      setRecent(await api().recent())
    } finally { onLoadingChange(false) }
  }
  const saveAll = async (): Promise<void> => {
    const state = current.current.workspace
    if (!state) return
    for (const buffer of Object.values(current.current.buffers)) {
      if (buffer.content === buffer.saved) continue
      const saved = await api().write(state.project.session, buffer.path, buffer.content, buffer.revision)
      setBuffers(items => ({ ...items, [buffer.path]: { ...items[buffer.path], revision: saved.revision, saved: saved.content } }))
    }
    setWorkspace(await api().state(state.project.session))
    await api().saveDrafts(state.project.session, [])
  }
  const refresh = async (): Promise<void> => {
    const state = current.current.workspace
    if (!state) return
    const next = await api().state(state.project.session)
    setWorkspace(next)
    const updated: Record<string, Buffer> = {}
    for (const buffer of Object.values(current.current.buffers)) {
      if (buffer.content !== buffer.saved) { updated[buffer.path] = buffer; continue }
      if (!next.files.some(file => file.path === buffer.path)) continue
      try { const text = await api().read(state.project.session, buffer.path); updated[buffer.path] = { ...buffer, ...text, saved: text.content } } catch { updated[buffer.path] = buffer }
    }
    setBuffers(updated)
    if (livePreview.current && livePreview.current.buildId !== next.build?.id) { setPreview(null); setPreviewStatus('源码已更新，请运行预览') }
  }
  const leave = async (): Promise<void> => {
    const state = current.current.workspace
    if (aiRunning) { fail('请先停止 AI 任务'); return }
    if (changed && !await confirm({ title: '保存开发工程', message: '保存当前修改后返回项目选择。', confirmLabel: '保存并返回', cancelLabel: '继续编辑' })) return
    await perform('保存中', async () => { await saveAll(); if (state) await api().close(state.project.session); onClose() })
  }
  const runPreview = async (page = previewPage, dark = previewDark): Promise<void> => {
    const state = current.current.workspace
    if (!state) return
    await saveAll()
    setPreviewStatus('构建中')
    const build = await api().build(state.project.session)
    const next = await api().preview(state.project.session, page || undefined, dark, readOnly)
    setWorkspace(value => value ? { ...value, build } : value)
    setPreview(next); setPreviewPage(page || next.pages[0]?.id || ''); setView('preview'); setPreviewStatus('正在加载页面')
  }
  const runDebug = async (): Promise<void> => {
    if (!workspace) return
    await saveAll(); const build = await api().build(workspace.project.session)
    setWorkspace(value => value ? { ...value, build } : value)
    const result = await api().debug(workspace.project.session, { operation, name: debugName || choices[0]?.id, input: operation === 'inspect' ? {} : JSON.parse(debugInput), readOnly })
    setDebugResult(result); setStatus('调试已完成')
    if (operation === 'create-studio') { setPreview(null); setPreviewStatus('测试项目已创建，刷新预览可查看') }
  }
  useEffect(() => {
    if (!workspace || draftReady.current !== workspace.project.session) return
    const timeout = setTimeout(() => {
      const dirty = Object.values(buffers).filter(buffer => !buffer.readOnly && buffer.content !== buffer.saved).map(({ path, content, revision }) => ({ path, content, revision }))
      void api().saveDrafts(workspace.project.session, dirty).catch(fail)
    }, 150)
    return () => clearTimeout(timeout)
  }, [buffers, workspace?.project.session])
  useEffect(() => window.modmind.app.onCloseRequested(() => {
    const state = current.current
    if (state.workspace) void api().saveDrafts(state.workspace.project.session, Object.values(state.buffers).filter(buffer => !buffer.readOnly && buffer.content !== buffer.saved)).catch(fail)
  }), [])
  useEffect(() => {
    const listener = async (event: MessageEvent): Promise<void> => {
      const value = livePreview.current, state = current.current.workspace
      if (!value || !state || event.source !== frame.current?.contentWindow || event.data?.channel !== value.token) return
      const data = event.data
      if (data.type === 'ready') { setPreviewStatus('页面已加载 · 示例项目'); return }
      if (data.type === 'error') { setPreviewStatus('页面运行出错'); fail(data.value); return }
      if (data.type === 'notice') { setStatus(String(data.value)); return }
      if (data.type === 'navigate') {
        if (!value.pages.some(page => page.id === data.value)) { fail('预览中只能导航到当前开发包的页面'); return }
        try { const next = await api().preview(state.project.session, data.value, previewDark, readOnly); setPreviewPage(data.value); setPreview(next) } catch (error) { fail(error) }
      }
      if (data.type !== 'invoke' && data.type !== 'host-api') return
      try {
        if (current.current.aiRunning || current.current.busy) throw new Error('当前工程有任务运行，请稍后重试')
        const result = data.type === 'host-api'
          ? await api().previewInvoke(state.project.session, data.name, data.args, value.readOnly)
          : await api().previewInvoke(state.project.session, 'feature-plugins:invoke', [state.project.id, data.action, data.input], value.readOnly)
        if (livePreview.current?.token !== value.token) return
        frame.current?.contentWindow?.postMessage({ channel: value.token, id: data.id, result: result.result }, '*')
        for (const payload of result.events) if (!payload.delivered) frame.current?.contentWindow?.postMessage({ channel: value.token, type: 'event', value: payload }, '*')
        setDebugResult(result)
      } catch (error) { frame.current?.contentWindow?.postMessage({ channel: value.token, id: data.id, error: message(error) }, '*') }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [previewDark, readOnly])
  useEffect(() => api().onPreviewEvent(event => {
    const value = livePreview.current, state = current.current.workspace
    if (value && state?.project.session === event.session) frame.current?.contentWindow?.postMessage({ channel: value.token, type: 'ipc-event', name: event.channel, args: event.args }, '*')
  }), [])
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!locked) void perform('保存中', async () => { await saveAll(); setStatus('文件已保存') }) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [locked])
  useEffect(() => {
    if (!preview || view !== 'preview' || !changed || locked) return
    const timeout = setTimeout(() => { void perform('更新预览', () => runPreview()) }, 800)
    return () => clearTimeout(timeout)
  }, [buffers, view, locked])
  const choices = operation === 'tool' ? workspace?.manifest?.tools?.map(tool => ({ id: tool.name, label: tool.name })) ?? [] : operation === 'create-studio' ? workspace?.manifest?.studios?.map(studio => ({ id: studio.id, label: studio.name })) ?? [] : workspace?.manifest?.actions?.map(action => ({ id: action.id, label: action.id })) ?? []
  return <section className={`developer-workbench ${showAi ? 'with-ai' : ''}`} aria-label="ModMind开发者工作台">
    <header className="developer-toolbar">
      <button type="button" className="icon-button" title="返回项目选择" aria-label="返回项目选择" disabled={locked} onClick={() => void leave()}><ArrowLeft size={17} /></button>
      <div className="developer-current"><strong>{workspace?.project.name ?? 'ModMind开发者工作台'}</strong>{workspace ? <span>{workspace.project.kind === 'studio' ? '.mmstudio' : '.mmfeature'}{changed ? ' · 未保存' : ''}</span> : null}</div>
      {busy || error && !createOpen || status ? <div className="developer-feedback" role={error ? 'alert' : 'status'}>
        {busy ? <><LoaderCircle size={13} className="spin" /><span>{busy}</span>{workspace ? <button className="icon-button" type="button" onClick={() => { void api().cancel(workspace.project.session) }} aria-label="停止开发任务"><Square size={12} /></button> : null}</> : <>
          <MoreActions label={error ? '查看错误详情' : '查看操作结果'} text={(error || status).split('\n')[0]} icon={error ? <CircleAlert size={14} /> : <Check size={14} />}><div className="developer-feedback-details">{error || status}</div></MoreActions>
          <button className="icon-button" type="button" aria-label={error ? '收起错误' : '关闭操作结果'} onClick={() => { setError(''); setStatus('') }}><X size={12} /></button>
        </>}
      </div> : null}
      {workspace ? <div className="developer-toolbar-actions">
        <button type="button" className="secondary-button compact" disabled={locked || !changed} onClick={() => void perform('保存中', async () => { await saveAll(); setStatus('文件已保存') })}><Save size={14} />保存</button>
        <button type="button" className="secondary-button compact" disabled={locked} onClick={() => void perform('运行预览', () => runPreview())}><Play size={14} />运行预览</button>
        <button type="button" className="primary-button compact" disabled={locked} onClick={() => void perform('导出中', async () => { await saveAll(); const build = await api().build(workspace.project.session); setWorkspace(value => value ? { ...value, build } : value); const output = await api().export(workspace.project.session); if (output) setStatus('已导出：' + output.path) })}><Download size={14} />导出</button>
        <button type="button" className="icon-button" aria-label={showAi ? '收起开发 AI' : '展开开发 AI'} title={showAi ? '收起开发 AI' : '展开开发 AI'} aria-pressed={showAi} onClick={() => setShowAi(value => !value)}><MessagesSquare size={17} /></button>
        <MoreActions label="开发工程更多操作"><button type="button" disabled={locked} onClick={() => void (async () => {
          if (!await confirm({ title: '恢复 AI 修改前的工程', message: '将源码恢复到最近一次 AI 任务开始前。当前源码会保留为反向恢复点，再次恢复可取回。', confirmLabel: '保存并恢复' })) return
          await perform('恢复工程', async () => { await saveAll(); await api().restoreCheckpoint(workspace.project.session); await refresh(); setPreview(null); setStatus('已恢复 AI 修改前的工程') })
        })().catch(fail)}><Undo2 size={14} />恢复 AI 修改前</button><button type="button" disabled={locked || !selected} onClick={() => void (async () => {
          if (selected?.content !== selected?.saved && !await confirm({ title: '重新读取文件', message: '放弃当前文件的未保存草稿，读取磁盘上的最新内容。', confirmLabel: '放弃草稿并读取' })) return
          await perform('读取文件', async () => { const value = await api().read(workspace.project.session, file); setBuffers(items => ({ ...items, [file]: { ...value, saved: value.content, readOnly: selected?.readOnly ?? false } })) })
        })().catch(fail)}><RefreshCw size={14} />重新读取当前文件</button></MoreActions>
      </div> : null}
    </header>
    {!workspace ? <div className="developer-start">
      <div className="developer-start-actions"><button type="button" className="primary-button" disabled={locked} onClick={() => { setCreateOpen(true); setError('') }}><Plus size={16} />新建开发工程</button><button type="button" className="secondary-button" disabled={locked} onClick={() => void perform('打开工程', async () => activate(await api().open()))}><FolderOpen size={16} />打开开发工程</button><button type="button" className="secondary-button" disabled={locked} onClick={() => void perform('导入扩展包', async () => activate(await api().importPackage()))}><Upload size={16} />导入功能或工作台</button></div>
      <div className="developer-recent-heading"><strong>最近开发工程</strong><label className="developer-search"><Search size={14} /><input aria-label="搜索开发工程" placeholder="搜索名称或包 ID" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="developer-recent-list">{recent.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" disabled={locked} key={item.root} onClick={() => void perform('打开工程', async () => activate(await api().open(item.root)))}><Code2 size={18} /><span><strong>{item.name}</strong><small>{item.id}</small></span><span>{item.kind === 'studio' ? '工作台包' : '功能包'}</span></button>)}{!recent.length ? <p>还没有开发工程。</p> : null}</div>
    </div> : <div className="developer-layout">
      <aside className="developer-files" aria-label="开发工程文件">
        <div className="developer-file-tools"><label className="developer-search"><Search size={13} /><input aria-label="搜索开发文件" placeholder="搜索文件" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="icon-button" title="新建文件" aria-label="新建开发文件" disabled={locked} onClick={() => void (async () => {
          const path = await requestPrompt({ title: '新建文件', inputLabel: '相对路径', placeholder: 'components/Editor.tsx', confirmLabel: '创建文件' })
          if (!path) return
          await perform('创建文件', async () => { const text = await api().write(workspace.project.session, path, '', null); setBuffers(items => ({ ...items, [path]: { ...text, saved: text.content, readOnly: false } })); setWorkspace(await api().state(workspace.project.session)); setFile(path); setView('source') })
        })().catch(fail)}><Plus size={14} /></button><button type="button" className="icon-button" title="导入图片、字体或文本" aria-label="导入开发资源" disabled={locked} onClick={() => void perform('导入资源', async () => { const state = await api().importAssets(workspace.project.session); if (state) { setWorkspace(state); setStatus('资源已导入 assets 目录') } })}><Upload size={13} /></button><button type="button" className="icon-button" title="刷新文件" aria-label="刷新开发文件" disabled={locked} onClick={() => void perform('刷新文件', refresh)}><RefreshCw size={13} /></button></div>
        <div className="developer-file-list">{workspace.files.filter(item => item.path.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.path} type="button" className={file === item.path ? 'active' : ''} title={item.path} aria-current={file === item.path ? 'page' : undefined} onClick={() => void openFile(item.path).catch(fail)}><FileCode2 size={13} /><span>{item.path}</span>{buffers[item.path]?.content !== buffers[item.path]?.saved ? <i aria-label="未保存">●</i> : null}</button>)}</div>
      </aside>
      <main className="developer-content">
        <div className="developer-tabs" role="tablist" aria-label="开发视图">{([{ id: 'source', label: '源码', icon: Code2 }, { id: 'preview', label: '预览', icon: Eye }, { id: 'debug', label: '调试', icon: Braces }] as const).map(tab => <button type="button" role="tab" aria-selected={view === tab.id} key={tab.id} onClick={() => setView(tab.id)}><tab.icon size={14} />{tab.label}</button>)}<span /></div>
        {view === 'source' ? <div className="developer-editor">
          <div className="developer-editor-heading"><span title={file}>{file}</span>{selected?.readOnly ? <small>只读</small> : null}{file === 'manifest.json' ? <button type="button" className="secondary-button compact" onClick={() => setFormView(value => !value)}>{formView ? '编辑 JSON' : '表单'}</button> : null}
            {selected && !selected.readOnly ? <button type="button" className="icon-button" title="删除当前文件" aria-label="删除当前开发文件" disabled={locked || ['main.ts', 'renderer.tsx', 'main.cjs', 'renderer.js', 'renderer.css', 'manifest.json'].includes(file)} onClick={() => void (async () => {
              if (!await confirm({ title: '删除文件', message: `删除 ${file}，未保存内容也会移除。`, confirmLabel: '删除文件', tone: 'danger' })) return
              await perform('删除文件', async () => { await api().remove(workspace.project.session, file, selected.revision); setBuffers(items => { const next = { ...items }; delete next[file]; return next }); await openFile(workspace.project.sourceMode === 'package' ? 'renderer.js' : 'renderer.tsx'); setWorkspace(await api().state(workspace.project.session)) })
            })().catch(fail)}><Trash2 size={13} /></button> : null}
          </div>
          {selected ? file === 'manifest.json' && formView ? <PackageConfiguration content={selected.content} readOnly={selected.readOnly || locked} onChange={content => setBuffers(items => ({ ...items, [file]: { ...items[file], content } }))} /> : <MonacoCodeEditor path={`file:///modmind-developer/${workspace.project.session}/${file}`} language={/\.tsx?$/.test(file) ? 'typescript' : /\.[cm]?jsx?$/.test(file) ? 'javascript' : file.endsWith('.css') ? 'css' : file.endsWith('.json') ? 'json' : 'markdown'} value={selected.content} darkMode={darkMode} readOnly={selected.readOnly || aiRunning} onChange={content => setBuffers(items => ({ ...items, [file]: { ...items[file], content } }))} onSave={() => { if (!locked) void perform('保存中', saveAll) }} /> : <div className="developer-panel-message">正在读取文件…</div>}
        </div> : null}
        {view === 'preview' ? <div className="developer-preview">
          <div className="developer-preview-toolbar"><select aria-label="预览页面" value={previewPage} disabled={locked || !preview} onChange={event => { setPreviewPage(event.target.value); void perform('更新预览', () => runPreview(event.target.value)) }}>{(preview?.pages ?? workspace.manifest?.views?.map(view => ({ id: view.id, label: view.label })) ?? []).map(page => <option key={page.id} value={page.id}>{page.label}</option>)}</select><select aria-label="预览宽度" value={previewWidth} onChange={event => setPreviewWidth(event.target.value)}><option value="fit">适应面板</option><option value="1080">1080 px</option><option value="1440">1440 px</option></select><button type="button" className="icon-button" title={previewDark ? '预览浅色' : '预览深色'} aria-label={previewDark ? '预览浅色' : '预览深色'} disabled={locked} onClick={() => { setPreviewDark(value => !value); void perform('更新预览', () => runPreview(previewPage, !previewDark)) }}>{previewDark ? <Sun size={15} /> : <Moon size={15} />}</button><button type="button" className="icon-button" title="刷新预览" aria-label="刷新预览" disabled={locked} onClick={() => void perform('更新预览', () => runPreview())}><RefreshCw size={14} /></button></div>
          <div className="developer-preview-stage">{preview ? <iframe ref={frame} title="开发包页面预览" sandbox="allow-scripts allow-forms allow-downloads allow-same-origin" src={preview.url} style={{ width: previewWidth === 'fit' ? '100%' : `${previewWidth}px`, flexShrink: 0 }} /> : <div className="developer-panel-message"><p>运行当前包，查看界面并调用业务动作。</p><button className="secondary-button" type="button" disabled={locked} onClick={() => void perform('运行预览', () => runPreview())}><Play size={14} />运行预览</button></div>}</div><div className="developer-preview-status" role="status">{previewStatus}</div>
        </div> : null}
        {view === 'debug' ? <div className="developer-debug">
          <div className="developer-debug-controls"><label>调试类型<select aria-label="调试类型" value={operation} disabled={locked} onChange={event => { const next = event.target.value as DeveloperDebugInput['operation']; setOperation(next); setDebugName(''); setDebugInput(next === 'create-studio' ? '{\n  "name": "测试文稿"\n}' : '{\n  "text": "你好 ModMind"\n}') }}><option value="action">业务动作</option><option value="tool">MCP 工具</option>{workspace.project.kind === 'studio' ? <option value="create-studio">创建测试项目</option> : null}<option value="inspect">检查运行时</option></select></label>
            {operation !== 'inspect' ? <label>调用对象<select aria-label="调试对象" value={debugName || choices[0]?.id || ''} disabled={locked} onChange={event => setDebugName(event.target.value)}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label> : null}
            <label className="developer-check"><input type="checkbox" checked={readOnly} disabled={locked} onChange={event => setReadOnly(event.target.checked)} />只读模式</label></div>
          {operation !== 'inspect' ? <label className="developer-debug-input">{operation === 'create-studio' ? '创建字段（JSON，未填写的字段使用默认值）' : '调用参数（JSON）'}<textarea aria-label="调试参数" value={debugInput} onChange={event => setDebugInput(event.target.value)} spellCheck={false} /></label> : null}
          <div className="developer-debug-actions"><button className="secondary-button" type="button" disabled={locked || operation !== 'inspect' && !choices.length} onClick={() => void perform('调试中', runDebug)}><Play size={14} />{operation === 'create-studio' ? '创建测试项目' : '运行调试'}</button><span>独立本地测试进程</span></div>
          <div className="developer-debug-result" role="log">{debugResult ? <><strong>已完成 · {debugResult.buildId.slice(0, 8)}</strong><pre>{JSON.stringify(debugResult.result, null, 2)}</pre>{debugResult.logs.length ? <><strong>日志</strong><pre>{debugResult.logs.join('\n')}</pre></> : null}</> : <p>运行后查看结果、创建的文件与日志。</p>}</div>
        </div> : null}
      </main>
      <aside className="developer-ai" hidden={!showAi} aria-label="开发 AI"><DeveloperAiPane key={workspace.project.session} project={workspace.project} ai={ai} beforeRun={saveAll} afterRun={refresh} onRunningChange={setAiRunning} onError={fail} onShowLog={() => setView('debug')} onOpenFile={file => { void openFile(file.replace(workspace.project.root + '/', '')).catch(fail) }} /></aside>
    </div>}
    {createOpen ? <div className="modal-backdrop"><form role="dialog" aria-modal="true" aria-label="新建开发工程" className="dialog developer-create-dialog" onSubmit={event => { event.preventDefault(); void perform('创建工程', async () => activate(await api().create({ id, name, kind }))) }}><div className="dialog-header"><h2>新建开发工程</h2><button className="icon-button" type="button" aria-label="关闭新建开发工程" disabled={locked} onClick={() => setCreateOpen(false)}><X size={17} /></button></div><label>包类型<select aria-label="包类型" value={kind} onChange={event => setKind(event.target.value as 'feature' | 'studio')}><option value="feature">功能包 · .mmfeature</option><option value="studio">自定义工作台 · .mmstudio</option></select></label><label>名称<input autoFocus value={name} maxLength={80} required onChange={event => setName(event.target.value)} placeholder="例如：笔记工作台" /></label><label>包 ID<input value={id} required maxLength={64} onChange={event => setId(event.target.value)} placeholder="例如：notes-studio" /></label><div className="dialog-footer"><button type="button" className="secondary-button" disabled={locked} onClick={() => setCreateOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={locked || !name.trim() || !/^[a-z][a-z0-9-]{0,63}$/.test(id)}>选择位置并创建</button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}</form></div> : null}
    {confirmDialog}{promptDialog}
  </section>
}
