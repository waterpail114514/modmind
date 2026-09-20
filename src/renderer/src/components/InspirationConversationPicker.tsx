import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, MessagesSquare, Plus, Trash2 } from 'lucide-react'
import { useWorkbenchPopover } from '../useWorkbenchPopover'
import { formatConversationTime } from '../workbenchConversations'

export default function InspirationConversationPicker({ conversations, activeId, disabled, visible, onSelect, onNew, onDelete }: {
  conversations: { id: string; title: string; updatedAt: string }[]
  activeId: string
  disabled: boolean
  visible: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  useWorkbenchPopover(root, open, setOpen, '.inspiration-conversation-menu', '.agent-picker-trigger')
  useEffect(() => { if (disabled || !visible) setOpen(false) }, [disabled, visible])
  const close = (): void => {
    setOpen(false)
    root.current?.querySelector<HTMLButtonElement>('.agent-picker-trigger')?.focus()
  }
  return <div ref={root} className="inspiration-conversation-picker">
    <button type="button" className="agent-picker-trigger" aria-label="切换灵感对话" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <MessagesSquare size={14} /><span>{conversations.find(item => item.id === activeId)?.title ?? '历史对话'}</span><ChevronDown size={12} />
    </button>
    {open && <div id={id} className="agent-picker-menu inspiration-conversation-menu" role="group" aria-label="灵感对话" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
      <div className="inspiration-conversation-list">
        {conversations.map(conversation => <div key={conversation.id} className="inspiration-conversation-option"><button type="button" className={conversation.id === activeId ? 'active' : ''} aria-current={conversation.id === activeId ? 'true' : undefined} title={conversation.title} onClick={() => { onSelect(conversation.id); close() }}>
          <span>{conversation.title}</span><small>{formatConversationTime(conversation.updatedAt)}</small>{conversation.id === activeId && <Check size={13} />}
        </button><button type="button" className="inspiration-conversation-delete" aria-label={`删除对话：${conversation.title}`} title="删除历史对话" onClick={() => { close(); onDelete(conversation.id) }}><Trash2 size={14} /></button></div>)}
        {!conversations.length && <p className="agent-conversation-note">还没有历史对话</p>}
      </div>
      <button type="button" className="inspiration-conversation-new" onClick={() => { onNew(); close() }}><Plus size={14} /><span>新建对话</span></button>
    </div>}
  </div>
}
