import { useCallback, useEffect, useRef, useState } from 'react'
import { addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeMouseHandler, type Node, type NodeMouseHandler, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Eraser, FolderOpen, Grid3X3, ImageIcon, LoaderCircle, Plus, RotateCcw, Save, Settings2, Sparkles, Trash2, Undo2, Upload } from 'lucide-react'
import type { ImageAsset, ImageGenerationRequest, ImageStudioCapabilities, ImageStudioQuality, ImageStudioSettings, ImageStudioStyle, PerfectPixelOptions, PerfectPixelSampleMethod } from '../../../shared/imageStudio'
import type { ProjectImageAsset } from '../../../shared/types'
import MiniPaintEditor from './MiniPaintEditor'

type StudioTab = 'workflow' | 'process' | 'edit'
type WorkflowKind = 'prompt' | 'reference' | 'generate' | 'process' | 'output'
type ProcessOperation = 'none' | 'perfect-pixel' | 'remove-background'
type WorkflowData = {
  kind: WorkflowKind
  title: string
  subtitle: string
  prompt?: string
  referenceImage?: string
  referenceLabel?: string
  style?: ImageStudioStyle
  size?: string
  quality?: ImageStudioQuality
  moderation?: 'auto' | 'low'
  count?: number
  operation?: ProcessOperation
  perfectPixel?: PerfectPixelOptions
  outputStatus?: 'loading' | 'done' | 'error'
  outputAsset?: ImageAsset
  outputError?: string
  onOpenOutput?: (asset: ImageAsset) => void
  onSaveOutput?: (asset: ImageAsset) => void
  onAddOutputToProject?: (asset: ImageAsset) => void
}
type WorkflowNodeType = Node<WorkflowData>

