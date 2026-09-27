import { useEffect, useState } from 'react'
import type { InspirationNote } from '../../../shared/inspirationKnowledge'
import InspirationKnowledgeDialog from './InspirationKnowledgeDialog'

export default function ProjectKnowledgeButton({ projectPath, disabled }: {
  projectPath: string
  disabled: boolean
}): React.JSX.Element {
  const [notes, setNotes] = useState<InspirationNote[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    let receivedChange = false
    setNotes([]); setReady(false); setError(''); setOpen(false)
    const api = window.modmind.inspiration
    if (!api) { setError('项目知识服务不可用'); return }
    const unsubscribe = api.onKnowledgeChanged?.(change => {
      if (!active || change.projectPath !== projectPath) return
      receivedChange = true
      setNotes(change.notes); setReady(true); setError('')
    })
    void api.readKnowledge(projectPath).then(items => {
      if (active && !receivedChange) { setNotes(items); setReady(true) }
    }).catch(reason => {
      if (active && !receivedChange) setError(`项目知识读取失败：${reason instanceof Error ? reason.message : String(reason)}`)
    })
    return () => { active = false; unsubscribe?.() }
  }, [projectPath, attempt])

  return <>
    <button
      className="inspiration-knowledge-button"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={error ? `${error}，点击重试` : ready ? '查看与编辑项目知识' : '正在读取项目知识…'}
      disabled={disabled || (!ready && !error)}
      onClick={() => error ? setAttempt(value => value + 1) : setOpen(true)}
    >项目知识{error ? ' · 重试' : notes.length ? ` · ${notes.length}` : ''}</button>
    {open ? <InspirationKnowledgeDialog projectPath={projectPath} notes={notes} onChange={setNotes} onClose={() => setOpen(false)} /> : null}
  </>
}
