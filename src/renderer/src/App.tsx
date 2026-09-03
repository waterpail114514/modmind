import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode, SetStateAction } from 'react'
import { marked } from 'marked'
import {
  Archive,
  ArrowRightLeft,
  Binary,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  Puzzle,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  CloudUpload,
  Code2,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCog,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  Gamepad2,
  Hammer,
  History,
  Image,
  Info,
  LoaderCircle,
  RefreshCw,
  LibraryBig,
  List,
  Lightbulb,
  ListChecks,
  Link2,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PackageOpen,
  PackagePlus,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  Undo2,
  UserRound,
  WandSparkles,
  X,
  Zap
} from 'lucide-react'
import type {
  AiPlan,
  AiAttachment,
  AiOutputEvent,
  CodingBackend,
  AiModelInfo,
  AiRecoveryInfo,
  AgentSettings,
  AppUpdateState,
  AppVersionCheckResult,
  ExternalAgentStatus,
  ExternalAgentConfiguration,
  ExternalAgentKind,
  ExistingProjectAdoptInput,
  ExistingProjectAnalysis,
  FileNode,
  DetectedJavaHome,
  JavaPreferences,
  InspirationChatMessage,
  JavaLoaderKind,
  LoaderKind,
  LoaderVersionOption,
  PipelineEvent,
  PreflightResult,
  ProjectInfo,
  ProjectKind,
  ProjectMigrationPreview,
  SnapshotInfo,
  UiMode,
  BeginnerTaskState,
  BeginnerAiPreferences,
  BeginnerReasoningLevel,
  DeviceConnectionState,
  RemoteConnectionState,
  McpBridgeState,
  DiagnosticPageSnapshot,
  SidebarViewId,
  DetachedWindowTarget
} from '../../shared/types'
import type { MappingClassDetail, MappingClassResult } from '../../shared/mappings'
import type { DecompileInspectResult, DecompileProgressEvent } from '../../shared/decompile'
import type { DecompileTermsPayload } from '../../shared/decompileModuleExport'
import type { GiteeBuildResult, GiteeBuildSettings, GiteeBuildValidation } from '../../shared/production'
import type { ImageStudioSettings } from '../../shared/imageStudio'
import { AI_CONTINUATION_PROMPT, aiPromptFingerprint, isRepeatedAiPrompt } from '../../shared/aiPrompt'
import { describeAiFailureForUser } from '../../shared/aiFailure'
import { appendMinecraftRuntimeEvent, type MinecraftRuntimeEvent } from '../../shared/minecraft'
import { isJavaLoader, platformLabel } from '../../shared/projectPlatform'
import BlockbenchWorkspace from './components/BlockbenchWorkspace'
import AiAttachmentPicker, { formatAiAttachmentContext } from './components/AiAttachmentPicker'
import GitWorkspace from './components/GitWorkspace'
import MinecraftTestWorkspace from './components/MinecraftTestWorkspace'
import ModpackToolsWorkspace from './components/ModpackToolsWorkspace'
import ModpackMigrationWorkspace from './components/ModpackMigrationWorkspace'
import DecompileWorkspace from './components/DecompileWorkspace'
import FtbQuestEditor from './components/FtbQuestEditor'
import PatchouliBookEditor from './components/PatchouliBookEditor'
import ModpackModListWorkspace from './components/ModpackModListWorkspace'
import ModpackContentWorkspace from './components/ModpackContentWorkspace'
import ModpackKeybindWorkspace from './components/ModpackKeybindWorkspace'
import ThirdPartyModsWorkspace from './components/ThirdPartyModsWorkspace'
import { useConfirmDialog, usePromptDialog } from './components/InteractionDialogs'
import ProductionWorkspace from './components/ProductionWorkspace'
import GlobalDownloadIndicator from './components/GlobalDownloadIndicator'
import AddonRelationshipsWorkspace from './components/AddonRelationshipsWorkspace'
import ImageStudioWorkspace from './components/ImageStudioWorkspace'
import AgentWorkbench from './components/AgentWorkbench'
import { PluginPanelHost } from './components/PluginPanelHost'
import { PluginsManager } from './components/PluginsManager'
import { PluginOverlayLayer } from './components/PluginOverlayLayer'
import type { PluginSnapshot } from '../../shared/plugins'
import { appendUserTurn, normalizeStoredWorkbenchTimeline, reduceWorkbenchOutput, reduceWorkbenchProgress, settleWorkbenchActivity, workbenchDeleteTimelineItem, workbenchDialogueToText, workbenchFinalDialogue, workbenchRewindTimelineTo, type WorkbenchTimelineItem } from './workbenchTimeline'
import { GUIDE_AUTO_DISABLED_KEY, pageGuideSeenKey, PAGE_TOURS, SHELL_TOUR_STEPS } from './pageGuides'
import { PageGuideModal, WelcomeTour } from './components/PageGuide'
import { TourGuide } from './components/TourGuide'
import {
  createWorkbenchConversation,
  isLegacyWorkbenchConversation,
  migrateLegacyConversation,
  normalizeWorkbenchConversations,
  removeWorkbenchConversation,
  touchWorkbenchConversation,
  titleFromUserText,
  WORKBENCH_LEGACY_SCOPE,
  workbenchPromptHistoryStorageKey,
  workbenchSessionScope,
  type WorkbenchConversation
} from './workbenchConversations'
import { boundInspirationMessages, normalizeStoredInspirationMessages, persistInspirationHistory, type InspirationConversation } from './inspirationStorage'
import { isAiOperationalStatusText, isUsableAiAnswer } from '../../shared/aiOutput'
import { buildInspirationRows, deleteInspirationTimelineItem, finalInspirationReply, inspirationConversationHandoff, rewindInspirationTimelineTo, settleInspirationCancellation, settleInspirationFailure, settleInspirationReply, shouldResumeInspirationSession } from './inspirationOutput'
import appLogo from './assets/logo.png'

const MonacoCodeEditor = lazy(() => import('./components/MonacoCodeEditor'))

type ViewId = SidebarViewId
type SidebarDragItem = { id: ViewId; groupKey: string; label: string }
type SidebarDragPayload = SidebarDragItem

function KeepAliveRoute({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element | null {
  const [activated, setActivated] = useState(active)

  useEffect(() => {
    if (active) setActivated(true)
  }, [active])

  if (!active && !activated) return null
  return <div className="keep-alive-route" hidden={!active}>{children}</div>
}

function detachedWindowView(): ViewId | null {
  const params = new URLSearchParams(window.location.search)
  if (params.get('detached') !== '1') return null
  const view = params.get('view')
  return view && /^[a-z0-9-]+$/.test(view) ? view as ViewId : null
}

function detachedWindowGroup(): string | null {
  const params = new URLSearchParams(window.location.search)
  if (params.get('detached') !== '1') return null
  const group = params.get('group')
  return group && /^\d{1,3}$/.test(group) ? group : null
}

function normalizeProjectPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return navigator.platform.toLowerCase().includes('win') ? normalized.toLowerCase() : normalized
}

const initialDetachedView = detachedWindowView()
const initialDetachedGroup = detachedWindowGroup()
const isDetachedWindow = initialDetachedView !== null || initialDetachedGroup !== null

function readSidebarDragPayload(dataTransfer: DataTransfer): SidebarDragPayload | null {
  const raw = dataTransfer.getData('application/x-modmind-sidebar-item')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarDragPayload>
    if (typeof parsed.id !== 'string' || typeof parsed.groupKey !== 'string' || typeof parsed.label !== 'string') return null
    return { id: parsed.id as ViewId, groupKey: parsed.groupKey, label: parsed.label }
  } catch {
    return null
  }
}

