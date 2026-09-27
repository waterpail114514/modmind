import { useEffect, useRef, useState } from 'react'
import { Minimize2, Power, X } from 'lucide-react'
import './close-window-dialog.css'

export function CloseWindowDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const trayRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => window.modmind.app.onCloseRequested(() => {
    setRemember(false)
    setBusy(false)
    setOpen(true)
  }), [])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => trayRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const resolve = async (choice: 'tray' | 'quit' | 'cancel'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.modmind.app.resolveClose(choice, choice !== 'cancel' && remember)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return <div className="modal-backdrop close-window-backdrop" onMouseDown={() => void resolve('cancel')}>
    <div ref={dialogRef} className="dialog close-window-dialog" role="dialog" aria-modal="true" aria-labelledby="close-window-title" aria-describedby="close-window-description" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); void resolve('cancel') }
      if (event.key === 'Tab') {
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="close-window-heading">
        <div>
          <h2 id="close-window-title">关闭 ModMind</h2>
          <p id="close-window-description">要让后台任务继续运行吗？</p>
        </div>
        <button className="icon-button" type="button" title="取消关闭" aria-label="取消关闭" onClick={() => void resolve('cancel')}><X size={17} /></button>
      </div>
      <div className="close-window-options">
        <button ref={trayRef} className="close-window-option close-window-option-primary" type="button" disabled={busy} onClick={() => void resolve('tray')}>
          <span className="close-window-option-icon"><Minimize2 size={19} /></span>
          <span className="close-window-option-copy"><strong>收起到系统托盘</strong><small>窗口隐藏，后台任务继续运行</small></span>
        </button>
        <button className="close-window-option" type="button" disabled={busy} onClick={() => void resolve('quit')}>
          <span className="close-window-option-icon"><Power size={19} /></span>
          <span className="close-window-option-copy"><strong>退出 ModMind</strong><small>结束应用和正在运行的任务</small></span>
        </button>
      </div>
      <div className="close-window-footer">
        <label className="close-window-remember"><input type="checkbox" checked={remember} disabled={busy} onChange={event => setRemember(event.target.checked)} /><span>记住我的选择</span></label>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void resolve('cancel')}>取消</button>
      </div>
    </div>
  </div>
}