const defaultSettings: ImageStudioSettings = { baseUrl: '', model: '', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true }
const defaultCapabilities: ImageStudioCapabilities = { models: [], sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto'], qualities: ['low', 'medium', 'high', 'auto'], moderations: ['auto', 'low'], supportsImageInput: true, supportsMask: true }
const defaultPerfectPixelOptions: PerfectPixelOptions = { sampleMethod: 'center', minSize: 4, peakWidth: 6, refineIntensity: 0.3, fixSquare: true }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function readFileAsDataUrl(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取图片文件')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file) }) }
function createBlankImageAsset(): ImageAsset {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1024
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建编辑画布')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  return { id: crypto.randomUUID(), dataUrl: canvas.toDataURL('image/png'), createdAt: new Date().toISOString(), model: 'blank-canvas', style: 'free', size: '1024x1024', quality: 'auto', hosted: false, credits: 0 }
}
function nodeTitle(kind: WorkflowKind): string { return kind === 'prompt' ? '提示词' : kind === 'reference' ? '参考图' : kind === 'generate' ? '图像生成' : kind === 'process' ? '图像处理' : '输出' }
function nodeSubtitle(data: WorkflowData): string { if (data.kind === 'prompt') return '独立提示词输入'; if (data.kind === 'reference') return data.referenceLabel || '未选择图片'; if (data.kind === 'generate') return `${data.count || 1} 张`; if (data.kind === 'process') return data.operation === 'perfect-pixel' ? 'PerfectPixel' : data.operation === 'remove-background' ? '纯色去背' : '不处理'; return '结果预览与保存' }
function makeNode(id: string, kind: WorkflowKind, position: { x: number; y: number }, overrides: Partial<WorkflowData> = {}): Node<WorkflowData> { const data: WorkflowData = { kind, title: nodeTitle(kind), subtitle: '', ...overrides }; data.subtitle = nodeSubtitle(data); return { id, type: 'workflow', position, data } }

function PerfectPixelControls({ value, onChange }: { value?: PerfectPixelOptions; onChange: (value: PerfectPixelOptions) => void }): React.JSX.Element {
  const current = { ...defaultPerfectPixelOptions, ...value }
  const update = (patch: Partial<PerfectPixelOptions>): void => onChange({ ...current, ...patch })
  const gridSize = current.gridSize || [16, 16]
  return <div className="image-perfect-pixel-options"><strong>PerfectPixel 参数</strong>
    <label className="field-label">采样方式<select value={current.sampleMethod} onChange={(event) => update({ sampleMethod: event.target.value as PerfectPixelSampleMethod })}><option value="center">中心</option><option value="majority">多数</option><option value="median">中位数</option></select></label>
    <label className="field-label">最小像素尺寸<input type="number" min={0.1} max={1000} step={0.1} value={current.minSize} onChange={(event) => update({ minSize: Number(event.target.value) || 0.1 })} /></label>
    <label className="field-label">峰值宽度<input type="number" min={1} max={1000} step={1} value={current.peakWidth} onChange={(event) => update({ peakWidth: Number(event.target.value) || 1 })} /></label>
    <label className="field-label">网格线修正强度<input type="number" min={0} max={0.5} step={0.05} value={current.refineIntensity} onChange={(event) => update({ refineIntensity: Math.min(0.5, Math.max(0, Number(event.target.value) || 0)) })} /></label>
    <label className="image-perfect-pixel-check"><input type="checkbox" checked={Boolean(current.gridSize)} onChange={(event) => update({ gridSize: event.target.checked ? [Math.max(1, gridSize[0]), Math.max(1, gridSize[1])] : undefined })} />手动指定网格尺寸</label>
    {current.gridSize ? <div className="image-perfect-pixel-grid"><label className="field-label">宽<input type="number" min={1} max={4096} step={1} value={gridSize[0]} onChange={(event) => update({ gridSize: [Math.max(1, Number(event.target.value) || 1), gridSize[1]] })} /></label><label className="field-label">高<input type="number" min={1} max={4096} step={1} value={gridSize[1]} onChange={(event) => update({ gridSize: [gridSize[0], Math.max(1, Number(event.target.value) || 1)] })} /></label></div> : null}
    <label className="image-perfect-pixel-check"><input type="checkbox" checked={current.fixSquare !== false} onChange={(event) => update({ fixSquare: event.target.checked })} />接近正方形时修正</label>
  </div>
}

function WorkflowNode({ data }: { data: WorkflowData }): React.JSX.Element {
  if (data.kind === 'output') {
    return <div className="image-workflow-node image-workflow-node-output"><Handle type="target" position={Position.Left} /><strong>输出</strong>{data.outputStatus === 'loading' ? <div className="image-output-loading"><LoaderCircle className="spin" size={20} /><small>生成中</small></div> : data.outputStatus === 'error' ? <div className="image-output-error"><small>{data.outputError || '生成失败'}</small></div> : data.outputAsset ? <><button className="image-output-preview nodrag" title="放大预览" onClick={(event) => { event.stopPropagation(); data.onOpenOutput?.(data.outputAsset!) }}><img src={data.outputAsset.dataUrl} alt="生成结果" /></button><div className="image-output-actions nodrag"><button title="放大预览" onClick={(event) => { event.stopPropagation(); data.onOpenOutput?.(data.outputAsset!) }}><ImageIcon size={13} /></button><button title="另存为" onClick={(event) => { event.stopPropagation(); data.onSaveOutput?.(data.outputAsset!) }}><Save size={13} /></button><button title="加入项目" onClick={(event) => { event.stopPropagation(); data.onAddOutputToProject?.(data.outputAsset!) }}><FolderOpen size={13} /></button></div></> : null}</div>
  }
  return <div className={`image-workflow-node image-workflow-node-${data.kind}`}>{data.kind !== 'prompt' ? <Handle type="target" position={Position.Left} /> : null}<strong>{data.title}</strong><small>{data.subtitle}</small><Handle type="source" position={Position.Right} /></div>
}

const WORKFLOW_STORAGE_KEY = 'modmind.image-studio.workflow.v1'
const initialWorkflowNodes: WorkflowNodeType[] = [
  makeNode('prompt-1', 'prompt', { x: 40, y: 160 }, { prompt: '一个悬浮在深色石台上的蓝色水晶物品图标' }),
  makeNode('generate-1', 'generate', { x: 330, y: 160 }, { style: 'minecraft', size: '1024x1024', quality: 'medium', moderation: 'auto', count: 1 }),
  makeNode('process-1', 'process', { x: 625, y: 160 }, { operation: 'none' })
]
const initialWorkflowEdges: Edge[] = [
  { id: 'prompt-generate', source: 'prompt-1', target: 'generate-1', animated: true },
  { id: 'generate-process', source: 'generate-1', target: 'process-1' }
]

function imageProducingKind(kind: WorkflowKind): boolean { return kind === 'reference' || kind === 'generate' || kind === 'process' }

function connectionIsValid(connection: Connection, nodes: WorkflowNodeType[], edges: Edge[]): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  if (edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) return false
  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return false
  const allowed = (source.data.kind === 'prompt' || source.data.kind === 'reference')
    ? target.data.kind === 'generate'
    : (source.data.kind === 'generate' || source.data.kind === 'process') && (target.data.kind === 'generate' || target.data.kind === 'process' || target.data.kind === 'output')
  if (!allowed) return false
  const pending = [connection.target]
  const visited = new Set<string>()
  while (pending.length) {
    const current = pending.shift()!
    if (current === connection.source) return false
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...edges.filter((edge) => edge.source === current).map((edge) => edge.target))
  }
  return true
}

function topologicalNodes(nodes: WorkflowNodeType[], edges: Edge[]): WorkflowNodeType[] | null {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) if (indegree.has(edge.target) && indegree.has(edge.source)) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  const pending = nodes.filter((node) => indegree.get(node.id) === 0)
  const ordered: WorkflowNodeType[] = []
  while (pending.length) {
    const current = pending.shift()!
    ordered.push(current)
    for (const edge of edges.filter((item) => item.source === current.id)) {
      const next = (indegree.get(edge.target) ?? 0) - 1
      indegree.set(edge.target, next)
      if (next === 0) { const node = nodes.find((item) => item.id === edge.target); if (node) pending.push(node) }
    }
  }
  return ordered.length === nodes.length ? ordered : null
}

