import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, X } from 'lucide-react'
import type { AppChangelogSnapshot } from '../../../shared/appChangelog'
import './app-changelog-dialog.css'

export default function AppChangelogDialog({ snapshot, onClose, onPresented }: {
  snapshot: AppChangelogSnapshot
  onClose: () => void
  onPresented?: () => void
}): React.JSX.Element {
  const id = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const presentedRef = useRef(onPresented)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [latest, ...history] = snapshot.releases

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialogRef.current))
    const inertValues = background.map(element => element.inert)
    background.forEach(element => { element.inert = true })
    closeRef.current?.focus()
    presentedRef.current?.()
    return () => {
      background.forEach((element, index) => { element.inert = inertValues[index] })
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  return createPortal(<div className="modal-backdrop app-changelog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} className="dialog app-changelog-dialog" role="dialog" aria-modal="true" aria-labelledby={id + '-title'} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? [])
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="app-changelog-header">
        <h2 id={id + '-title'}>更新日志</h2>
        <button className="icon-button" type="button" aria-label="关闭更新日志" title="关闭更新日志" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="app-changelog-body" tabIndex={0} aria-label="版本更新内容">
        <p className="app-changelog-current">{snapshot.automatic ? '已更新至' : '当前版本'} ModMind {snapshot.currentVersion}</p>
        {latest ? [latest, ...(historyOpen ? history : [])].map(release => <section className="app-changelog-release" key={release.version}>
          {release.version !== snapshot.currentVersion && <h3>{release.version}</h3>}
          {release.sections.map(section => <div className="app-changelog-section" key={section.title}>
            <h4>{section.title}</h4>
            <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul>
          </div>)}
        </section>) : <p className="app-changelog-empty">此版本尚未收录更新日志。</p>}
        {history.length > 0 && <button className="app-changelog-history" type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><ChevronDown size={15} aria-hidden="true" />{historyOpen ? '收起历史版本' : '查看历史版本'}</button>}
      </div>
      <div className="app-changelog-footer"><button ref={closeRef} className="primary-button" type="button" onClick={onClose}>关闭</button></div>
    </div>
  </div>, document.body)
}
