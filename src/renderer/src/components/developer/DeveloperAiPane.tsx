import { useEffect, useRef, useState } from 'react'
import AgentWorkbench from '../AgentWorkbench'
import type { DeveloperConversation, DeveloperProject } from '../../../../shared/developerWorkbench'
import type { AgentSettings, AiModelInfo, BeginnerAiPreferences, DeviceConnectionState, ProjectInfo } from '../../../../shared/types'
import type { CatalogProvider } from '../ModelCatalogRows'
import type { AiModelSelection } from '../../../../shared/aiSelection'
import { appendUserTurn, reduceWorkbenchOutput, settleWorkbenchActivity, type WorkbenchTimelineItem } from '../../workbenchTimeline'
import { useConfirmDialog, usePromptDialog } from '../InteractionDialogs'

export interface DeveloperAiProps {
  settings: AgentSettings
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  providers?: CatalogProvider[]
  deviceState: DeviceConnectionState
  onOpenAccount: () => void
  onRefreshModels: () => void
}
const fresh = (): DeveloperConversation => ({ id: crypto.randomUUID(), title: '新对话', prompt: '', timeline: [], updatedAt: new Date().toISOString() })

export default function DeveloperAiPane({ project, ai, beforeRun, afterRun, onRunningChange, onError, onShowLog, onOpenFile }: {
  project: DeveloperProject; ai: DeveloperAiProps; beforeRun: () => Promise<void>; afterRun: () => Promise<void>
  onRunningChange: (running: boolean) => void; onError: (error: unknown) => void; onShowLog: () => void; onOpenFile: (file: string) => void
}): React.JSX.Element {
  const [conversations, setConversations] = useState<DeveloperConversation[]>([])
  const [active, setActive] = useState('')
  const [history, setHistory] = useState<'loading' | 'ready' | 'error'>('loading')
  const [persist, setPersist] = useState<'ready' | 'saving' | 'error'>('ready')
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState<string>()
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [backend, setBackend] = useState(ai.settings.codingBackend)
  const [selection, setSelection] = useState<AiModelSelection>(ai.settings.codingBackend === 'quota' ? ai.preferences : { model: ai.settings.externalAgents?.codex?.model ?? '', reasoningLevel: ai.settings.externalAgents?.codex?.reasoningEffort ?? 'auto' })
  const live = useRef({ conversations, active, running }); live.current = { conversations, active, running }
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const { prompt: requestPrompt, dialog: promptDialog } = usePromptDialog()
  const change = (id: string, update: (value: DeveloperConversation) => DeveloperConversation): void => setConversations(items => items.map(item => item.id === id ? update(item) : item))
  const load = async (): Promise<void> => {
    setHistory('loading')
    try {
      const items = await window.modmind.developer.conversations(project.session)
      const restored = items.map(item => ({ ...item, timeline: settleWorkbenchActivity(item.timeline as WorkbenchTimelineItem[]) }))
      const first = restored[0] ?? fresh()
      setConversations(restored.length ? restored : [first]); setActive(first.id); setHistory('ready')
    } catch (error) { setHistory('error'); onError(error) }
  }
  useEffect(() => { void load() }, [project.session])
  useEffect(() => window.modmind.developer.onAi(value => {
    if (value.session !== project.session) return
    change(value.conversationId, item => ({ ...item, timeline: reduceWorkbenchOutput(item.timeline as WorkbenchTimelineItem[], value.event), updatedAt: new Date().toISOString() }))
  }), [project.session])
  useEffect(() => {
    if (history !== 'ready' || !active) return
    const current = conversations.find(item => item.id === active)
    if (!current) return
    const timeout = setTimeout(() => {
      setPersist('saving')
      void window.modmind.developer.saveConversation(project.session, current).then(() => setPersist('ready')).catch(error => { setPersist('error'); onError(error) })
    }, 200)
    return () => clearTimeout(timeout)
  }, [conversations, active, history, project.session])
  useEffect(() => () => {
    const current = live.current.conversations.find(item => item.id === live.current.active)
    if (current) void window.modmind.developer.saveConversation(project.session, current).catch(() => undefined)
    if (live.current.running) void window.modmind.developer.stopAi(project.session)
  }, [project.session])
  const current = conversations.find(item => item.id === active)
  const start = async (): Promise<void> => {
    if (running || !current?.prompt.trim() || history !== 'ready') return
    try {
      await beforeRun()
      const message = current.prompt.trim(), time = new Date().toISOString()
      const updated = { ...current, title: current.title === '新对话' ? message.slice(0, 36) : current.title, prompt: '', timeline: appendUserTurn(current.timeline as WorkbenchTimelineItem[], message, crypto.randomUUID()), updatedAt: time }
      change(active, () => updated)
      await window.modmind.developer.saveConversation(project.session, updated)
      setRunning(true); onRunningChange(true); setStarted(time); setStatus('running')
      await window.modmind.developer.runAi(project.session, active, message, backend, selection.model ? selection : undefined)
      setStatus('success')
    } catch (error) { setStatus('error'); change(active, value => ({ ...value, prompt: value.prompt || current.prompt })); onError(error) }
    finally { setRunning(false); onRunningChange(false); await afterRun().catch(onError) }
  }
  const newConversation = async (): Promise<void> => {
    if (running) return
    if (current) await window.modmind.developer.saveConversation(project.session, current)
    const value = fresh(); setConversations(items => [value, ...items]); setActive(value.id); setStatus('idle')
  }
  const metadata: ProjectInfo = { name: project.name, path: project.root, kind: 'developer', loader: 'extension', minecraftVersion: '1', namespace: project.id, createdAt: project.createdAt }
  return <>
    <AgentWorkbench independent project={metadata} uiMode="advanced" presentation="full" modpack={false}
      prompt={current?.prompt ?? ''} setPrompt={prompt => change(active, item => ({ ...item, prompt }))}
      attachments={[]} setAttachments={() => undefined} planning={running} taskState={running ? 'working' : status === 'success' ? 'success' : status === 'error' ? 'error' : 'idle'}
      aiPlan={null} aiTodo={[]} aiTimeline={(current?.timeline ?? []) as WorkbenchTimelineItem[]} processingStartedAt={started} aiOutputStatus={status} aiRecovery={null}
      conversations={conversations.map(item => ({ id: item.id, title: item.title, pinned: item.pinned, createdAt: item.updatedAt, updatedAt: item.updatedAt, sessionScope: 'developer/' + item.id }))}
      activeConversationId={active} onSelectConversation={id => { if (!running) { setActive(id); setStatus('idle') } }} onNewConversation={() => void newConversation().catch(onError)}
      onDeleteConversation={id => { void (async () => {
        if (running || !await confirm({ title: '删除开发对话', message: '删除这段对话，工程文件会保留。', confirmLabel: '删除对话' })) return
        await window.modmind.developer.deleteConversation(project.session, id)
        const remaining = live.current.conversations.filter(item => item.id !== id)
        if (!remaining.length) remaining.push(fresh())
        setConversations(remaining); if (active === id) setActive(remaining[0].id)
      })().catch(onError) }}
      onRenameConversation={id => { void (async () => {
        const item = conversations.find(item => item.id === id)
        const value = await requestPrompt({ title: '重命名对话', message: '对话名称', value: item?.title ?? '' })
        if (value?.trim()) change(id, item => ({ ...item, title: value.trim() }))
      })().catch(onError) }} onTogglePinConversation={id => change(id, item => ({ ...item, pinned: !item.pinned }))}
      persistenceState={persist} persistenceMessage={persist === 'error' ? '对话保存失败，请重试' : undefined} historyState={history} onRetryHistory={() => void load()}
      backend={backend} onBackendChange={value => { setBackend(value); setSelection(value === 'quota' ? ai.preferences : { model: ai.settings.externalAgents?.codex?.model ?? '', reasoningLevel: ai.settings.externalAgents?.codex?.reasoningEffort ?? 'auto' }) }}
      onStart={() => void start()} workbenchFeatures={{ headlessTesting: false, renderedTesting: false, imageGeneration: false, modeling: false }} onWorkbenchFeaturesChange={() => undefined}
      onCancel={() => { void window.modmind.developer.stopAi(project.session).catch(onError) }} onResume={() => void start()} onDismissRecovery={() => undefined}
      onRename={() => undefined} onSnapshot={() => undefined} onExport={() => undefined} onExportServerPack={() => undefined} onExportLogs={onShowLog} onTest={onShowLog} onAttachmentError={onError}
      canExportArtifact={false} building={false} deviceState={ai.deviceState} onOpenAccount={ai.onOpenAccount}
      beginnerAiPreferences={{ ...ai.preferences, ...selection }} beginnerAvailableModels={backend === 'quota' ? ai.models : []} beginnerModelProviders={backend === 'quota' ? ai.providers : undefined}
      onScanBeginnerModels={ai.onRefreshModels} onModelChange={(model, option) => setSelection(value => ({ ...value, model, ...(option ?? {}) }))}
      onReasoningLevelChange={reasoningLevel => setSelection(value => ({ ...value, reasoningLevel }))}
      placeholder="描述要制作的功能、工作台或界面修改…" humanizeActivity={value => value} onOpenChangedFile={onOpenFile}
      emptyState={<div className="developer-ai-empty"><strong>从一个具体需求开始</strong><p>AI 可以修改源码、预览界面并调试当前开发包。</p><button type="button" className="secondary-button" onClick={() => change(active, item => ({ ...item, prompt: project.kind === 'studio' ? '把这个文稿工作台改成支持标题和分类的笔记工作台。完成后检查创建模板、UI 和 MCP 工具。' : '为当前文本工具添加字数统计和一键清空，保持界面简洁，并验证 UI、动作和 MCP。' }))}>完善当前示例</button></div>}
    />
    {confirmDialog}{promptDialog}
  </>
}
