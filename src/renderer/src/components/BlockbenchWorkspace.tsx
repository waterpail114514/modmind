import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  Box,
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  Grid3X3,
  LoaderCircle,
  Maximize,
  Paintbrush,
  Pin,
  PinOff,
  Play,
  History,
  RotateCcw,
  Redo2,
  Save,
  Sparkles,
  WandSparkles,
  X,
  Undo2
} from 'lucide-react'
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from '../useMediaQuery'
import type { AssetIntentPreview, AssetIntentProgram, AssetRefinementPreview, AssetRefinementProgram } from '../../../shared/assetIntent'
import type {AdvancedAssetCandidatePreview, AdvancedAssetComparison, AdvancedAssetProgram, ReferenceImageAssetProgram} from '../../../shared/advancedAsset'
import type {BlockbenchHistoryEntry, BlockbenchProjectState} from '../../../shared/blockbench'
import type {PipelineEvent} from '../../../shared/types'
import '../blockbench.css'

type BlockbenchBounds = {
  x: number
  y: number
  width: number
  height: number
}

type BlockbenchStatePayload = {
  status?: string
  connected?: boolean
  dirty?: boolean
  projectName?: string
  fileName?: string
  message?: string
  aiActive?: boolean
  aiAction?: string
  ai?: {
    active?: boolean
    action?: string
    message?: string
  }
}

type BlockbenchBridge = {
  show: (bounds: BlockbenchBounds) => Promise<void> | void
  hide: () => Promise<void> | void
  openProject: () => Promise<unknown>
  saveProject: () => Promise<unknown>
  setTheme: (theme: 'light' | 'dark') => Promise<unknown>
  runAction: (action: string) => Promise<unknown>
  projectState: () => Promise<BlockbenchProjectState>
  assetIntent: {
    preview: (intent: AssetIntentProgram, request?: Record<string, unknown>, expectedRevision?: string) => Promise<unknown>
    apply: (intent: AssetIntentProgram, expectedRevision?: string) => Promise<unknown>
  }
  assetRefinement: {
    preview: (refinement: AssetRefinementProgram, request?: Record<string, unknown>, expectedRevision?: string) => Promise<unknown>
    apply: (refinement: AssetRefinementProgram, expectedRevision?: string) => Promise<unknown>
  }
  advancedAsset: {
    preview: (program: AdvancedAssetProgram, request?: Record<string, unknown>, options?: Record<string, unknown>, expectedRevision?: string) => Promise<AdvancedAssetComparison>
    apply: (program: AdvancedAssetProgram, variantId?: string, expectedRevision?: string) => Promise<unknown>
  }
  referenceAsset: {
    preview: (program: ReferenceImageAssetProgram, request?: Record<string, unknown>, expectedRevision?: string) => Promise<AdvancedAssetCandidatePreview>
    apply: (program: ReferenceImageAssetProgram, expectedRevision?: string) => Promise<unknown>
  }
  history: () => Promise<BlockbenchHistoryEntry[]>
  createCheckpoint: (label?: string) => Promise<BlockbenchHistoryEntry>
  restoreHistory: (id: string) => Promise<unknown>
  saveAssetBundle: (request: Record<string, unknown>) => Promise<unknown>
  onState: (listener: (state: BlockbenchStatePayload) => void) => () => void
}

type WorkspaceState = {
  status: string
  connected: boolean
  dirty: boolean
  projectName: string
  message: string
  aiActive: boolean
  aiAction: string
}

export type BlockbenchWorkspaceProps = {
  visible?: boolean
  darkMode?: boolean
  project?: {namespace?: string}
  suppressed?: boolean
}

const initialState: WorkspaceState = {
  status: 'loading',
  connected: false,
  dirty: false,
  projectName: '未命名模型',
  message: '正在启动 Blockbench',
  aiActive: false,
  aiAction: ''
}

const defaultIntent: AssetIntentProgram = {
  version: 1,
  metadata: {name: 'Ember Raven', quality: 'hero', domain: 'organism'},
  model: {
    format: 'modded_entity', textureWidth: 64, textureHeight: 64, symmetry: 'bilateral',
    parts: [
      {id: 'body', kind: 'body', size: [8, 10, 6], offset: [0, 8, 0]},
      {id: 'head', kind: 'head', parent: 'body', size: [6, 6, 6], offset: [0, 17, -1]},
      {id: 'wing', kind: 'wing', parent: 'body', side: 'left', size: [2, 7, 8], offset: [6, 9, 0]},
      {id: 'tail', kind: 'tail', parent: 'body', size: [4, 4, 8], offset: [0, 6, 7]}
    ]
  },
  appearance: {palette: 'ember', texture: 'mottle', seed: 'raven-1'},
  animation: {name: 'idle', length: 1, loop: 'loop', tracks: [{part: 'wing', channel: 'rotation', keyframes: [
    {time: 0, value: [0, 0, 0]}, {time: 0.5, value: [8, 0, 0], interpolation: 'catmullrom'}, {time: 1, value: [0, 0, 0]}
  ]}]}
}

