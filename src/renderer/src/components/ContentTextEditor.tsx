import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import { LoaderCircle, RotateCcw, Save } from 'lucide-react'
import MonacoCodeEditor from './MonacoCodeEditor'
import { useConfirmDialog } from './InteractionDialogs'
import { editorLanguage } from '../lib/editorLanguage'
import { contentDraftKey, getContentDraft, saveContentDraft, setContentDraft, subscribeContentDrafts } from '../lib/contentDrafts'

export type ContentEditorHandle = { save: () => Promise<boolean> }

export default function ContentTextEditor({ projectPath, path, text, darkMode, editorRef }: {
  projectPath: string; path: string; text: string; darkMode: boolean; editorRef: MutableRefObject<ContentEditorHandle | null>
}): React.JSX.Element {
  const key = contentDraftKey(projectPath, path)
  const draft = useSyncExternalStore(subscribeContentDrafts, () => getContentDraft(key))
  const [saved, setSaved] = useState(text)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  const { confirm, dialog } = useConfirmDialog()
  useEffect(() => { setSaved(text) }, [text])
  useEffect(() => {
    if (draft) return
    let current = true
    void window.modmind.project.readFile(path, projectPath).then(value => { if (current) setSaved(value) }).catch(() => undefined)
    return () => { current = false }
  }, [draft, path, projectPath])
  const save = async (): Promise<boolean> => {
    if (savingRef.current) return false
    if (!getContentDraft(key)) return true
    savingRef.current = true; setSaving(true); setError('')
    try {
      const written = await saveContentDraft(key, () => window.modmind.project.readFile(path, projectPath), value => window.modmind.project.writeFile(path, value, projectPath))
      if (written !== undefined) setSaved(written)
      return !getContentDraft(key)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return false }
    finally { savingRef.current = false; setSaving(false) }
  }
  useEffect(() => {
    const handle = { save }
    editorRef.current = handle
    return () => { if (editorRef.current === handle) editorRef.current = null }
  })
  const reload = async (): Promise<void> => {
    if (savingRef.current) return
    if (draft && !await confirm({ title: '重新载入文件？', message: '将丢弃当前文件的未保存草稿，读取磁盘上的最新内容。', confirmLabel: '重新载入', cancelLabel: '保留草稿', tone: 'danger' })) return
    try {
      const latest = await window.modmind.project.readFile(path, projectPath)
      setSaved(latest); setContentDraft(key, undefined); setError('')
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  return <>
    <div className="pack-content-edit-actions"><span role="status">{saving ? '正在保存…' : draft ? '未保存 · 切换页面保留草稿' : '已保存'}</span><div className="resource-pack-actions"><button className="icon-button" title="重新载入文件" disabled={saving} onClick={() => void reload()}><RotateCcw size={15} /></button><button className="primary-button" disabled={saving || !draft} title="保存文件 (Ctrl+S / ⌘S)" onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存文件</button></div></div>
    {error ? <div className="resource-pack-notice" role="alert">{error}</div> : null}
    <div className="pack-content-text-preview"><MonacoCodeEditor path={`modpack-content://${encodeURIComponent(projectPath)}/${encodeURIComponent(path)}`} language={editorLanguage(path)} value={draft?.text ?? saved} darkMode={darkMode} readOnly={saving} onChange={value => setContentDraft(key, { base: draft?.base ?? saved, text: value })} onSave={() => void save()} /></div>
    {dialog}
  </>
}
