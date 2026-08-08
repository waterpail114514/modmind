import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  Archive,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  CloudUpload,
  Code2,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Hammer,
  History,
  LoaderCircle,
  LibraryBig,
  Lightbulb,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import type {
  AiPlan,
  AiModelInfo,
  AiRecoveryInfo,
  AiSettings,
  ExternalAgentStatus,
  BuildTrustRequest,
  ExistingProjectAdoptInput,
  ExistingProjectAnalysis,
  FileNode,
  InspirationChatMessage,
  LoaderKind,
  LoaderVersionOption,
  PipelineEvent,
  PreflightResult,
  ProjectInfo,
  ProjectMigrationPreview,
  SnapshotInfo
} from '../../shared/types'
import type { MappingClassDetail, MappingClassResult } from '../../shared/mappings'
import { appendMinecraftRuntimeEvent, type MinecraftRuntimeEvent } from '../../shared/minecraft'
import BlockbenchWorkspace from './components/BlockbenchWorkspace'
import GitWorkspace from './components/GitWorkspace'
import MinecraftTestWorkspace from './components/MinecraftTestWorkspace'
import ProductionWorkspace from './components/ProductionWorkspace'
import appLogo from './assets/logo.png'

const MonacoCodeEditor = lazy(() => import('./components/MonacoCodeEditor'))

type ViewId = 'workspace' | 'inspiration' | 'blockbench' | 'minecraft' | 'mappings' | 'code' | 'build' | 'snapshots' | 'production' | 'settings'
type InspirationConversation = { id: string; title: string; updatedAt: string; messages: InspirationChatMessage[] }
type AiTimelineItem = {
  id: string
  kind: string
  content: string
  time: string
  diff?: Array<{ path: string; added: number; removed: number; additions: string[]; removals: string[] }>
}

function aiTimelineOutput(items: AiTimelineItem[]): string {
  const labels: Record<string, string> = { history: '已恢复上下文', start: '任务开始', retry: '重试', tool: '工具结果', warning: '警告', error: '错误', diff: '代码修改', status: '状态' }
  return items.map((item) => `${labels[item.kind] ? `[${labels[item.kind]}]\n` : ''}${item.content}`).join('\n\n')
}

function timelineLabel(kind: string): string {
  return { history: '已恢复上下文', start: '任务开始', retry: '重试', tool: '工具结果', warning: '警告', error: '错误', diff: '代码修改' }[kind] ?? ''
}

