import { useEffect, useRef, useState } from 'react'
import { Download, Gamepad2, LoaderCircle, RotateCcw, Square, X } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import type { LocalTestState, MinecraftRuntimeState } from '../../../shared/minecraft'
import { launchQuickGameTest, quickTestOptions, quickTestUnavailable } from '../lib/quickGameTest'
import { reportClientFailure } from '../lib/clientFailure'

export default function QuickGameTestDialog({ project, onClose, onExport }: {
  project: ProjectInfo
  onClose: () => void
  onExport: () => void
}): React.JSX.Element {
  const unavailable = quickTestUnavailable(project)
  const [message, setMessage] = useState(unavailable ?? '正在准备游戏测试')
  const [busy, setBusy] = useState(!unavailable)
  const [active, setActive] = useState(false)
  const [failed, setFailed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const request = useRef<Promise<unknown> | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const plugin = project.kind === 'server-plugin'

  const start = async (): Promise<void> => {
    if (request.current || unavailable) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setFailed(false)
    setMessage('正在准备游戏测试')
    const pending = launchQuickGameTest(window.modmind, project, quickTestOptions(localStorage), abort.signal)
    request.current = pending
    try {
      const state = await pending
      if (!abort.signal.aborted) {
        setMessage(state.message)
        setActive('active' in state ? state.active : state.running)
      }
    }
    catch (error) {
      if (!abort.signal.aborted) {
        setFailed(true)
        setMessage(reportClientFailure(error))
      }
    } finally {
      if (request.current === pending) request.current = null
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    controller.current?.abort()
    setStopping(true)
    try {
      if (plugin) await window.modmind.localTest.stop()
      else {
        try { await window.modmind.minecraft.cancelPreparation() }
        finally { await window.modmind.minecraft.stop() }
      }
      await request.current?.catch(() => undefined)
      setActive(false)
      setFailed(false)
      setMessage('测试已停止')
    } catch (error) {
      setFailed(true)
      setMessage(reportClientFailure(error))
    } finally { setStopping(false) }
  }

  useEffect(() => {
    const accept = (state: MinecraftRuntimeState | LocalTestState): void => {
      if (state.projectPath !== project.path || controller.current?.signal.aborted) return
      setMessage(state.message)
      setActive('active' in state ? state.active : state.running)
      setFailed(state.stage === 'error')
    }
    const remove = plugin ? window.modmind.localTest.onState(accept) : window.modmind.minecraft.onState(accept)
    let disposed = false
    // Defer until effect setup is committed so StrictMode cannot launch twice.
    queueMicrotask(() => { if (!disposed) void start() })
    const previousFocus = document.activeElement
    dialog.current?.focus()
    return () => {
      disposed = true
      remove()
      controller.current?.abort()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  const preparing = busy || stopping
  return <div className="modal-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !preparing) onClose()
    if (event.key === 'Tab') {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
  }}>
    <div ref={dialog} tabIndex={-1} className="dialog quick-game-test-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-game-test-title">
      <div className="dialog-header"><div style={{ minWidth: 0 }}><h2 id="quick-game-test-title">游戏测试</h2><p style={{ overflowWrap: 'anywhere' }}>{project.name}</p></div><button className="icon-button" type="button" title="返回创作" aria-label="返回创作" disabled={preparing} onClick={onClose}><X size={16} /></button></div>
      <p role={failed ? 'alert' : 'status'} style={{ overflowWrap: 'anywhere', maxHeight: '40vh', overflowY: 'auto' }}>{preparing ? <LoaderCircle size={16} className="spin" /> : <Gamepad2 size={16} />} {message}</p>
      <div className="dialog-footer">
        {unavailable && project.loader !== 'velocity' && !project.draft ? <button className="primary-button" onClick={onExport}><Download size={15} />导出作品</button> : null}
        {!unavailable && (busy || active) ? <button className="secondary-button" disabled={stopping} onClick={() => void stop()}><Square size={15} />{stopping ? '正在停止' : busy ? '取消测试' : '停止测试'}</button> : null}
        {!unavailable && !preparing && !active ? <button className="primary-button" onClick={() => void start()}><RotateCcw size={15} />{failed ? '重试' : '重新测试'}</button> : null}
        {!preparing ? <button className="secondary-button" onClick={onClose}>返回创作</button> : null}
      </div>
    </div>
  </div>
}