export default function ImageStudioWorkspace({ visible, darkMode, onOpenSettings }: { visible: boolean; darkMode: boolean; onOpenSettings: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<StudioTab>('workflow')
  const [settings, setSettings] = useState<ImageStudioSettings>(defaultSettings)
  const [capabilities, setCapabilities] = useState<ImageStudioCapabilities>(defaultCapabilities)
  const [projectAssets, setProjectAssets] = useState<ProjectImageAsset[]>([])
  const [assets, setAssets] = useState<ImageAsset[]>([])
  const [active, setActive] = useState<ImageAsset | null>(null)
  const [previewAsset, setPreviewAsset] = useState<ImageAsset | null>(null)
  const [editorOpened, setEditorOpened] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState('generate-1')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [perfectPixelOptions, setPerfectPixelOptions] = useState<PerfectPixelOptions>(defaultPerfectPixelOptions)
  const [processUndoStack, setProcessUndoStack] = useState<ImageAsset[]>([])
  const [queue, setQueue] = useState<Array<{ id: string; label: string; status: 'queued' | 'running' | 'done' | 'error' }>>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeType>(initialWorkflowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialWorkflowEdges)
  const flowRef = useRef<ReactFlowInstance<WorkflowNodeType, Edge> | null>(null)
  const needsInitialFitRef = useRef(true)
  const [workflowReady, setWorkflowReady] = useState(false)
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [activeImageSize, setActiveImageSize] = useState(0)
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)
  const selectedNode = selectedEdge ? undefined : (nodes.find((node) => node.id === selectedNodeId) ?? nodes[0])
  useEffect(() => {
    if (!active) {
      setActiveImageSize(0)
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) setActiveImageSize(Math.max(image.naturalWidth, image.naturalHeight))
    }
    image.onerror = () => {
      if (!cancelled) setActiveImageSize(0)
    }
    image.src = active.dataUrl
    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [active])
  const activeIsPixelated = active?.id.endsWith('-perfect-pixel') || (activeImageSize > 0 && activeImageSize <= 128)
  const scheduleInitialFit = useCallback((): void => {
    if (!needsInitialFitRef.current) return
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (!needsInitialFitRef.current || !flowRef.current) return
      flowRef.current.fitView({ duration: 0, maxZoom: 1, padding: 0.16 })
      needsInitialFitRef.current = false
    }))
  }, [])
  const onConnect = useCallback((connection: Connection) => {
    if (!connectionIsValid(connection, nodes, edges)) { setMessage('这条连接不适用于当前节点，或会形成循环'); return }
    setEdges((current) => addEdge({ ...connection, animated: true }, current))
  }, [edges, nodes, setEdges])
  const onNodeClick: NodeMouseHandler<WorkflowNodeType> = useCallback((_event, node) => { setSelectedEdgeId(''); setSelectedNodeId(node.id) }, [])
  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => { setSelectedNodeId(''); setSelectedEdgeId(edge.id); setEdges((current) => current.map((item) => ({ ...item, selected: item.id === edge.id }))) }, [setEdges])
  const onPaneClick = useCallback(() => { setSelectedEdgeId(''); setEdges((current) => current.map((item) => item.selected ? { ...item, selected: false } : item)) }, [setEdges])

  useEffect(() => {
    if (!visible) {
      setWorkflowReady(false)
      return
    }
    needsInitialFitRef.current = true
    setWorkflowReady(false)
    try {
      const saved = JSON.parse(localStorage.getItem(WORKFLOW_STORAGE_KEY) || 'null') as { nodes?: WorkflowNodeType[]; edges?: Edge[] } | null
      if (saved?.nodes?.length && saved.edges) {
        const migratedNodes = saved.nodes.filter((node) => node.data.kind !== 'output')
        const ids = new Set(migratedNodes.map((node) => node.id))
        const migratedEdges = saved.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        setNodes(migratedNodes); setEdges(migratedEdges); setSelectedNodeId(migratedNodes.find((node) => node.data.kind === 'generate')?.id ?? migratedNodes[0].id)
      }
    } catch { /* Ignore a corrupt local workflow and keep the default graph. */ }
    void window.modmind.imageStudio.getSettings().then(setSettings).catch((error) => setMessage(errorText(error)))
    void window.modmind.imageStudio.capabilities().then(setCapabilities).catch(() => undefined)
    void window.modmind.project.listImageAssets().then(setProjectAssets).catch(() => setProjectAssets([]))
    setWorkflowReady(true)
  }, [visible])

  useEffect(() => {
    if (!visible || tab !== 'workflow' || !workflowReady) return
    scheduleInitialFit()
  }, [scheduleInitialFit, tab, visible, workflowReady])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [message])

  const saveWorkflow = (): void => {
    const savedNodes = nodes.filter((node) => node.data.kind !== 'output')
    const savedIds = new Set(savedNodes.map((node) => node.id))
    localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify({ nodes: savedNodes, edges: edges.filter((edge) => savedIds.has(edge.source) && savedIds.has(edge.target)) }))
    setMessage('工作流已保存')
  }
  const resetWorkflow = (): void => { setNodes(initialWorkflowNodes); setEdges(initialWorkflowEdges); setSelectedNodeId('generate-1'); localStorage.removeItem(WORKFLOW_STORAGE_KEY); needsInitialFitRef.current = true; scheduleInitialFit(); setMessage('已恢复默认工作流') }

  const updateNode = (patch: Partial<WorkflowData>): void => {
    if (!selectedNode) return
    setNodes((current) => current.map((node) => {
      if (node.id !== selectedNode.id) return node
      const data = { ...node.data, ...patch }
      data.subtitle = nodeSubtitle(data)
      return { ...node, data }
    }))
  }

  const addNode = (kind: WorkflowKind): void => {
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
    const position = { x: 100 + (nodes.length % 3) * 260, y: 360 + Math.floor(nodes.length / 3) * 150 }
    const defaults: Partial<WorkflowData> = kind === 'prompt' ? { prompt: '' } : kind === 'reference' ? {} : kind === 'generate' ? { style: 'free', size: '1024x1024', quality: 'medium', moderation: 'auto', count: 1 } : kind === 'process' ? { operation: 'none', perfectPixel: defaultPerfectPixelOptions } : {}
    setNodes((current) => [...current, makeNode(id, kind, position, defaults)])
    if (kind === 'prompt' || kind === 'reference') {
      const target = nodes.find((node) => node.data.kind === 'generate')
      if (target && !edges.some((edge) => edge.source === id && edge.target === target.id)) setEdges((current) => [...current, { id: `${id}-${target.id}`, source: id, target: target.id, animated: true }])
    }
    setSelectedNodeId(id)
  }

  const deleteNodes = useCallback((deleted: WorkflowNodeType[]): void => {
    if (!deleted.length) return
    const deletedIds = new Set(deleted.map((node) => node.id))
    setNodes((current) => current.filter((node) => !deletedIds.has(node.id)))
    setEdges((current) => current.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target)))
    setSelectedNodeId((current) => deletedIds.has(current) ? nodes.find((node) => !deletedIds.has(node.id))?.id ?? '' : current)
  }, [nodes, setEdges, setNodes])

  const removeSelectedNode = (): void => { if (selectedNode && nodes.length > 1) deleteNodes([selectedNode]) }
  const removeSelectedEdge = (): void => { if (!selectedEdgeId) return; setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId('') }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!selectedEdgeId || (event.key !== 'Delete' && event.key !== 'Backspace')) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      removeSelectedEdge()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedEdgeId])

  const generate = async (): Promise<void> => {
    if (busy) return
    const ordered = topologicalNodes(nodes, edges)
    if (!ordered) { setMessage('工作流包含循环连接，无法执行'); return }
    const generationNodes = ordered.filter((node) => node.data.kind === 'generate')
    if (!generationNodes.length) { setMessage('请添加至少一个图像生成节点'); return }
    for (const generation of generationNodes) {
      const promptNode = edges.filter((edge) => edge.target === generation.id).map((edge) => nodes.find((node) => node.id === edge.source)).find((node) => node?.data.kind === 'prompt')
      if (!promptNode?.data.prompt?.trim()) { setMessage(`“${generation.data.title}”缺少已连接的提示词`); return }
    }
    const estimatedOutputs = new Map<string, number>()
    let totalCount = 0
    for (const node of ordered) {
      const incoming = edges.filter((edge) => edge.target === node.id).map((edge) => nodes.find((item) => item.id === edge.source)).filter((item): item is WorkflowNodeType => Boolean(item))
      if (node.data.kind === 'reference') estimatedOutputs.set(node.id, node.data.referenceImage ? 1 : 0)
      if (node.data.kind === 'generate') {
        const upstream = incoming.filter((item) => imageProducingKind(item.data.kind)).reduce((sum, item) => sum + (estimatedOutputs.get(item.id) ?? 0), 0)
        const count = Math.min(10, Math.max(1, node.data.count || 1)) * Math.max(1, upstream)
        estimatedOutputs.set(node.id, count)
        totalCount += count
      }
      if (node.data.kind === 'process') estimatedOutputs.set(node.id, incoming.filter((item) => imageProducingKind(item.data.kind)).reduce((sum, item) => sum + (estimatedOutputs.get(item.id) ?? 0), 0))
    }
    const terminalImageNodes = ordered.filter((node) => (node.data.kind === 'generate' || node.data.kind === 'process') && !edges.some((edge) => edge.source === node.id && imageProducingKind(nodes.find((item) => item.id === edge.target)?.data.kind || 'output')))
    const finalOutputCount = Math.max(1, terminalImageNodes.reduce((sum, node) => sum + (estimatedOutputs.get(node.id) ?? 0), 0))
    const hosted = !settings.hasStoredKey
    if (hosted && !settings.manualHostedConsent) {
      await window.modmind.imageStudio.saveSettings({ ...settings, apiKey: '', manualHostedConsent: true }).then(setSettings)
    }
    const id = crypto.randomUUID()
    const outputNodeCount = finalOutputCount
    const outputNodeIds = Array.from({ length: outputNodeCount }, (_, index) => `runtime-output-${id}-${index}`)
    const previousOutputs = nodes.filter((node) => node.data.kind === 'output')
    const outputX = previousOutputs[0]?.position.x ?? Math.max(...nodes.filter((node) => node.data.kind !== 'output').map((node) => node.position.x + 240), 720)
    const outputY = previousOutputs.length ? Math.max(...previousOutputs.map((node) => node.position.y + Math.max(node.measured?.height ?? 0, 210))) + 24 : 70
    const outputPosition = (index: number): { x: number; y: number } => ({ x: outputX, y: outputY + index * 234 })
    const isCurrentOutput = (nodeId: string): boolean => nodeId.startsWith(`runtime-output-${id}-`)
    const sourceIds = terminalImageNodes.map((node) => node.id)
    setNodes((current) => [...current, ...outputNodeIds.map((outputId, index) => makeNode(outputId, 'output', outputPosition(index), { outputStatus: 'loading' }))])
    setEdges((current) => [...current, ...outputNodeIds.flatMap((outputId, index) => sourceIds.length ? [{ id: `${sourceIds[index % sourceIds.length]}-${outputId}`, source: sourceIds[index % sourceIds.length], target: outputId, animated: true }] : [])])
    window.requestAnimationFrame(() => flowRef.current?.fitView({ duration: 300, padding: 0.16 }))
    setQueue((current) => [...current, { id, label: `${generationNodes.length} 个生图节点 · ${totalCount} 张`, status: 'running' }]); setBusy(true); setMessage('正在按工作流执行…')
    try {
      const nodeAssets = new Map<string, ImageAsset[]>()
      for (const node of ordered) {
        const incomingNodes = edges.filter((edge) => edge.target === node.id).map((edge) => nodes.find((item) => item.id === edge.source)).filter((item): item is WorkflowNodeType => Boolean(item))
        if (node.data.kind === 'reference') {
          if (node.data.referenceImage) nodeAssets.set(node.id, [{ id: node.id, dataUrl: node.data.referenceImage, createdAt: new Date().toISOString(), model: 'reference', style: 'free', size: 'original', quality: 'auto', hosted: false, credits: 0 }])
          continue
        }
        if (node.data.kind === 'generate') {
          const promptNode = incomingNodes.find((item) => item.data.kind === 'prompt')!
          const upstream = incomingNodes.filter((item) => imageProducingKind(item.data.kind)).flatMap((item) => nodeAssets.get(item.id) ?? [])
          const references: Array<ImageAsset | null> = upstream.length ? upstream : [null]
          const generated: ImageAsset[] = []
          for (const reference of references) {
            const request: ImageGenerationRequest = { prompt: promptNode.data.prompt!.trim(), style: node.data.style || 'free', size: node.data.size || '1024x1024', quality: node.data.quality || 'medium', moderation: node.data.moderation || 'auto', count: Math.min(10, Math.max(1, node.data.count || 1)), background: 'solid', backgroundColor: '#ffffff', removeBackground: false, source: 'manual', ...(reference ? { referenceImage: reference.dataUrl } : {}) }
            const result = await window.modmind.imageStudio.generate(request)
            generated.push(...result.assets)
          }
          nodeAssets.set(node.id, generated)
          continue
        }
        if (node.data.kind === 'process') {
          const input = incomingNodes.filter((item) => imageProducingKind(item.data.kind)).flatMap((item) => nodeAssets.get(item.id) ?? [])
          if (!node.data.operation || node.data.operation === 'none') { nodeAssets.set(node.id, input); continue }
          const processed: ImageAsset[] = []
          for (const asset of input) { const next = await window.modmind.imageStudio.process(node.data.operation, asset.dataUrl, node.data.operation === 'perfect-pixel' ? { perfectPixel: node.data.perfectPixel } : undefined); processed.push({ ...asset, id: `${asset.id}-${node.id}`, dataUrl: next.dataUrl }) }
          nodeAssets.set(node.id, processed)
          continue
        }
        if (node.data.kind === 'output') nodeAssets.set(node.id, incomingNodes.filter((item) => imageProducingKind(item.data.kind)).flatMap((item) => nodeAssets.get(item.id) ?? []))
      }
      let output = ordered.filter((node) => (node.data.kind === 'generate' || node.data.kind === 'process') && !edges.some((edge) => edge.source === node.id && imageProducingKind(nodes.find((item) => item.id === edge.target)?.data.kind || 'output'))).flatMap((node) => nodeAssets.get(node.id) ?? [])
      output = [...new Map(output.map((asset) => [asset.id, asset])).values()]
      if (!output.length) throw new Error('工作流没有产生可输出的图片，请检查节点连接')
      const finalOutputIds = output.map((_, index) => outputNodeIds[index] || `runtime-output-${id}-${index}`)
      setNodes((current) => [...current.filter((node) => !isCurrentOutput(node.id)), ...output.map((asset, index) => makeNode(finalOutputIds[index], 'output', current.find((node) => node.id === finalOutputIds[index])?.position ?? outputPosition(index), { outputStatus: 'done', outputAsset: asset, onOpenOutput: (value) => { setProcessUndoStack([]); setActive(value); setPreviewAsset(value) }, onSaveOutput: (value) => void saveAssetAs(value), onAddOutputToProject: (value) => void addAssetToProject(value) }))])
      setEdges((current) => [...current.filter((edge) => !isCurrentOutput(edge.target)), ...finalOutputIds.flatMap((outputId, index) => sourceIds.length ? [{ id: `${sourceIds[index % sourceIds.length]}-${outputId}`, source: sourceIds[index % sourceIds.length], target: outputId, animated: false }] : [])])
      setAssets((current) => [...output, ...current]); setProcessUndoStack([]); setActive(output[0] ?? null); setQueue((current) => current.map((item) => item.id === id ? { ...item, status: 'done' } : item)); setMessage(`工作流完成：${output.length} 张图片`)
    } catch (error) { const detail = errorText(error); setNodes((current) => current.map((node) => isCurrentOutput(node.id) ? { ...node, data: { ...node.data, outputStatus: 'error', outputError: detail } } : node)); setQueue((current) => current.map((item) => item.id === id ? { ...item, status: 'error' } : item)); setMessage(detail) } finally { setBusy(false) }
  }

  const upload = async (file: File): Promise<void> => { if (!file.type.startsWith('image/')) return; const dataUrl = await readFileAsDataUrl(file); const asset: ImageAsset = { id: crypto.randomUUID(), dataUrl, createdAt: new Date().toISOString(), model: 'uploaded', style: 'free', size: 'original', quality: 'auto', hosted: false, credits: 0 }; setAssets((current) => [asset, ...current]); setProcessUndoStack([]); setActive(asset); setMessage('图片已载入') }
  const studioTabs: StudioTab[] = ['workflow', 'process', 'edit']
  const studioTabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectStudioTab = (next: StudioTab): void => {
    setTab(next)
    setEditorOpened(next === 'edit' && Boolean(active))
  }
  const onStudioTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = studioTabs.indexOf(tab)
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? studioTabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + studioTabs.length) % studioTabs.length
    const next = studioTabs[nextIndex]
    selectStudioTab(next)
    window.requestAnimationFrame(() => studioTabRefs.current[nextIndex]?.focus())
  }
  const startNewCanvas = (): void => {
    const asset = createBlankImageAsset()
    setAssets((current) => [asset, ...current])
    setProcessUndoStack([])
    setActive(asset)
    setEditorOpened(true)
    setTab('edit')
  }
  const openEditor = (): void => { if (active) setEditorOpened(true); setTab('edit') }
  const undoProcess = (): void => {
    if (!active || busy || !processUndoStack.length) return
    const previous = processUndoStack[processUndoStack.length - 1]
    setProcessUndoStack((current) => current.slice(0, -1))
    setActive(previous)
    setAssets((current) => {
      const replaced = current.map((item) => item.id === active.id ? previous : item)
      return replaced.some((item) => item.id === previous.id) ? replaced : [...replaced, previous]
    })
    setMessage('已撤销上一步处理')
  }
  const processActive = async (operation: 'perfect-pixel' | 'remove-background'): Promise<void> => { if (!active || busy) return; setBusy(true); setMessage(operation === 'perfect-pixel' ? '正在使用 PerfectPixel…' : '正在检测并去除纯色背景…'); try { const result = await window.modmind.imageStudio.process(operation, active.dataUrl, operation === 'perfect-pixel' ? { perfectPixel: perfectPixelOptions } : undefined); const processed = { ...active, id: `${active.id}-${operation}`, dataUrl: result.dataUrl }; setProcessUndoStack((current) => [...current, active]); setActive(processed); setAssets((current) => current.map((item) => item.id === active.id ? processed : item)); setMessage(result.detail) } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const saveAssetAs = async (asset: ImageAsset | null): Promise<void> => { if (!asset) return; const saved = await window.modmind.imageStudio.saveAsset(asset.dataUrl, `modmind-${asset.style}-${Date.now()}`); if (saved) setMessage(`已保存：${saved}`) }
  const addAssetToProject = async (asset: ImageAsset | null): Promise<void> => { if (!asset) return; try { const saved = await window.modmind.imageStudio.saveToProject(asset.dataUrl, `modmind-${asset.style}-${Date.now()}`); setMessage(`已加入项目：${saved}`) } catch (error) { setMessage(errorText(error)) } }
  const renderNodeEditor = (): React.JSX.Element => {
    if (selectedEdge) {
      const source = nodes.find((node) => node.id === selectedEdge.source)
      const target = nodes.find((node) => node.id === selectedEdge.target)
      return <div className="image-connection-editor"><strong>{source?.data.title || selectedEdge.source} → {target?.data.title || selectedEdge.target}</strong><p>这条连接会把上游图片传给下游节点。点击右上角垃圾桶，或按 Delete 删除连接</p></div>
    }
    if (!selectedNode) return <p className="image-editor-help">点击一个节点开始编辑</p>
    const data = selectedNode.data
    if (data.kind === 'prompt') return <label className="field-label">提示词<textarea value={data.prompt || ''} onChange={(event) => updateNode({ prompt: event.target.value })} rows={9} /></label>
    if (data.kind === 'reference') return <><label className="field-label">本地参考图<label className="secondary-button compact image-reference-upload"><Upload size={14} />选择图片<input type="file" accept="image/*" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; updateNode({ referenceImage: await readFileAsDataUrl(file), referenceLabel: file.name }) }} /></label></label>{projectAssets.length ? <label className="field-label">项目内图片<select value={data.referenceLabel?.startsWith('项目：') ? data.referenceLabel.slice(3) : ''} onChange={async (event) => { const path = event.target.value; if (!path) return; updateNode({ referenceImage: await window.modmind.project.readImageAsset(path), referenceLabel: `项目：${path}` }) }}><option value="">选择项目资源</option>{projectAssets.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>)}</select></label> : <small className="image-editor-help">当前项目没有可用图片资源</small>}{data.referenceImage ? <img className="image-reference-thumb" src={data.referenceImage} alt="参考图" /> : null}</>
    if (data.kind === 'generate') return <><label className="field-label">风格<select value={data.style || 'free'} onChange={(event) => updateNode({ style: event.target.value as ImageStudioStyle })}><option value="minecraft">Minecraft 像素风</option><option value="free">自由风格</option></select></label><label className="field-label">尺寸<select value={data.size || '1024x1024'} onChange={(event) => updateNode({ size: event.target.value })}>{capabilities.sizes.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">质量<select value={data.quality || 'medium'} onChange={(event) => updateNode({ quality: event.target.value as ImageStudioQuality })}>{capabilities.qualities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">审核<select value={data.moderation || 'auto'} onChange={(event) => updateNode({ moderation: event.target.value as 'auto' | 'low' })}>{capabilities.moderations.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">批量数量<input type="number" min={1} max={10} value={data.count || 1} onChange={(event) => updateNode({ count: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })} /></label></>
    if (data.kind === 'process') return <><label className="field-label">处理方式<select value={data.operation || 'none'} onChange={(event) => updateNode({ operation: event.target.value as ProcessOperation })}><option value="none">不处理</option><option value="perfect-pixel">PerfectPixel</option><option value="remove-background">纯色去背</option></select></label>{data.operation === 'perfect-pixel' ? <PerfectPixelControls value={data.perfectPixel} onChange={(value) => updateNode({ perfectPixel: value })} /> : null}</>
    return <p className="image-editor-help">该节点接收上游结果。连接到它的图片会出现在下方结果区，可保存到项目</p>
  }

  return <div className={`image-studio-page ${tab === 'edit' ? 'image-studio-editing' : ''}`}><div className="content-toolbar image-studio-toolbar-heading"><div className="image-studio-heading"><h1>图像工坊</h1><p>工作流、处理和编辑</p></div><div className="image-studio-toolbar-controls"><div className="image-studio-tabs" role="tablist" aria-label="图像工坊模式">
      <button ref={(element) => { studioTabRefs.current[0] = element }} id="image-tab-workflow" className={tab === 'workflow' ? 'active' : ''} role="tab" aria-selected={tab === 'workflow'} aria-controls="image-panel-workflow" tabIndex={tab === 'workflow' ? 0 : -1} onClick={() => selectStudioTab('workflow')} onKeyDown={onStudioTabKeyDown}><Sparkles size={15} />工作流</button>
      <button ref={(element) => { studioTabRefs.current[1] = element }} id="image-tab-process" className={tab === 'process' ? 'active' : ''} role="tab" aria-selected={tab === 'process'} aria-controls="image-panel-process" tabIndex={tab === 'process' ? 0 : -1} onClick={() => selectStudioTab('process')} onKeyDown={onStudioTabKeyDown}><Grid3X3 size={15} />处理</button>
      <button ref={(element) => { studioTabRefs.current[2] = element }} id="image-tab-edit" className={tab === 'edit' ? 'active' : ''} role="tab" aria-selected={tab === 'edit'} aria-controls="image-panel-edit" tabIndex={tab === 'edit' ? 0 : -1} onClick={() => selectStudioTab('edit')} onKeyDown={onStudioTabKeyDown}><ImageIcon size={15} />编辑</button>
    </div><div className="image-studio-status"><span className={`status-dot ${busy ? 'warning' : 'success'}`} />{settings.hasStoredKey ? '自有图片 Key' : 'ModMind 托管额度'}<button className="icon-button" title="保存工作流" onClick={saveWorkflow}><Save size={15} /></button><button className="icon-button" title="恢复默认工作流" onClick={resetWorkflow}><RotateCcw size={15} /></button><button className="icon-button" title="打开图像服务设置" onClick={onOpenSettings}><Settings2 size={15} /></button></div></div></div>
    {tab === 'workflow' ? <div id="image-panel-workflow" role="tabpanel" aria-labelledby="image-tab-workflow"><div className="image-workflow-layout"><section className="image-workflow-canvas"><ReactFlow colorMode={darkMode ? 'dark' : 'light'} nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodesDelete={deleteNodes} deleteKeyCode={['Backspace', 'Delete']} onConnect={onConnect} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={onPaneClick} onInit={(instance) => { flowRef.current = instance; if (visible && workflowReady) scheduleInitialFit() }} nodeTypes={{ workflow: WorkflowNode }}><MiniMap pannable zoomable /><Controls /><Background gap={18} size={1} /></ReactFlow></section><aside className="image-workflow-sidebar"><div className="image-panel-title"><Settings2 size={16} />{selectedEdge ? '连接' : selectedNode ? `${selectedNode.data.title} 节点` : '节点参数'}<button className="icon-button" title={selectedEdge ? '删除连接' : '删除当前节点'} disabled={selectedEdge ? false : (!selectedNode || nodes.length <= 1)} onClick={selectedEdge ? removeSelectedEdge : removeSelectedNode}><Trash2 size={14} /></button></div>{renderNodeEditor()}<div className="image-add-node"><strong>添加节点</strong><div><button className="secondary-button compact" onClick={() => addNode('prompt')}><Plus size={13} />提示词</button><button className="secondary-button compact" onClick={() => addNode('reference')}><Plus size={13} />参考图</button><button className="secondary-button compact" onClick={() => addNode('generate')}><Plus size={13} />生图</button><button className="secondary-button compact" onClick={() => addNode('process')}><Plus size={13} />处理</button></div></div><button className="primary-button image-generate-button" disabled={busy} onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}运行工作流</button><div className="image-queue"><div className="image-panel-title">队列</div>{queue.slice(-5).map((item) => <div className="image-queue-row" key={item.id}><span>{item.label}</span><small>{item.status === 'running' ? '运行中' : item.status === 'done' ? '完成' : item.status === 'error' ? '失败' : '排队'}</small></div>)}</div></aside></div></div> : null}
    {tab === 'process' ? <div id="image-panel-process" role="tabpanel" aria-labelledby="image-tab-process"><div className="image-process-layout"><section className="image-process-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file) }}><Upload size={28} /><strong>上传图片</strong><small>拖放文件到这里，或选择本地图片</small><label className="secondary-button compact"><FolderOpen size={14} />选择图片<input type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} /></label></section><section className="image-process-preview"><div className="image-panel-title"><ImageIcon size={16} />预览</div>{active ? <img className={activeIsPixelated ? 'image-pixelated-preview' : undefined} src={active.dataUrl} alt="待处理图片" /> : <div className="image-empty"><ImageIcon size={30} /><p>先上传或生成图片</p></div>}</section><aside className="image-process-tools"><div className="image-panel-title"><Grid3X3 size={16} />工具</div><PerfectPixelControls value={perfectPixelOptions} onChange={setPerfectPixelOptions} /><button className="secondary-button image-tool-button" disabled={!active || busy} onClick={() => void processActive('perfect-pixel')}><Grid3X3 size={15} />PerfectPixel</button><button className="secondary-button image-tool-button" disabled={!processUndoStack.length || busy} onClick={undoProcess}><Undo2 size={15} />撤销上一步</button><button className="secondary-button image-tool-button" disabled={!active || busy} onClick={() => void processActive('remove-background')}><Eraser size={15} />纯色去背</button><button className="secondary-button image-tool-button" disabled={!active} onClick={openEditor}><ImageIcon size={15} />在编辑器中打开</button></aside></div></div> : null}
    {tab === 'edit' ? <div id="image-panel-edit" className="image-edit-layout" role="tabpanel" aria-labelledby="image-tab-edit">{editorOpened && active ? <MiniPaintEditor asset={active} darkMode={darkMode} onError={setMessage} /> : <div className="image-editor-empty"><div className="image-editor-empty-icon"><ImageIcon size={25} /></div><h2>开始编辑图片</h2><p>创建一张新画布，或导入一张图片开始编辑</p><div className="image-editor-empty-actions"><button className="primary-button" onClick={startNewCanvas}><Plus size={16} />新建画布</button><label className="secondary-button"><Upload size={16} />导入图片<input type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) { void upload(file).then(() => { setEditorOpened(true) }) } }} /></label></div></div>}</div> : null}
    {previewAsset ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setPreviewAsset(null)}><div className="image-result-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="image-panel-title"><span>生成结果</span><button className="icon-button" title="关闭预览" onClick={() => setPreviewAsset(null)}>×</button></div><img src={previewAsset.dataUrl} alt="生成结果大图" /><div className="dialog-footer"><button className="secondary-button" onClick={() => void saveAssetAs(previewAsset)}><Save size={15} />另存为</button><button className="primary-button" onClick={() => void addAssetToProject(previewAsset)}><FolderOpen size={15} />加入项目</button></div></div></div> : null}
    {message ? <div className="image-studio-message">{message}</div> : null}</div>
}
