import { ReplyImagesProvider } from './ReplyImages'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

const FooterContext = createContext<ReactNode>(null)

function ConversationFooter(): React.JSX.Element {
  return <>{useContext(FooterContext)}<div className="agent-conversation-bottom-space" aria-hidden="true" /></>
}

const components = { Footer: ConversationFooter }

export default function WorkbenchConversation<T extends { id: string }>({ rows, renderRow, isUserRow, footer, projectPath, surface = 'workbench' }: {
  projectPath?: string
  rows: T[]
  renderRow: (row: T) => ReactNode
  isUserRow: (row: T) => boolean
  footer?: ReactNode
  surface?: 'workbench' | 'inspiration'
}): React.JSX.Element {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const followRef = useRef(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const latestUserIndex = rows.reduce((index, row, nextIndex) => isUserRow(row) ? nextIndex : index, -1)
  const latestUserId = rows[latestUserIndex]?.id
  const latestUserRef = useRef(latestUserId)
  const userIndexRef = useRef(latestUserIndex)
  const anchorPromptRef = useRef(surface === 'inspiration' && latestUserIndex >= 0)
  const frame = useRef<number>()
  const updateFollowing = useCallback((value: boolean) => {
    if (followRef.current === value) return
    followRef.current = value
    setFollowing(value)
  }, [])
  const scrollToLatest = useCallback(() => {
    if ((!followRef.current && surface !== 'inspiration') || frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      if (!scroller || !scroller.clientHeight) return
      if (!followRef.current && surface !== 'inspiration') return
      const user = scroller.querySelector<HTMLElement>('[data-latest-user="true"]')
      const spacer = scroller.querySelector<HTMLElement>('.agent-conversation-bottom-space')
      // Short turns need enough space to align the prompt. Inspiration consumes
      // that space as the answer grows, leaving only a small bottom inset.
      const turnHeight = user && spacer ? spacer.getBoundingClientRect().top - user.getBoundingClientRect().top : scroller.clientHeight
      const space = Math.max(surface === 'inspiration' ? 24 : scroller.clientHeight / 2, scroller.clientHeight - turnHeight)
      scroller.style.setProperty('--agent-conversation-space', `${space}px`)
      if (!followRef.current) return
      if (surface === 'inspiration' && anchorPromptRef.current) {
        if (user) {
          scroller.scrollTo({ top: scroller.scrollTop + user.getBoundingClientRect().top - scroller.getBoundingClientRect().top, behavior: 'instant' })
        } else if (userIndexRef.current >= 0) {
          virtuosoRef.current?.scrollToIndex({ index: userIndexRef.current, align: 'start', behavior: 'auto' })
        }
      } else {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })
      }
    })
  }, [scroller, surface])
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null)
  }, [])

  useLayoutEffect(() => {
    const previousId = latestUserRef.current
    latestUserRef.current = latestUserId
    userIndexRef.current = latestUserIndex
    if (latestUserId && latestUserId !== previousId) {
      anchorPromptRef.current = surface === 'inspiration'
      updateFollowing(true)
    }
    scrollToLatest()
  }, [latestUserId, latestUserIndex, surface, scrollToLatest, updateFollowing])

  useEffect(() => {
    if (!scroller) return
    let touchY = 0
    const pause = (): void => { anchorPromptRef.current = false; updateFollowing(false) }
    const onWheel = (event: WheelEvent): void => { if (event.deltaY < 0 || (surface === 'inspiration' && event.deltaY !== 0)) pause() }
    const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? 0 }
    const onTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY ?? touchY
      if (nextY > touchY || (surface === 'inspiration' && nextY !== touchY)) pause()
      touchY = nextY
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause()
      if (surface === 'inspiration' && ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) pause()
    }
    const onPointerDown = (event: PointerEvent): void => {
      // Reading and opening historical steps take priority over output following.
      if (event.button === 0) pause()
    }
    const onScroll = (): void => {
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4) updateFollowing(true)
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
  }, [scroller, surface, scrollToLatest, updateFollowing])

  return <ReplyImagesProvider projectPath={projectPath}><div className="agent-conversation-region">
    <FooterContext.Provider value={footer}>
      <Virtuoso
        ref={virtuosoRef}
        className={surface === 'inspiration' ? 'inspiration-messages' : 'agent-conversation'}
        tabIndex={0}
        aria-label={surface === 'inspiration' ? '灵感台对话记录' : '工作台对话记录'}
        data={rows}
        computeItemKey={(_index, row) => row.id}
        initialTopMostItemIndex={surface === 'inspiration' && latestUserIndex >= 0 ? latestUserIndex : rows.length - 1}
        // A sampled long reply can otherwise be extrapolated to every unread
        // row, exceeding Chromium's scroll-height limit before measurement.
        defaultItemHeight={100}
        scrollerRef={scrollerRef}
        followOutput={() => followRef.current && !anchorPromptRef.current ? 'auto' : false}
        atBottomStateChange={setAtBottom}
        totalListHeightChanged={scrollToLatest}
        rangeChanged={scrollToLatest}
        increaseViewportBy={400}
        itemContent={(_index, row) => <div data-latest-user={row.id === latestUserId || undefined} className={surface === 'inspiration' ? 'inspiration-conversation-row' : 'agent-conversation-row'}>{renderRow(row)}</div>}
        components={components}
      />
    </FooterContext.Provider>
    {!following || (surface === 'inspiration' && !atBottom) ? <button type="button" className="agent-scroll-latest" title="回到最新内容" aria-label="回到最新内容" onClick={() => { anchorPromptRef.current = false; updateFollowing(true); scrollToLatest() }}><ArrowDown size={17} /></button> : null}
  </div></ReplyImagesProvider>
}
