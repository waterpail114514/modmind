import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Code2, Download, FileJson, FolderOpen, Grid3X3, LoaderCircle, Plus, Save, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type { ProjectInfo } from '../../../src/shared/types'
import { DATA_PACK_KINDS, dataPackPath, readDataPackForm, writeDataPackForm, type DataPackDocument, type DataPackEntry, type DataPackForm, type DataPackInfo, type DataPackKind, type DataPackValidation } from '../../../src/shared/dataPack'
import { useConfirmDialog, usePromptDialog } from '../../../src/renderer/src/components/InteractionDialogs'
import MoreActions from '../../../src/renderer/src/components/MoreActions'
import GameResourceSources from '../../sdk/GameResourceSources'
import ItemPicker from './ItemPicker'
import DataPackHistory from './DataPackHistory'
import './data-packs.css'

type Draft = { root: string; document: DataPackDocument | null; text: string }
const drafts = new Map<string, Draft>()
export default function DataPackWorkspace({ project, onFilesChanged, onTest }: { project: ProjectInfo; onFilesChanged: () => void; onTest: () => void }): React.JSX.Element {
  const cached = drafts.get(project.path)
  const [packs, setPacks] = useState<DataPackInfo[]>([]), [root, setRoot] = useState(cached?.root ?? ''), [entries, setEntries] = useState<DataPackEntry[]>([]), [document, setDocument] = useState<DataPackDocument | null>(cached?.document ?? null), [text, setText] = useState(cached?.text ?? '')
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [mode, setMode] = useState<'visual' | 'source' | 'changes'>('visual'), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [validation, setValidation] = useState<DataPackValidation | null>(null), [newKind, setNewKind] = useState<DataPackKind>('recipe-shaped'), [picker, setPicker] = useState<number | 'result' | null>(null), [sources, setSources] = useState(false), [revision, setRevision] = useState(0)
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [tagDraft, setTagDraft] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirmDialog(), { prompt, dialog: promptDialog } = usePromptDialog()
  const alive = useRef(true), snapshot = useRef<Draft>({ root, document, text }), opening = useRef(0)
  snapshot.current = { root, document, text }
  const dirty = Boolean(document && text !== document.content), archived = packs.find(p => p.root === root)?.archived
  const parsed = document ? readDataPackForm(document.kind, text) : { form: null, reason: '' }
  const iconIds = [...new Set([...(parsed.form?.slots ?? []), parsed.form?.result ?? ''].filter(id => id && !id.startsWith('#')))].join('|')
  useEffect(() => { let active = true; if (!iconIds) { setIcons({}); return }; void window.modmind.featurePlugins.invoke('data-packs', 'source:icons', { projectPath: project.path, ids: iconIds.split('|') }).then(result => { if (active) setIcons(result as Record<string, string>) }).catch(() => { if (active) setIcons({}) }); return () => { active = false } }, [iconIds, project.path, revision])
  const invoke = <T,>(action: string, input: Record<string, unknown> = {}) => window.modmind.featurePlugins.invoke('data-packs', action, { ...input, projectPath: project.path }) as Promise<T>
  const run = async (label: string, operation: () => Promise<void>) => { setBusy(label); setError(''); setNotice(''); try { await operation() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) } finally { if (alive.current) setBusy('') } }
  const refreshPacks = async () => { const result = await invoke<{ packs: DataPackInfo[] }>('query', { operation: 'list' }); if (alive.current) { setPacks(result.packs); setRoot(current => result.packs.some(p => p.root === current) ? current : result.packs[0]?.root ?? '') } }
  useEffect(() => { alive.current = true; void run('读取数据包', refreshPacks); return () => { alive.current = false; opening.current++; if (snapshot.current.document && snapshot.current.text !== snapshot.current.document.content) { drafts.delete(project.path); drafts.set(project.path, snapshot.current); while (drafts.size > 4) drafts.delete(drafts.keys().next().value!) } else drafts.delete(project.path) } }, [project.path])
  useEffect(() => {
    if (!root) { setLoading(false); setEntries([]); return }
    let active = true; setLoading(true)
    const timer = setTimeout(() => { void invoke<{ entries: DataPackEntry[]; total: number }>('query', { operation: 'files', root, query, offset, limit: 200 }).then(result => { if (active) { setEntries(result.entries); setTotal(result.total) } }).catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setLoading(false) }) }, query ? 120 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [root, query, offset, revision])
  const canLeave = () => !dirty ? Promise.resolve(true) : confirm({ title: '放弃未保存的修改？', message: '当前数据文件的修改尚未保存。', confirmLabel: '放弃修改', tone: 'danger' })
  const accept = (doc: DataPackDocument) => { setDocument(doc); setText(doc.content); setTagDraft(null); setValidation(doc.validation); setMode(readDataPackForm(doc.kind, doc.content).form ? 'visual' : 'source'); setError(''); setNotice('') }
  const open = async (entry: DataPackEntry) => {
    if (!await canLeave()) return
    const token = ++opening.current
    await run('打开文件', async () => { const doc = await invoke<DataPackDocument>('query', { operation: 'read', root, path: entry.path }); if (alive.current && token === opening.current) accept(doc) })
  }
  const save = async (copy = false) => {
    if (!document) return
    let file = document.path
    if (copy) { const name = await prompt({ title: '另存数据文件', inputLabel: '相对数据路径', value: file.replace(/(\.[^.]+)$/, '_copy$1'), confirmLabel: '另存' }); if (!name) return; file = name }
    await run('保存文件', async () => {
      const saved = await invoke<DataPackDocument>('write', { operation: 'save', root, path: file, content: text, baseline: copy ? null : document.baseline })
      if (!alive.current) return
      accept(saved); setNotice('已保存'); setRevision(n => n + 1); drafts.delete(project.path); onFilesChanged()
    })
  }
  const create = async () => {
    if (!root || !await canLeave()) return
    const resource = await prompt({ title: `新建${DATA_PACK_KINDS.find(k => k.id === newKind)?.label}`, inputLabel: '资源 ID', value: `${project.namespace}:example`, confirmLabel: '创建' })
    if (!resource) return
    const separator = resource.indexOf(':'), namespace = separator >= 0 ? resource.slice(0, separator) : project.namespace, id = separator >= 0 ? resource.slice(separator + 1) : resource
    await run('创建文件', async () => { const doc = await invoke<DataPackDocument>('write', { operation: 'create', root, kind: newKind, namespace, id }); if (alive.current) { accept(doc); setRevision(n => n + 1); onFilesChanged() } })
  }
  const createPack = async () => {
    if (!await canLeave()) return
    const name = await prompt({ title: '新建数据包', inputLabel: '数据包名称', value: project.namespace || 'my_pack', confirmLabel: '创建数据包' })
    if (!name) return
    await run('创建数据包', async () => { const created = await invoke<DataPackInfo>('write', { operation: 'create-pack', name }); await refreshPacks(); if (alive.current) { setRoot(created.root); setDocument(null); setText(''); setOffset(0); onFilesChanged() } })
  }
  const changeRoot = async (value: string) => { if (await canLeave()) { opening.current++; setRoot(value); setDocument(null); setText(''); setValidation(null); setOffset(0); setQuery(''); setError('') } }
  const updateForm = (form: DataPackForm) => { try { setText(writeDataPackForm(project.minecraftVersion, text, form)); setValidation(null); setError('') } catch (e) { setError(String(e)) } }
  const pick = (value: string) => { if (!parsed.form) return; const form = { ...parsed.form, slots: [...parsed.form.slots] }; if (picker === 'result') { if (value.startsWith('#')) { setError('产物或掉落物必须是物品 ID，不能使用标签'); return }; form.result = value } else if (typeof picker === 'number') form.slots[picker] = value; updateForm(form) }
  const form = parsed.form
  return <div className="dp-workspace" aria-label="数据包" data-project={project.path}>
    <div className="dp-toolbar"><select aria-label="当前数据包" value={root} disabled={Boolean(busy)} onChange={event => void changeRoot(event.target.value)}>{!packs.length ? <option value="">暂无数据包</option> : packs.map(pack => <option key={pack.root} value={pack.root}>{pack.name}{pack.archived ? ' · ZIP' : ''}</option>)}</select>
      {project.kind === 'modpack' ? <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void createPack()}><Plus size={15} />新建数据包</button> : null}
      <div className="dp-toolbar-end"><button className="secondary-button" disabled={!root || Boolean(busy) || dirty} onClick={() => void run('校验数据包', async () => { const result = await invoke<DataPackValidation>('query', { operation: 'validate', root }); if (alive.current) { setValidation(result); setNotice(result.valid ? '静态校验通过' : '发现需要修复的问题') } })}><ShieldCheck size={15} />校验</button>
      <MoreActions label="数据包更多操作"><button disabled={!root || Boolean(busy) || archived} onClick={() => void (async () => { if (await canLeave()) setHistory(true) })()}>恢复历史</button><button disabled={Boolean(busy)} onClick={() => void run('刷新列表', async () => { await refreshPacks(); setRevision(n => n + 1) })}>刷新列表</button><button disabled={Boolean(busy)} onClick={() => setSources(true)}>资源来源</button>{project.kind === 'modpack' ? <button disabled={Boolean(busy)} onClick={() => void run('导入数据包', async () => { const imported = await invoke<DataPackInfo | null>('import'); if (imported) { await refreshPacks(); await changeRoot(imported.root); onFilesChanged() } })}>导入数据包 ZIP</button> : null}<button disabled={!root || dirty || Boolean(busy)} onClick={() => void run('导出数据包', async () => { const result = await invoke<{ path: string }>('write', { operation: 'export', root }); if (alive.current) setNotice(`已导出至 ${result.path}`) })}><Download size={15} />导出数据包</button><button disabled={!root || dirty || Boolean(busy)} onClick={onTest}>进入游戏测试</button></MoreActions></div>
    </div>
    {archived ? <div className="dp-archive-notice">此数据包来自 ZIP，可浏览源码。<button disabled={Boolean(busy)} className="secondary-button" onClick={() => void run('解包编辑', async () => { const imported = await invoke<DataPackInfo>('import', { root }); await refreshPacks(); await changeRoot(imported.root) })}>解包编辑</button></div> : null}
    <div className="dp-body"><aside className="dp-files"><div className="dp-file-search"><Search size={15} /><input aria-label="搜索数据文件" placeholder="搜索数据文件" value={query} onChange={e => { setQuery(e.target.value); setOffset(0) }} /></div><div className="dp-create-row"><select aria-label="新建内容类型" value={newKind} onChange={e => setNewKind(e.target.value as DataPackKind)}>{DATA_PACK_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select><button className="icon-button" title="新建数据文件" aria-label="新建数据文件" disabled={!root || Boolean(busy) || archived} onClick={() => void create()}><Plus size={16} /></button></div>
      <div className="dp-file-list" aria-busy={loading}>{loading ? <div className="dp-loading"><LoaderCircle className="spin" size={16} />读取文件…</div> : entries.length ? entries.map(entry => <button key={entry.path} className={entry.path === document?.path ? 'selected' : ''} disabled={Boolean(busy)} title={entry.path} onClick={() => void open(entry)}><FileJson size={15} /><span>{entry.path.replace(/^data\//, '')}</span></button>) : <div className="dp-empty-list">{query ? '没有匹配的数据文件' : '暂无数据文件'}</div>}</div>
      <div className="dp-pagination"><span>{total} 个文件</span><button className="icon-button" title="上一页" disabled={!offset || loading} onClick={() => setOffset(n => Math.max(0, n - 200))}>‹</button><button className="icon-button" title="下一页" disabled={offset + 200 >= total || loading} onClick={() => setOffset(n => n + 200)}>›</button></div></aside>
    <main className="dp-editor">{document ? <><div className="dp-document-toolbar"><div className="dp-document-name" title={document.path}>{document.path.split('/').pop()}{dirty ? <span className="dp-dirty">未保存</span> : null}</div><div className="dp-mode-switch" aria-label="编辑方式">{(['visual', 'source', 'changes'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setTagDraft(null) }}>{value === 'visual' ? <Grid3X3 size={14} /> : value === 'source' ? <Code2 size={14} /> : null}{value === 'visual' ? '图形' : value === 'source' ? '源码' : '改动'}</button>)}</div><button className="primary-button" disabled={!dirty || Boolean(busy) || archived} onClick={() => void save()}><Save size={15} />保存</button><MoreActions label="文件更多操作"><button disabled={!dirty || Boolean(busy)} onClick={() => void save(true)}>另存为</button><button disabled={Boolean(busy) || archived} onClick={() => void (async () => { if (await confirm({ title: '删除数据文件', message: `删除 ${document.path}？删除前会保存恢复副本。`, confirmLabel: '删除文件', tone: 'danger' })) await run('删除文件', async () => { const result = await invoke<{ recoveryPath: string }>('write', { operation: 'remove', root, path: document.path, baseline: document.baseline }); if (alive.current) { setDocument(null); setText(''); setValidation(null); setNotice(`已删除，恢复副本：${result.recoveryPath}`); setRevision(n => n + 1); onFilesChanged() } }) })()}><Trash2 size={15} />删除文件</button></MoreActions></div>
      <div className="dp-edit-area">{mode === 'source' ? <textarea className="dp-source" aria-label="数据文件源码" spellCheck={false} readOnly={archived || Boolean(busy)} value={text} onChange={e => { setText(e.target.value); setValidation(null) }} /> : mode === 'changes' ? <div className="dp-diff"><section><h3>已保存</h3><pre>{document.content}</pre></section><section><h3>当前草稿</h3><pre>{text}</pre></section></div> : form ? <fieldset disabled={Boolean(busy) || archived} className="dp-visual">
        {form.kind.startsWith('recipe') ? <div className="dp-recipe"><div className="dp-grid" aria-label="配方材料网格">{form.slots.map((id, i) => <button type="button" key={i} aria-label={`材料 ${i + 1}${id ? '：' + id : ''}`} title={id || '选择材料'} onClick={() => setPicker(i)}>{icons[id] ? <img src={icons[id]} alt="" /> : <span>{id ? id.replace(/^(?:minecraft:)/, '').replace(/^#/, '# ').replaceAll('_', ' ') : '+'}</span>}</button>)}</div><ArrowRight size={24} className="dp-recipe-arrow" /><button type="button" className="dp-result" aria-label="选择配方产物" title={form.result} onClick={() => setPicker('result')}>{icons[form.result] ? <img src={icons[form.result]} alt="" /> : <span>{form.result.replace(/^minecraft:/, '').replaceAll('_', ' ')}</span>}</button><label>产物数量<input aria-label="产物数量" type="number" min={1} max={99} value={form.count} onChange={e => updateForm({ ...form, count: Number(e.target.value) || 1 })} /></label></div> : null}
        {form.kind.endsWith('-tag') ? <><label>标签内容<textarea aria-label="标签内容" rows={12} value={tagDraft ?? form.values} placeholder="每行一个物品、方块或 #标签 ID" onChange={e => { setTagDraft(e.target.value); updateForm({ ...form, values: e.target.value }) }} /></label><label className="dp-checkbox"><input type="checkbox" checked={form.replace} onChange={e => updateForm({ ...form, replace: e.target.checked })} />替换此前加载的同名标签内容</label></> : null}
        {form.kind === 'loot-block' ? <div className="dp-loot"><label>掉落物<button type="button" className="secondary-button" aria-label="选择掉落物" onClick={() => setPicker('result')}>{form.result}</button></label><label>抽取次数<input aria-label="抽取次数" type="number" min={0} value={form.rolls} onChange={e => updateForm({ ...form, rolls: Number(e.target.value) })} /></label></div> : null}
      </fieldset> : <div className="dp-unsupported"><Code2 size={24} /><p>{parsed.reason}</p><button className="secondary-button" onClick={() => setMode('source')}>编辑源码</button></div>}</div>
      </> : <div className="dp-empty"><FileJson size={32} /><p>{packs.length ? '选择一个数据文件，或新建内容' : '创建或导入数据包开始编辑'}</p>{!packs.length && project.kind === 'modpack' ? <button className="primary-button" disabled={Boolean(busy)} onClick={() => void createPack()}><Plus size={15} />新建数据包</button> : <button className="secondary-button" disabled={!root || Boolean(busy) || archived} onClick={() => void create()}><Plus size={15} />新建数据文件</button>}</div>}
    </main></div>
    <div className="dp-status" role="status">{busy ? <><LoaderCircle size={14} className="spin" />{busy}…</> : notice ? <><Check size={14} />{notice}</> : document ? document.path : `${project.minecraftVersion}`}</div>
    {error ? <div className="dp-error" role="alert"><span>{error}</span>{dirty ? <button className="secondary-button" onClick={() => void save(true)}>另存为</button> : <button className="secondary-button" onClick={() => void run('刷新数据包', async () => { await refreshPacks(); setRevision(n => n + 1) })}>重试</button>}</div> : null}
    {validation && (validation.errors.length || validation.warnings.length) ? <details className="dp-validation" open={validation.errors.length > 0}><summary>{validation.errors.length ? `${validation.errors.length} 个错误` : '校验范围与提示'}{validation.warnings.length ? ` · ${validation.warnings.length} 项提示` : ''}</summary>{validation.errors.map((e, i) => <p className="dp-error" key={i}>{e}</p>)}{validation.warnings.map((e, i) => <p key={i}>{e}</p>)}</details> : null}
    {picker !== null && form ? <ItemPicker key={`${document?.path}:${picker}`} projectPath={project.path} value={picker === 'result' ? form.result : form.slots[picker]} onSelect={pick} onClose={() => setPicker(null)} /> : null}
    {sources ? <GameResourceSources featureId="data-packs" actionPrefix="source:" projectPath={project.path} onChanged={() => setRevision(n => n + 1)} onClose={() => setSources(false)} /> : null}
    {history ? <DataPackHistory projectPath={project.path} root={root} onRestored={doc => { accept(doc); setHistory(false); setRevision(n => n + 1); setNotice('已恢复所选版本'); onFilesChanged() }} onClose={() => setHistory(false)} /> : null}
    {confirmDialog}{promptDialog}
  </div>
}
