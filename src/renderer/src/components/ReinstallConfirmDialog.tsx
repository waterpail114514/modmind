import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { RotateCcw, X } from 'lucide-react'
import './reinstall-confirm-dialog.css'

export default function ReinstallConfirmDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  const id = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialogRef.current))
    const inertValues = background.map(element => element.inert)
    background.forEach(element => { element.inert = true })
    cancelRef.current?.focus()
    return () => {
      background.forEach((element, index) => { element.inert = inertValues[index] })
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop reinstall-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
      <div ref={dialogRef} className="reinstall-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={id + '-title'} aria-describedby={id + '-description'} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
        if (event.key === 'Tab') {
          const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
          const first = buttons[0], last = buttons[buttons.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <div className="reinstall-confirm-header">
          <h2 id={id + '-title'}>重装 ModMind？</h2>
          <button className="reinstall-confirm-close" type="button" aria-label="关闭" onClick={onCancel}><X size={18} /></button>
        </div>
        <div id={id + '-description'} className="reinstall-confirm-copy">
          <p>下载最新版后，优先清除应用数据并重新安装。</p>
          <p>设置、登录信息、插件和缓存将被清除，Gradle 等工具需重新下载。<strong>项目文件和项目列表保留。</strong></p>
          <p>清理重装无法启动时，自动改为覆盖安装，保留现有应用数据。</p>
        </div>
        <div className="reinstall-confirm-footer">
          <button className="secondary-button reinstall-confirm-action" type="button" onClick={onConfirm}><RotateCcw size={15} />下载并重装</button>
          <button ref={cancelRef} className="primary-button reinstall-confirm-cancel" type="button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