function normalizeStoredTimelineItem(item: AiTimelineItem): AiTimelineItem {
  if (item.kind !== 'error') return item
  if (/(?:warning|warn|deprecated|deprecation|警告|重试|重新连接)/i.test(item.content)) return {...item, kind: 'warning'}
  if (/(?:error|fatal|exception|failed|forbidden|unauthorized|timed out|timeout|错误|失败|异常|无法|超时|退出码|拒绝)/i.test(item.content)) return item
  return {...item, kind: 'tool'}
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

const initialSettings: AiSettings = {
  provider: 'openai-compatible',
  codingBackend: 'internal',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
  parallelism: 2,
  agentMaxSteps: 0,
  maxBuilds: 0,
  allowBuildScriptChanges: true,
  preferLocalGradle: false,
  gradleExecutable: '',
  gradleDownloadSource: 'auto',
  darkMode: false
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function editorLanguage(relativePath: string): string {
  const extension = relativePath.split('.').at(-1)?.toLowerCase() ?? ''
  return {
    java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'groovy', groovy: 'groovy',
    json: 'json', mcmeta: 'json', md: 'markdown', html: 'html', htm: 'html',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss', properties: 'ini'
  }[extension] ?? 'plaintext'
}

function isEditablePath(relativePath: string): boolean {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  if (['gradlew', 'license', 'copying'].includes(name)) return true
  return /\.(?:java|kt|kts|gradle|groovy|json|mcmeta|md|txt|toml|html?|xml|ya?ml|js|jsx|ts|tsx|css|scss|properties|bat|cmd|sh|gitignore)$/i.test(name)
}

function shouldOfferAiRecovery(error: unknown): boolean {
  const message = errorMessage(error)
  return /recovery snapshot was preserved|safety stop|interrupted|中断|安全停止|恢复快照/i.test(message)
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
      <p>创建新工程，或打开之前由 ModMind 管理的项目。</p>
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
  onSelect,
  onRemove
}: {
  projects: ProjectInfo[]
  onCreate: () => void
  onOpen: () => void
  onAdopt: () => void
  onSelect: (project: ProjectInfo) => void
  onRemove: (project: ProjectInfo) => void
}): React.JSX.Element {
  return (
    <main className="project-launcher">
      <div className="project-launcher-header">
        <div><h1>项目</h1><p>选择最近项目或开始一个新项目</p></div>
      </div>
      <div className="project-launcher-list">
        <button className="project-launcher-action" type="button" onClick={onCreate}>
          <span className="project-launcher-icon new"><Plus size={20} /></span>
          <span><strong>新建项目</strong><small>创建新的 Minecraft Mod 工程</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onOpen}>
          <span className="project-launcher-icon open"><FolderOpen size={19} /></span>
          <span><strong>打开已有项目</strong><small>从其他位置选择 ModMind 项目文件夹</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onAdopt}>
          <span className="project-launcher-icon adopt"><PackageOpen size={19} /></span>
          <span><strong>接管现有项目</strong><small>支持项目文件夹或 ZIP，识别完整工程、残缺源码或 API 文档</small></span>
          <ChevronRight size={17} />
        </button>
      </div>
      {projects.length ? (
        <section className="recent-projects">
          <h2>最近项目</h2>
          <div className="recent-project-list">
            {projects.map((recent) => (
              <div className="recent-project-row" key={recent.path}>
                <button className="recent-project-main" type="button" onClick={() => onSelect(recent)}>
                  <span className="project-launcher-icon project"><Box size={18} /></span>
                  <span><strong>{recent.name}</strong><small>{recent.path}</small></span>
                  <span className="recent-project-meta">{recent.loader} · {recent.minecraftVersion}</span>
                </button>
                <button className="recent-project-remove" type="button" title="从最近项目中移除" onClick={() => onRemove(recent)}><X size={15} /></button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  )
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
  const kindLabel = analysis.kind === 'complete' ? '完整工程' : analysis.kind === 'partial' ? '残缺源码' : 'API 文档'

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
        <div className="adopt-reasons">{analysis.reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
        <div className="adopt-fields">
          <label className="field-label">项目名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="field-label">命名空间<input value={form.namespace} onChange={(event) => setForm({ ...form, namespace: event.target.value })} /></label>
          <label className="field-label">Minecraft 版本<input value={form.minecraftVersion} onChange={(event) => setForm({ ...form, minecraftVersion: event.target.value })} /></label>
          <label className="field-label">加载器<select value={form.loader} disabled={analysis.kind !== 'complete'} onChange={(event) => setForm({ ...form, loader: event.target.value as ExistingProjectAdoptInput['loader'] })}><option value="fabric">Fabric</option><option value="quilt">Quilt</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label>
        </div>
        {analysis.detectedFiles.length ? <div className="adopt-files"><span>检测到的关键文件</span><code>{analysis.detectedFiles.slice(0, 8).join('\n')}</code></div> : null}
        {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !form.name.trim() || !form.namespace.trim()} onClick={() => void adopt()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <PackageOpen size={16} />}{analysis.kind === 'complete' ? '接管此项目' : '创建项目并导入'}
          </button>
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
          <button className="project-launcher-action" type="button" onClick={() => onSelect('zip')}>
            <span className="project-launcher-icon adopt"><PackageOpen size={19} /></span>
            <span><strong>ZIP 压缩包</strong><small>自动解压后识别并导入项目内容</small></span>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}

function InspirationWorkspace({ project, visible, onSendToCoding }: { project: ProjectInfo; visible: boolean; onSendToCoding: (prompt: string) => void }): React.JSX.Element {
  const [messages, setMessages] = useState<InspirationChatMessage[]>([])
  const [conversations, setConversations] = useState<InspirationConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const quickPrompts = [
    '分析当前项目结构，指出已经实现的内容、缺口和最值得优先处理的风险。',
    '结合现有代码，给我三个能融入当前模组的 Boss 设计，并说明战斗阶段和实现难点。',
    '阅读导入的源码或 API 文档，告诉我可以利用哪些能力，以及它们适合做什么玩法。',
    '基于当前项目给出下一步开发路线，按价值和工作量排序。'
  ]
  const storageKey = `modmind-inspiration:${project.path}`

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { activeId?: string; conversations?: InspirationConversation[] } | null
      const valid = Array.isArray(saved?.conversations) ? saved.conversations.filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.messages)) : []
      const fallback: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
      const list = valid.length ? valid : [fallback]
      const active = list.find((entry) => entry.id === saved?.activeId) ?? list[0]
      setConversations(list)
      setActiveConversationId(active.id)
      setMessages(active.messages)
    } catch {
      const fallback: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
      setConversations([fallback])
      setActiveConversationId(fallback.id)
      setMessages([])
    }
    setHydrated(true)
  }, [storageKey])

  useEffect(() => {
    if (!hydrated || !activeConversationId) return
    const updated = conversations.map((conversation) => conversation.id === activeConversationId ? { ...conversation, messages: messages.slice(-100), updatedAt: new Date().toISOString() } : conversation)
    setConversations(updated)
    localStorage.setItem(storageKey, JSON.stringify({ activeId: activeConversationId, conversations: updated }))
  }, [messages, activeConversationId, hydrated, storageKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  const send = async (value = draft): Promise<void> => {
    const content = value.trim()
    if (!content || busy) return
    const history = messages.slice(-20)
    setMessages((current) => [...current, { role: 'user', content }])
    setDraft('')
    setBusy(true)
    try {
      const reply = await window.modmind.ai.inspire(content, history)
      setMessages((current) => [...current, { role: 'assistant', content: reply }])
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', content: `无法完成分析：${errorMessage(error)}` }])
    } finally {
      setBusy(false)
    }
  }

  const startNewConversation = (): void => {
    if (messages.length && !window.confirm('清空当前灵感对话并开始新对话吗？')) return
    const conversation: InspirationConversation = { id: `${Date.now()}`, title: '新对话', updatedAt: new Date().toISOString(), messages: [] }
    setConversations((current) => [conversation, ...current])
    setActiveConversationId(conversation.id)
    setMessages([])
    setDraft('')
  }

  const selectConversation = (conversation: InspirationConversation): void => {
    setActiveConversationId(conversation.id)
    setMessages(conversation.messages)
    setDraft('')
  }

  return (
    <div className="inspiration-page" hidden={!visible}>
      <div className="content-toolbar">
        <div><h1>灵感台</h1><p>只读分析与创意讨论，不执行编程</p></div>
        <div className="inspiration-toolbar"><span className="inspiration-model-state"><Lightbulb size={15} />项目顾问</span><button className="secondary-button compact" type="button" onClick={startNewConversation}><Plus size={14} />新对话</button></div>
      </div>
      <div className="inspiration-layout">
        <aside className="inspiration-sidebar">
          <div className="inspiration-project"><span className="project-launcher-icon project"><Box size={18} /></span><div><strong>{project.name}</strong><small>{project.loader} · {project.minecraftVersion}</small></div></div>
          <dl><div><dt>命名空间</dt><dd>{project.namespace}</dd></div><div><dt>项目位置</dt><dd title={project.path}>{project.path}</dd></div></dl>
           <div className="inspiration-quick"><span>快速提问</span>{quickPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => void send(prompt)}>{prompt}<ChevronRight size={14} /></button>)}</div>
           <div className="inspiration-history"><span>历史对话</span>{conversations.slice(0, 8).map((conversation) => <button key={conversation.id} className={conversation.id === activeConversationId ? 'active' : ''} type="button" onClick={() => selectConversation(conversation)}>{conversation.title}<small>{conversation.messages.length} 条消息</small></button>)}</div>
        </aside>
        <section className="inspiration-chat">
          <div className="inspiration-messages">
            {!messages.length ? <div className="inspiration-empty"><Lightbulb size={30} /><h2>从项目本身开始思考</h2><p>询问现有实现、技术风险、API 用法或玩法灵感。</p></div> : null}
            {messages.map((message, index) => (
              <div className={`inspiration-message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === 'assistant' ? <Bot size={16} /> : <UserRound size={16} />}</span>
                <div><strong>{message.role === 'assistant' ? '灵感台' : '你'}</strong>{message.role === 'assistant' ? <><MarkdownMessage content={message.content} /><button className="message-action" type="button" onClick={() => onSendToCoding(message.content)}><Code2 size={13} />交给工作台</button></> : <p>{message.content}</p>}</div>
              </div>
            ))}
            {busy ? <div className="inspiration-message assistant"><span><Bot size={16} /></span><div><strong>灵感台</strong><p className="inspiration-thinking"><LoaderCircle className="spin" size={15} />正在阅读项目并整理思路</p></div></div> : null}
            <div ref={endRef} />
          </div>
          <div className="inspiration-composer">
            <textarea value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="询问项目结构、API 用法或玩法灵感" />
             <div className="inspiration-composer-actions"><button className="secondary-button compact" type="button" title="发送到工作台" disabled={!draft.trim()} onClick={() => onSendToCoding(draft.trim())}><Code2 size={14} />交给工作台</button><button className="send-button" title="发送" disabled={busy || !draft.trim()} onClick={() => void send()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>
          </div>
        </section>
      </div>
    </div>
  )
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: ProjectInfo) => void }): React.JSX.Element {
  const [name, setName] = useState('')
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

  useEffect(() => {
    if (!availableVersions.length || availableVersions.some((option) => option.minecraftVersion === version)) return
    setVersion(availableVersions[0].minecraftVersion)
  }, [loader, catalog, version, availableVersions])

  const create = async (): Promise<void> => {
    if (!name.trim()) return setError('请输入项目名称')
    setBusy(true)
    setError('')
    try {
      const project = await window.modmind.project.create({ name, loader, minecraftVersion: version })
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
            <h2>新建 Mod 项目</h2>
            <p>选择基础环境，ModMind 将生成可编辑工程。</p>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <label className="field-label">
          项目名称
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：经验水晶" />
        </label>
        <div className="field-label">
          加载器
          <div className="segmented-control">
            <button className={loader === 'fabric' ? 'active' : ''} onClick={() => setLoader('fabric')}>Fabric</button>
            <button className={loader === 'quilt' ? 'active' : ''} onClick={() => setLoader('quilt')}>Quilt</button>
            <button className={loader === 'forge' ? 'active' : ''} onClick={() => setLoader('forge')}>Forge</button>
            <button className={loader === 'neoforge' ? 'active' : ''} onClick={() => setLoader('neoforge')}>NeoForge</button>
          </div>
        </div>
        <label className="field-label">
          Minecraft 版本
          <select value={version} disabled={catalogBusy || !availableVersions.length} onChange={(event) => setVersion(event.target.value)}>
            {availableVersions.map((option) => <option key={`${option.loader}-${option.minecraftVersion}`} value={option.minecraftVersion}>{option.minecraftVersion}{option.supportTier === 'experimental' ? '（实验性）' : ''}</option>)}
          </select>
          {catalogBusy ? <small>正在读取加载器兼容目录…</small> : null}
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

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('workspace')
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [recentProjects, setRecentProjects] = useState<ProjectInfo[]>([])
  const [projectLauncherOpen, setProjectLauncherOpen] = useState(true)
  const [existingAnalysis, setExistingAnalysis] = useState<ExistingProjectAnalysis | null>(null)
  const [existingImportPicker, setExistingImportPicker] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [files, setFiles] = useState<FileNode[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorDirty, setEditorDirty] = useState(false)
  const [prompt, setPrompt] = useState('')
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
  const [buildTrustRequest, setBuildTrustRequest] = useState<BuildTrustRequest | null>(null)
  const [settings, setSettings] = useState<AiSettings>(initialSettings)
  const [notice, setNotice] = useState('')
  const [aiPlan, setAiPlan] = useState<AiPlan | null>(null)
  const [aiTodo, setAiTodo] = useState<Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>>([])
  const [planning, setPlanning] = useState(false)
  const [availableModels, setAvailableModels] = useState<AiModelInfo[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [scanningModels, setScanningModels] = useState(false)
  const [modelScanMessage, setModelScanMessage] = useState('输入 API Key 后自动扫描')
  const [aiOutput, setAiOutput] = useState('AI 的结构化响应会显示在这里。')
  const [aiTimeline, setAiTimeline] = useState<AiTimelineItem[]>([])
  const [aiOutputStatus, setAiOutputStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [externalAgents, setExternalAgents] = useState<ExternalAgentStatus[]>([])
  const [externalAgentsReady, setExternalAgentsReady] = useState(false)
  const [installingAgents, setInstallingAgents] = useState<Partial<Record<'codex' | 'claude' | 'opencode', boolean>>>({})
  const aiFollowBottomRef = useRef(true)
  const [aiHistoryLoadedKey, setAiHistoryLoadedKey] = useState('')
  const aiOutputHistoryKey = project ? `modmind-ai-output:${project.path}:${settings.codingBackend}` : ''

  const humanizeActivity = (value: string): string => value
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

  const humanizeOutput = (value: string): string => value
    .replaceAll('Invalid Agent response; requesting one valid action:', 'AI 返回格式需要调整，正在重试：')
    .replaceAll('The model failed the Agent protocol 3 times:', 'AI 连续 3 次没有按要求返回操作：')
    .replaceAll('The AI model did not respond within 10 minutes.', 'AI 超过 10 分钟没有响应。')
    .replaceAll('Unable to connect to the AI service:', '无法连接 AI 服务：')
  const [aiRecovery, setAiRecovery] = useState<AiRecoveryInfo | null>(null)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [mappingQuery, setMappingQuery] = useState('')
  const [mappingResults, setMappingResults] = useState<MappingClassResult[]>([])
  const [mappingDetail, setMappingDetail] = useState<MappingClassDetail | null>(null)
  const [mappingMemberQuery, setMappingMemberQuery] = useState('')
  const [mappingBusy, setMappingBusy] = useState(false)
  const [mappingMessage, setMappingMessage] = useState('输入任意命名空间中的类名，例如 Item、class_1792 或 C_1381_。')

  const refreshFiles = async (): Promise<void> => {
    if (!project) return
    setFiles(await window.modmind.project.listFiles())
  }

  const refreshSnapshots = async (): Promise<void> => {
    if (!project) return
    setSnapshots(await window.modmind.snapshots.list())
  }

  const refreshRecentProjects = async (): Promise<void> => {
    setRecentProjects(await window.modmind.project.listRecent())
  }

  useEffect(() => {
    if (!aiOutputHistoryKey) {
      setAiTimeline([])
      setAiOutput('AI 的结构化响应会显示在这里。')
      setAiHistoryLoadedKey('')
      return
    }
    let history: AiTimelineItem[] = []
    try {
      const value = JSON.parse(localStorage.getItem(aiOutputHistoryKey) ?? '[]') as unknown
      if (Array.isArray(value)) history = value
        .filter((item): item is AiTimelineItem => Boolean(item && typeof item === 'object' && typeof (item as AiTimelineItem).id === 'string' && typeof (item as AiTimelineItem).content === 'string' && typeof (item as AiTimelineItem).kind === 'string' && typeof (item as AiTimelineItem).time === 'string'))
        .map(normalizeStoredTimelineItem)
    } catch {
      history = []
    }
    aiFollowBottomRef.current = true
    setAiTimeline(history)
    setAiOutput(history.length ? aiTimelineOutput(history) : 'AI 的结构化响应会显示在这里。')
    setAiHistoryLoadedKey(aiOutputHistoryKey)
    let cancelled = false
    if (settings.codingBackend !== 'internal') {
      void window.modmind.externalAgents.history(settings.codingBackend).then((context) => {
        if (cancelled || !context.trim()) return
        const label = settings.codingBackend === 'codex' ? 'Codex' : settings.codingBackend === 'claude' ? 'Claude Code' : 'opencode'
        const marker = `[已恢复的 ${label} 对话上下文]`
        setAiOutput((current) => current.includes(marker) ? current : `${marker}\n${context}\n\n${current}`)
        setAiTimeline((current) => {
          if (current.some((item) => item.kind === 'history' && item.content.includes(marker))) return current
          return [{ id: `history-${settings.codingBackend}-${Date.now()}`, kind: 'history', content: `${marker}\n${context}`, time: new Date().toISOString() }, ...current]
        })
      }).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [aiOutputHistoryKey])

  useEffect(() => {
    if (!aiOutputHistoryKey || aiHistoryLoadedKey !== aiOutputHistoryKey) return
    try {
      localStorage.setItem(aiOutputHistoryKey, JSON.stringify(aiTimeline))
    } catch {
      // Keep the live timeline even when the browser storage quota is full.
    }
  }, [aiTimeline, aiHistoryLoadedKey, aiOutputHistoryKey])

  useEffect(() => {
    if (!aiFollowBottomRef.current) return
    const element = document.querySelector<HTMLElement>('.ai-timeline')
    if (!element) return
    const frame = window.requestAnimationFrame(() => element.scrollTo({top: element.scrollHeight, behavior: 'smooth'}))
    return () => window.cancelAnimationFrame(frame)
  }, [aiTimeline])

  useEffect(() => {
    const element = document.querySelector<HTMLElement>('.ai-timeline')
    if (!element) return
    const updateFollowState = (): void => {
      aiFollowBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    }
    element.addEventListener('scroll', updateFollowState, {passive: true})
    return () => element.removeEventListener('scroll', updateFollowState)
  }, [aiHistoryLoadedKey, view])

  useEffect(() => {
    void Promise.all([window.modmind.project.current(), window.modmind.project.listRecent()]).then(([current, recent]) => {
      setProject(current)
      setRecentProjects(recent)
      setProjectLauncherOpen(!current)
      if (current) void window.modmind.ai.getRecovery().then((recovery) => { if (recovery.pending) setAiRecovery(recovery) })
    })
    void window.modmind.settings.getAi().then(setSettings)
    void window.modmind.project.listLoaderVersions().then(setLoaderCatalog).catch(() => undefined)
    void window.modmind.externalAgents.detect().then(setExternalAgents).catch(() => undefined).finally(() => setExternalAgentsReady(true))
    const removeBuildListener = window.modmind.build.onProgress((event) => setEvents((current) => [event, ...current]))
    const removeBuildTrustListener = window.modmind.build.onTrustRequired(setBuildTrustRequest)
    const removeAiListener = window.modmind.ai.onProgress((event) => {
      setEvents((current) => [event, ...current])
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
      if (event.kind === 'start') {
        const content = humanizeOutput(event.content)
        const historyMarker = '\n\n[已恢复的 '
        const historyIndex = content.indexOf(historyMarker)
        const taskContent = historyIndex >= 0 ? content.slice(0, historyIndex).trim() : content
        setAiOutput((current) => {
          const displayContent = historyIndex >= 0 && current.includes('[已恢复的 ') ? taskContent : content
          return current === 'AI 的结构化响应会显示在这里。' ? displayContent : `${current}\n\n[任务开始]\n${displayContent}`
        })
        setAiTimeline((current) => {
          const displayContent = historyIndex >= 0 && current.some((item) => item.content.includes('[已恢复的 ')) ? taskContent : content
          const item: AiTimelineItem = { id: `${event.time}-start-${Date.now()}`, kind: 'start', content: displayContent, time: event.time }
          return [...current, item]
        })
        // Recovery progress sends the saved Todo immediately after start;
        // keep the current list until a new plan arrives.
        setAiOutputStatus('running')
        return
      }
      if (event.kind === 'stream-start') {
        setAiOutputStatus('running')
        return
      }
      if (event.kind === 'delta') {
        setAiOutputStatus('running')
        return
      }
      if (event.kind === 'answer') {
        const content = humanizeOutput(event.content)
        const item: AiTimelineItem = { id: `${event.time}-answer-${Date.now()}`, kind: 'answer', content, time: event.time }
        setAiOutput((current) => current === 'AI 的结构化响应会显示在这里。' ? content : `${current}\n\n${content}`)
        setAiTimeline((current) => [...current, item])
        setAiOutputStatus('success')
        return
      }
      const label = event.kind === 'retry' ? '重试' : event.kind === 'tool' ? '操作' : event.kind === 'warning' ? '警告' : event.kind === 'error' ? '错误' : event.kind === 'response' ? '' : '状态'
      const content = humanizeOutput(event.content)
      setAiOutput((current) => `${current}\n\n${label ? `[${label}]\n` : ''}${content}`)
      if (event.kind === 'response' || event.kind === 'retry' || event.kind === 'tool' || event.kind === 'warning' || event.kind === 'error') {
        if (content.startsWith('__CODE_DIFF__')) {
          try {
            const diff = JSON.parse(content.slice('__CODE_DIFF__'.length)) as Array<{ path: string; added: number; removed: number; additions: string[]; removals: string[] }>
            setAiTimeline((current) => [...current, { id: `${event.time}-${current.length}`, kind: 'diff', content: '代码修改已应用', time: event.time, diff }])
          } catch {
            setAiTimeline((current) => [...current, { id: `${event.time}-${current.length}`, kind: event.kind, content, time: event.time }])
          }
        } else {
          setAiTimeline((current) => [...current, { id: `${event.time}-${current.length}`, kind: event.kind, content, time: event.time }])
        }
      }
      if (event.kind === 'error') setAiOutputStatus('error')
    })
    const removeMinecraftListener = window.modmind.minecraft.onEvent((event) => {
      setMinecraftEvents((current) => appendMinecraftRuntimeEvent(current, event, 500))
    })
    return () => {
      removeBuildListener()
      removeBuildTrustListener()
      removeAiListener()
      removeAiOutputListener()
      removeMinecraftListener()
    }
  }, [])

  useEffect(() => {
    if (!project) return
    void refreshFiles()
    void refreshSnapshots()
    setMigrationLoader(project.loader)
    setMigrationVersion('')
    setMigrationPreview(null)
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
        const recovery = await window.modmind.ai.getRecovery()
        setAiRecovery(recovery.pending ? recovery : null)
      }
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const restoreInterruptedAi = async (): Promise<void> => {
    setRecoveryBusy(true)
    try {
      const backup = await window.modmind.ai.restoreRecovery()
      setAiRecovery(null)
      await refreshFiles()
      await refreshSnapshots()
      setNotice(backup ? `已恢复 AI 修改前状态，当前内容备份为 ${backup.id.slice(0, 19)}` : '没有找到可恢复的 AI 快照')
    } catch (error) {
      setNotice(`恢复失败：${errorMessage(error)}`)
    } finally {
      setRecoveryBusy(false)
    }
  }

  const resumeInterruptedAi = async (): Promise<void> => {
    setRecoveryBusy(true)
    setPlanning(true)
    setAiOutputStatus('running')
    setAiOutput('正在从保存的 AI 检查点继续任务…')
    setNotice('正在恢复 AI 任务；会继续读取项目并重新验证构建')
    // The recovery dialog is a confirmation step, not a progress screen. Keep
    // the workspace usable while the model/build loop runs; re-open it only if
    // the backend reports that the checkpoint still needs attention.
    setAiRecovery(null)
    try {
      const result = await window.modmind.ai.resumeRecovery()
      setAiPlan(result)
      if (result.todo) {
        setAiTodo(result.todo)
      } else {
        setAiTodo((current) => current.length ? current : result.tasks.map((task, index) => ({ id: `T${index + 1}`, title: task, status: 'completed' as const })))
      }
      setAiOutputStatus('success')
      await refreshFiles()
      await refreshSnapshots()
      setNotice('AI 已从中断点继续，并完成构建与独立验收')
    } catch (error) {
      setAiOutputStatus('error')
      setAiOutput((current) => `${current}\n\n[恢复失败]\n${errorMessage(error)}`)
      setNotice(`继续任务失败：${errorMessage(error)}`)
      if (shouldOfferAiRecovery(error)) {
        const recovery = await window.modmind.ai.getRecovery().catch(() => ({ pending: false, snapshot: null }))
        if (recovery.pending) setAiRecovery(recovery)
      }
    } finally {
      setPlanning(false)
      setRecoveryBusy(false)
    }
  }

  const inspectExistingProject = async (sourceType: 'folder' | 'zip'): Promise<void> => {
    try {
      const analysis = await window.modmind.project.inspectExisting(sourceType)
      if (analysis) setExistingAnalysis(analysis)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const openRecentProject = async (recent: ProjectInfo): Promise<void> => {
    try {
      const opened = await window.modmind.project.openRecent(recent.path)
      setProject(opened)
      setView('workspace')
      setProjectLauncherOpen(false)
      void refreshRecentProjects()
      const recovery = await window.modmind.ai.getRecovery()
      setAiRecovery(recovery.pending ? recovery : null)
    } catch (error) {
      setNotice(errorMessage(error))
      void refreshRecentProjects()
    }
  }

  const removeRecentProject = async (recent: ProjectInfo): Promise<void> => {
    try {
      setRecentProjects(await window.modmind.project.removeRecent(recent.path))
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const selectFile = async (node: FileNode): Promise<void> => {
    if (node.type !== 'file') return
    try {
      if (editorDirty && selectedFile && selectedFile !== node.path) {
        await window.modmind.project.writeFile(selectedFile, editorContent)
      }
      setSelectedFile(node.path)
      if (!isEditablePath(node.path)) {
        setEditorContent('')
        setEditorDirty(false)
        setNotice('该文件不是可编辑文本，可使用工具栏在文件管理器中显示。')
        return
      }
      const content = await window.modmind.project.readFile(node.path)
      setEditorContent(content)
      setEditorDirty(false)
    } catch (error) {
      setNotice(`无法读取文件：${errorMessage(error)}`)
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
    if (!selectedFile) return
    try {
      await window.modmind.project.writeFile(selectedFile, editorContent)
      setEditorDirty(false)
      setNotice('文件已保存')
    } catch (error) {
      setNotice(`保存失败：${errorMessage(error)}`)
    }
  }

  const createProjectFile = async (): Promise<void> => {
    const suggestedDirectory = selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/') + 1) : 'src/main/'
    const relativePath = window.prompt('输入新文件的项目相对路径', `${suggestedDirectory}NewFile.java`)?.trim()
    if (!relativePath) return
    try {
      const result = await window.modmind.project.createFile(relativePath)
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
    const relativePath = window.prompt('输入新目录的项目相对路径', `${suggestedDirectory}/new-directory`)?.trim()
    if (!relativePath) return
    try {
      const result = await window.modmind.project.createDirectory(relativePath)
      await refreshFiles()
      setNotice(`已创建 ${result.path}`)
    } catch (error) {
      setNotice(`创建目录失败：${errorMessage(error)}`)
    }
  }

  const renameSelectedFile = async (): Promise<void> => {
    if (!selectedFile) return
    const nextPath = window.prompt('输入新的项目相对路径', selectedFile)?.trim()
    if (!nextPath || nextPath === selectedFile) return
    try {
      if (editorDirty) await window.modmind.project.writeFile(selectedFile, editorContent)
      const result = await window.modmind.project.renamePath(selectedFile, nextPath)
      setSelectedFile(result.path)
      setEditorDirty(false)
      await refreshFiles()
      setNotice(`已重命名为 ${result.path}`)
    } catch (error) {
      setNotice(`重命名失败：${errorMessage(error)}`)
    }
  }

  const deleteSelectedFile = async (): Promise<void> => {
    if (!selectedFile || !window.confirm(`删除“${selectedFile}”？\n\n此操作不会删除受保护的项目目录。`)) return
    try {
      await window.modmind.project.deletePath(selectedFile)
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
    setBuilding(true)
    setBuildResult(null)
    setBuildError('')
    setMinecraftEvents([])
    setEvents((current) => [
      {
        id: `build-start-${Date.now()}`,
        stage: 'building',
        title: '正在构建项目',
        detail: '执行托管 Gradle build',
        status: 'running',
        time: new Date().toISOString()
      },
      ...current
    ])
    try {
      const artifact = await window.modmind.minecraft.buildProject()
      const result = await window.modmind.build.preflight()
      result.logs.unshift(`PASS  Gradle artifact: ${artifact.name}`)
      result.summary = result.success ? 'Gradle 构建成功，项目预检通过。' : result.summary
      setBuildResult(result)
      if (!result.success) {
        const detail = 'Gradle 已生成有效 JAR，但项目预检未通过；本次构建不标记为成功。'
        setBuildError(detail)
        setEvents((current) => [
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
      setBuildError(detail)
      setEvents((current) => [
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
      setBuilding(false)
    }
  }

  const captureIdea = async (): Promise<void> => {
    if (!prompt.trim() || !project) return
    const idea = prompt.trim()
    setEvents((current) => [
      {
        id: `idea-${Date.now()}`,
        stage: 'planning',
        title: '需求已记录',
        detail: '已写入 docs/idea.md',
        status: 'success',
        time: new Date().toISOString()
      },
      ...current
    ])
    await window.modmind.project.captureIdea(idea)
    setPrompt('')
    await refreshFiles()
    if (settings.codingBackend === 'internal' && !settings.model) {
      setNotice('需求已保存；请先在设置中配置 AI 模型')
      return
    }
    setPlanning(true)
    setAiOutputStatus('running')
    setEvents((current) => [
      {
        id: `plan-${Date.now()}`,
        stage: 'planning',
        title: 'AI 正在分析请求',
        detail: settings.codingBackend === 'internal' ? settings.model : settings.codingBackend === 'codex' ? 'Codex 正在判断任务意图' : settings.codingBackend === 'claude' ? 'Claude Code 正在判断任务意图' : 'opencode 正在判断任务意图',
        status: 'running',
        time: new Date().toISOString()
      },
      ...current
    ])
    const sessionId = `coding-${Date.now()}`
    try {
      let plan = await window.modmind.ai.createCode(idea, sessionId, settings.codingBackend)
      setAiPlan(plan)
      if (plan.todo) setAiTodo(plan.todo)
      else setAiTodo((current) => current.length ? current : plan.tasks.map((task, index) => ({ id: `T${index + 1}`, title: task, status: 'completed' as const })))
      setAiOutputStatus('success')
      const informational = plan.intent === 'informational'
      setEvents((current) => [
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
      await refreshFiles()
      await refreshSnapshots()
      setNotice(informational ? 'AI 已完成回答，项目未发生修改' : 'AI 已完成修改、构建和自动验收；请进入游戏测试实际玩法')
    } catch (error) {
      setEvents((current) => [
        {
          id: `plan-error-${Date.now()}`,
          stage: 'error',
          title: 'AI 编程失败',
          detail: errorMessage(error),
          status: 'error',
          time: new Date().toISOString()
        },
        ...current
      ])
      setNotice(errorMessage(error))
      setAiOutputStatus('error')
      setAiOutput((current) => `${current}\n\n[任务失败]\n${errorMessage(error)}`)
      if (shouldOfferAiRecovery(error)) {
        const recovery = await window.modmind.ai.getRecovery().catch(() => ({ pending: false, snapshot: null }))
        if (recovery.pending) setAiRecovery(recovery)
      }
    } finally {
      setPlanning(false)
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
      if (target) setNotice(`Mod JAR 已导出到 ${target}`)
    } catch (error) {
      setNotice(`导出失败：${errorMessage(error)}`)
    }
  }

  const repairBuildWithAi = async (): Promise<void> => {
    if (!project || !buildError || planning || building) return
    let failure = buildError
    const sessionId = `build-repair-${Date.now()}`
    setPlanning(true)
    setAiOutputStatus('running')
    try {
      for (let round = 1; round <= MAX_AUTO_REPAIR_ROUNDS; round += 1) {
        setEvents((current) => [
          {
            id: `repair-build-${round}-${Date.now()}`,
            stage: 'planning',
            title: `AI 自动修复 ${round}/${MAX_AUTO_REPAIR_ROUNDS}`,
            detail: '读取编译错误和当前工程文件',
            status: 'running',
            time: new Date().toISOString()
          },
          ...current
        ])
        const result = await window.modmind.ai.createCode(
          `Automatic build repair round ${round}/${MAX_AUTO_REPAIR_ROUNDS}. Fix every reported build error while preserving the requested mod behavior. Make the smallest complete source changes needed.\n\nBUILD FAILURE\n${failure}`,
          sessionId
        )
        setAiPlan(result)
        setAiOutputStatus('success')
        await refreshFiles()
        await refreshSnapshots()
        const build = await performBuild()
        if (build.success) {
          setNotice(`AI 修复 ${round} 轮后构建成功`)
          return
        }
        failure = build.error
        setAiOutputStatus('running')
      }
      setView('build')
      setNotice(`已自动修复 ${MAX_AUTO_REPAIR_ROUNDS} 轮，最后一次错误已保留`)
    } catch (error) {
      const detail = errorMessage(error)
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
    } finally {
      setPlanning(false)
    }
  }

  const createSnapshot = async (): Promise<void> => {
    if (!project) return
    try {
      const result = await window.modmind.snapshots.create('手动快照')
      setSnapshots((current) => [result, ...current])
      setNotice(`已保存 ${result.fileCount} 个文件`)
    } catch (error) {
      setNotice(`快照失败：${errorMessage(error)}`)
    }
  }

  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || building || planning || migrationBusy) return
    const unsavedMessage = editorDirty
      ? '\n\n当前代码编辑器有未保存内容；继续后会先保存，并包含在自动安全备份中。'
      : ''
    if (!window.confirm(`恢复快照“${snapshot.label}”？\n\n当前项目状态会先自动备份，恢复失败时会自动回滚。${unsavedMessage}`)) return
    setRestoringSnapshotId(snapshot.id)
    try {
      if (editorDirty && selectedFile) await window.modmind.project.writeFile(selectedFile, editorContent)
      const result = await window.modmind.snapshots.restore(snapshot.id)
      setProject(result.project)
      setSelectedFile('')
      setEditorContent('')
      setEditorDirty(false)
      setBuildResult(null)
      setBuildError('')
      setEvents([])
      setMinecraftEvents([])
      setAiRecovery(null)
      await Promise.all([refreshFiles(), refreshSnapshots()])
      setNotice(`已恢复“${result.snapshot.label}”，恢复前状态已备份为 ${result.backup.id.slice(0, 19)}`)
    } catch (error) {
      setNotice(`恢复失败：${errorMessage(error)}`)
    } finally {
      setRestoringSnapshotId('')
    }
  }

  const deleteSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || deletingSnapshotId || building || planning || migrationBusy) return
    if (!window.confirm(`永久删除快照“${snapshot.label}”？\n\n删除后无法从 ModMind 恢复。`)) return
    setDeletingSnapshotId(snapshot.id)
    try {
      setSnapshots(await window.modmind.snapshots.delete(snapshot.id))
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

  const saveSettings = async (): Promise<void> => {
    try {
      const saved = await window.modmind.settings.saveAi(settings)
      setSettings(saved)
      setNotice('设置已保存')
    } catch (error) {
      setNotice(`配置保存失败：${errorMessage(error)}`)
    }
  }

  const selectCodingBackend = (backend: AiSettings['codingBackend']): void => {
    const next = { ...settings, codingBackend: backend }
    setSettings(next)
    void window.modmind.settings.saveAi(next).then(setSettings).catch((error) => {
      setNotice(`后端切换未保存：${errorMessage(error)}`)
    })
  }

  const launchExternalAgent = async (kind: 'codex' | 'claude' | 'opencode'): Promise<void> => {
    try {
      await window.modmind.externalAgents.launch(kind)
      setNotice(`${kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'opencode'} 已在项目目录启动`)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const installExternalAgent = async (kind: 'codex' | 'claude' | 'opencode'): Promise<void> => {
    setInstallingAgents((current) => ({ ...current, [kind]: true }))
    setNotice(`正在安装 ${kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'opencode'}…`)
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

  const openExternalAgentDocs = async (kind: 'codex' | 'claude' | 'opencode'): Promise<void> => {
    try {
      await window.modmind.externalAgents.openDocs(kind)
    } catch (error) {
      setNotice(`无法打开安装教程：${errorMessage(error)}`)
    }
  }

  const scanModels = async (): Promise<void> => {
    if (scanningModels || !settings.baseUrl.trim()) return
    setScanningModels(true)
    setModelScanMessage('正在读取可用模型…')
    try {
      const models = await window.modmind.settings.listModels(settings)
      setAvailableModels(models)
      setModelScanMessage(models.length ? `发现 ${models.length} 个模型` : '接口没有返回可用模型，可手动填写 ID')
      if (models.length === 1 && !settings.model) setSettings((current) => ({ ...current, model: models[0].id }))
    } catch (error) {
      setAvailableModels([])
      setModelScanMessage(errorMessage(error))
    } finally {
      setScanningModels(false)
    }
  }

  const latestEvent = events[0]
  const migrationVersions = loaderCatalog.filter((option) => option.loader === migrationLoader)
  const selectedMigrationVersion = migrationVersion || migrationVersions[0]?.minecraftVersion || ''
  const filteredModels = availableModels.filter((model) => model.id.toLowerCase().includes(modelSearch.trim().toLowerCase()))
  const filteredMappingMembers = mappingDetail?.members.filter((member) => {
    const query = mappingMemberQuery.trim().toLowerCase()
    return !query || `${member.type} ${Object.values(member.names).join(' ')}`.toLowerCase().includes(query)
  }) ?? []
  const navGroups = useMemo(
    () => [
      {
        label: '开发',
        items: [
          { id: 'workspace' as const, label: '工作台', icon: MessageSquareText },
          { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb },
          { id: 'blockbench' as const, label: 'Blockbench', icon: Box },
          { id: 'code' as const, label: '代码编辑', icon: Code2 },
          { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 },
          { id: 'build' as const, label: '构建', icon: Hammer }
        ]
      },
      {
        label: '交付',
        items: [
          { id: 'production' as const, label: '生产中心', icon: CloudUpload },
          { id: 'snapshots' as const, label: '版本', icon: History },
          { id: 'mappings' as const, label: 'Mappings', icon: LibraryBig },
          { id: 'settings' as const, label: '设置', icon: Settings }
        ]
      }
    ],
    []
  )

  return (
    <div className={`app-shell ${settings.darkMode ? 'dark-mode' : ''}`}>
      <header className="titlebar">
        <div className="titlebar-name"><img src={appLogo} alt="" />{projectLauncherOpen ? 'ModMind' : project?.name ?? 'ModMind'}</div>
        <div className="titlebar-actions">
          <button className="titlebar-icon" title="切换侧栏"><PanelLeft size={15} /></button>
          <button className="titlebar-icon" title="更多操作"><MoreHorizontal size={16} /></button>
          <span className="titlebar-divider" />
          <button className="window-control" title="最小化" onClick={() => void window.modmind.app.minimize()}><Minus size={15} /></button>
          <button className="window-control" title="最大化" onClick={() => void window.modmind.app.maximize()}><Square size={13} /></button>
          <button className="window-control close" title="关闭" onClick={() => void window.modmind.app.close()}><X size={16} /></button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="brand-row">
            <img className="brand-mark" src={appLogo} alt="ModMind" />
            <div><strong>ModMind</strong><span>AI Mod Workspace</span></div>
          </div>

          <nav className="sidebar-nav">
            {navGroups.map((group, index) => <div className="sidebar-nav-group" key={group.label}>
              <span className={`nav-caption ${index ? 'settings-caption' : ''}`}>{group.label}</span>
              {group.items.map((item) => (
                <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)} type="button">
                  <item.icon size={16} /><span>{item.label}</span>
                  {item.id === 'build' && latestEvent ? <i className={`status-dot ${latestEvent.status}`} /> : null}
                </button>
              ))}
            </div>)}
          </nav>

          <div className="sidebar-footer">
            {project ? (
              <button className="project-switcher" onClick={() => { setProjectLauncherOpen(true); setView('workspace'); void refreshRecentProjects() }}>
                <span className="project-cube"><Box size={16} /></span>
                <span><strong>{project.name}</strong><small>{project.loader} · {project.minecraftVersion}</small></span>
                <ChevronDown size={14} />
              </button>
            ) : (
              <button className="new-project-side" onClick={() => setShowCreate(true)}><Plus size={16} />新建项目</button>
            )}
          </div>
        </aside>

        {view !== 'settings' && (projectLauncherOpen || !project) ? (
          <ProjectLauncher
            projects={recentProjects}
            onCreate={() => setShowCreate(true)}
            onOpen={() => void openProject()}
            onAdopt={() => setExistingImportPicker(true)}
            onSelect={(recent) => void openRecentProject(recent)}
            onRemove={(recent) => void removeRecentProject(recent)}
          />
        ) : (
          <main className="main-content">
            {view === 'workspace' && project ? (
              <>
                <div className="content-toolbar">
                  <div><h1>{project.name}</h1><p>{project.loader} · Minecraft {project.minecraftVersion}</p></div>
                  <div className="toolbar-actions">
                    <button className="secondary-button" onClick={() => void createSnapshot()}><History size={16} />保存版本</button>
                    <button className="primary-button" disabled={building || planning} onClick={() => void runPreflight()}>
                      {building ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}一键构建
                    </button>
                  </div>
                </div>

                <div className="workspace-grid">
                  <section className="idea-section">
                    <div className="section-heading">
                      <div><Sparkles size={18} /><div><h2>描述你想要的 Mod</h2><p>AI 将读取现有工程，直接创建或修改代码与资源文件。</p></div></div>
                      <div className="backend-switch" role="tablist" aria-label="Coding backend">
                        <button type="button" className={settings.codingBackend === 'internal' ? 'active' : ''} onClick={() => selectCodingBackend('internal')}><Bot size={13} />内部 AI</button>
                        <button type="button" className={settings.codingBackend === 'codex' ? 'active' : ''} onClick={() => selectCodingBackend('codex')}><TerminalSquare size={13} />Codex</button>
                        <button type="button" className={settings.codingBackend === 'claude' ? 'active' : ''} onClick={() => selectCodingBackend('claude')}><Sparkles size={13} />Claude Code</button>
                        <button type="button" className={settings.codingBackend === 'opencode' ? 'active' : ''} onClick={() => selectCodingBackend('opencode')}><TerminalSquare size={13} />opencode</button>
                      </div>
                    </div>
                    <div className="prompt-box">
                      <textarea
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder="例如：制作一个可以储存经验值的水晶方块，右键存入，Shift 右键取出……"
                      />
                      <div className="prompt-footer">
                         <div className="prompt-meta"><span>{settings.codingBackend === 'internal' ? (settings.model || '尚未选择模型') : settings.codingBackend === 'codex' ? 'Codex CLI · ModMind MCP' : settings.codingBackend === 'claude' ? 'Claude Code · ModMind MCP' : 'opencode · ModMind MCP'}</span><span>并发 {settings.parallelism}</span></div>
                        {planning ? <button className="secondary-button" title="停止 AI 编程" onClick={() => void window.modmind.ai.cancelCode()}><X size={16} />停止 AI</button> : <button className="send-button" title="开始 AI 编程" disabled={!prompt.trim()} onClick={() => void captureIdea()}><Send size={17} /><span>开始开发</span></button>}
                      </div>
                    </div>
                    <div className="suggestions">
                      <button onClick={() => setPrompt('添加一种新的矿石、矿物方块和对应工具套装')}>矿石与工具</button>
                      <button onClick={() => setPrompt('制作一个右键打开界面的经验储存方块')}>功能方块</button>
                      <button onClick={() => setPrompt('添加一种拥有特殊攻击效果的武器')}>特殊武器</button>
                    </div>
                  </section>

                  <aside className="project-inspector">
                    <h2>项目概览</h2>
                    <dl>
                      <div><dt>命名空间</dt><dd>{project.namespace}</dd></div>
                      <div><dt>加载器</dt><dd>{project.loader}</dd></div>
                      <div><dt>游戏版本</dt><dd>{project.minecraftVersion}</dd></div>
                      <div><dt>构建方式</dt><dd>托管 Gradle</dd></div>
                    </dl>
                    <div className="adapter-note"><TerminalSquare size={16} /><p><strong>零环境构建</strong><span>按需下载 Java 与 Gradle，构建结果自动同步到测试实例。</span></p></div>
                  </aside>
                </div>

                <div className="ai-output-layout">
                <section className="ai-output-section">
                  <div className="ai-output-heading">
                    <div><h2>AI 输出</h2><span className={`ai-output-status ${aiOutputStatus}`}>{aiOutputStatus === 'running' ? '生成中' : aiOutputStatus === 'success' ? '已应用' : aiOutputStatus === 'error' ? '需要检查' : '等待任务'}</span></div>
                    <button className="icon-button" title="复制 AI 输出" onClick={() => void navigator.clipboard.writeText(aiOutput)}><Copy size={14} /></button>
                  </div>
                  <div className="ai-timeline">{aiTimeline.length ? aiTimeline.map((item) => {
                    const label = timelineLabel(item.kind)
                    const icon = item.kind === 'tool' ? <TerminalSquare size={11} /> : item.kind === 'diff' ? <FileCode2 size={11} /> : item.kind === 'history' ? <History size={11} /> : item.kind === 'start' ? <Play size={11} /> : item.kind === 'retry' ? <RotateCcw size={11} /> : <CircleAlert size={11} />
                    return <article className={`ai-timeline-item ${item.kind}`} key={item.id}>{label ? <div className="ai-output-event-header"><span className="ai-output-event-badge">{icon}{label}</span></div> : null}{item.kind === 'answer' || item.kind === 'response' ? <MarkdownMessage content={item.content} /> : <p>{item.content}</p>}{item.diff ? <div className="code-diff-list">{item.diff.map((file) => <div className="code-diff-file" key={file.path}><strong>{file.path}</strong><span className="diff-count">+{file.added} / -{file.removed}</span>{file.additions.map((line, index) => <code className="diff-add" key={`a-${index}`}>+ {line || ' '}</code>)}{file.removals.map((line, index) => <code className="diff-remove" key={`r-${index}`}>- {line || ' '}</code>)}</div>)}</div> : null}</article>
                  }) : <div className="ai-timeline-empty">AI 的工作过程会显示在这里。</div>}</div>
                </section>
                <aside className="ai-todo-section">
                  <div className="ai-todo-heading"><div><Check size={15} /><h2>Todo List</h2></div><span>{aiTodo.length ? `${aiTodo.filter((item) => item.status === 'completed').length}/${aiTodo.length}` : '—'}</span></div>
                  {aiTodo.length ? <ol className="ai-todo-list">{aiTodo.map((item) => <li className={item.status} key={item.id}><span className="ai-todo-check">{item.status === 'completed' ? <Check size={12} /> : item.status === 'in_progress' ? <LoaderCircle className="spin" size={12} /> : null}</span><div><strong>{item.title}</strong><small>{item.status === 'completed' ? '已完成' : item.status === 'in_progress' ? '进行中' : '待处理'}</small></div></li>)}</ol> : <div className="ai-todo-empty">AI 制定计划后会显示在这里</div>}
                </aside>
                </div>

                {aiPlan ? (
                  <section className="plan-summary">
                    <div className="section-title-row"><h2>本次 AI 修改</h2><span>{aiPlan.files.length} 个文件</span></div>
                    <p>{aiPlan.summary}</p>
                    <ol>{aiPlan.tasks.slice(0, 5).map((task) => <li key={task}>{task}</li>)}</ol>
                    <div className="ai-result-grid">
                      <div><strong>已修改文件</strong>{aiPlan.files.length ? <ul>{aiPlan.files.slice(0, 12).map((file) => <li key={file.path}><code>{file.path}</code><span>{file.purpose}</span></li>)}</ul> : <p>没有记录到文件修改</p>}</div>
                      <div><strong>自动验收范围</strong><p>已执行 Gradle 构建、资源/注册引用检查，以及需要时的 Minecraft 启动检查。</p>{aiPlan.tests.length ? <ul>{aiPlan.tests.slice(0, 8).map((test) => <li key={test}>{test}</li>)}</ul> : null}{aiPlan.warnings.length ? <ul className="ai-result-warnings">{aiPlan.warnings.slice(0, 8).map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}<p className="ai-manual-check">实际玩法、按键、数值和平衡仍需进入游戏手动确认。</p></div>
                    </div>
                  </section>
                ) : null}

                <section className="activity-section">
                  <div className="section-title-row"><h2>最近活动</h2><button onClick={() => setView('build')}>查看全部</button></div>
                  {events.length ? (
                    <div className="activity-list">
                      {events.slice(0, 4).map((event) => (
                        <div className="activity-row" key={event.id}>
                          <span className={`activity-icon ${event.status}`}>
                            {event.status === 'success' ? <Check size={14} /> : event.status === 'error' ? <X size={14} /> : <LoaderCircle className="spin" size={14} />}
                          </span>
                          <div><strong>{humanizeActivity(event.title)}</strong><p>{humanizeActivity(event.detail)}</p></div>
                          <time>{formatTime(event.time)}</time>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-activity"><Clock3 size={18} />需求、文件修改和构建事件会显示在这里。</div>
                  )}
                </section>
              </>
            ) : null}

            {project ? <InspirationWorkspace key={project.path} project={project} visible={view === 'inspiration'} onSendToCoding={(codingPrompt) => { setPrompt(codingPrompt); setView('workspace'); setNotice('已发送到工作台，请确认后开始开发') }} /> : null}

            {view === 'blockbench' && project ? (
              <div className="blockbench-page">
                <BlockbenchWorkspace visible />
              </div>
            ) : null}

            {view === 'minecraft' && project ? <MinecraftTestWorkspace /> : null}

            {view === 'mappings' && project ? (
              <div className="mappings-page">
                <div className="content-toolbar">
                  <div><h1>Minecraft Mappings</h1><p>查询 {project.minecraftVersion} 的 Mojang、Yarn、Intermediary 与其他映射。</p></div>
                  <div className="toolbar-actions">
                    <button className="mapping-source-link" onClick={() => void window.modmind.mappings.openLoaderDocs(project.loader)}><ExternalLink size={13} />{project.loader === 'fabric' ? 'Fabric' : project.loader === 'quilt' ? 'Quilt' : project.loader === 'forge' ? 'Forge' : 'NeoForge'} 文档</button>
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
                    ) : <div className="mapping-detail-empty"><LibraryBig size={30} /><h2>选择一个类查看完整映射</h2><p>结果包含字段、构造器、方法签名及各命名空间名称。</p></div>}
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
                      <button className="icon-button" title="在文件管理器中显示" disabled={!selectedFile} onClick={() => void window.modmind.project.reveal(selectedFile)}><FolderOpen size={14} /></button>
                      <button className="secondary-button compact" title="使用 Java LSP 与调试器打开完整项目" onClick={() => void window.modmind.project.openIde().catch((error) => window.alert(errorMessage(error)))}><ExternalLink size={14} />Java IDE</button>
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
                    <div className="editor-empty"><File size={28} /><p>该文件不是可编辑文本，可在文件管理器中查看。</p></div>
                  ) : (
                    <div className="editor-empty"><FileCode2 size={28} /><p>从左侧文件树中选择源码或配置文件。</p></div>
                  )}
                </section>
              </div>
            ) : null}

            {view === 'build' && project ? (
              <div className="standard-page">
                  <div className="content-toolbar">
                    <div><h1>构建与测试</h1><p>使用托管 Java 与 Gradle 生成可运行的 Mod JAR。</p></div>
                    <div className="toolbar-actions">
                      <button className="secondary-button" disabled={building || planning || !buildResult?.success} onClick={() => void exportArtifact()}><Download size={16} />导出 Mod JAR</button>
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
                  <div className={`build-state ${buildResult?.success ? 'success' : buildError || buildResult ? 'error' : ''}`}>
                    {building ? <LoaderCircle className="spin" size={22} /> : buildResult?.success ? <Check size={22} /> : buildError || buildResult ? <X size={22} /> : <Hammer size={22} />}
                    <div><strong>{building ? minecraftEvents.at(-1)?.message || '正在准备构建环境' : buildError ? buildResult && !buildResult.success ? '构建未通过' : '构建失败' : buildResult?.summary || '等待运行'}</strong><span>{buildError ? '错误详情已保留在下方输出中' : buildResult?.reportPath || '尚未生成预检报告'}</span></div>
                  </div>
                  <div className="build-metrics"><span><strong>{buildResult?.logs.filter((line) => line.startsWith('PASS')).length ?? 0}</strong>通过</span><span><strong>{buildResult?.logs.filter((line) => line.startsWith('FAIL')).length ?? 0}</strong>失败</span></div>
                </section>
                <section className="log-section">
                  <div className="section-title-row"><h2>输出</h2><span>Preflight</span></div>
                  <pre>{buildResult?.logs.join('\n') || [
                    ...minecraftEvents.map((event) => `[${formatTime(event.time)}] ${event.message}`),
                    ...(buildError ? ['', buildError] : [])
                  ].join('\n') || '点击“构建项目”下载所需运行时并执行 Gradle build。'}</pre>
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
                  <div><h1>版本与迁移</h1><p>{project.loader} · Minecraft {project.minecraftVersion}</p></div>
                  <button className="primary-button" onClick={() => void createSnapshot()}><Plus size={16} />创建快照</button>
                </div>
                <section className="migration-band">
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
                </section>
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
                  )) : <div className="large-empty"><History size={26} /><h3>还没有版本快照</h3><p>创建快照后，项目文件会保存在项目内的 {project.toolDataDirectory ?? '.modmind'} 目录。</p></div>}
                </div>
              </div>
            ) : null}

            {view === 'production' && project ? (
              <ProductionWorkspace project={project} onFilesChanged={() => { void refreshFiles(); void refreshSnapshots() }} />
            ) : null}

            {view === 'settings' ? (
              <div className="settings-page">
                <div className="content-toolbar"><div><h1>设置</h1><p>配置 AI Provider 和任务执行方式。</p></div></div>
                <section className="settings-section">
                  <div className="settings-heading"><h2>AI 服务</h2><p>兼容 OpenAI 协议的 API 可以使用自定义地址。</p></div>
                  <div className="external-agent-section">
                    <div className="settings-heading"><h3>外部 Coding Agent</h3><p>Codex、Claude Code 和 opencode 通过 ModMind MCP 接入项目文件、映射、构建、游戏测试和 Blockbench。</p></div>
                    <div className="external-agent-grid">
                      {(['codex', 'claude', 'opencode'] as const).map((kind) => {
                        const status = externalAgents.find((item) => item.kind === kind)
                        const kindLabel = kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'opencode'
                        const pathKey = kind === 'codex' ? 'codexExecutable' : kind === 'claude' ? 'claudeExecutable' : 'opencodeExecutable'
                        const configuredPath = settings[pathKey] ?? ''
                        return <article className="external-agent-card" key={kind}>
                          <div className="external-agent-card-heading"><div><strong>{kindLabel}</strong><small>{status?.installed ? status.version : externalAgentsReady ? '未检测到 CLI' : '正在检测…'}</small></div><span className={`status-dot ${status?.installed ? 'success' : 'warning'}`} /></div>
                          <input value={configuredPath} onChange={(event) => setSettings({ ...settings, [pathKey]: event.target.value })} placeholder={status?.executable || '留空则从 PATH 查找'} />
                          <div className="external-agent-actions">
                            {status?.installed || configuredPath.trim() ? <button className="secondary-button compact" type="button" onClick={() => void launchExternalAgent(kind)}><TerminalSquare size={14} />打开</button> : <button className="primary-button compact" type="button" disabled={!externalAgentsReady || installingAgents[kind]} onClick={() => void installExternalAgent(kind)}>{installingAgents[kind] ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}一键安装</button>}
                            <button className="secondary-button compact" type="button" onClick={() => void openExternalAgentDocs(kind)}><ExternalLink size={14} />B站安装教程</button>
                          </div>
                        </article>
                      })}
                    </div>
                  </div>
                  <div className="settings-form">
                    <label className="field-label">Provider<select value={settings.provider} onChange={(event) => { setSettings({ ...settings, provider: event.target.value as AiSettings['provider'] }); setAvailableModels([]) }}><option value="openai-compatible">OpenAI Compatible</option><option value="openai">OpenAI</option><option value="local">本地模型</option></select></label>
                    <label className="field-label">Base URL<input value={settings.baseUrl} onChange={(event) => { setSettings({ ...settings, baseUrl: event.target.value }); setAvailableModels([]) }} onBlur={() => { if (settings.provider === 'local' || settings.apiKey.trim() || settings.hasStoredKey) void scanModels() }} /></label>
                    <label className="field-label">API Key<input type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} onBlur={() => { if (settings.apiKey.trim()) void scanModels() }} placeholder={settings.hasStoredKey ? '已安全保存，留空则保持不变' : '输入 API Key'} /></label>
                    <label className="field-label">并发任务数<div className="stepper"><button onClick={() => setSettings({ ...settings, parallelism: Math.max(1, settings.parallelism - 1) })}>−</button><span>{settings.parallelism}</span><button onClick={() => setSettings({ ...settings, parallelism: Math.min(8, settings.parallelism + 1) })}>+</button></div></label>
                    <label className="field-label">AI Agent 最大轮数<select value={settings.agentMaxSteps === 0 ? 'unlimited' : String(settings.agentMaxSteps)} onChange={(event) => setSettings({ ...settings, agentMaxSteps: event.target.value === 'unlimited' ? 0 : Number(event.target.value) })}><option value="unlimited">自适应</option><option value="12">12 轮</option><option value="24">24 轮</option><option value="48">48 轮</option><option value="96">96 轮</option></select><small>自适应模式不会按固定轮数截断；连续 8 轮没有进展时才会停止。</small></label>
                    <label className="field-label">最大构建次数<select value={settings.maxBuilds === 0 ? 'unlimited' : String(settings.maxBuilds)} onChange={(event) => setSettings({ ...settings, maxBuilds: event.target.value === 'unlimited' ? 0 : Number(event.target.value) })}><option value="unlimited">无限制</option><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option><option value="5">5 次</option><option value="10">10 次</option></select><small>Todo 全部完成前不会启动构建；默认不限制构建次数。</small></label>
                    <div className="model-picker-field">
                      <div className="model-picker-heading"><span>可用模型</span><button type="button" disabled={scanningModels} onClick={() => void scanModels()}>{scanningModels ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}扫描模型</button></div>
                      {availableModels.length > 8 ? <input className="model-search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="搜索模型" /> : null}
                      <div className="model-options">
                        {filteredModels.map((model) => (
                          <label key={model.id} className={settings.model === model.id ? 'selected' : ''}><input type="radio" name="ai-model" checked={settings.model === model.id} onChange={() => setSettings({ ...settings, model: model.id })} /><span><strong>{model.id}</strong>{model.ownedBy ? <small>{model.ownedBy}</small> : null}</span></label>
                        ))}
                        {!filteredModels.length ? <p>{modelScanMessage}</p> : null}
                      </div>
                      <label className="manual-model-field">手动模型 ID<input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder="扫描不可用时手动填写" /></label>
                    </div>
                  </div>
                  <div className="settings-actions"><span><ShieldCheck size={15} />API Key 使用系统级加密存储</span><button className="primary-button" onClick={() => void saveSettings()}><Save size={16} />保存设置</button></div>
                </section>
                <section className="settings-section">
                  <div className="settings-heading"><h2>构建工具</h2><p>新项目仍保留官方 Gradle Wrapper；开启后，构建优先使用你机器上的 Gradle。</p></div>
                  <label className="field-label">Gradle 下载源<select value={settings.gradleDownloadSource} onChange={(event) => setSettings({ ...settings, gradleDownloadSource: event.target.value as AiSettings['gradleDownloadSource'] })}><option value="auto">自动择优（推荐）</option><option value="china">国内镜像优先</option><option value="official">仅官方源</option></select><small>自动模式会探测华为云、腾讯云和官方源，下载后仍按官方 SHA-256 校验。</small></label>
                  <div className="appearance-row"><div><strong>优先使用本机 Gradle</strong><p>允许使用 PATH 或下方路径中的任意版本，版本兼容性由你自行确认。</p></div><button className={`toggle ${settings.preferLocalGradle ? 'on' : ''}`} type="button" role="switch" aria-checked={settings.preferLocalGradle} onClick={() => setSettings({ ...settings, preferLocalGradle: !settings.preferLocalGradle })}><span /></button></div>
                  <label className="field-label">Gradle 可执行文件路径<input value={settings.gradleExecutable ?? ''} onChange={(event) => setSettings({ ...settings, gradleExecutable: event.target.value })} placeholder="留空则从 PATH 查找 gradle" /></label>
                  <div className="settings-actions"><span>关闭开关时始终优先使用项目 Wrapper 或 ModMind 托管版本</span><button className="primary-button" onClick={() => void saveSettings()}><Save size={16} />保存设置</button></div>
                </section>
                <section className="settings-section">
                  <div className="settings-heading"><h2>外观</h2><p>调整 ModMind 的显示方式。</p></div>
                  <div className="appearance-row"><div><strong>深色模式</strong><p>使用深色界面降低夜间使用时的亮度。</p></div><button className={`toggle ${settings.darkMode ? 'on' : ''}`} type="button" role="switch" aria-checked={settings.darkMode} onClick={() => setSettings({ ...settings, darkMode: !settings.darkMode })}><span /></button></div>
                  <div className="settings-actions"><span>修改外观后点击保存设置以记住选择</span></div>
                </section>
                <section className="settings-section disabled-section">
                  <div className="settings-heading"><h2>远程构建</h2><p>构建服务协议将在下一阶段接入。</p></div>
                  <div className="connection-row"><span className="status-dot warning" /><div><strong>未配置</strong><p>当前仅执行本地工程预检。</p></div><button className="secondary-button" disabled>配置服务</button></div>
                </section>
              </div>
            ) : null}
          </main>
        )}
      </div>

      {showCreate ? <CreateProjectDialog onClose={() => setShowCreate(false)} onCreated={(created) => { setProject(created); setShowCreate(false); setProjectLauncherOpen(false); setView('workspace'); void refreshRecentProjects() }} /> : null}
      {existingImportPicker ? <ExistingImportPicker onClose={() => setExistingImportPicker(false)} onSelect={(sourceType) => { setExistingImportPicker(false); void inspectExistingProject(sourceType) }} /> : null}
      {existingAnalysis ? <AdoptProjectDialog analysis={existingAnalysis} onClose={() => setExistingAnalysis(null)} onAdopted={(adopted) => { setExistingAnalysis(null); setProject(adopted); setProjectLauncherOpen(false); setView('workspace'); void refreshRecentProjects() }} /> : null}
      {aiRecovery ? <div className="modal-backdrop"><div className="dialog recovery-dialog" role="dialog" aria-modal="true"><div className="dialog-header"><div><h2>发现未完成的 AI 任务</h2><p>任务的计划、会话和修改进度已保存。</p></div><CircleAlert size={21} /></div><p className="recovery-copy">可以从中断点继续，也可以精确恢复到 AI 修改前状态。恢复前会自动备份当前半成品。</p><div className="dialog-footer"><button className="secondary-button" disabled={recoveryBusy} onClick={() => void restoreInterruptedAi()}><RotateCcw size={16} />恢复修改前状态</button>{recoveryBusy ? <button className="secondary-button" onClick={() => void window.modmind.ai.cancelCode()}><X size={16} />停止恢复</button> : null}<button className="primary-button" disabled={recoveryBusy} onClick={() => void resumeInterruptedAi()}>{recoveryBusy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}继续 AI 任务</button></div></div></div> : null}
      {buildTrustRequest ? <div className="modal-backdrop"><div className="dialog recovery-dialog" role="dialog" aria-modal="true"><div className="dialog-header"><div><h2>确认执行构建脚本</h2><p>{buildTrustRequest.projectName}</p></div><ShieldCheck size={21} /></div><p className="recovery-copy">Gradle 构建脚本能够以当前 Windows 用户权限执行程序、访问网络和读写文件。脚本内容发生变化后，ModMind 会重新询问。</p><code>{buildTrustRequest.projectPath}</code><div className="dialog-footer"><button className="secondary-button" onClick={() => { void window.modmind.build.respondTrust(buildTrustRequest.id, false); setBuildTrustRequest(null) }}>取消构建</button><button className="primary-button" onClick={() => { void window.modmind.build.respondTrust(buildTrustRequest.id, true); setBuildTrustRequest(null) }}><ShieldCheck size={16} />信任并构建</button></div></div></div> : null}
      {notice ? <div className="toast">{notice}</div> : null}
    </div>
  )
}
