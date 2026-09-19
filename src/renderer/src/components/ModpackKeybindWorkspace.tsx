import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CircleAlert, FileCode2, Keyboard, LoaderCircle, MousePointer2, Plus, RefreshCw, RotateCcw, Save, Search, X } from 'lucide-react'
import type { ModpackKeybindState, ProjectInfo } from '../../../shared/types'

type BindingMap = Record<string, string>

const keyboardNames: Record<string, string> = {
  Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
  Home: 'home', End: 'end', PageUp: 'page.up', PageDown: 'page.down', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  ShiftLeft: 'left.shift', ShiftRight: 'right.shift', ControlLeft: 'left.control', ControlRight: 'right.control', AltLeft: 'left.alt', AltRight: 'right.alt',
  MetaLeft: 'left.win', MetaRight: 'right.win', CapsLock: 'caps.lock', NumLock: 'num.lock', ScrollLock: 'scroll.lock', PrintScreen: 'print.screen', Pause: 'pause',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'left.bracket', BracketRight: 'right.bracket', Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Comma: 'comma', Period: 'period', Slash: 'slash', Backquote: 'grave.accent'
}

const bindingLabels: Record<string, string> = {
  'key.keyboard.unknown': '未绑定', 'key.keyboard.space': '空格', 'key.keyboard.enter': '回车', 'key.keyboard.tab': 'Tab', 'key.keyboard.escape': 'Esc',
  'key.keyboard.backspace': '退格', 'key.keyboard.delete': 'Delete', 'key.keyboard.left.shift': '左 Shift', 'key.keyboard.right.shift': '右 Shift',
  'key.keyboard.left.control': '左 Ctrl', 'key.keyboard.right.control': '右 Ctrl', 'key.keyboard.left.alt': '左 Alt', 'key.keyboard.right.alt': '右 Alt',
  'key.keyboard.up': '上方向键', 'key.keyboard.down': '下方向键', 'key.keyboard.left': '左方向键', 'key.keyboard.right': '右方向键',
  'key.mouse.left': '鼠标左键', 'key.mouse.right': '鼠标右键', 'key.mouse.middle': '鼠标中键', 'key.mouse.4': '鼠标侧键 1', 'key.mouse.5': '鼠标侧键 2'
}

function errorMessage(error: unknown): string { return reportClientFailure(error) }

function actionLabel(action: string): string {
  return action.replace(/^key_/, '').split(/[._-]/).filter(Boolean).map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

function bindingLabel(binding: string): string {
  const normalized = binding.trim().toLowerCase()
  if (bindingLabels[normalized]) return bindingLabels[normalized]
  const mouse = normalized.match(/^key\.mouse\.(.+)$/)
  if (mouse) return `鼠标 ${mouse[1].replace(/^button\.?/, '')}`
  const keyboard = normalized.match(/^key\.keyboard\.(.+)$/)
  if (!keyboard) return binding || '未绑定'
  const key = keyboard[1]
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^f\d{1,2}$/.test(key) || /^\d$/.test(key)) return key.toUpperCase()
  return key.split('.').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

function keyboardBinding(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return `key.keyboard.${event.code.slice(3).toLowerCase()}`
  if (/^Digit\d$/.test(event.code)) return `key.keyboard.${event.code.slice(5)}`
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.code)) return `key.keyboard.${event.code.toLowerCase()}`
  const named = keyboardNames[event.code]
  return named ? `key.keyboard.${named}` : null
}

function mouseBinding(event: PointerEvent): string | null {
  return ({ 0: 'key.mouse.left', 1: 'key.mouse.middle', 2: 'key.mouse.right', 3: 'key.mouse.4', 4: 'key.mouse.5' })[event.button] ?? null
}

function conflictsFor(bindings: BindingMap): ModpackKeybindState['conflicts'] {
  const grouped = new Map<string, string[]>()
  Object.entries(bindings).forEach(([action, binding]) => {
    if (!binding || binding === 'key.keyboard.unknown') return
    const actions = grouped.get(binding) ?? []
    actions.push(action)
    grouped.set(binding, actions)
  })
  return [...grouped.entries()].filter(([, actions]) => actions.length > 1).map(([key, actions]) => ({ key, bindings: actions }))
}

