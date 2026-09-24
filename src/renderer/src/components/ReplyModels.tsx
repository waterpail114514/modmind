import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Expand, MousePointer2, X } from 'lucide-react'
import type { ProjectModelPreview } from '../../../shared/projectModels'
import './reply-models.css'

const ModelCanvas = lazy(() => import('./ResourceModelPreview').then(module => ({ default: module.ModelCanvas })))
export type ReplyModelSelection = { model: ProjectModelPreview; caption: string }

export function ReplyModelCard({ projectPath, path, caption, onExpand }: { projectPath?: string; path: string; caption: string; onExpand: (value: ReplyModelSelection) => void }): React.JSX.Element {
  const [model, setModel] = useState<ProjectModelPreview>()
  const [error, setError] = useState('')
  const [interactive, setInteractive] = useState(false)
  const label = caption || path.split('/').pop() || '3D 模型'
  useEffect(() => {
    let active = true
    setModel(undefined); setError(''); setInteractive(false)
    if (!projectPath) { setError('请先打开模型所属项目'); return }
    void window.modmind.project.readModelAsset(path, projectPath).then(value => { if (active) setModel(value) }, error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [projectPath, path])
  return <span className="reply-model-card" role="group" aria-label={`3D 模型：${label}`}>
    <span className="reply-model-stage">
      {error ? <span className="reply-image-status" role="status"><Box size={24} />{error}</span> : model ? <Suspense fallback={<span className="reply-image-status">正在载入 3D 查看器…</span>}><ModelCanvas projectModel={model} interactive={interactive} /></Suspense> : <span className="reply-image-status" role="status">正在读取模型与贴图…</span>}
      {model && !interactive ? <button type="button" className="reply-model-interact" onClick={() => setInteractive(true)}><MousePointer2 size={14} />旋转模型</button> : null}
    </span>
    <span className="reply-image-caption"><Box size={15} aria-hidden="true" /><span title={path}>{label}</span>{interactive ? <button type="button" className="reply-model-action" onClick={() => setInteractive(false)}>结束交互</button> : <small>3D</small>}<button type="button" className="reply-model-action" aria-label={`展开模型：${label}`} title="展开模型" disabled={!model} onClick={() => model && onExpand({ model, caption: label })}><Expand size={16} /></button></span>
    {model?.warnings.length ? <span className="reply-model-warning">{[...new Set(model.warnings)].join('；')}</span> : null}
  </span>
}

export function ReplyModelDialog({ selection, onClose }: { selection: ReplyModelSelection; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={dialog} className="reply-image-dialog reply-model-dialog" aria-label={`3D 模型：${selection.caption}`} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="reply-image-dialog-content">
      <header><div><strong>{selection.caption}</strong><span>{selection.model.path}</span></div><button type="button" className="icon-button" aria-label="关闭模型" onClick={onClose} autoFocus><X size={20} /></button></header>
      <Suspense fallback={<span className="reply-image-status">正在载入模型…</span>}><ModelCanvas projectModel={selection.model} /></Suspense>
      <footer>{selection.model.warnings.length ? [...new Set(selection.model.warnings)].join('；') : '静态模型预览 · 贴图保留像素清晰度'}</footer>
    </div>
  </dialog>, document.body)
}
