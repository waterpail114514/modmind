import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { MAX_AI_ATTACHMENTS } from '../../shared/aiAttachments'
import type { AiAttachment, AiAttachmentSelectionKind } from '../../shared/types'

export function attachmentTransferFiles(transfer: DataTransfer): File[] {
  const files = Array.from(transfer.files)
  if (files.length) return files
  return Array.from(transfer.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null)
}

function hasFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files') || Array.from(transfer.items).some((item) => item.kind === 'file')
}

export function useAiAttachments(options: {
  attachments: AiAttachment[]
  onChange: (attachments: AiAttachment[]) => void
  projectPath: string
  conversationId: string
  disabled: boolean
  onError?: (error: unknown) => void
}) {
  const latest = useRef(options)
  latest.current = options
  const scope = `${options.projectPath}\0${options.conversationId}`
  const generation = useRef({ scope, version: 0 })
  if (generation.current.scope !== scope) generation.current = { scope, version: generation.current.version + 1 }
  const mounted = useRef(true)
  const lock = useRef(false)
  const depth = useRef(0)
  const [picking, setPicking] = useState<AiAttachmentSelectionKind | 'transfer' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { depth.current = 0; setDragging(false); setError('') }, [scope, options.disabled])

  const run = async (kind: NonNullable<typeof picking>, files?: File[]): Promise<void> => {
    if (latest.current.disabled || lock.current) return
    const version = generation.current.version
    const current = latest.current
    lock.current = true
    setPicking(kind)
    setError('')
    try {
      if (current.attachments.length + (files?.length ?? 1) > MAX_AI_ATTACHMENTS) throw new Error(`最多保留 ${MAX_AI_ATTACHMENTS} 个附件`)
      const selected = kind === 'transfer'
        ? await window.modmind.ai.importAttachments(files!, current.projectPath)
        : await window.modmind.ai.pickAttachments(kind, current.projectPath)
      if (!mounted.current || version !== generation.current.version || latest.current.disabled || !selected.length) return
      const next = [...latest.current.attachments]
      const existing = new Set(next.map((attachment) => attachment.path))
      for (const attachment of selected) {
        if (!existing.has(attachment.path)) { existing.add(attachment.path); next.push(attachment) }
      }
      if (next.length > MAX_AI_ATTACHMENTS) throw new Error(`最多保留 ${MAX_AI_ATTACHMENTS} 个附件`)
      latest.current.onChange(next)
    } catch (cause) {
      if (mounted.current && version === generation.current.version) {
        setError(cause instanceof Error ? cause.message : String(cause))
        latest.current.onError?.(cause)
      }
    } finally {
      lock.current = false
      if (mounted.current) setPicking(null)
    }
  }

  return {
    picking, dragging, error,
    busy: picking !== null,
    isBusy: () => lock.current,
    pick: (kind: AiAttachmentSelectionKind) => { void run(kind) },
    handlers: {
      onPaste: (event: ClipboardEvent<HTMLElement>) => {
        const files = attachmentTransferFiles(event.clipboardData)
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        void run('transfer', files)
      },
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        if (!latest.current.disabled && !lock.current) { depth.current++; setDragging(true) }
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = latest.current.disabled || lock.current ? 'none' : 'copy'
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation()
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        depth.current = 0
        setDragging(false)
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        const files = attachmentTransferFiles(event.dataTransfer)
        if (files.length) void run('transfer', files)
      }
    }
  }
}

export type AiAttachmentController = ReturnType<typeof useAiAttachments>
