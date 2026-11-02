import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Search, X } from 'lucide-react'
import type { DataPackItem } from '../../../src/shared/dataPack'
import GameResourceSources from '../../sdk/GameResourceSources'

export default function ItemPicker({ projectPath, value, onSelect, onClose }: { projectPath: string; value: string; onSelect: (value: string) => void; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(''), [id, setId] = useState(value), [items, setItems] = useState<DataPackItem[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [sources, setSources] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { dialog.current?.showModal(); search.current?.focus() }, [])
  useEffect(() => {
    let active = true; setLoading(true); setError('')
    const timer = setTimeout(() => { void window.modmind.featurePlugins.invoke('data-packs', 'catalog', { projectPath, query, offset, limit: 48 }).then(value => {
      if (!active) return
      const result = value as { items: DataPackItem[]; total: number; warning: string }; setItems(result.items); setTotal(result.total); if (!result.total) setError(result.warning)
    }).catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setLoading(false) }) }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [projectPath, query, offset, revision])
  const valid = /^#?(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(id)
  return <dialog ref={dialog} className="dialog dp-item-picker" onCancel={onClose} aria-labelledby="dp-item-title">
    <div className="dp-dialog-heading"><h2 id="dp-item-title">选择物品或标签</h2><button className="icon-button" aria-label="关闭物品选择" onClick={onClose}><X size={18} /></button></div>
    <div className="dp-picker-search"><Search size={16} /><input ref={search} aria-label="搜索物品" placeholder="搜索名称或 ID" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} /><button className="secondary-button" onClick={() => setSources(true)}>资源来源</button></div>
    <div className="dp-picker-items" aria-busy={loading}>{loading ? <div className="dp-picker-loading"><LoaderCircle className="spin" size={18} />读取目录…</div> : items.map(item => <button key={item.id} title={item.id} className={id === item.id ? 'selected' : ''} onClick={() => setId(item.id)} onDoubleClick={() => { onSelect(item.id); onClose() }}>{item.icon ? <img src={item.icon} alt="" className="dp-picker-icon" /> : null}<span>{item.name}</span><small>{item.id}</small>{id === item.id ? <Check size={14} /> : null}</button>)}</div>
    <div className="dp-pagination"><span>{total} 项</span><button className="secondary-button" disabled={loading || !offset} onClick={() => setOffset(n => Math.max(0, n - 48))}>上一页</button><button className="secondary-button" disabled={loading || offset + 48 >= total} onClick={() => setOffset(n => n + 48)}>下一页</button></div>
    {error ? <div role="status" className="dp-inline-notice">{error}<button onClick={() => setRevision(n => n + 1)}>重试</button></div> : null}
    <form onSubmit={event => { event.preventDefault(); if (valid) { onSelect(id.includes(':') ? id : id.startsWith('#') ? '#minecraft:' + id.slice(1) : 'minecraft:' + id); onClose() } }}><label className="dp-picker-id">物品或标签 ID<input aria-label="物品或标签 ID" value={id} onChange={event => setId(event.target.value)} placeholder="minecraft:stone 或 #minecraft:logs" /></label><div className="dp-picker-footer"><button type="button" className="secondary-button" onClick={() => { onSelect(''); onClose() }}>清空</button><button type="submit" className="primary-button" disabled={!valid}>使用所选内容</button></div></form>
    {sources ? <GameResourceSources featureId="data-packs" actionPrefix="source:" projectPath={projectPath} onChanged={() => { setOffset(0); setRevision(n => n + 1) }} onClose={() => setSources(false)} /> : null}
  </dialog>
}
