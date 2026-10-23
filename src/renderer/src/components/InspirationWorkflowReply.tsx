import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Copy, Pencil, RotateCcw, X } from 'lucide-react'
import type { InspirationChatMessage } from '../../../shared/types'
import type { InspirationFeatures } from '../../../shared/inspirationFeatures'
import type { InspirationWorkflowRecord } from '../../../shared/inspirationKnowledge'
import { inspirationPromptHandoff, parseInspirationWorkflow } from '../../../shared/inspirationWorkflow'
import { ReplyMarkdown } from './ReplyImages'
import './inspiration-workflow.css'
import { splitInspirationFollowups } from '../inspirationFollowups'

export default function InspirationWorkflowReply({ message, features, projectPath, conversationId, generation, latest, busy,
  attachmentPaths, onSend, onHandoff, onEdit, onSource, onCollect }: {
  message: InspirationChatMessage; features: InspirationFeatures; projectPath: string; conversationId: string; generation: number
  latest: boolean; busy: boolean; attachmentPaths: string[]
  onSend: (text: string) => void; onHandoff: (text: string) => void; onEdit: (text: string | undefined) => void; onSource: (href: string) => void
  onCollect: (text: string) => void
}): React.JSX.Element {
  const [displayText, setDisplayText] = useState(message.content)
  useEffect(() => {
    if (message.status !== 'streaming') { setDisplayText(message.content); return }
    const frame = requestAnimationFrame(() => setDisplayText(message.content))
    return () => cancelAnimationFrame(frame)
  }, [message.content, message.status])
  const selection = message.inspirationFeatures ?? features
  const preview = useMemo(() => parseInspirationWorkflow(displayText, selection), [displayText, selection])
  const complete = preview.complete && message.isFinal && message.status === 'completed'
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState(message.promptEdit ?? '')
  const [error, setError] = useState('')
  const [record, setRecord] = useState<InspirationWorkflowRecord | null>(null)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [knowledgeBusy, setKnowledgeBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const identity = useMemo(() => ({ conversationId, turnId: message.turnId ?? '', generation: message.generation ?? generation }), [conversationId, message.turnId, message.generation, generation])
  const loadToken = useRef(0)
  useEffect(() => {
    const token = ++loadToken.current
    if (!complete || !identity.turnId || !window.modmind.inspiration.readWorkflow) return
    void window.modmind.inspiration.readWorkflow(projectPath, identity).then(value => {
      if (loadToken.current === token) {
        setRecord(value)
        if (!value && preview.candidates.length) setError('知识预览记录不可用，请重新整理；提示词仍可使用')
      }
    }).catch(e => { if (loadToken.current === token) setError(e instanceof Error ? e.message : String(e)) })
    return () => { loadToken.current++ }
  }, [complete, identity, projectPath])
  const promptText = message.promptEdit ?? preview.promptText
  const reason = !latest ? '此前版本，请先根据最新需求重新整理' : !complete
    ? preview.error ?? (message.status === 'streaming' ? '提示词仍在生成' : '回答未完整生成，请重试')
    : preview.value?.prompt?.state !== 'ready' ? '请先补齐关键要求' : ''
  const saveKnowledge = async (edits: Array<{ index: number; title: string; content: string }>, undo = false): Promise<void> => {
    setKnowledgeBusy(true); setError('')
    try { setRecord(await window.modmind.inspiration.commitWorkflow(projectPath, identity, edits, undo)) }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // A partial failure may have durably recorded the selected edits, but not saved the notes.
      const refreshed = await window.modmind.inspiration.readWorkflow(projectPath, identity).catch(() => null)
      if (refreshed) setRecord(refreshed)
    } finally { setKnowledgeBusy(false) }
  }
  if (!preview.protocol) return <><ReplyMarkdown content={splitInspirationFollowups(displayText).content} onSource={onSource} />{message.inspirationFeatures && message.status === 'completed' ? <p className="inspiration-workflow-error" role="alert">回答格式不完整。<button type="button" disabled={busy || !latest} onClick={() => onSend('保留已确定的需求，按灵感台 JSON 协议重新整理上一轮结果，不增加功能。')}>重新整理</button></p> : null}{message.isFinal && message.status === 'completed' && !busy ? <button className="message-action" type="button" onClick={() => onCollect(splitInspirationFollowups(displayText).content)}>收藏方案</button> : null}</>
  return <>
    {preview.reply ? <ReplyMarkdown content={preview.reply} onSource={onSource} /> : null}
    {preview.promptText || message.promptEdit !== undefined ? <section className="inspiration-prompt-artifact" aria-label="提示词">
      <header><strong>提示词</strong></header>
      {editing ? <textarea aria-label="编辑提示词" maxLength={20000} value={edited} onChange={event => setEdited(event.target.value)} />
        : <div className="inspiration-prompt-body"><ReplyMarkdown content={promptText} onSource={onSource} /></div>}
      <footer><div className="inspiration-prompt-tools">
        <button type="button" title="复制提示词" onClick={() => void navigator.clipboard.writeText(editing ? edited : promptText).catch(() => setError('复制失败，请选择正文复制'))}><Copy size={14} />复制</button>
        {complete && !busy ? editing ? <><button type="button" disabled={!edited.trim()} onClick={() => { onEdit(edited); setEditing(false) }}>保存编辑</button><button type="button" onClick={() => setEditing(false)}>取消</button></>
          : <button type="button" onClick={() => { setEdited(promptText); setEditing(true) }}><Pencil size={14} />编辑</button> : null}
        {message.promptEdit !== undefined && !editing ? <button type="button" title="恢复 AI 版本" onClick={() => onEdit(undefined)}><RotateCcw size={14} /></button> : null}
      </div><button type="button" className="primary-button" title={reason || '将提示词填入工作台'} disabled={Boolean(reason) || busy || editing || !promptText.trim()} onClick={() => onHandoff(inspirationPromptHandoff(promptText, attachmentPaths))}>交给工作台</button></footer>
      {reason && message.status !== 'streaming' ? <p className="inspiration-workflow-error" role="status">{reason}</p> : null}
    </section> : null}
    {complete && latest && !busy && preview.value?.questions.length ? <form className="inspiration-workflow-questions" onSubmit={event => {
      event.preventDefault()
      const lines = preview.value!.questions.filter(q => answers[q.id]?.trim()).map(q => `${q.text}\n我的选择：${answers[q.id]}`)
      if (lines.length) onSend(lines.join('\n\n'))
    }}>{preview.value.questions.map(q => <fieldset key={q.id}><legend>{q.text}</legend><div className="inspiration-question-options">{q.options.map(option => <button type="button" key={option.id} title={option.reason} aria-pressed={answers[q.id] === option.label} onClick={() => setAnswers(current => ({ ...current, [q.id]: option.label }))}>{option.label}</button>)}</div><input aria-label={q.text} placeholder="输入你的选择" value={answers[q.id] ?? ''} maxLength={2000} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))} /></fieldset>)}
      <button className="secondary-button" type="submit" disabled={preview.value.questions.some(q => q.blocking && !answers[q.id]?.trim()) || !Object.values(answers).some(v => v.trim())}>继续整理</button>
    </form> : null}
    {complete && latest && !busy && preview.value?.suggestions.length ? <div className="inspiration-workflow-suggestions">{preview.value.suggestions.map(s => <div key={s.id}><span title={s.reason}>{s.text}</span><button type="button" className="secondary-button" onClick={() => onSend(`采用建议：${s.text}`)}>采用</button></div>)}</div> : null}
    {preview.candidates.length || record?.changes.length || record?.error ? <div className="inspiration-workflow-knowledge-action">
      <button type="button" onClick={() => setKnowledgeOpen(true)}><BookOpen size={15} />知识更新</button>
      {record?.status === 'saved' ? <><span>已保存</span><button type="button" disabled={knowledgeBusy} onClick={() => void saveKnowledge([], true)}>撤销</button></> : record?.status === 'undone' ? <span>已撤销</span> : null}
    </div> : null}
    {preview.error || error ? <p className="inspiration-workflow-error" role="alert">{error || preview.error}{preview.error && latest ? <button type="button" disabled={busy} onClick={() => onSend('保留已确定的需求，按灵感台 JSON 协议重新整理上一轮结果，不增加功能。')}>重新整理</button> : null}</p> : null}
    {knowledgeOpen ? <KnowledgePreview preview={preview.candidates} record={record} complete={Boolean(complete)} busy={knowledgeBusy} error={error}
      onClose={() => setKnowledgeOpen(false)} onSave={edits => void saveKnowledge(edits)} onUndo={() => void saveKnowledge([], true)} /> : null}
  </>
}

