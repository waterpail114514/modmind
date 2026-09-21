import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, SlidersHorizontal, ChevronDown } from 'lucide-react'
import { INSPIRATION_FEATURES, type InspirationFeatures } from '../../../shared/inspirationFeatures'
import { useWorkbenchPopover } from '../useWorkbenchPopover'
import './workbench-feature-controls.css'



export default function InspirationFeatureControls({ value, disabled, onChange }: {
  value: InspirationFeatures
  disabled: boolean
  onChange: (value: InspirationFeatures) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const selected = INSPIRATION_FEATURES.filter(({ id }) => value[id]).length
  useWorkbenchPopover(root, open, setOpen, '.workbench-feature-menu', '.workbench-feature-trigger')
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return
    const surface = panel.current
    // The top layer keeps the upward picker clear of the conversation's clipping container.
    surface.setAttribute('popover', 'manual')
    surface.showPopover()
    const position = (): void => {
      const anchor = trigger.current!.getBoundingClientRect()
      surface.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - surface.offsetWidth - 12))}px`
      surface.style.bottom = `${window.innerHeight - anchor.top + 8}px`
      surface.style.maxHeight = `${Math.max(80, Math.min(480, anchor.top - 20))}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      surface.hidePopover()
    }
  }, [open])
  return <div ref={root} className="workbench-feature-controls inspiration-feature-controls">
    <button ref={trigger} type="button" className={`agent-icon-button workbench-feature-trigger inspiration-feature-trigger${open ? ' active' : ''}`} title={`分析功能（已选 ${selected}/${INSPIRATION_FEATURES.length}）`} aria-label="分析功能" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => setOpen(current => !current)}><SlidersHorizontal size={15} /><span>分析功能{selected ? ` · ${selected}` : ''}</span><ChevronDown size={12} /></button>
    {open ? <div ref={panel} id={panelId} className="agent-picker-menu workbench-feature-menu inspiration-feature-menu" role="group" aria-label="分析功能">
      <div className="workbench-feature-heading"><span>分析功能</span><span>{selected}/{INSPIRATION_FEATURES.length}</span></div>

      {INSPIRATION_FEATURES.map(({ id, label }) => {
        return <button type="button" role="checkbox" aria-checked={value[id]} className={value[id] ? 'selected' : ''} key={id} disabled={disabled} onClick={() => onChange({ ...value, [id]: !value[id] })}><span>{label}</span><span className="workbench-feature-check" aria-hidden="true">{value[id] ? <Check size={15} strokeWidth={2.4} /> : null}</span></button>
      })}
    </div> : null}
  </div>
}
