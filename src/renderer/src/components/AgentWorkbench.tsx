import ContextUsage from './ContextUsage'
import ReasoningControl from './ReasoningControl'
import type { AiModelInfo } from '../../../shared/types'
import WorkbenchApprovalDialog from './WorkbenchApprovalDialog'
import { useAiAttachments } from '../useAiAttachments'
import MoreActions from './MoreActions'
import TurnCompletionCard, { isTurnCompletion } from './TurnCompletionCard'
import { AiNoticeDetails } from './AiNoticeDetails'
import WorkbenchFeatureControls from './WorkbenchFeatureControls'
import ProjectKnowledgeButton from './ProjectKnowledgeButton'
import type { WorkbenchFeatures } from '../../../shared/workbenchFeatures'
/**
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from AionUi's ChatLayout, MessageList, MessageThinking,
 * ConversationPlanBar and SendBox. ModMind-specific project actions and event
 * adapters remain local.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ReplyMarkdown } from './ReplyImages'
import { useWorkbenchPopover } from '../useWorkbenchPopover'
import WorkbenchConversation from './WorkbenchConversation'
import PagedSteps from './PagedSteps'
import ChatWelcome, { ChatRecommendations } from './ChatWelcome'
import QuotaPreferenceControls from './QuotaPreferenceControls'
import { selectedReasoningEfforts } from '../../../shared/modelReasoning'
import modmindLogo from '../assets/logo.png'
import AgentBrandIcon from './AgentBrandIcon'
import DiscussionChoiceCards from './DiscussionChoiceCards'
import { splitDiscussionChoices, type DiscussionChoice } from '../../../shared/discussionChoices'
import '../minimal-workbench.css'
import { recoveryBelongsToConversation } from '../../../shared/aiSession'
import {
  Archive,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileCode2,
  Gamepad2,
  History,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  Pin,
  PinOff,
  Pencil,
  Plus,
  Settings,
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
import { formatConversationTime, isLegacyWorkbenchConversation, type WorkbenchConversation as WorkbenchConversationInfo } from '../workbenchConversations'
import { workbenchElapsedSeconds } from '../workbenchElapsed'

export type AgentWorkbenchTimelineItem = WorkbenchTimelineItem

type TodoItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }
type TimelineRow = (AgentWorkbenchTimelineItem & { separateAnswer?: boolean }) | { id: string; kind: 'tool-group'; items: AgentWorkbenchTimelineItem[] }

export type AgentWorkbenchProps = {
  onOpenChangedFile?: (path: string) => void
  project: ProjectInfo
  uiMode: 'beginner' | 'advanced'
  presentation?: 'minimal' | 'full'
  onUiModeChange?: (mode: 'beginner' | 'advanced') => void
  modpack: boolean
  prompt: string
  setPrompt: (value: string) => void
  attachments: AiAttachment[]
  setAttachments: (attachments: AiAttachment[]) => void
  planning: boolean
  taskState: BeginnerTaskState
  aiPlan: (AiPlan & { intent?: 'engineering' | 'informational' }) | null
  aiTodo: TodoItem[]
  aiTimeline: AgentWorkbenchTimelineItem[]
  processingStartedAt?: string
  aiOutputStatus: 'idle' | 'running' | 'success' | 'error'
  aiRecovery: AiRecoveryInfo | null
  conversations: WorkbenchConversationInfo[]
  activeConversationId: string
  onSelectConversation: (conversationId: string) => void
  onNewConversation: () => void
  onDeleteConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string) => void
  onTogglePinConversation: (conversationId: string) => void
  persistenceState?: 'loading' | 'ready' | 'saving' | 'saved' | 'degraded' | 'error'
  persistenceMessage?: string
  backend: AgentSettings['codingBackend']
  runningBackend?: CodingBackend
  switchingBackend?: CodingBackend | null
  onBackendChange: (backend: AgentSettings['codingBackend']) => void
  onStart: () => void
  workbenchFeatures: WorkbenchFeatures
  onWorkbenchFeaturesChange: (features: WorkbenchFeatures) => void
  onDiscussionChoice?: (choice: DiscussionChoice) => void
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
  beginnerAvailableModels?: AiModelInfo[]
  scanningBeginnerModels?: boolean
  savingAiPreferences?: boolean
  beginnerModelScanMessage?: string
  contextModel?: string
  onScanBeginnerModels?: () => void
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onResetAiSelection?: () => void
  onFastModeChange?: (enabled: boolean) => void
  placeholder: string
  humanizeActivity: (value: string) => string
  onEditTimelineItem?: (id: string, content: string) => void
  onDeleteTimelineItem?: (id: string) => void
  onRewindTimelineTo?: (id: string) => void
}

export const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return <ReplyMarkdown content={content} className="agent-markdown" />
})

function backendLabel(backend: AgentSettings['codingBackend']): string {
  return backend === 'quota' ? 'ModMind' : 'Codex'
}

function backendIcon(backend: AgentSettings['codingBackend'], size = 14): React.JSX.Element {
  if (backend === 'quota') return <img src={modmindLogo} alt="" width={size} height={size} style={{ flexShrink: 0, objectFit: 'contain' }} />
  return <AgentBrandIcon kind={backend} size={size} />
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date) : ''
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
    if (item.kind === 'answer') {
      const previous = rows.at(-1)
      rows.push(previous && previous.kind !== 'user' && previous.kind !== 'answer'
        ? { ...item, separateAnswer: true } : item)
      continue
    }
    if (isTurnCompletion(item)) {
      rows.push(item)
      continue
    }
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
    <button type="button" className="agent-disclosure-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="agent-disclosure-icon">{running ? <LoaderCircle className="spin" size={12} /> : <Brain size={14} />}</span>
      <span>{running ? `${title || '正在思考'} · ${elapsed}s` : '思考完成'}</span>
      <ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded && detail.length ? <div className="agent-disclosure-body">{detail.join('\n')}</div> : null}
  </section>
}

function ToolGroup({ items, humanizeActivity }: { items: AgentWorkbenchTimelineItem[]; humanizeActivity: (value: string) => string }): React.JSX.Element {
  const running = items.some((item) => item.status === 'running')
  // Completed groups start collapsed; running groups reveal their progress.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { if (running) setExpanded(true) }, [running])
  return <section className="agent-tool-group">
    <button type="button" className="agent-disclosure-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="agent-disclosure-icon">{running ? <LoaderCircle className="spin" size={12} /> : <ListChecks size={14} />}</span>
      <span>查看步骤{items.length ? ` · ${items.length}` : ''}</span>
      <ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded ? <PagedSteps items={items} renderItem={(item) => {
      const content = humanizeActivity(item.content)
      const [title, ...detail] = content.split('\n')
      return <div className={`agent-tool-row${item.notice ? ' ai-notice-row' : ''}`} key={item.id}>
        <span className={`agent-tool-dot ${item.kind === 'error' && item.terminal !== true ? 'warning' : item.status ?? 'done'}`} />
        <div><strong>{title || '工具调用'}</strong>{detail.length ? <span>{detail.join(' ')}</span> : null}<AiNoticeDetails notice={item.notice} /></div>
      </div>
    }} /> : null}
  </section>
}

function UserTimelineItem({ item, content, onEdit, onDelete, onRewind }: { item: AgentWorkbenchTimelineItem; content: string; onEdit?: (id: string, content: string) => void; onDelete?: (id: string) => void; onRewind?: (id: string) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = content.length > 1_000 || content.split('\n').length > 12
  return <article className={`agent-message-row user${long ? ' is-long' : ''}`}>
    <div className={`agent-message agent-message-user${long && !expanded ? ' is-collapsed' : ''}`}><p>{long && !expanded ? `${content.slice(0, 1_200)}…` : content}</p></div>
    {long ? <button type="button" className="agent-message-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '展开全文'}</button> : null}
    {(onEdit || onDelete || onRewind) ? <div className="agent-message-actions">{onEdit ? <button type="button" title="编辑并重新发送" aria-label="编辑并重新发送" onClick={() => onEdit(item.id, item.content)}><Pencil size={12} /></button> : null}{onDelete ? <button type="button" title="删除这轮对话" aria-label="删除这轮对话" onClick={() => onDelete(item.id)}><Trash2 size={12} /></button> : null}{onRewind ? <button type="button" title="从这条提问重新开始" aria-label="从这条提问重新开始" onClick={() => onRewind(item.id)}><Undo2 size={12} /></button> : null}</div> : null}
    <time>{formatTime(item.time)}</time>
  </article>
}

function TimelineItem({ item, humanizeActivity, onEdit, onDelete, onRewind }: { item: AgentWorkbenchTimelineItem & { separateAnswer?: boolean }; humanizeActivity: (value: string) => string; onEdit?: (id: string, content: string) => void; onDelete?: (id: string) => void; onRewind?: (id: string) => void }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(item.kind === 'error')
  const content = useMemo(() => humanizeActivity(item.kind === 'answer' || item.kind === 'response' ? splitDiscussionChoices(item.content).content : item.content), [item.kind, item.content, humanizeActivity])
  if (item.kind === 'user') return <UserTimelineItem item={item} content={content} onEdit={onEdit} onDelete={onDelete} onRewind={onRewind} />
  if (item.kind === 'thinking') return <ThinkingItem item={item} content={content} />
  if (item.kind === 'start' || item.kind === 'retry' || item.kind === 'history') return <div className="agent-event-muted"><Clock3 size={13} /><span>{content}</span></div>
  if (item.kind === 'diff') return <section className="agent-diff-card">
    <button type="button" className="agent-diff-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><FileCode2 size={14} /><span>{item.diff?.length ?? 0} 个文件变更</span><ChevronRight className={expanded ? 'expanded' : ''} size={12} /></button>
    {expanded ? <div className="agent-diff-body">{item.diff?.map((file) => <div className="agent-diff-file" key={file.path}><code>{file.path}</code><span>+{file.added} -{file.removed}</span><pre>{[...file.additions.map((line) => `+ ${line}`), ...file.removals.map((line) => `- ${line}`)].join('\n')}</pre></div>)}</div> : null}
  </section>
  if (item.kind === 'answer' || item.kind === 'response') return content ? <article className="agent-message-row assistant">{item.kind === 'answer' && item.separateAnswer ? <hr className="agent-answer-divider" aria-label="最终回答" /> : null}<div className="agent-message agent-message-assistant"><MarkdownMessage content={content} /></div>{item.kind === 'answer' && (onDelete || onRewind) ? <div className="agent-message-actions">{onDelete ? <button type="button" title="删除这轮对话" aria-label="删除这轮对话" onClick={() => onDelete(item.id)}><Trash2 size={12} /></button> : null}{onRewind ? <button type="button" title="保留此回答并截断后续对话" aria-label="保留此回答并截断后续对话" onClick={() => onRewind(item.id)}><Undo2 size={12} /></button> : null}</div> : null}<time>{formatTime(item.time)}</time></article> : null
  if (item.kind === 'error' || item.kind === 'warning') {
    if (item.terminal !== true) return <div className="agent-event-muted"><CircleAlert size={13} /><span>{content}</span></div>
    return <div className={`agent-notice ${item.kind}`}><CircleAlert size={14} /><div><span>{content}</span><AiNoticeDetails notice={item.notice} /></div></div>
  }
  return content ? <div className="agent-event-muted"><span>{content}</span></div> : null
}

function PlanBar({ todo }: { todo: TodoItem[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  if (!todo.length) return null
  const completed = todo.filter((item) => item.status === 'completed').length
  return <section className="agent-plan-bar">
    <button type="button" className="agent-plan-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="agent-plan-badge">计划</span><small>{completed}/{todo.length}</small></button>
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
  return <div className="agent-settings-popover"><div className="agent-settings-row"><strong>模型</strong><div><select value={preferences.model} disabled={props.savingAiPreferences} onChange={(event) => props.onModelChange?.(event.target.value)}>{models.some((model) => model.id === preferences.model) ? null : <option value={preferences.model}>{preferences.model}</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select><button type="button" className="agent-icon-button" title="刷新模型" disabled={props.scanningBeginnerModels || props.savingAiPreferences} onClick={props.onScanBeginnerModels}>{props.scanningBeginnerModels ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}</button></div></div><div className="agent-settings-row"><strong>思考强度</strong><ReasoningControl value={preferences.reasoningLevel} capabilities={models.find(model => model.id === preferences.model)?.reasoning} allowedEfforts={selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions)} disabled={props.savingAiPreferences} onChange={props.onReasoningLevelChange} /></div><label className="agent-settings-switch"><span>快速响应</span><input type="checkbox" checked={preferences.fastMode} disabled={props.savingAiPreferences} onChange={(event) => props.onFastModeChange?.(event.target.checked)} /></label>{props.beginnerModelScanMessage ? <small>{props.beginnerModelScanMessage}</small> : null}</div>
}

export default function AgentWorkbench(props: AgentWorkbenchProps): React.JSX.Element {
  const workbenchRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const { project, modpack, planning, taskState, aiTimeline, aiTodo, aiPlan } = props
  const attachmentInput = useAiAttachments({ attachments: props.attachments, onChange: props.setAttachments, projectPath: project.path, conversationId: props.activeConversationId, disabled: planning, onError: props.onAttachmentError })
  const recovery = recoveryBelongsToConversation(props.aiRecovery, props.activeConversationId) ? props.aiRecovery : null
  const effectiveBackend: AgentSettings['codingBackend'] = props.uiMode === 'beginner' ? 'quota' : (props.runningBackend ?? props.backend)
  const beginnerConversation = props.uiMode === 'beginner' || props.conversations.find(item => item.id === props.activeConversationId)?.agentMode === 'beginner'
  const minimal = props.presentation === 'minimal'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false)
  useWorkbenchPopover(workbenchRef, conversationPickerOpen, setConversationPickerOpen, '.agent-conversation-menu', '.agent-conversation-picker > button')
  useWorkbenchPopover(workbenchRef, agentPickerOpen, setAgentPickerOpen, '.agent-picker > .agent-picker-menu', '.agent-picker > button')
  useWorkbenchPopover(workbenchRef, settingsOpen, setSettingsOpen, '.agent-settings-popover', '.agent-mode-pill')
  useLayoutEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    const resize = (): void => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
    resize()
    let width = textarea.clientWidth
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return
      width = textarea.clientWidth
      resize()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [props.prompt])
  useEffect(() => {
    setAgentPickerOpen(false)
    setConversationPickerOpen(false)
    setSettingsOpen(false)
  }, [props.activeConversationId, props.uiMode, planning])
  const { confirm: confirmConversationDelete, dialog: conversationDeleteDialog } = useConfirmDialog()
  const requestConversationDelete = (conversation: WorkbenchConversationInfo): void => {
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
  // Keep the complete persisted projection. Disclosure groups are presentation
  // only and must never remove historical items from the model.
  const displayedTimeline = useMemo(() => aiTimeline, [aiTimeline])
  const timelineRows = useMemo(() => groupTimeline(displayedTimeline), [displayedTimeline])
  const latestReply = useMemo(() => {
    for (let index = displayedTimeline.length - 1; index >= 0; index -= 1) {
      const item = displayedTimeline[index]
      if (item.kind === 'answer' || item.kind === 'user') return item
    }
    return undefined
  }, [displayedTimeline])
  const choiceAnswer = latestReply?.kind === 'answer' ? latestReply : undefined
  const choiceDisabled = planning || props.aiOutputStatus !== 'success' || Boolean(props.savingAiPreferences) || Boolean(props.prompt.trim()) || props.attachments.length > 0
  const hasLiveThinking = useMemo(() => displayedTimeline.some((item) => item.kind === 'thinking' && item.status === 'running'), [displayedTimeline])
  const canExport = props.canExportArtifact && !planning && !props.building
  const contextModel = props.beginnerAiPreferences?.model ?? props.contextModel
  const latestUsage = useMemo(() => latestWorkbenchUsage(aiTimeline, { model: contextModel, backend: effectiveBackend }), [aiTimeline, contextModel, effectiveBackend])
  return <div ref={workbenchRef} className={`agent-workbench${minimal ? ` agent-minimal${timelineRows.length ? '' : ' agent-minimal-empty'}` : ''}`}>
    <header className="agent-workbench-header">
      <h1 className="visually-hidden">工作台</h1>
        <div className="agent-conversation-picker">
          <button type="button" className="agent-picker-trigger" aria-label="切换对话" aria-expanded={conversationPickerOpen} title={props.planning ? '任务运行中不能切换对话' : '多对话：切换、新建或删除对话'} disabled={props.planning} onClick={() => setConversationPickerOpen((value) => !value)}><MessagesSquare size={14} /><span>{props.conversations.find((item) => item.id === props.activeConversationId)?.title ?? '选择对话'}</span>{props.conversations.length > 1 ? <small>{props.conversations.length}</small> : null}<ChevronDown size={12} /></button>
          {conversationPickerOpen ? <div className="agent-picker-menu agent-conversation-menu">
            {props.conversations.map((conversation) => {
              const original = isLegacyWorkbenchConversation(conversation)
              return <div key={conversation.id} className={`agent-conversation-item ${conversation.id === props.activeConversationId ? 'active' : ''}`}>
                <button type="button" className="agent-conversation-select" title={conversation.title} onClick={() => { props.onSelectConversation(conversation.id); setConversationPickerOpen(false) }}><span>{conversation.pinned ? <Pin size={11} /> : null}{conversation.title}</span>{conversation.agentMode === 'beginner' ? <em title="小白模式对话">小白</em> : original ? <em title="升级前的对话，与旧版本完全一致">原始</em> : null}</button>
                <div className="agent-conversation-trailing"><small className="agent-conversation-time">{formatConversationTime(conversation.updatedAt)}</small><div className="agent-conversation-actions">
                  <button type="button" className="agent-conversation-action" title="重命名对话" aria-label={`重命名对话 ${conversation.title}`} onClick={() => { setConversationPickerOpen(false); props.onRenameConversation(conversation.id) }}><Pencil size={13} /></button>
                  <button type="button" className="agent-conversation-action" title={conversation.pinned ? '取消置顶' : '置顶'} aria-label={conversation.pinned ? `取消置顶 ${conversation.title}` : `置顶对话 ${conversation.title}`} onClick={() => props.onTogglePinConversation(conversation.id)}>{conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                  {props.conversations.length > 1 ? <button type="button" className="agent-conversation-delete" title="删除对话" aria-label={`删除对话 ${conversation.title}`} onClick={() => requestConversationDelete(conversation)}><Trash2 size={13} /></button> : null}
                </div></div>
              </div>
            })}
            <button type="button" className="agent-conversation-new" disabled={props.planning} onClick={() => { props.onNewConversation(); setConversationPickerOpen(false) }}><Plus size={13} /><span>新建对话</span></button>
          </div> : null}
        </div>
      <div className="agent-workbench-actions">

        {props.persistenceState === 'saving' || props.persistenceState === 'error' ? <span className={`agent-persistence-status ${props.persistenceState ?? 'ready'}`} title={props.persistenceMessage}>{props.persistenceState === 'saving' ? <LoaderCircle className="spin" size={12} /> : props.persistenceState === 'error' ? <CircleAlert size={12} /> : <Check size={12} />}<span>{props.persistenceMessage ?? '已保存'}</span></span> : null}
        <div className="agent-picker"><button type="button" className="agent-picker-trigger" aria-label={`开发引擎：${backendLabel(effectiveBackend)}`} disabled={planning || Boolean(props.switchingBackend) || props.uiMode !== 'advanced'} aria-expanded={agentPickerOpen} onClick={() => props.uiMode === 'advanced' && setAgentPickerOpen((value) => !value)}>{props.switchingBackend ? <LoaderCircle className="spin" size={14} /> : backendIcon(effectiveBackend)}<span>{props.switchingBackend ? `正在切换到 ${backendLabel(props.switchingBackend)}` : backendLabel(effectiveBackend)}</span>{props.uiMode === 'advanced' ? <ChevronDown size={12} /> : null}</button>{agentPickerOpen ? <div className="agent-picker-menu">{(['quota', 'codex'] as const).map((backend) => <button type="button" className={(props.runningBackend ?? props.backend) === backend ? 'active' : ''} key={backend} onClick={() => { props.onBackendChange(backend); setAgentPickerOpen(false) }}>{backendIcon(backend)}<span>{backendLabel(backend)}</span>{(props.runningBackend ?? props.backend) === backend ? <Check size={13} /> : null}</button>)}</div> : null}</div>
        <MoreActions label="工作台更多操作">        <button type="button" className="agent-icon-button" title="保存版本" aria-label="保存版本" onClick={props.onSnapshot}><History size={15} /></button>
        <button type="button" className="agent-icon-button" title="导出成品" aria-label="导出成品" disabled={!canExport} onClick={props.onExport}><Download size={15} /></button>
        {modpack ? <button type="button" className="agent-icon-button" title="导出服务端包" aria-label="导出服务端包" disabled={planning || props.building} onClick={props.onExportServerPack}><Archive size={15} /></button> : null}
<button type="button" onClick={props.onRename}><Pencil size={14} />重命名项目</button>{props.onUiModeChange ? <button type="button" onClick={() => props.onUiModeChange?.(props.uiMode === 'advanced' ? 'beginner' : 'advanced')}>{props.uiMode === 'advanced' ? '切换到简洁模式' : '切换到专业模式'}</button> : null}</MoreActions>        {props.uiMode === 'beginner' ? <button type="button" className="agent-icon-button agent-account-button" title="账号与远程设置" aria-label="账号与远程设置" onClick={props.onOpenAccount}><UserRound size={15} /><span className={`agent-account-dot ${props.deviceState?.status === 'connected' ? 'connected' : ''}`} /></button> : null}
      </div>
    </header>

    {recovery ? <section className="agent-recovery-banner"><CircleAlert size={16} /><div><strong>发现未完成任务</strong><span>恢复点已保存{recovery.backend ? `，将使用 ${backendLabel(recovery.backend)} 继续` : ''}。</span></div><button type="button" className="agent-text-button" disabled={planning} onClick={props.onDismissRecovery}>稍后</button><button type="button" className="agent-primary-button" disabled={planning} onClick={props.onResume}>{planning ? <LoaderCircle className="spin" size={13} /> : null}继续</button></section> : null}

    {timelineRows.length ? <WorkbenchConversation projectPath={project.path} key={`${project.path}:${props.activeConversationId}`} rows={timelineRows} isUserRow={row => row.kind === 'user'} renderRow={(row) => row.kind !== 'tool-group' && isTurnCompletion(row) ? <TurnCompletionCard item={row} onOpenFile={props.onOpenChangedFile} /> : row.kind === 'tool-group' ? <ToolGroup items={row.items} humanizeActivity={props.humanizeActivity} /> : <><TimelineItem item={row} humanizeActivity={props.humanizeActivity} onEdit={!planning ? props.onEditTimelineItem : undefined} onDelete={!planning ? props.onDeleteTimelineItem : undefined} onRewind={!planning ? props.onRewindTimelineTo : undefined} />{row.id === choiceAnswer?.id && props.onDiscussionChoice ? <DiscussionChoiceCards choices={splitDiscussionChoices(row.content).choices} disabled={choiceDisabled} onSelect={props.onDiscussionChoice} /> : null}</>} footer={taskState === 'success' && aiPlan && aiPlan.intent !== 'informational' ? <div className="agent-conversation-row"><div className="agent-result-actions"><button type="button" className="agent-secondary-button" onClick={props.onTest}><Gamepad2 size={14} />{project.kind === 'server-plugin' ? '进入测试' : '进入游戏测试'}</button>{props.canExportArtifact ? <button type="button" className="agent-secondary-button" onClick={props.onExport}><Download size={14} />导出</button> : null}</div></div> : null} /> : <ChatWelcome key={`${project.path}:${props.activeConversationId}`} mode="workbench" modpack={modpack} serverPlugin={project.kind === 'server-plugin'} minimal={minimal} disabled={planning} onSelect={(prompt) => { props.setPrompt(prompt); composerRef.current?.focus() }} />}

    <div className="agent-composer-stack">
      {planning ? <PlanBar todo={aiTodo} /> : null}
      {planning && !hasLiveThinking ? <ProcessingBar label="正在处理" startedAt={props.processingStartedAt} /> : null}
      {settingsOpen ? <SettingsPopover props={props} /> : null}
      <WorkbenchApprovalDialog projectPath={project.path} conversationId={props.activeConversationId} />
      <footer className={`agent-composer ai-attachment-dropzone${attachmentInput.dragging ? ' is-dragging' : ''}`} {...attachmentInput.handlers}>
        {attachmentInput.dragging ? <div className="ai-attachment-drop-hint" role="status">松开即可添加文件、图片或文件夹</div> : null}
        <textarea ref={composerRef} aria-label="发送给 AI 的消息" value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && attachmentInput.isBusy()) { event.preventDefault(); return }; if (event.key === 'Enter' && event.shiftKey) return; if (props.savingAiPreferences && event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); return } if (event.ctrlKey || event.metaKey) { if (event.key === 'Enter' && !planning) { event.preventDefault(); const textarea = event.currentTarget; const start = textarea.selectionStart; const end = textarea.selectionEnd; props.setPrompt(`${props.prompt.slice(0, start)}\n${props.prompt.slice(end)}`); window.requestAnimationFrame(() => textarea.setSelectionRange(start + 1, start + 1)) } return } if (event.key === 'Enter' && !planning && (props.prompt.trim() || props.attachments.length)) { event.preventDefault(); props.onStart() } }} placeholder={props.placeholder} disabled={planning} rows={2} />
        <div className="agent-composer-toolbar"><div className="agent-composer-tools">{props.uiMode === 'advanced' && !beginnerConversation ? <WorkbenchFeatureControls value={props.workbenchFeatures} disabled={planning} onChange={props.onWorkbenchFeaturesChange} /> : null}<ProjectKnowledgeButton key={project.path} projectPath={project.path} disabled={planning} /><AiAttachmentPicker attachments={props.attachments} onChange={props.setAttachments} disabled={planning} controller={attachmentInput} /></div><div className="agent-composer-actions">{props.uiMode === 'beginner' ? <button type="button" className="agent-mode-pill" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings size={14} /><span>制作设置</span><ChevronDown size={12} /></button> : null}{props.beginnerAiPreferences ? <QuotaPreferenceControls managedCodex preferences={props.beginnerAiPreferences} models={props.beginnerAvailableModels ?? []} disabled={planning || Boolean(props.savingAiPreferences)} onModelChange={props.onModelChange} onReasoningLevelChange={props.onReasoningLevelChange} onReset={props.onResetAiSelection} /> : null}<ContextUsage usage={latestUsage} />{planning ? <button type="button" className="agent-send-button stop" title="停止任务" aria-label="停止任务" onClick={props.onCancel}><Square size={14} fill="currentColor" /></button> : <button type="button" className="agent-send-button" title="发送" aria-label="发送" disabled={attachmentInput.busy || Boolean(props.savingAiPreferences) || (!props.prompt.trim() && !props.attachments.length)} onClick={() => { if (!attachmentInput.isBusy()) props.onStart() }}><ArrowUp size={17} strokeWidth={2.7} /></button>}</div></div>
      </footer>
      {minimal && !timelineRows.length ? <div className="chat-welcome minimal-recommendations"><ChatRecommendations mode="workbench" modpack={modpack} serverPlugin={project.kind === 'server-plugin'} disabled={planning} onSelect={value => { props.setPrompt(value); composerRef.current?.focus() }} /></div> : null}
      {props.aiOutputStatus === 'error' && !planning ? <div className="agent-error-footer"><CircleAlert size={14} /><span>任务没有完成，详细信息已保留</span><button type="button" className="agent-text-button" onClick={props.onExportLogs}>导出诊断</button></div> : null}
    </div>

    {conversationDeleteDialog}
  </div>
}
