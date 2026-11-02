import { memo, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { History, LoaderCircle, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { SnapshotBatchDeleteResult, SnapshotInfo } from '../../../shared/types'
import './snapshot-list.css'

export default memo(function SnapshotList({ snapshots, loading, error, onRetry, restoringId, deletingId, disabled, onRestore, onDelete, onDeleteMany, formatDate }: {
  snapshots: SnapshotInfo[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  restoringId: string
  deletingId: string
  disabled: boolean
  onRestore: (snapshot: SnapshotInfo) => void
  onDelete: (snapshot: SnapshotInfo) => void
  onDeleteMany: (snapshots: SnapshotInfo[]) => Promise<SnapshotBatchDeleteResult | undefined>
  formatDate: (value: string) => string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const batchLock = useRef(false)
  const [batchError, setBatchError] = useState('')
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([])
  const [batchSummary, setBatchSummary] = useState('')
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return term ? snapshots.filter(snapshot => `${snapshot.label}\n${snapshot.id}`.toLocaleLowerCase().includes(term)) : snapshots
  }, [snapshots, query])
  const selected = useMemo(() => snapshots.filter(snapshot => selectedIds.has(snapshot.id)), [snapshots, selectedIds])
  const selectedInFilter = filtered.filter(snapshot => selectedIds.has(snapshot.id)).length
  const unavailable = disabled || Boolean(loading) || batchBusy
  const removeSelected = async (): Promise<void> => {
    if (unavailable || batchLock.current || !selected.length) return
    batchLock.current = true
    setBatchBusy(true); setBatchError(''); setFailures([]); setBatchSummary('')
    try {
      const result = await onDeleteMany(selected)
      if (!result) return
      const removed = new Set(result.deletedIds)
      setSelectedIds(current => new Set([...current].filter(id => !removed.has(id))))
      setFailures(result.failed)
      setBatchSummary(`已删除 ${result.deletedIds.length} 个快照${result.failed.length ? `，${result.failed.length} 个未删除` : ''}`)
    } catch (error) { setBatchError(error instanceof Error ? error.message : String(error)) }
    finally { batchLock.current = false; setBatchBusy(false) }
  }
  return <section className="snapshot-list snapshot-list-window" aria-label="版本快照">
    {error ? <div className="snapshot-list-status" role="alert">{error}<button type="button" className="secondary-button compact" onClick={onRetry}>重试</button></div> : null}
    {snapshots.length ? <div className="snapshot-selection-bar">
      <label className="snapshot-select-all"><input type="checkbox" aria-label={query ? '全选筛选结果' : '全选快照'} checked={Boolean(filtered.length) && selectedInFilter === filtered.length} ref={element => { if (element) element.indeterminate = selectedInFilter > 0 && selectedInFilter < filtered.length }} disabled={unavailable || !filtered.length} onChange={event => { const checked = event.target.checked; setSelectedIds(current => { const next = new Set(current); for (const snapshot of filtered) { if (checked) next.add(snapshot.id); else next.delete(snapshot.id) } return next }) }} />{query ? '全选筛选结果' : '全选'}</label>
      <span className="snapshot-selection-count">已选 {selected.length}{selected.length > selectedInFilter ? `（筛选外 ${selected.length - selectedInFilter}）` : ''}</span>
      <button type="button" className="secondary-button compact" disabled={unavailable || !selected.length} onClick={() => setSelectedIds(new Set())}>取消选择</button>
      <button type="button" className="secondary-button compact danger" disabled={unavailable || !selected.length || selected.length > 10_000} title={selected.length > 10_000 ? '每次最多删除 10000 个快照' : undefined} onClick={() => void removeSelected()}>{batchBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}删除所选{selected.length ? `（${selected.length}）` : ''}</button>
    </div> : null}
    {batchSummary ? <div className="snapshot-batch-result" role="status">{batchSummary}</div> : null}
    {batchError ? <div className="snapshot-batch-result error" role="alert">批量删除失败：{batchError}。请刷新列表核对结果后重试。</div> : null}
    {failures.length ? <details className="snapshot-batch-result error" open><summary>查看未删除原因</summary><ul>{failures.map(failure => <li key={failure.id}>{snapshots.find(snapshot => snapshot.id === failure.id)?.label ?? failure.id}：{failure.message}</li>)}</ul></details> : null}
    {snapshots.length > 20 || query ? <label className="snapshot-search"><Search size={15} /><input aria-label="搜索版本" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索版本" /><span>{filtered.length} / {snapshots.length}</span></label> : null}
    {filtered.length ? <Virtuoso className="snapshot-virtual-list" style={{ height: Math.min(520, Math.max(140, filtered.length * 76)) }} data={filtered} computeItemKey={(_index, snapshot) => snapshot.id} increaseViewportBy={152} itemContent={(_index, snapshot) => <article className="snapshot-row">
      <span className="snapshot-selection"><input type="checkbox" aria-label={`选择快照 ${snapshot.label} ${snapshot.id}`} checked={selectedIds.has(snapshot.id)} disabled={unavailable} onChange={event => { const checked = event.target.checked; setSelectedIds(current => { const next = new Set(current); if (checked) next.add(snapshot.id); else next.delete(snapshot.id); return next }) }} /></span>
      <div><h3>{snapshot.label}</h3><p>{formatDate(snapshot.createdAt)} · {snapshot.fileCount} 个文件</p></div>
      <code>{snapshot.id.slice(0, 19)}</code>
      <div className="snapshot-actions">
        <button className="icon-button" title="恢复此快照" aria-label={`恢复快照 ${snapshot.label}`} disabled={unavailable} onClick={() => onRestore(snapshot)}>{restoringId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button>
        <button className="icon-button danger" title="删除此快照" aria-label={`删除快照 ${snapshot.label}`} disabled={unavailable} onClick={() => onDelete(snapshot)}>{deletingId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>
      </div>
    </article>} /> : loading ? <div className="large-empty" role="status"><LoaderCircle className="spin" size={24} /><span>正在读取版本…</span></div> : error ? null : <div className="large-empty"><History size={26} /><h3>{snapshots.length ? '没有匹配的版本' : '还没有版本快照'}</h3></div>}
  </section>
})
