import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Layers3 } from 'lucide-react'
import type { SavedImageWorkflow } from '../lib/imageWorkflowStorage'
import { workflowDisplayName } from '../lib/imageWorkflowPresentation'

function FadingName({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setOverflow(element.scrollWidth > element.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [text])
  return <span ref={ref} className={`image-workflow-name${overflow ? ' is-overflowing' : ''}`} title={text}>{text}</span>
}

export default function ImageWorkflowSwitcher({ workflows, activeId, name, disabled, onSelect }: {
  workflows: SavedImageWorkflow[]; activeId: string; name: string; disabled: boolean; onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const entries = [
    ...(!activeId ? [{ id: '', name, nodes: [], edges: [], updatedAt: '' }] : []),
    ...workflows.map(item => ({ ...item, name: item.id === activeId ? name : workflowDisplayName(item.nodes, item.name) }))
  ]
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const show = (): void => {
    if (disabled) return
    setOpen(true)
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus())
  }
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside) }
  }, [open])
  return <div className="image-workflow-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (!open) { show(); return }
    const options = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[index]?.focus()
  }}>
    <button ref={trigger} className="image-workflow-picker-trigger" role="combobox" aria-label="已保存的工作流" aria-expanded={open} aria-haspopup="listbox" aria-controls={id} disabled={disabled} onClick={() => open ? close() : show()}>
      <span className="image-workflow-picker-icon"><Layers3 size={17} /></span>
      <span className="image-workflow-picker-title"><small>当前工作流</small><FadingName text={name} /></span>
      <ChevronDown size={14} className={open ? 'is-open' : undefined} />
    </button>
    {open ? <div className="image-workflow-picker-popover">
      <div className="image-workflow-picker-heading"><span>我的工作流</span><small>{workflows.length} 个已保存</small></div>
      <div id={id} role="listbox" aria-label="切换工作流" className="image-workflow-picker-list">
        {entries.map(item => {
          const thumbnail = item.nodes.find(node => node.data.outputAsset)?.data.outputAsset
          const resultCount = item.nodes.filter(node => node.data.outputAsset).length
          return <button key={item.id} type="button" role="option" aria-selected={item.id === activeId} tabIndex={-1} onClick={() => { close(); if (item.id && item.id !== activeId) onSelect(item.id) }}>
            <span className="image-workflow-picker-thumbnail">{thumbnail ? <img src={thumbnail.dataUrl} alt="" /> : <Layers3 size={18} />}</span>
            <span className="image-workflow-picker-option-text"><FadingName text={item.name} /><small>{item.id ? `${item.nodes.filter(node => node.data.kind !== 'output').length} 个节点 · ${resultCount} 张图片` : '当前画布 · 尚未保存'}</small></span>
            <Check size={15} className={item.id === activeId ? 'is-current' : 'is-hidden'} />
          </button>
        })}
      </div>
      <div className="image-workflow-picker-footer">随第一个提示词命名 · 切换时保存</div>
    </div> : null}
  </div>
}
