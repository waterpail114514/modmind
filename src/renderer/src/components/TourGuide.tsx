import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { TourStepDef } from '../pageGuides'

/**
 * 互动引导（聚光高亮步骤引导）：
 * - 每步高亮一个真实界面元素（target 选择器），镂空区域外的界面被遮罩挡住
 * - 镂空区域不做遮罩，用户可以真正点击被引导的元素，再按「下一步」继续
 * - 元素晚挂载（如先点开面板才出现的按钮）会自动重试检测；窗口/滚动变化实时重算
 * - 元素找不到时退化为居中提示卡，不会卡死引导
 */

const HOLE_PAD = 8
const EDGE = 12
const TIP_WIDTH = 320
const TIP_EST_HEIGHT = 200

type Placement = NonNullable<TourStepDef['placement']>
type Box = { top: number; left: number; width: number; height: number }
type TipPos = { top: number; left: number; placement: Placement }

function placeTip(box: Box | null, preferred: Placement, vw: number, vh: number): TipPos {
  if (!box) return { top: Math.round(vh / 2 - TIP_EST_HEIGHT / 2), left: Math.round(vw / 2 - TIP_WIDTH / 2), placement: preferred }
  const centerLeft = box.left + box.width / 2 - TIP_WIDTH / 2
  const candidates: Array<{ p: Placement; top: number; left: number; fits: boolean }> = [
    { p: 'bottom', top: box.top + box.height + HOLE_PAD + 10, left: centerLeft, fits: box.top + box.height + HOLE_PAD + 10 + TIP_EST_HEIGHT < vh - EDGE },
    { p: 'top', top: box.top - HOLE_PAD - 10 - TIP_EST_HEIGHT, left: centerLeft, fits: box.top - HOLE_PAD - 10 - TIP_EST_HEIGHT > EDGE },
    { p: 'right', top: box.top + box.height / 2 - TIP_EST_HEIGHT / 2, left: box.left + box.width + HOLE_PAD + 10, fits: box.left + box.width + HOLE_PAD + 10 + TIP_WIDTH < vw - EDGE },
    { p: 'left', top: box.top + box.height / 2 - TIP_EST_HEIGHT / 2, left: box.left - HOLE_PAD - 10 - TIP_WIDTH, fits: box.left - HOLE_PAD - 10 - TIP_WIDTH > EDGE }
  ]
  const order: Placement[] = [preferred, ...(['bottom', 'top', 'right', 'left'] as Placement[]).filter((p) => p !== preferred)]
  const chosen = candidates.find((c) => c.p === order[0] && c.fits) ?? candidates.find((c) => c.fits) ?? candidates[0]
  return {
    top: Math.round(Math.min(Math.max(EDGE, chosen.top), Math.max(EDGE, vh - TIP_EST_HEIGHT - EDGE))),
    left: Math.round(Math.min(Math.max(EDGE, chosen.left), Math.max(EDGE, vw - TIP_WIDTH - EDGE))),
    placement: chosen.p
  }
}

export function TourGuide({ steps, open, title = '互动引导', onFinish }: { steps: TourStepDef[]; open: boolean; title?: string; onFinish: () => void }): React.JSX.Element | null {
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  const step = steps[index]
  const measure = useCallback((): void => {
    if (!step) return
    const el = step.target ? document.querySelector(step.target) : null
    if (!el) {
      setBox(null)
      return
    }
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      setBox(null)
      return
    }
    setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
  }, [step])

  useEffect(() => {
    if (open) setIndex(0)
  }, [open])

  useEffect(() => {
    if (!open || !step) return
    measure()
    const el = step.target ? document.querySelector(step.target) : null
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      }
    }
    const timer = window.setInterval(measure, 240)
    const onResize = (): void => {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
      measure()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, index, measure, step])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onFinish()
      else if (event.key === 'ArrowRight' && index < steps.length - 1) setIndex((value) => value + 1)
      else if (event.key === 'ArrowLeft' && index > 0) setIndex((value) => value - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, index, steps.length, onFinish])

  if (!open || !step) return null

  const vw = viewport.w
  const vh = viewport.h
  const hole: Box | null = box ? { top: box.top - HOLE_PAD, left: box.left - HOLE_PAD, width: box.width + HOLE_PAD * 2, height: box.height + HOLE_PAD * 2 } : null
  const masks: CSSProperties[] = hole
    ? [
        { top: 0, left: 0, width: vw, height: Math.max(0, hole.top) },
        { top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height },
        { top: hole.top, left: hole.left + hole.width, width: Math.max(0, vw - hole.left - hole.width), height: hole.height },
        { top: hole.top + hole.height, left: 0, width: vw, height: Math.max(0, vh - hole.top - hole.height) }
      ]
    : [{ top: 0, left: 0, width: vw, height: vh }]
  const tip = placeTip(box, step.placement ?? 'bottom', vw, vh)

  return (
    <div role="dialog" aria-modal="true" aria-label={title}>
      {masks.map((style, i) => <div key={i} className="tour-mask" style={style} />)}
      {hole ? <div className="tour-ring" style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} /> : null}
      <div className={`tour-tip tour-tip-${tip.placement}`} style={{ top: tip.top, left: tip.left }} onClick={(event) => event.stopPropagation()}>
        <header>
          <span className="tour-tip-badge">{title}</span>
          <button className="bb-tool-button" type="button" title="跳过引导" aria-label="跳过引导" onClick={onFinish}><X size={14} /></button>
        </header>
        <div className="tour-tip-body">
          <span className="guide-step-index">{index + 1}</span>
          <div>
            <strong>{step.title}</strong>
            <span>{step.detail}</span>
          </div>
        </div>
        {!box ? <p className="tour-tip-missing">目标区域暂时没有显示，可点「上一步」先完成前面的操作，或直接点「下一步」继续。</p> : null}
        <footer>
          <div className="tour-tip-dots" aria-hidden="true">
            {steps.map((_, i) => <i key={i} className={i === index ? 'active' : ''} />)}
          </div>
          <div className="tour-tip-actions">
            <button className="guide-ghost-button" type="button" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={13} />上一步</button>
            <button className="guide-primary-button" type="button" onClick={() => (index < steps.length - 1 ? setIndex((value) => value + 1) : onFinish())}>
              {index < steps.length - 1 ? <>下一步<ChevronRight size={13} /></> : '完成'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