export default function ModpackKeybindWorkspace({ project, onOpenRaw }: { project: ProjectInfo; onOpenRaw: (relativePath: string) => void }): React.JSX.Element {
  const [state, setState] = useState<ModpackKeybindState | null>(null)
  const [draft, setDraft] = useState<BindingMap>({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [onlyConflicts, setOnlyConflicts] = useState(false)
  const [allowConflicts, setAllowConflicts] = useState(false)
  const [recording, setRecording] = useState<string | null>(null)
  const [newAction, setNewAction] = useState('')

  const load = async (): Promise<void> => {
    setBusy('load')
    setNotice('')
    try {
      const next = await window.modmind.modpack.getKeybinds()
      setState(next)
      setDraft(next.bindings)
      setAllowConflicts(false)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load() }, [project.path])

  const conflicts = useMemo(() => conflictsFor(draft), [draft])
  const conflictActions = useMemo(() => new Set(conflicts.flatMap((conflict) => conflict.bindings)), [conflicts])
  const changedActions = useMemo(() => {
    const original = state?.bindings ?? {}
    return Object.keys(draft).filter((action) => draft[action] !== original[action])
  }, [draft, state?.bindings])
  const rows = useMemo(() => Object.entries(draft)
    .filter(([action]) => {
      const haystack = `${action} ${actionLabel(action)} ${draft[action]} ${bindingLabel(draft[action])}`.toLowerCase()
      return (!query.trim() || haystack.includes(query.trim().toLowerCase())) && (!onlyConflicts || conflictActions.has(action))
    })
    .sort(([left], [right]) => left.localeCompare(right)), [draft, query, onlyConflicts, conflictActions])

  const updateBinding = (action: string, binding: string): void => {
    setDraft((current) => ({ ...current, [action]: binding }))
    setRecording(null)
  }

  useEffect(() => {
    if (!recording) return
    const keyHandler = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') { event.preventDefault(); setRecording(null); return }
      const binding = keyboardBinding(event)
      if (!binding) return
      event.preventDefault()
      event.stopPropagation()
      updateBinding(recording, binding)
    }
    const pointerHandler = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a, label, [data-keybind-recording-control]')) return
      const binding = mouseBinding(event)
      if (!binding) return
      event.preventDefault()
      event.stopPropagation()
      updateBinding(recording, binding)
    }
    window.addEventListener('keydown', keyHandler, true)
    window.addEventListener('pointerdown', pointerHandler, true)
    return () => {
      window.removeEventListener('keydown', keyHandler, true)
      window.removeEventListener('pointerdown', pointerHandler, true)
    }
  }, [recording])

  const addAction = (): void => {
    const action = newAction.trim()
    if (!/^key_[A-Za-z0-9_.-]+$/.test(action)) { setNotice('动作标识应以 key_ 开头，只能包含字母、数字、点和连字符'); return }
    if (draft[action]) { setNotice('该动作已在列表中'); return }
    setDraft((current) => ({ ...current, [action]: 'key.keyboard.unknown' }))
    setNewAction('')
    setRecording(action)
  }

  const save = async (): Promise<void> => {
    if (!changedActions.length || busy) return
    setBusy('save')
    setNotice('')
    try {
      const bindings = Object.fromEntries(changedActions.map((action) => [action, draft[action]]))
      const result = await window.modmind.modpack.applyKeybindPreset({ id: 'player-defaults', name: '玩家预设', bindings }, allowConflicts) as { changed?: string[]; conflicts?: ModpackKeybindState['conflicts'] }
      await load()
      setNotice(result.conflicts?.length ? `已保存 ${result.changed?.length ?? 0} 项；保留 ${result.conflicts.length} 组冲突` : `已保存 ${result.changed?.length ?? 0} 项键位`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const reset = (): void => {
    setDraft(state?.bindings ?? {})
    setAllowConflicts(false)
    setRecording(null)
  }

  return <div className="keybind-workspace">
    <header className="content-toolbar keybind-toolbar">
      <h1 className="visually-hidden">玩家预设</h1>
      <div className="keybind-toolbar-actions"><span className={conflicts.length ? 'keybind-conflict-count warning' : 'keybind-conflict-count'}>{conflicts.length ? <AlertTriangle size={14} /> : <Keyboard size={14} />}{conflicts.length ? `${conflicts.length} 组冲突` : '无冲突'}</span><button className="icon-button" type="button" title="重新读取键位" aria-label="重新读取键位" disabled={Boolean(busy)} onClick={() => void load()}>{busy === 'load' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button><button className="secondary-button compact" type="button" disabled={!state?.path} onClick={() => state && onOpenRaw(state.path)}><FileCode2 size={14} />原文</button><button className="primary-button compact" type="button" disabled={!changedActions.length || Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存 {changedActions.length || ''}</button></div>
    </header>

    <section className="keybind-command-bar" aria-label="键位编辑工具">
      <label className="keybind-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索动作或按键" /></label>
      <label className="keybind-filter"><input type="checkbox" checked={onlyConflicts} onChange={(event) => setOnlyConflicts(event.target.checked)} />仅冲突</label>
      <label className="keybind-filter"><input type="checkbox" checked={allowConflicts} onChange={(event) => setAllowConflicts(event.target.checked)} />允许保存冲突</label>
      <button className="icon-button" type="button" title="放弃未保存修改" aria-label="放弃未保存修改" disabled={!changedActions.length || Boolean(busy)} onClick={reset}><RotateCcw size={15} /></button>
    </section>

    <section className="keybind-add-row">
      <Keyboard size={17} /><label><span>新动作</span><input value={newAction} onChange={(event) => setNewAction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addAction() }} placeholder="key_example.open" /></label><button className="secondary-button compact" type="button" disabled={Boolean(busy) || !newAction.trim()} onClick={addAction}><Plus size={14} />添加并录入</button>
    </section>

    {recording ? <div className="keybind-recording" role="status"><Keyboard size={17} /><span><strong>正在录入 {actionLabel(recording)}</strong><small>按键盘或鼠标按键，按 Esc 取消</small></span><button className="icon-button" data-keybind-recording-control type="button" title="取消录入" aria-label="取消录入" onClick={() => setRecording(null)}><X size={15} /></button></div> : null}

    <section className="keybind-table" aria-label="键位列表">
      <div className="keybind-row keybind-row-header"><span>动作</span><span>按键</span><span>状态</span><span /></div>
      {rows.map(([action, binding]) => <KeybindRow action={action} binding={binding} conflicted={conflictActions.has(action)} recording={recording === action} onRecord={() => setRecording(action)} onClear={() => updateBinding(action, 'key.keyboard.unknown')} key={action} />)}
      {!rows.length ? <div className="keybind-empty"><Keyboard size={24} /><div><strong>{Object.keys(draft).length ? '没有匹配的键位' : '还没有可编辑的键位'}</strong><small>{Object.keys(draft).length ? '调整搜索条件或显示全部键位' : '添加一个动作，或先在游戏运行后重新读取'}</small></div></div> : null}
    </section>
    {notice ? <div className="keybind-notice" role="status"><CircleAlert size={15} />{notice}</div> : null}
  </div>
}

function KeybindRow({ action, binding, conflicted, recording, onRecord, onClear }: { action: string; binding: string; conflicted: boolean; recording: boolean; onRecord: () => void; onClear: () => void }): React.JSX.Element {
  return <div className={`keybind-row${conflicted ? ' conflict' : ''}`}>
    <span className="keybind-action"><strong>{actionLabel(action)}</strong><small>{action}</small></span>
    <button type="button" className={`keybind-binding-button${recording ? ' recording' : ''}`} title={binding} onClick={onRecord}>{binding.startsWith('key.mouse.') ? <MousePointer2 size={15} /> : <Keyboard size={15} />}<span>{recording ? '按任意键' : bindingLabel(binding)}</span><small>{recording ? 'Esc 取消' : binding}</small></button>
    <span className={conflicted ? 'keybind-state conflict' : 'keybind-state'}>{conflicted ? <><AlertTriangle size={15} />冲突</> : '可用'}</span>
    <button className="icon-button" type="button" title="清除绑定" aria-label={`清除 ${actionLabel(action)} 的绑定`} onClick={onClear}><X size={15} /></button>
  </div>
}
