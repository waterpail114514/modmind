import { useState, type ReactNode } from 'react'
import './paged-steps.css'

const PAGE_SIZE = 50

/** Bound expanded tool groups as well as the outer, virtualized conversation. */
export default function PagedSteps<T>({ items, renderItem }: {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
}): React.JSX.Element {
  // null follows the newest steps; an explicit offset keeps older pages still.
  const [offset, setOffset] = useState<number | null>(null)
  const latest = Math.max(0, items.length - PAGE_SIZE)
  const start = Math.min(offset ?? latest, latest)
  const end = Math.min(items.length, start + PAGE_SIZE)
  return <div className="agent-tool-group-body">
    {items.length > PAGE_SIZE ? <nav className="agent-step-pages" aria-label="步骤分页">
      <button type="button" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - PAGE_SIZE))}>较早步骤</button>
      <span aria-live="polite">{start + 1}–{end} / {items.length}</span>
      <button type="button" disabled={end === items.length} onClick={() => setOffset(start + PAGE_SIZE >= latest ? null : start + PAGE_SIZE)}>较新步骤</button>
      {offset !== null && end < items.length ? <button type="button" onClick={() => setOffset(null)}>最新步骤</button> : null}
    </nav> : null}
    {items.slice(start, end).map((item, index) => renderItem(item, start + index))}
  </div>
}
