import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Box, Check, Image, Monitor, SlidersHorizontal, Terminal } from 'lucide-react'
import { WORKBENCH_FEATURES, type WorkbenchFeatures } from '../../../shared/workbenchFeatures'
import { useWorkbenchPopover } from '../useWorkbenchPopover'
import './workbench-feature-controls.css'

const icons = { renderedTesting: Monitor, headlessTesting: Terminal, imageGeneration: Image, modeling: Box }

export default function WorkbenchFeatureControls({ value, disabled, onChange }: {
  value: WorkbenchFeatures
  disabled: boolean
  onChange: (value: WorkbenchFeatures) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const selected = WORKBENCH_FEATURES.filter(({ id }) => value[id]).length
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
      surface.style.maxHeight = `${Math.max(80, anchor.top - 20)}px`
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
  return <div ref={root} className="workbench-feature-controls">
    <button ref={trigger} type="button" className={`agent-icon-button workbench-feature-trigger${open ? ' active' : ''}`} title={`制作功能（已选 ${selected}/${WORKBENCH_FEATURES.length}）`} aria-label="制作功能" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => setOpen(current => !current)}><SlidersHorizontal size={16} /></button>
    {open ? <div ref={panel} id={panelId} className="agent-picker-menu workbench-feature-menu" role="group" aria-label="制作功能">
      <div className="workbench-feature-heading"><span>制作功能</span><span>{selected}/{WORKBENCH_FEATURES.length}</span></div>
      {WORKBENCH_FEATURES.map(({ id, label }) => {
        const Icon = icons[id]
        return <button type="button" role="checkbox" aria-checked={value[id]} className={value[id] ? 'selected' : ''} key={id} disabled={disabled} onClick={() => onChange({ ...value, [id]: !value[id] })}><Icon size={16} aria-hidden="true" /><span>{label}</span><span className="workbench-feature-check" aria-hidden="true">{value[id] ? <Check size={15} strokeWidth={2.4} /> : null}</span></button>
      })}
    </div> : null}
  </div>
}
