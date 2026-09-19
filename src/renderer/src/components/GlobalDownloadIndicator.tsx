import { describeClientFailure } from '../../../shared/clientFailure'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Download, LoaderCircle, RotateCcw, Square, Trash2, X } from 'lucide-react'
import type { DownloadActivity, DownloadActivitySnapshot } from '../../../shared/types'

function bytesLabel(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** unit
  return `${scaled >= 100 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

function progressLabel(activity: DownloadActivity): string {
  if (activity.status === 'failed') return '下载失败'
  if (activity.status === 'cancelled') return '下载已停止'
  if (activity.status === 'completed') return '下载完成'
  if (activity.totalBytes && activity.totalBytes > 0) return `${bytesLabel(activity.downloadedBytes)} / ${bytesLabel(activity.totalBytes)}`
  return activity.downloadedBytes > 0 ? `已下载 ${bytesLabel(activity.downloadedBytes)}` : '正在连接'
}

function ActivityIcon({ status }: { status: DownloadActivity['status'] }): React.JSX.Element {
  if (status === 'failed') return <CircleAlert size={17} />
  if (status === 'cancelled') return <Square size={15} />
  if (status === 'completed') return <CheckCircle2 size={17} />
  return <LoaderCircle className="spin" size={17} />
}

export default function GlobalDownloadIndicator(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DownloadActivitySnapshot>({ activities: [] })
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const activities = snapshot.activities
  const hasFailed = activities.some((activity) => activity.status === 'failed')
  const hasStopped = activities.some((activity) => activity.status === 'cancelled')
  const hasActive = activities.some((activity) => activity.status === 'downloading')
  const finishedCount = activities.filter((activity) => activity.status !== 'downloading').length
  const activeProgress = useMemo(() => {
    const known = activities.filter((activity) => activity.status === 'downloading' && activity.totalBytes && activity.totalBytes > 0)
    const downloaded = known.reduce((total, activity) => total + Math.min(activity.downloadedBytes, activity.totalBytes!), 0)
    const total = known.reduce((sum, activity) => sum + activity.totalBytes!, 0)
    return total > 0 ? Math.max(0, Math.min(1, downloaded / total)) : undefined
  }, [activities])

  useEffect(() => {
    let mounted = true
    void window.modmind.downloads.list().then((value) => { if (mounted) setSnapshot(value) })
    const unsubscribe = window.modmind.downloads.onChanged((value) => {
      if (mounted) setSnapshot(value)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!activities.length) setOpen(false)
  }, [activities.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!activities.length) return null

  return (
    <div ref={hostRef} className="global-download-host">
      <section className="global-download-popover" data-open={open} aria-hidden={!open} aria-label="下载任务">
        <header className="global-download-header">
          <div><strong>下载任务</strong><span>{hasActive ? `${activities.filter((activity) => activity.status === 'downloading').length} 项进行中` : hasFailed ? '有任务失败' : hasStopped ? '有任务已停止' : '全部完成'}</span></div>
          <div>
            {finishedCount ? <button type="button" title="清除已完成和失败任务" aria-label="清除已完成和失败任务" onClick={() => void window.modmind.downloads.clearFinished().then(setSnapshot)}><Trash2 size={15} /></button> : null}
            <button type="button" title="收起" aria-label="收起下载任务" onClick={() => setOpen(false)}><X size={16} /></button>
          </div>
        </header>
        <div className="global-download-list">
          {activities.map((activity) => {
            const fraction = activity.totalBytes && activity.totalBytes > 0 ? Math.max(0, Math.min(1, activity.downloadedBytes / activity.totalBytes)) : undefined
            return (
              <article key={activity.id} className={`global-download-row ${activity.status}`}>
                <span className="global-download-status"><ActivityIcon status={activity.status} /></span>
                <div className="global-download-copy">
                  <div>
                    <strong title={activity.label}>{activity.label}</strong>
                    <span className="global-download-actions">
                      {activity.status === 'downloading' && activity.restartable ? <button type="button" title="停止当前连接并从缓存重启" aria-label={`重启 ${activity.label}`} onClick={() => void window.modmind.downloads.restart(activity.id).then(setSnapshot)}><RotateCcw size={14} /></button> : null}
                      {activity.status === 'downloading' && activity.cancellable ? <button type="button" title="停止下载" aria-label={`停止 ${activity.label}`} onClick={() => void window.modmind.downloads.cancel(activity.id).then(setSnapshot)}><Square size={13} /></button> : null}
                      {activity.status !== 'downloading' && activity.retryable ? <button type="button" title="校验已有缓存并重试" aria-label={`重试 ${activity.label}`} onClick={() => void window.modmind.downloads.retry(activity.id).then(setSnapshot)}><RotateCcw size={14} /></button> : null}
                      {activity.status !== 'downloading' ? (
                      <button type="button" title="移除此任务" aria-label={`移除 ${activity.label}`} onClick={() => void window.modmind.downloads.dismiss(activity.id).then(setSnapshot)}><X size={14} /></button>
                      ) : null}
                    </span>
                  </div>
                  {activity.detail ? <small>{activity.detail}</small> : null}
                  {activity.error ? <p>{describeClientFailure(activity.error)}</p> : null}
                  <span>{progressLabel(activity)}</span>
                  {activity.status === 'downloading' ? <i className={fraction === undefined ? 'indeterminate' : ''}><b style={fraction === undefined ? undefined : { transform: `scaleX(${fraction})` }} /></i> : null}
                </div>
              </article>
            )
          })}
        </div>
      </section>
      <button
        type="button"
        className={`global-download-ball${hasFailed ? ' failed' : ''}`}
        aria-label={hasFailed ? '查看下载失败原因' : hasActive ? '查看正在下载的任务' : hasStopped ? '查看已停止的下载' : '查看已完成的下载'}
        aria-expanded={open}
        title={hasFailed ? '下载失败' : hasActive ? '正在下载' : hasStopped ? '下载已停止' : '下载完成'}
        onClick={() => setOpen((value) => !value)}
      >
        {hasFailed ? <CircleAlert size={23} /> : hasActive ? <Download size={23} /> : hasStopped ? <Square size={20} /> : <CheckCircle2 size={23} />}
        {activities.length > 1 ? <span>{activities.length > 99 ? '99+' : activities.length}</span> : null}
        {activeProgress !== undefined && !hasFailed ? <i style={{ transform: `scaleX(${activeProgress})` }} /> : null}
      </button>
    </div>
  )
}
