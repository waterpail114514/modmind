import { useEffect, useRef } from 'react'
import type { WorkflowData } from '../lib/imageWorkflow'

type ClipboardNode = { kind: 'prompt' | 'reference'; data: Partial<WorkflowData> }

/** Listen only while this workflow is active; ordinary editing keeps its native paste behavior. */
export default function ImageWorkflowPaste({ enabled, epoch, onPaste, onMessage }: {
  enabled: boolean
  epoch: number
  onPaste: (node: ClipboardNode) => void
  onMessage: (message: string) => void
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const callbacks = useRef({ onPaste, onMessage, enabled, epoch })
  callbacks.current = { onPaste, onMessage, enabled, epoch }

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const readers = new Set<FileReader>()
    const active = (): boolean => !cancelled && callbacks.current.enabled && callbacks.current.epoch === epoch
    const paste = (event: ClipboardEvent): void => {
      if (!active() || event.defaultPrevented || !event.clipboardData) return
      const page = anchor.current?.closest('.image-studio-page')
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (!page || !page.getClientRects().length) return
      if (target && target !== document.body && target !== document.documentElement && !page.contains(target)) return
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="alertdialog"]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return

      // Copying an image often also supplies its URL as text. Prefer the actual image.
      const clipboard = event.clipboardData
      const imageItem = Array.from(clipboard.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))
      const image = imageItem?.getAsFile() ?? Array.from(clipboard.files).find(file => file.type.startsWith('image/'))
      if (image) {
        event.preventDefault()
        if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(image.type)) { callbacks.current.onMessage('请粘贴 PNG、JPEG、WebP、GIF 或 BMP 图片'); return }
        if (!image.size || image.size > 20 * 1024 * 1024) { callbacks.current.onMessage('参考图不能为空且不能超过 20 MB'); return }
        const reader = new FileReader()
        readers.add(reader)
        reader.onload = () => {
          readers.delete(reader)
          if (active() && typeof reader.result === 'string') callbacks.current.onPaste({ kind: 'reference', data: { referenceImage: reader.result, referenceLabel: image.name || '剪贴板图片' } })
        }
        reader.onerror = () => { readers.delete(reader); if (active()) callbacks.current.onMessage('无法读取剪贴板图片，请重新复制后粘贴') }
        callbacks.current.onMessage('正在读取剪贴板图片…')
        reader.readAsDataURL(image)
        return
      }
      const text = clipboard.getData('text/plain')
      if (!text.trim()) return
      event.preventDefault()
      if (text.trim().length > 32_000) { callbacks.current.onMessage('提示词不能超过 32000 个字符，请分段粘贴'); return }
      callbacks.current.onPaste({ kind: 'prompt', data: { prompt: text } })
    }
    document.addEventListener('paste', paste)
    return () => {
      cancelled = true
      document.removeEventListener('paste', paste)
      readers.forEach(reader => { if (reader.readyState === FileReader.LOADING) reader.abort() })
    }
  }, [enabled, epoch])

  return <span ref={anchor} hidden />
}
