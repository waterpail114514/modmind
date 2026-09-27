import { useId, useState, type ReactNode } from 'react'
import './workspace-tabs.css'

export default function WorkspaceTabs({ label, sections }: {
  label: string
  sections: Array<{ id: string; label: string; render: (active: boolean) => ReactNode }>
}): React.JSX.Element {
  const prefix = useId()
  const [selected, setSelected] = useState(sections[0].id)
  const [visited, setVisited] = useState(() => new Set([sections[0].id]))
  const select = (id: string): void => {
    setSelected(id)
    setVisited(current => new Set([...current, id]))
  }
  return <div className="workspace-tabs-layout">
    <div className="production-tabs workspace-tabs-nav" role="tablist" aria-label={label}>
      {sections.map((section, index) => <button key={section.id} type="button" role="tab"
        id={`${prefix}-tab-${section.id}`} aria-controls={`${prefix}-panel-${section.id}`}
        aria-selected={selected === section.id} tabIndex={selected === section.id ? 0 : -1}
        className={selected === section.id ? 'active' : ''} onClick={() => select(section.id)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length
          select(sections[next].id)
          document.getElementById(`${prefix}-tab-${sections[next].id}`)?.focus()
        }}>{section.label}</button>)}
    </div>
    {sections.map(section => <div key={section.id} className="workspace-tab-panel" role="tabpanel"
      id={`${prefix}-panel-${section.id}`} aria-labelledby={`${prefix}-tab-${section.id}`}
      hidden={selected !== section.id} tabIndex={0}>
      {visited.has(section.id) ? section.render(selected === section.id) : null}
    </div>)}
  </div>
}
