import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2, Undo2, type LucideIcon } from 'lucide-react'
import MoreActions from './MoreActions'
import { deleteSidebarCategory, emptySidebarLayout, moveSidebarCategory, moveSidebarEntry, UNGROUPED_SIDEBAR_KEY, type SidebarGroup, type SidebarLayout } from '../sidebarLayout'
import './sidebar-editor.css'

type EditorGroup = SidebarGroup<{ id: string; label: string; icon: LucideIcon }>

function CategoryName({ group, onRename }: { group: EditorGroup; onRename: (label: string) => boolean }): React.JSX.Element {
  const [name, setName] = useState(group.label)
  const [invalid, setInvalid] = useState(false)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => { setName(group.label); setInvalid(false); setEditing(false) }, [group.label])
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select() }
    else if (restoreFocus.current) { triggerRef.current?.focus(); restoreFocus.current = false }
  }, [editing])
  const commit = (): void => {
    if (name.trim() === group.label) { setName(group.label); setInvalid(false); setEditing(false); return }
    const saved = onRename(name)
    setInvalid(!saved)
    if (saved) setEditing(false)
  }
  if (!editing) return <button ref={triggerRef} className="sidebar-editor-name-trigger" type="button" title="重命名分类" aria-label={`重命名分类：${group.label}`} onClick={() => setEditing(true)}><span>{group.label}</span><Pencil size={13} aria-hidden="true" /></button>
  return <input ref={inputRef} className="sidebar-editor-name" aria-label={`分类名称：${group.label}`} title="回车保存，Esc 取消" maxLength={24} value={name} aria-invalid={invalid || undefined}
    onChange={event => { setName(event.target.value); setInvalid(false) }} onBlur={commit}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter') { event.preventDefault(); restoreFocus.current = true; commit() }
      if (event.key === 'Escape') { event.preventDefault(); restoreFocus.current = true; setName(group.label); setInvalid(false); setEditing(false) }
    }} />
}