function InspirationStepGroup({ items }: { items: InspirationChatMessage[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(items.some((item) => item.status === 'streaming'))
  useEffect(() => { if (items.some((item) => item.status === 'streaming')) setExpanded(true) }, [items])
  return <section className="agent-tool-group">
    <button type="button" className="agent-disclosure-header" onClick={() => setExpanded((value) => !value)}>
      <span className="agent-disclosure-icon">{items.some((item) => item.status === 'streaming') ? <LoaderCircle className="spin" size={12} /> : <ListChecks size={14} />}</span>
      <span>查看步骤{items.length ? ` · ${items.length}` : ''}</span>
      <ChevronRight className={expanded ? 'expanded' : ''} size={12} />
    </button>
    {expanded ? <div className="agent-tool-group-body">{items.map((item) => (
      <div className="agent-tool-row" key={item.id || `${item.time || ''}-${item.content}`}>
        <span className={`agent-tool-dot ${item.status === 'error' || item.status === 'cancelled' ? 'warning' : 'done'}`} />
        <div><strong>{item.content.split('\n')[0] || '工具调用'}</strong>{item.content.includes('\n') ? <span>{item.content.split('\n').slice(1).join(' ')}</span> : null}</div>
      </div>
    ))}</div> : null}
  </section>
}

type AiTimelineItem = WorkbenchTimelineItem

type WorkbenchUiState = {
  prompt: string
  attachments: AiAttachment[]
  plan: AiPlan | null
  todo: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
  planning: boolean
  processingStartedAt?: string
  taskState: BeginnerTaskState
  timeline: AiTimelineItem[]
  outputStatus: 'idle' | 'running' | 'success' | 'error'
  recovery: AiRecoveryInfo | null
}

type WorkbenchUiAction = { key: keyof WorkbenchUiState; value: unknown }

const initialWorkbenchUiState: WorkbenchUiState = {
  prompt: '',
  attachments: [],
  plan: null,
  todo: [],
  planning: false,
  processingStartedAt: undefined,
  taskState: 'idle',
  timeline: [],
  outputStatus: 'idle',
  recovery: null
}

function workbenchUiReducer(state: WorkbenchUiState, action: WorkbenchUiAction): WorkbenchUiState {
  const current: unknown = state[action.key]
  const value = typeof action.value === 'function'
    ? (action.value as (current: unknown) => unknown)(current)
    : action.value
  return { ...state, [action.key]: value }
}

type ProjectWorkbenchState = {
  prompt: string
  attachments: AiAttachment[]
  events: PipelineEvent[]
  aiPlan: AiPlan | null
  aiTodo: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
  planning: boolean
  processingStartedAt?: string
  runningBackend?: CodingBackend
  switchingBackend?: CodingBackend | null
  workspaceSession: string
  conversations: WorkbenchConversation[]
  activeConversationId: string
  aiTimeline: AiTimelineItem[]
  aiOutputStatus: 'idle' | 'running' | 'success' | 'error'
  aiRecovery: AiRecoveryInfo | null
  beginnerTaskState: BeginnerTaskState
  files: FileNode[]
  selectedFile: string
  editorContent: string
  editorDirty: boolean
  buildResult: PreflightResult | null
  buildError: string
  building: boolean
  snapshots: SnapshotInfo[]
  exportArtifactAvailable: boolean
  minecraftEvents: MinecraftRuntimeEvent[]
}

type PendingBackendSwitch = {
  generation: number
  backend: CodingBackend
  previousBackend: CodingBackend
  accepted: boolean
}

type WorkbenchPersistenceState = 'loading' | 'ready' | 'saving' | 'saved' | 'degraded' | 'error'

function emptyProjectWorkbenchState(): ProjectWorkbenchState {
  return {
    prompt: '', attachments: [], events: [], aiPlan: null, aiTodo: [], planning: false, processingStartedAt: undefined,
    workspaceSession: '', conversations: [], activeConversationId: '', aiTimeline: [], aiOutputStatus: 'idle', runningBackend: undefined, switchingBackend: null,
    aiRecovery: null, beginnerTaskState: 'idle', files: [], selectedFile: '', editorContent: '', editorDirty: false,
    buildResult: null, buildError: '', building: false, snapshots: [], exportArtifactAvailable: false, minecraftEvents: []
  }
}

function normalizeStoredTimelineItem(item: AiTimelineItem): AiTimelineItem {
  return normalizeStoredWorkbenchTimeline(item)
}

/** Shared parsing for persisted workbench timelines (legacy and per-conversation files). */
export function parseStoredWorkbenchTimeline(value: unknown): AiTimelineItem[] {
  if (!Array.isArray(value)) return []
  let history = value
  .filter((item): item is AiTimelineItem => Boolean(item && typeof item === 'object' && typeof (item as AiTimelineItem).id === 'string' && typeof (item as AiTimelineItem).content === 'string' && typeof (item as AiTimelineItem).kind === 'string' && typeof (item as AiTimelineItem).time === 'string'))
  .map(normalizeStoredTimelineItem)
  history = history.filter((item) => item.kind !== 'history' || item.content.length <= 200)
  return settleWorkbenchActivity(history)
}

marked.setOptions({ gfm: true, breaks: true })

function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  const renderer = new marked.Renderer()
  renderer.html = ({ text }) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  renderer.link = ({ href, text }) => {
    const safeText = text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
    if (!/^https?:\/\//i.test(href)) return safeText
    const safeHref = href.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeText}</a>`
  }
  renderer.image = ({ text }) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  const html = marked.parse(content, { async: false, renderer })
  return <div className="markdown-message" dangerouslySetInnerHTML={{ __html: html }} />
}

const MAX_AUTO_REPAIR_ROUNDS = 3

const initialSettings: AgentSettings = {
  codingBackend: 'codex',
  allowBuildScriptChanges: true,
  preferLocalGradle: false,
  gradleExecutable: '',
  gradleDownloadSource: 'auto',
  networkProxyUrl: '',
  javaPreferences: { game: '', build: '', tools: '' },
  darkMode: false,
  closeBehavior: 'ask',
  notificationsEnabled: true
}

type JavaProbeDisplayState = { status: 'idle' | 'checking' | 'valid' | 'invalid'; major: number }

function JavaHomePreferenceRow({ label, description, value, homes, scanning, onChange }: {
  label: string
  description: string
  value: string
  homes: DetectedJavaHome[]
  scanning: boolean
  onChange: (value: string) => void
}) {
  const [probe, setProbe] = useState<JavaProbeDisplayState>({ status: 'idle', major: 0 })

  useEffect(() => {
    const home = value.trim()
    if (!home) {
      setProbe({ status: 'idle', major: 0 })
      return
    }
    setProbe({ status: 'checking', major: 0 })
    let cancelled = false
    const timer = setTimeout(() => {
      window.modmind.settings.probeJavaHome(home)
        .then((result) => { if (!cancelled) setProbe({ status: result.valid ? 'valid' : 'invalid', major: result.major }) })
        .catch(() => { if (!cancelled) setProbe({ status: 'invalid', major: 0 }) })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value])

  const normalizedValue = value.trim()
  const knownHomes = homes.filter((home) => home.home !== normalizedValue)
  const customNotListed = Boolean(normalizedValue) && !homes.some((home) => home.home === normalizedValue)
  const statusText = probe.status === 'idle'
    ? `当前使用：${normalizedValue ? '此路径' : 'ModMind 自动配置（托管运行时）'}`
    : probe.status === 'checking'
      ? '正在检测该 Java 是否可用…'
      : probe.status === 'valid'
        ? `可用：检测到 Java ${probe.major}`
        : '无法运行该 Java 或版本不合规；运行时会自动回退到托管运行时'

  return (
    <div className="settings-java-row">
      <div className="appearance-row"><div><strong>{label}</strong><p>{description}</p></div><span className={`status-dot ${probe.status === 'invalid' ? 'warning' : 'success'}`} /></div>
      <label className="field-label">自动检测
        <select
          value={knownHomes.some((home) => home.home === normalizedValue) ? normalizedValue : ''}
          onChange={(event) => onChange(event.target.value)}
          disabled={scanning}
        >
          <option value="">自动（推荐）</option>
          {knownHomes.map((home) => <option key={home.home} value={home.home}>Java {home.major} · {home.home}</option>)}
          {customNotListed ? <option value={normalizedValue}>{`自定义路径 · ${normalizedValue}`}</option> : null}
        </select>
      </label>
      <label className="field-label">Java 目录（留空则自动配置）
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如 C:\Program Files\Eclipse Adoptium\jdk-21" />
      </label>
      <div className="settings-actions">
        <span><Info size={14} />{statusText}</span>
        <button className="secondary-button compact" type="button" onClick={() => void window.modmind.settings.pickJavaHome().then((picked) => { if (picked) onChange(picked) })}>
          浏览…
        </button>
      </div>
    </div>
  )
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatBalanceCents(value?: string): string {
  if (!value || !/^\d+$/.test(value)) return '—'
  const cents = BigInt(value)
  return `¥${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

const EXTERNAL_AGENT_OPTIONS: Array<{kind: ExternalAgentKind; label: string; detail: string; managedService: boolean}> = [
  {kind: 'codex', label: 'Codex', detail: '使用 ModMind 托管的稳定版 Codex；需要时可在此配置中转服务', managedService: true},
  {kind: 'claude', label: 'Claude Code', detail: '读取本机 Claude Code 配置；需要时可在此配置中转服务', managedService: true}
]

function externalAgentLabel(kind: ExternalAgentKind): string {
  return EXTERNAL_AGENT_OPTIONS.find((agent) => agent.kind === kind)?.label ?? kind
}

function externalAgentIcon(kind: ExternalAgentKind, size = 13): React.JSX.Element {
  if (kind === 'codex') return <Code2 size={size} />
  if (kind === 'claude') return <Sparkles size={size} />
  return <Zap size={size} />
}

type ProductionSettingsPanelProps = {
  aiSettings: BeginnerAiPreferences
  deviceState: DeviceConnectionState
  availableModels: AiModelInfo[]
  scanningModels: boolean
  savingAiPreferences: boolean
  modelScanMessage: string
  onScanModels: () => void
  onModelChange: (model: string) => void
  onReasoningLevelChange: (reasoningLevel: BeginnerReasoningLevel) => void
  onFastModeChange: (fastMode: boolean) => void
}

function ProductionSettingsPanel({
  aiSettings,
  deviceState,
  availableModels,
  scanningModels,
  savingAiPreferences,
  modelScanMessage,
  onScanModels,
  onModelChange,
  onReasoningLevelChange,
  onFastModeChange
}: ProductionSettingsPanelProps): React.JSX.Element {
  const modelOptions = availableModels.some((model) => model.id === aiSettings.model)
    ? availableModels
    : [{ id: aiSettings.model }, ...availableModels]

  return <div className="production-settings-panel">
    <section className="beginner-ai-preferences">
      <div className="beginner-ai-preferences-heading"><Bot size={17} /><div><strong>智能引擎</strong><small>选择制作使用的模型、思考强度和响应速度</small></div></div>
      <label className="beginner-model-control"><span>模型 <InfoTooltip className="model-info"><span>gpt-5.6-sol：能力最强，消耗较高</span><span>gpt-5.6-terra：均衡、较省额度</span><span>gpt-5.6-luna：响应较快、成本较低</span></InfoTooltip></span><div><select value={aiSettings.model} disabled={savingAiPreferences} onChange={(event) => onModelChange(event.target.value)}>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select><button className="icon-button" type="button" title="刷新模型列表" disabled={scanningModels || savingAiPreferences || deviceState.status !== 'connected'} onClick={onScanModels}>{scanningModels ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button></div><small>{modelScanMessage}</small></label>
      <div className="beginner-reasoning-control"><span>思考强度 <InfoTooltip><span>强度越高，推理更充分，但额度消耗更快</span></InfoTooltip></span><div role="group" aria-label="思考强度">{([['low', '低'], ['medium', '中'], ['high', '高'], ['extreme', '极高']] as const).map(([value, label]) => <button type="button" className={aiSettings.reasoningLevel === value ? 'active' : ''} disabled={savingAiPreferences} key={value} onClick={() => onReasoningLevelChange(value)}>{label}</button>)}</div></div>
      <div className="beginner-fast-control"><span>Fast 模式</span><label className="switch-control"><input type="checkbox" checked={aiSettings.fastMode} disabled={savingAiPreferences} onChange={(event) => onFastModeChange(event.target.checked)} /><span aria-hidden="true" /></label><InfoTooltip><span>同步 ModMind 账号的 Fast 服务设置</span></InfoTooltip></div>
    </section>
    <section className="beginner-image-permissions">
      <div className="beginner-image-permissions-heading"><WandSparkles size={17} /><div><strong>图片能力</strong><small>制作过程中需要生图时才会使用额度</small></div></div>
      <div className="beginner-permission-row"><span>AI 可直接生成图片 <InfoTooltip><span>外部 Agent 可以使用生图和图像处理工具，额度由已配置的服务决定</span></InfoTooltip></span></div>
    </section>
  </div>
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/blocked\s+by\s+policy/gi, '服务限制')
    .replace(/content\s+policy/gi, '服务限制')
    .replace(/policy\s+violation/gi, '服务限制')
    .replace(/safety\s+policy/gi, '服务限制')
}

function aiFailureMessage(error: unknown): string {
  return describeAiFailureForUser(errorMessage(error))
}

function editorLanguage(relativePath: string): string {
  const extension = relativePath.split('.').at(-1)?.toLowerCase() ?? ''
  return {
    java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'groovy', groovy: 'groovy',
    json: 'json', json5: 'json', mcmeta: 'json', md: 'markdown', html: 'html', htm: 'html',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', css: 'css', scss: 'scss', properties: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    lang: 'plaintext', mcfunction: 'plaintext', snbt: 'plaintext', toml: 'plaintext', zs: 'javascript'
  }[extension] ?? 'plaintext'
}

function isEditablePath(relativePath: string): boolean {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  if (['gradlew', 'license', 'copying'].includes(name)) return true
  return /\.(?:java|kt|kts|gradle|groovy|json5?|mcmeta|md|txt|toml|html?|xml|ya?ml|js|jsx|mjs|ts|tsx|py|lang|mcfunction|css|scss|properties|ini|cfg|conf|snbt|zs|bat|cmd|sh|gitignore)$/i.test(name)
}

function shouldOfferAiRecovery(error: unknown): boolean {
  const message = errorMessage(error)
  if (/(?:^|\D)(?:401|402|403|404|429|500|502|503|504)(?:\D|$)|API Key|timed out|timeout|stream disconnected|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|ENOTFOUND|线路繁忙|连接中断|响应超时|会话.{0,20}拒绝|凭证已失效|额度不足|模型接口或所选模型不存在/i.test(message)) return true
  return /recovery snapshot was preserved|safety stop|interrupted|Review Agent rejected completion|Mandatory workflow incomplete|连续 .*没有任何操作|切换线路后重试|中断|安全停止|恢复快照/i.test(message)
}

function isWorkflowAuditRejection(error: unknown): boolean {
  return /Review Agent rejected completion|Mandatory workflow incomplete|ModMind 完成检查未通过|审计|工作流未完成/i.test(errorMessage(error))
}

function FileTree({
  nodes,
  selectedPath,
  onSelect,
  depth = 0
}: {
  nodes: FileNode[]
  selectedPath: string
  onSelect: (node: FileNode) => void
  depth?: number
}): React.JSX.Element {
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(['src', 'src/main', 'src/main/java', 'docs']))

  const toggle = (node: FileNode): void => {
    if (node.type === 'file') return onSelect(node)
    setOpenFolders((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  return (
    <div className="file-tree">
      {nodes.map((node) => {
        const isOpen = openFolders.has(node.path)
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-row ${selectedPath === node.path ? 'selected' : ''}`}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => toggle(node)}
            >
              {node.type === 'directory' ? (
                <>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                </>
              ) : (
                <>
                  <span className="tree-spacer" />
                  {node.name.endsWith('.java') ? <FileCode2 size={15} /> : <File size={15} />}
                </>
              )}
              <span>{node.name}</span>
            </button>
            {node.type === 'directory' && isOpen && node.children ? (
              <FileTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function EmptyState({ onCreate, onOpen }: { onCreate: () => void; onOpen: () => void }): React.JSX.Element {
  return (
    <main className="empty-state">
      <div className="empty-icon"><Box size={30} /></div>
      <h1>开始一个 Minecraft Mod</h1>
      <p>创建新工程，或打开之前由 ModMind 管理的项目</p>
      <div className="empty-actions">
        <button className="primary-button" onClick={onCreate}><Plus size={16} />新建项目</button>
        <button className="secondary-button" onClick={onOpen}><FolderOpen size={16} />打开项目</button>
      </div>
      <div className="empty-details">
        <span><ShieldCheck size={15} />项目文件操作限制在所选目录内</span>
        <span><Archive size={15} />支持本地版本快照</span>
      </div>
    </main>
  )
}

function ProjectLauncher({
  projects,
  onCreate,
  onOpen,
  onAdopt,
  onImportModJar,
  onSelect,
  onRemove,
  onRename
}: {
  projects: ProjectInfo[]
  onCreate: () => void
  onOpen: () => void
  onAdopt: () => void
  onImportModJar: () => void
  onSelect: (project: ProjectInfo) => void
  onRemove: (project: ProjectInfo) => void
  onRename: (project: ProjectInfo) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ project: ProjectInfo; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  return (
    <main className="project-launcher">
      <div className="project-launcher-header">
        <div><h1>项目</h1><p>选择最近项目或开始一个新项目</p></div>
      </div>
      <div className="project-launcher-list">
        <button className="project-launcher-action" type="button" onClick={onCreate}>
          <span className="project-launcher-icon new"><Plus size={20} /></span>
          <span><strong>新建项目</strong><small>创建 Minecraft Mod 工程或整合包</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onOpen}>
          <span className="project-launcher-icon open"><FolderOpen size={19} /></span>
          <span><strong>打开已有项目</strong><small>从其他位置选择 ModMind 项目文件夹</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onAdopt}>
          <span className="project-launcher-icon adopt"><PackageOpen size={19} /></span>
          <span><strong>接管现有项目</strong><small>支持项目文件夹或压缩包（ZIP、MRPack），识别完整工程、残缺源码或 API 文档</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onImportModJar}>
          <span className="project-launcher-icon adopt"><Binary size={19} /></span>
          <span><strong>接管现成模组 <i className="sidebar-beta-badge" title="新功能测试中">Beta</i></strong><small>识别 JAR 的加载器与 Minecraft 版本，反编译后直接创建 ModMind 项目</small></span>
          <ChevronRight size={17} />
        </button>
      </div>
      {projects.length ? (
        <section className="recent-projects">
          <h2>最近项目</h2>
          <div className="recent-project-list">
            {projects.map((recent) => (
              <div className="recent-project-row" key={recent.path} onContextMenu={(event) => { event.preventDefault(); setMenu({ project: recent, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 92) }) }}>
                <button className="recent-project-main" type="button" onClick={() => onSelect(recent)}>
                  <span className="project-launcher-icon project"><Box size={18} /></span>
                  <span><strong>{recent.name}</strong><small>{recent.path}</small></span>
                  <span className="recent-project-meta">{platformLabel(recent.loader)} · {recent.minecraftVersion}</span>
                </button>
                <button className="recent-project-remove" type="button" title="删除项目" onClick={() => onRemove(recent)}><X size={15} /></button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {menu ? <div className="project-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => { onRename(menu.project); setMenu(null) }}><Pencil size={14} />重命名项目</button>
        <button type="button" role="menuitem" onClick={() => { onRemove(menu.project); setMenu(null) }}><X size={14} />删除项目</button>
      </div> : null}
    </main>
  )
}

function RenameProjectDialog({ project, onClose, onRenamed }: { project: ProjectInfo; onClose: () => void; onRenamed: (project: ProjectInfo) => void }): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [namespace, setNamespace] = useState(project.namespace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const rename = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const renamed = await window.modmind.project.rename({ name, namespace, projectPath: project.path })
      onRenamed(renamed)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
    <div className="dialog rename-project-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <div className="dialog-header"><div><h2>重命名项目</h2><p>{project.path}</p></div><button className="icon-button" type="button" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
      <label className="field-label">项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field-label">命名空间<input value={namespace} onChange={(event) => setNamespace(event.target.value)} /><small>只允许 Minecraft 标识符；输入中的空格和大写字母会自动规范化</small></label>
      {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
      <div className="dialog-footer"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={busy || !name.trim() || !namespace.trim()} onClick={() => void rename()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Pencil size={16} />}保存重命名</button></div>
    </div>
  </div>
}

function AdoptProjectDialog({
  analysis,
  onClose,
  onAdopted
}: {
  analysis: ExistingProjectAnalysis
  onClose: () => void
  onAdopted: (project: ProjectInfo) => void
}): React.JSX.Element {
  const [form, setForm] = useState<ExistingProjectAdoptInput>({ sourcePath: analysis.sourcePath, ...analysis.inferred })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const kindLabel = analysis.kind === 'complete'
    ? '完整工程'
    : analysis.kind === 'partial'
      ? '残缺源码'
      : analysis.kind === 'modpack'
        ? '整合包实例'
        : 'API 文档'

  const adopt = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const project = await window.modmind.project.adoptExisting(form)
      if (project) onAdopted(project)
      else setBusy(false)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div className="dialog adopt-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2>接管现有项目</h2><p>{analysis.sourcePath}</p></div>
          <button className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="adopt-detection">
          <span className={`adopt-kind ${analysis.kind}`}>{kindLabel}</span>
          <div><strong>{analysis.fileCount} 个文件</strong><small>{analysis.sourceFileCount} 个源码文件 · {analysis.documentCount} 个文档</small></div>
        </div>
        {analysis.modpack?.loaderVersion ? <div className="adapter-note"><PackageOpen size={16} /><p><strong>已识别 Loader 版本</strong><span>{platformLabel(analysis.inferred.loader)} {analysis.modpack.loaderVersion}</span></p></div> : null}
        <div className="adopt-reasons">{analysis.reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
        <div className="adopt-fields">
          <label className="field-label">项目名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="field-label">命名空间<input value={form.namespace} onChange={(event) => setForm({ ...form, namespace: event.target.value })} /></label>
          <label className="field-label">Minecraft 版本<input value={form.minecraftVersion} onChange={(event) => setForm({ ...form, minecraftVersion: event.target.value })} /></label>
          <label className="field-label">加载器<select value={form.loader} disabled={analysis.kind === 'complete'} onChange={(event) => setForm({ ...form, loader: event.target.value as ExistingProjectAdoptInput['loader'] })}><option value="fabric">Fabric</option><option value="quilt">Quilt</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label>
        </div>
        {analysis.detectedFiles.length ? <div className="adopt-files"><span>检测到的关键文件</span><code>{analysis.detectedFiles.slice(0, 8).join('\n')}</code></div> : null}
        {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !form.name.trim() || !form.namespace.trim()} onClick={() => void adopt()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <PackageOpen size={16} />}{analysis.kind === 'complete' ? '接管此项目' : analysis.kind === 'modpack' ? '接管此整合包' : '创建项目并导入'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AdoptModJarDialog({
  inspection,
  onClose,
  onAdopted
}: {
  inspection: DecompileInspectResult
  onClose: () => void
  onAdopted: (project: ProjectInfo) => void
}): React.JSX.Element {
  const [name, setName] = useState(inspection.displayName?.trim() || inspection.fileName.replace(/\.jar$/i, ''))
  const [loader, setLoader] = useState<JavaLoaderKind>(inspection.loader ?? 'fabric')
  const [minecraftVersion, setMinecraftVersion] = useState(inspection.minecraftVersions[0] ?? '')
  const [stage, setStage] = useState<'confirm' | 'terms'>('confirm')
  const [terms, setTerms] = useState<DecompileTermsPayload | null>(null)
  const [sourceSha256, setSourceSha256] = useState(inspection.sha256)
  const [progress, setProgress] = useState<DecompileProgressEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sizeLabel = inspection.size < 1024 * 1024
    ? `${(inspection.size / 1024).toFixed(1)} KB`
    : `${(inspection.size / 1024 / 1024).toFixed(1)} MB`

  useEffect(() => window.modmind.decompile.onProgress(setProgress), [])

  const startDecompile = async (): Promise<void> => {
    if (!name.trim() || !minecraftVersion.trim()) return
    setBusy(true)
    setError('')
    setProgress({ jarSha256: inspection.sha256, phase: 'hashing', message: '正在准备反编译' })
    try {
      const result = await window.modmind.decompile.start({
        jarPath: inspection.filePath,
        minecraftVersion: minecraftVersion.trim()
      })
      setSourceSha256(result.sha256)
      setTerms(await window.modmind.decompile.getTerms(inspection.fileName))
      setStage('terms')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const adopt = async (): Promise<void> => {
    if (!terms) return
    setBusy(true)
    setError('')
    try {
      const project = await window.modmind.decompile.createProjectFromJar({
        sourceSha256,
        name,
        loader,
        minecraftVersion: minecraftVersion.trim(),
        termsAcknowledgement: { termsVersion: terms.version, acknowledged: true, origin: 'user-workspace' }
      })
      if (project) onAdopted(project)
      else setBusy(false)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  const reasons = [
    `已识别 ${platformLabel(loader)} 模组描述文件`,
    inspection.minecraftVersions.length
      ? `已自动识别 Minecraft ${inspection.minecraftVersions.join(' / ')}`
      : '未能自动识别 Minecraft 版本，请手动确认',
    ...inspection.warnings
  ]

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div className="dialog adopt-dialog mod-jar-adopt-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2>接管现成模组 <span className="sidebar-beta-badge" title="新功能测试中">Beta</span></h2><p>{inspection.filePath}</p></div>
          <button className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="adopt-detection">
          <span className="adopt-kind complete">JAR 模组</span>
          <div><strong>{inspection.classCount} 个类</strong><small>{platformLabel(loader)} · {sizeLabel} · sha256 {inspection.sha256.slice(0, 12)}…</small></div>
        </div>
        {busy ? <div className="adapter-note"><LoaderCircle className="spin" size={16} /><p><strong>正在反编译</strong><span>{progress?.message ?? '正在准备受控反编译环境'}</span></p></div> : null}
        {stage === 'confirm' ? <>
          <div className="adopt-reasons">{reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
          <div className="adopt-fields">
            <label className="field-label">项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="field-label">Minecraft 版本
              <input list={`decompile-versions-${inspection.sha256.slice(0, 8)}`} value={minecraftVersion} onChange={(event) => setMinecraftVersion(event.target.value)} placeholder="例如：1.21.1" />
              <datalist id={`decompile-versions-${inspection.sha256.slice(0, 8)}`}>{inspection.minecraftVersions.map((version) => <option key={version} value={version} />)}</datalist>
            </label>
            <label className="field-label">加载器<select value={loader} onChange={(event) => setLoader(event.target.value as JavaLoaderKind)}><option value="fabric">Fabric</option><option value="quilt">Quilt</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label>
          </div>
          <div className="adopt-files"><span>检测到的模组文件</span><code>{inspection.fileName}</code></div>
        </> : terms ? <>
          <div className="decompile-terms-body">
            {terms.sections.map((section) => <section key={section.heading}><h4>{section.heading}</h4>{section.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}
            <p className="decompile-terms-source">来源 JAR：{inspection.fileName}（sha256: {sourceSha256.slice(0, 16)}…）。接受记录会写入生成的项目目录。</p>
          </div>
        </> : null}
        {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={stage === 'terms' ? () => setStage('confirm') : onClose}>{stage === 'terms' ? '返回' : '取消'}</button>
          {stage === 'confirm' ? <button className="primary-button" disabled={busy || !name.trim() || !minecraftVersion.trim()} onClick={() => void startDecompile()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Binary size={16} />}反编译并接管
          </button> : <button className="primary-button decompile-danger-confirm" disabled={busy || !terms} onClick={() => void adopt()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <PackageOpen size={16} />}我已阅读并同意，创建项目
          </button>}
        </div>
      </div>
    </div>
  )
}

function ExistingImportPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (sourceType: 'folder' | 'zip') => void }): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog import-picker-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2>接管现有项目</h2><p>选择要导入的来源类型</p></div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="import-picker-options">
          <button className="project-launcher-action" type="button" onClick={() => onSelect('folder')}>
            <span className="project-launcher-icon open"><FolderOpen size={19} /></span>
            <span><strong>项目文件夹</strong><small>选择已经解压的源码或工程目录</small></span>
            <ChevronRight size={17} />
          </button>
          <button className="project-launcher-action archive-picker-action" type="button" onClick={() => onSelect('zip')}>
            <span className="project-launcher-icon adopt"><PackageOpen size={19} /></span>
            <span><strong>压缩包</strong><small>支持 ZIP、MRPack 格式，自动解压后识别并导入项目内容</small></span>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectInspectionDialog({ kind }: { kind: 'project' | 'mod' }): React.JSX.Element {
  const title = kind === 'mod' ? '接管现成模组' : '接管现有项目'
  const detail = kind === 'mod'
    ? '正在读取 JAR 描述文件、识别加载器与 Minecraft 版本，请稍候…'
    : '正在扫描文件、读取构建配置并识别项目类型，请稍候…'
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="dialog adopt-dialog inspection-dialog" role="dialog" aria-modal="true" aria-busy="true">
        <div className="dialog-header">
          <div><h2>{title}</h2><p>正在识别</p></div>
        </div>
        <div className="inspection-status" role="status">
          <LoaderCircle className="spin" size={22} />
          <div><strong>{kind === 'mod' ? '正在识别模组' : '正在识别项目'}</strong><span>{detail}</span></div>
        </div>
      </div>
    </div>
  )
}

/** 回退/编辑重发时只保留「用户提问 + AI 最终回答」，清掉工具步骤、进行中/中断残留等半处理中间态。 */
function isFinalInspirationMessage(message: InspirationChatMessage): boolean {
  return message.role === 'user' || (message.role === 'assistant' && message.kind !== 'tool' && message.status === 'completed')
}

function dedupeInspirationMessages(messages: InspirationChatMessage[]): InspirationChatMessage[] {
  return messages.reduce<InspirationChatMessage[]>((result, message) => {
    if (message.role !== 'assistant' || message.kind === 'tool') {
      result.push(message)
      return result
    }
    if (!message.content.trim()) return result
    let targetIndex = -1
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const candidate = result[index]
      if (candidate.role === 'user') break
      if (candidate.role === 'assistant' && candidate.kind !== 'tool') {
        targetIndex = index
        break
      }
    }
    if (targetIndex < 0) {
      result.push(message)
      return result
    }
    const existing = result[targetIndex]
    if (!existing.content.includes(message.content) && !message.content.includes(existing.content)) {
      result.push(message)
      return result
    }
    result[targetIndex] = {
      ...existing,
      ...message,
      content: message.content.length >= existing.content.length ? message.content : existing.content,
      status: message.status === 'error' || message.status === 'cancelled' ? message.status : message.isFinal ? message.status : existing.status,
      isFinal: message.isFinal ?? existing.isFinal
    }
    return result
  }, [])
}

function InspirationWorkspace({ project, visible, uiMode, deviceState, codingBackend, onBusyChange, onConnectionRequired, onSendToCoding }: {
  project: ProjectInfo
  visible: boolean
  uiMode: UiMode
  deviceState: DeviceConnectionState
  codingBackend: AgentSettings['codingBackend']
  onBusyChange: (busy: boolean) => void
  onConnectionRequired: () => void
  onSendToCoding: (prompt: string) => void
}): React.JSX.Element {
  const { confirm: confirmMessageAction, dialog: messageActionDialog } = useConfirmDialog()
  const [conversations, setConversations] = useState<InspirationConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<AiAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [thinkingSeconds, setThinkingSeconds] = useState(0)
  const [persistenceWarning, setPersistenceWarning] = useState('')
  const [attachmentReplayWarning, setAttachmentReplayWarning] = useState('')
  const sendTokenRef = useRef(0)
  const inspirationAttachmentRestoreTokenRef = useRef(0)
  const activeInspirationConversationIdRef = useRef('')
  const sessionResetConversationIdsRef = useRef(new Set<string>())
  const inspirationSessionRef = useRef('')
  const inspirationConversationRef = useRef('')
  const finalAnswerSessionRef = useRef('')
  const ignoredInspirationSessionRef = useRef('')
  const thinkingStartedAtRef = useRef<number | null>(null)
  const cancellingInspirationRef = useRef(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const quickPrompts = [
    '分析当前项目结构，指出已经实现的内容、缺口和最值得优先处理的风险',
    '结合现有代码，给我三个能融入当前模组的 Boss 设计，并说明战斗阶段和实现难点',
    '阅读导入的源码或 API 文档，告诉我可以利用哪些能力，以及它们适合做什么玩法',
    '基于当前项目给出下一步开发路线，按价值和工作量排序'
  ]
  const storageKey = `modmind-inspiration:${project.path}`
  const messages = conversations.find((conversation) => conversation.id === activeConversationId)?.messages ?? []
  const inspirationRows = buildInspirationRows(messages)

  useEffect(() => {
    activeInspirationConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  const updateConversationMessages = (conversationId: string, updater: (messages: InspirationChatMessage[]) => InspirationChatMessage[]): void => {
    if (!conversationId) return
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: boundInspirationMessages(updater(conversation.messages)), updatedAt: new Date().toISOString() }
      : conversation))
  }

  const updateActiveMessages = (updater: (messages: InspirationChatMessage[]) => InspirationChatMessage[]): void => {
    updateConversationMessages(activeConversationId, updater)
  }

  const [pendingEditTarget, setPendingEditTarget] = useState<{ conversationId: string; messageIndex: number } | null>(null)
  const editInspirationMessage = async (messageIndex: number, content: string): Promise<void> => {
    const conversationId = activeConversationId
    const restoreToken = ++inspirationAttachmentRestoreTokenRef.current
    const replay = messages[messageIndex]?.replay
    setDraft(replay?.prompt ?? content)
    setAttachments([])
    setAttachmentReplayWarning('')
    setPendingEditTarget({ conversationId, messageIndex })
    const replayAttachments = replay?.attachments ?? []
    if (!replayAttachments.length) return
    try {
      const restored = await window.modmind.ai.validateAttachments(replayAttachments, project.path)
      if (activeInspirationConversationIdRef.current !== conversationId || inspirationAttachmentRestoreTokenRef.current !== restoreToken) return
      setAttachments(restored)
      if (restored.length !== replayAttachments.length) {
        setAttachmentReplayWarning(`原消息的 ${replayAttachments.length - restored.length} 个附件已不存在；发送时会使用其余附件和已保存的文字上下文`)
      }
    } catch (error) {
      if (activeInspirationConversationIdRef.current !== conversationId || inspirationAttachmentRestoreTokenRef.current !== restoreToken) return
      setAttachmentReplayWarning(`附件恢复失败：${errorMessage(error)}；仍可按已保存的文字上下文发送`)
    }
  }
  const deleteInspirationMessage = async (messageIndex: number): Promise<void> => {
    if (!await confirmMessageAction({
      title: '删除这轮对话？',
      message: '相关的提问、分析步骤和回答会一起删除，此操作无法撤销。',
      confirmLabel: '删除对话',
      cancelLabel: '保留对话',
      tone: 'danger',
      actionIcon: 'delete'
    })) return
    setPendingEditTarget(null)
    sessionResetConversationIdsRef.current.add(activeConversationId)
    updateActiveMessages((current) => deleteInspirationTimelineItem(current, messageIndex))
  }
  const rewindInspirationTo = async (messageIndex: number): Promise<void> => {
    const selected = messages[messageIndex]
    if (!selected || !await confirmMessageAction({
      title: '截断后续对话？',
      message: selected.role === 'user' ? '这条提问及其后的内容会被移除。' : '这条回答会保留，其后的内容会被移除。',
      confirmLabel: '截断对话',
      cancelLabel: '保留全部',
      tone: 'danger',
      actionIcon: 'restore'
    })) return
    setPendingEditTarget(null)
    sessionResetConversationIdsRef.current.add(activeConversationId)
    updateActiveMessages((current) => rewindInspirationTimelineTo(current, messageIndex))
  }

  useEffect(() => {
    return window.modmind.ai.onOutput((event) => {
      if (event.projectPath && normalizeProjectPath(event.projectPath) !== normalizeProjectPath(project.path)) return
      if (event.sessionId !== inspirationSessionRef.current || !event.content.trim()) return
      if (event.sessionId === ignoredInspirationSessionRef.current) return
      const conversationId = inspirationConversationRef.current
      const sessionId = event.sessionId
      const step = (content: string, status: 'completed' | 'error' = 'completed'): InspirationChatMessage => ({
        role: 'assistant', kind: 'tool', id: `inspiration-step-${Date.now()}-${crypto.randomUUID()}`,
        content, time: new Date().toISOString(), status, isFinal: false, sessionId
      })
      const appendUniqueStep = (items: InspirationChatMessage[], item: InspirationChatMessage): InspirationChatMessage[] => {
        const previous = items.at(-1)
        return previous?.kind === 'tool' && previous.content.trim() === item.content.trim() ? items : [...items, item]
      }
      const demoteResponseAndAppendStep = (content: string, status: 'completed' | 'error' = 'completed'): void => {
        updateConversationMessages(conversationId, (current) => {
          const reverseIndex = [...current].reverse().findIndex((message) => message.role === 'assistant' && message.status === 'streaming' && message.sessionId === sessionId)
          if (reverseIndex < 0) return appendUniqueStep(current, step(content, status))
          const target = current.length - 1 - reverseIndex
          const streaming = current[target]
          let before = current.slice(0, target)
          if (streaming.content.trim()) before = appendUniqueStep(before, step(streaming.content))
          before = appendUniqueStep(before, step(content, status))
          return [...before, { ...streaming, content: '' }, ...current.slice(target + 1)]
        })
      }
      if (event.kind === 'answer') {
        if (!isUsableAiAnswer(event.content)) {
          demoteResponseAndAppendStep(event.content, 'error')
          return
        }
        finalAnswerSessionRef.current = sessionId
        updateConversationMessages(conversationId, (current) => {
          if (current.some((message) => message.role === 'assistant' && message.sessionId === sessionId && message.isFinal && message.content.trim() === event.content.trim())) return current
          const reverseIndex = [...current].reverse().findIndex((message) => message.role === 'assistant' && message.status === 'streaming' && message.sessionId === sessionId)
          const completed: InspirationChatMessage = { role: 'assistant', content: event.content, status: 'completed', isFinal: true, sessionId, time: event.time }
          if (reverseIndex < 0) return [...current, completed]
          const target = current.length - 1 - reverseIndex
          return current.map((message, index) => index === target ? completed : message)
        })
        return
      }
      if (event.kind === 'response') {
        if (isAiOperationalStatusText(event.content)) {
          demoteResponseAndAppendStep(event.content)
          return
        }
        updateConversationMessages(conversationId, (current) => {
          const reverseIndex = [...current].reverse().findIndex((message) => message.role === 'assistant' && message.status === 'streaming' && message.sessionId === sessionId)
          if (reverseIndex < 0) return current
          const target = current.length - 1 - reverseIndex
          const streaming = current[target]
          if (streaming.content === event.content) return current
          let before = current.slice(0, target)
          if (streaming.content.trim()) before = appendUniqueStep(before, step(streaming.content))
          return [...before, { ...streaming, content: event.content }, ...current.slice(target + 1)]
        })
        return
      }
      if (event.kind === 'delta') {
        updateConversationMessages(conversationId, (current) => current.map((message) => {
          if (message.role !== 'assistant' || message.status !== 'streaming' || message.sessionId !== sessionId) return message
          const content = !message.content || event.content.startsWith(message.content)
            ? event.content
            : message.content.endsWith(event.content) ? message.content : `${message.content}${event.content}`
          return { ...message, content }
        }))
        return
      }
      if (event.kind === 'retry' || event.kind === 'tool' || event.kind === 'warning' || event.kind === 'error' || event.kind === 'start') {
        demoteResponseAndAppendStep(event.content, event.kind === 'warning' || event.kind === 'error' ? 'error' : 'completed')
      }
    })
  }, [project.path])

  useEffect(() => {
    setPendingEditTarget(null)
    sessionResetConversationIdsRef.current.clear()
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { activeId?: string; conversations?: InspirationConversation[] } | null
      const valid = Array.isArray(saved?.conversations) ? saved.conversations
        .filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.messages))
        .map((entry) => ({ ...entry, messages: dedupeInspirationMessages(normalizeStoredInspirationMessages(entry.messages)) })) : []
      const fallback: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
      const list = valid.length ? valid : [fallback]
      const active = list.find((entry) => entry.id === saved?.activeId) ?? list[0]
      setConversations(list)
      setActiveConversationId(active.id)
    } catch {
      const fallback: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
      setConversations([fallback])
      setActiveConversationId(fallback.id)
    }
    setHydrated(true)
  }, [storageKey])

  useEffect(() => {
    if (!hydrated || !activeConversationId) return
    const result = persistInspirationHistory(window.localStorage, storageKey, { activeId: activeConversationId, conversations })
    setPersistenceWarning(result.status === 'unavailable' ? '灵感历史暂时无法保存；当前对话仍可继续使用' : '')
  }, [conversations, activeConversationId, hydrated, storageKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  useEffect(() => {
    if (!busy || thinkingStartedAtRef.current === null) return
    const updateElapsed = (): void => setThinkingSeconds(Math.max(0, Math.floor((Date.now() - thinkingStartedAtRef.current!) / 1_000)))
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [busy])

  const send = async (value = draft): Promise<void> => {
    const requestedContent = value.trim()
    if ((!requestedContent && !attachments.length) || busy) return
    const content = requestedContent || '请分析我上传的附件'
    setAttachmentReplayWarning('')
    const attachmentContext = formatAiAttachmentContext(attachments)
    const selectedBackend: AgentSettings['codingBackend'] = uiMode === 'beginner' ? 'quota' : codingBackend
    const usesQuota = selectedBackend === 'quota'
    if (usesQuota && deviceState.status !== 'connected') {
      onConnectionRequired()
      return
    }
    inspirationAttachmentRestoreTokenRef.current += 1
    const conversationId = activeConversationId
    const editIndex = pendingEditTarget?.conversationId === conversationId
      && pendingEditTarget.messageIndex >= 0
      && pendingEditTarget.messageIndex < messages.length
      ? pendingEditTarget.messageIndex
      : null
    const resetSession = sessionResetConversationIdsRef.current.delete(conversationId)
    const needsReset = editIndex !== null || resetSession
    const baseMessages = needsReset
      ? (editIndex !== null ? messages.slice(0, editIndex) : messages).filter(isFinalInspirationMessage)
      : messages
    if (pendingEditTarget?.conversationId === conversationId) setPendingEditTarget(null)
    const resumeSession = needsReset ? false : shouldResumeInspirationSession(messages)
    const handoff = needsReset
      ? inspirationConversationHandoff(baseMessages)
      : (!resumeSession && messages.length ? inspirationConversationHandoff(messages) : '')
    const inspirationPrompt = `Answer the user's latest inspiration question in Simplified Chinese. Default to a direct, concrete answer. Only inspect project files when the answer genuinely depends on current implementation details. Do not modify files.\n\n${handoff ? `RECENT CONVERSATION CONTEXT\n${handoff}\n\n` : ''}LATEST QUESTION\n${content}${attachmentContext}`
    const attachmentKeys = attachments.map((attachment) => `${attachment.path}:${attachment.size}`)
    const dedupeKey = aiPromptFingerprint(content, attachmentKeys)
    const sendToken = ++sendTokenRef.current
    const sessionId = `inspiration-${conversationId}-${Date.now()}-${sendToken}-${crypto.randomUUID()}`
    inspirationConversationRef.current = conversationId
    inspirationSessionRef.current = sessionId
    finalAnswerSessionRef.current = ''
    ignoredInspirationSessionRef.current = ''
    updateActiveMessages((current) => {
      const base = needsReset
        ? (editIndex !== null ? current.slice(0, editIndex) : current)
        : current
      return [...base,
        {
          role: 'user',
          content: `${content}${attachments.length ? `\n\n已附 ${attachments.length} 个文件` : ''}`,
          status: 'completed',
          replay: { prompt: content, ...(attachments.length ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}) }
        },
        { role: 'assistant', content: '', status: 'streaming', isFinal: false, sessionId }
      ]
    })
    updateConversationMessages(conversationId, (current) => current.map((message, index) => index === current.length - 2 ? { ...message, dedupeKey } : message))
    setDraft('')
    thinkingStartedAtRef.current = Date.now()
    setThinkingSeconds(0)
    setBusy(true)
    onBusyChange(true)
    try {
      if (usesQuota && deviceState.keyStatus === 'FROZEN') {
        throw new Error('当前账号暂不可用，请前往网站查看账号状态后再继续')
      }
      const result = await window.modmind.ai.createCode(
        inspirationPrompt,
        sessionId,
        selectedBackend,
        usesQuota ? 'beginner-unlimited' : 'standard',
        { surface: 'inspiration', sessionScope: `inspiration/${conversationId}`, resumeSession, inspirationQuestion: content, projectPath: project.path, fallbackPrompt: inspirationPrompt }
      )
      if (sendToken !== sendTokenRef.current) return
      const reply = finalInspirationReply(result)
      if (reply && finalAnswerSessionRef.current !== sessionId) {
        finalAnswerSessionRef.current = sessionId
        updateConversationMessages(conversationId, (current) => settleInspirationReply(current, sessionId, reply, ''))
      } else if (!reply && finalAnswerSessionRef.current !== sessionId) {
        updateConversationMessages(conversationId, (current) => settleInspirationReply(current, sessionId, '', '上游模型完成了请求，但没有返回可显示的回答。灵感台没有把状态信息当作答案，请重试。'))
      }
      setAttachments([])
    } catch (error) {
      if (sendToken !== sendTokenRef.current) return
      const failure = aiFailureMessage(error)
      updateConversationMessages(conversationId, (current) => settleInspirationFailure(current, sessionId, failure))
    } finally {
      if (sendToken !== sendTokenRef.current) {
        updateConversationMessages(conversationId, (current) => settleInspirationCancellation(current, sessionId))
      }
      setBusy(false)
      thinkingStartedAtRef.current = null
      onBusyChange(false)
    }
  }

  const cancelInspiration = (): void => {
    if (cancellingInspirationRef.current) return
    const conversationId = inspirationConversationRef.current
    const sessionId = inspirationSessionRef.current
    sendTokenRef.current += 1
    ignoredInspirationSessionRef.current = sessionId
    updateConversationMessages(conversationId, (current) => current.map((message) => message.status === 'streaming' && message.sessionId === sessionId
      ? { ...message, content: message.content || '正在停止任务…' }
      : message))
    cancellingInspirationRef.current = true
    void window.modmind.ai.cancelCode(sessionId || undefined, project.path)
      .then((result) => {
        if (result.status === 'timed_out') {
          updateConversationMessages(conversationId, (current) => current.map((message) => message.status === 'streaming' && message.sessionId === sessionId
            ? { ...message, content: message.content || 'Agent 进程尚未完全退出，可再次停止' }
            : message))
          return
        }
        updateConversationMessages(conversationId, (current) => settleInspirationCancellation(current, sessionId))
        setBusy(false)
        thinkingStartedAtRef.current = null
        onBusyChange(false)
      })
      .catch((error) => {
        updateConversationMessages(conversationId, (current) => current.map((message) => message.status === 'streaming' && message.sessionId === sessionId
          ? { ...message, content: `停止失败：${errorMessage(error)}` }
          : message))
      })
      .finally(() => { cancellingInspirationRef.current = false })
  }

  const startNewConversation = (): void => {
    if (busy) return
    const conversation: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
    setConversations((current) => [conversation, ...current])
    setActiveConversationId(conversation.id)
    inspirationConversationRef.current = conversation.id
    inspirationSessionRef.current = ''
    finalAnswerSessionRef.current = ''
    setPendingEditTarget(null)
    setDraft('')
  }

  const selectConversation = (conversation: InspirationConversation): void => {
    setActiveConversationId(conversation.id)
    if (!busy) {
      inspirationConversationRef.current = conversation.id
      inspirationSessionRef.current = ''
      finalAnswerSessionRef.current = ''
    }
    setPendingEditTarget(null)
    setDraft('')
  }

  return <>
    <div className="inspiration-page" hidden={!visible}>
      <div className="content-toolbar">
        <div><h1>{uiMode === 'beginner' ? '灵感' : '灵感台'}</h1><p>只读分析与创意讨论，不执行编程</p></div>
        <div className="inspiration-toolbar"><span className="inspiration-model-state"><Lightbulb size={15} />{uiMode === 'beginner' ? '智能灵感顾问' : '项目顾问'}</span><button className="secondary-button compact" type="button" onClick={startNewConversation}><Plus size={14} />新对话</button></div>
      </div>
      <div className="inspiration-layout">
        <aside className="inspiration-sidebar">
          <div className="inspiration-project"><span className="project-launcher-icon project"><Box size={18} /></span><div><strong>{project.name}</strong><small>{platformLabel(project.loader)} · {project.minecraftVersion}</small></div></div>
          <dl><div><dt>命名空间</dt><dd>{project.namespace}</dd></div><div><dt>项目位置</dt><dd title={project.path}>{project.path}</dd></div></dl>
           <div className="inspiration-quick"><span>快速提问</span>{quickPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => void send(prompt)}>{prompt}<ChevronRight size={14} /></button>)}</div>
           <div className="inspiration-history"><span>历史对话</span>{conversations.slice(0, 8).map((conversation) => <button key={conversation.id} className={conversation.id === activeConversationId ? 'active' : ''} type="button" onClick={() => selectConversation(conversation)}>{conversation.title}<small>{conversation.messages.length} 条消息</small></button>)}</div>
        </aside>
        <section className="inspiration-chat">
          <div className="inspiration-messages">
            {!messages.length ? <div className="inspiration-empty"><Lightbulb size={30} /><h2>从项目本身开始思考</h2><p>询问现有实现、技术风险、API 用法或玩法灵感</p></div> : null}
            {inspirationRows.map((row) => {
              if (row.kind === 'tool-group') return <InspirationStepGroup items={row.items} key={row.id} />
              const { message } = row
              const retryPrompt = message.role === 'assistant' && (message.status === 'error' || message.status === 'cancelled')
                ? messages.slice(0, row.index).reverse().find((candidate) => candidate.role === 'user')?.content.replace(/\n\n已附 \d+ 个文件$/, '')
                : undefined
              return <div className={`inspiration-message ${message.role} ${message.status === 'error' || message.status === 'cancelled' ? 'error' : ''}`} key={row.id}>
                <span>{message.role === 'assistant' ? <Bot size={16} /> : <UserRound size={16} />}</span>
                <div><strong>{message.role === 'assistant' ? '灵感台' : '你'}</strong>{message.role === 'assistant' ? <><MarkdownMessage content={message.content} />{message.isFinal && message.status === 'completed' && !busy ? <button className="message-action" type="button" onClick={() => onSendToCoding(message.content)}><Code2 size={13} />交给工作台</button> : null}{message.isFinal && retryPrompt && !busy ? <button className="message-action" type="button" onClick={() => void send(retryPrompt)}><RotateCcw size={13} />重试</button> : null}</> : <p>{message.content}</p>}{!busy ? <div className="inspiration-message-actions">{message.role === 'user' ? <button type="button" title="编辑并重新发送" aria-label="编辑并重新发送" onClick={() => void editInspirationMessage(row.index, message.content)}><Pencil size={12} /></button> : null}<button type="button" title="删除这轮对话" aria-label="删除这轮对话" onClick={() => void deleteInspirationMessage(row.index)}><Trash2 size={12} /></button><button type="button" title={message.role === 'user' ? '从这条提问重新开始' : '保留此回答并截断后续对话'} aria-label={message.role === 'user' ? '从这条提问重新开始' : '保留此回答并截断后续对话'} onClick={() => void rewindInspirationTo(row.index)}><Undo2 size={12} /></button></div> : null}</div>
              </div>
            })}
            {busy ? <div className="inspiration-thinking-status" role="status"><span>灵感台思考中</span><time>{thinkingSeconds}s</time></div> : null}
            <div ref={endRef} />
          </div>
          <div className="inspiration-composer">
            <textarea value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !(event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() } }} placeholder="询问项目结构、API 用法或玩法灵感" />
             <div className="inspiration-composer-actions"><AiAttachmentPicker attachments={attachments} onChange={setAttachments} disabled={busy} onError={(error) => { if (uiMode !== 'advanced') updateActiveMessages((current) => [...current, { role: 'assistant', content: `无法添加附件：${errorMessage(error)}`, status: 'error' }]) }} />{busy ? <button className="secondary-button compact" type="button" onClick={cancelInspiration}><X size={14} />暂停任务</button> : null}<button className="send-button" title="发送" disabled={busy || (!draft.trim() && !attachments.length)} onClick={() => void send()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>
          </div>
          {attachmentReplayWarning || persistenceWarning ? <div className="inspiration-persistence-warning" role="status"><CircleAlert size={14} />{attachmentReplayWarning || persistenceWarning}</div> : null}
        </section>
      </div>
    </div>
    {messageActionDialog}
  </>
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: ProjectInfo) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [projectKind, setProjectKind] = useState<ProjectKind>('mod')
  const [edition, setEdition] = useState<'java' | 'bedrock' | 'netease'>('java')
  const [loader, setLoader] = useState<LoaderKind>('fabric')
  const [version, setVersion] = useState('1.21.1')
  const [catalog, setCatalog] = useState<LoaderVersionOption[]>([])
  const [catalogBusy, setCatalogBusy] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.modmind.project.listLoaderVersions().then((options) => {
      setCatalog(options)
      setCatalogBusy(false)
    }).catch((reason) => {
      setError(errorMessage(reason))
      setCatalogBusy(false)
    })
  }, [])

  const availableVersions = catalog.filter((option) => option.loader === loader)
  const selectedOption = availableVersions.find((option) => option.minecraftVersion === version)

  const selectEdition = (next: 'java' | 'bedrock' | 'netease'): void => {
    setEdition(next)
    setLoader(next === 'java' ? 'fabric' : next === 'bedrock' ? 'bedrock' : 'netease-mobile')
    setVersion('')
  }

  useEffect(() => {
    if (!availableVersions.length || availableVersions.some((option) => option.minecraftVersion === version)) return
    setVersion(availableVersions[0].minecraftVersion)
  }, [loader, catalog, version, availableVersions])

  const create = async (): Promise<void> => {
    if (!name.trim()) return setError('请输入项目名称')
    setBusy(true)
    setError('')
    try {
      const project = await window.modmind.project.create({ name, loader, minecraftVersion: version, kind: projectKind })
      if (project) onCreated(project)
      else setBusy(false)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <h2>新建 Minecraft 项目</h2>
            <p>先选择你实际游玩的版本，ModMind 将生成对应的完整工程</p>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <label className="field-label">
          项目名称
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：经验水晶" />
        </label>
        <div className="field-label">
          项目类型
          <div className="segmented-control">
            <button className={projectKind === 'mod' ? 'active' : ''} onClick={() => setProjectKind('mod')}>自制 Mod</button>
            <button className={projectKind === 'modpack' ? 'active' : ''} onClick={() => { setProjectKind('modpack'); selectEdition('java') }}>整合包</button>
          </div>
        </div>
        <div className="field-label">
          游戏平台
          <div className="segmented-control">
            <button className={edition === 'java' ? 'active' : ''} onClick={() => selectEdition('java')}>Java 版</button>
            <button disabled={projectKind === 'modpack'} className={edition === 'bedrock' ? 'active' : ''} onClick={() => selectEdition('bedrock')}>国际基岩版</button>
            <button disabled={projectKind === 'modpack'} className={edition === 'netease' ? 'active' : ''} onClick={() => selectEdition('netease')}>网易版</button>
          </div>
        </div>
        {edition === 'java' ? <div className="field-label">加载器<div className="segmented-control">
          <button className={loader === 'fabric' ? 'active' : ''} onClick={() => setLoader('fabric')}>Fabric</button>
          <button className={loader === 'quilt' ? 'active' : ''} onClick={() => setLoader('quilt')}>Quilt</button>
          <button className={loader === 'forge' ? 'active' : ''} onClick={() => setLoader('forge')}>Forge</button>
          <button className={loader === 'neoforge' ? 'active' : ''} onClick={() => setLoader('neoforge')}>NeoForge</button>
        </div></div> : null}
        {edition === 'netease' ? <div className="field-label">运行目标<div className="segmented-control">
          <button className={loader === 'netease-mobile' ? 'active' : ''} onClick={() => { setLoader('netease-mobile'); setVersion('') }}>网易手游</button>
          <button className={loader === 'netease-pc' ? 'active' : ''} onClick={() => { setLoader('netease-pc'); setVersion('') }}>网易 PC</button>
        </div></div> : null}
        <label className="field-label">
          {edition === 'java' ? 'Minecraft 版本' : edition === 'bedrock' ? '最低兼容基岩版本' : 'Mod SDK 版本'}
          <select value={version} disabled={catalogBusy || !availableVersions.length} onChange={(event) => setVersion(event.target.value)}>
            {availableVersions.map((option) => <option key={`${option.loader}-${option.minecraftVersion}`} value={option.minecraftVersion}>{option.minecraftVersion}{option.supportTier === 'experimental' ? '（实验性）' : ''}</option>)}
          </select>
          {catalogBusy ? <small>正在读取加载器兼容目录…</small> : null}
          {selectedOption?.notes.map((note) => <small key={note}>{note}</small>)}
        </label>
        {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || catalogBusy || !availableVersions.length} onClick={() => void create()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建项目
          </button>
        </div>
      </div>
    </div>
  )
}

type DeviceAccountDialogProps = {
  state: DeviceConnectionState
  remoteState: RemoteConnectionState
  busy: boolean
  remoteBusy: boolean
  onClose: () => void
  onAuthorize: () => void
  onCancel: () => void
  onDisconnect: () => void
  onRefresh: () => void
  onOpenSite: () => void
  onRemoteToggle: () => void
}

function DeviceAccountDialog({ state, remoteState, busy, remoteBusy, onClose, onAuthorize, onCancel, onDisconnect, onRefresh, onOpenSite, onRemoteToggle }: DeviceAccountDialogProps): React.JSX.Element {
  const balance = formatBalanceCents(state.balanceCents)
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog hosted-account-dialog" role="dialog" aria-modal="true" aria-labelledby="device-account-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><h2 id="device-account-title">ModMind 设备连接</h2><p>管理本机授权凭证和站内余额</p></div><button className="icon-button" type="button" title="关闭" onClick={onClose}><X size={17} /></button></div>
        {state.status === 'connected' ? (
          <>
            <div className="hosted-dialog-profile"><span className="hosted-account-avatar"><UserRound size={16} /></span><div><strong>{state.username ?? '已连接账号'}</strong><small>{state.keyStatus === 'FROZEN' ? (state.frozenReason ?? 'Key 已冻结') : '设备已安全连接'}</small></div><button className="text-button" type="button" disabled={busy} onClick={onDisconnect}>断开设备</button></div>
            <div className="hosted-dialog-balance"><span>站内余额</span><div><strong>{balance}</strong></div></div>
            <div className="hosted-dialog-balance"><span className="remote-workbench-label">远程工作台<small className="remote-workbench-beta">beta</small></span><div><strong>{remoteState.status === 'ready' ? '在线' : remoteState.status === 'connecting' || remoteState.status === 'authenticating' || remoteState.status === 'backoff' ? '连接中' : remoteState.status === 'error' ? '不可用' : '未启动'}</strong><button className={`remote-toggle-button${remoteState.enabled ? ' stop' : ''}`} type="button" disabled={busy || remoteBusy} onClick={onRemoteToggle}>{remoteBusy ? <LoaderCircle className="spin" size={12} /> : remoteState.enabled ? <Square size={11} fill="currentColor" /> : <Play size={12} />}{remoteBusy ? '处理中' : remoteState.enabled ? '断开' : '开启'}</button></div></div>
            <div className="dialog-footer"><button className="secondary-button" type="button" disabled={busy} onClick={onRefresh}><RotateCcw size={15} />刷新用量</button><button className="primary-button" type="button" disabled={busy} onClick={onOpenSite}><ExternalLink size={15} />前往网站</button></div>
          </>
        ) : state.status === 'authorizing' ? (
          <>
            <p className="recovery-copy">{state.message ?? '请在浏览器中完成授权'}</p>
            <div className="dialog-footer"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}><X size={15} />取消授权</button></div>
          </>
        ) : (
          <div className="dialog-footer"><button className="secondary-button" type="button" disabled={busy || !state.configured} onClick={onOpenSite}><ExternalLink size={15} />前往网站</button><button className="primary-button" type="button" disabled={busy || !state.configured} onClick={onAuthorize}>{busy ? <LoaderCircle className="spin" size={15} /> : <UserRound size={15} />}打开浏览器连接</button></div>
        )}
        {state.message ? <p className="hosted-dialog-message">{state.message}</p> : null}
      </div>
    </div>
  )
}

function InfoTooltip({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <span className={`info-tooltip ${className}`} tabIndex={0} aria-label="信息"><Info size={13} aria-hidden="true" /><span className="info-tooltip-content" role="tooltip">{children}</span></span>
}

function animateModeSurface(
  element: HTMLElement | null,
  animationRef: { current: Animation | null },
  reducedMotion: boolean,
  fromOpacity: string,
  fromTransform: string,
  duration: number
): void {
  if (!element) return
  const activeAnimation = animationRef.current?.playState === 'running' ? animationRef.current : null
  const computed = getComputedStyle(element)
  const startOpacity = activeAnimation ? computed.opacity : fromOpacity
  const startTransform = activeAnimation && computed.transform !== 'none' ? computed.transform : fromTransform
  animationRef.current?.cancel()

  const animation = element.animate(
    reducedMotion
      ? [{ opacity: startOpacity }, { opacity: '1' }]
      : [{ opacity: startOpacity, transform: startTransform }, { opacity: '1', transform: 'translate(0, 0)' }],
    { duration: reducedMotion ? 140 : duration, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
  )
  animationRef.current = animation
  void animation.finished.then(() => {
    if (animationRef.current === animation) animationRef.current = null
  }).catch(() => undefined)
}

export default function App(): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const { prompt: requestPrompt, dialog: promptDialog } = usePromptDialog()
  const [view, setView] = useState<ViewId>(initialDetachedView ?? 'workspace')
  // 用户插件系统：注册表快照（零插件时为空，侧边栏不加任何分组）
  const [pluginSnapshot, setPluginSnapshot] = useState<PluginSnapshot>({ plugins: [] })
  useEffect(() => {
    let disposed = false
    void window.modmind.plugins.list().then((snapshot) => {
      if (!disposed) setPluginSnapshot(snapshot)
    }).catch(() => undefined)
    const unsubscribe = window.modmind.plugins.onChanged((snapshot) => setPluginSnapshot(snapshot))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  const [uiMode, setUiMode] = useState<UiMode>(() => {
    try {
      return localStorage.getItem('modmind-ui-mode') === 'advanced' ? 'advanced' : 'beginner'
    } catch {
      return 'beginner'
    }
  })
  const uiModeRef = useRef<UiMode>(uiMode)
  uiModeRef.current = uiMode
  const [lastAdvancedView, setLastAdvancedView] = useState<ViewId>('workspace')
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [recentProjects, setRecentProjects] = useState<ProjectInfo[]>([])
  const [projectLauncherOpen, setProjectLauncherOpen] = useState(() => !isDetachedWindow)
  const [existingAnalysis, setExistingAnalysis] = useState<ExistingProjectAnalysis | null>(null)
  const [existingImportPicker, setExistingImportPicker] = useState(false)
  const [existingInspecting, setExistingInspecting] = useState(false)
  const [decompileJarHandoff, setDecompileJarHandoff] = useState<string | null>(null)
  const [modJarInspection, setModJarInspection] = useState<DecompileInspectResult | null>(null)
  const [modJarInspecting, setModJarInspecting] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [renamingProject, setRenamingProject] = useState<ProjectInfo | null>(null)
  const [files, setFiles] = useState<FileNode[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorDirty, setEditorDirty] = useState(false)
  const [workbenchUi, dispatchWorkbenchUi] = useReducer(workbenchUiReducer, initialWorkbenchUiState)
  const {
    prompt,
    attachments: aiAttachments,
    plan: aiPlan,
    todo: aiTodo,
    planning,
    processingStartedAt,
    taskState: beginnerTaskState,
    timeline: aiTimeline,
    outputStatus: aiOutputStatus,
    recovery: aiRecovery
  } = workbenchUi
  const setWorkbenchValue = <Key extends keyof WorkbenchUiState>(key: Key, value: SetStateAction<WorkbenchUiState[Key]>): void => {
    dispatchWorkbenchUi({ key, value })
  }
  const setPrompt = (value: SetStateAction<string>): void => setWorkbenchValue('prompt', value)
  const setAiAttachments = (value: SetStateAction<AiAttachment[]>): void => setWorkbenchValue('attachments', value)
  const setAiPlan = (value: SetStateAction<AiPlan | null>): void => setWorkbenchValue('plan', value)
  const setAiTodo = (value: SetStateAction<WorkbenchUiState['todo']>): void => setWorkbenchValue('todo', value)
  const setProcessingStartedAt = (value: SetStateAction<string | undefined>): void => setWorkbenchValue('processingStartedAt', value)
  const setPlanning = (value: SetStateAction<boolean>): void => {
    setWorkbenchValue('planning', value)
    if (typeof value === 'boolean') setProcessingStartedAt(value ? (current) => current ?? new Date().toISOString() : undefined)
  }
  const setBeginnerTaskState = (value: SetStateAction<BeginnerTaskState>): void => setWorkbenchValue('taskState', value)
  const setAiTimeline = (value: SetStateAction<AiTimelineItem[]>): void => setWorkbenchValue('timeline', value)
  const setAiOutputStatus = (value: SetStateAction<WorkbenchUiState['outputStatus']>): void => setWorkbenchValue('outputStatus', value)
  const setAiRecovery = (value: SetStateAction<AiRecoveryInfo | null>): void => setWorkbenchValue('recovery', value)
  const [pendingWorkbenchEdit, setPendingWorkbenchEdit] = useState<{ conversationId: string; itemId: string } | null>(null)
  const sessionResetConversationIdsRef = useRef(new Set<string>())
  const workbenchAttachmentRestoreTokenRef = useRef(0)
  const handleEditTimelineItem = async (id: string, content: string): Promise<void> => {
    const conversationId = activeWorkbenchConversationIdRef.current
    const projectPath = project?.path
    const restoreToken = ++workbenchAttachmentRestoreTokenRef.current
    const selected = aiTimelineRef.current.find((item) => item.id === id)
    if (!conversationId || !projectPath || !await requestConfirm({
      title: '编辑并重新发送这条消息？',
      message: '只会重置对话上下文，不会撤销 Agent 已经写入项目的文件。需要恢复代码时，请使用“版本记录”中的快照。',
      confirmLabel: '继续编辑',
      cancelLabel: '取消',
      actionIcon: 'continue'
    })) return
    const replay = selected?.replay
    setPrompt(replay?.prompt ?? content)
    setAiAttachments([])
    setPendingWorkbenchEdit({ conversationId, itemId: id })
    const replayAttachments = replay?.attachments ?? []
    if (!replayAttachments.length) {
      setNotice('已回填到输入框；发送后将从这条消息重建对话上下文，项目文件保持当前状态')
      return
    }
    try {
      const restored = await window.modmind.ai.validateAttachments(replayAttachments, projectPath)
      if (activeWorkbenchConversationIdRef.current !== conversationId || workbenchAttachmentRestoreTokenRef.current !== restoreToken) return
      setAiAttachments(restored)
      const missing = replayAttachments.length - restored.length
      setNotice(missing
        ? `已恢复 ${restored.length} 个附件；${missing} 个附件已不存在，将使用已保存的文字上下文回退`
        : `已恢复 ${restored.length} 个附件；发送后将从这条消息重建对话上下文，项目文件保持当前状态`)
    } catch (error) {
      if (activeWorkbenchConversationIdRef.current !== conversationId || workbenchAttachmentRestoreTokenRef.current !== restoreToken) return
      setNotice(`附件恢复失败：${errorMessage(error)}；仍可使用已保存的文字上下文发送`)
    }
  }
  const handleDeleteTimelineItem = async (id: string): Promise<void> => {
    const conversationId = activeWorkbenchConversationIdRef.current
    if (!conversationId || !await requestConfirm({
      title: '删除这轮工作台对话？',
      message: '对话记录会被删除，但 Agent 已经修改的项目文件不会撤销。',
      detail: '需要恢复代码时，请使用“版本记录”中的快照。',
      confirmLabel: '删除对话',
      cancelLabel: '保留对话',
      tone: 'danger',
      actionIcon: 'delete'
    })) return
    setAiTimeline((current) => workbenchDeleteTimelineItem(current, id))
    setPendingWorkbenchEdit(null)
    sessionResetConversationIdsRef.current.add(conversationId)
  }
  const handleRewindTimelineTo = async (id: string): Promise<void> => {
    const conversationId = activeWorkbenchConversationIdRef.current
    const selected = aiTimelineRef.current.find((item) => item.id === id)
    if (!conversationId || !selected || !await requestConfirm({
      title: '截断后续工作台对话？',
      message: `${selected.kind === 'user' ? '这条提问及其后的对话会被移除' : '这条回答会保留，其后的对话会被移除'}，项目文件不会回滚。`,
      detail: '需要恢复代码时，请使用“版本记录”中的快照。',
      confirmLabel: '截断对话',
      cancelLabel: '保留全部',
      tone: 'danger',
      actionIcon: 'restore'
    })) return
    setAiTimeline((current) => workbenchRewindTimelineTo(current, id))
    setPendingWorkbenchEdit(null)
    sessionResetConversationIdsRef.current.add(conversationId)
  }
  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [buildResult, setBuildResult] = useState<PreflightResult | null>(null)
  const [buildError, setBuildError] = useState('')
  const [minecraftEvents, setMinecraftEvents] = useState<MinecraftRuntimeEvent[]>([])
  const [building, setBuilding] = useState(false)
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [restoringSnapshotId, setRestoringSnapshotId] = useState('')
  const [deletingSnapshotId, setDeletingSnapshotId] = useState('')
  const [loaderCatalog, setLoaderCatalog] = useState<LoaderVersionOption[]>([])
  const [migrationLoader, setMigrationLoader] = useState<LoaderKind>('fabric')
  const [migrationVersion, setMigrationVersion] = useState('')
  const [migrationPreview, setMigrationPreview] = useState<ProjectMigrationPreview | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [settings, setSettings] = useState<AgentSettings>(initialSettings)
  const settingsRef = useRef<AgentSettings>(initialSettings)
  settingsRef.current = settings
  const settingsMutationRef = useRef(0)
  const settingsSaveTailRef = useRef(Promise.resolve())
  const [runningBackend, setRunningBackend] = useState<CodingBackend | undefined>(undefined)
  const [switchingBackend, setSwitchingBackend] = useState<CodingBackend | null>(null)
  const backendSwitchCounterRef = useRef(0)
  const backendSwitchGenerationRef = useRef(0)
  const switchingBackendRef = useRef<CodingBackend | null>(null)
  const pendingBackendSwitchRef = useRef<PendingBackendSwitch | null>(null)
  const backendSwitchRequestsRef = useRef(new Map<number, PendingBackendSwitch>())
  const cancelAiPromiseRef = useRef<Promise<void> | null>(null)
  switchingBackendRef.current = switchingBackend
  const [detectedJavaHomes, setDetectedJavaHomes] = useState<DetectedJavaHome[]>([])
  const [javaScanState, setJavaScanState] = useState<'idle' | 'scanning' | 'done' | 'failed'>('idle')
  const javaScanRequestedRef = useRef(false)
  const [imageStudioSettings, setImageStudioSettings] = useState<ImageStudioSettings>({ baseUrl: 'https://ai.soulecho.cc/v1', model: 'gpt-image-2', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true })
  const [imageApiKey, setImageApiKey] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [pageGuideOpen, setPageGuideOpen] = useState(false)
  const [activeTour, setActiveTour] = useState<'page' | 'shell' | null>(null)
  useEffect(() => {
    try {
      if (localStorage.getItem(GUIDE_AUTO_DISABLED_KEY)) return
      if (localStorage.getItem(pageGuideSeenKey(view))) return
      localStorage.setItem(pageGuideSeenKey(view), 'auto')
      setPageGuideOpen(true)
    } catch {
      /* localStorage 不可用时跳过自动弹出 */
    }
  }, [view])
  const [sidebarOrders, setSidebarOrders] = useState<Record<string, string[]>>({})
  const [sidebarGroupOrder, setSidebarGroupOrder] = useState<string[]>([])
  const [detachedSidebarItemIds, setDetachedSidebarItemIds] = useState<Set<ViewId>>(() => new Set())
  const [detachedSidebarGroupKeys, setDetachedSidebarGroupKeys] = useState<Set<string>>(() => new Set())
  const [sidebarDraggedId, setSidebarDraggedId] = useState<ViewId | null>(null)
  const [sidebarDropTargetId, setSidebarDropTargetId] = useState<ViewId | null>(null)
  const [sidebarDraggedGroupKey, setSidebarDraggedGroupKey] = useState<string | null>(null)
  const [sidebarGroupDropTargetKey, setSidebarGroupDropTargetKey] = useState<string | null>(null)
  const [detachedAlwaysOnTop, setDetachedAlwaysOnTop] = useState(false)
  const [titlebarMenuOpen, setTitlebarMenuOpen] = useState(false)
  const titlebarMenuRef = useRef<HTMLDivElement | null>(null)
  const mainContentRef = useRef<HTMLElement | null>(null)
  const viewScrollPositionsRef = useRef<Record<string, number>>({})
  const modeAnimationRef = useRef<Animation | null>(null)
  const sidebarNavRef = useRef<HTMLElement | null>(null)
  const sidebarAnimationRef = useRef<Animation | null>(null)
  const sidebarDragItemRef = useRef<SidebarDragItem | null>(null)
  const sidebarDragGroupKeyRef = useRef<string | null>(null)
  const sidebarDropHandledRef = useRef(false)
  const sidebarDragScrollFrameRef = useRef<number | null>(null)
  const sidebarDragScrollVelocityRef = useRef(0)
  const sidebarLayoutSnapshotRef = useRef<Map<string, DOMRect>>(new Map())
  const sidebarLayoutAnimationsRef = useRef<Map<string, Animation>>(new Map())
  const pageSnapshotsRef = useRef<Map<string, DiagnosticPageSnapshot>>(new Map())
  const previousUiModeRef = useRef(uiMode)
  const [giteeSettings, setGiteeSettings] = useState<GiteeBuildSettings>({ repositoryUrl: '', branch: 'main', token: '' })
  const [giteeValidation, setGiteeValidation] = useState<GiteeBuildValidation | null>(null)
  const [giteeBuildResult, setGiteeBuildResult] = useState<GiteeBuildResult | null>(null)
  const [giteeBuildBusy, setGiteeBuildBusy] = useState<'save' | 'validate' | 'build' | ''>('')
  const [notice, setNoticeState] = useState('')
  const setNotice = (message: string): void => {
    // Advanced mode keeps failures available to the agent/diagnostics while
    // removing noisy error toasts from the operator-facing surface.
    if (uiModeRef.current === 'advanced' && /(failure|failed|error|unable|cannot|forbidden|timeout|insufficient|失败|错误|无法|不能|不足|异常|拒绝|超时|未通过|未完成)/i.test(message)) {
      setNoticeState('')
      return
    }
    setNoticeState(message)
  }
  const setErrorNotice = (message: string): void => {
    if (uiModeRef.current !== 'advanced') setNoticeState(message)
  }

  const capturePageSnapshot = (): DiagnosticPageSnapshot | null => {
    if (typeof document === 'undefined' || !document.documentElement) return null
    const root = document.documentElement.cloneNode(true) as HTMLElement
    root.querySelectorAll('script').forEach((script) => script.remove())
    const originalControls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
    const clonedControls = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
    originalControls.forEach((original, index) => {
      const clone = clonedControls[index]
      if (!clone) return
      if (original instanceof HTMLInputElement && original.type === 'password') {
        clone.value = ''
        clone.removeAttribute('value')
        clone.setAttribute('data-modmind-redacted', 'true')
      } else if (original instanceof HTMLInputElement) {
        clone.setAttribute('value', original.value)
        if (original.checked) clone.setAttribute('checked', 'checked')
        else clone.removeAttribute('checked')
      } else if (original instanceof HTMLTextAreaElement) {
        clone.textContent = original.value
      } else if (original instanceof HTMLSelectElement) {
        const clonedSelect = clone as HTMLSelectElement
        Array.from(clonedSelect.options).forEach((option, optionIndex) => {
          if (original.options[optionIndex]?.selected) option.setAttribute('selected', 'selected')
          else option.removeAttribute('selected')
        })
      }
    })
    root.querySelectorAll('.keep-alive-route[hidden]').forEach((route) => route.remove())
    const snapshot: DiagnosticPageSnapshot = {
      view,
      title: document.title,
      url: window.location.href,
      capturedAt: new Date().toISOString(),
      html: `<!doctype html>\n${root.outerHTML}`
    }
    pageSnapshotsRef.current.set(view, snapshot)
    return snapshot
  }

  useEffect(() => {
    pageSnapshotsRef.current.clear()
  }, [project?.path])

  useEffect(() => {
    const timer = window.setTimeout(() => capturePageSnapshot(), 250)
    return () => window.clearTimeout(timer)
  }, [view, project?.path, uiMode])

  useEffect(() => {
    if (!isDetachedWindow) return
    void window.modmind.app.getDetachedWindowState()
      .then((state) => {
        if (state) setDetachedAlwaysOnTop(state.alwaysOnTop)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (isDetachedWindow && !initialDetachedGroup) return
    return window.modmind.app.onDetachedWindowClosed((closedTarget: DetachedWindowTarget) => {
      if (closedTarget.startsWith('group:')) {
        if (initialDetachedGroup) return
        const groupKey = closedTarget.slice('group:'.length)
        setDetachedSidebarGroupKeys((current) => {
          if (!current.has(groupKey)) return current
          const next = new Set(current)
          next.delete(groupKey)
          return next
        })
        return
      }
      const closedView = closedTarget as ViewId
      setDetachedSidebarItemIds((current) => {
        if (!current.has(closedView)) return current
        const next = new Set(current)
        next.delete(closedView)
        return next
      })
    })
  }, [])

  useLayoutEffect(() => {
    if (previousUiModeRef.current === uiMode) return
    previousUiModeRef.current = uiMode
    const element = mainContentRef.current
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    animateModeSurface(element, modeAnimationRef, reducedMotion, '0.78', 'translateY(5px)', 300)
    animateModeSurface(sidebarNavRef.current, sidebarAnimationRef, reducedMotion, '0.86', 'translateX(-4px)', 260)
  }, [uiMode])

  useLayoutEffect(() => {
    const element = mainContentRef.current
    if (!element) return
    const key = `${project?.path ?? 'launcher'}:${view}`
    element.scrollTop = viewScrollPositionsRef.current[key] ?? 0
    const rememberScroll = (): void => {
      viewScrollPositionsRef.current[key] = element.scrollTop
    }
    element.addEventListener('scroll', rememberScroll, { passive: true })
    return () => element.removeEventListener('scroll', rememberScroll)
  }, [project?.path, projectLauncherOpen, view])

  const navigateToView = (nextView: ViewId): void => {
    const element = mainContentRef.current
    if (element) {
      const key = `${project?.path ?? 'launcher'}:${view}`
      viewScrollPositionsRef.current[key] = element.scrollTop
    }
    setView(nextView)
  }

  useEffect(() => () => {
    modeAnimationRef.current?.cancel()
    sidebarAnimationRef.current?.cancel()
  }, [])

  const aiRunTokensRef = useRef<Map<string, number>>(new Map())
  const nextAiRunToken = (projectPath: string): number => {
    const key = normalizeProjectPath(projectPath)
    const token = (aiRunTokensRef.current.get(key) ?? 0) + 1
    aiRunTokensRef.current.set(key, token)
    return token
  }
  const isCurrentAiRunToken = (projectPath: string, token: number): boolean => aiRunTokensRef.current.get(normalizeProjectPath(projectPath)) === token
  const workspaceSessionRef = useRef('')
  const [workbenchConversations, setWorkbenchConversations] = useState<WorkbenchConversation[]>([])
  const [activeWorkbenchConversationId, setActiveWorkbenchConversationId] = useState('')
  const activeWorkbenchConversationIdRef = useRef('')
  activeWorkbenchConversationIdRef.current = activeWorkbenchConversationId
  const workbenchConversationsLoadedRef = useRef(false)
  const aiTimelineRef = useRef<AiTimelineItem[]>([])
  aiTimelineRef.current = aiTimeline
  const persistedWorkbenchIndexRef = useRef<Map<string, string>>(new Map())
  const requestedWorkbenchIndexRef = useRef<Map<string, string>>(new Map())
  const persistedWorkbenchTimelineRef = useRef<Map<string, string>>(new Map())
  const requestedWorkbenchTimelineRef = useRef<Map<string, string>>(new Map())
  const workbenchPersistenceGenerationRef = useRef(0)
  const projectPathRef = useRef('')
  projectPathRef.current = project?.path ?? ''
  useEffect(() => {
    let disposed = false
    const projectPath = project?.path
    if (!projectPath) {
      workspaceSessionRef.current = ''
      setPlanning(false)
      setAiRecovery(null)
      return () => { disposed = true }
    }
    workspaceSessionRef.current = ''
    void Promise.all([
      window.modmind.ai.getProjectTaskState(projectPath).catch(() => ({ codingSessionId: undefined, startedAt: undefined, backend: undefined, readOnlyTaskCount: 0 })),
      window.modmind.ai.getRecovery(projectPath).catch(() => ({ pending: false, snapshot: null, sessionId: undefined, backend: undefined }))
    ]).then(([taskState, recovery]) => {
      if (disposed || projectPathRef.current !== projectPath) return
      workspaceSessionRef.current = taskState.codingSessionId ?? recovery.sessionId ?? ''
      setRunningBackend(taskState.backend ?? recovery.backend)
      setPlanning(Boolean(taskState.startedAt))
      setProcessingStartedAt(taskState.startedAt)
      setAiOutputStatus(taskState.startedAt ? 'running' : 'idle')
      setAiRecovery(recovery.pending ? recovery : null)
    })
    return () => { disposed = true }
  }, [project?.path])
  const workspacePromptHistoryRef = useRef<Map<string, string[]>>(new Map())
  const cancelAi = (): void => {
    if (cancelAiPromiseRef.current) return
    const taskProjectPath = projectPathRef.current
    if (!taskProjectPath) return
    // Pausing keeps the project checkpoint and Codex session for a later
    // natural-language "继续" or explicit recovery.
    nextAiRunToken(taskProjectPath)
    setNotice('正在停止 Agent，等待进程完全退出…')
    const cancellation = (async (): Promise<void> => {
      try {
        const result = await window.modmind.ai.cancelCode(workspaceSessionRef.current || undefined, taskProjectPath)
        if (normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(taskProjectPath)) return
        if (result.status === 'timed_out') {
          const taskState = await window.modmind.ai.getProjectTaskState(taskProjectPath).catch(() => null)
          if (normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(taskProjectPath)) return
          const stillRunning = Boolean(taskState?.startedAt)
          setPlanning(stillRunning)
          setProcessingStartedAt(taskState?.startedAt)
          setRunningBackend(taskState?.backend)
          setAiOutputStatus(stillRunning ? 'running' : 'idle')
          setNotice(stillRunning
            ? `Agent 进程尚未完全退出（仍有 ${result.remaining} 个任务），未允许新任务覆盖它；可再次停止或导出诊断`
            : 'Agent 已停止')
          if (stillRunning) return
        }
        setPlanning(false)
        setProcessingStartedAt(undefined)
        setRunningBackend(undefined)
        setBeginnerTaskState('idle')
        setAiOutputStatus('idle')
        setAiTimeline((current) => settleWorkbenchActivity(current))
        setNotice(result.status === 'idle' ? '当前没有正在运行的 Agent 任务' : 'Agent 已完全停止，恢复点已保留')
      } catch (error) {
        const taskState = await window.modmind.ai.getProjectTaskState(taskProjectPath).catch(() => null)
        if (normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(taskProjectPath)) return
        const stillRunning = Boolean(taskState?.startedAt)
        setPlanning(stillRunning)
        setProcessingStartedAt(taskState?.startedAt)
        setRunningBackend(taskState?.backend)
        setAiOutputStatus(stillRunning ? 'running' : 'idle')
        setNotice(stillRunning ? `Agent 停止失败：${errorMessage(error)}` : 'Agent 已停止')
      } finally {
        cancelAiPromiseRef.current = null
      }
    })()
    cancelAiPromiseRef.current = cancellation
    void cancellation
  }
  const activateWorkbenchConversation = (conversationId: string): void => {
    setPendingWorkbenchEdit(null)
    setActiveWorkbenchConversationId(conversationId)
    // Clearing the loaded key makes the timeline effect reload from the new
    // conversation's own file; the plan/todo panel resets with it.
    setAiHistoryLoadedKey('')
    setAiTimeline([])
    setAiPlan(null)
    setAiTodo([])
    workspaceSessionRef.current = ''
    void window.modmind.ai.getProjectTaskState(projectPathRef.current || undefined).then((state) => {
      if (state.activeConversationId && state.activeConversationId !== conversationId) return
      if (state.codingSessionId) workspaceSessionRef.current = state.codingSessionId
    }).catch(() => undefined)
  }
  const selectWorkbenchConversation = (conversationId: string): void => {
    if (planning || conversationId === activeWorkbenchConversationId) return
    if (!workbenchConversations.some((item) => item.id === conversationId)) return
    activateWorkbenchConversation(conversationId)
  }
  const startWorkbenchConversation = async (): Promise<void> => {
    if (planning) return
    const created = createWorkbenchConversation(workbenchConversations)
    const projectPath = projectPathRef.current
    if (!projectPath) return
    try {
      await requireRedundantWorkbenchWrite(() => persistWorkbenchIndexNow(projectPath, created.conversations), '新对话索引')
      setWorkbenchConversations(created.conversations)
      // The new id is not present in this render's conversation array yet, so it
      // must bypass selectWorkbenchConversation's stale-array membership guard.
      activateWorkbenchConversation(created.conversation.id)
    } catch (error) {
      setNotice(`新建对话失败，未安全保存：${errorMessage(error)}`)
    }
  }
  const deleteWorkbenchConversation = async (conversationId: string): Promise<void> => {
    if (planning) return
    const target = workbenchConversations.find((item) => item.id === conversationId)
    if (!target) return
    const remaining = removeWorkbenchConversation(workbenchConversations, conversationId)
    if (!remaining.length) return
    const projectPath = projectPathRef.current
    if (!projectPath) return
    try {
      await requireRedundantWorkbenchWrite(() => persistWorkbenchIndexNow(projectPath, remaining), '删除后的对话索引')
    } catch (error) {
      setNotice(`删除对话已取消：无法安全保存索引（${errorMessage(error)}）`)
      return
    }
    setWorkbenchConversations(remaining)
    sessionResetConversationIdsRef.current.delete(conversationId)
    if (pendingWorkbenchEdit?.conversationId === conversationId) setPendingWorkbenchEdit(null)
    if (conversationId === activeWorkbenchConversationId) {
      setActiveWorkbenchConversationId('')
      setAiHistoryLoadedKey('')
      setAiTimeline([])
      setAiPlan(null)
      setAiTodo([])
      workspaceSessionRef.current = ''
      window.setTimeout(() => {
        setActiveWorkbenchConversationId(remaining[0].id)
        void window.modmind.ai.getProjectTaskState(projectPathRef.current || undefined).then((state) => {
          if (state.activeConversationId && state.activeConversationId !== remaining[0].id) return
          if (state.codingSessionId) workspaceSessionRef.current = state.codingSessionId
        }).catch(() => undefined)
      }, 0)
    }
    if (projectPath) {
      void window.modmind.project.deleteWorkbenchData(`.modmind/workbench-timeline-${conversationId}.json`, projectPath).catch(() => undefined)
      if (isLegacyWorkbenchConversation(target)) {
        // The original conversation keeps the pre-beta 'workspace' scope: its
        // timeline and session pointer still live in the legacy single files.
        void window.modmind.project.deleteWorkbenchData('.modmind/workbench-timeline.json', projectPath).catch(() => undefined)
        void window.modmind.project.deleteWorkbenchData('.modmind/external-agents/session-codex.json', projectPath).catch(() => undefined)
        void window.modmind.project.deleteWorkbenchData('.modmind/external-agents/session-claude.json', projectPath).catch(() => undefined)
        try {
          for (const backend of ['quota', 'codex', 'claude']) localStorage.removeItem(`${projectPath}:${backend}`)
        } catch { /* storage is optional */ }
      } else {
        void window.modmind.project.deleteWorkbenchData(`.modmind/external-agents/sessions/workspace/${conversationId}`, projectPath).catch(() => undefined)
      }
      try { localStorage.removeItem(`${projectPath}:${settings.codingBackend}:${conversationId}`) } catch { /* storage is optional */ }
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !planning) return
      event.preventDefault()
      cancelAi()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [planning])

  useEffect(() => {
    if (!planning) setAiTimeline((current) => settleWorkbenchActivity(current))
  }, [planning])
  const [deviceState, setDeviceState] = useState<DeviceConnectionState>({ status: 'disconnected', configured: false })
  const [remoteState, setRemoteState] = useState<RemoteConnectionState>({ status: 'disabled', enabled: false })
  const [mcpBridgeState, setMcpBridgeState] = useState<McpBridgeState>({ enabled: false, running: false, projectPath: null, projectName: null, mcpConfigPath: null, startedAt: null })
  const [mcpBridgeBusy, setMcpBridgeBusy] = useState(false)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [deviceAccountOpen, setDeviceAccountOpen] = useState(false)
  const [beginnerAiPreferences, setBeginnerAiPreferences] = useState<BeginnerAiPreferences>({ model: 'gpt-5.6-sol', reasoningLevel: 'medium', fastMode: false })
  const [beginnerAvailableModels, setBeginnerAvailableModels] = useState<AiModelInfo[]>([])
  const [scanningBeginnerModels, setScanningBeginnerModels] = useState(false)
  const [beginnerModelScanMessage, setBeginnerModelScanMessage] = useState('连接账号后扫描可用模型')
  const [availableModels, setAvailableModels] = useState<AiModelInfo[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [scanningModels, setScanningModels] = useState(false)
  const [savingAiPreferences, setSavingAiPreferences] = useState(false)
  const [exportArtifactAvailable, setExportArtifactAvailable] = useState(false)
  const [diagnosticExporting, setDiagnosticExporting] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<AppVersionCheckResult | null>(null)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({ phase: 'idle', currentVersion: '' })
  const [updateDownloadedOpen, setUpdateDownloadedOpen] = useState(false)
  const [updateActionBusy, setUpdateActionBusy] = useState(false)
  const [modelScanMessage, setModelScanMessage] = useState('输入 API Key 后扫描')
  const [externalAgents, setExternalAgents] = useState<ExternalAgentStatus[]>([])
  const [externalAgentsReady, setExternalAgentsReady] = useState(false)
  const [installingAgents, setInstallingAgents] = useState<Partial<Record<ExternalAgentKind, boolean>>>({})
  const [configuringAgents, setConfiguringAgents] = useState<Partial<Record<ExternalAgentKind, boolean>>>({})
  const [editingAgent, setEditingAgent] = useState<ExternalAgentKind | null>(null)
  const [agentDraft, setAgentDraft] = useState<ExternalAgentConfiguration>({})
  const [aiHistoryLoadedKey, setAiHistoryLoadedKey] = useState('')
  const [workbenchPersistenceState, setWorkbenchPersistenceState] = useState<WorkbenchPersistenceState>('loading')
  const [workbenchPersistenceMessage, setWorkbenchPersistenceMessage] = useState('正在读取对话')
  const aiOutputHistoryPath = project && activeWorkbenchConversationId ? `.modmind/workbench-timeline-${activeWorkbenchConversationId}.json` : ''
  // One conversation has one timeline across all execution backends.
  const aiOutputHistoryKey = project && activeWorkbenchConversationId ? `${project.path}:${activeWorkbenchConversationId}` : ''
  const workbenchConversationsFile = '.modmind/workbench-conversations.json'
  const legacyWorkbenchTimelineFile = '.modmind/workbench-timeline.json'
  const applyWorkbenchWriteResult = (result: Awaited<ReturnType<typeof window.modmind.project.writeWorkbenchData>>, generation: number): void => {
    if (generation !== workbenchPersistenceGenerationRef.current) return
    if (result.durability === 'redundant') {
      setWorkbenchPersistenceState('saved')
      setWorkbenchPersistenceMessage('已双重保存')
      return
    }
    setWorkbenchPersistenceState('degraded')
    setWorkbenchPersistenceMessage(result.warning ?? '对话已保存，但冗余备份未全部完成')
  }
  const persistWorkbenchIndexNow = async (projectPath: string, conversations: WorkbenchConversation[]): Promise<Awaited<ReturnType<typeof window.modmind.project.writeWorkbenchData>>> => {
    const content = JSON.stringify(conversations)
    const key = `${projectPath}\n${workbenchConversationsFile}`
    requestedWorkbenchIndexRef.current.set(key, content)
    const generation = ++workbenchPersistenceGenerationRef.current
    setWorkbenchPersistenceState('saving')
    setWorkbenchPersistenceMessage('正在保存对话索引')
    try {
      const result = await window.modmind.project.writeWorkbenchData(workbenchConversationsFile, content, projectPath)
      if (requestedWorkbenchIndexRef.current.get(key) === content) persistedWorkbenchIndexRef.current.set(key, content)
      applyWorkbenchWriteResult(result, generation)
      return result
    } catch (error) {
      if (requestedWorkbenchIndexRef.current.get(key) === content) requestedWorkbenchIndexRef.current.delete(key)
      if (generation === workbenchPersistenceGenerationRef.current) {
        setWorkbenchPersistenceState('error')
        setWorkbenchPersistenceMessage(`对话索引保存失败：${errorMessage(error)}`)
      }
      throw error
    }
  }
  const persistWorkbenchTimelineNow = async (
    projectPath: string,
    historyPath: string,
    historyKey: string,
    timeline: AiTimelineItem[]
  ): Promise<Awaited<ReturnType<typeof window.modmind.project.writeWorkbenchData>>> => {
    const content = JSON.stringify(timeline)
    const key = `${projectPath}\n${historyKey}`
    requestedWorkbenchTimelineRef.current.set(key, content)
    const generation = ++workbenchPersistenceGenerationRef.current
    setWorkbenchPersistenceState('saving')
    setWorkbenchPersistenceMessage('正在保存对话')
    try {
      const result = await window.modmind.project.writeWorkbenchData(historyPath, content, projectPath)
      if (requestedWorkbenchTimelineRef.current.get(key) === content) persistedWorkbenchTimelineRef.current.set(key, content)
      applyWorkbenchWriteResult(result, generation)
      return result
    } catch (error) {
      if (requestedWorkbenchTimelineRef.current.get(key) === content) requestedWorkbenchTimelineRef.current.delete(key)
      if (generation === workbenchPersistenceGenerationRef.current) {
        setWorkbenchPersistenceState('error')
        setWorkbenchPersistenceMessage(`对话保存失败：${errorMessage(error)}`)
      }
      throw error
    }
  }
  const requireRedundantWorkbenchWrite = async (
    operation: () => Promise<Awaited<ReturnType<typeof window.modmind.project.writeWorkbenchData>>>,
    label: string
  ): Promise<void> => {
    let lastWarning = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await operation()
      if (result.durability === 'redundant') return
      lastWarning = result.warning ?? '冗余副本未完成'
      await new Promise((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)))
    }
    throw new Error(`${label}未完成双重落盘：${lastWarning}`)
  }
  // Load the conversation index when a project opens. Legacy projects with a
  // single anonymous workspace thread become one conversation that keeps the
  // legacy 'workspace' scope so its CLI session pointer still resumes.
  //
  // Migration renders first: the legacy timeline is shown immediately, adopted
  // by the per-conversation load path below, and the legacy file is deleted
  // only after the new per-conversation file has been written successfully.
  // If the index load fails, the active conversation stays hidden so the
  // timeline save effect cannot overwrite anything.
  useEffect(() => {
    workbenchConversationsLoadedRef.current = false
    setPendingWorkbenchEdit(null)
    sessionResetConversationIdsRef.current.clear()
    setWorkbenchConversations([])
    setActiveWorkbenchConversationId('')
    setWorkbenchPersistenceState('loading')
    setWorkbenchPersistenceMessage('正在读取对话索引')
    if (!project?.path) return
    let cancelled = false
    const projectPath = project.path
    const readOptionalLocalStorage = (key: string): string => {
      try { return localStorage.getItem(key) ?? '' } catch { return '' }
    }
    const readLegacyTimeline = async (): Promise<{ history: AiTimelineItem[]; durable: boolean }> => {
      const stored = await window.modmind.project.readWorkbenchData(legacyWorkbenchTimelineFile, projectPath)
      if (stored.status === 'unavailable') throw new Error(stored.message ?? '旧版对话无法安全读取')
      const fallback = stored.status === 'missing' ? readOptionalLocalStorage(`${projectPath}:${settings.codingBackend}`) : ''
      const raw = stored.status === 'ok' ? stored.content ?? '' : fallback
      if (!raw) return { history: [], durable: stored.status === 'ok' }
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) throw new Error('旧版对话数据格式无效')
      return { history: parseStoredWorkbenchTimeline(parsed), durable: stored.status === 'ok' }
    }
    const loadIndex = async (): Promise<void> => {
      try {
        const stored = await window.modmind.project.readWorkbenchData(workbenchConversationsFile, projectPath)
        if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话索引无法安全读取')
        const fallback = stored.status === 'missing' ? readOptionalLocalStorage(`modmind-workbench-conversations:${projectPath}`) : ''
        const raw = stored.status === 'ok' ? stored.content ?? '' : fallback
        let conversations: WorkbenchConversation[] = []
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          if (!Array.isArray(parsed)) throw new Error('对话索引格式无效')
          conversations = normalizeWorkbenchConversations(parsed)
          if (parsed.length > 0 && conversations.length === 0) throw new Error('对话索引中没有可安全恢复的条目')
        }
        const indexPersistenceKey = `${projectPath}\n${workbenchConversationsFile}`
        if (stored.status === 'ok') persistedWorkbenchIndexRef.current.set(indexPersistenceKey, JSON.stringify(conversations))
        else persistedWorkbenchIndexRef.current.delete(indexPersistenceKey)
        if (!conversations.length) {
          const legacy = await readLegacyTimeline()
          if (cancelled) return
          setAiTimeline(legacy.history)
          conversations = [migrateLegacyConversation(legacy.history.length)]
        }
        const activeId = conversations[0]?.id ?? ''
        if (cancelled) return
        setWorkbenchConversations(conversations)
        setActiveWorkbenchConversationId(activeId)
        workbenchConversationsLoadedRef.current = true
        setWorkbenchPersistenceState('ready')
        setWorkbenchPersistenceMessage(stored.recovered ? stored.warning ?? '对话已恢复' : '对话索引已加载')
      } catch (error) {
        if (cancelled) return
        workbenchConversationsLoadedRef.current = false
        setWorkbenchPersistenceState('error')
        setWorkbenchPersistenceMessage(`对话索引加载失败：${errorMessage(error)}`)
      }
    }
    void loadIndex()
    return () => { cancelled = true }
  }, [project?.path])
  useEffect(() => {
    if (!project?.path || !workbenchConversationsLoadedRef.current) return
    const content = JSON.stringify(workbenchConversations)
    const key = `${project.path}\n${workbenchConversationsFile}`
    if (persistedWorkbenchIndexRef.current.get(key) === content || requestedWorkbenchIndexRef.current.get(key) === content) return
    void persistWorkbenchIndexNow(project.path, workbenchConversations).catch(() => undefined)
  }, [workbenchConversations, project?.path])
  useEffect(() => {
    if (!titlebarMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !titlebarMenuRef.current?.contains(target)) setTitlebarMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [titlebarMenuOpen])

  const humanizeActivity = (value: string): string => {
    const humanized = value
    .replaceAll('Agent analyzing the project', 'AI 正在分析项目')
    .replaceAll('Reading files and planning tool calls', '读取文件并规划下一步操作')
    .replaceAll('Agent task started; inspecting the project', 'AI 已开始检查项目')
    .replaceAll('Agent applied changes', 'AI 已应用代码修改')
    .replaceAll('Agent running Gradle', 'AI 正在运行 Gradle 构建')
    .replaceAll('Gradle build succeeded', 'Gradle 构建成功')
    .replaceAll('Gradle build failed', 'Gradle 构建失败')
    .replaceAll('The build result will be returned to this session', '构建结果会返回到当前任务')
    .replaceAll('The error was returned to the Agent for repair', '错误已返回 AI，等待修复')
    .replaceAll('Agent task completed', 'AI 任务已完成')
    .replaceAll('Passed build after', '构建验证通过，已完成')
    .replaceAll('tool steps', '个操作')
    .replaceAll('Agent step', 'AI 操作')
    return uiMode === 'beginner'
      ? humanized.replaceAll('Codex', '智能开发引擎').replaceAll('Claude Code', '智能开发引擎')
      : humanized
  }

  const humanizeOutput = (value: string): string => {
    const humanized = value
      .replaceAll('Invalid Agent response; requesting one valid action:', '上游没有按 Agent 协议返回可执行操作，正在重试：')
      .replaceAll('The model failed the Agent protocol 3 times:', '上游连续 3 次没有按 Agent 协议返回可执行操作：')
      .replaceAll('The AI model did not respond within 10 minutes.', '上游模型在等待 10 分钟后没有返回任何内容，请稍后重试或切换线路')
      .replaceAll('Unable to connect to the AI service:', '无法连接 AI 服务：')
    return /(?:上游模型|模型服务|Codex|Claude|AI 服务).*(?:失败|拒绝|不可用|超时|中断|参数|额度|凭证|没有返回|429|4\d\d|5\d\d)/i.test(humanized)
      ? aiFailureMessage(humanized)
      : humanized
  }
  const projectWorkbenchCacheRef = useRef<Map<string, ProjectWorkbenchState>>(new Map())
  const activeWorkbenchProjectRef = useRef('')
  const currentWorkbenchStateRef = useRef<ProjectWorkbenchState | null>(null)
  currentWorkbenchStateRef.current = {
    prompt,
    attachments: aiAttachments,
    events,
    aiPlan,
    aiTodo,
    planning,
    processingStartedAt,
    runningBackend,
    switchingBackend,
    workspaceSession: workspaceSessionRef.current,
    conversations: workbenchConversations,
    activeConversationId: activeWorkbenchConversationId,
    aiTimeline,
    aiOutputStatus,
    aiRecovery,
    beginnerTaskState,
    files,
    selectedFile,
    editorContent,
    editorDirty,
    buildResult,
    buildError,
    building,
    snapshots,
    exportArtifactAvailable,
    minecraftEvents
  }
  useEffect(() => {
    const nextProjectPath = project?.path ?? ''
    const previousProjectPath = activeWorkbenchProjectRef.current
    if (previousProjectPath && previousProjectPath !== nextProjectPath && currentWorkbenchStateRef.current) {
      projectWorkbenchCacheRef.current.set(normalizeProjectPath(previousProjectPath), currentWorkbenchStateRef.current)
    }
    const cached = nextProjectPath ? projectWorkbenchCacheRef.current.get(normalizeProjectPath(nextProjectPath)) : undefined
    const restored = cached ?? emptyProjectWorkbenchState()
    setPrompt(restored.prompt)
    setAiAttachments(restored.attachments)
    setEvents(restored.events)
    setAiPlan(restored.aiPlan)
    setAiTodo(restored.aiTodo)
    setPlanning(restored.planning)
    setProcessingStartedAt(restored.processingStartedAt)
    setRunningBackend(restored.runningBackend)
    setSwitchingBackend(restored.switchingBackend ?? null)
    workspaceSessionRef.current = restored.workspaceSession
    if (restored.conversations.length) {
      setWorkbenchConversations(restored.conversations)
      workbenchConversationsLoadedRef.current = true
      setActiveWorkbenchConversationId(restored.activeConversationId || restored.conversations[0].id)
    }
    setAiTimeline(restored.planning ? restored.aiTimeline : settleWorkbenchActivity(restored.aiTimeline))
    setAiOutputStatus(restored.aiOutputStatus)
    setAiRecovery(restored.aiRecovery)
    setBeginnerTaskState(restored.beginnerTaskState)
    setFiles(restored.files)
    setSelectedFile(restored.selectedFile)
    setEditorContent(restored.editorContent)
    setEditorDirty(restored.editorDirty)
    setBuildResult(restored.buildResult)
    setBuildError(restored.buildError)
    setBuilding(restored.building)
    setSnapshots(restored.snapshots)
    setExportArtifactAvailable(restored.exportArtifactAvailable)
    setMinecraftEvents(restored.minecraftEvents)
    activeWorkbenchProjectRef.current = nextProjectPath
  }, [project?.path])
  useEffect(() => () => {
    const active = activeWorkbenchProjectRef.current
    if (active && currentWorkbenchStateRef.current) projectWorkbenchCacheRef.current.set(normalizeProjectPath(active), currentWorkbenchStateRef.current)
  }, [])
  const isForegroundProject = (projectPath: string): boolean => normalizeProjectPath(projectPathRef.current) === normalizeProjectPath(projectPath)
  const storeProjectPlan = (projectPath: string, plan: AiPlan & { todo?: ProjectWorkbenchState['aiTodo'] }): void => {
    const todo = plan.todo ?? plan.tasks.map((task, index) => ({ id: `T${index + 1}`, title: task, status: 'completed' as const }))
    if (isForegroundProject(projectPath)) {
      setAiPlan(plan)
      setAiTodo(todo)
      setPrompt('')
      setAiAttachments([])
      setPlanning(false)
      setAiOutputStatus('success')
      setBeginnerTaskState('success')
      return
    }
    const current = projectWorkbenchCacheRef.current.get(normalizeProjectPath(projectPath)) ?? emptyProjectWorkbenchState()
    projectWorkbenchCacheRef.current.set(normalizeProjectPath(projectPath), {
      ...current,
      aiPlan: plan,
      aiTodo: todo,
      prompt: '',
      attachments: [],
      planning: false,
      aiOutputStatus: 'success',
      beginnerTaskState: 'success'
    })
  }
  const [mappingQuery, setMappingQuery] = useState('')
  const [mappingResults, setMappingResults] = useState<MappingClassResult[]>([])
  const [mappingDetail, setMappingDetail] = useState<MappingClassDetail | null>(null)
  const [mappingMemberQuery, setMappingMemberQuery] = useState('')
  const [mappingBusy, setMappingBusy] = useState(false)
  const [mappingMessage, setMappingMessage] = useState('输入任意命名空间中的类名，例如 Item、class_1792 或 C_1381_')

  const refreshFilesFor = async (projectPath: string): Promise<void> => {
    const nextFiles = await window.modmind.project.listFiles(projectPath)
    if (normalizeProjectPath(projectPathRef.current) === normalizeProjectPath(projectPath)) setFiles(nextFiles)
    else {
      const key = normalizeProjectPath(projectPath)
      const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
      projectWorkbenchCacheRef.current.set(key, {...current, files: nextFiles})
    }
  }

  const refreshFiles = async (): Promise<void> => {
    if (project) await refreshFilesFor(project.path)
  }

  const refreshSnapshotsFor = async (projectPath: string): Promise<void> => {
    const nextSnapshots = await window.modmind.snapshots.list(projectPath)
    if (isForegroundProject(projectPath)) setSnapshots(nextSnapshots)
    else {
      const key = normalizeProjectPath(projectPath)
      const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
      projectWorkbenchCacheRef.current.set(key, {...current, snapshots: nextSnapshots})
    }
  }

  const refreshSnapshots = async (): Promise<void> => {
    if (project) await refreshSnapshotsFor(project.path)
  }

  const refreshExportArtifactFor = async (projectPath: string): Promise<void> => {
    const available = await window.modmind.project.hasExportArtifact(projectPath).catch(() => false)
    if (isForegroundProject(projectPath)) setExportArtifactAvailable(available)
    else {
      const key = normalizeProjectPath(projectPath)
      const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
      projectWorkbenchCacheRef.current.set(key, {...current, exportArtifactAvailable: available})
    }
  }

  const refreshExportArtifact = async (): Promise<void> => {
    if (project) await refreshExportArtifactFor(project.path)
  }

  useEffect(() => {
    if (!project) {
      setExportArtifactAvailable(false)
      return
    }
    void refreshExportArtifactFor(project.path)
  }, [project?.path])

  const refreshRecentProjects = async (): Promise<void> => {
    setRecentProjects(await window.modmind.project.listRecent())
  }

  useEffect(() => {
    if (!aiOutputHistoryKey) {
      setAiTimeline([])
      setAiHistoryLoadedKey('')
      setWorkbenchPersistenceState('loading')
      setWorkbenchPersistenceMessage('正在等待对话索引')
      return
    }
    let cancelled = false
    const historyProjectPath = project?.path ?? ''
    const historyConversationId = activeWorkbenchConversationId
    setWorkbenchPersistenceState('loading')
    setWorkbenchPersistenceMessage('正在校验对话历史')
    const loadHistory = async (): Promise<void> => {
      try {
        let stored = await window.modmind.project.readWorkbenchData(aiOutputHistoryPath, historyProjectPath)
        if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话历史无法通过完整性校验')
        let migratedFromLegacy = false
        if (stored.status === 'missing' && activeWorkbenchConversationId === WORKBENCH_LEGACY_SCOPE) {
          const legacy = await window.modmind.project.readWorkbenchData(legacyWorkbenchTimelineFile, historyProjectPath)
          if (legacy.status === 'unavailable') throw new Error(legacy.message ?? '旧版对话历史无法通过完整性校验')
          if (legacy.status === 'ok') {
            stored = legacy
            migratedFromLegacy = true
          }
        }
        const legacyBackendKey = project?.path ? `${project.path}:${settings.codingBackend}:${activeWorkbenchConversationId}` : ''
        let localFallback = ''
        if (stored.status === 'missing') {
          try { localFallback = localStorage.getItem(aiOutputHistoryKey) || (legacyBackendKey ? localStorage.getItem(legacyBackendKey) : '') || '' } catch { /* migration source is optional */ }
        }
        const raw = stored.status === 'ok' ? stored.content ?? '' : localFallback
        let history: AiTimelineItem[] = []
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          if (!Array.isArray(parsed)) throw new Error('对话历史格式无效')
          history = parseStoredWorkbenchTimeline(parsed)
        }
        if (cancelled || normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(historyProjectPath) || activeWorkbenchConversationIdRef.current !== historyConversationId) return
        const persistenceKey = `${historyProjectPath}\n${aiOutputHistoryKey}`
        const needsMigration = migratedFromLegacy || Boolean(localFallback)
        if (stored.status === 'ok' && !needsMigration) persistedWorkbenchTimelineRef.current.set(persistenceKey, JSON.stringify(history))
        else if (stored.status === 'missing' && !needsMigration) persistedWorkbenchTimelineRef.current.set(persistenceKey, '[]')
        else persistedWorkbenchTimelineRef.current.delete(persistenceKey)
        requestedWorkbenchTimelineRef.current.delete(persistenceKey)
        setAiTimeline(history)
        setAiHistoryLoadedKey(aiOutputHistoryKey)
        setWorkbenchPersistenceState('ready')
        setWorkbenchPersistenceMessage(stored.recovered ? stored.warning ?? '对话已从备份恢复' : needsMigration ? '正在迁移旧版对话' : '对话历史已校验')
      } catch (error) {
        if (cancelled || normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(historyProjectPath) || activeWorkbenchConversationIdRef.current !== historyConversationId) return
        setAiHistoryLoadedKey('')
        setWorkbenchPersistenceState('error')
        setWorkbenchPersistenceMessage(`对话历史加载失败：${errorMessage(error)}；已阻止覆盖`)
      }
    }
    void loadHistory()
    return () => { cancelled = true }
  }, [aiOutputHistoryKey, activeWorkbenchConversationId])

  useEffect(() => {
    if (!project || !aiOutputHistoryKey || aiHistoryLoadedKey !== aiOutputHistoryKey) return
    const content = JSON.stringify(aiTimeline)
    const persistenceKey = `${project.path}\n${aiOutputHistoryKey}`
    if (persistedWorkbenchTimelineRef.current.get(persistenceKey) === content || requestedWorkbenchTimelineRef.current.get(persistenceKey) === content) return
    void persistWorkbenchTimelineNow(project.path, aiOutputHistoryPath, aiOutputHistoryKey, aiTimeline).then(async () => {
      if (activeWorkbenchConversationId === WORKBENCH_LEGACY_SCOPE) {
        await window.modmind.project.deleteWorkbenchData(legacyWorkbenchTimelineFile, project.path).catch(() => undefined)
      }
      try {
        localStorage.removeItem(aiOutputHistoryKey)
        localStorage.removeItem(`${project.path}:${settings.codingBackend}:${activeWorkbenchConversationId}`)
        localStorage.removeItem(`${project.path}:${settings.codingBackend}`)
      } catch { /* legacy browser storage is no longer authoritative */ }
    }).catch(() => undefined)
  }, [aiTimeline, aiHistoryLoadedKey, aiOutputHistoryKey])

  useEffect(() => {
    if (settings.codingBackend === 'quota') return
    const activeAgent = settings.codingBackend
    void window.modmind.externalAgents.history(activeAgent).then(() => undefined).catch(() => undefined)
  }, [settings.codingBackend])
  useEffect(() => {
    const applyDeviceState = (state: DeviceConnectionState): void => {
      setDeviceState(state)
      if (state.status !== 'connected') {
        setBeginnerAvailableModels([])
        return
      }
      void Promise.all([
        window.modmind.device.getAiPreferences(),
        window.modmind.device.listModels().catch(() => [] as AiModelInfo[])
      ]).then(([preferences, models]) => {
        setBeginnerAiPreferences(preferences)
        setBeginnerAvailableModels(models)
        setBeginnerModelScanMessage(models.length ? `发现 ${models.length} 个可用模型` : '账号服务没有返回可用模型')
      }).catch(() => undefined)
    }
    void Promise.all([window.modmind.project.current(), window.modmind.project.listRecent()]).then(([current, recent]) => {
      setProject(current)
      setRecentProjects(recent)
      setProjectLauncherOpen(isDetachedWindow ? false : !current)
      if (current) void window.modmind.project.hasExportArtifact(current.path).then(setExportArtifactAvailable).catch(() => setExportArtifactAvailable(false))
    })
    void window.modmind.settings.getAgent().then((value) => { settingsRef.current = value; setSettings(value) })
    void window.modmind.imageStudio.getSettings().then(setImageStudioSettings).catch(() => undefined)
    void window.modmind.device.getState().then(applyDeviceState).catch(() => undefined)
    void window.modmind.remote.getState().then(setRemoteState).catch(() => undefined)
    void window.modmind.mcpBridge.getState().then(setMcpBridgeState).catch(() => undefined)
    void window.modmind.device.getAiPreferences().then(setBeginnerAiPreferences).catch(() => undefined)
    if (!isDetachedWindow) {
      void window.modmind.app.getUpdateState().then((state) => {
        setAppUpdateState(state)
        if (state.phase === 'downloaded') setUpdateDownloadedOpen(true)
      }).catch(() => undefined)
      void window.modmind.app.checkForUpdates().then((result) => { if (result?.updateAvailable) setUpdateInfo(result) }).catch(() => undefined)
    }
    void window.modmind.production.remoteBuild.getGiteeSettings().then(setGiteeSettings).catch(() => undefined)
    void window.modmind.project.listLoaderVersions().then(setLoaderCatalog).catch(() => undefined)
    void window.modmind.externalAgents.detect().then(setExternalAgents).catch(() => undefined).finally(() => setExternalAgentsReady(true))
    const removeOpenSettingsListener = window.modmind.app.onOpenSettings(() => {
      setProjectLauncherOpen(false)
      setView('settings')
    })
    const removeOpenViewListener = window.modmind.app.onOpenView((nextView) => {
      setProjectLauncherOpen(false)
      setView(nextView)
    })
    const removeProjectChangedListener = window.modmind.project.onChanged((nextProject) => {
      setProject(nextProject)
      setProjectLauncherOpen(!nextProject)
      if (nextProject) {
        setExistingAnalysis(null)
        setExistingImportPicker(false)
      }
      void window.modmind.project.listRecent().then(setRecentProjects).catch(() => undefined)
    })
    const removeAppUpdateListener = window.modmind.app.onUpdateState((state) => {
      if (isDetachedWindow) return
      setAppUpdateState(state)
      if (state.phase === 'downloaded') {
        setUpdateInfo(null)
        setUpdateDownloadedOpen(true)
      } else if (state.phase === 'error' && state.message) {
        setNotice(`更新下载失败：${state.message}`)
      }
    })
    const removeBuildListener = window.modmind.build.onProgress((event) => {
      if (uiModeRef.current === 'advanced' && event.status === 'error') return
      const safeEvent = event.status === 'error' && uiModeRef.current === 'beginner'
        ? { ...event, status: 'warning' as const, title: '工具仍在处理中', detail: event.detail }
        : event.status === 'error' ? { ...event, title: '制作状态已更新', detail: '详细信息已写入诊断日志' } : event
      if (event.projectPath && normalizeProjectPath(event.projectPath) !== normalizeProjectPath(projectPathRef.current)) {
        const key = normalizeProjectPath(event.projectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, events: [safeEvent, ...current.events].slice(0, 500)})
        return
      }
      setEvents((current) => [safeEvent, ...current])
    })
    const removeDeviceListener = window.modmind.device.onState(applyDeviceState)
    const removeRemoteListener = window.modmind.remote.onState(setRemoteState)
    const removeMcpBridgeListener = window.modmind.mcpBridge.onState(setMcpBridgeState)
    const removeBeginnerCodexListener = window.modmind.beginnerCodex.onProgress((progress) => {
      // Preparation progress has no runId. During a handoff, only quota setup
      // can belong to the selected target; all other setup events are stale.
      if (switchingBackendRef.current && switchingBackendRef.current !== 'quota') return
      if (uiModeRef.current === 'advanced' && progress.status === 'error') return
      const safeProgress = progress.status === 'error' && uiModeRef.current === 'beginner'
        ? { ...progress, stage: 'planning' as const, status: 'warning' as const, title: '工具仍在处理中', detail: progress.detail }
        : progress.status === 'error'
        ? { ...progress, title: '制作状态已更新', detail: '详细信息已写入诊断日志' }
        : progress
      const progressEvent: PipelineEvent = {
        id: `codex-prepare-${Date.now()}`,
        stage: safeProgress.stage === 'error' ? 'error' : 'planning',
        title: safeProgress.title,
        detail: safeProgress.detail,
        status: safeProgress.status,
        time: new Date().toISOString(),
        ...(safeProgress.projectPath ? {projectPath: safeProgress.projectPath} : {})
      }
      if (safeProgress.projectPath && normalizeProjectPath(safeProgress.projectPath) !== normalizeProjectPath(projectPathRef.current)) {
        const key = normalizeProjectPath(safeProgress.projectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, events: [progressEvent, ...current.events].slice(0, 500)})
        return
      }
      setEvents((current) => [progressEvent, ...current])
    })
    const backgroundProjectPath = (eventProjectPath?: string): string | undefined => {
      if (!eventProjectPath) return undefined
      const normalized = normalizeProjectPath(eventProjectPath)
      return normalizeProjectPath(projectPathRef.current) === normalized ? undefined : normalized
    }
    const storeBackgroundProgress = (event: PipelineEvent, key: string): void => {
      const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
      const timeline = reduceWorkbenchProgress(current.aiTimeline, event, humanizeActivity)
      projectWorkbenchCacheRef.current.set(key, {
        ...current,
        events: [event, ...current.events].slice(0, 500),
        aiTimeline: timeline,
        planning: event.stage === 'complete' || (event.status === 'error' && event.terminal === true) ? false : event.status === 'running' || current.planning,
        aiOutputStatus: event.status === 'error' && event.terminal === true ? 'error' : event.status === 'success' ? 'success' : current.aiOutputStatus,
        aiTodo: event.todo ?? current.aiTodo
      })
    }
    const storeBackgroundOutput = (event: AiOutputEvent, key: string): void => {
      const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
      const timeline = reduceWorkbenchOutput(current.aiTimeline, event, humanizeOutput)
      projectWorkbenchCacheRef.current.set(key, {
        ...current,
        aiTimeline: timeline,
        aiOutputStatus: event.kind === 'error' && event.terminal === true ? 'error' : event.kind === 'answer' ? 'success' : current.aiOutputStatus,
        planning: event.kind !== 'answer' && (event.kind !== 'error' || event.terminal !== true)
      })
    }
    const removeAiListener = window.modmind.ai.onProgress((event) => {
      const backgroundKey = backgroundProjectPath(event.projectPath)
      if (event.sessionId?.startsWith('inspiration-')) return
      if (backgroundKey) {
        storeBackgroundProgress(event, backgroundKey)
        return
      }
      if (switchingBackendRef.current && event.backend && event.backend !== switchingBackendRef.current) return
      if (event.backend) setRunningBackend(event.backend)
      setEvents((current) => [event, ...current])
      setAiTimeline((current) => reduceWorkbenchProgress(current, event, humanizeActivity))
      if (event.todo) {
        setAiTodo((current) => {
          if (!current.length || current.length !== event.todo!.length) return event.todo!
          const rank = { pending: 0, in_progress: 1, completed: 2 } as const
          const previous = new Map(current.map((item) => [item.id, item]))
          return event.todo!.map((item) => {
            const prior = previous.get(item.id)
            if (!prior || rank[item.status] >= rank[prior.status]) return item
            return prior
          })
        })
      }
    })
    const removeAiOutputListener = window.modmind.ai.onOutput((event) => {
      const backgroundKey = backgroundProjectPath(event.projectPath)
      if (event.sessionId?.startsWith('inspiration-')) return
      if (backgroundKey) {
        storeBackgroundOutput(event, backgroundKey)
        return
      }
      if (switchingBackendRef.current && event.backend && event.backend !== switchingBackendRef.current) return
      if (event.backend) setRunningBackend(event.backend)
      setAiTimeline((current) => {
        return reduceWorkbenchOutput(current, event, humanizeOutput)
      })
      if (event.kind === 'error' && event.terminal === true) setAiOutputStatus('error')
      else if (event.kind === 'answer') setAiOutputStatus('success')
      else setAiOutputStatus('running')
    })
    const removeMinecraftListener = window.modmind.minecraft.onEvent((event) => {
      if (event.projectPath && normalizeProjectPath(event.projectPath) !== normalizeProjectPath(projectPathRef.current)) {
        const key = normalizeProjectPath(event.projectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, minecraftEvents: appendMinecraftRuntimeEvent(current.minecraftEvents, event, 500)})
        return
      }
      setMinecraftEvents((current) => appendMinecraftRuntimeEvent(current, event, 500))
    })
    const removeBackendReadyListener = window.modmind.ai.onBackendReady((event) => {
      if (normalizeProjectPath(event.projectPath) !== normalizeProjectPath(projectPathRef.current)) return
      const pending = pendingBackendSwitchRef.current
      if (!pending || pending.backend !== event.backend || (event.switchId !== undefined && pending.generation !== event.switchId)) return
      pending.accepted = true
      switchingBackendRef.current = null
      setSwitchingBackend(null)
      settingsRef.current = { ...settingsRef.current, codingBackend: event.backend }
      setSettings((current) => ({ ...current, codingBackend: event.backend }))
      setRunningBackend(event.backend)
      setNotice(`已切换到 ${event.backend === 'quota' ? '智能引擎' : event.backend === 'codex' ? 'Codex' : 'Claude Code'}，正在继续当前任务`)
    })
    return () => {
      removeBuildListener()
      removeOpenSettingsListener()
      removeOpenViewListener()
      removeProjectChangedListener()
      removeAppUpdateListener()
      removeDeviceListener()
      removeRemoteListener()
      removeMcpBridgeListener()
      removeBeginnerCodexListener()
      removeAiListener()
      removeAiOutputListener()
      removeMinecraftListener()
      removeBackendReadyListener()
    }
  }, [])

  const downloadAppUpdate = (): void => {
    setUpdateInfo(null)
    setUpdateDownloadedOpen(false)
    setUpdateActionBusy(true)
    void window.modmind.app.downloadUpdate()
      .catch((error) => setNotice(`更新下载失败：${errorMessage(error)}`))
      .finally(() => setUpdateActionBusy(false))
  }

  const installAppUpdate = (): void => {
    setUpdateActionBusy(true)
    void window.modmind.app.installUpdate().then((started) => {
      if (!started) throw new Error('已下载的安装包不可用，请重新下载')
    }).catch((error) => {
      setUpdateActionBusy(false)
      setNotice(`无法启动安装程序：${errorMessage(error)}`)
    })
  }

  useEffect(() => {
    if (deviceState.status !== 'connected') return
    const timer = window.setInterval(() => { void window.modmind.device.refreshUsage().then(setDeviceState).catch(() => undefined) }, 2 * 60_000)
    return () => window.clearInterval(timer)
  }, [deviceState.status])

  useEffect(() => {
    if (!project) return
    void refreshFiles()
    void refreshSnapshots()
    setMigrationLoader(project.loader)
    setMigrationVersion('')
    setMigrationPreview(null)
    if ((!isJavaLoader(project.loader) && ['minecraft', 'mappings', 'production', 'relationships'].includes(view))
      || (project.kind === 'modpack' && ['blockbench', 'code', 'build', 'mappings'].includes(view))) setView('workspace')
  }, [project])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (view !== 'blockbench') void window.modmind.blockbench.hide()
  }, [view])

  const openProject = async (): Promise<void> => {
    try {
      const opened = await window.modmind.project.open()
      if (opened) {
        setProject(opened)
        setView('workspace')
        setProjectLauncherOpen(false)
        void refreshRecentProjects()
      }
    } catch (error) {
      setNotice(uiMode === 'beginner' ? '制作没有完成，可导出诊断日志' : errorMessage(error))
    }
  }

  const resumeInterruptedAi = async (): Promise<void> => {
    const taskProjectPath = project?.path
    if (!taskProjectPath) return
    const runToken = nextAiRunToken(taskProjectPath)
    // Hide the banner immediately so it does not linger while the resume runs.
    // A failed resume re-reads the checkpoint in the catch branch below and
    // shows the banner again.
    if (isForegroundProject(taskProjectPath)) {
      setAiRecovery(null)
      setNotice('正在恢复 AI 任务；会继续读取项目并重新验证构建')
    }
    // The resumed task belongs to the conversation recorded in its checkpoint.
    const recoveryConversationId = aiRecovery?.conversationId
    if (recoveryConversationId && workbenchConversations.some((item) => item.id === recoveryConversationId) && recoveryConversationId !== activeWorkbenchConversationId) {
      setActiveWorkbenchConversationId(recoveryConversationId)
      setAiHistoryLoadedKey('')
      setAiTimeline([])
    }
    setPlanning(true)
    setRunningBackend(aiRecovery?.backend ?? settings.codingBackend)
    setAiOutputStatus('running')
    setAiTimeline((current) => reduceWorkbenchProgress(current, { id: `recovery-${Date.now()}`, runId: `recovery-${taskProjectPath}`, stage: 'planning', title: '正在继续任务', detail: '从保存的检查点恢复并重新验证', status: 'running', time: new Date().toISOString() }, humanizeActivity))
    try {
      const result = await window.modmind.ai.resumeRecovery(taskProjectPath)
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      storeProjectPlan(taskProjectPath, result)
      await refreshFilesFor(taskProjectPath)
      if (isForegroundProject(taskProjectPath)) {
        await refreshSnapshotsFor(taskProjectPath)
        setAiRecovery(null)
        setNotice('AI 已从中断点继续，并完成构建与独立验收')
      }
    } catch (error) {
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      if (!isForegroundProject(taskProjectPath)) {
        const key = normalizeProjectPath(taskProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, planning: false, aiOutputStatus: 'error'})
      } else if (isWorkflowAuditRejection(error)) {
        setAiOutputStatus('idle')
        setNotice('验证流程尚未完成，任务已保留，可从恢复入口继续')
      } else if (uiModeRef.current === 'advanced') {
        setAiOutputStatus('idle')
      } else {
        setAiOutputStatus('error')
        setAiTimeline((current) => [...current, { id: `recovery-error-${Date.now()}`, kind: 'error', content: aiFailureMessage(error), time: new Date().toISOString(), status: 'error', terminal: true }])
        setNotice(`继续任务失败：${aiFailureMessage(error)}`)
      }
      if (shouldOfferAiRecovery(error)) {
        const recovery = await window.modmind.ai.getRecovery(taskProjectPath).catch(() => ({ pending: false, snapshot: null, sessionId: undefined }))
        if (recovery.pending && normalizeProjectPath(projectPathRef.current) === normalizeProjectPath(taskProjectPath)) setAiRecovery(recovery)
      }
    } finally {
      if (isForegroundProject(taskProjectPath)) {
        setPlanning(false)
      }
    }
  }

  const automaticRecoveryKeyRef = useRef('')
  useEffect(() => {
    const retry = aiRecovery?.retry
    if (!project?.path || planning || !aiRecovery?.pending || !retry) return
    if (aiRecovery.lifecycle !== 'waiting_retry' && aiRecovery.lifecycle !== 'repairing') return
    const key = `${normalizeProjectPath(project.path)}:${aiRecovery.contextRevision ?? 0}:${retry.attempt}:${retry.nextAttemptAt ?? ''}`
    if (automaticRecoveryKeyRef.current === key) return
    const scheduledAt = retry.nextAttemptAt ? Date.parse(retry.nextAttemptAt) : Date.now()
    const delayMs = Number.isFinite(scheduledAt) ? Math.max(0, scheduledAt - Date.now()) : 0
    const timer = window.setTimeout(() => {
      automaticRecoveryKeyRef.current = key
      void resumeInterruptedAi()
    }, Math.min(delayMs, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [aiRecovery?.contextRevision, aiRecovery?.lifecycle, aiRecovery?.pending, aiRecovery?.retry, planning, project?.path])

  const inspectExistingProject = async (sourceType: 'folder' | 'zip'): Promise<void> => {
    setExistingInspecting(true)
    try {
      const analysis = await window.modmind.project.inspectExisting(sourceType)
      if (analysis) setExistingAnalysis(analysis)
    } catch (error) {
      setErrorNotice(errorMessage(error))
    } finally {
      setExistingInspecting(false)
    }
  }

  const openRecentProject = async (recent: ProjectInfo): Promise<void> => {
    try {
      const opened = await window.modmind.project.openRecent(recent.path)
      setProject(opened)
      setView('workspace')
      setProjectLauncherOpen(false)
      void refreshRecentProjects()
    } catch (error) {
      setErrorNotice(errorMessage(error))
      void refreshRecentProjects()
    }
  }

  const removeRecentProject = async (recent: ProjectInfo): Promise<void> => {
    if (!await requestConfirm({ title: `删除项目“${recent.name}”？`, message: '这会永久删除项目目录及其中的源代码、构建产物和快照，不能撤销', confirmLabel: '删除项目', tone: 'danger' })) return
    try {
      const remaining = await window.modmind.project.deleteProject(recent.path)
      setRecentProjects(remaining)
      if (project && project.path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() === recent.path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()) {
        setProject(null)
        setProjectLauncherOpen(true)
        setView('workspace')
        setFiles([])
        setSelectedFile('')
        setEditorContent('')
        setEditorDirty(false)
        setAiPlan(null)
        setAiTodo([])
        setAiTimeline([])
        setAiOutputStatus('idle')
        setBuildResult(null)
        setBuildError('')
      }
      setNotice(`项目“${recent.name}”已删除`)
    } catch (error) {
      setErrorNotice(errorMessage(error))
    }
  }

  const projectRenamed = (renamed: ProjectInfo): void => {
    const isActive = project?.path === renamed.path
    if (isActive) {
      setProject(renamed)
      setSelectedFile('')
      setEditorContent('')
      setEditorDirty(false)
      void window.modmind.project.listFiles().then(setFiles).catch(() => undefined)
    }
    setRenamingProject(null)
    void refreshRecentProjects()
    setNotice(`已重命名为 ${renamed.name}（${renamed.namespace}）`)
  }

  const selectFile = async (node: FileNode): Promise<void> => {
    const editorProjectPath = project?.path
    if (node.type !== 'file' || !editorProjectPath) return
    try {
      if (editorDirty && selectedFile && selectedFile !== node.path) {
        await window.modmind.project.writeFile(selectedFile, editorContent, editorProjectPath)
      }
      setSelectedFile(node.path)
      if (!isEditablePath(node.path)) {
        setEditorContent('')
        setEditorDirty(false)
        setNotice('该文件不是可编辑文本，可使用工具栏在文件管理器中显示')
        return
      }
      const content = await window.modmind.project.readFile(node.path, editorProjectPath)
      if (normalizeProjectPath(projectPathRef.current) !== normalizeProjectPath(editorProjectPath)) return
      setEditorContent(content)
      setEditorDirty(false)
    } catch (error) {
      setNotice(`无法读取文件：${errorMessage(error)}`)
    }
  }

  const openEditorFile = async (relativePath: string): Promise<void> => {
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
    navigateToView('code')
    setProjectLauncherOpen(false)
    await selectFile({ name: normalized.split('/').at(-1) ?? normalized, path: normalized, type: 'file' })
    void refreshFiles()
  }

  const openModpackContentEditor = (contentPath?: string): void => {
    if (!contentPath) {
      navigateToView('code')
      setProjectLauncherOpen(false)
      void refreshFiles()
      return
    }
    void window.modmind.modpack.contentProjectPath(contentPath)
      .then(openEditorFile)
      .catch((error) => setNotice(`无法打开内容文件：${errorMessage(error)}`))
  }

  const createModpackContentFile = async (contentPath: string, initialContent?: string): Promise<void> => {
    try {
      const suggestedPath = await window.modmind.modpack.contentProjectPath(contentPath)
      const relativePath = (await requestPrompt({ title: '新建整合包文件', message: '输入项目相对路径；文件创建后会直接在代码编辑器中打开', value: suggestedPath, inputLabel: '项目相对路径', confirmLabel: '新建文件' }))?.trim()
      if (!relativePath) return
      const result = await window.modmind.project.createFile(relativePath, initialContent, project?.path)
      await openEditorFile(result.path)
      setNotice(`已创建 ${result.path}`)
    } catch (error) {
      setNotice(`无法创建内容文件：${errorMessage(error)}`)
    }
  }

  const searchMappings = async (): Promise<void> => {
    if (!project || !mappingQuery.trim()) return
    setMappingBusy(true)
    setMappingDetail(null)
    try {
      const result = await window.modmind.mappings.search(project.minecraftVersion, mappingQuery)
      setMappingResults(result.results)
      setMappingMessage(result.results.length
        ? `Minecraft ${result.version} · ${result.results.length} 个结果 · ${result.cached ? '本地缓存' : '已从 mappings.dev 下载并缓存'}`
        : `Minecraft ${result.version} 中没有匹配的类`)
    } catch (error) {
      setMappingResults([])
      setMappingMessage(errorMessage(error))
    } finally {
      setMappingBusy(false)
    }
  }

  const openMapping = async (entry: MappingClassResult): Promise<void> => {
    if (!project) return
    setMappingBusy(true)
    try {
      const className = entry.names.Mojang ?? Object.values(entry.names)[0]
      const detail = await window.modmind.mappings.getClass(project.minecraftVersion, className)
      setMappingDetail(detail)
      setMappingMemberQuery('')
      setMappingMessage(`${detail.members.length} 个字段、构造器和方法 · ${detail.cached ? '本地缓存' : '已缓存供离线使用'}`)
    } catch (error) {
      setMappingMessage(errorMessage(error))
    } finally {
      setMappingBusy(false)
    }
  }

  const saveFile = async (): Promise<void> => {
    const editorProjectPath = project?.path
    if (!selectedFile || !editorProjectPath) return
    try {
      await window.modmind.project.writeFile(selectedFile, editorContent, editorProjectPath)
      setEditorDirty(false)
      setNotice('文件已保存')
    } catch (error) {
      setNotice(`保存失败：${errorMessage(error)}`)
    }
  }

  const createProjectFile = async (): Promise<void> => {
    const suggestedDirectory = selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/') + 1) : 'src/main/'
    const relativePath = (await requestPrompt({ title: '创建文件', message: '输入新文件的项目相对路径', value: `${suggestedDirectory}NewFile.java`, inputLabel: '项目相对路径', confirmLabel: '创建文件' }))?.trim()
    if (!relativePath) return
    try {
      const result = await window.modmind.project.createFile(relativePath, undefined, project?.path)
      await refreshFiles()
      setSelectedFile(result.path)
      setEditorContent('')
      setEditorDirty(false)
      setNotice(`已创建 ${result.path}`)
    } catch (error) {
      setNotice(`创建文件失败：${errorMessage(error)}`)
    }
  }

  const createProjectDirectory = async (): Promise<void> => {
    const suggestedDirectory = selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/')) : 'src/main'
    const relativePath = (await requestPrompt({ title: '创建目录', message: '输入新目录的项目相对路径', value: `${suggestedDirectory}/new-directory`, inputLabel: '项目相对路径', confirmLabel: '创建目录' }))?.trim()
    if (!relativePath) return
    try {
      const result = await window.modmind.project.createDirectory(relativePath, project?.path)
      await refreshFiles()
      setNotice(`已创建 ${result.path}`)
    } catch (error) {
      setNotice(`创建目录失败：${errorMessage(error)}`)
    }
  }

  const renameSelectedFile = async (): Promise<void> => {
    const editorProjectPath = project?.path
    if (!selectedFile || !editorProjectPath) return
    const nextPath = (await requestPrompt({ title: '重命名文件', message: '输入新的项目相对路径', value: selectedFile, inputLabel: '项目相对路径', confirmLabel: '重命名' }))?.trim()
    if (!nextPath || nextPath === selectedFile) return
    try {
      if (editorDirty) await window.modmind.project.writeFile(selectedFile, editorContent, editorProjectPath)
      const result = await window.modmind.project.renamePath(selectedFile, nextPath, editorProjectPath)
      setSelectedFile(result.path)
      setEditorDirty(false)
      await refreshFiles()
      setNotice(`已重命名为 ${result.path}`)
    } catch (error) {
      setNotice(`重命名失败：${errorMessage(error)}`)
    }
  }

  const deleteSelectedFile = async (): Promise<void> => {
    if (!selectedFile || !await requestConfirm({ title: `删除“${selectedFile}”？`, message: '此操作不会删除受保护的项目目录', confirmLabel: '删除文件', tone: 'danger' })) return
    try {
      await window.modmind.project.deletePath(selectedFile, project?.path)
      setSelectedFile('')
      setEditorContent('')
      setEditorDirty(false)
      await refreshFiles()
      setNotice('文件已删除')
    } catch (error) {
      setNotice(`删除失败：${errorMessage(error)}`)
    }
  }

  const performBuild = async (showBuildView = false): Promise<{ success: true } | { success: false; error: string }> => {
    if (!project) return { success: false, error: '没有打开的项目' }
    const buildProject = project
    const buildProjectPath = buildProject.path
    const javaProject = isJavaLoader(buildProject.loader)
    const artifactKind = javaProject ? 'Gradle artifact' : buildProject.loader === 'bedrock' ? 'Bedrock artifact' : 'NetEase archive'
    setBuilding(true)
    setBuildResult(null)
    setBuildError('')
    setMinecraftEvents([])
    setEvents((current) => [
      {
        id: `build-start-${Date.now()}`,
        stage: 'building',
        title: '正在构建项目',
        detail: javaProject ? '执行托管 Gradle build' : buildProject.loader === 'bedrock' ? '校验并打包 .mcaddon' : '校验并生成网易工作台归档',
        status: 'running',
        time: new Date().toISOString()
      },
      ...current
    ])
    try {
      const artifact = await window.modmind.minecraft.buildProject(buildProjectPath)
      if (isForegroundProject(buildProjectPath)) setExportArtifactAvailable(true)
      const result = await window.modmind.build.preflight(buildProjectPath)
      result.logs.unshift(`PASS  ${artifactKind}: ${artifact.name}`)
      result.summary = result.success ? (javaProject ? 'Gradle 构建成功，项目预检通过' : `${platformLabel(buildProject.loader)} 归档成功，项目预检通过`) : result.summary
      if (!isForegroundProject(buildProjectPath)) {
        const key = normalizeProjectPath(buildProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, building: false, buildResult: result, buildError: result.success ? '' : '项目预检未通过', exportArtifactAvailable: true})
        return result.success ? {success: true} : {success: false, error: result.summary}
      }
      setBuildResult(result)
      if (!result.success) {
        const detail = javaProject ? 'Gradle 已生成有效 JAR，但项目预检未通过；本次构建不标记为成功' : '平台归档已生成，但项目预检未通过；本次构建不标记为成功'
        setBuildError(detail)
        if (uiModeRef.current !== 'advanced') setEvents((current) => [
          {
            id: `build-preflight-error-${Date.now()}`,
            stage: 'error',
            title: '项目构建未通过',
            detail,
            status: 'error',
            time: new Date().toISOString()
          },
          ...current
        ])
        if (showBuildView) setView('build')
        return { success: false, error: detail }
      }
      setEvents((current) => [
        {
          id: `build-success-${Date.now()}`,
          stage: 'complete',
          title: '项目构建成功',
          detail: artifact.name,
          status: 'success',
          time: new Date().toISOString()
        },
        ...current
      ])
      if (showBuildView) setView('build')
      return { success: true }
    } catch (error) {
      const detail = errorMessage(error)
      if (!isForegroundProject(buildProjectPath)) {
        const key = normalizeProjectPath(buildProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, building: false, buildError: detail})
        return {success: false, error: detail}
      }
      setBuildError(detail)
      if (uiModeRef.current !== 'advanced') setEvents((current) => [
        {
          id: `build-error-${Date.now()}`,
          stage: 'error',
          title: '项目构建失败',
          detail,
          status: 'error',
          time: new Date().toISOString()
        },
        ...current
      ])
      if (showBuildView) setView('build')
      return { success: false, error: detail }
    } finally {
      if (isForegroundProject(buildProjectPath)) setBuilding(false)
      else {
        const key = normalizeProjectPath(buildProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, building: false})
      }
    }
  }

  const captureIdea = async (): Promise<void> => {
    if ((!prompt.trim() && !aiAttachments.length) || !project) return
    const taskProjectPath = project.path
    if (!aiOutputHistoryKey || aiHistoryLoadedKey !== aiOutputHistoryKey || workbenchPersistenceState === 'loading' || workbenchPersistenceState === 'error') {
      setNotice(workbenchPersistenceState === 'error' ? workbenchPersistenceMessage : '对话历史尚未完成安全加载')
      return
    }
    // Serial workbench policy: only one task may run per project at a time.
    if (planning) {
      setNotice('当前项目有任务正在运行，请等待完成或停止后再发送')
      return
    }
    const selectedBackend: AgentSettings['codingBackend'] = uiMode === 'beginner' ? 'quota' : settings.codingBackend
    setRunningBackend(selectedBackend)
    const usesQuota = selectedBackend === 'quota'
    if (usesQuota && deviceState.status !== 'connected') {
      setNotice('请先连接 ModMind 账号')
      return
    }
    if (usesQuota && deviceState.keyStatus === 'FROZEN') {
      setNotice('当前账号暂不可用，请前往网站查看账号状态')
      return
    }
    workbenchAttachmentRestoreTokenRef.current += 1
    let activeConversation = workbenchConversations.find((item) => item.id === activeWorkbenchConversationId)
    let nextConversations = workbenchConversations
    if (!activeConversation) {
      const created = createWorkbenchConversation(workbenchConversations)
      nextConversations = created.conversations
      activeConversation = created.conversation
    }
    const idea = prompt.trim() || '请分析并使用我上传的附件'
    const requestPrompt = `${idea}${formatAiAttachmentContext(aiAttachments)}`
    const promptHistoryKey = workbenchPromptHistoryStorageKey(taskProjectPath, activeConversation)
    let taskPromptHistory = workspacePromptHistoryRef.current.get(promptHistoryKey) ?? []
    try {
      const saved = JSON.parse(localStorage.getItem(promptHistoryKey) ?? '[]') as unknown
      if (Array.isArray(saved)) taskPromptHistory = saved.filter((value): value is string => typeof value === 'string').slice(-50)
    } catch { /* Keep the in-memory history. */ }
    const editItemId = pendingWorkbenchEdit?.conversationId === activeConversation.id ? pendingWorkbenchEdit.itemId : ''
    const editIndex = editItemId ? aiTimelineRef.current.findIndex((item) => item.id === editItemId) : -1
    const resetSession = sessionResetConversationIdsRef.current.delete(activeConversation.id)
    const needsReset = editIndex >= 0 || resetSession
    const baseTimeline = editIndex >= 0 ? aiTimelineRef.current.slice(0, editIndex) : aiTimelineRef.current
    const isRewind = needsReset
    const dialogueContext = isRewind ? workbenchDialogueToText(workbenchFinalDialogue(baseTimeline)) : ''
    const repeated = isRepeatedAiPrompt(requestPrompt, taskPromptHistory)
    const promptForAgent = isRewind
      ? `用户已重置对话上下文。项目文件保持当前状态，并且是判断现状的唯一依据。${dialogueContext ? `\n\n保留的最近对话：\n${dialogueContext}` : ''}\n\n最新请求：\n${requestPrompt}`
      : repeated ? AI_CONTINUATION_PROMPT : requestPrompt
    const sessionId = `coding-${Date.now()}`
    nextConversations = touchWorkbenchConversation(
      nextConversations,
      activeConversation!.id,
      nextConversations.find((item) => item.id === activeConversation!.id)?.title === '新的对话' ? { title: titleFromUserText(idea) } : {}
    )
    const visibleRequest = aiAttachments.length
      ? `${idea}\n\n附件：${aiAttachments.map((attachment) => attachment.name).join('、')}`
      : idea
    const nextTimeline = appendUserTurn(baseTimeline, visibleRequest, sessionId, undefined, {
      prompt: idea,
      ...(aiAttachments.length ? { attachments: aiAttachments.map((attachment) => ({ ...attachment })) } : {})
    })
    const nextHistoryPath = `.modmind/workbench-timeline-${activeConversation.id}.json`
    const nextHistoryKey = `${taskProjectPath}:${activeConversation.id}`
    try {
      await Promise.all([
        requireRedundantWorkbenchWrite(() => persistWorkbenchIndexNow(taskProjectPath, nextConversations), '对话索引'),
        requireRedundantWorkbenchWrite(() => persistWorkbenchTimelineNow(taskProjectPath, nextHistoryPath, nextHistoryKey, nextTimeline), '用户消息')
      ])
    } catch (error) {
      if (resetSession) sessionResetConversationIdsRef.current.add(activeConversation.id)
      setWorkbenchPersistenceState('error')
      setWorkbenchPersistenceMessage(`消息未能双重保存：${errorMessage(error)}`)
      setNotice('消息未发送：未能完成双重落盘')
      return
    }
    if (pendingWorkbenchEdit?.conversationId === activeConversation.id) setPendingWorkbenchEdit(null)
    taskPromptHistory = [...taskPromptHistory, requestPrompt].slice(-50)
    workspacePromptHistoryRef.current.set(promptHistoryKey, taskPromptHistory)
    try { localStorage.setItem(promptHistoryKey, JSON.stringify(taskPromptHistory)) } catch { /* repetition history is optional */ }
    const runToken = nextAiRunToken(taskProjectPath)
    workspaceSessionRef.current = sessionId
    setWorkbenchConversations(nextConversations)
    if (activeConversation.id !== activeWorkbenchConversationId) setActiveWorkbenchConversationId(activeConversation.id)
    setAiTimeline(nextTimeline)
    setPrompt('')
    setAiAttachments([])
    // A follow-up turn has its own report and Todo state. The conversation
    // timeline remains intact, but it must not present the prior turn as this
    // turn's code change while the new request is running.
    setAiPlan(null)
    setAiTodo([])
    setBeginnerTaskState('working')
    setPlanning(true)
    setEvents((current) => [
      {
        id: `idea-${Date.now()}`,
        stage: 'planning',
        title: uiMode === 'beginner' ? '正在准备开发工具' : '需求已记录',
        detail: uiMode === 'beginner' ? '正在检查 Codex、下载组件并比对配置' : '已写入 docs/idea.md',
        status: uiMode === 'beginner' ? 'running' : 'success',
        time: new Date().toISOString()
      },
      ...current
    ])
    try {
      if (usesQuota) await window.modmind.beginnerCodex.prepare(taskProjectPath)
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      await window.modmind.project.captureIdea(requestPrompt, taskProjectPath)
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      await refreshFilesFor(taskProjectPath)
      await refreshExportArtifactFor(taskProjectPath)
      if (uiMode === 'beginner') setEvents((current) => [{
        id: `idea-recorded-${Date.now()}`,
        stage: 'planning',
        title: '需求已记录',
        detail: '已写入 docs/idea.md',
        status: 'success',
        time: new Date().toISOString()
      }, ...current])
    } catch (error) {
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      const detail = errorMessage(error)
      if (uiModeRef.current === 'advanced') {
        setBeginnerTaskState('idle')
        setAiOutputStatus('idle')
      } else {
        setBeginnerTaskState('error')
        setNotice(detail)
        setEvents((current) => [{
          id: `codex-prepare-error-${Date.now()}`,
          stage: 'error',
          title: '开始制作失败',
          detail,
          status: 'error',
          time: new Date().toISOString()
        }, ...current])
      }
      setPlanning(false)
      return
    }
    setAiOutputStatus('running')
    setEvents((current) => [
      {
        id: `plan-${Date.now()}`,
        stage: 'planning',
        title: 'AI 正在分析请求',
        detail: selectedBackend === 'quota' ? '正在使用 ModMind 额度启动 Codex' : selectedBackend === 'codex' ? 'Codex 正在判断任务意图' : 'Claude Code 正在判断任务意图',
        status: 'running',
        time: new Date().toISOString()
      },
      ...current
    ])
    try {
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      let plan = await window.modmind.ai.createCode(
        promptForAgent,
        sessionId,
        selectedBackend,
        usesQuota ? 'beginner-unlimited' : 'standard',
        { surface: 'workspace', sessionScope: activeConversation.sessionScope, resumeSession: !isRewind, projectPath: taskProjectPath, fallbackPrompt: promptForAgent }
      )
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      storeProjectPlan(taskProjectPath, plan)
      const informational = plan.intent === 'informational'
      if (isForegroundProject(taskProjectPath)) setEvents((current) => [
        {
          id: `plan-done-${Date.now()}`,
          stage: 'planning',
          title: informational ? 'AI 已完成回答' : '代码修改已完成',
          detail: informational ? '已识别为咨询任务，没有修改或构建项目' : `${plan.files.length} 个文件已写入，修改前快照已保存`,
          status: 'success',
          time: new Date().toISOString()
        },
        ...current
      ])
      await refreshFilesFor(taskProjectPath)
      if (isForegroundProject(taskProjectPath)) {
        await refreshSnapshotsFor(taskProjectPath)
        setNotice(informational ? 'AI 已完成回答，项目未发生修改' : 'AI 已完成修改、构建和自动验收；请进入游戏测试实际玩法')
      }
    } catch (error) {
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      const failureDetail = aiFailureMessage(error)
      const inactivityTimeout = /没有返回任何内容|连接中断|线路繁忙|响应超时|上游模型服务异常/i.test(failureDetail)
      if (isWorkflowAuditRejection(error)) {
        if (isForegroundProject(taskProjectPath)) {
          setBeginnerTaskState('idle')
          setAiOutputStatus('idle')
          setNotice('验证流程尚未完成，任务已保留，可从恢复入口继续')
        }
        const recovery = await window.modmind.ai.getRecovery(taskProjectPath).catch(() => ({ pending: false, snapshot: null, sessionId: undefined }))
        if (recovery.pending) {
          if (isForegroundProject(taskProjectPath)) setAiRecovery(recovery)
          else {
            const key = normalizeProjectPath(taskProjectPath)
            const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
            projectWorkbenchCacheRef.current.set(key, {...current, aiRecovery: recovery, planning: false, aiOutputStatus: 'idle', beginnerTaskState: 'idle'})
          }
        }
        return
      }
      if (inactivityTimeout && isForegroundProject(taskProjectPath)) {
        setBeginnerTaskState('idle')
        setAiOutputStatus('error')
         setNoticeState(failureDetail)
      } else if (!isForegroundProject(taskProjectPath)) {
        const key = normalizeProjectPath(taskProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, planning: false, aiOutputStatus: 'error', beginnerTaskState: 'error'})
      } else if (uiModeRef.current === 'advanced') {
        setBeginnerTaskState('idle')
        setAiOutputStatus('idle')
      } else {
        setEvents((current) => [
          {
            id: `plan-error-${Date.now()}`,
            stage: 'error',
            title: 'AI 编程失败',
            detail: failureDetail,
            status: 'error',
            time: new Date().toISOString()
          },
          ...current
        ])
        setNotice('制作没有完成，可导出诊断日志')
        setBeginnerTaskState('error')
        setAiOutputStatus('error')
      }
      if (shouldOfferAiRecovery(error)) {
        const recovery = await window.modmind.ai.getRecovery(taskProjectPath).catch(() => ({ pending: false, snapshot: null, sessionId: undefined }))
        if (recovery.pending && isForegroundProject(taskProjectPath)) setAiRecovery(recovery)
      }
    } finally {
      if (isForegroundProject(taskProjectPath)) setPlanning(false)
      else {
        const key = normalizeProjectPath(taskProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, planning: false})
      }
    }
  }

  const deviceAuthorize = async (): Promise<void> => {
    setDeviceBusy(true)
    try {
      setDeviceState(await window.modmind.device.authorize())
    } catch (error) {
      setNotice(`连接失败：${errorMessage(error)}`)
    } finally {
      setDeviceBusy(false)
    }
  }

  const deviceCancel = async (): Promise<void> => {
    setDeviceBusy(true)
    try {
      setDeviceState(await window.modmind.device.cancelAuthorization())
    } catch (error) {
      setNotice(`取消失败：${errorMessage(error)}`)
    } finally {
      setDeviceBusy(false)
    }
  }

  const deviceDisconnect = async (): Promise<void> => {
    setDeviceBusy(true)
    try {
      setDeviceState(await window.modmind.device.disconnectLocal())
    } catch (error) {
      setNotice(`断开失败：${errorMessage(error)}`)
    } finally {
      setDeviceBusy(false)
    }
  }

  const deviceRefresh = async (): Promise<void> => {
    setDeviceBusy(true)
    try {
      setDeviceState(await window.modmind.device.refreshUsage())
    } catch (error) {
      setNotice(`刷新用量失败：${errorMessage(error)}`)
    } finally {
      setDeviceBusy(false)
    }
  }

  const deviceOpenSite = (): void => { void window.modmind.device.openSite().catch((error) => setErrorNotice(errorMessage(error))) }

  const remoteToggle = async (): Promise<void> => {
    setRemoteBusy(true)
    try {
      setRemoteState(await (remoteState.enabled ? window.modmind.remote.stop() : window.modmind.remote.start()))
    } catch (error) {
      setNotice(`Remote 连接失败：${errorMessage(error)}`)
    } finally {
      setRemoteBusy(false)
    }
  }

  const mcpBridgeToggle = async (enabled: boolean): Promise<void> => {
    setMcpBridgeBusy(true)
    try {
      setMcpBridgeState(await window.modmind.mcpBridge.setEnabled(enabled))
    } catch (error) {
      setNotice(`MCP 接入设置失败：${errorMessage(error)}`)
    } finally {
      setMcpBridgeBusy(false)
    }
  }

  const runPreflight = async (): Promise<void> => {
    if (!project || building) return
    const result = await performBuild(true)
    if (!result.success) {
      setNotice('项目构建失败，错误已保留在构建输出中')
    }
  }

  const exportArtifact = async (): Promise<void> => {
    try {
      const target = await window.modmind.project.exportArtifact()
      if (target) setNotice(project?.kind === 'modpack' ? `整合包已导出到 ${target}` : `Mod JAR 已导出到 ${target}`)
    } catch (error) {
      setNotice(`导出失败：${errorMessage(error)}`)
    }
  }

  const exportServerPack = async (): Promise<void> => {
    try {
      const target = await window.modmind.modpack.exportServerPack()
      if (target) setNotice(`服务端包已导出：${target}`)
    } catch (error) {
      setNotice(`服务端包导出失败：${errorMessage(error)}`)
    }
  }

  const repairBuildWithAi = async (): Promise<void> => {
    if (!project || !buildError || planning || building) return
    const taskProjectPath = project.path
    let failure = buildError
    const sessionId = `build-repair-${Date.now()}`
    workspaceSessionRef.current = sessionId
    const selectedBackend: AgentSettings['codingBackend'] = uiMode === 'beginner' ? 'quota' : settings.codingBackend
    setRunningBackend(selectedBackend)
    const usesQuota = selectedBackend === 'quota'
    const runToken = nextAiRunToken(taskProjectPath)
    setPlanning(true)
    setAiOutputStatus('running')
    try {
      if (usesQuota) await window.modmind.beginnerCodex.prepare(taskProjectPath)
      for (let round = 1; round <= MAX_AUTO_REPAIR_ROUNDS; round += 1) {
        if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
        const repairEvent: PipelineEvent = {
          id: `repair-build-${round}-${Date.now()}`,
          stage: 'planning',
          title: uiMode === 'beginner' ? 'Codex 正在自动修复' : `AI 自动修复 ${round}/${MAX_AUTO_REPAIR_ROUNDS}`,
          detail: '读取编译错误和当前工程文件',
          status: 'running',
          time: new Date().toISOString()
        }
        if (isForegroundProject(taskProjectPath)) setEvents((current) => [repairEvent, ...current])
        else {
          const key = normalizeProjectPath(taskProjectPath)
          const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
          projectWorkbenchCacheRef.current.set(key, {...current, events: [repairEvent, ...current.events].slice(0, 500), planning: true, aiOutputStatus: 'running'})
        }
        const repairRoundInstruction = uiMode === 'beginner'
          ? 'Fix every reported build error and keep repairing until verification passes.'
          : `Automatic build repair round ${round}/${MAX_AUTO_REPAIR_ROUNDS}. Fix every reported build error.`
        const result = await window.modmind.ai.createCode(
          `${repairRoundInstruction} Preserve the requested mod behavior and make the smallest complete source changes needed.\n\nBUILD FAILURE\n${failure}`,
          sessionId,
          selectedBackend,
          usesQuota ? 'beginner-unlimited' : 'standard',
          { surface: 'workspace', projectPath: taskProjectPath, runId: `repair-${runToken}` }
        )
        if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
        storeProjectPlan(taskProjectPath, result)
        await refreshFilesFor(taskProjectPath)
        await refreshSnapshotsFor(taskProjectPath)
        if (uiMode === 'beginner') {
          if (isForegroundProject(taskProjectPath)) setNotice('Codex 已完成修复、构建和验收')
          return
        }
          const build = await performBuild()
        if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
        if (build.success) {
          if (isForegroundProject(taskProjectPath)) setNotice(`AI 修复 ${round} 轮后构建成功`)
          return
        }
        failure = build.error
        if (isForegroundProject(taskProjectPath)) setAiOutputStatus('running')
      }
      if (isForegroundProject(taskProjectPath)) {
        setView('build')
        setNotice(`已自动修复 ${MAX_AUTO_REPAIR_ROUNDS} 轮，最后一次错误已保留`)
      }
    } catch (error) {
      if (!isCurrentAiRunToken(taskProjectPath, runToken)) return
      const detail = errorMessage(error)
      if (!isForegroundProject(taskProjectPath)) {
        const key = normalizeProjectPath(taskProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, planning: false, aiOutputStatus: 'error', buildError: detail})
      } else if (uiModeRef.current === 'advanced') {
        setAiOutputStatus('idle')
      } else {
        setAiOutputStatus('error')
        setEvents((current) => [
          {
            id: `repair-build-error-${Date.now()}`,
            stage: 'error',
            title: 'AI 修复未完成',
            detail,
            status: 'error',
            time: new Date().toISOString()
          },
          ...current
        ])
        setNotice(detail)
      }
    } finally {
      if (isForegroundProject(taskProjectPath)) setPlanning(false)
      else {
        const key = normalizeProjectPath(taskProjectPath)
        const current = projectWorkbenchCacheRef.current.get(key) ?? emptyProjectWorkbenchState()
        projectWorkbenchCacheRef.current.set(key, {...current, planning: false})
      }
    }
  }

  const createSnapshot = async (): Promise<void> => {
    if (!project) return
    try {
      const projectPath = project.path
      const result = await window.modmind.snapshots.create('手动快照', projectPath)
      setSnapshots((current) => [result, ...current])
      setNotice(`已保存 ${result.fileCount} 个文件`)
    } catch (error) {
      setNotice(`快照失败：${errorMessage(error)}`)
    }
  }

  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || building || planning || migrationBusy) return
    const unsavedMessage = editorDirty
      ? '\n\n当前代码编辑器有未保存内容；继续后会先保存，并包含在自动安全备份中'
      : ''
    if (!await requestConfirm({ title: `恢复快照“${snapshot.label}”？`, message: `当前项目状态会先自动备份，恢复失败时会自动回滚。${unsavedMessage}`, confirmLabel: '恢复快照', actionIcon: 'restore' })) return
    setRestoringSnapshotId(snapshot.id)
    try {
      if (editorDirty && selectedFile) await window.modmind.project.writeFile(selectedFile, editorContent, project.path)
      const projectPath = project.path
      const result = await window.modmind.snapshots.restore(snapshot.id, projectPath)
      setProject(result.project)
      setSelectedFile('')
      setEditorContent('')
      setEditorDirty(false)
      setBuildResult(null)
      setBuildError('')
      setEvents([])
      setMinecraftEvents([])
      setAiRecovery(null)
      await Promise.all([refreshFilesFor(projectPath), refreshSnapshotsFor(projectPath)])
      setNotice(`已恢复“${result.snapshot.label}”，恢复前状态已备份为 ${result.backup.id.slice(0, 19)}`)
    } catch (error) {
      setNotice(`恢复失败：${errorMessage(error)}`)
    } finally {
      setRestoringSnapshotId('')
    }
  }

  const deleteSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || deletingSnapshotId || building || planning || migrationBusy) return
    if (!await requestConfirm({ title: `永久删除快照“${snapshot.label}”？`, message: '删除后无法从 ModMind 恢复', confirmLabel: '永久删除', tone: 'danger' })) return
    setDeletingSnapshotId(snapshot.id)
    try {
      const projectPath = project.path
      const nextSnapshots = await window.modmind.snapshots.delete(snapshot.id, projectPath)
      if (isForegroundProject(projectPath)) setSnapshots(nextSnapshots)
      setNotice(`已删除快照“${snapshot.label}”`)
    } catch (error) {
      setNotice(`删除快照失败：${errorMessage(error)}`)
    } finally {
      setDeletingSnapshotId('')
    }
  }

  const previewMigration = async (): Promise<void> => {
    if (!project || !selectedMigrationVersion) return
    setMigrationBusy(true)
    try {
      setMigrationPreview(await window.modmind.project.previewMigration({ loader: migrationLoader, minecraftVersion: selectedMigrationVersion }))
    } catch (error) {
      setNotice(`迁移预检失败：${errorMessage(error)}`)
    } finally {
      setMigrationBusy(false)
    }
  }

  const runMigration = async (): Promise<void> => {
    if (!migrationPreview || migrationPreview.blockers.length) return
    setMigrationBusy(true)
    try {
      const result = await window.modmind.project.migrate({ loader: migrationPreview.target.loader, minecraftVersion: migrationPreview.target.minecraftVersion })
      if (result) {
        setProject(result.project)
        setMigrationPreview(null)
        setNotice(`迁移项目已生成，报告：${result.reportPath}`)
        void refreshRecentProjects()
      }
    } catch (error) {
      setNotice(`迁移失败：${errorMessage(error)}`)
    } finally {
      setMigrationBusy(false)
    }
  }

  const saveSettingsPatch = async (patch: Partial<AgentSettings>): Promise<void> => {
    const previous = settingsRef.current
    const next = { ...previous, ...patch }
    const mutation = settingsMutationRef.current + 1
    settingsMutationRef.current = mutation
    settingsRef.current = next
    setSettings(next)
    const save = settingsSaveTailRef.current.catch(() => undefined).then(() => window.modmind.settings.saveAgent(next))
    settingsSaveTailRef.current = save.then(() => undefined).catch(() => undefined)
    try {
      const saved = await save
      if (settingsMutationRef.current === mutation) {
        settingsRef.current = saved
        setSettings(saved)
        setNotice('设置已保存')
      }
    } catch (error) {
      if (settingsMutationRef.current === mutation) {
        settingsRef.current = previous
        setSettings(previous)
        setNotice(`配置保存失败：${errorMessage(error)}`)
      }
    }
  }

  const scanJavaHomes = (): void => {
    setJavaScanState('scanning')
    window.modmind.settings.scanJavaHomes()
      .then((homes) => { setDetectedJavaHomes(homes); setJavaScanState('done') })
      .catch(() => setJavaScanState('failed'))
  }

  useEffect(() => {
    if (view !== 'settings' || javaScanRequestedRef.current) return
    javaScanRequestedRef.current = true
    scanJavaHomes()
  }, [view])

  const updateJavaPreference = (scenario: keyof JavaPreferences) => (value: string): void => {
    const base = settings.javaPreferences ?? { game: '', build: '', tools: '' }
    void saveSettingsPatch({ javaPreferences: { ...base, [scenario]: value } })
  }

  const configureExternalAgent = async (kind: ExternalAgentKind): Promise<void> => {
    if (configuringAgents[kind]) return
    const usesManagedService = kind === 'codex'
    if (usesManagedService && (!agentDraft.baseUrl?.trim() || !agentDraft.model?.trim() || (!agentDraft.apiKey?.trim() && !settings.externalAgents?.[kind]?.hasStoredKey))) {
      setNotice('请填写 Base URL、API Key 并选择模型')
      return
    }
    setConfiguringAgents((current) => ({ ...current, [kind]: true }))
    try {
      const result = await window.modmind.externalAgents.configure(kind, agentDraft)
      const refreshedSettings = await window.modmind.settings.getAgent()
      settingsRef.current = refreshedSettings
      setSettings(refreshedSettings)
      setEditingAgent(null)
      setAgentDraft({})
      setNotice(`${externalAgentLabel(kind)} 配置完成${result.configPath ? `：${result.configPath}` : ''}`)
    } catch (error) {
      setNotice(`自动配置失败：${errorMessage(error)}`)
    } finally {
      setConfiguringAgents((current) => ({ ...current, [kind]: false }))
    }
  }

  const exportDiagnosticLogs = async (): Promise<void> => {
    if (diagnosticExporting) return
    setDiagnosticExporting(true)
    try {
      capturePageSnapshot()
      const target = await window.modmind.diagnostics.exportLogs([...pageSnapshotsRef.current.values()])
      if (target) setNotice(`诊断日志已导出：${target}`)
    } catch (error) {
      setNotice(`诊断日志导出失败：${errorMessage(error)}`)
    } finally {
      setDiagnosticExporting(false)
    }
  }

  const saveImageSettings = async (patch: Partial<ImageStudioSettings> & { apiKey?: string; clearApiKey?: boolean }): Promise<void> => {
    try {
      const next = { ...imageStudioSettings, ...patch }
      setImageStudioSettings(await window.modmind.imageStudio.saveSettings({ ...next, apiKey: patch.apiKey ?? imageApiKey, clearApiKey: patch.clearApiKey }))
      if (patch.apiKey !== undefined) setImageApiKey('')
      setNotice('图像服务设置已保存')
    } catch (error) {
      setNotice(`图像服务设置保存失败：${errorMessage(error)}`)
    }
  }

  const clearImageApiKey = async (): Promise<void> => {
    if (!await requestConfirm({ title: '删除已保存的图片 API Key？', message: '删除后图像服务将改用 ModMind 托管额度', confirmLabel: '删除 Key', tone: 'danger' })) return
    await saveImageSettings({ apiKey: '', clearApiKey: true })
  }

  const saveBeginnerAiPreference = async (patch: Partial<BeginnerAiPreferences>): Promise<void> => {
    if (savingAiPreferences) return
    const previous = beginnerAiPreferences
    const next = { ...beginnerAiPreferences, ...patch }
    setBeginnerAiPreferences(next)
    setSavingAiPreferences(true)
    try {
      setBeginnerAiPreferences(await window.modmind.device.saveAiPreferences(next))
      setNotice('智能引擎设置已保存')
    } catch (error) {
      setBeginnerAiPreferences(previous)
      setNotice(`智能引擎设置保存失败：${errorMessage(error)}`)
    } finally {
      setSavingAiPreferences(false)
    }
  }

  const selectCodingBackend = (backend: AgentSettings['codingBackend']): void => {
    const currentSettings = settingsRef.current
    const currentBackend = runningBackend ?? currentSettings.codingBackend
    if ((!planning && backend === currentSettings.codingBackend) || (planning && !switchingBackendRef.current && backend === currentBackend) || switchingBackendRef.current === backend) return
    const generation = backendSwitchCounterRef.current + 1
    backendSwitchCounterRef.current = generation
    backendSwitchGenerationRef.current = generation
    const taskProjectPath = project?.path
    const activeConversation = workbenchConversations.find((item) => item.id === activeWorkbenchConversationId)
    if (!taskProjectPath || uiMode !== 'advanced' || (!planning && !aiRecovery)) {
      void saveSettingsPatch({ codingBackend: backend })
      return
    }
    const wasPlanning = planning
    let restoredPreviousSwitch = false
    let preservePlanning = false
    const request: PendingBackendSwitch = { generation, backend, previousBackend: currentBackend, accepted: false }
    backendSwitchRequestsRef.current.set(generation, request)
    pendingBackendSwitchRef.current = request
    switchingBackendRef.current = backend
    setSwitchingBackend(backend)
    setPlanning(true)
    setAiOutputStatus('running')
    nextAiRunToken(taskProjectPath)
    void window.modmind.ai.switchBackend(backend, taskProjectPath, activeConversation?.sessionScope, generation)
      .then(async (result) => {
        if (backendSwitchGenerationRef.current !== generation) return
        if (result.status === 'superseded') return
        if (result.status === 'rejected') {
          const taskState = await window.modmind.ai.getProjectTaskState(taskProjectPath).catch(() => null)
          if (backendSwitchGenerationRef.current !== generation) return
          preservePlanning = wasPlanning && (taskState ? Boolean(taskState.startedAt) : true)
          const activePending = result.activeSwitchId !== undefined
            ? backendSwitchRequestsRef.current.get(result.activeSwitchId)
            : undefined
          if (activePending && taskState?.startedAt) {
            restoredPreviousSwitch = true
            const activeReady = result.activeReady === true || activePending.accepted
            backendSwitchGenerationRef.current = activePending.generation
            pendingBackendSwitchRef.current = activeReady ? null : activePending
            switchingBackendRef.current = activeReady ? null : activePending.backend
            setSwitchingBackend(activeReady ? null : activePending.backend)
            if (activeReady) {
              settingsRef.current = { ...settingsRef.current, codingBackend: activePending.backend }
              setSettings((current) => ({ ...current, codingBackend: activePending.backend }))
              setRunningBackend(activePending.backend)
            }
          } else {
            const activeBackend = result.activeBackend ?? currentBackend
            pendingBackendSwitchRef.current = null
            switchingBackendRef.current = null
            setSwitchingBackend(null)
            settingsRef.current = { ...settingsRef.current, codingBackend: activeBackend }
            setSettings((current) => ({ ...current, codingBackend: activeBackend }))
            setRunningBackend(activeBackend)
          }
          setAiOutputStatus(preservePlanning ? 'running' : 'error')
          setNotice(`引擎切换失败：${result.message ?? '目标引擎当前不可用'}`)
          return
        }
        const pending = pendingBackendSwitchRef.current
        if (pending?.generation === generation && !pending.accepted) {
          pending.accepted = true
          settingsRef.current = { ...settingsRef.current, codingBackend: backend }
          setSettings((current) => ({ ...current, codingBackend: backend }))
          setRunningBackend(backend)
        }
        setAiRecovery(null)
        if (result.result) storeProjectPlan(taskProjectPath, result.result)
        if (result.status === 'idle') setNotice(`已切换到 ${backend === 'quota' ? '智能引擎' : backend === 'codex' ? 'Codex' : 'Claude Code'}`)
      })
      .catch(async (error) => {
        const taskState = await window.modmind.ai.getProjectTaskState(taskProjectPath).catch(() => null)
        if (backendSwitchGenerationRef.current === generation) {
          preservePlanning = wasPlanning && (taskState ? Boolean(taskState.startedAt) : true)
          const pending = pendingBackendSwitchRef.current
          if (pending?.generation === generation && !pending.accepted) {
            settingsRef.current = { ...settingsRef.current, codingBackend: pending.previousBackend }
            setSettings((current) => ({ ...current, codingBackend: pending.previousBackend }))
            setRunningBackend(taskState?.backend ?? pending.previousBackend)
          }
          setNotice(`引擎切换失败：${aiFailureMessage(error)}`)
          setAiOutputStatus(preservePlanning ? 'running' : 'error')
        }
      })
      .finally(() => {
        backendSwitchRequestsRef.current.delete(generation)
        if (backendSwitchGenerationRef.current === generation) {
          pendingBackendSwitchRef.current = null
          switchingBackendRef.current = null
          setSwitchingBackend(null)
          setPlanning(preservePlanning)
        } else if (restoredPreviousSwitch) {
          setPlanning(preservePlanning)
        }
      })
  }

  const selectUiMode = (nextMode: UiMode): void => {
    if (nextMode === uiMode) return
    if (nextMode === 'beginner') {
      setLastAdvancedView(view === 'settings' ? 'workspace' : view)
      setView('workspace')
    } else {
      setView(lastAdvancedView)
    }
    setUiMode(nextMode)
    try {
      localStorage.setItem('modmind-ui-mode', nextMode)
    } catch {
      // A restricted webview may not expose localStorage; the in-memory mode still works.
    }
  }

  const launchExternalAgent = async (kind: ExternalAgentKind): Promise<void> => {
    try {
      await window.modmind.externalAgents.launch(kind)
      setNotice(`${externalAgentLabel(kind)} 已在项目目录启动`)
    } catch (error) {
      setErrorNotice(errorMessage(error))
    }
  }

  const installExternalAgent = async (kind: ExternalAgentKind): Promise<void> => {
    setInstallingAgents((current) => ({ ...current, [kind]: true }))
    setNotice(`正在安装 ${externalAgentLabel(kind)}…`)
    try {
      const status = await window.modmind.externalAgents.install(kind)
      setExternalAgents((current) => [...current.filter((item) => item.kind !== kind), status])
      setNotice(`${status.label} ${status.version ?? ''} 安装完成`)
    } catch (error) {
      setNotice(`安装失败：${errorMessage(error)}`)
    } finally {
      setInstallingAgents((current) => ({ ...current, [kind]: false }))
    }
  }

  const openExternalAgentDocs = async (kind: ExternalAgentKind): Promise<void> => {
    try {
      await window.modmind.externalAgents.openDocs(kind)
    } catch (error) {
      setNotice(`无法打开安装教程：${errorMessage(error)}`)
    }
  }

  const scanModels = async (): Promise<void> => {
    if (scanningModels || !editingAgent || !agentDraft.baseUrl?.trim()) return
    setScanningModels(true)
    setModelScanMessage('正在读取可用模型…')
    try {
      const models = await window.modmind.settings.listAgentModels(editingAgent, agentDraft)
      setAvailableModels(models)
      setModelScanMessage(models.length ? `发现 ${models.length} 个模型` : '接口没有返回可用模型，可手动填写 ID')
      if (models.length === 1 && !agentDraft.model) setAgentDraft((current) => ({ ...current, model: models[0].id }))
    } catch (error) {
      setAvailableModels([])
      setModelScanMessage(aiFailureMessage(error))
    } finally {
      setScanningModels(false)
    }
  }

  const scanBeginnerModels = async (): Promise<void> => {
    if (scanningBeginnerModels) return
    setScanningBeginnerModels(true)
    setBeginnerModelScanMessage('正在读取账号可用模型…')
    try {
      const models = await window.modmind.device.listModels(true)
      setBeginnerAvailableModels(models)
      setBeginnerAiPreferences(await window.modmind.device.getAiPreferences())
      setBeginnerModelScanMessage(models.length ? `发现 ${models.length} 个可用模型` : '账号服务没有返回可用模型')
    } catch (error) {
      setBeginnerAvailableModels([])
      setBeginnerModelScanMessage(aiFailureMessage(error))
    } finally {
      setScanningBeginnerModels(false)
    }
  }

  const saveGiteeBuildSettings = async (): Promise<void> => {
    setGiteeBuildBusy('save')
    try {
      const saved = await window.modmind.production.remoteBuild.saveGiteeSettings(giteeSettings)
      setGiteeSettings(saved)
      setGiteeValidation(null)
      setNotice('Gitee 构建配置已保存')
    } catch (error) {
      setNotice(`Gitee 配置保存失败：${errorMessage(error)}`)
    } finally {
      setGiteeBuildBusy('')
    }
  }

  const validateGitee = async (): Promise<void> => {
    setGiteeBuildBusy('validate')
    try {
      const result = await window.modmind.production.remoteBuild.validateGitee(giteeSettings)
      setGiteeValidation(result)
      setNotice(result.detail)
    } catch (error) {
      setGiteeValidation({ valid: false, detail: errorMessage(error) })
      setNotice(`Gitee 校验失败：${errorMessage(error)}`)
    } finally {
      setGiteeBuildBusy('')
    }
  }

  const triggerGiteeBuild = async (): Promise<void> => {
    if (!giteeSettings.repositoryUrl.trim()) {
      setNotice('请先填写 Gitee 仓库地址')
      return
    }
    setGiteeBuildBusy('build')
    setGiteeBuildResult(null)
    try {
      const saved = await window.modmind.production.remoteBuild.saveGiteeSettings(giteeSettings)
      setGiteeSettings(saved)
      const result = await window.modmind.production.remoteBuild.triggerGitee()
      setGiteeBuildResult(result)
      setNotice(result.detail)
    } catch (error) {
      setNotice(`Gitee 远程构建失败：${errorMessage(error)}`)
    } finally {
      setGiteeBuildBusy('')
    }
  }

  const latestEvent = events[0]
  const javaProject = !project || isJavaLoader(project.loader)
  const modpackProject = project?.kind === 'modpack'
  const workspacePromptHeading = modpackProject ? '描述整合包的下一步' : '描述你想要的 Mod'
  const workspacePromptDescription = modpackProject
    ? 'AI 会读取当前整合包，并直接修改任务、配置、资源或脚本'
    : 'AI 将读取现有工程，直接创建或修改代码与资源文件'
  const workspacePromptPlaceholder = modpackProject
    ? '例如：加入一条新手任务线，并为每一步配置奖励'
    : '例如：制作一个可以储存经验值的水晶方块，右键存入，Shift 右键取出…'
  const migrationVersions = loaderCatalog.filter((option) => option.loader === migrationLoader)
  const selectedMigrationVersion = migrationVersion || migrationVersions[0]?.minecraftVersion || ''
  const filteredModels = availableModels.filter((model) => model.id.toLowerCase().includes(modelSearch.trim().toLowerCase()))
  const filteredMappingMembers = mappingDetail?.members.filter((member) => {
    const query = mappingMemberQuery.trim().toLowerCase()
    return !query || `${member.type} ${Object.values(member.names).join(' ')}`.toLowerCase().includes(query)
  }) ?? []
  const navGroups = useMemo(
    () => {
      if (!project) {
        return [
          {
            label: '项目',
            items: [{ id: 'workspace' as const, label: '项目', icon: FolderOpen }]
          },
          {
            label: '应用',
            items: [
              { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
              { id: 'settings' as const, label: '设置', icon: Settings }
            ]
          }
        ]
      }

      if (modpackProject) {
        return [
          { label: '整合包', items: [
            { id: 'workspace' as const, label: '整合包创作', icon: MessageSquareText },
            { id: 'modpack-manifest' as const, label: '文件清单', icon: Archive },
            { id: 'modpack-mod-list' as const, label: '模组列表', icon: List },
            { id: 'third-party-mods' as const, label: '模组下载', icon: PackagePlus }
          ] },
          { label: '内容', items: [
            { id: 'modpack-config' as const, label: '配置与默认项', icon: FileCog },
            { id: 'modpack-scripts' as const, label: '脚本与 KubeJS', icon: Code2 },
            { id: 'modpack-datapacks' as const, label: '数据包', icon: Archive },
            { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
            { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
            { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
            { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image },
            { id: 'modpack-shaders' as const, label: '光影包', icon: Sparkles },
            { id: 'modpack-ui' as const, label: '界面资源', icon: WandSparkles },
            { id: 'modpack-worlds' as const, label: '存档与世界', icon: Save },
            { id: 'modpack-client' as const, label: '玩家预设', icon: SlidersHorizontal },
            { id: 'modpack-server-content' as const, label: '服务端配置', icon: ServerCog },
            { id: 'modpack-files' as const, label: '文件工作台', icon: FolderOpen },
            { id: 'code' as const, label: '代码编辑器', icon: Code2 }
          ] },
          { label: '运行', items: [
            { id: 'modpack-migration' as const, label: '版本迁移', icon: ArrowRightLeft },
            { id: 'decompile' as const, label: '反编译', icon: Binary },
            { id: 'modpack-automation' as const, label: '依赖与优化', icon: Gauge },
            { id: 'modpack-server' as const, label: '本机服务端', icon: Server },
            { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 },
            { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
          ] },
          { label: '项目', items: [
            { id: 'production' as const, label: '版本与导出', icon: CloudUpload },
            { id: 'snapshots' as const, label: '版本记录', icon: History },
            { id: 'settings' as const, label: '设置', icon: Settings }
          ] }
        ]
      }

      return [
      {
        label: '创作',
        items: modpackProject ? [
          { id: 'workspace' as const, label: '整合包创作', icon: MessageSquareText },
          { id: 'modpack-mod-list' as const, label: '模组列表', icon: List },
          { id: 'third-party-mods' as const, label: '模组下载', icon: PackagePlus },
          { id: 'modpack-config' as const, label: '配置与默认项', icon: FileCog },
          { id: 'modpack-scripts' as const, label: '脚本与 KubeJS', icon: Code2 },
          { id: 'modpack-datapacks' as const, label: '数据包', icon: Archive },
          { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
          { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
          { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image },
          { id: 'modpack-shaders' as const, label: '光影包', icon: Sparkles },
          { id: 'modpack-ui' as const, label: '界面资源', icon: WandSparkles },
          { id: 'modpack-worlds' as const, label: '存档与世界', icon: Save },
          { id: 'modpack-client' as const, label: '玩家预设', icon: SlidersHorizontal },
          { id: 'modpack-server-content' as const, label: '服务端配置', icon: ServerCog },
          { id: 'modpack-files' as const, label: '文件工作台', icon: FolderOpen },
          { id: 'modpack-automation' as const, label: '依赖与优化', icon: Gauge },
          { id: 'modpack-server' as const, label: '本机服务端', icon: Server },
          { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 },
          { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
        ] : [
          { id: 'workspace' as const, label: '工作台', icon: MessageSquareText },
          { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb },
          { id: 'image-studio' as const, label: '资源', icon: WandSparkles },
          { id: 'blockbench' as const, label: '模型', icon: Box },
          { id: 'code' as const, label: '代码', icon: Code2 },
          ...(javaProject ? [{ id: 'relationships' as const, label: '前置与联动', icon: Link2 }] : []),
          ...(javaProject ? [{ id: 'decompile' as const, label: '反编译', icon: Binary }] : []),
          ...(javaProject ? [{ id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }] : []),
          { id: 'build' as const, label: '构建与导出', icon: Hammer }
        ]
      },
      {
        label: '项目',
        items: modpackProject ? [
          { id: 'production' as const, label: '导出', icon: CloudUpload },
          { id: 'snapshots' as const, label: '版本', icon: History },
          { id: 'settings' as const, label: '设置', icon: Settings }
        ] : [
          ...(javaProject ? [{ id: 'production' as const, label: '发布', icon: CloudUpload }] : []),
          { id: 'snapshots' as const, label: '版本', icon: History },
          ...(javaProject ? [{ id: 'mappings' as const, label: 'Mappings', icon: LibraryBig }] : []),
          { id: 'settings' as const, label: '设置', icon: Settings }
        ]
      }
      ]
    },
    [javaProject, modpackProject, project]
  )
  const visibleNavGroupsRaw = uiMode === 'beginner'
    ? !project
      ? [
          { label: '项目', items: [{ id: 'workspace' as const, label: '项目', icon: FolderOpen }] },
          { label: '应用', items: [
            { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
            { id: 'settings' as const, label: '设置', icon: Settings }
          ] }
        ]
      : [
          ...(modpackProject ? [{
            label: '创作',
            items: [
              { id: 'workspace' as const, label: '工作台', icon: Sparkles },
              { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb },
              { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
              { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
              { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
              { id: 'code' as const, label: '代码编辑器', icon: Code2 },
              { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }
            ]
          }] : []),
          ...(!modpackProject ? [
          { label: '创作', items: [
            { id: 'workspace' as const, label: '开始创作', icon: Sparkles },
            { id: 'inspiration' as const, label: '灵感', icon: Lightbulb },
            ...(javaProject ? [{ id: 'relationships' as const, label: '联动模组', icon: Link2 }] : []),
            ...(javaProject
              ? [{ id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }]
              : [{ id: 'build' as const, label: '构建与导出', icon: Hammer }])
          ] }
          ] : [])
        ]
    : navGroups
  // 用户插件分组：追加到导航尾部。
  // 高级模式常驻「管理插件」入口（面向制作者，保证可发现性）；新手模式仅在已启用面板插件时出现。
  const enabledPanelPlugins = useMemo(
    () => pluginSnapshot.plugins.filter((plugin) => plugin.enabled && !plugin.error && plugin.manifest.panel),
    [pluginSnapshot]
  )
  const hasEnabledOverlayPlugin = useMemo(
    () => pluginSnapshot.plugins.some((plugin) => plugin.enabled && !plugin.error && plugin.manifest.overlay),
    [pluginSnapshot]
  )
  const visibleNavGroupsWithPlugins = useMemo(
    () => {
      const showManagerAlways = uiMode !== 'beginner'
      if (enabledPanelPlugins.length === 0 && !hasEnabledOverlayPlugin && !showManagerAlways) return visibleNavGroupsRaw
      return [...visibleNavGroupsRaw, {
        label: '插件',
        items: [
          ...enabledPanelPlugins.map((plugin) => ({
            id: `plugin:${plugin.manifest.id}` as ViewId,
            label: plugin.manifest.name,
            icon: Puzzle
          })),
          { id: 'plugins' as const, label: '管理插件', icon: Puzzle }
        ]
      }]
    },
    [enabledPanelPlugins, hasEnabledOverlayPlugin, visibleNavGroupsRaw, uiMode]
  )
  const navLabelMap: Partial<Record<ViewId, string>> = {
    workspace: modpackProject ? '工作台' : uiMode === 'beginner' ? '开始创作' : '工作台',
    inspiration: '灵感台',
    relationships: uiMode === 'beginner' ? '联动模组' : '前置与联动',
    'modpack-manifest': '文件清单',
    'modpack-mod-list': '模组列表',
    'third-party-mods': '模组下载',
    'modpack-config': '配置与默认项',
    'modpack-scripts': '脚本与 KubeJS',
    'modpack-datapacks': '数据包',
    'modpack-content': '任务与手册',
    'ftb-quests': 'FTB 任务书',
    patchouli: 'Patchouli 指南书',
    'modpack-resourcepacks': '资源包',
    'modpack-shaders': '光影包',
    'modpack-ui': '界面资源',
    'modpack-worlds': '存档与世界',
    'modpack-client': '玩家预设',
    'modpack-server-content': '服务端配置',
    'modpack-files': '文件工作台',
    'modpack-migration': '版本迁移',
    decompile: '反编译',
    plugins: '管理插件',
    'modpack-automation': '依赖与优化',
    'modpack-server': '服务端测试',
    minecraft: '游戏测试',
    'image-studio': '图像工坊',
    blockbench: '模型',
    code: '代码',
    build: '构建与导出',
    production: '发布',
    snapshots: '版本记录',
    mappings: 'Mappings',
    settings: '设置'
  }
  const navOrderStorageKey = `modmind-sidebar-order:v2:${uiMode}:${project?.kind ?? 'launcher'}:${javaProject ? 'java' : 'addon'}`
  const navGroupOrderStorageKey = `${navOrderStorageKey}:groups`

  const resetSidebarOrder = async (): Promise<void> => {
    if (!await requestConfirm({
      title: '恢复侧边栏默认顺序？',
      message: '这会清除当前项目的功能和类型排序，恢复默认顺序',
      confirmLabel: '恢复默认顺序',
      cancelLabel: '保留当前顺序',
      tone: 'danger',
      actionIcon: 'restore'
    })) return

    try {
      localStorage.removeItem(navOrderStorageKey)
      localStorage.removeItem(navGroupOrderStorageKey)
      setSidebarOrders({})
      setSidebarGroupOrder([])
      setNotice('侧边栏顺序已恢复默认')
    } catch (error) {
      setNotice(`恢复侧边栏顺序失败：${errorMessage(error)}`)
    }
  }

  useEffect(() => {
    const load = (): void => {
      try {
        const stored = localStorage.getItem(navOrderStorageKey)
        const parsed = stored ? JSON.parse(stored) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid sidebar order')
        const orders: Record<string, string[]> = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) orders[key] = value.filter((item): item is string => typeof item === 'string')
        }
        setSidebarOrders(orders)
      } catch {
        setSidebarOrders({})
      }
    }
    const onStorage = (event: StorageEvent): void => { if (event.key === navOrderStorageKey) load() }
    load()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [navOrderStorageKey])

  useEffect(() => {
    const load = (): void => {
      try {
        const stored = localStorage.getItem(navGroupOrderStorageKey)
        const parsed = stored ? JSON.parse(stored) : []
        setSidebarGroupOrder(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
      } catch {
        setSidebarGroupOrder([])
      }
    }
    const onStorage = (event: StorageEvent): void => { if (event.key === navGroupOrderStorageKey) load() }
    load()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [navGroupOrderStorageKey])

  const baseVisibleNavGroups = visibleNavGroupsWithPlugins.map((group, groupIndex) => ({
    ...group,
    groupKey: String(groupIndex),
    label: group.label === '创建' || group.label === '鍒涗綔' ? '创作' : group.label === '项目' || group.label === '椤圭洰' ? '项目' : group.label === '应用' || group.label === '搴旂敤' ? '应用' : group.label,
    items: (() => {
      const mapped = group.items
        .filter((item) => uiMode !== 'beginner' || !['ftb-quests', 'patchouli', 'image-studio'].includes(item.id))
        .map((item) => ({ ...item, label: navLabelMap[item.id] || item.label }))
      if (uiMode === 'beginner' && modpackProject && !mapped.some((item) => item.id === 'modpack-server')) {
        mapped.push({ id: 'modpack-server' as const, label: '服务端测试', icon: Server })
      }
      if (!modpackProject || uiMode === 'beginner' || groupIndex !== 0) return mapped
      const primary = mapped.find((item) => item.id === 'workspace')
      const inspiration = { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
      const modList = mapped.find((item) => item.id === 'modpack-mod-list')
      const downloads = mapped.find((item) => item.id === 'third-party-mods')
      const rest = mapped.filter((item) => !['workspace', 'inspiration', 'modpack-mod-list', 'third-party-mods'].includes(item.id))
      return [primary, inspiration, modList, downloads, ...rest].filter(Boolean) as typeof mapped
    })().sort((left, right) => {
      const order = sidebarOrders[String(groupIndex)] ?? []
      const leftIndex = order.indexOf(left.id)
      const rightIndex = order.indexOf(right.id)
      if (leftIndex < 0 && rightIndex < 0) return 0
      if (leftIndex < 0) return 1
      if (rightIndex < 0) return -1
      return leftIndex - rightIndex
    })
  }))
  type BaseSidebarItem = (typeof baseVisibleNavGroups)[number]['items'][number]
  const navItemsById = new Map<string, BaseSidebarItem>(
    baseVisibleNavGroups.flatMap((group) => group.items.map((item) => [item.id, item] as [string, BaseSidebarItem]))
  )
  const assignedNavItemIds = new Set<string>()
  for (const group of baseVisibleNavGroups) {
    for (const id of sidebarOrders[group.groupKey] ?? []) {
      if (navItemsById.has(id)) assignedNavItemIds.add(id)
    }
  }
  const visibleNavGroups = baseVisibleNavGroups.map((group) => {
    const savedItems = (sidebarOrders[group.groupKey] ?? [])
      .map((id) => navItemsById.get(id))
      .filter((item): item is (typeof group.items)[number] => Boolean(item))
    const defaultItems = group.items.filter((item) => !assignedNavItemIds.has(item.id))
    return { ...group, items: [...savedItems, ...defaultItems].filter((item) => !detachedSidebarItemIds.has(item.id)) }
  })
  const orderedVisibleNavGroups = [...visibleNavGroups].filter((group) => !detachedSidebarGroupKeys.has(group.groupKey)).sort((left, right) => {
    const leftIndex = sidebarGroupOrder.indexOf(left.groupKey)
    const rightIndex = sidebarGroupOrder.indexOf(right.groupKey)
    if (leftIndex < 0 && rightIndex < 0) return 0
    if (leftIndex < 0) return 1
    if (rightIndex < 0) return -1
    return leftIndex - rightIndex
  })
  const detachedGroup = initialDetachedGroup ? orderedVisibleNavGroups.find((group) => group.groupKey === initialDetachedGroup) : undefined
  const detachedWindowTitle = navLabelMap[view] ?? 'ModMind'

  useEffect(() => {
    const firstItemId = detachedGroup?.items[0]?.id
    if (!initialDetachedGroup || view !== 'workspace' || !firstItemId) return
    setView(firstItemId)
  }, [detachedGroup?.groupKey, detachedGroup?.items[0]?.id, initialDetachedGroup, view])

  useLayoutEffect(() => {
    const nav = sidebarNavRef.current
    if (!nav) return
    for (const animation of sidebarLayoutAnimationsRef.current.values()) animation.cancel()
    sidebarLayoutAnimationsRef.current.clear()
    const draggedKey = sidebarDragItemRef.current ? `item:${sidebarDragItemRef.current.id}` : sidebarDragGroupKeyRef.current ? `group:${sidebarDragGroupKeyRef.current}` : ''
    const next = new Map<string, DOMRect>()
    nav.querySelectorAll<HTMLElement>('[data-sidebar-drag-key]').forEach((node) => {
      const key = node.dataset.sidebarDragKey
      if (!key) return
      const rect = node.getBoundingClientRect()
      const previous = sidebarLayoutSnapshotRef.current.get(key)
      if (previous) {
        const deltaX = previous.left - rect.left
        const deltaY = previous.top - rect.top
        if (key !== draggedKey && (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1)) {
          const animation = node.animate([{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0, 0)' }], { duration: 115, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)' })
          sidebarLayoutAnimationsRef.current.set(key, animation)
          void animation.finished.then(() => { if (sidebarLayoutAnimationsRef.current.get(key) === animation) sidebarLayoutAnimationsRef.current.delete(key) }).catch(() => undefined)
        }
      }
      next.set(key, rect)
    })
    sidebarLayoutSnapshotRef.current = next
  }, [sidebarOrders, sidebarGroupOrder, detachedSidebarGroupKeys, detachedSidebarItemIds])

  const moveSidebarItem = (fromGroupKey: string, targetGroupKey: string, targetItems: Array<{ id: ViewId }>, draggedId: ViewId, targetId: ViewId | null, insertAfter = false): void => {
    const sourceGroup = visibleNavGroups.find((group) => group.groupKey === fromGroupKey)
    if (!sourceGroup) return
    setSidebarOrders((current) => {
      const normalizedIds = (groupKey: string, items: Array<{ id: ViewId }>): string[] => {
        const availableIds = items.map((item) => item.id)
        const saved = current[groupKey] ?? []
        return [...saved.filter((id) => availableIds.includes(id as ViewId)), ...availableIds.filter((id) => !saved.includes(id))]
      }
      const sourceIds = normalizedIds(fromGroupKey, sourceGroup.items)
      if (!sourceIds.includes(draggedId)) return current
      const next = { ...current }
      if (fromGroupKey === targetGroupKey) {
        if (draggedId === targetId) return current
        const reorderedIds = sourceIds.filter((id) => id !== draggedId)
        const targetPosition = targetId ? reorderedIds.indexOf(targetId) : reorderedIds.length
        if (targetPosition < 0) return current
        const targetIndex = targetPosition + (targetId && insertAfter ? 1 : 0)
        reorderedIds.splice(targetIndex, 0, draggedId)
        if (reorderedIds.length === sourceIds.length && reorderedIds.every((id, index) => id === sourceIds[index])) return current
        next[fromGroupKey] = reorderedIds
      } else {
        const targetIds = normalizedIds(targetGroupKey, targetItems).filter((id) => id !== draggedId)
        const targetPosition = targetId ? targetIds.indexOf(targetId) : targetIds.length
        if (targetPosition < 0) return current
        const targetIndex = targetPosition + (targetId && insertAfter ? 1 : 0)
        next[fromGroupKey] = sourceIds.filter((id) => id !== draggedId)
        targetIds.splice(targetIndex, 0, draggedId)
        next[targetGroupKey] = targetIds
      }
      try {
        localStorage.setItem(navOrderStorageKey, JSON.stringify(next))
      } catch {
        // The session remains ordered even when browser storage is unavailable.
      }
      return next
    })
  }

  const moveSidebarGroup = (draggedGroupKey: string, targetGroupKey: string, insertAfter = false): void => {
    if (draggedGroupKey === targetGroupKey) return
    setSidebarGroupOrder((current) => {
      const groupKeys = visibleNavGroups.map((group) => group.groupKey)
      const orderedKeys = [...current.filter((key) => groupKeys.includes(key)), ...groupKeys.filter((key) => !current.includes(key))]
      const fromIndex = orderedKeys.indexOf(draggedGroupKey)
      const targetIndex = orderedKeys.indexOf(targetGroupKey)
      if (fromIndex < 0 || targetIndex < 0) return current
      orderedKeys.splice(fromIndex, 1)
      orderedKeys.splice(orderedKeys.indexOf(targetGroupKey) + (insertAfter ? 1 : 0), 0, draggedGroupKey)
      if (orderedKeys.every((key, index) => key === [...current.filter((key) => groupKeys.includes(key)), ...groupKeys.filter((key) => !current.includes(key))][index])) return current
      try {
        localStorage.setItem(navGroupOrderStorageKey, JSON.stringify(orderedKeys))
      } catch {
        // The session remains ordered even when browser storage is unavailable.
      }
      return orderedKeys
    })
  }

  const stopSidebarDragScroll = (): void => {
    sidebarDragScrollVelocityRef.current = 0
    if (sidebarDragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarDragScrollFrameRef.current)
      sidebarDragScrollFrameRef.current = null
    }
  }

  const updateSidebarDragScroll = (clientY: number): void => {
    const nav = sidebarNavRef.current
    if (!nav || (!sidebarDragItemRef.current && !sidebarDragGroupKeyRef.current)) return
    const bounds = nav.getBoundingClientRect()
    const edge = Math.min(64, Math.max(32, bounds.height * 0.18))
    const distanceFromTop = clientY - bounds.top
    const distanceFromBottom = bounds.bottom - clientY
    const intensity = distanceFromTop < edge ? (distanceFromTop - edge) / edge : distanceFromBottom < edge ? (edge - distanceFromBottom) / edge : 0
    const velocity = Math.sign(intensity) * Math.min(18, Math.max(2, Math.abs(intensity) * 18))
    if (!velocity || (velocity < 0 && nav.scrollTop <= 0) || (velocity > 0 && nav.scrollTop + nav.clientHeight >= nav.scrollHeight)) {
      stopSidebarDragScroll()
      return
    }
    sidebarDragScrollVelocityRef.current = velocity
    if (sidebarDragScrollFrameRef.current !== null) return
    const tick = (): void => {
      const element = sidebarNavRef.current
      const nextVelocity = sidebarDragScrollVelocityRef.current
      if (!element || !nextVelocity) {
        sidebarDragScrollFrameRef.current = null
        return
      }
      const previous = element.scrollTop
      element.scrollTop += nextVelocity
      if (element.scrollTop === previous) {
        stopSidebarDragScroll()
        return
      }
      sidebarDragScrollFrameRef.current = window.requestAnimationFrame(tick)
    }
    sidebarDragScrollFrameRef.current = window.requestAnimationFrame(tick)
  }

  const handleSidebarWheel = (event: React.WheelEvent<HTMLElement>): void => {
    const nav = sidebarNavRef.current
    if (!nav || !event.deltaY) return
    nav.scrollTop += event.deltaY
    event.preventDefault()
  }

  const beginSidebarDrag = (event: React.DragEvent<HTMLButtonElement>, item: { id: ViewId; label: string }, groupKey: string): void => {
    window.getSelection()?.removeAllRanges()
    sidebarDropHandledRef.current = false
    sidebarDragGroupKeyRef.current = null
    sidebarDragItemRef.current = { id: item.id, groupKey, label: item.label }
    setSidebarDraggedId(item.id)
    setSidebarDropTargetId(null)
    setSidebarGroupDropTargetKey(null)
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', item.id)
    event.dataTransfer.setData('application/x-modmind-sidebar-item', JSON.stringify(sidebarDragItemRef.current))
  }

  const beginSidebarGroupDrag = (event: React.DragEvent<HTMLSpanElement>, groupKey: string): void => {
    window.getSelection()?.removeAllRanges()
    sidebarDropHandledRef.current = false
    sidebarDragItemRef.current = null
    sidebarDragGroupKeyRef.current = groupKey
    setSidebarDraggedId(null)
    setSidebarDropTargetId(null)
    setSidebarDraggedGroupKey(groupKey)
    setSidebarGroupDropTargetKey(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `group:${groupKey}`)
  }

  const clearSidebarDragState = (): void => {
    stopSidebarDragScroll()
    sidebarDragItemRef.current = null
    sidebarDragGroupKeyRef.current = null
    sidebarDropHandledRef.current = false
    setSidebarDraggedId(null)
    setSidebarDropTargetId(null)
    setSidebarDraggedGroupKey(null)
    setSidebarGroupDropTargetKey(null)
  }

  const finishSidebarDrag = (event: React.DragEvent<HTMLElement>): void => {
    const dragged = sidebarDragItemRef.current
    const draggedGroupKey = sidebarDragGroupKeyRef.current
    const navBounds = sidebarNavRef.current?.getBoundingClientRect()
    const droppedOutsideNavigation = Boolean(navBounds && (
      event.clientX < navBounds.left || event.clientX > navBounds.right || event.clientY < navBounds.top || event.clientY > navBounds.bottom
    ))
    const droppedOutsideNavigationHorizontally = Boolean(navBounds && (event.clientX < navBounds.left || event.clientX > navBounds.right))
    const acceptedExternalDrop = event.dataTransfer.dropEffect === 'move'
    if (dragged && !sidebarDropHandledRef.current && droppedOutsideNavigation && !acceptedExternalDrop) {
      void window.modmind.app.openDetachedWindow(dragged.id, dragged.label)
        .then(() => {
          setDetachedSidebarItemIds((current) => new Set(current).add(dragged.id))
        })
        .catch(setErrorNotice)
    }
    if (draggedGroupKey && !sidebarDropHandledRef.current && droppedOutsideNavigationHorizontally) {
      const group = visibleNavGroups.find((entry) => entry.groupKey === draggedGroupKey)
      if (group) void window.modmind.app.openDetachedWindow(`group:${draggedGroupKey}`, group.label)
        .then(() => setDetachedSidebarGroupKeys((current) => new Set(current).add(draggedGroupKey)))
        .catch(setErrorNotice)
    }
    clearSidebarDragState()
  }

  const toggleDetachedAlwaysOnTop = (): void => {
    void window.modmind.app.setDetachedWindowAlwaysOnTop(!detachedAlwaysOnTop)
      .then((state) => setDetachedAlwaysOnTop(state.alwaysOnTop))
      .catch(setErrorNotice)
  }

  useEffect(() => {
    const reset = (): void => clearSidebarDragState()
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [])

  const advancedErrorsHidden = uiMode === 'advanced'
  const buildLogs = buildResult?.logs.filter((line) => !advancedErrorsHidden || !/(error|failed|failure|exception|fatal|fail|失败|错误|异常)/i.test(line)) ?? []
  const projectIndependentView = view === 'settings'
    || view === 'image-studio'
    || view === 'decompile'
    || view === 'plugins'
    || view.startsWith('plugin:')

  if (false && initialDetachedGroup) {
    return <div className={`app-shell ${settings.darkMode ? 'dark-mode' : ''} detached-window detached-group-window-shell mode-${uiMode}`}>
      <header className="titlebar detached-titlebar">
        <div className="titlebar-name"><img src={appLogo} alt="" />{detachedGroup?.label ?? 'ModMind'}</div>
        <div className="titlebar-actions">
          <button className={`detached-pin ${detachedAlwaysOnTop ? 'active' : ''}`} type="button" title={detachedAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-label={detachedAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-pressed={detachedAlwaysOnTop} onClick={toggleDetachedAlwaysOnTop}>{detachedAlwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}</button>
          <span className="titlebar-divider" />
          <button className="window-control" title="最小化" onClick={() => void window.modmind.app.minimize()}><Minus size={15} /></button>
          <button className="window-control" title="最大化" onClick={() => void window.modmind.app.maximize()}><Square size={13} /></button>
          <button className="window-control close" title="关闭" onClick={() => void window.modmind.app.close()}><X size={16} /></button>
        </div>
      </header>
      <main className="detached-group-window">
        {detachedGroup ? <nav aria-label={detachedGroup?.label ?? 'ModMind'}>{detachedGroup?.items?.map((item) => <button key={item.id} type="button" onClick={() => void window.modmind.app.openDetachedWindow(item.id, item.label).catch(setErrorNotice)}><item.icon size={16} /><span>{item.label}</span>{item.id === 'decompile' || item.id === 'plugins' ? <i className="sidebar-beta-badge" title="新功能测试中">Beta</i> : null}<ChevronRight size={15} /></button>)}</nav> : <div className="detached-group-empty">类型内容正在载入</div>}
      </main>
    </div>
  }

  return (
    <div className={`app-shell ${settings.darkMode ? 'dark-mode' : ''} ${uiMode === 'beginner' ? 'beginner-mode' : ''} ${isDetachedWindow ? 'detached-window' : ''} ${initialDetachedGroup ? 'detached-group-window-shell' : ''} mode-transition mode-${uiMode}`}>
      {!isDetachedWindow ? <PluginOverlayLayer snapshot={pluginSnapshot} theme={settings.darkMode ? 'dark' : 'light'} /> : null}
      {isDetachedWindow ? <header className="titlebar detached-titlebar">
        <div className="titlebar-name">{initialDetachedGroup ? detachedGroup?.label ?? '' : <><img src={appLogo} alt="" />{detachedWindowTitle}</>}</div>
        <div className="titlebar-actions">
          <button className={`detached-pin ${detachedAlwaysOnTop ? 'active' : ''}`} type="button" title={detachedAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-label={detachedAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-pressed={detachedAlwaysOnTop} onClick={toggleDetachedAlwaysOnTop}>{detachedAlwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}</button>
          <span className="titlebar-divider" />
          <button className="window-control" title="最小化" onClick={() => void window.modmind.app.minimize()}><Minus size={15} /></button>
          <button className="window-control" title="最大化" onClick={() => void window.modmind.app.maximize()}><Square size={13} /></button>
          <button className="window-control close" title="关闭" onClick={() => void window.modmind.app.close()}><X size={16} /></button>
        </div>
      </header> : null}
      {!isDetachedWindow ? <header className="titlebar">
        <div className="titlebar-name"><img src={appLogo} alt="" />{projectLauncherOpen ? 'ModMind' : project?.name ?? 'ModMind'}</div>
        <div className="titlebar-actions">
          <button className="hosted-titlebar-button" type="button" data-tour="titlebar-account" title="ModMind 账号与额度" onClick={() => setDeviceAccountOpen(true)}><UserRound size={14} /><span>{deviceState.status === 'connected' ? formatBalanceCents(deviceState.balanceCents) : '连接账号'}</span></button>
          <label className="expert-mode-toggle" data-tour="titlebar-mode" title="开启后显示完整开发工具与设置"><span>专业模式</span><input type="checkbox" checked={uiMode === 'advanced'} onChange={(event) => selectUiMode(event.target.checked ? 'advanced' : 'beginner')} /><span className="expert-mode-track" aria-hidden="true" /></label>
          <button className="titlebar-icon" title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCollapsed((current) => !current)}><PanelLeft size={15} /></button>
          <button className="titlebar-icon" data-tour="titlebar-help" title="本页使用指南" aria-label="本页使用指南" onClick={() => setPageGuideOpen(true)}><CircleHelp size={15} /></button>
          <div className="titlebar-menu-wrap" ref={titlebarMenuRef}>
            <button className="titlebar-icon" title="更多操作" aria-label="更多操作" aria-expanded={titlebarMenuOpen} onClick={() => setTitlebarMenuOpen((current) => !current)}><MoreHorizontal size={16} /></button>
            {titlebarMenuOpen ? <div className="titlebar-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { selectUiMode('advanced'); setView('settings'); setTitlebarMenuOpen(false) }}><Settings size={14} />打开设置</button>
              <button type="button" role="menuitem" onClick={() => { void saveSettingsPatch({ darkMode: !settings.darkMode }); setTitlebarMenuOpen(false) }}><Sparkles size={14} />切换深色模式</button>
              {project ? <button type="button" role="menuitem" onClick={() => { void window.modmind.project.reveal(undefined, project.path); setTitlebarMenuOpen(false) }}><FolderOpen size={14} />打开项目目录</button> : null}
            </div> : null}
          </div>
          <span className="titlebar-divider" />
          <button className="window-control" title="最小化" onClick={() => void window.modmind.app.minimize()}><Minus size={15} /></button>
          <button className="window-control" title="最大化" onClick={() => void window.modmind.app.maximize()}><Square size={13} /></button>
          <button className="window-control close" title="关闭" onClick={() => void window.modmind.app.close()}><X size={16} /></button>
        </div>
      </header> : null}

      <div className="app-body">
        {(!isDetachedWindow || initialDetachedGroup) ? <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${initialDetachedGroup ? 'detached-group-sidebar' : ''}`}>
          <div className="brand-row">
            <img className="brand-mark" src={appLogo} alt="ModMind" />
            <div><strong>ModMind{import.meta.env.DEV ? <span className="dev-badge">DEV</span> : null}</strong><span>Minecraft 创作工具</span></div>
          </div>

          <nav ref={sidebarNavRef} className="sidebar-nav" onDragOver={(event) => updateSidebarDragScroll(event.clientY)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopSidebarDragScroll() }} onWheel={handleSidebarWheel}>
            {(initialDetachedGroup && detachedGroup ? [detachedGroup] : orderedVisibleNavGroups).map((group, index) => <div className="sidebar-nav-group" data-sidebar-drag-key={`group:${group.groupKey}`} key={group.groupKey}>
              <span
                draggable
                className={`nav-caption ${index ? 'settings-caption' : ''} ${sidebarDraggedGroupKey === group.groupKey ? 'dragging' : ''} ${sidebarGroupDropTargetKey === group.groupKey ? 'drop-target' : ''}`}
                onDragStart={(event) => beginSidebarGroupDrag(event, group.groupKey)}
                onDragOver={(event) => {
                  const draggedGroupKey = sidebarDragGroupKeyRef.current
                  const draggedItem = sidebarDragItemRef.current ?? readSidebarDragPayload(event.dataTransfer)
                  if (!draggedGroupKey && !draggedItem && !event.dataTransfer.types.includes('application/x-modmind-sidebar-item')) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (draggedGroupKey) {
                    const bounds = event.currentTarget.getBoundingClientRect()
                    moveSidebarGroup(draggedGroupKey, group.groupKey, event.clientY > bounds.top + bounds.height / 2)
                  }
                  setSidebarGroupDropTargetKey(group.groupKey)
                  setSidebarDropTargetId(null)
                }}
                onDrop={(event) => {
                  const draggedGroupKey = sidebarDragGroupKeyRef.current
                  const draggedItem = sidebarDragItemRef.current ?? readSidebarDragPayload(event.dataTransfer)
                  if (!draggedGroupKey && !draggedItem) return
                  event.preventDefault()
                  sidebarDropHandledRef.current = true
                  if (draggedGroupKey) moveSidebarGroup(draggedGroupKey, group.groupKey, event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2)
                  else if (draggedItem) {
                    moveSidebarItem(draggedItem.groupKey, group.groupKey, group.items, draggedItem.id, null)
                    if (sidebarDragItemRef.current?.id === draggedItem.id) sidebarDragItemRef.current = { ...sidebarDragItemRef.current, groupKey: group.groupKey }
                  }
                  setSidebarGroupDropTargetKey(null)
                }}
                onDragEnd={finishSidebarDrag}
              >{group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  data-sidebar-drag-key={`item:${item.id}`}
                  data-tour={`nav:${item.id}`}
                  draggable
                  className={`sidebar-nav-item ${view === item.id ? 'active' : ''} ${sidebarDraggedId === item.id ? 'dragging' : ''} ${sidebarDropTargetId === item.id ? 'drop-target' : ''}`}
                  aria-current={view === item.id ? 'page' : undefined}
                  aria-label={item.label}
                  title={sidebarCollapsed ? item.label : undefined}
                  onClick={() => { navigateToView(item.id); if (project) setProjectLauncherOpen(false) }}
                  onDragStart={(event) => beginSidebarDrag(event, item, group.groupKey)}
                  onDragOver={(event) => {
                    const dragged = sidebarDragItemRef.current ?? readSidebarDragPayload(event.dataTransfer)
                    if (!dragged && !event.dataTransfer.types.includes('application/x-modmind-sidebar-item')) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (dragged) {
                      moveSidebarItem(dragged.groupKey, group.groupKey, group.items, dragged.id, item.id, event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2)
                      if (sidebarDragItemRef.current?.id === dragged.id && dragged.groupKey !== group.groupKey) sidebarDragItemRef.current = { ...sidebarDragItemRef.current, groupKey: group.groupKey }
                    }
                    setSidebarDropTargetId(item.id)
                    setSidebarGroupDropTargetKey(null)
                  }}
                  onDrop={(event) => {
                    const dragged = sidebarDragItemRef.current ?? readSidebarDragPayload(event.dataTransfer)
                    if (!dragged) return
                    event.preventDefault()
                    sidebarDropHandledRef.current = true
                    moveSidebarItem(dragged.groupKey, group.groupKey, group.items, dragged.id, item.id, event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2)
                    if (sidebarDragItemRef.current?.id === dragged.id && dragged.groupKey !== group.groupKey) sidebarDragItemRef.current = { ...sidebarDragItemRef.current, groupKey: group.groupKey }
                    setSidebarDropTargetId(null)
                    setSidebarGroupDropTargetKey(null)
                  }}
                  onDragEnd={finishSidebarDrag}
                  type="button"
                >
                  <item.icon size={16} /><span>{item.label}</span>
                  {item.id === 'decompile' || item.id === 'plugins' ? <i className="sidebar-beta-badge" title="新功能测试中">Beta</i> : null}
                  {item.id === 'build' && latestEvent ? <i className={`status-dot ${latestEvent.status}`} /> : null}
                </button>
              ))}
            </div>)}
          </nav>

          <div className="sidebar-footer">
            {project ? (
              <div className="project-switcher-row">
                <button className="project-switcher" type="button" onClick={() => { setProjectLauncherOpen(true); setView('workspace'); void refreshRecentProjects() }}>
                  <span className="project-cube"><Box size={16} /></span>
                  <span><strong>{project.name}</strong><small>{platformLabel(project.loader)} · {project.minecraftVersion}</small></span>
                  <ChevronDown size={14} />
                </button>
              </div>
            ) : (
              <button className="new-project-side" onClick={() => setShowCreate(true)}><Plus size={16} />新建项目</button>
            )}
          </div>
        </aside> : null}

        {!isDetachedWindow && !projectIndependentView && (projectLauncherOpen || !project) ? (
          <ProjectLauncher
            projects={recentProjects}
            onCreate={() => setShowCreate(true)}
            onOpen={() => void openProject()}
            onAdopt={() => setExistingImportPicker(true)}
            onImportModJar={async () => {
              const picked = await window.modmind.decompile.pickJar()
              if (!picked) return
              setModJarInspecting(true)
              try {
                setModJarInspection(await window.modmind.decompile.inspect(picked))
              } catch (reason) {
                setErrorNotice(errorMessage(reason))
              } finally {
                setModJarInspecting(false)
              }
            }}
            onSelect={(recent) => void openRecentProject(recent)}
            onRemove={(recent) => void removeRecentProject(recent)}
            onRename={setRenamingProject}
          />
        ) : (
          <main ref={mainContentRef} className="main-content" data-view={view}>
            {project?.kind === 'modpack' ? <KeepAliveRoute key={`modpack-content:${project.path}`} active={view === 'modpack-content'}><ModpackToolsWorkspace project={project} section="content" /></KeepAliveRoute> : null}
            {view === 'relationships' && project && project.kind !== 'modpack' && isJavaLoader(project.loader) ? <AddonRelationshipsWorkspace project={project} beginner={uiMode === 'beginner'} onFilesChanged={() => { void refreshFiles(); void refreshSnapshots() }} onDecompile={(jarPath) => { setDecompileJarHandoff(jarPath); setView('decompile') }} /> : null}
            {view === 'ftb-quests' && project?.kind === 'modpack' ? <div className="ftb-quest-host"><FtbQuestEditor project={project} /></div> : null}
            {view === 'patchouli' && project?.kind === 'modpack' ? <PatchouliBookEditor /> : null}
            {project?.kind === 'modpack' ? <KeepAliveRoute key={`modpack-migration:${project.path}`} active={view === 'modpack-migration'}><ModpackMigrationWorkspace project={project} onDecompile={(jarPath) => { setDecompileJarHandoff(jarPath); setView('decompile') }} /></KeepAliveRoute> : null}
            <KeepAliveRoute key={`decompile:${project?.path ?? 'standalone'}`} active={view === 'decompile'}>
              <DecompileWorkspace
                key={decompileJarHandoff ?? 'none'}
                initialJarPath={decompileJarHandoff}
                projectContext={project}
                darkMode={settings.darkMode}
                onProjectCreated={(created) => {
                  setProject(created)
                  setProjectLauncherOpen(false)
                  setView('workspace')
                  void refreshRecentProjects()
                }}
              />
            </KeepAliveRoute>
            {project?.kind === 'modpack' ? <KeepAliveRoute key={`modpack-automation:${project.path}`} active={view === 'modpack-automation'}><ModpackToolsWorkspace project={project} section="automation" /></KeepAliveRoute> : null}
            {project?.kind === 'modpack' ? <KeepAliveRoute key={`modpack-server:${project.path}`} active={view === 'modpack-server'}><ModpackToolsWorkspace project={project} section="server" /></KeepAliveRoute> : null}
            {view === 'modpack-mod-list' && project?.kind === 'modpack' ? <ModpackModListWorkspace project={project} onOpenModule={(module) => { setProject(module); setView('workspace') }} onDecompile={(jarPath) => { setDecompileJarHandoff(jarPath); setView('decompile') }} /> : null}
            {view === 'modpack-manifest' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="other" inventoryMode onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-config' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="config" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-scripts' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="scripts" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-datapacks' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="datapacks" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-resourcepacks' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="resourcepacks" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-shaders' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="shaderpacks" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-ui' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="ui" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-worlds' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="worlds" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-client' && project?.kind === 'modpack' ? <ModpackKeybindWorkspace project={project} onOpenRaw={(relativePath) => void openEditorFile(relativePath)} /> : null}
            {view === 'modpack-server-content' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="server" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {view === 'modpack-files' && project?.kind === 'modpack' ? <ModpackContentWorkspace project={project} section="other" onOpenEditor={openModpackContentEditor} onCreateFile={(contentPath, content) => void createModpackContentFile(contentPath, content)} /> : null}
            {project?.kind === 'modpack' ? <div className="third-party-route" hidden={view !== 'third-party-mods'}><ThirdPartyModsWorkspace key={project.path} project={project} visible={view === 'third-party-mods'} /></div> : null}

            {view === 'workspace' && project && normalizeProjectPath(activeWorkbenchProjectRef.current) === normalizeProjectPath(project.path) ? <AgentWorkbench
              key={project.path}
              project={project}
              uiMode={uiMode}
              modpack={project.kind === 'modpack'}
              prompt={prompt}
              setPrompt={setPrompt}
              attachments={aiAttachments}
              setAttachments={setAiAttachments}
              planning={planning}
              taskState={beginnerTaskState}
              aiPlan={aiPlan}
              aiTodo={aiTodo}
              aiTimeline={aiTimeline}
              processingStartedAt={processingStartedAt}
              aiOutputStatus={aiOutputStatus}
              aiRecovery={aiRecovery}
              conversations={workbenchConversations}
              activeConversationId={activeWorkbenchConversationId}
              persistenceState={workbenchPersistenceState}
              persistenceMessage={workbenchPersistenceMessage}
              onSelectConversation={selectWorkbenchConversation}
              onNewConversation={startWorkbenchConversation}
              onDeleteConversation={(conversationId) => deleteWorkbenchConversation(conversationId)}
              backend={settings.codingBackend}
              runningBackend={runningBackend}
              switchingBackend={switchingBackend}
              onBackendChange={selectCodingBackend}
              onStart={() => void captureIdea()}
              onCancel={cancelAi}
              onResume={() => void resumeInterruptedAi()}
              onDismissRecovery={() => setAiRecovery(null)}
              onRename={() => setRenamingProject(project)}
              onSnapshot={() => void createSnapshot()}
              onExport={() => void exportArtifact()}
              onExportServerPack={() => void exportServerPack()}
              onExportLogs={() => void exportDiagnosticLogs()}
              onTest={() => setView('minecraft')}
              onAttachmentError={(error) => setNotice(`无法添加附件：${errorMessage(error)}`)}
              canExportArtifact={exportArtifactAvailable}
              building={building}
              deviceState={deviceState}
              onOpenAccount={() => setDeviceAccountOpen(true)}
              beginnerAiPreferences={beginnerAiPreferences}
              beginnerAvailableModels={beginnerAvailableModels}
              scanningBeginnerModels={scanningBeginnerModels}
              savingAiPreferences={savingAiPreferences}
              beginnerModelScanMessage={beginnerModelScanMessage}
              contextModel={settings.codingBackend === 'codex' || settings.codingBackend === 'claude' ? settings.externalAgents?.[settings.codingBackend]?.model : undefined}
              onScanBeginnerModels={() => void scanBeginnerModels()}
              onModelChange={(model) => void saveBeginnerAiPreference({ model })}
              onReasoningLevelChange={(reasoningLevel) => void saveBeginnerAiPreference({ reasoningLevel })}
              onFastModeChange={(fastMode) => void saveBeginnerAiPreference({ fastMode })}
              placeholder={workspacePromptPlaceholder}
              humanizeActivity={humanizeActivity}
              onEditTimelineItem={handleEditTimelineItem}
              onDeleteTimelineItem={handleDeleteTimelineItem}
              onRewindTimelineTo={handleRewindTimelineTo}
            /> : null}

            {[...new Map([...(project ? [project] : []), ...recentProjects].map((entry) => [normalizeProjectPath(entry.path), entry])).values()].map((inspirationProject) => (
              <InspirationWorkspace
                key={inspirationProject.path}
                project={inspirationProject}
                visible={view === 'inspiration' && Boolean(project && normalizeProjectPath(project.path) === normalizeProjectPath(inspirationProject.path))}
                uiMode={uiMode}
                deviceState={deviceState}
                codingBackend={settings.codingBackend}
                onBusyChange={() => undefined}
                onConnectionRequired={() => setDeviceAccountOpen(true)}
                onSendToCoding={(codingPrompt) => {
                  if (!project || normalizeProjectPath(project.path) !== normalizeProjectPath(inspirationProject.path)) return
                  setPrompt(codingPrompt)
                  setView('workspace')
                  setNotice('已发送到工作台，请确认后开始开发')
                }}
              />
            ))}

            {uiMode === 'advanced' || view === 'image-studio' ? <div className="image-studio-host" hidden={view !== 'image-studio'}><ImageStudioWorkspace visible={view === 'image-studio'} darkMode={settings.darkMode} onOpenSettings={() => setView('settings')} /></div> : null}

            {project ? (
              <KeepAliveRoute key={`blockbench:${project.path}`} active={view === 'blockbench'}>
                <div className="blockbench-page">
                  <BlockbenchWorkspace visible={view === 'blockbench'} darkMode={settings.darkMode} project={project} suppressed={deviceAccountOpen || titlebarMenuOpen || pageGuideOpen} />
                </div>
              </KeepAliveRoute>
            ) : null}

            {project ? <KeepAliveRoute key={`minecraft:${project.path}`} active={view === 'minecraft'}><MinecraftTestWorkspace projectPath={project.path} beginner={uiMode === 'beginner'} modpack={project.kind === 'modpack'} onManageRelationships={() => setView('relationships')} /></KeepAliveRoute> : null}

            {view === 'mappings' && project ? (
              <div className="mappings-page">
                <div className="content-toolbar">
                  <div><h1>Minecraft Mappings</h1><p>查询 {project.minecraftVersion} 的 Mojang、Yarn、Intermediary 与其他映射</p></div>
                  <div className="toolbar-actions">
                    <button className="mapping-source-link" onClick={() => void window.modmind.mappings.openLoaderDocs(project.loader)}><ExternalLink size={13} />{platformLabel(project.loader)} 文档</button>
                    <button className="mapping-source-link" onClick={() => void window.modmind.mappings.openSource(project.minecraftVersion)}><ExternalLink size={13} />mappings.dev</button>
                  </div>
                </div>
                <div className="mapping-search-band">
                  <div className="mapping-search-box">
                    <Search size={16} />
                    <input
                      value={mappingQuery}
                      onChange={(event) => setMappingQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void searchMappings() }}
                      placeholder="搜索类名或包名"
                    />
                    <button className="primary-button" disabled={mappingBusy || !mappingQuery.trim()} onClick={() => void searchMappings()}>
                      {mappingBusy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}查询
                    </button>
                  </div>
                  <p>{mappingMessage}</p>
                </div>
                <div className="mapping-layout">
                  <aside className="mapping-results">
                    <div className="panel-title"><span>类列表</span><small>{mappingResults.length}</small></div>
                    {mappingResults.map((entry) => {
                      const primary = entry.names.Mojang ?? Object.values(entry.names)[0]
                      return (
                        <button key={entry.pagePath} className={mappingDetail?.pagePath === entry.pagePath ? 'selected' : ''} onClick={() => void openMapping(entry)}>
                          <strong>{primary.split('/').at(-1)}</strong>
                          <span>{primary.replaceAll('/', '.')}</span>
                          <small>{Object.entries(entry.names).filter(([namespace]) => namespace !== 'Mojang').slice(0, 2).map(([namespace, name]) => `${namespace}: ${name.split('/').at(-1)}`).join(' · ')}</small>
                        </button>
                      )
                    })}
                    {!mappingResults.length ? <div className="mapping-empty"><LibraryBig size={24} /><span>查询结果会显示在这里</span></div> : null}
                  </aside>
                  <section className="mapping-detail">
                    {mappingDetail ? (
                      <>
                        <div className="mapping-detail-head">
                          <div><span>声明</span><h2>{mappingDetail.declaration}</h2></div>
                          <input value={mappingMemberQuery} onChange={(event) => setMappingMemberQuery(event.target.value)} placeholder="筛选字段或方法" />
                        </div>
                        <div className="mapping-class-names">
                          {Object.entries(mappingDetail.names).map(([namespace, name]) => <div key={namespace}><span>{namespace}</span><code>{name.replaceAll('/', '.')}</code></div>)}
                        </div>
                        <div className="mapping-member-heading"><strong>成员列表</strong><span>{filteredMappingMembers.length} 条</span></div>
                        <div className="mapping-members">
                          {filteredMappingMembers.map((member, index) => (
                            <article key={`${member.kind}-${index}`}>
                              <div><span className={`mapping-kind ${member.kind}`}>{member.kind}</span><code>{member.type}</code></div>
                              <dl>{Object.entries(member.names).map(([namespace, name]) => <div key={namespace}><dt>{namespace}</dt><dd>{name}</dd></div>)}</dl>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : <div className="mapping-detail-empty"><LibraryBig size={30} /><h2>选择一个类查看完整映射</h2><p>结果包含字段、构造器、方法签名及各命名空间名称</p></div>}
                  </section>
                </div>
              </div>
            ) : null}

            {view === 'code' && project ? (
              <div className="code-layout">
                <aside className="file-panel">
                  <div className="panel-title"><span>项目文件</span><div className="file-panel-actions">
                    <button className="icon-button" title="新建文件" onClick={() => void createProjectFile()}><FilePlus2 size={14} /></button>
                    <button className="icon-button" title="新建目录" onClick={() => void createProjectDirectory()}><FolderPlus size={14} /></button>
                    <button className="icon-button" title="刷新文件树" onClick={() => void refreshFiles()}><RotateCcw size={14} /></button>
                  </div></div>
                  <FileTree nodes={files} selectedPath={selectedFile} onSelect={(node) => void selectFile(node)} />
                </aside>
                <section className="editor-panel">
                  <div className="editor-toolbar">
                    <span className="editor-path"><FileCode2 size={14} />{selectedFile || '选择一个文件开始编辑'}{editorDirty ? <i title="有未保存修改" /> : null}</span>
                    <div className="editor-actions">
                      <button className="icon-button" title="在文件管理器中显示" disabled={!selectedFile} onClick={() => void window.modmind.project.reveal(selectedFile, project.path)}><FolderOpen size={14} /></button>
                      <button className="secondary-button compact" title="在 VS Code 中打开完整项目" onClick={() => void window.modmind.project.openIde().catch((error) => setErrorNotice(errorMessage(error)))}><ExternalLink size={14} />VS Code</button>
                      <button className="icon-button" title="重命名文件" disabled={!selectedFile} onClick={() => void renameSelectedFile()}><Pencil size={14} /></button>
                      <button className="icon-button danger" title="删除文件" disabled={!selectedFile} onClick={() => void deleteSelectedFile()}><Trash2 size={14} /></button>
                      <button className="secondary-button compact" disabled={!editorDirty} onClick={() => void saveFile()}><Save size={14} />保存</button>
                    </div>
                  </div>
                  {selectedFile && isEditablePath(selectedFile) ? (
                    <Suspense fallback={<div className="editor-empty"><LoaderCircle className="spin" size={22} /><p>正在载入本地编辑器...</p></div>}><MonacoCodeEditor
                      key={selectedFile}
                      path={selectedFile}
                      language={editorLanguage(selectedFile)}
                      darkMode={settings.darkMode}
                      value={editorContent}
                      onChange={(value) => { setEditorContent(value); setEditorDirty(true) }}
                      onSave={() => void saveFile()}
                    /></Suspense>
                  ) : selectedFile ? (
                    <div className="editor-empty"><File size={28} /><p>该文件不是可编辑文本，可在文件管理器中查看</p></div>
                  ) : (
                    <div className="editor-empty"><FileCode2 size={28} /><p>从左侧文件树中选择源码或配置文件</p></div>
                  )}
                </section>
              </div>
            ) : null}

            {uiMode === 'advanced' && view === 'build' && project ? (
              <div className="standard-page">
                  <div className="content-toolbar">
                    <div><h1>构建与测试</h1><p>{isJavaLoader(project.loader) ? '使用托管 Java 与 Gradle 生成可运行的 Mod JAR' : project.loader === 'bedrock' ? '校验行为包与资源包并生成可导入的 .mcaddon' : '校验网易 Mod SDK 工程并生成工作台归档'}</p></div>
                    <div className="toolbar-actions">
                      <button className="secondary-button" disabled={building || planning || !buildResult?.success} onClick={() => void exportArtifact()}><Download size={16} />{isJavaLoader(project.loader) ? '导出 Mod JAR' : project.loader === 'bedrock' ? '导出 .mcaddon' : '导出工作台归档'}</button>
                      {buildError ? (
                      <button className="secondary-button" disabled={planning || building} onClick={() => void repairBuildWithAi()}>
                        {planning ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}AI 修复
                      </button>
                    ) : null}
                    <button className="primary-button" disabled={building || planning} onClick={() => void runPreflight()}>
                      {building ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}构建项目
                    </button>
                  </div>
                </div>
                <section className="build-status-band">
                  <div className={`build-state ${buildResult?.success ? 'success' : !advancedErrorsHidden && (buildError || buildResult) ? 'error' : ''}`}>
                    {building ? <LoaderCircle className="spin" size={22} /> : buildResult?.success ? <Check size={22} /> : !advancedErrorsHidden && (buildError || buildResult) ? <X size={22} /> : <Hammer size={22} />}
                    <div><strong>{building ? minecraftEvents.at(-1)?.message || '正在准备构建环境' : buildResult?.success ? buildResult.summary : advancedErrorsHidden && (buildError || buildResult) ? '构建状态已更新' : buildError ? buildResult && !buildResult.success ? '构建未通过' : '构建失败' : '等待运行'}</strong><span>{advancedErrorsHidden && buildError ? '详细信息已写入诊断日志' : buildError ? '错误详情已保留在下方输出中' : buildResult?.reportPath || '尚未生成预检报告'}</span></div>
                  </div>
                  <div className="build-metrics"><span><strong>{buildResult?.logs.filter((line) => line.startsWith('PASS')).length ?? 0}</strong>通过</span>{advancedErrorsHidden ? null : <span><strong>{buildResult?.logs.filter((line) => line.startsWith('FAIL')).length ?? 0}</strong>失败</span>}</div>
                </section>
                <section className="log-section">
                  <div className="section-title-row"><h2>输出</h2><span>Preflight</span></div>
                  <pre>{advancedErrorsHidden && buildError ? '构建输出已写入诊断日志' : buildLogs.join('\n') || [
                    ...minecraftEvents.map((event) => `[${formatTime(event.time)}] ${event.message}`),
                    ...(buildError ? ['', buildError] : [])
                  ].join('\n') || (isJavaLoader(project.loader) ? '点击“构建项目”下载所需运行时并执行 Gradle build' : project.loader === 'bedrock' ? '点击“构建项目”校验双 Pack 并生成 .mcaddon' : '点击“构建项目”校验工程并生成网易开发者工作台归档')}</pre>
                </section>
                <section className="pipeline-list">
                  <h2>任务时间线</h2>
                  {events.map((event) => (
                    <div className="pipeline-row" key={event.id}><span className={`status-dot ${event.status}`} /><div><strong>{event.title}</strong><p>{event.detail}</p></div><time>{formatTime(event.time)}</time></div>
                  ))}
                </section>
              </div>
            ) : null}

            {view === 'snapshots' && project ? (
              <div className="standard-page">
                <div className="content-toolbar">
                  <div><h1>{project.kind === 'modpack' ? '版本' : '版本与迁移'}</h1><p>{platformLabel(project.loader)} · {project.minecraftVersion}{project.kind === 'modpack' ? ' · 整合包' : ''}</p></div>
                  <button className="primary-button" onClick={() => void createSnapshot()}><Plus size={16} />创建快照</button>
                </div>
                {project.kind !== 'modpack' && (isJavaLoader(project.loader) ? <section className="migration-band">
                  <div className="section-title-row"><h2>迁移目标</h2><span>生成到新目录</span></div>
                  <div className="migration-controls">
                    <div className="segmented-control">
                      {(['fabric', 'quilt', 'forge', 'neoforge'] as const).map((loader) => <button key={loader} className={migrationLoader === loader ? 'active' : ''} onClick={() => { setMigrationLoader(loader); setMigrationVersion(''); setMigrationPreview(null) }}>{loader === 'fabric' ? 'Fabric' : loader === 'quilt' ? 'Quilt' : loader === 'forge' ? 'Forge' : 'NeoForge'}</button>)}
                    </div>
                    <select value={selectedMigrationVersion} onChange={(event) => { setMigrationVersion(event.target.value); setMigrationPreview(null) }}>
                      {migrationVersions.map((option) => <option key={`${option.loader}-${option.minecraftVersion}`} value={option.minecraftVersion}>{option.minecraftVersion}{option.supportTier === 'experimental' ? '（实验性）' : ''}</option>)}
                    </select>
                    <button className="secondary-button" disabled={migrationBusy || !selectedMigrationVersion} onClick={() => void previewMigration()}>{migrationBusy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}预检</button>
                  </div>
                  {migrationPreview ? <div className="migration-preview">
                    <div><strong>{migrationPreview.source.loader} {migrationPreview.source.minecraftVersion}</strong><ChevronRight size={15} /><strong>{migrationPreview.target.loader} {migrationPreview.target.minecraftVersion}</strong><span className={`migration-tier ${migrationPreview.target.supportTier}`}>{migrationPreview.target.supportTier === 'stable' ? '稳定' : '实验性'}</span></div>
                    {migrationPreview.warnings.map((warning) => <p key={warning}><CircleAlert size={14} />{warning}</p>)}
                    {migrationPreview.blockers.map((blocker) => <p className="error" key={blocker}><X size={14} />{blocker}</p>)}
                    <button className="primary-button" disabled={migrationBusy || Boolean(migrationPreview.blockers.length)} onClick={() => void runMigration()}>{migrationBusy ? <LoaderCircle className="spin" size={15} /> : <PackageOpen size={15} />}生成迁移项目</button>
                  </div> : null}
                </section> : <section className="migration-band"><div className="section-title-row"><h2>平台版本</h2><span>{platformLabel(project.loader)}</span></div><p>基岩与网易工程不执行 Java Loader 自动迁移。升级最低引擎或 Mod SDK 前请先创建快照，并按目标平台 API 逐项验证</p></section>)}
                <GitWorkspace project={project} onFilesChanged={() => { void refreshFiles(); void refreshSnapshots() }} />
                <div className="snapshot-list">
                  {snapshots.length ? snapshots.map((snapshot) => (
                    <article className="snapshot-row" key={snapshot.id}>
                      <span className="snapshot-icon"><Archive size={18} /></span>
                      <div><h3>{snapshot.label}</h3><p>{formatDate(snapshot.createdAt)} · {snapshot.fileCount} 个文件</p></div>
                      <code>{snapshot.id.slice(0, 19)}</code>
                      <div className="snapshot-actions">
                        <button
                          className="icon-button"
                          title="恢复此快照"
                          disabled={Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || building || planning || migrationBusy}
                          onClick={() => void restoreSnapshot(snapshot)}
                        >
                          {restoringSnapshotId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                        </button>
                        <button
                          className="icon-button danger"
                          title="删除此快照"
                          disabled={Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || building || planning || migrationBusy}
                          onClick={() => void deleteSnapshot(snapshot)}
                        >
                          {deletingSnapshotId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                        </button>
                      </div>
                    </article>
                  )) : <div className="large-empty"><History size={26} /><h3>还没有版本快照</h3><p>创建快照后，项目文件会保存在项目内的 {project.toolDataDirectory ?? '.modmind'} 目录</p></div>}
                </div>
              </div>
            ) : null}

            {project ? (
              <KeepAliveRoute key={`production:${project.path}`} active={view === 'production'}>
                <ProductionWorkspace project={project} onFilesChanged={() => { void refreshFiles(); void refreshSnapshots() }} />
              </KeepAliveRoute>
            ) : null}

            {view === 'plugins' ? (
              <PluginsManager
                snapshot={pluginSnapshot}
                hasProject={Boolean(project)}
                onRefresh={() => void window.modmind.plugins.list().then(setPluginSnapshot).catch(() => undefined)}
                onOpenPanel={(pluginId) => navigateToView(`plugin:${pluginId}`)}
                confirmDelete={(pluginId, pluginName) => requestConfirm({
                  title: `永久删除插件“${pluginName}”？`,
                  message: `将删除插件目录及全部源码（${pluginId}），此操作无法撤销`,
                  confirmLabel: '永久删除',
                  tone: 'danger'
                })}
              />
            ) : null}

            {view.startsWith('plugin:') ? (() => {
              const pluginId = view.slice('plugin:'.length)
              const plugin = pluginSnapshot.plugins.find((entry) => entry.manifest.id === pluginId)
              if (!plugin) {
                return <div className="large-empty"><Puzzle size={26} /><h3>插件未安装或已卸载</h3><p>在「管理插件」中检查插件状态</p></div>
              }
              return <PluginPanelHost plugin={plugin} theme={settings.darkMode ? 'dark' : 'light'} />
            })() : null}

            {view === 'settings' ? (
              <div className="settings-page">
                <div className="content-toolbar"><div><h1>设置</h1><p>管理制作引擎、外部工具和工作区偏好</p></div></div>
                <nav className="settings-index" aria-label="设置分类">
                  <a href="#settings-ai">AI 与 Agent</a>
                  <a href="#settings-image">图像</a>
                  <a href="#settings-build">构建</a>
                  <a href="#settings-network">网络</a>
                  <a href="#settings-diagnostics">诊断</a>
                  <a href="#settings-appearance">外观</a>
                  <a href="#settings-sidebar-order">侧边栏</a>
                  <a href="#settings-notifications">通知</a>
                  <a href="#settings-remote">远程构建</a>
                  <a href="#settings-legal">许可证</a>
                </nav>
                <section id="settings-ai" className="settings-section">
                  <div className="settings-heading"><h2>AI 服务</h2><p>统一管理制作引擎，以及需要接入项目的外部 Coding Agent</p></div>
                  <ProductionSettingsPanel
                    aiSettings={beginnerAiPreferences}
                    deviceState={deviceState}
                    availableModels={beginnerAvailableModels}
                    scanningModels={scanningBeginnerModels}
                    savingAiPreferences={savingAiPreferences}
                    modelScanMessage={beginnerModelScanMessage}
                    onScanModels={() => void scanBeginnerModels()}
                    onModelChange={(model) => void saveBeginnerAiPreference({ model })}
                    onReasoningLevelChange={(reasoningLevel) => void saveBeginnerAiPreference({ reasoningLevel })}
                    onFastModeChange={(fastMode) => void saveBeginnerAiPreference({ fastMode })}
                  />
                  <div className="external-agent-settings">
                    <div className="settings-heading external-agent-heading"><h3>外部 Coding Agent</h3><p>检测到的本机 Agent 会直接使用原有配置。只有点“配置”时，ModMind 才会为对应 Agent 保存单独的服务设置</p></div>
                    <div className="external-agent-list">
                      {EXTERNAL_AGENT_OPTIONS.map((agent) => {
                        const status = externalAgents.find((item) => item.kind === agent.kind)
                        const configured = settings.externalAgents?.[agent.kind]
                        return <div className="external-agent-row" key={agent.kind}>
                          <div className="external-agent-name"><span className={`status-dot ${status?.installed ? 'success' : 'warning'}`} /><div><strong>{agent.label}</strong><p>{status?.installed ? `${status.version ?? '已检测到'} · ${configured?.baseUrl ? '已设置 ModMind 服务' : '使用本机原有配置'}` : externalAgentsReady ? '未检测到命令行工具' : '正在检测…'}</p></div></div>
                          <div className="external-agent-row-actions">
                            <button className="secondary-button compact" type="button" onClick={() => { setEditingAgent(agent.kind); setAgentDraft({...configured, mode: configured?.mode ?? (agent.kind === 'claude' ? 'local' : 'hosted'), apiKey: ''}); setAvailableModels([]); setModelScanMessage('输入 API Key 后扫描') }}><Pencil size={14} />配置</button>
                            {status?.installed || configured?.executable ? <button className="icon-button" type="button" title={`打开 ${agent.label}`} onClick={() => void launchExternalAgent(agent.kind)}><TerminalSquare size={15} /></button> : <button className="icon-button" type="button" title={`安装 ${agent.label}`} disabled={!externalAgentsReady || installingAgents[agent.kind]} onClick={() => void installExternalAgent(agent.kind)}>{installingAgents[agent.kind] ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}</button>}
                            <button className="icon-button" type="button" title={`${agent.label} 文档`} onClick={() => void openExternalAgentDocs(agent.kind)}><ExternalLink size={15} /></button>
                          </div>
                        </div>
                      })}
                    </div>
                    {editingAgent ? (() => {
                      const selectedAgent = EXTERNAL_AGENT_OPTIONS.find((item) => item.kind === editingAgent)!
                      const agent = {...selectedAgent, managedService: selectedAgent.managedService && (editingAgent !== 'claude' || agentDraft.mode === 'hosted')}
                      return <div className="external-agent-editor">
                        <div className="external-agent-editor-heading"><div><strong>配置 {agent.label}</strong><p>{agent.managedService ? '只在这里填写该 Agent 需要的中转服务。保存前会备份现有配置' : '通常不需要填写服务信息；ModMind 会沿用该 Agent 本机已有的账号和配置'}</p></div><button className="icon-button" type="button" title="关闭" onClick={() => { setEditingAgent(null); setAgentDraft({}) }}><X size={15} /></button></div>
                        <div className="external-agent-editor-form">
                          {editingAgent === 'claude' ? <label className="field-label">Claude Code 模式<select value={agentDraft.mode ?? 'local'} onChange={(event) => setAgentDraft((current) => ({...current, mode: event.target.value as ExternalAgentConfiguration['mode']}))}><option value="local">本机登录和配置</option><option value="hosted">ModMind 中转服务</option></select></label> : null}
                          {editingAgent === 'claude' ? <label className="field-label">命令路径<input value={agentDraft.executable ?? ''} onChange={(event) => setAgentDraft((current) => ({...current, executable: event.target.value}))} placeholder="留空则从 PATH 查找" /></label> : null}
                          {agent.managedService ? <><label className="field-label">Base URL<input value={agentDraft.baseUrl ?? ''} onChange={(event) => setAgentDraft((current) => ({...current, baseUrl: event.target.value}))} placeholder="https://api.example.com/v1" /></label><label className="field-label">API Key<input type="password" value={agentDraft.apiKey ?? ''} onChange={(event) => setAgentDraft((current) => ({...current, apiKey: event.target.value}))} placeholder={settings.externalAgents?.[editingAgent]?.hasStoredKey ? '已安全保存，留空保持不变' : '输入服务 API Key'} /></label><div className="model-picker-field"><div className="model-picker-heading"><span>模型</span><button type="button" onClick={() => void scanModels()} disabled={scanningModels || !agentDraft.baseUrl?.trim()}>{scanningModels ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}{scanningModels ? '扫描中' : '扫描模型'}</button></div><label className="field-label"><input value={agentDraft.model ?? ''} onChange={(event) => setAgentDraft((current) => ({...current, model: event.target.value}))} placeholder="扫描后选择，或手动填写模型 ID" /><small>{modelScanMessage}</small></label>{availableModels.length ? <select className="external-agent-model-select" value={availableModels.some((item) => item.id === agentDraft.model) ? agentDraft.model : ''} onChange={(event) => { if (event.target.value) setAgentDraft((current) => ({...current, model: event.target.value})) }}><option value="">从已扫描模型中选择</option>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.id}{model.ownedBy ? ` (${model.ownedBy})` : ''}</option>)}</select> : null}</div><div className="external-agent-reasoning-control"><span>思考强度</span><div role="group" aria-label={`${agent.label} 思考强度`}>{(editingAgent === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] as const : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const).map((value) => <button type="button" className={agentDraft.reasoningEffort === value ? 'active' : ''} key={value} onClick={() => setAgentDraft((current) => ({...current, reasoningEffort: value}))}>{value}</button>)}</div></div></> : null}
                        </div>
                        <div className="settings-actions editor-actions"><span><ShieldCheck size={15} />凭证通过系统加密保存</span><button className="primary-button compact" type="button" disabled={configuringAgents[editingAgent]} onClick={() => void configureExternalAgent(editingAgent)}>{configuringAgents[editingAgent] ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存 {agent.label} 配置</button></div>
                      </div>
                    })() : null}
                  </div>
                  <div className="settings-heading external-agent-heading mcp-bridge-heading"><h3>MCP 接入</h3><p>允许 modmind-mcp 等开源 MCP 客户端接入当前项目，直接使用 ModMind 的制作工具</p></div>
                  <div className="external-agent-list">
                    <div className="external-agent-row">
                      <div className="external-agent-name">
                        <span className={`status-dot ${mcpBridgeState.running ? 'success' : mcpBridgeState.enabled ? 'warning' : ''}`} />
                        <div>
                          <strong>外部 MCP 桥接</strong>
                          <p>
                            {mcpBridgeState.running
                              ? `运行中 · 项目「${mcpBridgeState.projectName ?? mcpBridgeState.projectPath}」`
                              : mcpBridgeState.enabled
                                ? (project ? '已开启，正在启动桥接…' : '已开启；打开项目后自动开始监听')
                                : '未开启'}
                          </p>
                        </div>
                      </div>
                      <div className="external-agent-row-actions">
                        <button
                          className={`toggle${mcpBridgeState.enabled ? ' on' : ''}`}
                          type="button"
                          role="switch"
                          aria-label="外部 MCP 接入"
                          aria-checked={mcpBridgeState.enabled}
                          disabled={mcpBridgeBusy}
                          onClick={() => void mcpBridgeToggle(!mcpBridgeState.enabled)}
                        ><span /></button>
                      </div>
                    </div>
                  </div>
                  {mcpBridgeState.enabled ? (
                    <div className="mcp-bridge-detail">
                      {mcpBridgeState.mcpConfigPath ? (
                        <>
                          <p>把下面的配置文件路径填到你的 MCP 客户端（如 modmind-mcp）即可接入：</p>
                          <code className="mcp-bridge-path">{mcpBridgeState.mcpConfigPath}</code>
                          <div className="settings-actions mcp-bridge-actions">
                            <span><Info size={14} />配置文件在打开项目后生成，切换项目会自动跟随</span>
                            <button className="secondary-button compact" type="button" onClick={() => void navigator.clipboard?.writeText(mcpBridgeState.mcpConfigPath ?? '').then(() => setNotice('已复制 MCP 配置路径')).catch(() => setNotice('复制失败，请手动复制'))}><Copy size={14} />复制路径</button>
                          </div>
                        </>
                      ) : (
                        <p><Info size={14} />开关已打开。打开一个项目后，这里会显示 mcp-config.json 的路径，填进 MCP 客户端即可接入。</p>
                      )}
                    </div>
                  ) : (
                    <div className="mcp-bridge-detail"><p>关闭时不监听任何外部接入；打开后也仅限本机访问，且跟随当前打开的项目。</p></div>
                  )}
                 </section>
                 <section id="settings-image" className="settings-section image-settings-section">
                    <div className="settings-heading"><h2>图像服务</h2><p>图片 API Key 使用系统级加密保存，图像工坊和外部 Agent 共用此配置</p></div>
                    <div className="image-service-form">
                      <label className="field-label">Base URL<input value={imageStudioSettings.baseUrl} onChange={(event) => setImageStudioSettings({ ...imageStudioSettings, baseUrl: event.target.value })} /></label>
                      <label className="field-label">默认图片模型<input value={imageStudioSettings.model} onChange={(event) => setImageStudioSettings({ ...imageStudioSettings, model: event.target.value })} /></label>
                      <label className="field-label">图片 API Key<input type="password" value={imageApiKey} onChange={(event) => setImageApiKey(event.target.value)} placeholder={imageStudioSettings.hasStoredKey ? '已安全保存，留空保持不变' : '输入自己的图片 API Key'} /></label>
                      <div className="settings-actions"><span><ShieldCheck size={15} />{imageStudioSettings.hasStoredKey ? '已有加密凭证' : '未填写时使用 ModMind 托管额度'}</span><div className="settings-button-group">{imageStudioSettings.hasStoredKey ? <button className="secondary-button compact danger" type="button" onClick={() => void clearImageApiKey()}><Trash2 size={14} />删除已保存 Key</button> : null}<button className="primary-button compact" type="button" onClick={() => void saveImageSettings({ apiKey: imageApiKey })}><Save size={14} />保存图像服务</button></div></div>
                    </div>
                    <div className="settings-heading"><h2>AI 图像能力</h2><p>Codex、Claude Code 等外部 Agent 可以直接调用图像 Skill</p></div>
                    <div className="image-settings-form">
                      <div className="appearance-row"><div><strong>AI 图像 Skill</strong><p>外部 Agent 可以直接使用生图和图像处理 Skill</p></div><span className="status-dot success" /></div>
                      <div className="settings-actions"><span><Info size={14} />外部 Agent 生图由 ModMind 自动执行并记录额度</span><button className="secondary-button compact" type="button" onClick={() => setView('image-studio')}><WandSparkles size={14} />打开图像工坊</button></div>
                    </div>
                 </section>
                <section id="settings-build" className="settings-section">
                  <div className="settings-heading"><h2>构建工具</h2><p>ModMind 使用项目自带的 Gradle Wrapper 构建，不安装单独的 Gradle 运行时</p></div>
                  <div className="appearance-row"><div><strong>项目 Gradle Wrapper</strong><p>构建时在项目根目录执行 {navigator.platform.toLowerCase().includes('win') ? '.\\gradlew.bat build' : './gradlew build'}</p></div><span className="status-dot success" /></div>
                </section>
                <section id="settings-java" className="settings-section">
                  <div className="settings-heading"><h2>Java 运行时</h2><p>默认全自动：ModMind 按需检测本机 JDK 并下载托管运行时。也可以为每个场景手动指定 Java，版本不满足时自动回退</p></div>
                  <div className="settings-actions">
                    <span>
                      <Info size={14} />
                      {javaScanState === 'scanning' ? '正在扫描本机 Java…'
                        : javaScanState === 'failed' ? '扫描失败：下方仍可手动填写 Java 目录'
                        : detectedJavaHomes.length ? `检测到 ${detectedJavaHomes.length} 个本机 Java` : '未检测到本机 Java，可选择自动或手动填写目录'}
                    </span>
                    <button className="secondary-button compact" type="button" disabled={javaScanState === 'scanning'} onClick={scanJavaHomes}>
                    {javaScanState === 'scanning' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}重新扫描
                    </button>
                  </div>
                  <JavaHomePreferenceRow
                    label="游戏运行时"
                    description="启动 Minecraft 测试实例、安装 Fabric/NeoForge 加载器时使用的 Java"
                    value={settings.javaPreferences?.game ?? ''}
                    homes={detectedJavaHomes}
                    scanning={javaScanState === 'scanning'}
                    onChange={updateJavaPreference('game')}
                  />
                  <JavaHomePreferenceRow
                    label="Gradle 构建 JDK"
                    description="编译模组项目时注入 Gradle 的 JAVA_HOME；需要包含 javac 的完整 JDK"
                    value={settings.javaPreferences?.build ?? ''}
                    homes={detectedJavaHomes}
                    scanning={javaScanState === 'scanning'}
                    onChange={updateJavaPreference('build')}
                  />
                  <JavaHomePreferenceRow
                    label="内置工具"
                    description="ServerPackCreator 服务端整合、HeadlessMC 冒烟测试等内置工具使用的 Java"
                    value={settings.javaPreferences?.tools ?? ''}
                    homes={detectedJavaHomes}
                    scanning={javaScanState === 'scanning'}
                    onChange={updateJavaPreference('tools')}
                  />
                </section>
                <section id="settings-network" className="settings-section">
                  <div className="settings-heading"><h2>网络</h2><p>Modrinth、CurseForge 等下载源无法直连时，配置 HTTP 代理后立即生效，无需重启</p></div>
                  <label className="field-label">代理地址<input value={settings.networkProxyUrl ?? ''} onChange={(event) => void saveSettingsPatch({ networkProxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" /><small>留空则不使用代理。填写本机代理客户端的 HTTP 端口（Clash 混合端口通常为 7890，v2rayN 为 10809）；不支持 SOCKS 端口。MC百科、Gitee 等国内站点始终直连，不走此代理</small></label>
                </section>
                <section id="settings-diagnostics" className="settings-section">
                  <div className="settings-heading"><h2>诊断日志</h2><p>导出启动、构建和崩溃日志，便于排查本机运行问题。不会包含已保存的 API Key 或 Token</p></div>
                  <div className="settings-actions"><span><TerminalSquare size={15} />包含应用事件、下载重试、Minecraft、构建、服务端日志和页面快照</span><button className="secondary-button" type="button" disabled={diagnosticExporting} onClick={() => void exportDiagnosticLogs()}>{diagnosticExporting ? <LoaderCircle className="spin" size={16} /> : <Archive size={16} />}导出诊断日志</button></div>
                </section>
                <section id="settings-appearance" className="settings-section">
                  <div className="settings-heading"><h2>外观</h2><p>调整 ModMind 的显示方式</p></div>
                  <div className="appearance-row"><div><strong>深色模式</strong><p>使用深色界面降低夜间使用时的亮度</p></div><button className={`toggle ${settings.darkMode ? 'on' : ''}`} type="button" role="switch" aria-label="深色模式" aria-checked={settings.darkMode} onClick={() => void saveSettingsPatch({ darkMode: !settings.darkMode })}><span /></button></div>
                  <div className="settings-actions"><span>修改后会自动保存</span></div>
                </section>
                <section id="settings-sidebar-order" className="settings-section">
                  <div className="settings-heading"><h2>侧边栏顺序</h2><p>恢复功能和类型的默认排列顺序</p></div>
                  <div className="settings-actions"><span>清除当前项目保存的拖拽排序</span><button className="secondary-button danger" type="button" onClick={() => void resetSidebarOrder()}><RotateCcw size={16} />恢复默认顺序</button></div>
                </section>
                <section id="settings-notifications" className="settings-section close-settings-section">
                  <div className="settings-heading"><h2>关闭与通知</h2><p>控制右上角关闭按钮，以及 AI 和构建任务完成后的系统提醒</p></div>
                  <label className="field-label">关闭窗口<select value={settings.closeBehavior} onChange={(event) => void saveSettingsPatch({ closeBehavior: event.target.value as AgentSettings['closeBehavior'] })}><option value="ask">每次询问</option><option value="tray">最小化到系统托盘</option><option value="quit">直接关闭</option></select><small>首次关闭时会询问；勾选“不再提示”后会记住你的选择</small></label>
                  <div className="appearance-row"><div><strong>任务完成通知</strong><p>AI 或构建任务完成、失败时显示系统通知，不显示中间进度</p></div><button className={`toggle ${settings.notificationsEnabled ? 'on' : ''}`} type="button" role="switch" aria-label="任务完成通知" aria-checked={settings.notificationsEnabled} onClick={() => void saveSettingsPatch({ notificationsEnabled: !settings.notificationsEnabled })}><span /></button></div>
                </section>
                <section id="settings-remote" className="settings-section remote-build-section">
                  <div className="settings-heading"><h2>远程构建</h2><p>免费、国内低延迟的构建方案：使用 Gitee Go 托管 CI，推送代码后在国内节点执行 Gradle</p></div>
                  <div className="remote-build-card">
                    <div className="remote-build-card-heading"><div><strong>推荐：Gitee Go</strong><small>免费额度 · 国内节点 · 支持 Java/Gradle 缓存</small></div><span className="status-dot warning" /></div>
                    <p>配置一次仓库和 Token 后，ModMind 会自动生成 `.gitee-ci.yml`、提交项目并推送；已启用 Gitee Go 的仓库会自动开始 Gradle 构建</p>
                    <div className="remote-build-form">
                      <label className="field-label">Gitee 仓库地址<input value={giteeSettings.repositoryUrl} onChange={(event) => { setGiteeSettings({ ...giteeSettings, repositoryUrl: event.target.value }); setGiteeValidation(null) }} placeholder="https://gitee.com/用户名/仓库名" /></label>
                      <label className="field-label">构建分支<input value={giteeSettings.branch} onChange={(event) => setGiteeSettings({ ...giteeSettings, branch: event.target.value })} placeholder="main" /></label>
                      <label className="field-label remote-build-token-field">Gitee Personal Access Token<input type="password" value={giteeSettings.token} onChange={(event) => setGiteeSettings({ ...giteeSettings, token: event.target.value })} placeholder={giteeSettings.hasStoredToken ? '已安全保存，留空则保持不变' : '粘贴 Gitee Token'} /><small>请授予仓库读写权限；Token 只保存在系统加密存储中，用于 Git 推送和仓库校验</small></label>
                    </div>
                    <div className="remote-build-actions"><div className="remote-build-button-group"><button className="secondary-button compact" type="button" onClick={() => window.open('https://gitee.com/profile/personal_access_tokens', '_blank')}><ExternalLink size={14} />创建 Token</button><button className="secondary-button compact" type="button" disabled={Boolean(giteeBuildBusy) || !giteeSettings.repositoryUrl.trim()} onClick={() => void validateGitee()}>{giteeBuildBusy === 'validate' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}校验连接</button><button className="secondary-button compact" type="button" disabled={Boolean(giteeBuildBusy) || !giteeSettings.repositoryUrl.trim()} onClick={() => void saveGiteeBuildSettings()}><Save size={14} />保存</button></div><span>{giteeValidation ? (giteeValidation.valid ? `已连接 ${giteeValidation.repository}` : giteeValidation.detail) : '首次使用需要 Gitee 账号和 Token'}</span></div>
                    <div className="remote-build-primary-action"><button className="primary-button" type="button" disabled={Boolean(giteeBuildBusy) || !giteeSettings.repositoryUrl.trim() || (!giteeSettings.token.trim() && !giteeSettings.hasStoredToken)} onClick={() => void triggerGiteeBuild()}>{giteeBuildBusy === 'build' ? <LoaderCircle className="spin" size={15} /> : <CloudUpload size={15} />}推送并开始远程构建</button>{giteeBuildResult?.pipelineUrl ? <button className="secondary-button compact" type="button" onClick={() => window.open(giteeBuildResult.pipelineUrl, '_blank')}><ExternalLink size={14} />打开 Gitee 流水线</button> : null}</div>
                    <details className="remote-build-guide">
                      <summary>首次使用说明：需要注册账号</summary>
                      <p>远程构建依赖第三方构建平台账号。ModMind 不会索要平台密码，只在浏览器中完成授权；没有账号时仍可使用本地构建</p>
                      <div className="remote-build-account-list">
                        <div><strong>推荐路径</strong><span>注册 Gitee 账号，创建私有仓库并启用 Gitee Go</span></div>
                        <div><strong>备用云平台</strong><span>CODING 需要腾讯云/CODING 账号；CodeArts 需要华为云账号</span></div>
                        <div><strong>自托管路径</strong><span>GitHub Runner 需要 GitHub 账号和在线机器；Jenkins 需要 Gitee 账号和已部署的 Jenkins</span></div>
                      </div>
                      <p className="remote-build-guide-note">云平台免费额度会因账号类型和政策变化；当前版本使用 Gitee Go，Gitee 不可用时请切换到本地构建。其他 Provider 接入后再启用自动择优</p>
                    </details>
                  </div>
                </section>
                <section id="settings-legal" className="settings-section">
                  <div className="settings-heading"><h2>许可证与版权</h2><p>本版本的源码、许可证和第三方组件声明</p></div>
                  <div className="settings-actions"><span><Info size={15} />ModMind 1.4.4 原创源码按 GNU Affero General Public License v3.0-only（AGPL-3.0-only）授权。软件按“现状”提供，不提供任何明示或默示保证。</span><div className="settings-button-group"><button className="secondary-button compact" type="button" onClick={() => window.open('https://github.com/waterpail114514/modmind/blob/main/LICENSE', '_blank')}><ExternalLink size={14} />查看许可证</button><button className="secondary-button compact" type="button" onClick={() => window.open('https://github.com/waterpail114514/modmind', '_blank')}><ExternalLink size={14} />获取对应源码</button></div></div>
                  <div className="settings-actions"><span>1.4.3 及更早版本仍按发布时的 MIT 许可证提供；第三方组件和随包工具以其各自许可证为准。</span><button className="secondary-button compact" type="button" onClick={() => window.open('https://github.com/waterpail114514/modmind/blob/main/THIRD_PARTY_NOTICES.md', '_blank')}><ExternalLink size={14} />第三方声明</button></div>
                </section>
              </div>
            ) : null}
          </main>
        )}
      </div>

      <GlobalDownloadIndicator />
      <PageGuideModal view={view} open={pageGuideOpen} onClose={() => setPageGuideOpen(false)} onLaunchTour={PAGE_TOURS[view] ? () => { setPageGuideOpen(false); setActiveTour('page') } : undefined} />
      <WelcomeTour onLaunchShellTour={() => setActiveTour('shell')} />
      {activeTour === 'page' && PAGE_TOURS[view]
        ? <TourGuide steps={PAGE_TOURS[view]} open title="互动引导" onFinish={() => setActiveTour(null)} />
        : null}
      {activeTour === 'shell'
        ? <TourGuide steps={SHELL_TOUR_STEPS} open title="ModMind 快速上手" onFinish={() => setActiveTour(null)} />
        : null}
      {showCreate ? <CreateProjectDialog onClose={() => setShowCreate(false)} onCreated={(created) => { setProject(created); setShowCreate(false); setProjectLauncherOpen(false); setView('workspace'); void refreshRecentProjects() }} /> : null}
      {renamingProject ? <RenameProjectDialog project={renamingProject} onClose={() => setRenamingProject(null)} onRenamed={projectRenamed} /> : null}
      {existingImportPicker ? <ExistingImportPicker onClose={() => setExistingImportPicker(false)} onSelect={(sourceType) => { setExistingImportPicker(false); void inspectExistingProject(sourceType) }} /> : null}
      {existingInspecting ? <ProjectInspectionDialog kind="project" /> : null}
      {modJarInspecting ? <ProjectInspectionDialog kind="mod" /> : null}
      {existingAnalysis ? <AdoptProjectDialog analysis={existingAnalysis} onClose={() => setExistingAnalysis(null)} onAdopted={(adopted) => { setExistingAnalysis(null); setProject(adopted); setProjectLauncherOpen(false); setView('workspace'); void refreshRecentProjects() }} /> : null}
      {modJarInspection ? <AdoptModJarDialog inspection={modJarInspection} onClose={() => setModJarInspection(null)} onAdopted={(adopted) => { setModJarInspection(null); setProject(adopted); setProjectLauncherOpen(false); setView('workspace'); void refreshRecentProjects() }} /> : null}
      {updateInfo ? <div className="modal-backdrop"><div className="dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title"><div className="dialog-header"><div><h2 id="update-dialog-title">发现新版本</h2><p>ModMind {updateInfo.latestVersion} 已发布</p></div><CloudUpload size={21} /></div><p className="recovery-copy">当前版本为 {updateInfo.currentVersion}。安装包将在后台下载，期间可以收起下载悬浮窗继续工作。</p><div className="dialog-footer"><button className="secondary-button" disabled={updateActionBusy} onClick={() => setUpdateInfo(null)}>暂不下载</button><button className="primary-button" disabled={updateActionBusy} onClick={downloadAppUpdate}>{updateActionBusy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载更新</button></div></div></div> : null}
      {updateDownloadedOpen && appUpdateState.phase === 'downloaded' ? <div className="modal-backdrop"><div className="dialog update-dialog update-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="update-ready-dialog-title"><div className="dialog-header"><div><h2 id="update-ready-dialog-title">更新已下载</h2><p>ModMind {appUpdateState.latestVersion} 已准备好</p></div><PackageOpen size={21} /></div><p className="recovery-copy">安装包已经校验完成。可以立即重启安装；选择稍后时，下次启动 ModMind 会自动进入安装。</p><div className="dialog-footer"><button className="secondary-button" disabled={updateActionBusy} onClick={() => setUpdateDownloadedOpen(false)}>稍后</button><button className="primary-button" disabled={updateActionBusy} onClick={installAppUpdate}>{updateActionBusy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}重启并安装</button></div></div></div> : null}
      {deviceAccountOpen ? <DeviceAccountDialog state={deviceState} remoteState={remoteState} busy={deviceBusy} remoteBusy={remoteBusy} onClose={() => setDeviceAccountOpen(false)} onAuthorize={() => void deviceAuthorize()} onCancel={() => void deviceCancel()} onDisconnect={() => void deviceDisconnect()} onRefresh={() => void deviceRefresh()} onOpenSite={deviceOpenSite} onRemoteToggle={() => void remoteToggle()} /> : null}
      {confirmDialog}
      {promptDialog}
      {notice ? <div className="toast">{notice}</div> : null}
    </div>
  )
}
