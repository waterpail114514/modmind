import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'

const FooterContext = createContext<ReactNode>(null)

function ConversationFooter(): React.JSX.Element {
  return <>{useContext(FooterContext)}<div className="agent-conversation-bottom-space" aria-hidden="true" /></>
}

const components = { Footer: ConversationFooter }

export default function WorkbenchConversation<T extends { id: string }>({ rows, renderRow, footer }: {
  rows: T[]
  renderRow: (row: T) => ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [following, setFollowing] = useState(true)
  const followRef = useRef(true)
  const frame = useRef<number>()
  const updateFollowing = useCallback((value: boolean) => {
    if (followRef.current === value) return
    followRef.current = value
    setFollowing(value)
  }, [])
  const scrollToLatest = useCallback(() => {
    if (!followRef.current || frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      if (followRef.current && scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })
    })
  }, [scroller])
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])

  useEffect(() => {
    if (!scroller) return
    let touchY = 0
    const pause = (): void => updateFollowing(false)
    const onWheel = (event: WheelEvent): void => { if (event.deltaY < 0) pause() }
    const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? 0 }
    const onTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY ?? touchY
      if (nextY > touchY) pause()
      touchY = nextY
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause()
    }
    const onPointerDown = (event: PointerEvent): void => {
      // Reading and opening historical steps take priority over output following.
      if (event.button === 0) pause()
    }
    const onScroll = (): void => {
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4) updateFollowing(true)
    }
    const observer = new ResizeObserver(() => {
      scroller.style.setProperty('--agent-conversation-space', `${scroller.clientHeight / 2}px`)
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
  }, [scroller, scrollToLatest, updateFollowing])

  return <div className="agent-conversation-region">
    <FooterContext.Provider value={footer}>
      <Virtuoso
        className="agent-conversation"
        tabIndex={0}
        aria-label="工作台对话记录"
        data={rows}
        computeItemKey={(_index, row) => row.id}
        initialTopMostItemIndex={rows.length - 1}
        // A sampled long reply can otherwise be extrapolated to every unread
        // row, exceeding Chromium's scroll-height limit before measurement.
        defaultItemHeight={100}
        scrollerRef={scrollerRef}
        followOutput={() => followRef.current ? 'auto' : false}
        totalListHeightChanged={scrollToLatest}
        increaseViewportBy={400}
        itemContent={(_index, row) => <div className="agent-conversation-row">{renderRow(row)}</div>}
        components={components}
      />
    </FooterContext.Provider>
    {!following ? <button type="button" className="agent-scroll-latest" title="回到最新内容" aria-label="回到最新内容" onClick={() => { updateFollowing(true); scrollToLatest() }}><ArrowDown size={17} /></button> : null}
  </div>
}