const defaultRefinement: AssetRefinementProgram = {
  version: 1,
  metadata: {name: 'Ember Raven refinement'},
  parts: [
    {id: 'tail', size: [4, 4, 12]},
    {id: 'head', size: [5, 5, 5]}
  ],
  animation: {name: 'wing_flap_refined', length: 1, loop: 'loop', tracks: [{part: 'wing_left', channel: 'rotation', keyframes: [
    {time: 0, value: [0, 0, 0]}, {time: 0.5, value: [18, 0, 0]}, {time: 1, value: [0, 0, 0]}
  ]}]}
}

const defaultAdvanced: AdvancedAssetProgram = {
  version: 1,
  metadata: {name: 'Arc Relay', quality: 'hero', symmetry: 'bilateral'},
  model: {
    format: 'free', textureWidth: 64, textureHeight: 64,
    primitives: [
      {id: 'body', type: 'cylinder', radius: 3, height: 12, segments: 12, center: [0, 6, 0]},
      {id: 'core', type: 'sphere', radius: 4, segments: 12, rings: 7, center: [0, 14, 0]},
      {id: 'arc', type: 'tube', path: [[0, 14, 0], [6, 18, 0], [4, 24, 3]], radius: 0.65, radialSegments: 7, curveSegments: 4}
    ]
  },
  texture: {fill: '#283038ff', rectangles: [{x: 0, y: 0, width: 10, height: 10, color: '#d7a83fff'}]},
  rig: {
    name: 'relay_rig', bones: [{id: 'root'}, {id: 'tip', parent: 'root', origin: [0, 16, 0]}],
    weightRules: [{mesh: 'arc', lowerBone: 'root', upperBone: 'tip', axis: 1, split: 18, blend: 5}],
    locators: [{id: 'effect_socket', position: [4, 24, 3], parent: 'tip'}],
    ik: [{id: 'tip_ik', position: [4, 25, 3], target: 'tip', source: 'root'}]
  },
  animations: [{name: 'pulse', length: 1, loop: 'loop', tracks: [{target: 'tip', channel: 'rotation', keyframes: [
    {time: 0, value: [0, 0, 0]}, {time: 0.5, value: [0, 0, 12]}, {time: 1, value: [0, 0, 0]}
  ]}]}],
  variants: [{id: 'compact', label: 'Compact', scale: 0.86}, {id: 'bright', label: 'Bright', accent: '#ffe58aff'}]
}

const defaultReference: ReferenceImageAssetProgram = {
  version: 1,
  metadata: {name: 'Reference Asset', quality: 'production'},
  image: {dataUrl: '', depth: 2, maxProfilePoints: 48},
  model: {format: 'free', textureWidth: 64, textureHeight: 64}
}

function getBridge(): BlockbenchBridge | undefined {
  const api = window.modmind as unknown as {
    blockbench?: Omit<BlockbenchBridge, 'assetIntent' | 'assetRefinement' | 'advancedAsset' | 'referenceAsset'>
    assetIntent?: BlockbenchBridge['assetIntent']
    assetRefinement?: BlockbenchBridge['assetRefinement']
    advancedAsset?: BlockbenchBridge['advancedAsset']
    referenceAsset?: BlockbenchBridge['referenceAsset']
  }
  return api.blockbench && api.assetIntent && api.assetRefinement && api.advancedAsset && api.referenceAsset
    ? {...api.blockbench, assetIntent: api.assetIntent, assetRefinement: api.assetRefinement, advancedAsset: api.advancedAsset, referenceAsset: api.referenceAsset}
    : undefined
}

function mergeState(current: WorkspaceState, payload: BlockbenchStatePayload): WorkspaceState {
  const status = payload.status ?? current.status
  const aiActive = payload.ai?.active ?? payload.aiActive ?? status === 'ai-running'

  return {
    status,
    connected: payload.connected ?? (status === 'ready' || status === 'busy' || status === 'ai-running'),
    dirty: payload.dirty ?? current.dirty,
    projectName: payload.projectName ?? payload.fileName ?? current.projectName,
    message: payload.ai?.message ?? payload.message ?? current.message,
    aiActive,
    aiAction: payload.ai?.action ?? payload.aiAction ?? current.aiAction
  }
}