export default function SidebarEditor({ groups, layout, scope, error, canUndo, onSave, onUndo, onRetry }: {
  groups: EditorGroup[]; layout: SidebarLayout; scope: string; error: string; canUndo: boolean
  onSave: (layout: SidebarLayout) => boolean; onUndo: () => void; onRetry: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState('')
  const [feedback, setFeedback] = useState('')
  const [invalidName, setInvalidName] = useState(false)
  const hidden = new Set(layout.hiddenItems)
  const save = (next: SidebarLayout, message = '已保存'): boolean => {
    const saved = onSave(next)
    if (saved) { setFeedback(message); setInvalidName(false) }
    return saved
  }
  const validateName = (value: string, except?: string): boolean => {
    if (!value.trim()) { setFeedback('请输入分类名称'); setInvalidName(true); return false }
    if (groups.some(group => group.groupKey !== except && group.label === value.trim())) { setFeedback('已有同名分类，请换一个名称'); setInvalidName(true); return false }
    return true
  }
  const setVisibility = (ids: string[], visible: boolean): void => {
    const next = new Set(hidden)
    for (const id of ids) { if (visible) next.delete(id); else next.add(id) }
    save({ ...layout, hiddenItems: [...next] })
  }
  return <div className="sidebar-editor">
    <div className="appearance-row sidebar-editor-heading"><strong>侧边栏</strong><button type="button" className="secondary-button compact" aria-expanded={expanded} aria-controls="sidebar-editor-content" onClick={() => setExpanded(value => !value)}>{expanded ? '收起编辑' : '编辑侧边栏'}</button></div>
    {(expanded || error) && <>
      {error && <div className="sidebar-editor-error" role="alert"><span>{error}</span><button type="button" className="secondary-button compact" onClick={onRetry}>重试</button></div>}
      {expanded && <div id="sidebar-editor-content">
        <div className="sidebar-editor-toolbar"><span className="sidebar-editor-scope">{scope}</span><div className="sidebar-editor-actions">
          <button className="sidebar-editor-icon" type="button" title="撤销上一步" aria-label="撤销上一步" disabled={!canUndo} onClick={() => { onUndo(); setFeedback(''); setInvalidName(false) }}><Undo2 size={16} /></button>
          <MoreActions label="侧边栏选项"><button type="button" onClick={() => save(emptySidebarLayout(), '已恢复默认布局，可撤销')}><RotateCcw size={16} />恢复默认布局</button></MoreActions>
        </div></div>
        <form className="sidebar-editor-create" onSubmit={event => {
          event.preventDefault()
          if (!validateName(name)) return
          const groupKey = `custom-${crypto.randomUUID()}`
          if (save({ ...layout, customGroups: [...layout.customGroups, { groupKey, label: name.trim() }] }, `已创建“${name.trim()}”`)) setName('')
        }}><input aria-label="新分类名称" placeholder="新分类名称" maxLength={24} value={name} onChange={event => { setName(event.target.value); setFeedback(''); setInvalidName(false) }} /><button type="submit" className="secondary-button compact"><Plus size={15} />新建分类</button></form>
        <div className={`sidebar-editor-feedback${invalidName ? ' invalid' : ''}`} role={invalidName ? 'alert' : 'status'}>{feedback || '更改即时生效；删除分类后，入口移到“未分类”。'}</div>
        <div className="sidebar-editor-groups">
          {groups.map((group, groupIndex) => <section className="sidebar-editor-group" key={group.groupKey} aria-label={`编辑分类：${group.label}`}>
            <div className="sidebar-editor-group-heading">
              <CategoryName group={group} onRename={value => validateName(value, group.groupKey) && save({ ...layout, labels: { ...layout.labels, [group.groupKey]: value.trim() } })} />
              <span className="sidebar-editor-count">{group.items.filter(item => !hidden.has(item.id)).length}/{group.items.length}</span>
              <div className="sidebar-editor-actions">
                <button type="button" className="sidebar-editor-icon" title="上移分类" aria-label={`上移分类：${group.label}`} disabled={groupIndex === 0} onClick={() => save(moveSidebarCategory(layout, groups, group.groupKey, groups[groupIndex - 1].groupKey))}><ArrowUp size={15} /></button>
                <button type="button" className="sidebar-editor-icon" title="下移分类" aria-label={`下移分类：${group.label}`} disabled={groupIndex === groups.length - 1} onClick={() => save(moveSidebarCategory(layout, groups, group.groupKey, groups[groupIndex + 1].groupKey, true))}><ArrowDown size={15} /></button>
                <MoreActions label={`分类选项：${group.label}`}>
                  <button type="button" disabled={!group.items.length} onClick={() => setVisibility(group.items.map(item => item.id), true)}>全部显示</button>
                  <button type="button" disabled={!group.items.length} onClick={() => setVisibility(group.items.map(item => item.id), false)}>全部隐藏</button>
                  {group.groupKey !== UNGROUPED_SIDEBAR_KEY && <button type="button" onClick={() => save(deleteSidebarCategory(layout, groups, group.groupKey), `已删除“${group.label}”，入口保留在未分类中，可撤销`)}><Trash2 size={15} />删除分类</button>}
                </MoreActions>
              </div>
            </div>
            {group.items.map((item, index) => <div className={`sidebar-editor-item${hidden.has(item.id) ? ' is-hidden' : ''}`} key={item.id}>
              <label className="sidebar-editor-item-label"><input type="checkbox" aria-label={`显示${item.label}`} checked={!hidden.has(item.id)} onChange={event => setVisibility([item.id], event.target.checked)} /><item.icon size={16} aria-hidden="true" /><span title={item.label}>{item.label}</span></label>
              <div className="sidebar-editor-item-controls">
                <select aria-label={`${item.label}所属分类`} value={group.groupKey} onChange={event => save(moveSidebarEntry(layout, groups, item.id, event.target.value))}>{groups.map(option => <option key={option.groupKey} value={option.groupKey}>{option.label}</option>)}</select>
                <button type="button" className="sidebar-editor-icon" title="上移入口" aria-label={`上移${item.label}`} disabled={index === 0} onClick={() => save(moveSidebarEntry(layout, groups, item.id, group.groupKey, group.items[index - 1].id))}><ArrowUp size={15} /></button>
                <button type="button" className="sidebar-editor-icon" title="下移入口" aria-label={`下移${item.label}`} disabled={index === group.items.length - 1} onClick={() => save(moveSidebarEntry(layout, groups, item.id, group.groupKey, group.items[index + 1].id, true))}><ArrowDown size={15} /></button>
              </div>
            </div>)}
            {!group.items.length && <p className="sidebar-editor-empty">从其他入口的分类菜单移入内容。</p>}
          </section>)}
        </div>
      </div>}
    </>}
  </div>
}
