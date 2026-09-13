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
import type { AssetIntentPreview, AssetIntentProgram, AssetRefinementPreview, AssetRefinementProgram } from '../../../shared/assetIntent'
import type {AdvancedAssetCandidatePreview, AdvancedAssetComparison, AdvancedAssetProgram, ReferenceImageAssetProgram} from '../../../shared/advancedAsset'
import type {BlockbenchHistoryEntry, BlockbenchProjectState} from '../../../shared/blockbench'
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
  resourceTarget?: import('../../../shared/modelSource').ResourceModelTarget | null
  onCloseResource?: () => void
  onDetachResource?: () => void
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

export function BlockbenchWorkspace({ visible = true, darkMode = false, project, resourceTarget, onCloseResource, onDetachResource }: BlockbenchWorkspaceProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<string | null>(null)
  const bridge = useMemo(getBridge, [])
  const [state, setState] = useState<WorkspaceState>(() =>
    bridge ? initialState : { ...initialState, status: 'error', message: 'Blockbench 桥接服务不可用' }
  )
  const [pendingAction, setPendingAction] = useState('')
  const [notice, setNotice] = useState('')
  const resourceBaseline = useRef('')
  useEffect(() => { resourceBaseline.current = resourceTarget?.baseline ?? '' }, [resourceTarget])
  useEffect(() => {
    if (!visible || !bridge) return
    let active = true
    void window.modmind.blockbench.getState().then(value => { if (active) setState(current => mergeState(current, value)) }).catch(() => undefined)
    void bridge.projectState().then(value => { if (active) setState(current => ({ ...current, projectName: value.project.name, dirty: !value.project.saved })) }).catch(() => undefined)
    return () => { active = false }
  }, [visible, bridge, resourceTarget])
  const [intentOpen, setIntentOpen] = useState(false)
  const [intentMode, setIntentMode] = useState<'generate' | 'refine' | 'advanced' | 'reference'>('generate')
  const [intentText, setIntentText] = useState(() => JSON.stringify(defaultIntent, null, 2))
  const [intentCandidate, setIntentCandidate] = useState<AssetIntentPreview | AssetRefinementPreview | null>(null)
  const [advancedComparison, setAdvancedComparison] = useState<AdvancedAssetComparison | null>(null)
  const [selectedAdvancedId, setSelectedAdvancedId] = useState('')
  const [intentValue, setIntentValue] = useState<AssetIntentProgram | AssetRefinementProgram | AdvancedAssetProgram | ReferenceImageAssetProgram | null>(null)
  const [intentBusy, setIntentBusy] = useState(false)
  const [intentMessage, setIntentMessage] = useState('')
  const [referenceDataUrl, setReferenceDataUrl] = useState('')
  const [comparisonView, setComparisonView] = useState<'after' | 'before' | 'split'>('after')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<BlockbenchHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)

  const syncBounds = useCallback((): void => {
    if (!bridge || !visible || !viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height))
    }
    if (bounds.width <= 1 || bounds.height <= 1) return
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
    if (lastBoundsRef.current === key) return
    lastBoundsRef.current = key
    void bridge.show(bounds)
  }, [bridge, visible])

  useEffect(() => {
    if (!bridge) return
    const removeStateListener = bridge.onState((payload) => setState((current) => mergeState(current, payload)))
    return removeStateListener
  }, [bridge])

  useEffect(() => { if (bridge) void bridge.setTheme(darkMode ? 'dark' : 'light') }, [bridge, darkMode])

  useEffect(() => {
    if (!bridge) return
    if (!visible) {
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
  }, [bridge, syncBounds, visible])

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
      const document = await bridge?.projectState().catch(() => null)
      if (document) setState(current => ({ ...current, projectName: document.project.name, dirty: !document.project.saved }))
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
        if (!comparison.candidates.length) throw new Error('Advanced program did not produce a candidate')
        setIntentValue(intent)
        setIntentCandidate(null)
        setAdvancedComparison(comparison)
        setSelectedAdvancedId(comparison.selectedCandidateId)
        setIntentMessage('A/B candidates scored. The strongest candidate is selected.')
        return
      }
      if (intentMode === 'reference') {
        if (!referenceDataUrl) throw new Error('Choose a PNG, JPEG, or WebP reference image first')
        const reference = {...intent as ReferenceImageAssetProgram, image: {...(intent as ReferenceImageAssetProgram).image, dataUrl: referenceDataUrl}}
        const preview = await bridge.referenceAsset.preview(reference, capture, current?.revision)
        const comparison: AdvancedAssetComparison = {comparisonVersion: 1, selectedCandidateId: preview.variantId, candidates: [preview]}
        setIntentValue(reference)
        setIntentCandidate(null)
        setAdvancedComparison(comparison)
        setSelectedAdvancedId(preview.variantId)
        setIntentMessage('Reference silhouette extracted and visually reviewed.')
        return
      }
      const preview = intentMode === 'generate'
        ? await bridge.assetIntent.preview(intent as AssetIntentProgram, capture, current?.revision)
        : await bridge.assetRefinement.preview(intent as AssetRefinementProgram, capture, current?.revision)
      if (!preview || !('captures' in (preview as Record<string, unknown>))) {
        const diagnostics = (preview as {diagnostics?: Array<{message?: string}>})?.diagnostics ?? []
        throw new Error(diagnostics.map((diagnostic) => diagnostic.message).filter(Boolean).join('; ') || 'Intent did not produce a preview')
      }
      setIntentValue(intent)
      setIntentCandidate(preview as AssetIntentPreview | AssetRefinementPreview)
      setAdvancedComparison(null)
      setIntentMessage('Preview ready. The temporary candidate was discarded.')
    } catch (error) {
      setIntentCandidate(null)
      setAdvancedComparison(null)
      setIntentMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIntentBusy(false)
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
      if (!applied.execution) throw new Error('Asset Intent was not applied')
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
      setIntentMessage(`Accepted and saved ${String((saved as {projectRelativePath?: string}).projectRelativePath || `${slug}.bbmodel`)}`)
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
      await bridge.createCheckpoint(`Manual checkpoint ${new Date().toLocaleTimeString()}`)
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
      setNotice('Blockbench checkpoint restored')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setHistoryBusy(false) }
  }

  const readReferenceFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setIntentMessage('Reference must be a PNG, JPEG, or WebP no larger than 8 MiB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReferenceDataUrl(reader.result)
        setIntentMessage(`${file.name} ready for silhouette extraction.`)
      }
    }
    reader.onerror = () => setIntentMessage('Reference image could not be read.')
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
    <section className="bb-workspace" aria-label="Blockbench 模型工作台">
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
            onClick={() => bridge && void execute('save', async () => {
              if (!resourceTarget) return bridge.saveProject()
              resourceBaseline.current = await window.modmind.resourcePacks.saveModel({ ...resourceTarget, baseline: resourceBaseline.current })
              setNotice('模型已保存到资源包；单独修改的贴图请另行保存。')
            })}
          >
            {pendingAction === 'save' ? <LoaderCircle className="bb-spin" size={16} /> : <Save size={16} />}
          </button>
          <span className="bb-toolbar-divider" />
          <button className="bb-tool-button" type="button" title="打开 YSM 源模型，支持 ysm.json 或未加密 ZIP" disabled={!bridge || Boolean(pendingAction)} onClick={() => void execute('ysm', async () => {
            const result = await window.modmind.blockbench.openYsm()
            if (result) { onDetachResource?.(); setNotice(`已打开 ${result.name}。主模型、默认贴图和主 / 附加动画已加载；控制器、游戏变量与模组联动请在 YSM 客户端验证。`) }
          })}>YSM</button>
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
          <button className={`bb-tool-button ${intentOpen ? 'active' : ''}`} type="button" title="AI candidate" aria-label="AI candidate" disabled={!bridge} onClick={() => setIntentOpen((value) => !value)}>
            <WandSparkles size={16} />
          </button>
          <button className={`bb-tool-button ${historyOpen ? 'active' : ''}`} type="button" title="Model history" aria-label="Model history" disabled={!bridge} onClick={toggleHistory}>
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
          <strong title={resourceTarget?.file}>{resourceTarget ? `资源包 · ${resourceTarget.file.split('/').at(-1)}` : state.projectName}</strong>
        </div>
        {resourceTarget ? <button className="bb-resource-return" disabled={Boolean(pendingAction)} onClick={onCloseResource}>返回资源包</button> : null}
        <div className={`bb-runtime-state ${isError ? 'error' : state.aiActive ? 'ai' : ''}`}>
          {isError ? <CircleAlert size={13} /> : isLoading ? <LoaderCircle className="bb-spin" size={13} /> : <CheckCircle2 size={13} />}
          <span>{statusText}</span>
        </div>
      </div>

      {intentOpen ? <aside className="bb-intent-panel">
        <div className="bb-intent-head">
          <div><strong>AI candidate</strong><span>Preview is isolated. Accept is explicit.</span></div>
          <button className="bb-tool-button" type="button" title="Close candidate panel" aria-label="Close candidate panel" onClick={() => setIntentOpen(false)}><X size={15} /></button>
        </div>
        <div className="bb-intent-modes" aria-label="Asset candidate mode">
          <button type="button" className={intentMode === 'generate' ? 'selected' : ''} onClick={() => switchIntentMode('generate')}>Generate</button>
          <button type="button" className={intentMode === 'refine' ? 'selected' : ''} onClick={() => switchIntentMode('refine')}>Refine current</button>
          <button type="button" className={intentMode === 'advanced' ? 'selected' : ''} onClick={() => switchIntentMode('advanced')}>Advanced</button>
          <button type="button" className={intentMode === 'reference' ? 'selected' : ''} onClick={() => switchIntentMode('reference')}>Reference</button>
        </div>
        {intentMode === 'reference' ? <label className="bb-reference-picker">
          <span>{referenceDataUrl ? 'Reference loaded' : 'Choose reference image'}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={readReferenceFile} />
        </label> : null}
        <textarea className="bb-intent-editor" value={intentText} onChange={(event) => setIntentText(event.target.value)} spellCheck={false} aria-label="Asset Intent JSON" />
        <div className="bb-intent-actions">
          <button className="bb-intent-primary" type="button" disabled={intentBusy} onClick={() => void previewIntent()}>{intentBusy ? <LoaderCircle className="bb-spin" size={14} /> : <Sparkles size={14} />}Preview</button>
          <button className="bb-intent-secondary" type="button" disabled={intentBusy || !visibleCandidate} onClick={() => void acceptIntent()}><CheckCircle2 size={14} />Accept and save</button>
          <button className="bb-intent-secondary" type="button" disabled={intentBusy || !visibleCandidate} onClick={() => { setIntentCandidate(null); setAdvancedComparison(null); setIntentValue(null); setIntentMessage('Candidate discarded.') }}><X size={14} />Discard</button>
        </div>
        {intentMessage ? <p className={`bb-intent-message ${visibleCandidate ? 'success' : ''}`}>{intentMessage}</p> : null}
        {advancedComparison && advancedComparison.candidates.length > 1 ? <div className="bb-candidate-tabs" aria-label="Candidate variants">
          {advancedComparison.candidates.map((candidate) => <button key={candidate.variantId} type="button" className={candidate.variantId === selectedAdvanced?.variantId ? 'selected' : ''} onClick={() => setSelectedAdvancedId(candidate.variantId)}>
            <span>{candidate.label}</span><strong>{candidate.review.score}</strong>
          </button>)}
        </div> : null}
        {visibleCandidate ? <>
          <div className="bb-intent-summary">
            <strong>{visibleCandidate.summary.name}</strong>
            <span>{visibleCandidate.summary.format} | {'parts' in visibleCandidate.summary ? visibleCandidate.summary.parts : visibleCandidate.summary.primitives} editable parts | {visibleCandidate.summary.animations} animation</span>
            <span>{visibleCandidate.validation.valid ? 'Validation passed' : 'Validation needs review'}{selectedAdvanced ? ` | Visual score ${selectedAdvanced.review.score}/100 | iteration ${selectedAdvanced.iteration}` : ''}</span>
          </div>
          {baselineCaptures ? <div className="bb-compare-modes" aria-label="Before and after view">
            <button type="button" className={comparisonView === 'after' ? 'selected' : ''} onClick={() => setComparisonView('after')}>After</button>
            <button type="button" className={comparisonView === 'before' ? 'selected' : ''} onClick={() => setComparisonView('before')}>Before</button>
            <button type="button" className={comparisonView === 'split' ? 'selected' : ''} onClick={() => setComparisonView('split')}>Side by side</button>
          </div> : null}
          <div className={`bb-intent-captures ${comparisonView === 'split' && baselineCaptures ? 'split' : ''}`}>
            {(comparisonView === 'before' && baselineCaptures ? baselineCaptures : visibleCandidate.captures).map((capture, index) => comparisonView === 'split' && baselineCaptures
              ? <figure key={capture.view}><img src={baselineCaptures[index]?.dataUrl} alt={`${capture.view} before`} /><img src={capture.dataUrl} alt={`${capture.view} after`} /></figure>
              : <img key={capture.view} src={capture.dataUrl} alt={`${capture.view} candidate preview`} />)}
          </div>
          {selectedAdvanced ? <div className="bb-review-findings">{selectedAdvanced.review.findings.slice(0, 4).map((finding) => <span key={finding.checkId} data-severity={finding.severity}>{finding.message}</span>)}</div> : null}
          {projectDiff ? <div className="bb-diff-list"><strong>{projectDiff.counts.added} added | {projectDiff.counts.removed} removed | {projectDiff.counts.changed} changed</strong>{projectDiff.entries.slice(0, 8).map((entry) => <span key={`${entry.category}-${entry.uuid}-${entry.change}`}>{entry.change} {entry.category} {entry.name}{entry.fields.length ? `: ${entry.fields.join(', ')}` : ''}</span>)}</div> : null}
          {selectedAdvanced ? <div className="bb-diff-list"><strong>{selectedAdvanced.actionDiff.length} replayable actions</strong>{selectedAdvanced.actionDiff.slice(0, 8).map((entry, index) => <span key={`${entry.type}-${entry.target}-${index}`}>{entry.type}: {entry.target} | {entry.detail}</span>)}</div> : null}
        </> : null}
      </aside> : null}

      {historyOpen ? <aside className="bb-history-panel">
        <div className="bb-intent-head"><div><strong>Model history</strong><span>Up to 20 complete editable checkpoints</span></div><button className="bb-tool-button" type="button" title="Close history" aria-label="Close history" onClick={() => setHistoryOpen(false)}><X size={15} /></button></div>
        <button className="bb-intent-secondary" type="button" disabled={historyBusy} onClick={() => void createHistoryCheckpoint()}>{historyBusy ? <LoaderCircle className="bb-spin" size={14} /> : <History size={14} />}Create checkpoint</button>
        <div className="bb-history-list">{history.length ? history.map((entry) => <div key={entry.id}><span><strong>{entry.label}</strong><small>{new Date(entry.createdAt).toLocaleString()} | {entry.actionCount} actions</small></span><button className="bb-tool-button" type="button" title={`Restore ${entry.label}`} aria-label={`Restore ${entry.label}`} disabled={historyBusy} onClick={() => void restoreHistory(entry.id)}><RotateCcw size={14} /></button></div>) : <p>No checkpoints yet.</p>}</div>
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
        <span className="bb-status-message">{state.aiActive ? `AI · ${statusText}` : '手动操作已启用'}</span>
      </footer>

      {notice ? <div className="bb-notice" role="status">{notice}</div> : null}
    </section>
  )
}

export default BlockbenchWorkspace
