import { useEffect, useRef, useState } from 'react'
import { Check, Download, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react'
import type { AppUpdateState } from '../../../shared/types'
import './app-maintenance-settings.css'
import ReinstallConfirmDialog from './ReinstallConfirmDialog'

export default function AppMaintenanceSettings(): React.JSX.Element {
  const [state, setState] = useState<AppUpdateState>({ phase: 'idle', currentVersion: '' })
  const [action, setAction] = useState<'check' | 'update' | 'reinstall' | null>(null)
  const [feedback, setFeedback] = useState('')
  const [confirmReinstall, setConfirmReinstall] = useState(false)
  const running = useRef(false)
  const busy = action !== null || ['checking', 'downloading', 'installing'].includes(state.phase)
  const progress = state.totalBytes ? Math.min(100, Math.round((state.downloadedBytes ?? 0) / state.totalBytes * 100)) : null

  useEffect(() => {
    let live = true
    let received = false
    const unsubscribe = window.modmind.app.onUpdateState(value => { received = true; if (live) { setState(value); setFeedback('') } })
    void window.modmind.app.getUpdateState().then(value => { if (live && !received) setState(value) }).catch(() => undefined)
    void window.modmind.app.getVersion().then(version => { if (live) setState(value => ({ ...value, currentVersion: version })) }).catch(() => undefined)
    return () => { live = false; unsubscribe() }
  }, [])

  const run = async (next: 'check' | 'update' | 'reinstall'): Promise<void> => {
    if (running.current || busy) return
    running.current = true
    setAction(next)
    setFeedback('')
    try {
      if (next === 'check') {
        const result = await window.modmind.app.checkForUpdates()
        if (!result) throw new Error('暂时无法检查更新，请检查网络后重试。')
        setFeedback(result.updateAvailable ? '发现新版本 ' + result.latestVersion : '当前已是最新版')
      } else if (next === 'update') {
        setState(await window.modmind.app.updateNow())
      } else {
        const result = await window.modmind.app.reinstallLatest(true)
        if (result) setState(result)
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      running.current = false
      setAction(null)
    }
  }

  const status = feedback || (state.phase === 'checking' ? '正在检查最新版本…'
    : state.phase === 'up-to-date' ? '当前已是最新版'
    : state.phase === 'downloading' ? '正在下载' + (state.operation === 'reinstall' ? '重装安装包' : '更新') + (progress === null ? '…' : ' · ' + progress + '%')
    : state.message || (state.phase === 'available' ? '发现新版本 ' + state.latestVersion : ''))

  return <>
    <div className="settings-heading"><h2>版本与更新</h2></div>
    <div className="app-maintenance-settings">
      <div className="app-maintenance-row">
        <span className="app-maintenance-version">ModMind {state.currentVersion || '—'}</span>
        <div className="settings-button-group">
          <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void run('check')}>{action === 'check' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}检查更新</button>
          <button className="primary-button compact" type="button" disabled={busy} onClick={() => void run('update')}>{action === 'update' || (busy && state.operation !== 'reinstall' && action !== 'check') ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}一键更新</button>
          <button className="secondary-button compact" type="button" disabled={busy} onClick={() => setConfirmReinstall(true)}>{action === 'reinstall' || (busy && state.operation === 'reinstall') ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}重装</button>
        </div>
      </div>
      {status && <p className="app-maintenance-status" role="status" aria-live="polite">{state.phase === 'up-to-date' && !feedback && <Check size={15} aria-hidden="true" />}{status}</p>}
      {state.phase === 'downloading' && <progress className="app-maintenance-progress" aria-label="安装包下载进度" max={100} value={progress ?? undefined} />}
    </div>
    {confirmReinstall && <ReinstallConfirmDialog onCancel={() => setConfirmReinstall(false)} onConfirm={() => { setConfirmReinstall(false); void run('reinstall') }} />}
  </>
}
