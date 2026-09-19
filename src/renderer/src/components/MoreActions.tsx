import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

/** Secondary actions remain available without competing with the primary task. */
export default function MoreActions({ children, label = '更多操作', text, icon = <MoreHorizontal size={17} /> }: { children: ReactNode; label?: string; text?: string; icon?: ReactNode }): React.JSX.Element {
  const root = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && root.current) root.current.open = false
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !root.current?.open) return
      event.preventDefault()
      root.current.open = false
      root.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return <details ref={root} className="more-actions" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={label} title={label} aria-expanded={open} aria-controls={id}>{icon}{text && <span>{text}</span>}</summary>
    <div id={id} className="more-actions-panel" role="group" aria-label={label} onClick={event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null
      if (!button || button.disabled || !root.current) return
      root.current.open = false
      root.current.querySelector('summary')?.focus()
    }}>{Children.map(children, child => {
      if (!isValidElement<{ title?: string; children?: ReactNode }>(child) || child.type !== 'button' || !child.props.title) return child
      const hasLabel = Children.toArray(child.props.children).some(content => typeof content === 'string' && content.trim())
      return hasLabel ? child : cloneElement(child, {}, child.props.children, <span>{child.props.title}</span>)
    })}</div>
  </details>
}
