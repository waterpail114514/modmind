import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { CatalogProvider } from './ModelCatalogRows'
import './model-provider-select.css'

export default function ModelProviderSelect({ providers, value, disabled, onChange }: {
  providers: CatalogProvider[]; value?: string; disabled?: boolean; onChange: (account: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null)
  const id = useId(), current = providers.find(provider => provider.account === value)
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  if (providers.length < 2) return <span className="model-provider-static" title={current?.label}>{current?.label ?? '暂无供应商'}</span>
  const searchQuery = query.trim().toLowerCase(), visible = providers.filter(provider => `${provider.label} ${provider.account}`.toLowerCase().includes(searchQuery))
  return <div className="model-provider-select" ref={root}>
    <button ref={trigger} type="button" className="model-provider-trigger" aria-label={`选择供应商：${current?.label ?? '请选择'}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} title={current?.label} onClick={() => { setQuery(''); setOpen(value => !value) }}><span>{current?.label ?? '选择供应商'}</span><ChevronDown size={12} /></button>
    {open ? <div className="model-provider-menu">
      <label className="model-provider-search"><Search size={13} /><input ref={search} type="search" aria-label="搜索供应商" placeholder="搜索供应商" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div id={id} role="listbox" aria-label="供应商" className="model-provider-options">{visible.map(provider => <button type="button" role="option" disabled={disabled} aria-selected={provider.account === value} aria-label={`供应商 ${provider.label}`} data-provider-account={provider.account} key={provider.account} title={provider.account} onClick={() => { onChange(provider.account); setOpen(false); trigger.current?.focus() }}><span>{provider.label}</span><small>{provider.billing === 'free' ? '免费' : '额度'}</small>{provider.account === value ? <Check size={13} /> : null}</button>)}{!visible.length ? <span className="model-provider-empty">没有匹配的供应商</span> : null}</div>
    </div> : null}
  </div>
}