export function BlockbenchWorkspace({ visible = true, darkMode = false, project, suppressed = false }: BlockbenchWorkspaceProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<string | null>(null)
  const bridge = useMemo(getBridge, [])
  const [state, setState] = useState<WorkspaceState>(() =>
    bridge ? initialState : { ...initialState, status: 'error', message: 'Blockbench 桥接服务不可用' }
  )
  const [pendingAction, setPendingAction] = useState('')
  const [notice, setNotice] = useState('')
  const [intentOpen, setIntentOpen] = useState(false)
  const [intentDocked, setIntentDocked] = useState(true)
  const isCompactLayout = useMediaQuery(COMPACT_LAYOUT_QUERY)
  const intentDockManualOverrideRef = useRef(false)
  useEffect(() => {
    if (intentDockManualOverrideRef.current) return
    setIntentDocked(!isCompactLayout)
  }, [isCompactLayout])
  const [intentMode, setIntentMode] = useState<'generate' | 'refine' | 'advanced' | 'reference'>('generate')
  const [intentText, setIntentText] = useState(() => JSON.stringify(defaultIntent, null, 2))
  const [intentCandidate, setIntentCandidate] = useState<AssetIntentPreview | AssetRefinementPreview | null>(null)
  const [advancedComparison, setAdvancedComparison] = useState<AdvancedAssetComparison | null>(null)
  const [selectedAdvancedId, setSelectedAdvancedId] = useState('')
  const [intentValue, setIntentValue] = useState<AssetIntentProgram | AssetRefinementProgram | AdvancedAssetProgram | ReferenceImageAssetProgram | null>(null)
  const [intentBusy, setIntentBusy] = useState(false)
  const [intentMessage, setIntentMessage] = useState('')
  const [nlText, setNlText] = useState('')
  const [nlBusy, setNlBusy] = useState(false)
  const [nlMessage, setNlMessage] = useState('')
  const [nlSteps, setNlSteps] = useState<PipelineEvent[]>([])
  const nlBusyRef = useRef(false)
  const [referenceDataUrl, setReferenceDataUrl] = useState('')
  const [comparisonView, setComparisonView] = useState<'after' | 'before' | 'split'>('after')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<BlockbenchHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyPanelWidth, setHistoryPanelWidth] = useState(340)
  const [intentPanelWidth, setIntentPanelWidth] = useState(430)

  const syncBounds = useCallback((): void => {
    if (!bridge || !visible || suppressed || !viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()

    // Blockbench WebContentsView 层级高于 React DOM。浮出的 AI 建模面板（右）和模型历史面板（左）
    // 都位于 viewport 上方，若不预留空间就会被 WebView 遮住。停靠模式下 viewport shell 已在 grid 中变窄，无需额外处理。
    let reserveLeft = 0
    let reserveRight = 0

    if (historyOpen) {
      const gap = 24
      const panelMin = 260
      const panelMax = 520
      const panelWidth = Math.min(panelMax, Math.max(panelMin, Math.round(historyPanelWidth)))
      reserveLeft = panelWidth + gap
    }

    if (intentOpen && !intentDocked) {
      const gap = 24
      const panelMin = 280
      const panelMax = 520
      const panelWidth = Math.min(panelMax, Math.max(panelMin, Math.round(intentPanelWidth)))
      reserveRight = panelWidth + gap
    }

    // 极端窄屏下优先保证 Blockbench 画布有最低可用宽度，按比例压缩两侧预留。
    const viewportMin = 280
    const totalReserve = reserveLeft + reserveRight
    const available = Math.round(rect.width) - viewportMin
    if (totalReserve > 0 && totalReserve > available) {
      const ratio = available / totalReserve
      reserveLeft = Math.floor(reserveLeft * ratio)
      reserveRight = available - reserveLeft
    }

    const bounds = {
      x: Math.round(rect.left) + reserveLeft,
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width) - reserveLeft - reserveRight),
      height: Math.max(0, Math.round(rect.height))
    }
    if (bounds.width <= 1 || bounds.height <= 1) return
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${historyOpen ? 1 : 0}:${intentOpen ? 1 : 0}:${intentDocked ? 1 : 0}:${historyPanelWidth}:${intentPanelWidth}`
    if (lastBoundsRef.current === key) return
    lastBoundsRef.current = key
    void bridge.show(bounds)
  }, [bridge, visible, suppressed, historyOpen, intentOpen, intentDocked, historyPanelWidth, intentPanelWidth])

  const startResizeIntent = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = intentPanelWidth
    const handleMouseMove = (e: MouseEvent): void => {
      const delta = startX - e.clientX
      const next = Math.min(520, Math.max(280, startWidth + delta))
      setIntentPanelWidth(next)
    }
    const handleMouseUp = (): void => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [intentPanelWidth])

  const startResizeHistory = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = historyPanelWidth
    const handleMouseMove = (e: MouseEvent): void => {
      const delta = e.clientX - startX
      const next = Math.min(520, Math.max(260, startWidth + delta))
      setHistoryPanelWidth(next)
    }
    const handleMouseUp = (): void => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [historyPanelWidth])

  useEffect(() => {
    if (!bridge) return
    const removeStateListener = bridge.onState((payload) => setState((current) => mergeState(current, payload)))
    return removeStateListener
  }, [bridge])

  useEffect(() => { if (bridge) void bridge.setTheme(darkMode ? 'dark' : 'light') }, [bridge, darkMode])

  useEffect(() => {
    if (!bridge) return
    if (!visible || suppressed) {
      lastBoundsRef.current = null
      void bridge.hide()
      return
    }

    let frame = 0
    const scheduleSync = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(syncBounds)
    }
    const observer = new ResizeObserver(scheduleSync)
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener('resize', scheduleSync)
    window.addEventListener('scroll', scheduleSync, true)
    scheduleSync()

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', scheduleSync, true)
      lastBoundsRef.current = null
      void bridge.hide()
    }
  }, [bridge, syncBounds, visible, suppressed])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  const execute = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    if (!bridge || pendingAction) return
    setPendingAction(name)
    setNotice('')
    try {
      await action()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction('')
    }
  }

  const runAction = (action: string): void => {
    if (!bridge) return
    void execute(action, () => bridge.runAction(action))
  }

  const switchIntentMode = (mode: 'generate' | 'refine' | 'advanced' | 'reference'): void => {
    if (intentBusy || mode === intentMode) return
    setIntentMode(mode)
    const value = mode === 'generate' ? defaultIntent : mode === 'refine' ? defaultRefinement : mode === 'advanced' ? defaultAdvanced : defaultReference
    setIntentText(JSON.stringify(value, null, 2))
    setIntentCandidate(null)
    setAdvancedComparison(null)
    setSelectedAdvancedId('')
    setIntentValue(null)
    setIntentMessage('')
  }

  const previewIntent = async (): Promise<void> => {
    if (!bridge || intentBusy) return
    setIntentBusy(true)
    setIntentMessage('')
    try {
      const intent = JSON.parse(intentText) as AssetIntentProgram | AssetRefinementProgram | AdvancedAssetProgram | ReferenceImageAssetProgram
      const current = await bridge.projectState().catch(() => null)
      const capture = {views: ['isometric_right', 'north', 'west'], width: 320, height: 320}
      if (intentMode === 'advanced') {
        const comparison = await bridge.advancedAsset.preview(intent as AdvancedAssetProgram, capture, {maxIterations: 3, targetScore: 82}, current?.revision)
        if (!comparison.candidates.length) throw new Error('高级程序未生成候选')
        setIntentValue(intent)
        setIntentCandidate(null)
        setAdvancedComparison(comparison)
        setSelectedAdvancedId(comparison.selectedCandidateId)
        setIntentMessage('候选已评分，已选中得分最高的候选。')
        return
      }
      if (intentMode === 'reference') {
        if (!referenceDataUrl) throw new Error('请先选择 PNG、JPEG 或 WebP 参考图')
        const reference = {...intent as ReferenceImageAssetProgram, image: {...(intent as ReferenceImageAssetProgram).image, dataUrl: referenceDataUrl}}
        const preview = await bridge.referenceAsset.preview(reference, capture, current?.revision)
        const comparison: AdvancedAssetComparison = {comparisonVersion: 1, selectedCandidateId: preview.variantId, candidates: [preview]}
        setIntentValue(reference)
        setIntentCandidate(null)
        setAdvancedComparison(comparison)
        setSelectedAdvancedId(preview.variantId)
        setIntentMessage('已提取参考图轮廓并完成目视复核。')
        return
      }
      const preview = intentMode === 'generate'
        ? await bridge.assetIntent.preview(intent as AssetIntentProgram, capture, current?.revision)
        : await bridge.assetRefinement.preview(intent as AssetRefinementProgram, capture, current?.revision)
      if (!preview || !('captures' in (preview as Record<string, unknown>))) {
        const diagnostics = (preview as {diagnostics?: Array<{message?: string}>})?.diagnostics ?? []
        throw new Error(diagnostics.map((diagnostic) => diagnostic.message).filter(Boolean).join('; ') || '意图未生成预览')
      }
      setIntentValue(intent)
      setIntentCandidate(preview as AssetIntentPreview | AssetRefinementPreview)
      setAdvancedComparison(null)
      setIntentMessage('预览就绪，临时候选已丢弃。')
    } catch (error) {
      setIntentCandidate(null)
      setAdvancedComparison(null)
      setIntentMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIntentBusy(false)
    }
  }

  useEffect(() => {
    const off = window.modmind.ai.onProgress((event) => {
      if (event.sessionId?.startsWith('inspiration-')) return
      if (!nlBusyRef.current) return
      setNlSteps((current) => current.some((item) => item.id === event.id) ? current : [...current, event])
    })
    return off
  }, [])

  const runModeling = async (): Promise<void> => {
    if (!bridge || nlBusy || !nlText.trim()) return
    setNlBusy(true)
    setNlMessage('')
    setNlSteps([])
    nlBusyRef.current = true
    try {
      const prompt = nlText.trim()
      await window.modmind.ai.createCode(prompt, undefined, undefined, 'standard', {
        surface: 'modeling',
        sessionScope: 'modeling',
        resumeSession: false,
        fallbackPrompt: prompt
      })
      setNlMessage('AI 建模任务已完成，请在视口中查看并保存生成的模型。')
    } catch (error) {
      setNlMessage(error instanceof Error ? error.message : String(error))
    } finally {
      nlBusyRef.current = false
      setNlBusy(false)
    }
  }

  const acceptIntent = async (): Promise<void> => {
    const advancedCandidate = advancedComparison?.candidates.find((candidate) => candidate.variantId === selectedAdvancedId) ?? advancedComparison?.candidates[0]
    if (!bridge || (!intentCandidate && !advancedCandidate) || !intentValue || intentBusy) return
    setIntentBusy(true)
    setIntentMessage('')
    try {
      const revisionBefore = intentCandidate?.execution.revisionBefore ?? advancedCandidate?.execution.revisionBefore
      const applied = intentMode === 'generate'
        ? await bridge.assetIntent.apply(intentValue as AssetIntentProgram, revisionBefore) as {execution?: {revisionAfter?: string}}
        : intentMode === 'refine'
          ? await bridge.assetRefinement.apply(intentValue as AssetRefinementProgram, revisionBefore) as {execution?: {revisionAfter?: string}}
          : intentMode === 'advanced'
            ? await bridge.advancedAsset.apply(advancedCandidate!.program, 'base', revisionBefore) as {execution?: {revisionAfter?: string}}
            : await bridge.referenceAsset.apply(intentValue as ReferenceImageAssetProgram, revisionBefore) as {execution?: {revisionAfter?: string}}
      if (!applied.execution) throw new Error('意图未成功应用')
      const current = await bridge.projectState()
      const assetName = intentMode === 'refine' ? current.project.name : intentValue.metadata.name
      const slug = assetName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'asset'
      const namespace = project?.namespace?.trim() || 'modmind'
      const textureName = current.textures[0]?.name ?? `${slug}_atlas`
      const activeCandidate = intentCandidate ?? advancedCandidate!
      const sourceMetadata = 'sourceMetadata' in activeCandidate ? activeCandidate.sourceMetadata : undefined
      const saved = await bridge.saveAssetBundle({
        projectRelativePath: `models/blockbench/${slug}.bbmodel`,
        textureRelativePath: `src/main/resources/assets/${namespace}/textures/entity/${slug}_atlas.png`,
        textureName,
        metadata: {
          source: intentMode === 'refine' ? 'REFINED' : 'GENERATED', intentHash: 'intentHash' in activeCandidate ? activeCandidate.intentHash : activeCandidate.programHash,
          generatedAt: new Date().toISOString(), ...(sourceMetadata?.intentHash ? {refinedFrom: sourceMetadata.intentHash} : {})
        }
      })
      setIntentCandidate(null)
      setAdvancedComparison(null)
      setIntentMessage(`已应用并保存 ${String((saved as {projectRelativePath?: string}).projectRelativePath || `${slug}.bbmodel`)}`)
    } catch (error) {
      setIntentMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIntentBusy(false)
    }
  }

  const loadHistory = async (): Promise<void> => {
    if (!bridge) return
    setHistoryBusy(true)
    try { setHistory(await bridge.history()) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setHistoryBusy(false) }
  }

  const toggleHistory = (): void => {
    setHistoryOpen((value) => !value)
    if (!historyOpen) void loadHistory()
  }

  const createHistoryCheckpoint = async (): Promise<void> => {
    if (!bridge || historyBusy) return
    setHistoryBusy(true)
    try {
      await bridge.createCheckpoint(`手动检查点 ${new Date().toLocaleTimeString()}`)
      setHistory(await bridge.history())
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setHistoryBusy(false) }
  }

  const restoreHistory = async (id: string): Promise<void> => {
    if (!bridge || historyBusy) return
    setHistoryBusy(true)
    try {
      await bridge.restoreHistory(id)
      setHistory(await bridge.history())
      setIntentCandidate(null)
      setAdvancedComparison(null)
      setNotice('已恢复 Blockbench 检查点')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setHistoryBusy(false) }
  }

  const readReferenceFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setIntentMessage('参考图必须是 PNG、JPEG 或 WebP，且不超过 8 MiB。')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReferenceDataUrl(reader.result)
        setIntentMessage(`${file.name} 已就绪，可提取轮廓。`)
      }
    }
    reader.onerror = () => setIntentMessage('无法读取参考图。')
    reader.readAsDataURL(file)
  }

  const selectedAdvanced = advancedComparison?.candidates.find((candidate) => candidate.variantId === selectedAdvancedId) ?? advancedComparison?.candidates[0]
  const visibleCandidate = intentCandidate ?? selectedAdvanced ?? null
  const baselineCaptures = intentCandidate && 'baselineCaptures' in intentCandidate ? intentCandidate.baselineCaptures : undefined
  const projectDiff = intentCandidate && 'diff' in intentCandidate ? intentCandidate.diff : undefined

  const isLoading = state.status === 'loading' || state.status === 'starting'
  const isError = state.status === 'error'
  const statusText = state.aiActive
    ? state.aiAction || state.message || '正在调整模型'
    : isError
      ? state.message
      : state.connected
        ? state.dirty
          ? '有未保存的修改'
          : '已保存'
        : state.message

  return (
    <section className={`bb-workspace${intentOpen ? ' intent-open' : ''}${intentOpen && intentDocked ? ' intent-docked' : ''}`} aria-label="Blockbench 模型工作台">
      <header className="bb-toolbar">
        <div className="bb-toolbar-group">
          <button
            className="bb-tool-button"
            type="button"
            title="打开 Blockbench 项目"
            aria-label="打开 Blockbench 项目"
            disabled={!bridge || Boolean(pendingAction)}
            onClick={() => bridge && void execute('open', () => bridge.openProject())}
          >
            {pendingAction === 'open' ? <LoaderCircle className="bb-spin" size={16} /> : <FolderOpen size={16} />}
          </button>
          <button
            className="bb-tool-button"
            type="button"
            title="保存模型"
            aria-label="保存模型"
            disabled={!bridge || Boolean(pendingAction)}
            onClick={() => bridge && void execute('save', () => bridge.saveProject())}
          >
            {pendingAction === 'save' ? <LoaderCircle className="bb-spin" size={16} /> : <Save size={16} />}
          </button>
          <span className="bb-toolbar-divider" />
          <button className="bb-tool-button" type="button" title="撤销" aria-label="撤销" disabled={!bridge} onClick={() => runAction('undo')}>
            <Undo2 size={16} />
          </button>
          <button className="bb-tool-button" type="button" title="重做" aria-label="重做" disabled={!bridge} onClick={() => runAction('redo')}>
            <Redo2 size={16} />
          </button>
        </div>

        <div className="bb-mode-control" aria-label="Blockbench 编辑模式">
          <button type="button" title="模型模式" onClick={() => runAction('mode_edit')}><Box size={14} />模型</button>
          <button type="button" title="绘制模式" onClick={() => runAction('mode_paint')}><Paintbrush size={14} />贴图</button>
          <button type="button" title="动画模式" onClick={() => runAction('mode_animate')}><Play size={14} />动画</button>
        </div>

        <div className="bb-toolbar-group bb-toolbar-end">
          <button className="bb-tool-button" type="button" title="切换网格" aria-label="切换网格" disabled={!bridge} onClick={() => runAction('toggle_grid')}>
            <Grid3X3 size={16} />
          </button>
          <button className="bb-tool-button" type="button" title="适合视图" aria-label="适合视图" disabled={!bridge} onClick={() => runAction('frame_all')}>
            <Maximize size={16} />
          </button>
          <button className={`bb-tool-button ${intentOpen ? 'active' : ''}`} type="button" title="AI 建模" aria-label="AI 建模" disabled={!bridge} onClick={() => setIntentOpen((value) => !value)}>
            <WandSparkles size={16} />
          </button>
          <button className={`bb-tool-button ${historyOpen ? 'active' : ''}`} type="button" title="模型历史" aria-label="模型历史" disabled={!bridge} onClick={toggleHistory}>
            <History size={16} />
          </button>
          <span className="bb-toolbar-divider" />
          <div className={`bb-ai-state ${state.aiActive ? 'active' : ''}`} title={statusText}>
            {state.aiActive ? <LoaderCircle className="bb-spin" size={14} /> : <Sparkles size={14} />}
            <span>{state.aiActive ? 'AI 正在操作' : '手动编辑'}</span>
          </div>
        </div>
      </header>

      <div className="bb-document-bar">
        <div className="bb-document-name">
          <span className={`bb-document-dot ${state.dirty ? 'dirty' : ''}`} />
          <strong>{state.projectName}</strong>
        </div>
        <div className={`bb-runtime-state ${isError ? 'error' : state.aiActive ? 'ai' : ''}`}>
          {isError ? <CircleAlert size={13} /> : isLoading ? <LoaderCircle className="bb-spin" size={13} /> : <CheckCircle2 size={13} />}
          <span>{statusText}</span>
        </div>
      </div>

      {intentOpen ? <aside className="bb-intent-panel" style={{ width: intentDocked ? undefined : intentPanelWidth }}>
        <div className="bb-panel-resize-handle bb-resize-left" data-tour="bb-intent-resize" aria-hidden="true" onMouseDown={startResizeIntent} />
        <div className="bb-intent-head">
          <div><strong>AI 建模</strong><span>预览为独立候选，需手动应用。</span></div>
          <button
            className="bb-tool-button"
            type="button"
            data-tour="bb-intent-pin"
            title={intentDocked ? '已停靠，点击改为浮出' : '已浮出，点击停靠到右侧'}
            aria-label={intentDocked ? '已停靠，点击改为浮出' : '已浮出，点击停靠到右侧'}
            onClick={() => { intentDockManualOverrideRef.current = true; setIntentDocked((value) => !value) }}
          >
            {intentDocked ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <button className="bb-tool-button" type="button" title="关闭候选面板" aria-label="关闭候选面板" onClick={() => setIntentOpen(false)}><X size={15} /></button>
        </div>
        <div className="bb-intent-nl">
          <textarea className="bb-intent-nl-editor" value={nlText} onChange={(event) => setNlText(event.target.value)} placeholder="用一句话描述模型，例如：做一只会喷火的红色小龙" aria-label="自然语言建模描述" rows={2} />
          <button className="bb-intent-primary" type="button" disabled={nlBusy || !nlText.trim()} onClick={() => void runModeling()}>{nlBusy ? <LoaderCircle className="bb-spin" size={14} /> : <WandSparkles size={14} />}AI 生成</button>
          {nlSteps.length > 0 ? <ol className="bb-intent-steps" aria-live="polite">
            {nlSteps.map((step) => <li key={step.id} className={`bb-intent-step ${step.status}`}>
              <span className="bb-intent-step-icon">{step.status === 'running' ? <LoaderCircle className="bb-spin" size={12} /> : step.status === 'error' || step.status === 'warning' ? <CircleAlert size={12} /> : <CheckCircle2 size={12} />}</span>
              <span className="bb-intent-step-copy"><strong>{step.title}</strong>{step.detail ? <em>{step.detail}</em> : null}</span>
            </li>)}
          </ol> : null}
          {nlMessage ? <p className="bb-intent-message">{nlMessage}</p> : null}
        </div>
        <details className="bb-intent-advanced">
          <summary>高级：直接编辑 Asset Intent JSON</summary>
        <div className="bb-intent-modes" aria-label="Asset candidate mode">
          <button type="button" className={intentMode === 'generate' ? 'selected' : ''} onClick={() => switchIntentMode('generate')}>生成</button>
          <button type="button" className={intentMode === 'refine' ? 'selected' : ''} onClick={() => switchIntentMode('refine')}>精修当前</button>
          <button type="button" className={intentMode === 'advanced' ? 'selected' : ''} onClick={() => switchIntentMode('advanced')}>高级</button>
          <button type="button" className={intentMode === 'reference' ? 'selected' : ''} onClick={() => switchIntentMode('reference')}>参考图</button>
        </div>
        {intentMode === 'reference' ? <label className="bb-reference-picker">
          <span>{referenceDataUrl ? '已载入参考图' : '选择参考图'}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={readReferenceFile} />
        </label> : null}
        <textarea className="bb-intent-editor" value={intentText} onChange={(event) => setIntentText(event.target.value)} spellCheck={false} aria-label="Asset Intent JSON" />
        <div className="bb-intent-actions">
          <button className="bb-intent-primary" type="button" disabled={intentBusy} onClick={() => void previewIntent()}>{intentBusy ? <LoaderCircle className="bb-spin" size={14} /> : <Sparkles size={14} />}预览</button>
          <button className="bb-intent-secondary" type="button" disabled={intentBusy || !visibleCandidate} onClick={() => void acceptIntent()}><CheckCircle2 size={14} />应用并保存</button>
          <button className="bb-intent-secondary" type="button" disabled={intentBusy || !visibleCandidate} onClick={() => { setIntentCandidate(null); setAdvancedComparison(null); setIntentValue(null); setIntentMessage('已丢弃候选。') }}><X size={14} />丢弃</button>
        </div>
        </details>
        {intentMessage ? <p className={`bb-intent-message ${visibleCandidate ? 'success' : ''}`}>{intentMessage}</p> : null}
        {advancedComparison && advancedComparison.candidates.length > 1 ? <div className="bb-candidate-tabs" aria-label="候选变体">
          {advancedComparison.candidates.map((candidate) => <button key={candidate.variantId} type="button" className={candidate.variantId === selectedAdvanced?.variantId ? 'selected' : ''} onClick={() => setSelectedAdvancedId(candidate.variantId)}>
            <span>{candidate.label}</span><strong>{candidate.review.score}</strong>
          </button>)}
        </div> : null}
        {visibleCandidate ? <>
          <div className="bb-intent-summary">
            <strong>{visibleCandidate.summary.name}</strong>
            <span>{visibleCandidate.summary.format} | {'parts' in visibleCandidate.summary ? visibleCandidate.summary.parts : visibleCandidate.summary.primitives} 个可编辑部件 | {visibleCandidate.summary.animations} 个动画</span>
            <span>{visibleCandidate.validation.valid ? '校验通过' : '校验待复核'}{selectedAdvanced ? ` | 视觉分 ${selectedAdvanced.review.score}/100 · 第 ${selectedAdvanced.iteration} 轮` : ''}</span>
          </div>
          {baselineCaptures ? <div className="bb-compare-modes" aria-label="修改前后对比">
            <button type="button" className={comparisonView === 'after' ? 'selected' : ''} onClick={() => setComparisonView('after')}>修改后</button>
            <button type="button" className={comparisonView === 'before' ? 'selected' : ''} onClick={() => setComparisonView('before')}>修改前</button>
            <button type="button" className={comparisonView === 'split' ? 'selected' : ''} onClick={() => setComparisonView('split')}>左右对比</button>
          </div> : null}
          <div className={`bb-intent-captures ${comparisonView === 'split' && baselineCaptures ? 'split' : ''}`}>
            {(comparisonView === 'before' && baselineCaptures ? baselineCaptures : visibleCandidate.captures).map((capture, index) => comparisonView === 'split' && baselineCaptures
              ? <figure key={capture.view}><img src={baselineCaptures[index]?.dataUrl} alt={`${capture.view} 修改前`} /><img src={capture.dataUrl} alt={`${capture.view} 修改后`} /></figure>
              : <img key={capture.view} src={capture.dataUrl} alt={`${capture.view} 候选预览`} />)}
          </div>
          {selectedAdvanced ? <div className="bb-review-findings">{selectedAdvanced.review.findings.slice(0, 4).map((finding) => <span key={finding.checkId} data-severity={finding.severity}>{finding.message}</span>)}</div> : null}
          {projectDiff ? <div className="bb-diff-list"><strong>新增 {projectDiff.counts.added} · 删除 {projectDiff.counts.removed} · 修改 {projectDiff.counts.changed}</strong>{projectDiff.entries.slice(0, 8).map((entry) => <span key={`${entry.category}-${entry.uuid}-${entry.change}`}>{entry.change} {entry.category} {entry.name}{entry.fields.length ? `: ${entry.fields.join(', ')}` : ''}</span>)}</div> : null}
          {selectedAdvanced ? <div className="bb-diff-list"><strong>{selectedAdvanced.actionDiff.length} 个可回放操作</strong>{selectedAdvanced.actionDiff.slice(0, 8).map((entry, index) => <span key={`${entry.type}-${entry.target}-${index}`}>{entry.type}: {entry.target} | {entry.detail}</span>)}</div> : null}
        </> : null}
      </aside> : null}

      {historyOpen ? <aside className="bb-history-panel" style={{ width: historyPanelWidth }}>
        <div className="bb-panel-resize-handle bb-resize-right" aria-hidden="true" onMouseDown={startResizeHistory} />
        <div className="bb-intent-head"><div><strong>模型历史</strong><span>最多保留 20 个可编辑检查点</span></div><button className="bb-tool-button" type="button" title="关闭历史" aria-label="关闭历史" onClick={() => setHistoryOpen(false)}><X size={15} /></button></div>
        <button className="bb-intent-secondary" type="button" disabled={historyBusy} onClick={() => void createHistoryCheckpoint()}>{historyBusy ? <LoaderCircle className="bb-spin" size={14} /> : <History size={14} />}创建检查点</button>
        <div className="bb-history-list">{history.length ? history.map((entry) => <div key={entry.id}><span><strong>{entry.label}</strong><small>{new Date(entry.createdAt).toLocaleString()} | {entry.actionCount} 步</small></span><button className="bb-tool-button" type="button" title={`恢复 ${entry.label}`} aria-label={`恢复 ${entry.label}`} disabled={historyBusy} onClick={() => void restoreHistory(entry.id)}><RotateCcw size={14} /></button></div>) : <p>暂无检查点。</p>}</div>
      </aside> : null}

      <div className="bb-viewport-shell">
        <div ref={viewportRef} className="bb-native-viewport">
          <div className={`bb-viewport-placeholder ${isError ? 'error' : ''}`}>
            {isError ? <CircleAlert size={24} /> : <LoaderCircle className="bb-spin" size={24} />}
            <strong>{isError ? '无法载入 Blockbench' : '正在载入 Blockbench'}</strong>
            <span>{state.message}</span>
          </div>
        </div>
      </div>

      <footer className="bb-statusbar">
        <span className={`bb-connection ${state.connected ? 'connected' : ''}`}><i />Blockbench {state.connected ? '已连接' : '未连接'}</span>
        <span className="bb-status-message" title={state.aiActive ? `AI · ${statusText}` : '手动操作已启用'}>{state.aiActive ? `AI · ${statusText}` : '手动操作已启用'}</span>
      </footer>

      {notice ? <div className="bb-notice" role="status">{notice}</div> : null}
    </section>
  )
}

export default BlockbenchWorkspace
