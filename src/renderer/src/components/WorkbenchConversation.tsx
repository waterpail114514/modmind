import { ReplyImagesProvider } from './ReplyImages'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { shiftedHistoryIndex } from '../historyWindow'

export interface ConversationScrollHistory {
  hasOlder: boolean
  hasNewer: boolean
  browsing: boolean
  windowStart: number
  busy: boolean
  error: string
  onOlder: () => void
  onNewer: () => void
  onLatest: () => void
  onRetry: () => void
}

const FooterContext = createContext<ReactNode>(null)

function ConversationFooter(): React.JSX.Element {
  return <>{useContext(FooterContext)}<div className="agent-conversation-bottom-space" aria-hidden="true" /></>
}

const components = { Footer: ConversationFooter }

export default function WorkbenchConversation<T extends { id: string }>({ rows, renderRow, isUserRow, footer, projectPath, surface = 'workbench', history }: {
  projectPath?: string
  rows: T[]
  renderRow: (row: T) => ReactNode
  isUserRow: (row: T) => boolean
  footer?: ReactNode
  surface?: 'workbench' | 'inspiration'
  history?: ConversationScrollHistory
}): React.JSX.Element {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const followRef = useRef(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  let latestUserIndex = rows.length - 1
  while (latestUserIndex >= 0 && !isUserRow(rows[latestUserIndex])) latestUserIndex -= 1
  const latestUserId = rows[latestUserIndex]?.id
  const latestUserRef = useRef(latestUserId)
  const frame = useRef<number>()
  const historyRef = useRef(history)
  historyRef.current = history
  const position = useRef({ rows, firstIndex: 1_000_000, windowStart: history?.windowStart })
  const windowChanged = position.current.windowStart !== history?.windowStart
  if (position.current.rows !== rows) position.current = { rows, firstIndex: history ? shiftedHistoryIndex(position.current.rows, rows, position.current.firstIndex) : 1_000_000, windowStart: history?.windowStart }
  const loadIntent = useRef<'older' | 'newer' | null>(null)
  const requestedRange = useRef('')
  const readingAnchor = useRef<{ id: string; y: number }[] | null>(null)
  const anchorPending = useRef(false)
  const captureAnchor = useCallback(() => {
    if (!scroller) return
    const top = scroller.getBoundingClientRect().top
    readingAnchor.current = [...scroller.querySelectorAll<HTMLElement>('[data-history-row]')]
      .filter(element => element.getBoundingClientRect().bottom > top + 1)
      .slice(0, 4).map(element => ({ id: element.dataset.historyRow!, y: element.getBoundingClientRect().top }))
  }, [scroller])
  const maybeLoad = useCallback(() => {
    const current = historyRef.current, direction = loadIntent.current
    if (!scroller || !current || !direction || current.busy || current.error) return
    const range = `${current.windowStart}:${direction}`
    const reached = direction === 'older' ? current.hasOlder && scroller.scrollTop <= 80 : current.hasNewer && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 80
    if (!reached || requestedRange.current === range) return
    requestedRange.current = range; loadIntent.current = null; anchorPending.current = true; captureAnchor()
    if (direction === 'older') current.onOlder(); else current.onNewer()
  }, [scroller, captureAnchor])
  const updateFollowing = useCallback((value: boolean) => {
    if (followRef.current === value) return
    followRef.current = value
    setFollowing(value)
  }, [])
  const scrollToLatest = useCallback(() => {
    if (!followRef.current || frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      if (!scroller || !scroller.clientHeight) return
      if (!followRef.current) return
      scroller.style.setProperty('--agent-conversation-space', '32px')
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })
    })
  }, [scroller])
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])

  useLayoutEffect(() => {
    anchorPending.current = false
    const previousId = latestUserRef.current
    latestUserRef.current = latestUserId
    if (windowChanged && history?.browsing) return
    if (history && !history.browsing || latestUserId && latestUserId !== previousId && !history?.browsing) {
      updateFollowing(true)
    }
    scrollToLatest()
  }, [latestUserId, latestUserIndex, surface, scrollToLatest, updateFollowing, history?.windowStart, history?.browsing, windowChanged])

  useEffect(() => { requestedRange.current = '' }, [history?.windowStart, history?.error])

  useLayoutEffect(() => {
    if (!history?.browsing || !scroller) { readingAnchor.current = null; return }
    const saved = readingAnchor.current
    if (!saved?.length) return
    let frame = 0, remaining = 6
    const restore = (): void => {
      const elements = [...scroller.querySelectorAll<HTMLElement>('[data-history-row]')]
      for (const anchor of saved) {
        const element = elements.find(item => item.dataset.historyRow === anchor.id)
        if (!element) continue
        const delta = element.getBoundingClientRect().top - anchor.y
        if (Math.abs(delta) > .5) scroller.scrollTop += delta
        break
      }
      if (--remaining > 0) frame = requestAnimationFrame(restore)
      else readingAnchor.current = null
    }
    frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [history?.windowStart, history?.browsing, scroller])

  useEffect(() => {
    if (!scroller) return
    let touchY = 0
    let previousTop = scroller.scrollTop
    const pause = (): void => { updateFollowing(false) }
    const onWheel = (event: WheelEvent): void => { if (event.deltaY < 0) pause(); loadIntent.current = event.deltaY < 0 ? 'older' : 'newer'; maybeLoad() }
    const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? 0 }
    const onTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY ?? touchY
      if (nextY > touchY) pause()
      loadIntent.current = nextY > touchY ? 'older' : 'newer'; maybeLoad()
      touchY = nextY
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause()
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) loadIntent.current = 'older'
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) loadIntent.current = 'newer'
    }
    const onPointerDown = (event: PointerEvent): void => {
      // Reading and opening historical steps take priority over output following.
      if (event.button === 0) { pause(); loadIntent.current = 'older' }
    }
    const onScroll = (): void => {
      if (loadIntent.current && scroller.scrollTop !== previousTop) loadIntent.current = scroller.scrollTop < previousTop ? 'older' : 'newer'
      previousTop = scroller.scrollTop
      if (anchorPending.current && readingAnchor.current) captureAnchor()
      if (!historyRef.current?.browsing && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4) updateFollowing(true)
      maybeLoad()
    }
    const observer = new ResizeObserver(() => {
      scrollToLatest()
    })
    observer.observe(scroller)
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('pointerdown', onPointerDown)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scrollToLatest()
    return () => {
      observer.disconnect()
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('scroll', onScroll)
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    }
  }, [scroller, surface, scrollToLatest, updateFollowing, maybeLoad, captureAnchor])

  return <ReplyImagesProvider projectPath={projectPath}><div className="agent-conversation-region" data-history-window-start={history?.windowStart} data-history-row-count={history ? rows.length : undefined}>
    <FooterContext.Provider value={footer}>
      <Virtuoso
        ref={virtuosoRef}
        className="agent-conversation"
        tabIndex={0}
        aria-label={surface === 'inspiration' ? '灵感台对话记录' : '工作台对话记录'}
        data={rows}
        computeItemKey={(_index, row) => row.id}
        firstItemIndex={history ? position.current.firstIndex : undefined}
        initialTopMostItemIndex={history ? { index: 'LAST', align: 'end' } : rows.length - 1}
        // A sampled long reply can otherwise be extrapolated to every unread
        // row, exceeding Chromium's scroll-height limit before measurement.
        defaultItemHeight={100}
        scrollerRef={scrollerRef}
        followOutput={() => followRef.current ? 'auto' : false}
        atBottomStateChange={setAtBottom}
        totalListHeightChanged={scrollToLatest}
        rangeChanged={scrollToLatest}
        increaseViewportBy={400}
        itemContent={(_index, row) => <div data-history-row={row.id} data-latest-user={row.id === latestUserId || undefined} className="agent-conversation-row">{renderRow(row)}</div>}
        components={components}
      />
    </FooterContext.Provider>
    {history?.busy || history?.error ? <div className="agent-history-scroll-state" role={history.error ? 'alert' : 'status'}>{history.error ? <><span>{history.error}</span><button type="button" onClick={() => { requestedRange.current = ''; anchorPending.current = true; captureAnchor(); history.onRetry() }}>重试</button></> : '正在读取记录…'}</div> : null}
    {!following || !atBottom || history?.browsing ? <button type="button" className="agent-scroll-latest" title="一键到底" aria-label="一键到底" onClick={() => { anchorPending.current = false; readingAnchor.current = null; history?.onLatest(); updateFollowing(true); scrollToLatest() }}><ArrowDown size={17} /></button> : null}
  </div></ReplyImagesProvider>
}
