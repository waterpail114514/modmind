import { createContext, createElement, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Copy, Download, Expand, ImageOff, X } from 'lucide-react'
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

type ReplyMarkdownProps = { content: string; className?: string; onSource?: (href: string) => void }
const REPLY_PAGE_CHARS = 12_000

type ReplyPage = { start: number; end: number; fence: string }
function replyPages(content: string): ReplyPage[] {
  const pages: ReplyPage[] = []
  let start = 0
  let fence = ''
  while (start < content.length) {
    let end = Math.min(content.length, start + REPLY_PAGE_CHARS)
    if (end < content.length) {
      const newline = content.slice(start, end).lastIndexOf('\n')
      if (newline > REPLY_PAGE_CHARS / 2) end = start + newline + 1
      // Keep UTF-16 pairs intact even for a very long unbroken line.
      if (/[\uD800-\uDBFF]/u.test(content[end - 1])) end--
    }
    pages.push({ start, end, fence })
    for (const line of content.slice(start, end).split('\n')) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
      if (!match) continue
      if (!fence) fence = `${match[1]}${match[2]}`
      else if (match[1][0] === fence[0] && match[1].length >= /^(`+|~+)/u.exec(fence)![0].length && !match[2].trim()) fence = ''
    }
    start = end
  }
  return pages
}

function LongReply({ content, className, onSource }: ReplyMarkdownProps): React.JSX.Element {
  const pages = useMemo(() => replyPages(content), [content])
  const [selected, setSelected] = useState(0)
  const [fullOpen, setFullOpen] = useState(false)
  const page = Math.min(selected, pages.length - 1)
  const part = pages[page]
  const preview = `${part.fence ? `${part.fence}\n` : ''}${content.slice(part.start, part.end)}`
  return <div className="reply-long-message">
    <div className="reply-long-toolbar"><span>长回复 · 第 {page + 1} / {pages.length} 段</span><button type="button" aria-label="上一段回复" disabled={page === 0} onClick={() => setSelected(page - 1)}><ChevronLeft size={14} /></button><button type="button" aria-label="下一段回复" disabled={page === pages.length - 1} onClick={() => setSelected(page + 1)}><ChevronRight size={14} /></button><button type="button" onClick={() => setFullOpen(true)}>阅读全文</button></div>
    <ReplyMarkdownPage content={preview} className={className} onSource={onSource} />
    {fullOpen ? <ReplyTextDialog content={content} pages={pages} initialPage={page} onClose={() => setFullOpen(false)} /> : null}
  </div>
}

function ReplyTextDialog({ content, pages, initialPage, onClose }: { content: string; pages: ReplyPage[]; initialPage: number; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const text = useRef<HTMLPreElement>(null)
  const [page, setPage] = useState(initialPage)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState(-1)
  const [message, setMessage] = useState('')
  const part = pages[Math.min(page, pages.length - 1)]
  const source = content.slice(part.start, part.end)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { text.current?.scrollTo({ top: 0 }) }, [page])
  useEffect(() => {
    if (match >= 0) text.current?.querySelector('mark')?.scrollIntoView({ block: 'center' })
  }, [page, match])
  const find = (): void => {
    if (!query) return
    let index = content.indexOf(query, match >= 0 ? match + Math.max(1, query.length) : 0)
    if (index < 0) index = content.indexOf(query)
    setMatch(index)
    if (index < 0) setMessage('没有找到匹配文字')
    else { setPage(pages.findIndex(part => index >= part.start && index < part.end)); setMessage('已定位匹配文字') }
  }
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'ModMind-完整回复.md'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const offset = match - part.start
  return createPortal(<dialog ref={dialog} className="reply-text-dialog" aria-label="完整回复原文" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header><strong>完整回复原文</strong><button type="button" aria-label="关闭完整回复" title="关闭（Esc）" onClick={onClose}><X size={18} /></button></header>
    <div className="reply-text-tools"><input type="search" aria-label="在完整回复中查找" placeholder="查找原文" value={query} onChange={event => { setQuery(event.target.value); setMatch(-1); setMessage('') }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); find() } }} /><button type="button" disabled={!query} onClick={find}>查找下一个</button><button type="button" onClick={() => { void navigator.clipboard.writeText(content).then(() => setMessage('已复制完整回复'), () => setMessage('复制失败，可以下载完整原文')) }}><Copy size={14} />复制全文</button><button type="button" onClick={download}><Download size={14} />下载原文</button></div>
    <pre ref={text} tabIndex={0}>{offset >= 0 && offset < source.length ? <>{source.slice(0, offset)}<mark>{source.slice(offset, offset + query.length)}</mark>{source.slice(offset + query.length)}</> : source}</pre>
    <footer><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一段</button><label>第 <input type="number" aria-label="原文段数" min={1} max={pages.length} value={page + 1} onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= pages.length) setPage(next - 1) }} /> / {pages.length} 段</label><button type="button" disabled={page === pages.length - 1} onClick={() => setPage(page + 1)}>下一段</button><span role="status">{message}</span></footer>
  </dialog>, document.body)
}

export const ReplyMarkdown = memo(function ReplyMarkdown(props: ReplyMarkdownProps): React.JSX.Element {
  return props.content.length > REPLY_PAGE_CHARS * 2 ? <LongReply {...props} /> : <ReplyMarkdownPage {...props} />
})

const ReplyMarkdownPage = memo(function ReplyMarkdownPage({ content, className = 'markdown-message', onSource }: ReplyMarkdownProps): React.JSX.Element {
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