function KnowledgePreview({ preview, record, complete, busy, error, onClose, onSave, onUndo }: {
  preview: Array<{ title?: string; content?: string }>; record: InspirationWorkflowRecord | null; complete: boolean; busy: boolean; error: string
  onClose: () => void; onSave: (edits: Array<{ index: number; title: string; content: string }>) => void; onUndo: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [edits, setEdits] = useState<Record<number, { title: string; content: string }>>({})
  const [editing, setEditing] = useState(false)
  const items = record?.changes.length ? record.changes : preview
  const saved = record?.status === 'saved' || record?.status === 'undone'
  useEffect(() => { setEdits({}); setSelected({}); setEditing(false) }, [record])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const chosen = items.map((item, index) => ({ index, title: edits[index]?.title ?? item.title ?? '', content: edits[index]?.content ?? item.content ?? '' })).filter(item => selected[item.index] !== false)
  return createPortal(<dialog ref={dialog} className="inspiration-workflow-knowledge-dialog" aria-label="项目知识更新" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><strong>项目知识更新</strong><button type="button" aria-label="关闭知识更新" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="inspiration-workflow-knowledge-body">{items.map((item, index) => <section key={index}>
      <div className="inspiration-knowledge-item-heading">{complete && !saved ? <input type="checkbox" aria-label={`保存${item.title}`} checked={selected[index] !== false} onChange={event => setSelected(current => ({ ...current, [index]: event.target.checked }))} /> : null}
        {editing ? <input aria-label={`知识标题 ${index + 1}`} maxLength={120} value={edits[index]?.title ?? item.title ?? ''} onChange={event => setEdits(current => ({ ...current, [index]: { title: event.target.value, content: current[index]?.content ?? item.content ?? '' } }))} /> : <strong>{item.title}</strong>}
      </div>{record?.changes[index]?.before ? <details><summary>查看原有内容</summary><ReplyMarkdown content={record.changes[index].before!.content} /></details> : null}
      {editing ? <textarea aria-label={`知识内容 ${index + 1}`} maxLength={20000} value={edits[index]?.content ?? item.content ?? ''} onChange={event => setEdits(current => ({ ...current, [index]: { title: current[index]?.title ?? item.title ?? '', content: event.target.value } }))} /> : <ReplyMarkdown content={edits[index]?.content ?? item.content ?? ''} />}
    </section>)}{error || record?.error ? <p className="inspiration-workflow-error" role="alert">{error || record?.error}</p> : null}</div>
    <footer><button type="button" disabled={!complete || busy || saved} onClick={() => setEditing(current => !current)}>{editing ? '结束编辑' : '编辑内容'}</button><div>
      <button type="button" disabled={busy} onClick={onClose}>{saved ? '关闭' : '暂不保存'}</button>
      {record?.status === 'saved' ? <button type="button" disabled={busy} onClick={onUndo}>撤销保存</button> : record?.status === 'undone' ? null : <button type="button" className="primary-button" disabled={!complete || busy || !record?.changes.length || !chosen.length || chosen.some(c => !c.title.trim() || !c.content.trim())} onClick={() => onSave(chosen)}>{busy ? '保存中…' : !complete ? '正在整理…' : `确认保存 · ${chosen.length} 项`}</button>}
    </div></footer>
  </dialog>, document.body)
}
