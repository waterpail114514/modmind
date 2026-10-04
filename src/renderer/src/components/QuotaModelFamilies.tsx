import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export default function QuotaModelFamilies({ animated, children }: { animated: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  const update = useCallback((animate: boolean) => {
    const group = root.current, highlight = indicator.current
    if (!group || !highlight) return
    const selected = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    if (!selected) { highlight.style.opacity = '0'; return }
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = selected
    const clip = `inset(${top}px ${Math.max(0, group.clientWidth - left - width)}px ${Math.max(0, group.clientHeight - top - height)}px ${left}px round 5px)`
    if (highlight.style.clipPath === clip && highlight.style.opacity === '1') return
    // Resize and keyboard selection snap to their new geometry. Pointer changes
    // use a CSS transition that can retarget midway through a previous selection.
    if (!animate) highlight.style.transition = 'none'
    highlight.style.clipPath = clip
    highlight.style.opacity = '1'
    if (!animate) {
      void getComputedStyle(highlight).clipPath
      highlight.style.transition = ''
    }
  }, [])

  useLayoutEffect(() => { update(animated) }, [animated, children, update])
  useLayoutEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(() => update(false))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [update])

  return <div className="quota-model-families" role="group" aria-label="模型家族" ref={root}>
    <span className="quota-model-family-indicator" aria-hidden="true" ref={indicator} />
    {children}
  </div>
}
