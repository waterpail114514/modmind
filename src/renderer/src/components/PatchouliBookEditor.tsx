import { reportClientFailure } from '../lib/clientFailure'
import { useMemo, useState } from 'react'
import { BookOpen, FilePlus2, FolderPlus, LibraryBig, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react'
import { useConfirmDialog } from './InteractionDialogs'

type PatchouliEntry = { id: string; name: string; icon: string; text: string }
type PatchouliCategory = { id: string; name: string; description: string; icon: string; entries: PatchouliEntry[] }

function nextId(prefix: string): string { return `${prefix}_${crypto.randomUUID().slice(0, 8)}` }

export default function PatchouliBookEditor(): React.JSX.Element {
  const { confirm, dialog } = useConfirmDialog()
  const [bookId, setBookId] = useState('guide')
  const [name, setName] = useState('整合包指南')
  const [landingText, setLandingText] = useState('从这里开始你的旅程')
  const [categories, setCategories] = useState<PatchouliCategory[]>([{ id: 'getting_started', name: '入门', description: '', icon: 'minecraft:book', entries: [{ id: 'welcome', name: '欢迎', icon: 'minecraft:book', text: '查看任务书，完成第一项任务' }] }])
  const [selectedCategoryId, setSelectedCategoryId] = useState('getting_started')
  const [selectedEntryId, setSelectedEntryId] = useState('welcome')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const category = categories.find((item) => item.id === selectedCategoryId) ?? categories[0]
  const entry = category?.entries.find((item) => item.id === selectedEntryId) ?? category?.entries[0]
  const entryCount = useMemo(() => categories.reduce((count, item) => count + item.entries.length, 0), [categories])
  const updateCategory = (id: string, patch: Partial<PatchouliCategory>): void => setCategories((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  const updateEntry = (categoryId: string, entryId: string, patch: Partial<PatchouliEntry>): void => setCategories((current) => current.map((item) => item.id !== categoryId ? item : { ...item, entries: item.entries.map((child) => child.id === entryId ? { ...child, ...patch } : child) }))
  const chooseCategory = (id: string): void => { const next = categories.find((item) => item.id === id); setSelectedCategoryId(id); setSelectedEntryId(next?.entries[0]?.id ?? '') }
  const addCategory = (): void => {
    const id = nextId('category'); const next: PatchouliCategory = { id, name: '新分类', description: '', icon: 'minecraft:book', entries: [] }
    setCategories((current) => [...current, next]); setSelectedCategoryId(id); setSelectedEntryId('')
  }
  const removeCategory = async (): Promise<void> => {
    if (!category || categories.length <= 1 || !await confirm({ title: `删除分类“${category.name}”？`, message: `其中的 ${category.entries.length} 个条目也会一并删除。`, confirmLabel: '删除分类', cancelLabel: '保留分类', tone: 'danger', actionIcon: 'delete' })) return
    const next = categories.filter((item) => item.id !== category.id)
    setCategories(next); setSelectedCategoryId(next[0].id); setSelectedEntryId(next[0].entries[0]?.id ?? '')
  }
  const addEntry = (): void => {
    if (!category) return
    const next: PatchouliEntry = { id: nextId('entry'), name: '新条目', icon: 'minecraft:book', text: '' }
    updateCategory(category.id, { entries: [...category.entries, next] }); setSelectedEntryId(next.id)
  }
  const removeEntry = async (): Promise<void> => {
    if (!category || !entry || !await confirm({ title: `删除条目“${entry.name}”？`, message: '该条目的正文和图标设置也会一并删除。', confirmLabel: '删除条目', cancelLabel: '保留条目', tone: 'danger', actionIcon: 'delete' })) return
    const entries = category.entries.filter((item) => item.id !== entry.id)
    updateCategory(category.id, { entries }); setSelectedEntryId(entries[0]?.id ?? '')
  }
  const save = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      const files = await window.modmind.modpack.writePatchouliBook({ bookId, name, landingText, categories })
      setMessage(`已写入 ${files.length} 个指南文件`)
    } catch (error) { setMessage(reportClientFailure(error)) }
    finally { setBusy(false) }
  }

  return <div className="patchouli-book-editor">
    <header className="content-toolbar patchouli-toolbar"><h1 className="visually-hidden">Patchouli 指南书</h1><div className="patchouli-toolbar-actions"><span>{categories.length} 个分类 · {entryCount} 个条目</span><button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}写入指南书</button></div></header>
    <div className="patchouli-book-meta"><label>书籍标识<input value={bookId} onChange={(event) => setBookId(event.target.value)} /></label><label>书籍名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>首页文本<textarea value={landingText} onChange={(event) => setLandingText(event.target.value)} /></label></div>
    <div className="patchouli-book-layout">
      <aside className="patchouli-categories"><div className="patchouli-panel-title"><span><LibraryBig size={16} />分类</span><button className="icon-button" title="新增分类" onClick={addCategory}><FolderPlus size={15} /></button></div><div className="patchouli-category-list">{categories.map((item) => <button className={item.id === category?.id ? 'selected' : ''} key={item.id} onClick={() => chooseCategory(item.id)}><BookOpen size={15} /><span><strong>{item.name}</strong><small>{item.entries.length} 个条目</small></span></button>)}</div><button className="secondary-button compact patchouli-add-category" onClick={addCategory}><Plus size={14} />新增分类</button></aside>
      <section className="patchouli-entry-list-panel"><div className="patchouli-panel-title"><span>{category?.name || '分类条目'}</span><div><button className="icon-button" title="新增条目" disabled={!category} onClick={addEntry}><FilePlus2 size={15} /></button><button className="icon-button" title="删除分类" disabled={!category || categories.length <= 1} onClick={removeCategory}><Trash2 size={15} /></button></div></div>{category ? <><div className="patchouli-category-fields"><label className="field-label">分类名称<input value={category.name} onChange={(event) => updateCategory(category.id, { name: event.target.value })} /></label><label className="field-label">分类图标<input value={category.icon} onChange={(event) => updateCategory(category.id, { icon: event.target.value })} /></label><label className="field-label">分类说明<textarea value={category.description} onChange={(event) => updateCategory(category.id, { description: event.target.value })} /></label></div><div className="patchouli-entries">{category.entries.map((item) => <button key={item.id} className={item.id === entry?.id ? 'selected' : ''} onClick={() => setSelectedEntryId(item.id)}><FilePlus2 size={14} /><span><strong>{item.name}</strong><small>{item.text || '未填写正文'}</small></span></button>)}{!category.entries.length ? <div className="patchouli-empty">此分类还没有条目</div> : null}</div></> : null}</section>
      <aside className="patchouli-entry-inspector">{entry && category ? <><div className="patchouli-panel-title"><span><BookOpen size={16} />条目编辑</span><button className="icon-button" title="删除条目" onClick={removeEntry}><Trash2 size={15} /></button></div><label className="field-label">条目名称<input value={entry.name} onChange={(event) => updateEntry(category.id, entry.id, { name: event.target.value })} /></label><label className="field-label">条目图标<input value={entry.icon} onChange={(event) => updateEntry(category.id, entry.id, { icon: event.target.value })} /></label><label className="field-label patchouli-entry-text">正文<textarea value={entry.text} placeholder="输入指南正文" onChange={(event) => updateEntry(category.id, entry.id, { text: event.target.value })} /></label></> : <div className="patchouli-inspector-empty"><BookOpen size={22} /><p>选择条目，或创建一个新条目</p></div>}</aside>
    </div>
    {message ? <div className="patchouli-message">{message}</div> : null}
    {dialog}
  </div>
}
