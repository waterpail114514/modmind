import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, Copy, LoaderCircle, Plus, Save, Search, Trash2, Undo2 } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { SoundDefinition, SoundEvent, SoundVariant } from '../../../shared/soundLibrary'
import { reportClientFailure } from '../lib/clientFailure'
import { useConfirmDialog } from './InteractionDialogs'
import MoreActions from './MoreActions'

const blank: SoundDefinition = { sounds: [] }
const objectVariant = (raw: string | SoundVariant): SoundVariant => typeof raw === 'string' ? { name: raw } : raw
export default function SoundEventEditor({ projectPath, projectNamespace, onFilesChanged }: { projectPath: string; projectNamespace: string; onFilesChanged: () => void }): React.JSX.Element {
  const [events, setEvents] = useState<SoundEvent[]>([])
  const [selected, setSelected] = useState<SoundEvent | null>(null)
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  const [definition, setDefinition] = useState<SoundDefinition>(blank)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const { confirm, dialog } = useConfirmDialog()
  const api = window.modmind.production.sounds
  const draftKey = 'modmind.sound.event.' + projectPath
  const load = async (preferred?: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.list(projectPath, true)
      setEvents(result.events)
      if (preferred) {
        const next = result.events.find(item => item.key === preferred || item.namespace + ':' + item.id === preferred && item.editable)
        if (next) choose(next)
      }
    } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) }
  }
  useEffect(() => {
    void load()
    try {
      const saved = localStorage.getItem(draftKey)
      if (saved) { const value = JSON.parse(saved) as { selected: SoundEvent | null; name: string; namespace: string; definition: SoundDefinition }; if (value?.definition && Array.isArray(value.definition.sounds)) { setSelected(value.selected); setName(value.name); setNamespace(value.namespace); setDefinition(value.definition); setDirty(true); setNotice('已恢复未保存的事件草稿') } }
    } catch { localStorage.removeItem(draftKey) }
  }, [projectPath])
  useEffect(() => { if (dirty) try { localStorage.setItem(draftKey, JSON.stringify({ selected, name, namespace, definition })) } catch { /* Local recovery never blocks editing. */ } }, [dirty, selected, name, namespace, definition, draftKey])
  const choose = (event: SoundEvent | null): void => {
    localStorage.removeItem(draftKey); setSelected(event); setName(event?.id ?? ''); setNamespace(event?.namespace ?? projectNamespace); setDefinition(event ? structuredClone(event.definition) : { sounds: [] }); setDirty(false); setNotice('')
  }
  const select = async (event: SoundEvent): Promise<void> => {
    if (dirty && !await confirm({ title: '离开未保存的事件？', message: '当前修改尚未保存。', confirmLabel: '放弃修改' })) return
    choose(event)
  }
  const startNew = async (): Promise<void> => {
    if (dirty && !await confirm({ title: '离开未保存的事件？', message: '当前修改尚未保存。', confirmLabel: '放弃修改' })) return
    choose(null)
  }
  const change = (patch: Partial<SoundDefinition>): void => { setDefinition(current => ({ ...current, ...patch })); setDirty(true) }
  const variant = (index: number, patch: Partial<SoundVariant>): void => change({ sounds: definition.sounds.map((raw, offset) => offset === index ? { ...objectVariant(raw), ...patch } : raw) })
  const save = async (): Promise<void> => {
    setBusy(true); setNotice('')
    try {
      const target = namespace.trim() || 'minecraft'
      await api.saveEvent(projectPath, { ...(selected?.editable ? { key: selected.key, revision: selected.revision } : {}), id: name.trim(), namespace: target, definition })
      localStorage.removeItem(draftKey); setDirty(false); onFilesChanged(); await load(target + ':' + name.trim()); setNotice('事件已保存')
    } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!selected?.editable || !await confirm({ title: '删除声音事件', message: '将从 sounds.json 移除 ' + selected.id + '，音频文件会保留。', tone: 'danger', confirmLabel: '删除事件' })) return
    setBusy(true)
    try { await api.saveEvent(projectPath, { key: selected.key, id: selected.id, namespace: selected.namespace, revision: selected.revision, definition: selected.definition, remove: true }); choose(null); onFilesChanged(); await load(); setNotice('事件已删除，可从更多操作撤销') }
    catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) }
  }
  const undo = async (): Promise<void> => { setBusy(true); try { await api.undo(projectPath); choose(null); onFilesChanged(); await load(); setNotice('已撤销最近一次声音修改') } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) } }
  const filtered = useMemo(() => events.filter(item => (item.id + ' ' + item.namespace + ' ' + item.subtitle + ' ' + item.sourceLabel).toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.editable) - Number(a.editable) || a.id.localeCompare(b.id)), [events, query])
  return <div className="production-pane sound-event-pane authoring-workspace">
    <div className="sound-event-toolbar"><label className="sound-search"><Search size={15} /><span className="visually-hidden">查找事件</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="查找事件或字幕" /></label><button className="secondary-button compact" type="button" onClick={() => void startNew()}><Plus size={14} />新建事件</button><MoreActions label="事件更多操作"><button type="button" disabled={busy} onClick={() => void undo()}><Undo2 size={14} />撤销最近修改</button></MoreActions></div>
    <div className="sound-library-grid">
      <section className="sound-library-list" aria-label="事件列表"><div className="sound-library-list-heading">{filtered.length} 个事件</div><Virtuoso className="sound-library-items" data={filtered} itemContent={(_, item) => <button className={'sound-library-item ' + (selected?.key === item.key ? 'selected' : '')} type="button" onClick={() => void select(item)}><span className="sound-item-copy"><strong>{item.id}</strong><span>{item.sourceLabel} · {item.definition.sounds.length} 个变体</span></span></button>} /></section>
      <section className="sound-event-detail" aria-label="事件编辑"><div className="sound-detail-heading"><div><strong>{selected ? selected.id : '新事件'}</strong><span>{selected?.editable ? '项目事件' : selected ? '只读参照 · 保存为项目事件' : '项目声音事件'}</span></div>{selected && !selected.editable ? <button type="button" className="secondary-button compact" onClick={() => { setSelected(null); setNamespace(projectNamespace); setDirty(true) }}><Copy size={14} />复制到项目</button> : null}</div>
        <div className="sound-event-form"><div className="sound-event-fields"><label>命名空间<input value={namespace} onChange={event => { setNamespace(event.target.value); setDirty(true) }} placeholder="项目命名空间" /></label><label>事件 ID<input value={name} onChange={event => { setName(event.target.value); setDirty(true) }} placeholder="ambient/wind" /></label><label className="sound-wide-field">字幕键<input value={definition.subtitle ?? ''} onChange={event => change({ subtitle: event.target.value || undefined })} placeholder="subtitles.example.wind" /></label></div>
          <div className="sound-variant-heading"><strong>声音变体</strong><button className="secondary-button compact" type="button" onClick={() => change({ sounds: [...definition.sounds, { name: '', volume: 1, pitch: 1, weight: 1 }] })}><Plus size={14} />添加变体</button></div>
          <div className="sound-variant-list">{definition.sounds.map((raw, index) => { const item = objectVariant(raw); return <div className="sound-variant-row" key={index}><label>音频或事件引用<input value={item.name} onChange={event => variant(index, { name: event.target.value })} placeholder="namespace:path/to/sound" /></label><label>类型<select value={item.type === 'event' ? 'event' : 'file'} onChange={event => variant(index, { type: event.target.value as 'file' | 'event' })}><option value="file">音频</option><option value="event">事件</option></select></label><label>音量<input type="number" min={0} max={4} step={0.1} value={item.volume ?? 1} onChange={event => variant(index, { volume: Number(event.target.value) })} /></label><label>音调<input type="number" min={0.01} max={4} step={0.01} value={item.pitch ?? 1} onChange={event => variant(index, { pitch: Number(event.target.value) })} /></label><label>权重<input type="number" min={1} max={1000000} step={1} value={item.weight ?? 1} onChange={event => variant(index, { weight: Number(event.target.value) })} /></label><label className="sound-variant-check"><input type="checkbox" checked={Boolean(item.stream)} onChange={event => variant(index, { stream: event.target.checked })} />流式</label><button className="icon-button danger" type="button" title="移除变体" aria-label="移除变体" onClick={() => change({ sounds: definition.sounds.filter((_, offset) => offset !== index) })}><Trash2 size={15} /></button></div> })}</div>
        </div><div className="sound-event-footer">{selected?.editable ? <button type="button" className="secondary-button compact danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />删除事件</button> : <span />}{dirty ? <span className="sound-unsaved">未保存</span> : null}<button className="primary-button compact" type="button" disabled={busy || !name.trim() || !namespace.trim() || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存事件</button></div>{notice ? <div className="authoring-feedback" role={notice.includes('失败') || notice.includes('无效') ? 'alert' : 'status'}><CircleAlert size={14} />{notice}</div> : null}
      </section>
    </div>{dialog}
  </div>
}
