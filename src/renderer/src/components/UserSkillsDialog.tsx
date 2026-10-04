import { useEffect, useRef, useState } from 'react'
import { FileCode2, FolderInput, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import type { UserSkill, UserSkillDocument } from '../../../shared/userSkills'
import MoreActions from './MoreActions'
import './user-skills.css'

const template = '---\nname: my-skill\ndescription: \n---\n\n'
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export default function UserSkillsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [skills, setSkills] = useState<UserSkill[]>([])
  const [document, setDocument] = useState<UserSkillDocument | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [confirmation, setConfirmation] = useState<{ text: string; label: string; action: () => void } | null>(null)
  const dirty = editing && content !== (document?.content ?? template)

  useEffect(() => {
    const surface = dialog.current
    surface?.showModal()
    let active = true
    void window.modmind.skills.list().then(items => { if (active) { setSkills(items); setReady(true) } })
      .catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false; surface?.close() }
  }, [])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setStatus(''); setConfirmation(null)
    try { await action() } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  const refresh = async (): Promise<void> => { setSkills(await window.modmind.skills.list()); setReady(true) }
  const show = (item: UserSkillDocument): void => {
    setDocument(item); setContent(item.content); setEditing(true)
  }
  const leave = (action: () => void): void => {
    if (busy) return
    if (dirty) setConfirmation({ text: '有未保存的修改，放弃这些修改？', label: '放弃修改', action })
    else { setConfirmation(null); action() }
  }
  const create = (): void => leave(() => {
    setDocument(null); setContent(template); setEditing(true); setError(''); setStatus('')
  })
  const select = (name: string): void => leave(() => void run(async () => show(await window.modmind.skills.read(name))))
  const importSkill = (kind: 'folder' | 'file'): void => leave(() => void run(async () => {
    const item = await window.modmind.skills.import(kind)
    if (!item) return
    show(item); await refresh(); setStatus('已导入，下次发送生效')
  }))
  const save = (): void => void run(async () => {
    const item = await window.modmind.skills.save({ name: document?.name, revision: document?.revision, content })
    show(item); await refresh(); setStatus(item.enabled ? '已保存，下次发送生效' : '已保存，当前已停用')
  })
  const toggleEnabled = (enabled: boolean): void => {
    if (!document) return
    const item = document
    setDocument(current => current ? { ...current, enabled } : current)
    void run(async () => {
      try {
        await window.modmind.skills.setEnabled(item.name, enabled)
        await refresh()
        setStatus(enabled ? '已启用，下次发送生效' : '已停用，下次发送生效')
      } catch (reason) {
        const saved = await window.modmind.skills.read(item.name).catch(() => item)
        setDocument(current => current ? { ...current, enabled: saved.enabled } : current)
        throw reason
      }
    })
  }
  const remove = (): void => {
    if (!document) return
    const item = document
    setConfirmation({ text: `移除「${item.name}」及其配套资源？原始导入目录不会受影响。`, label: '移除 Skill', action: () => void run(async () => {
      await window.modmind.skills.remove(item.name, item.revision)
      setDocument(null); setContent(''); setEditing(false); await refresh(); setStatus('已移除，下次发送生效')
    }) })
  }
  const filtered = skills.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
  return <dialog ref={dialog} className="user-skills-dialog" aria-label="用户 Skills" onCancel={event => { event.preventDefault(); leave(onClose) }}>
    <header className="user-skills-header"><div><strong>Skills</strong><span>所有项目 · 下次发送生效</span></div><button type="button" className="agent-icon-button" aria-label="关闭 Skills" title="关闭" disabled={busy} onClick={() => leave(onClose)}><X size={18} /></button></header>
    <div className="user-skills-toolbar">
      <label className="user-skills-search"><Search size={15} /><input aria-label="搜索 Skills" placeholder="搜索 Skills" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="agent-icon-button" title="刷新 Skills" aria-label="刷新 Skills" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16} /></button>
      <MoreActions label="导入 Skill" text="导入" icon={<FolderInput size={15} />}><button type="button" disabled={busy} onClick={() => importSkill('folder')}><FolderInput size={15} />导入目录</button><button type="button" disabled={busy} onClick={() => importSkill('file')}><FileCode2 size={15} />导入 SKILL.md</button></MoreActions>
      <button type="button" className="agent-secondary-button" disabled={busy} onClick={create}><Plus size={15} />新建</button>
    </div>
    <div className="user-skills-body">
      <nav className="user-skills-list" aria-label="用户 Skill 列表" aria-busy={!ready}>
        {!ready ? <p>{error ? '无法读取 Skills' : '正在读取…'}</p> : !filtered.length ? <p>{query ? '没有匹配的 Skill' : '尚未添加 Skill'}</p> : filtered.map(item => <button type="button" className={document?.name === item.name ? 'selected' : ''} aria-current={document?.name === item.name ? 'true' : undefined} disabled={busy} key={item.name} onClick={() => select(item.name)}><span className="user-skill-name">{item.name}<small>{item.enabled ? '启用' : '停用'}</small></span><span className="user-skill-description">{item.description}</span></button>)}
      </nav>
      <section className="user-skills-editor" aria-label="Skill 编辑器">
        {editing ? <>
          <div className="user-skill-editor-heading"><strong>{document?.name ?? '新建 Skill'}</strong>{dirty ? <span>未保存</span> : null}{document ? <label><input type="checkbox" checked={document.enabled} disabled={busy} onChange={event => toggleEnabled(event.target.checked)} />启用</label> : null}</div>
          <label className="user-skill-content">SKILL.md<textarea aria-label="SKILL.md 内容" spellCheck={false} disabled={busy} value={content} onChange={event => { setContent(event.target.value); setStatus('') }} /></label>
          <footer className="user-skill-editor-actions">{document ? <button type="button" className="agent-icon-button user-skill-remove" title="移除 Skill" aria-label="移除 Skill" disabled={busy} onClick={remove}><Trash2 size={16} /></button> : null}<button type="button" className="agent-primary-button" disabled={busy || !content.trim() || Boolean(document && !dirty)} onClick={save}><Save size={15} />{busy ? '处理中…' : '保存 Skill'}</button></footer>
        </> : <div className="user-skills-empty"><FileCode2 size={24} /><span>选择 Skill，或添加自己的 Skill</span><button type="button" className="agent-text-button" disabled={busy} onClick={create}><Plus size={15} />新建 Skill</button></div>}
      </section>
    </div>
    <div className="user-skills-feedback" aria-live="polite">{error ? <span role="alert">{error}</span> : <span>{status}</span>}{error ? <button type="button" className="agent-text-button" disabled={busy} onClick={() => void run(refresh)}>重新读取</button> : null}</div>
    {confirmation ? <div className="user-skills-confirm" role="alert"><span>{confirmation.text}</span><div><button type="button" className="agent-secondary-button" onClick={() => setConfirmation(null)}>取消</button><button type="button" className="agent-secondary-button user-skill-remove" onClick={() => { const action = confirmation.action; setConfirmation(null); action() }}>{confirmation.label}</button></div></div> : null}
  </dialog>
}
