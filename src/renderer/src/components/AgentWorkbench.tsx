/**
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from AionUi's ChatLayout, MessageList, MessageThinking,
 * ConversationPlanBar and SendBox. ModMind-specific project actions and event
 * adapters remain local.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  Archive,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Download,
  FileCode2,
  Gamepad2,
  History,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  UserRound
} from 'lucide-react'
import type {
  AgentSettings,
  AiAttachment,
  CodingBackend,
  AiPlan,
  AiRecoveryInfo,
  AiTokenUsage,
  BeginnerAiPreferences,
  BeginnerReasoningLevel,
  BeginnerTaskState,
  DeviceConnectionState,
  ProjectInfo
} from '../../../shared/types'
import AiAttachmentPicker from './AiAttachmentPicker'
import { useConfirmDialog } from './InteractionDialogs'
import { latestWorkbenchUsage, type WorkbenchTimelineItem } from '../workbenchTimeline'
import { formatConversationTime, isLegacyWorkbenchConversation, type WorkbenchConversation } from '../workbenchConversations'
import { workbenchElapsedSeconds } from '../workbenchElapsed'

export type AgentWorkbenchTimelineItem = WorkbenchTimelineItem

type TodoItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }
type TimelineRow = AgentWorkbenchTimelineItem | { id: string; kind: 'tool-group'; items: AgentWorkbenchTimelineItem[] }

type AgentWorkbenchProps = {
  project: ProjectInfo
  uiMode: 'beginner' | 'advanced'
  modpack: boolean
  prompt: string
  setPrompt: (value: string) => void
  attachments: AiAttachment[]
  setAttachments: (attachments: AiAttachment[]) => void
  planning: boolean
  taskState: BeginnerTaskState
  aiPlan: AiPlan | null
  aiTodo: TodoItem[]
  aiTimeline: AgentWorkbenchTimelineItem[]
  processingStartedAt?: string
  aiOutputStatus: 'idle' | 'running' | 'success' | 'error'
  aiRecovery: AiRecoveryInfo | null
  conversations: WorkbenchConversation[]
  activeConversationId: string
  onSelectConversation: (conversationId: string) => void
  onNewConversation: () => void
  onDeleteConversation: (conversationId: string) => void
  persistenceState?: 'loading' | 'ready' | 'saving' | 'saved' | 'degraded' | 'error'
  persistenceMessage?: string
  backend: AgentSettings['codingBackend']
  runningBackend?: CodingBackend
  switchingBackend?: CodingBackend | null
  onBackendChange: (backend: AgentSettings['codingBackend']) => void
  onStart: () => void
  onCancel: () => void
  onResume: () => void
  onDismissRecovery: () => void
  onRename: () => void
  onSnapshot: () => void
  onExport: () => void
  onExportServerPack: () => void
  onExportLogs: () => void
  onTest: () => void
  onAttachmentError: (error: unknown) => void
  canExportArtifact: boolean
  building: boolean
  deviceState?: DeviceConnectionState
  onOpenAccount?: () => void
  beginnerAiPreferences?: BeginnerAiPreferences
  beginnerAvailableModels?: Array<{ id: string }>
  scanningBeginnerModels?: boolean
  savingAiPreferences?: boolean
  beginnerModelScanMessage?: string
  onScanBeginnerModels?: () => void
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onFastModeChange?: (enabled: boolean) => void
  placeholder: string
  humanizeActivity: (value: string) => string
  onEditTimelineItem?: (id: string, content: string) => void
  onDeleteTimelineItem?: (id: string) => void
  onRewindTimelineTo?: (id: string) => void
}

function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  const renderer = new marked.Renderer()
  renderer.html = ({ text }) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  renderer.link = ({ href, text }) => {
    const safeText = text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
    if (!/^https?:\/\//i.test(href)) return safeText
    const safeHref = href.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeText}</a>`
  }
  const html = marked.parse(content, { async: false, gfm: true, breaks: true, renderer })
  return <div className="agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

function backendLabel(backend: AgentSettings['codingBackend']): string {
  return backend === 'quota' ? '智能引擎' : backend === 'codex' ? 'Codex' : 'Claude Code'
}

function backendIcon(backend: AgentSettings['codingBackend'], size = 14): React.JSX.Element {
  return backend === 'codex' ? <Code2 size={size} /> : <Sparkles size={size} />
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function contextUsage(usage: AiTokenUsage | undefined): { ratio: number; percent: number } | null {
  if (!usage?.contextWindow || !usage.inputTokens) return null
  const ratio = usage.inputTokens / usage.contextWindow
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return { ratio, percent: Math.min(100, Math.round(ratio * 100)) }
}

function ContextBadge({ usage }: { usage: AiTokenUsage | undefined }): React.JSX.Element | null {
  const state = contextUsage(usage)
  if (!state || !usage) return null
  const level = state.ratio > 0.92 ? 'critical' : state.ratio > 0.8 ? 'warning' : 'ok'
  const detail = [
    `输入 ${usage.inputTokens ?? 0}`,
    ...(usage.cachedInputTokens ? [`缓存 ${usage.cachedInputTokens}`] : []),
    `输出 ${usage.outputTokens ?? 0}`,
    `窗口 ${usage.contextWindow}`
  ].join(' · ')
  return (
    <span className={`agent-context-badge ${level}`} title={`本轮 Token 用量：${detail}${state.ratio > 0.8 ? '\n占用过高时建议新建对话' : ''}`}>
      <span>上下文 {state.percent}%</span>
      {state.ratio > 0.92 ? <em>建议新建对话</em> : null}
    </span>
  )
}

function groupTimeline(items: AgentWorkbenchTimelineItem[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const visibleThinking = new Set<string>()
  const isStepItem = (item: AgentWorkbenchTimelineItem): boolean => item.kind === 'tool'
    || item.kind === 'start'
    || item.kind === 'retry'
    || (item.kind === 'error' && item.terminal !== true)
    || (item.kind === 'warning' && item.terminal !== true)
  for (const item of items) {
    if (item.kind === 'thinking' && item.status !== 'running') {
      if (!visibleThinking.has(item.id)) {
        const previous = rows.at(-1)
        if (previous?.kind === 'tool-group') previous.items.push({ ...item, kind: 'tool' })
        else rows.push({ id: `tool-group-${item.id}`, kind: 'tool-group', items: [{ ...item, kind: 'tool' }] })
        visibleThinking.add(item.id)
      }
      continue
    }
    if (!isStepItem(item)) {
      rows.push(item)
      continue
    }
    const previous = rows.at(-1)
    if (previous?.kind === 'tool-group') previous.items.push(item)
    else rows.push({ id: `tool-group-${item.id}`, kind: 'tool-group', items: [item] })
  }
  return rows
}

function ThinkingItem({ item, content }: { item: AgentWorkbenchTimelineItem; content: string }): React.JSX.Element {
  const running = item.status === 'running'
  const [expanded, setExpanded] = useState(running)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) {
      setExpanded(false)
      return
    }
    const started = new Date(item.time).getTime()
    const update = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [item.time, running])
  const [title, ...detail] = content.split('\n')
  return <section className="agent-thinking">
    <button type="button" className="agent-disclosure-header" onClick={() => setExpanded((value) => !value)}>
      <span className="agent-disclosure-icon">{running ? <LoaderCircle className="spin" size={12} /> : <Brain size={14} />}</span>
      <span>{running ? `${title || '正在思考'} · ${elapsed}s` : '思考完成'}</span>
      <ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded && detail.length ? <div className="agent-disclosure-body">{detail.join('\n')}</div> : null}
  </section>
}

function ToolGroup({ items, humanizeActivity }: { items: AgentWorkbenchTimelineItem[]; humanizeActivity: (value: string) => string }): React.JSX.Element {
  const running = items.some((item) => item.status === 'running')
  const [expanded, setExpanded] = useState(running)
  useEffect(() => { if (running) setExpanded(true) }, [running])
  return <section className="agent-tool-group">
    <button type="button" className="agent-disclosure-header" onClick={() => setExpanded((value) => !value)}>
      <span className="agent-disclosure-icon">{running ? <LoaderCircle className="spin" size={12} /> : <ListChecks size={14} />}</span>
      <span>查看步骤{items.length ? ` · ${items.length}` : ''}</span>
      <ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded ? <div className="agent-tool-group-body">{items.map((item) => {
      const content = humanizeActivity(item.content)
      const [title, ...detail] = content.split('\n')
      return <div className="agent-tool-row" key={item.id}>
        <span className={`agent-tool-dot ${item.status ?? 'done'}`} />
        <div><strong>{title || '工具调用'}</strong>{detail.length ? <span>{detail.join(' ')}</span> : null}</div>
      </div>
    })}</div> : null}
  </section>
}

function TimelineItem({ item, humanizeActivity, onEdit, onDelete, onRewind }: { item: AgentWorkbenchTimelineItem; humanizeActivity: (value: string) => string; onEdit?: (id: string, content: string) => void; onDelete?: (id: string) => void; onRewind?: (id: string) => void }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(item.kind === 'error')
  const content = humanizeActivity(item.content)
  if (item.kind === 'user') return <article className="agent-message-row user"><div className="agent-message agent-message-user"><p>{content}</p></div>{(onEdit || onDelete || onRewind) ? <div className="agent-message-actions">{onEdit ? <button type="button" title="编辑并重新发送" aria-label="编辑并重新发送" onClick={() => onEdit(item.id, item.content)}><Pencil size={12} /></button> : null}{onDelete ? <button type="button" title="删除" aria-label="删除" onClick={() => onDelete(item.id)}><Trash2 size={12} /></button> : null}{onRewind ? <button type="button" title="回退到此处" aria-label="回退到此处" onClick={() => onRewind(item.id)}><Undo2 size={12} /></button> : null}</div> : null}<time>{formatTime(item.time)}</time></article>
  if (item.kind === 'thinking') return <ThinkingItem item={item} content={content} />
  if (item.kind === 'start' || item.kind === 'retry' || item.kind === 'history') return <div className="agent-event-muted"><Clock3 size={13} /><span>{content}</span></div>
  if (item.kind === 'diff') return <section className="agent-diff-card">
    <button type="button" className="agent-diff-heading" onClick={() => setExpanded((value) => !value)}><FileCode2 size={14} /><span>{item.diff?.length ?? 0} 个文件变更</span><ChevronRight className={expanded ? 'expanded' : ''} size={12} /></button>
    {expanded ? <div className="agent-diff-body">{item.diff?.map((file) => <div className="agent-diff-file" key={file.path}><code>{file.path}</code><span>+{file.added} -{file.removed}</span><pre>{[...file.additions.map((line) => `+ ${line}`), ...file.removals.map((line) => `- ${line}`)].join('\n')}</pre></div>)}</div> : null}
  </section>
  if (item.kind === 'answer' || item.kind === 'response') return content ? <article className="agent-message-row assistant"><div className="agent-message agent-message-assistant"><MarkdownMessage content={content} /></div>{(onDelete || onRewind) ? <div className="agent-message-actions">{onDelete ? <button type="button" title="删除" aria-label="删除" onClick={() => onDelete(item.id)}><Trash2 size={12} /></button> : null}{onRewind ? <button type="button" title="回退到此处" aria-label="回退到此处" onClick={() => onRewind(item.id)}><Undo2 size={12} /></button> : null}</div> : null}<time>{formatTime(item.time)}</time></article> : null
  if (item.kind === 'error' || item.kind === 'warning') {
    if (item.terminal !== true) return <div className="agent-event-muted"><CircleAlert size={13} /><span>{content}</span></div>
    return <div className={`agent-notice ${item.kind}`}><CircleAlert size={14} /><span>{content}</span></div>
  }
  return content ? <div className="agent-event-muted"><span>{content}</span></div> : null
}

function PlanBar({ todo }: { todo: TodoItem[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  if (!todo.length) return null
  const completed = todo.filter((item) => item.status === 'completed').length
  return <section className="agent-plan-bar">
    <button type="button" className="agent-plan-heading" onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="agent-plan-badge">计划</span><small>{completed}/{todo.length}</small></button>
    {expanded ? <div className="agent-plan-items">{todo.map((item) => <div key={item.id} className={`agent-plan-item ${item.status}`}><span>{item.status === 'completed' ? <Check size={12} /> : item.status === 'in_progress' ? <LoaderCircle className="spin" size={12} /> : null}</span><strong>{item.title}</strong></div>)}</div> : null}
  </section>
}

function ProcessingBar({ label, startedAt }: { label: string; startedAt?: string }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const fallbackStarted = Date.now()
    const update = (): void => setElapsed(workbenchElapsedSeconds(startedAt, Date.now()) ?? Math.max(0, Math.floor((Date.now() - fallbackStarted) / 1_000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <div className="agent-processing-bar"><LoaderCircle className="spin" size={14} /><span>{label}</span><small>({elapsed}s)</small></div>
}

function SettingsPopover({ props }: { props: AgentWorkbenchProps }): React.JSX.Element | null {
  const preferences = props.beginnerAiPreferences
  if (props.uiMode !== 'beginner' || !preferences) return null
  const models = props.beginnerAvailableModels ?? []
  return <div className="agent-settings-popover"><div className="agent-settings-row"><strong>模型</strong><div><select value={preferences.model} disabled={props.savingAiPreferences} onChange={(event) => props.onModelChange?.(event.target.value)}>{models.some((model) => model.id === preferences.model) ? null : <option value={preferences.model}>{preferences.model}</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select><button type="button" className="agent-icon-button" title="刷新模型" disabled={props.scanningBeginnerModels || props.savingAiPreferences} onClick={props.onScanBeginnerModels}>{props.scanningBeginnerModels ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}</button></div></div><div className="agent-settings-row"><strong>思考强度</strong><div className="agent-segmented">{([['low', '低'], ['medium', '中'], ['high', '高'], ['extreme', '极高']] as const).map(([value, label]) => <button type="button" key={value} className={preferences.reasoningLevel === value ? 'active' : ''} disabled={props.savingAiPreferences} onClick={() => props.onReasoningLevelChange?.(value)}>{label}</button>)}</div></div><label className="agent-settings-switch"><span>快速响应</span><input type="checkbox" checked={preferences.fastMode} disabled={props.savingAiPreferences} onChange={(event) => props.onFastModeChange?.(event.target.checked)} /></label>{props.beginnerModelScanMessage ? <small>{props.beginnerModelScanMessage}</small> : null}</div>
}

export default function AgentWorkbench(props: AgentWorkbenchProps): React.JSX.Element {
  const { project, modpack, planning, taskState, aiTimeline, aiTodo, aiPlan } = props
  const effectiveBackend: AgentSettings['codingBackend'] = props.uiMode === 'beginner' ? 'quota' : (props.runningBackend ?? props.backend)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false)
  const { confirm: confirmConversationDelete, dialog: conversationDeleteDialog } = useConfirmDialog()
  const requestConversationDelete = (conversation: WorkbenchConversation): void => {
    if (conversationPickerOpen) setConversationPickerOpen(false)
    void confirmConversationDelete({
      title: `删除对话「${conversation.title}」？`,
      message: '该对话的时间线和运行记录会一并删除，无法恢复',
      confirmLabel: '删除对话',
      tone: 'danger'
    }).then((confirmed) => {
      if (confirmed) props.onDeleteConversation(conversation.id)
    })
  }
  const [followBottom, setFollowBottom] = useState(true)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const displayedTimeline = useMemo(() => aiTimeline, [aiTimeline])
  const timelineRows = useMemo(() => groupTimeline(displayedTimeline), [displayedTimeline])
  const hasLiveThinking = displayedTimeline.some((item) => item.kind === 'thinking' && item.status === 'running')
  const canExport = props.canExportArtifact && !planning && !props.building
  useEffect(() => {
    if (!conversationPickerOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.agent-conversation-picker')) return
      setConversationPickerOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [conversationPickerOpen])
  useEffect(() => {
    const element = timelineRef.current
    if (!element || !followBottom) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [timelineRows, followBottom])
  const handleScroll = (): void => {
    const element = timelineRef.current
    if (!element) return
    setFollowBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 36)
  }

  return <div className="agent-workbench">
    <header className="agent-workbench-header">
      <div className="agent-workbench-title"><span className="agent-title-icon">{backendIcon(effectiveBackend, 17)}</span><h1>{project.name}</h1><button type="button" className="agent-title-edit" title="重命名项目" aria-label="重命名项目" onClick={props.onRename}><Pencil size={13} /></button></div>
      <div className="agent-workbench-actions">
        <span className={`agent-persistence-status ${props.persistenceState ?? 'ready'}`} title={props.persistenceMessage}>{props.persistenceState === 'saving' ? <LoaderCircle className="spin" size={12} /> : props.persistenceState === 'error' ? <CircleAlert size={12} /> : <Check size={12} />}<span>{props.persistenceMessage ?? '已保存'}</span></span>
        <div className="agent-conversation-picker">
          <button type="button" className="agent-picker-trigger" aria-expanded={conversationPickerOpen} title={props.planning ? '任务运行中不能切换对话' : '多对话（Beta）：切换、新建或删除对话'} disabled={props.planning} onClick={() => setConversationPickerOpen((value) => !value)}><MessagesSquare size={14} /><span>{props.conversations.find((item) => item.id === props.activeConversationId)?.title ?? '选择对话'}</span><em className="agent-beta-tag">Beta</em>{props.conversations.length > 1 ? <small>{props.conversations.length}</small> : null}<ChevronDown size={12} /></button>
          {conversationPickerOpen ? <div className="agent-picker-menu agent-conversation-menu">
            <p className="agent-conversation-note">多对话为 Beta 功能；各对话共享同一项目文件，删除后其历史记录无法恢复。</p>
            {props.conversations.map((conversation) => {
              const original = isLegacyWorkbenchConversation(conversation)
              return <div key={conversation.id} className={`agent-conversation-item ${conversation.id === props.activeConversationId ? 'active' : ''}`}>
                <button type="button" className="agent-conversation-select" onClick={() => { props.onSelectConversation(conversation.id); setConversationPickerOpen(false) }}><span>{conversation.title}</span>{original ? <em title="升级前的对话，与旧版本完全一致">原始</em> : null}<small className="agent-conversation-time">{formatConversationTime(conversation.updatedAt)}</small></button>
                {props.conversations.length > 1 ? <button type="button" className="agent-conversation-delete" title="删除对话" aria-label={`删除对话 ${conversation.title}`} onClick={() => requestConversationDelete(conversation)}><Trash2 size={13} /></button> : null}
              </div>
            })}
            <button type="button" className="agent-conversation-new" disabled={props.planning} onClick={() => { props.onNewConversation(); setConversationPickerOpen(false) }}><Plus size={13} /><span>新建对话</span></button>
          </div> : null}
        </div>
        <div className="agent-picker"><button type="button" className="agent-picker-trigger" aria-expanded={agentPickerOpen} onClick={() => props.uiMode === 'advanced' && setAgentPickerOpen((value) => !value)}>{props.switchingBackend ? <LoaderCircle className="spin" size={14} /> : backendIcon(effectiveBackend)}<span>{props.switchingBackend ? `正在切换到 ${backendLabel(props.switchingBackend)}` : backendLabel(effectiveBackend)}</span>{props.uiMode === 'advanced' ? <ChevronDown size={12} /> : null}</button>{agentPickerOpen ? <div className="agent-picker-menu">{(['quota', 'codex', 'claude'] as const).map((backend) => <button type="button" className={(props.runningBackend ?? props.backend) === backend ? 'active' : ''} key={backend} onClick={() => { props.onBackendChange(backend); setAgentPickerOpen(false) }}>{backendIcon(backend)}<span>{backendLabel(backend)}</span>{(props.runningBackend ?? props.backend) === backend ? <Check size={13} /> : null}</button>)}</div> : null}</div>
        <button type="button" className="agent-icon-button" title="保存版本" aria-label="保存版本" onClick={props.onSnapshot}><History size={15} /></button>
        <button type="button" className="agent-icon-button" title="导出成品" aria-label="导出成品" disabled={!canExport} onClick={props.onExport}><Download size={15} /></button>
        {modpack ? <button type="button" className="agent-icon-button" title="导出服务端包" aria-label="导出服务端包" disabled={planning || props.building} onClick={props.onExportServerPack}><Archive size={15} /></button> : null}
        {props.uiMode === 'beginner' ? <button type="button" className="agent-icon-button agent-account-button" title="账号与远程设置" aria-label="账号与远程设置" onClick={props.onOpenAccount}><UserRound size={15} /><span className={`agent-account-dot ${props.deviceState?.status === 'connected' ? 'connected' : ''}`} /></button> : null}
      </div>
    </header>

    {props.aiRecovery ? <section className="agent-recovery-banner"><CircleAlert size={16} /><div><strong>发现未完成任务</strong><span>恢复点已保存{props.aiRecovery.backend ? `，将使用 ${backendLabel(props.aiRecovery.backend)} 继续` : ''}。</span></div><button type="button" className="agent-text-button" disabled={planning} onClick={props.onDismissRecovery}>稍后</button><button type="button" className="agent-primary-button" disabled={planning} onClick={props.onResume}>{planning ? <LoaderCircle className="spin" size={13} /> : null}继续</button></section> : null}

    <div ref={timelineRef} className="agent-conversation" onScroll={handleScroll}><div className="agent-conversation-surface">
      {timelineRows.length ? timelineRows.map((row) => row.kind === 'tool-group' ? <ToolGroup key={row.id} items={row.items} humanizeActivity={props.humanizeActivity} /> : <TimelineItem key={row.id} item={row} humanizeActivity={props.humanizeActivity} onEdit={!planning ? props.onEditTimelineItem : undefined} onDelete={!planning ? props.onDeleteTimelineItem : undefined} onRewind={!planning ? props.onRewindTimelineTo : undefined} />) : <div className="agent-empty"><span className="agent-empty-avatar">{backendIcon(effectiveBackend, 24)}</span><strong>{backendLabel(effectiveBackend)}</strong><span>有什么我可以帮助你的？</span></div>}
      {taskState === 'success' && aiPlan ? <div className="agent-result-actions"><button type="button" className="agent-secondary-button" onClick={props.onTest}><Gamepad2 size={14} />进入游戏测试</button>{props.canExportArtifact ? <button type="button" className="agent-secondary-button" onClick={props.onExport}><Download size={14} />导出</button> : null}</div> : null}
    </div></div>

    <div className="agent-composer-stack">
      {planning ? <PlanBar todo={aiTodo} /> : null}
      {planning && !hasLiveThinking ? <ProcessingBar label="正在处理" startedAt={props.processingStartedAt} /> : null}
      {settingsOpen ? <SettingsPopover props={props} /> : null}
      <footer className="agent-composer">
        <textarea value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.ctrlKey || event.metaKey) { if (event.key === 'Enter' && !planning) { event.preventDefault(); const textarea = event.currentTarget; const start = textarea.selectionStart; const end = textarea.selectionEnd; props.setPrompt(`${props.prompt.slice(0, start)}\n${props.prompt.slice(end)}`); window.requestAnimationFrame(() => textarea.setSelectionRange(start + 1, start + 1)) } return } if (event.key === 'Enter' && !planning && (props.prompt.trim() || props.attachments.length)) { event.preventDefault(); props.onStart() } }} placeholder={props.placeholder} disabled={planning} rows={2} />
        <div className="agent-composer-toolbar"><div className="agent-composer-tools"><AiAttachmentPicker attachments={props.attachments} onChange={props.setAttachments} disabled={planning} onError={props.onAttachmentError} /><ContextBadge usage={latestWorkbenchUsage(aiTimeline)} /></div><div className="agent-composer-actions">{props.uiMode === 'beginner' ? <button type="button" className="agent-mode-pill" onClick={() => setSettingsOpen((value) => !value)}><Settings size={14} /><span>制作设置</span><ChevronDown size={12} /></button> : null}{planning ? <button type="button" className="agent-send-button stop" title="停止任务" aria-label="停止任务" onClick={props.onCancel}><Square size={14} fill="currentColor" /></button> : <button type="button" className="agent-send-button" title="发送" aria-label="发送" disabled={!props.prompt.trim() && !props.attachments.length} onClick={props.onStart}><ArrowUp size={17} strokeWidth={2.7} /></button>}</div></div>
      </footer>
      {props.aiOutputStatus === 'error' && !planning ? <div className="agent-error-footer"><CircleAlert size={14} /><span>任务没有完成，详细信息已保留</span><button type="button" className="agent-text-button" onClick={props.onExportLogs}>导出诊断</button></div> : null}
    </div>

    {conversationDeleteDialog}
  </div>
}
