import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import './conversation-picker-list.css'

/** Shared by both conversation menus; only visible rows mount their actions. */
export default function ConversationPickerList<T extends { id: string; title: string }>({ conversations, activeId, renderRow }: {
  conversations: T[]
  activeId: string
  renderRow: (conversation: T) => ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<VirtuosoHandle>(null)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase())
  const entries = useMemo(() => conversations.map(item => ({ item, search: `${item.title}\n${item.id}`.toLocaleLowerCase() })), [conversations])
  const filtered = useMemo(() => deferred ? entries.filter(entry => entry.search.includes(deferred)).map(entry => entry.item) : conversations, [conversations, entries, deferred])
  const currentIndex = Math.max(0, filtered.findIndex(item => item.id === activeId))
  const [keyboardIndex, setKeyboardIndex] = useState(currentIndex)
  const locateCurrent = useRef(false)
  const focusRow = (index: number): void => {
    const next = Math.min(filtered.length - 1, Math.max(0, index))
    if (next < 0) return
    setKeyboardIndex(next)
    list.current?.scrollIntoView({ index: next, behavior: 'auto', done: () => {
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-conversation-index="${next}"] button`)?.focus({ preventScroll: true }))
    } })
  }
  useEffect(() => {
    if (locateCurrent.current && !deferred) {
      locateCurrent.current = false
      focusRow(currentIndex)
    }
  }, [deferred, currentIndex])
  return <div ref={root} className="conversation-picker-list" onKeyDown={event => {
    const input = event.target === search.current
    if (event.nativeEvent.isComposing || input && !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) return
    event.preventDefault()
    const rowIndex = Number((event.target as HTMLElement).closest<HTMLElement>('[data-conversation-index]')?.dataset.conversationIndex)
    const index = input ? currentIndex : Number.isFinite(rowIndex) ? rowIndex : keyboardIndex
    focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : input ? index : index + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? 5 : -5))
  }}>
    <div className="conversation-picker-search"><input ref={search} type="search" aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" title="定位当前对话" onClick={() => { if (query) { locateCurrent.current = true; setQuery(''); search.current?.focus() } else focusRow(currentIndex) }}>当前对话</button></div>
    {filtered.length ? <Virtuoso key={deferred} ref={list} className="conversation-picker-virtual-list" style={{ height: Math.min(240, filtered.length * 40) }} data={filtered} fixedItemHeight={40} initialTopMostItemIndex={currentIndex} computeItemKey={(_index, row) => row.id} increaseViewportBy={80} aria-label="对话列表" itemContent={(index, row) => <div data-conversation-index={index} onFocus={() => setKeyboardIndex(index)}>{renderRow(row)}</div>} /> : <p className="agent-conversation-note" role="status">{query ? '没有匹配的对话' : '还没有历史对话'}</p>}
  </div>
}
