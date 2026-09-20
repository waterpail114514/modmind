import { useEffect, useRef, useState } from 'react'
import type { InspirationNote } from '../../../shared/inspirationKnowledge'

export default function InspirationKnowledgeDialog({ projectPath, notes, initialContent, onChange, onClose }: {
  projectPath: string; notes: InspirationNote[]; initialContent?: string
  onChange: (notes: InspirationNote[]) => void; onClose: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [id, setId] = useState<string>()
  const [title, setTitle] = useState(initialContent ? '收藏方案' : '')
  const [content, setContent] = useState(initialContent ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  const save = async (remove = false): Promise<void> => {
    setBusy(true); setError('')
    try {
      const next = await window.modmind.inspiration.updateKnowledge(projectPath, { id, title, content, remove })
      onChange(next)
      if (remove) { setId(undefined); setTitle(''); setContent('') }
      else setId(next[0]?.id)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="inspiration-knowledge-dialog" aria-label="项目知识与收藏" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><strong>项目知识与收藏</strong><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <p>保存已确定的设定、技术选择和待办。勾选「引用项目知识」后，才会附入后续提问。</p>
    <select aria-label="选择知识条目" disabled={busy} value={id ?? ''} onChange={event => {
      const note = notes.find(item => item.id === event.target.value)
      setId(note?.id); setTitle(note?.title ?? ''); setContent(note?.content ?? ''); setError('')
    }}><option value="">新建条目</option>{notes.map(note => <option value={note.id} key={note.id}>{note.title}</option>)}</select>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label>标题<input aria-label="标题" value={title} maxLength={120} required disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label>内容<textarea aria-label="内容" value={content} maxLength={20000} required disabled={busy} onChange={event => setContent(event.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <footer>{id ? <button type="button" disabled={busy} onClick={() => void save(true)}>删除条目</button> : null}<button type="submit" disabled={busy || !title.trim() || !content.trim()}>{busy ? '保存中…' : '保存'}</button></footer>
    </form>
  </dialog>
}
