import { memo, useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { Archive, History, LoaderCircle, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { SnapshotInfo } from '../../../shared/types'
import './snapshot-list.css'

export default memo(function SnapshotList({ snapshots, loading, error, onRetry, restoringId, deletingId, disabled, onRestore, onDelete, formatDate }: {
  snapshots: SnapshotInfo[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  restoringId: string
  deletingId: string
  disabled: boolean
  onRestore: (snapshot: SnapshotInfo) => void
  onDelete: (snapshot: SnapshotInfo) => void
  formatDate: (value: string) => string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return term ? snapshots.filter(snapshot => `${snapshot.label}\n${snapshot.id}`.toLocaleLowerCase().includes(term)) : snapshots
  }, [snapshots, query])
  return <section className="snapshot-list snapshot-list-window" aria-label="版本快照">
    {error ? <div className="snapshot-list-status" role="alert">{error}<button type="button" className="secondary-button compact" onClick={onRetry}>重试</button></div> : null}
    {snapshots.length > 20 || query ? <label className="snapshot-search"><Search size={15} /><input aria-label="搜索版本" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索版本" /><span>{filtered.length} / {snapshots.length}</span></label> : null}
    {filtered.length ? <Virtuoso className="snapshot-virtual-list" style={{ height: Math.min(520, Math.max(140, filtered.length * 76)) }} data={filtered} computeItemKey={(_index, snapshot) => snapshot.id} increaseViewportBy={152} itemContent={(_index, snapshot) => <article className="snapshot-row">
      <span className="snapshot-icon"><Archive size={18} /></span>
      <div><h3>{snapshot.label}</h3><p>{formatDate(snapshot.createdAt)} · {snapshot.fileCount} 个文件</p></div>
      <code>{snapshot.id.slice(0, 19)}</code>
      <div className="snapshot-actions">
        <button className="icon-button" title="恢复此快照" aria-label={`恢复快照 ${snapshot.label}`} disabled={disabled} onClick={() => onRestore(snapshot)}>{restoringId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button>
        <button className="icon-button danger" title="删除此快照" aria-label={`删除快照 ${snapshot.label}`} disabled={disabled} onClick={() => onDelete(snapshot)}>{deletingId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>
      </div>
    </article>} /> : loading ? <div className="large-empty" role="status"><LoaderCircle className="spin" size={24} /><span>正在读取版本…</span></div> : error ? null : <div className="large-empty"><History size={26} /><h3>{snapshots.length ? '没有匹配的版本' : '还没有版本快照'}</h3></div>}
  </section>
})
