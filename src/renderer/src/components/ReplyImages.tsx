import { createContext, createElement, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Expand, ImageOff, X } from 'lucide-react'
import { renderWorkbenchMarkdown } from '../workbenchMarkdown'
import ResourceImagePreview from './ResourceImagePreview'
import './reply-images.css'
import { ReplyModelCard, ReplyModelDialog, type ReplyModelSelection } from './ReplyModels'

type Preview = { src: string; path: string; caption: string }
const ImageContext = createContext<{ projectPath?: string; read: (path: string) => Promise<string>; open: (image: Preview) => void; openModel: (model: ReplyModelSelection) => void } | null>(null)

export function ReplyImagesProvider({ projectPath, children }: { projectPath?: string; children: ReactNode }): React.JSX.Element {
  const [preview, setPreview] = useState<Preview>()
  const [model, setModel] = useState<ReplyModelSelection>()
  // Scope the cache to this conversation and project; don't store base64 in history.
  const cache = useMemo(() => new Map<string, Promise<string>>(), [projectPath])
  const read = useCallback((path: string): Promise<string> => {
    let request = cache.get(path)
    if (!request) {
      request = projectPath ? window.modmind.project.readImageAsset(path, projectPath) : Promise.reject(new Error('请先打开图片所属项目'))
      cache.set(path, request)
      // Bound decoded payload retention, including very large screenshots.
      void request.then(value => { if (value.length > 4 * 1024 * 1024) cache.delete(path) }, () => cache.delete(path))
      if (cache.size > 8) cache.delete(cache.keys().next().value!)
    }
    return request
  }, [cache, projectPath])
  useEffect(() => { setPreview(undefined); setModel(undefined) }, [projectPath])
  const context = useMemo(() => ({ projectPath, read, open: setPreview, openModel: setModel }), [read, projectPath])
  return <ImageContext.Provider value={context}>{children}{preview ? <ReplyImageDialog image={preview} onClose={() => setPreview(undefined)} /> : null}{model ? <ReplyModelDialog selection={model} onClose={() => setModel(undefined)} /> : null}</ImageContext.Provider>
}

function ReplyImageDialog({ image, onClose }: { image: Preview; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement as HTMLElement | null
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={dialog} className="reply-image-dialog" aria-label={`查看图片：${image.caption}`} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="reply-image-dialog-content">
      <header><div><strong>{image.caption}</strong><span title={image.path}>{image.path}</span></div><button type="button" className="icon-button" aria-label="关闭图片" title="关闭（Esc）" onClick={onClose} autoFocus><X size={20} /></button></header>
      <ResourceImagePreview src={image.src} name={image.caption} />
      <footer>滚轮或双指缩放 · 拖动查看细节 · 点击百分比恢复原始大小</footer>
    </div>
  </dialog>, document.body)
}

function ReplyImage({ path, caption }: { path: string; caption: string }): React.JSX.Element {
  const context = useContext(ImageContext)
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [size, setSize] = useState('')
  const label = caption || path.split('/').pop() || '项目图片'
  useEffect(() => {
    let active = true
    setSrc(''); setError(''); setSize('')
    if (!context) { setError('请在项目对话中查看图片'); return }
    void context.read(path).then(value => { if (active) setSrc(value) }, error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [context, path])
  return <button type="button" className={`reply-image-card${error ? ' has-error' : ''}`} disabled={!src || !!error} aria-label={`查看图片：${label}`} title={error || '点击放大'} onClick={() => context?.open({ src, path, caption: label })}>
    <span className="reply-image-stage">{error ? <span className="reply-image-status"><ImageOff size={22} /><span>{error}</span></span> : src ? <img src={src} alt={label} draggable={false} onLoad={event => setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setError('图片无法解码，文件可能已损坏')} /> : <span className="reply-image-status" role="status">正在读取图片…</span>}</span>
    <span className="reply-image-caption"><span>{label}</span><small>{size || '项目图片'}</small>{!error ? <Expand size={14} aria-hidden="true" /> : null}</span>
  </button>
}

export const ReplyMarkdown = memo(function ReplyMarkdown({ content, className = 'markdown-message', onSource }: { content: string; className?: string; onSource?: (href: string) => void }): React.JSX.Element {
  const context = useContext(ImageContext)
  const html = useMemo(() => renderWorkbenchMarkdown(content, !!onSource), [content, !!onSource])
  const children = useMemo(() => {
    // Only parse our escaped Markdown output. Stable React keys retain loaded
    // media and camera state while later text streams into the same reply.
    const template = document.createElement('template')
    template.innerHTML = html
    const render = (nodes: NodeListOf<ChildNode>, parentKey = ''): ReactNode[] => Array.from(nodes).map((node, index) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent
      if (!(node instanceof HTMLElement)) return null
      const key = `${parentKey}/${index}`
      if (node.dataset.replyModel) return <span key={key} className="reply-model-slot"><ReplyModelCard projectPath={context?.projectPath} path={node.dataset.replyModel} caption={node.dataset.imageCaption ?? ''} onExpand={value => context?.openModel(value)} /></span>
      if (node.dataset.replyImage) return <span key={key} className="reply-image-slot"><ReplyImage path={node.dataset.replyImage} caption={node.dataset.imageCaption ?? ''} /></span>
      const props: Record<string, unknown> = { key }
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name === 'class') props.className = attribute.value
        else if (['disabled', 'checked'].includes(attribute.name)) props[attribute.name] = true
        else if (['href', 'target', 'rel', 'title', 'type', 'start', 'align', 'data-source'].includes(attribute.name)) props[attribute.name] = attribute.value
      }
      const tag = node.tagName.toLowerCase()
      const container = tag === 'p' && node.querySelector('[data-reply-model], [data-reply-image]') ? 'div' : tag
      if (container !== tag) props.className = 'reply-media-paragraph'
      return createElement(container, props, ...(node.childNodes.length ? render(node.childNodes, key) : []))
    })
    return render(template.content.childNodes)
  }, [html, context])
  return <div className={className} onClick={event => { const source = (event.target as HTMLElement).closest<HTMLElement>('[data-source]')?.dataset.source; if (source) onSource?.(source) }}>{children}</div>
})
