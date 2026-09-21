import MoreActions from './MoreActions'
import ImageWorkflowSwitcher from './ImageWorkflowSwitcher'
import ImageWorkflowPaste from './ImageWorkflowPaste'
import ImagePresetFields from './ImagePresetFields'
import { findImageStudioPreset } from '../lib/imageStudioPresets'
import { createWorkflowOutputSlots, newWorkflowNodePosition, nextOutputColumn, workflowDisplayName } from '../lib/imageWorkflowPresentation'
import './image-workflow-experience.css'
import { traceImageStudio, traceImageStudioSnapshot, tracedImageStudio } from '../lib/imageStudioTrace'
import { describeClientFailure } from '../../../shared/clientFailure'
import { reportClientFailure } from '../lib/clientFailure'
import { useCallback, useEffect, useRef, useState } from 'react'
import { addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeMouseHandler, type Node, type NodeMouseHandler, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Copy, Ellipsis, Eraser, FolderOpen, Grid3X3, ImageIcon, LoaderCircle, Plus, RotateCcw, Save, Settings2, Sparkles, Trash2, Undo2, Upload } from 'lucide-react'
import type { ImageAsset, ImageStudioCapabilities, ImageStudioQuality, ImageStudioSettings, PerfectPixelOptions, PerfectPixelSampleMethod } from '../../../shared/imageStudio'
import type { ProjectImageAsset } from '../../../shared/types'
import MiniPaintEditor from './MiniPaintEditor'
import { useConfirmDialog, usePromptDialog } from './InteractionDialogs'
import { connectionIsValid, planImageWorkflow, runImageWorkflow, snapshotImageWorkflow, type ProcessOperation, type WorkflowKind, type WorkflowData, type WorkflowNodeType } from '../lib/imageWorkflow'
import { loadImageWorkflows, saveImageWorkflows, type ImageWorkflowLibrary, type SavedImageWorkflow } from '../lib/imageWorkflowStorage'

type StudioTab = 'workflow' | 'process' | 'edit'
const defaultSettings: ImageStudioSettings = { baseUrl: '', model: '', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true }
const defaultCapabilities: ImageStudioCapabilities = { models: [], sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto'], qualities: ['low', 'medium', 'high', 'auto'], moderations: ['auto', 'low'], supportsImageInput: true, supportsMask: true }
const defaultPerfectPixelOptions: PerfectPixelOptions = { sampleMethod: 'center', minSize: 4, peakWidth: 6, refineIntensity: 0.3, fixSquare: true }

function errorText(error: unknown): string { return reportClientFailure(error) }
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
function nodeSubtitle(data: WorkflowData): string { if (data.kind === 'prompt') return '独立提示词输入'; if (data.kind === 'reference') return data.referenceLabel || '未选择图片'; if (data.kind === 'generate') return `${findImageStudioPreset(data.presetId)?.label ? `${findImageStudioPreset(data.presetId)!.label} · ` : ''}${data.count || 1} 张`; if (data.kind === 'process') return data.operation === 'perfect-pixel' ? 'PerfectPixel' : data.operation === 'remove-background' ? '纯色去背' : '不处理'; return '结果预览与保存' }
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
    const complete = Boolean(data.outputAsset)
    const loading = data.outputStatus === 'loading'
    const cancelled = data.outputStatus === 'cancelled'
    return <div className="image-workflow-node image-workflow-node-output" data-output-status={data.outputStatus} aria-busy={loading}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={complete && data.outputStatus === 'done'} title="作为参考图连接到生图节点" />
      <div className="image-output-heading"><strong>结果{data.outputIndex ? ` ${String(data.outputIndex).padStart(2, '0')}` : ''}</strong><span>{complete ? '已完成' : loading ? data.subtitle === '等待生成' ? '排队中' : '进行中' : cancelled ? '已停止' : '未完成'}</span></div>
      {complete ? <button className="image-output-preview nodrag" title="放大预览" onClick={event => { event.stopPropagation(); data.onOpenOutput?.(data.outputAsset!) }}><img src={data.outputAsset!.dataUrl} alt="生成结果" /></button>
        : <div className={loading ? 'image-output-loading' : cancelled ? 'image-output-cancelled' : 'image-output-error'} title={data.outputError}>
          {loading ? <LoaderCircle className="spin" size={22} /> : <ImageIcon size={23} />}
          <small>{loading ? data.subtitle || '等待生成' : cancelled ? '本轮已停止' : '未能完成'}</small>
          {!loading && data.outputError ? <span>{describeClientFailure(data.outputError)}</span> : <span>图片完成后会显示在这里</span>}
        </div>}
      <div className={`image-output-actions nodrag${complete ? '' : ' is-placeholder'}`} aria-hidden={!complete || undefined}>
        {complete ? <><span>{data.outputAsset!.size === 'auto' ? '自动尺寸' : data.outputAsset!.size}</span><button title="放大预览" onClick={event => { event.stopPropagation(); data.onOpenOutput?.(data.outputAsset!) }}><ImageIcon size={13} /></button><button title="另存为" onClick={event => { event.stopPropagation(); data.onSaveOutput?.(data.outputAsset!) }}><Save size={13} /></button><button title="加入项目" onClick={event => { event.stopPropagation(); data.onAddOutputToProject?.(data.outputAsset!) }}><FolderOpen size={13} /></button></> : null}
      </div>
    </div>
  }
  return <div className={`image-workflow-node image-workflow-node-${data.kind}`}>{data.kind !== 'prompt' ? <Handle type="target" position={Position.Left} /> : null}<strong>{data.title}</strong><small>{data.subtitle}</small><Handle type="source" position={Position.Right} /></div>
}

const initialWorkflowNodes: WorkflowNodeType[] = [
  makeNode('prompt-1', 'prompt', { x: 40, y: 160 }, { prompt: '一个悬浮在深色石台上的蓝色水晶物品图标' }),
  makeNode('generate-1', 'generate', { x: 330, y: 160 }, { style: 'minecraft', size: '1024x1024', quality: 'medium', moderation: 'auto', count: 1 }),
  makeNode('process-1', 'process', { x: 625, y: 160 }, { operation: 'none' })
]
const initialWorkflowEdges: Edge[] = [
  { id: 'prompt-generate', source: 'prompt-1', target: 'generate-1', animated: true },
  { id: 'generate-process', source: 'generate-1', target: 'process-1' }
]
const workflowNodeTypes = { workflow: WorkflowNode }

export default function ImageStudioWorkspace({ visible, darkMode, onOpenSettings, resourceTarget, onCloseResource }: { visible: boolean; darkMode: boolean; onOpenSettings: () => void; resourceTarget?: import('../../../shared/resourcePack').ResourceImageTarget | null; onCloseResource?: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<StudioTab>('workflow')
  const [settings, setSettings] = useState<ImageStudioSettings>(defaultSettings)
  const [capabilities, setCapabilities] = useState<ImageStudioCapabilities>(defaultCapabilities)
  const [projectAssets, setProjectAssets] = useState<ProjectImageAsset[]>([])
  const [assets, setAssets] = useState<ImageAsset[]>([])
  const [active, setActive] = useState<ImageAsset | null>(null)
  const [previewAsset, setPreviewAsset] = useState<ImageAsset | null>(null)
  const [editorOpened, setEditorOpened] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [busy, setBusy] = useState(false)
  const runningRef = useRef(false)
  const stopRef = useRef(false)
  const storageLock = useRef(false)
  const workflowEpoch = useRef(0)
  const [storageBusy, setStorageBusy] = useState(false)
  const workflowMenuRef = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => {
    const close = (event: PointerEvent): void => { if (workflowMenuRef.current && !workflowMenuRef.current.contains(event.target as globalThis.Node)) workflowMenuRef.current.open = false }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && workflowMenuRef.current?.open) { workflowMenuRef.current.open = false; workflowMenuRef.current.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [])
  const [library, setLibrary] = useState<ImageWorkflowLibrary>({ version: 2, revision: 0, activeId: '', workflows: [] })
  const [workflowId, setWorkflowId] = useState('')
  const [workflowName, setWorkflowName] = useState('未命名工作流')
  const { confirm, dialog: workflowConfirmDialog } = useConfirmDialog()
  const { prompt: askName, dialog: workflowNameDialog } = usePromptDialog()
  useEffect(() => () => { stopRef.current = true }, [])
  const [message, setMessage] = useState('')
  const resourceBaseline = useRef('')
  useEffect(() => {
    if (!resourceTarget) return
    const asset: ImageAsset = { id: `resource:${resourceTarget.id}:${resourceTarget.file}`, dataUrl: resourceTarget.dataUrl, createdAt: '', model: 'resource-pack', style: 'minecraft', size: '', quality: 'auto', hosted: false, credits: 0 }
    resourceBaseline.current = resourceTarget.baseline
    setActive(asset); setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
    setProcessUndoStack([]); setTab('process'); setEditorOpened(false); setMessage('')
  }, [resourceTarget])
  const saveResourceImage = async (dataUrl: string): Promise<void> => {
    if (!resourceTarget) return
    const { projectPath, id, file } = resourceTarget
    await window.modmind.resourcePacks.write(projectPath, id, file, dataUrl, resourceBaseline.current)
    const saved = await window.modmind.resourcePacks.read(projectPath, id, file)
    resourceBaseline.current = saved.baseline
    setActive(current => current ? { ...current, dataUrl } : current)
    setMessage(`已保存到资源包：${file}`)
  }
  const [perfectPixelOptions, setPerfectPixelOptions] = useState<PerfectPixelOptions>(defaultPerfectPixelOptions)
  const [processUndoStack, setProcessUndoStack] = useState<ImageAsset[]>([])
  const [queue, setQueue] = useState<Array<{ id: string; label: string; status: 'queued' | 'running' | 'done' | 'error' | 'stopped' }>>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeType>(initialWorkflowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialWorkflowEdges)
  const flowRef = useRef<ReactFlowInstance<WorkflowNodeType, Edge> | null>(null)
  const needsInitialFitRef = useRef(true)
  const [workflowReady, setWorkflowReady] = useState(false)
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [activeImageSize, setActiveImageSize] = useState(0)
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)
  const selectedNode = selectedEdge ? undefined : nodes.find((node) => node.id === selectedNodeId)
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
    traceImageStudio('graph.connect', { connection, blocked: runningRef.current || storageLock.current, valid: connectionIsValid(connection, nodes, edges) })
    if (runningRef.current || storageLock.current) return
    if (!connectionIsValid(connection, nodes, edges)) { setMessage('这条连接不适用于当前节点，或会形成循环'); return }
    setEdges((current) => addEdge({ ...connection, animated: true }, current))
  }, [edges, nodes, setEdges])
  const onNodeClick: NodeMouseHandler<WorkflowNodeType> = useCallback((_event, node) => { setSelectedEdgeId(''); setSelectedNodeId(node.id); setNodes(current => current.map(item => ({ ...item, selected: item.id === node.id }))); setEdges(current => current.map(edge => ({ ...edge, selected: false }))) }, [setNodes, setEdges])
  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => { setSelectedNodeId(''); setSelectedEdgeId(edge.id); setNodes(current => current.map(node => ({ ...node, selected: false }))); setEdges((current) => current.map((item) => ({ ...item, selected: item.id === edge.id }))) }, [setEdges, setNodes])
  const onPaneClick = useCallback(() => { setSelectedNodeId(''); setSelectedEdgeId(''); setNodes(current => current.map(node => ({ ...node, selected: false }))); setEdges((current) => current.map((item) => item.selected ? { ...item, selected: false } : item)) }, [setEdges, setNodes])

  useEffect(() => {
    let disposed = false
    void loadImageWorkflows().then(saved => {
      if (disposed) return
      setLibrary(saved)
      const current = saved.workflows.find(item => item.id === saved.activeId)
      if (current) applyWorkflow(current)
      setWorkflowReady(true)
    }).catch(error => { if (!disposed) setMessage(`工作流载入失败：${errorText(error)}`) })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!visible) return
    needsInitialFitRef.current = true
    void tracedImageStudio().getSettings().then(setSettings).catch((error) => setMessage(errorText(error)))
    void tracedImageStudio().capabilities().then(setCapabilities).catch((error) => setMessage(errorText(error)))
    void window.modmind.project.listImageAssets().then(setProjectAssets).catch(() => setProjectAssets([]))
  }, [visible])

  useEffect(() => {
    if (!visible || tab !== 'workflow' || !workflowReady) return
    scheduleInitialFit()
  }, [scheduleInitialFit, tab, visible, workflowReady])


  const outputCallbacks = (): Pick<WorkflowData, 'onOpenOutput' | 'onSaveOutput' | 'onAddOutputToProject'> => ({
    onOpenOutput: value => { setProcessUndoStack([]); setActive(value); setPreviewAsset(value) },
    onSaveOutput: value => void saveAssetAs(value),
    onAddOutputToProject: value => void addAssetToProject(value)
  })
  const applyWorkflow = (saved: SavedImageWorkflow): void => {
    traceImageStudio('workflow.apply', saved)
    workflowEpoch.current += 1
    setWorkflowId(saved.id); setWorkflowName(saved.name)
    setNodes(saved.nodes.map(node => node.data.kind === 'output' ? { ...node, data: { ...node.data, ...outputCallbacks() } } : node))
    setEdges(saved.edges); setSelectedEdgeId(''); setSelectedNodeId('')
    const savedAssets = saved.nodes.flatMap(node => node.data.outputAsset ? [node.data.outputAsset] : [])
    setAssets(savedAssets); setActive(savedAssets[0] ?? null); setProcessUndoStack([])
    setQueue([]); setPreviewAsset(null)
    needsInitialFitRef.current = true; scheduleInitialFit()
  }
  const currentSnapshot = (id = workflowId || crypto.randomUUID(), name = workflowDisplayName(nodes)): SavedImageWorkflow => ({
    id, name, updatedAt: new Date().toISOString(), ...snapshotImageWorkflow({ nodes, edges })
  })
  const storeWorkflows = async (workflows: SavedImageWorkflow[], activeId: string): Promise<void> => {
    const saved = await saveImageWorkflows({ ...library, workflows, activeId })
    setLibrary(saved)
  }
  const manageWorkflow = async (action: 'save' | 'copy' | 'new' | 'rename' | 'delete' | 'switch' | 'reset', targetId?: string): Promise<void> => {
    traceImageStudio('workflow.manage', { action, targetId, workflowId, workflowName, blocked: runningRef.current || busy || storageLock.current || !workflowReady })
    if (runningRef.current || busy || storageLock.current || !workflowReady) return
    if (workflowMenuRef.current) workflowMenuRef.current.open = false
    storageLock.current = true; setStorageBusy(true)
    try {
      const name = workflowDisplayName(nodes)
      if (action === 'delete' && !await confirm({ title: '删除当前工作流？', message: `“${name.slice(0, 100)}”及其画布图片将被删除。`, confirmLabel: '删除', tone: 'danger' })) return
      if (action === 'reset' && !await confirm({ title: '恢复默认工作流？', message: '当前画布会先另存为备份，再恢复默认节点。', confirmLabel: '备份并恢复', actionIcon: 'restore' })) return
      const snapshot = currentSnapshot()
      const updated = [...library.workflows.filter(item => item.id !== snapshot.id), snapshot]
      if (action === 'switch') {
        const target = library.workflows.find(item => item.id === targetId)
        if (!target) throw new Error('工作流不存在')
        await storeWorkflows(updated, target.id); applyWorkflow(target)
      } else if (action === 'new' || action === 'copy') {
        const next = action === 'copy' ? currentSnapshot(crypto.randomUUID(), name) : { id: crypto.randomUUID(), name: '未命名工作流', updatedAt: new Date().toISOString(), ...snapshotImageWorkflow({ nodes: initialWorkflowNodes.map(node => node.data.kind === 'prompt' ? { ...node, data: { ...node.data, prompt: '' } } : node), edges: initialWorkflowEdges }) }
        await storeWorkflows([...updated, next], next.id); applyWorkflow(next)
      } else if (action === 'delete') {
        const remaining = library.workflows.filter(item => item.id !== workflowId)
        const next = remaining[0] ?? { id: crypto.randomUUID(), name: '新工作流', updatedAt: new Date().toISOString(), ...snapshotImageWorkflow({ nodes: initialWorkflowNodes, edges: initialWorkflowEdges }) }
        await storeWorkflows(remaining.length ? remaining : [next], next.id); applyWorkflow(next)
      } else if (action === 'reset') {
        const backup = currentSnapshot(crypto.randomUUID(), `${workflowName}（恢复前备份）`)
        const next = { ...snapshot, nodes: initialWorkflowNodes, edges: initialWorkflowEdges }
        await storeWorkflows([...library.workflows.filter(item => item.id !== next.id), backup, next], next.id); applyWorkflow(next)
      } else {
        const next = { ...snapshot, name }
        await storeWorkflows([...library.workflows.filter(item => item.id !== next.id), next], next.id)
        setWorkflowId(next.id); setWorkflowName(name)
      }
      setMessage(action === 'switch' ? '已保存当前画布并切换工作流' : '工作流已保存')
    } catch (error) { setMessage(`工作流未完成：${errorText(error)}`) }
    finally { storageLock.current = false; setStorageBusy(false) }
  }
  const saveWorkflow = (): void => { void manageWorkflow('save') }
  const resetWorkflow = (): void => { void manageWorkflow('reset') }

  const updateNode = (patch: Partial<WorkflowData>, nodeId = selectedNode?.id, epoch = workflowEpoch.current): void => {
    traceImageStudio('node.update', { nodeId, patch, epoch, currentEpoch: workflowEpoch.current, blocked: !selectedNode || epoch !== workflowEpoch.current || runningRef.current || storageLock.current })
    if (!selectedNode || epoch !== workflowEpoch.current || runningRef.current || storageLock.current) return
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node
      const data = { ...node.data, ...patch }
      data.subtitle = nodeSubtitle(data)
      return { ...node, data }
    }))
  }

  const addNode = (kind: WorkflowKind, data: Partial<WorkflowData> = {}): void => {
    traceImageStudio('node.add', { kind, blocked: runningRef.current || storageLock.current })
    if (runningRef.current || storageLock.current || busy || !workflowReady) return
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
    const canvas = document.querySelector('.image-studio-host:not([hidden]) .image-workflow-canvas') ?? document.querySelector('.image-workflow-canvas')
    const bounds = canvas?.getBoundingClientRect()
    const center = bounds && flowRef.current ? flowRef.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }) : { x: 400, y: 300 }
    const position = newWorkflowNodePosition(flowRef.current?.getNodes() ?? nodes, center)
    const defaults: Partial<WorkflowData> = kind === 'prompt' ? { prompt: '' } : kind === 'reference' ? {} : kind === 'generate' ? { style: 'free', size: '1024x1024', quality: 'medium', moderation: 'auto', count: 1 } : kind === 'process' ? { operation: 'none', perfectPixel: defaultPerfectPixelOptions } : {}
    setNodes((current) => [...current.map(node => ({ ...node, selected: false })), { ...makeNode(id, kind, position, { ...defaults, ...data }), selected: true }])
    setSelectedEdgeId('')
    setEdges(current => current.map(edge => ({ ...edge, selected: false })))
    if (kind === 'prompt' || kind === 'reference') {
      const target = nodes.find((node) => node.data.kind === 'generate' && (kind !== 'prompt' || !edges.some(edge => edge.target === node.id && nodes.find(item => item.id === edge.source)?.data.kind === 'prompt')))
      if (target && !edges.some((edge) => edge.source === id && edge.target === target.id)) setEdges((current) => [...current, { id: `${id}-${target.id}`, source: id, target: target.id, animated: true }])
    }
    setSelectedNodeId(id)
    window.requestAnimationFrame(() => { void flowRef.current?.setCenter(position.x + 90, position.y + 40, { zoom: flowRef.current.getZoom(), duration: 0 }) })
  }

  const deleteNodes = useCallback((deleted: WorkflowNodeType[]): void => {
    traceImageStudio('node.delete', { deletedIds: deleted.map(node => node.id), selectedIds: nodes.filter(node => node.selected).map(node => node.id), blocked: runningRef.current || storageLock.current })
    if (!deleted.length || runningRef.current || storageLock.current) return
    const deletedIds = new Set(deleted.map((node) => node.id))
    setNodes((current) => current.filter((node) => !deletedIds.has(node.id)))
    setEdges((current) => current.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target)))
    setSelectedNodeId((current) => deletedIds.has(current) ? '' : current)
    setSelectedEdgeId('')
  }, [nodes, setEdges, setNodes])

  const removeSelectedNode = (): void => { if (selectedNode && nodes.length > 1) deleteNodes([selectedNode]) }
  const removeSelectedEdge = (): void => { if (!selectedEdgeId || runningRef.current || storageLock.current) return; setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId('') }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!visible || tab !== 'workflow' || event.repeat || event.defaultPrevented || (event.key !== 'Delete' && event.key !== 'Backspace')) return
      const target = event.target as HTMLElement | null
      if (!target?.closest('.image-studio-page') || target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="combobox"]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      if (selectedEdgeId) removeSelectedEdge()
      else removeSelectedNode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedEdgeId, selectedNodeId, nodes, visible, tab])

  const generate = async (targetId?: string): Promise<void> => {
    traceImageStudio('workflow.run.requested', { targetId, busy, running: runningRef.current, storageLocked: storageLock.current, workflowReady })
    if (busy || runningRef.current || storageLock.current || !workflowReady) return
    let plan: ReturnType<typeof planImageWorkflow>
    try { plan = planImageWorkflow(nodes, edges, targetId) }
    catch (error) { traceImageStudio('workflow.plan.error', { error }); setMessage(errorText(error)); return }
    runningRef.current = true; stopRef.current = false; setBusy(true)
    const id = crypto.randomUUID()
    traceImageStudio('workflow.run.start', { runId: id, workflowId, targetId, plan })
    const slots = createWorkflowOutputSlots(plan, flowRef.current?.getNodes() ?? nodes, edges, id)
    const filled = new Set<string>()
    setNodes(current => [...current, ...slots])
    setEdges(current => [...current, ...slots.map(slot => ({ id: `${slot.data.outputSourceId}-${slot.id}`, source: slot.data.outputSourceId!, target: slot.id }))])
    // Frame the new result column once. Filling a result never moves the viewport.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (slots[0]) void flowRef.current?.fitView({ nodes: slots.slice(0, Math.min(2, slots.length)), duration: 0, padding: 0.22, maxZoom: 1 })
    }))
    let completed = 0
    setQueue(current => [...current.slice(-19), { id, label: `0/${plan.totalCount} 张`, status: 'running' }])
    setMessage(`开始工作流，预计生成 ${plan.totalCount} 张图片`)
    try {
      await runImageWorkflow(plan, tracedImageStudio(), {
        onNodeStart: nodeId => {
          traceImageStudio('workflow.node.start', { nodeId })
          const first = slots.find(slot => slot.data.outputSourceId === nodeId && !filled.has(slot.id))
          if (first) setNodes(current => current.map(node => node.id === first.id ? { ...node, data: { ...node.data, subtitle: plan.nodes.find(item => item.id === nodeId)?.data.kind === 'process' ? '正在处理…' : '正在生成…' } } : node))
        },
        stopped: () => stopRef.current,
        onProgress: (done, total) => { setQueue(current => current.map(item => item.id === id ? { ...item, label: `${done}/${total} 张` } : item)) },
        onAsset: (asset, sourceId) => {
          traceImageStudio('workflow.asset', { sourceId, asset })
          completed += 1
          let slot = slots.find(item => item.data.outputSourceId === sourceId && !filled.has(item.id))
          if (!slot) {
            // Preserve an unexpected extra result from an upstream provider, too.
            const source = plan.nodes.find(node => node.id === sourceId)!
            slot = makeNode(`runtime-output-${id}-extra-${completed}`, 'output', nextOutputColumn(source, [...nodes, ...slots], edges, 1), { outputRunId: id, outputSourceId: sourceId })
            slots.push(slot)
            setNodes(current => [...current, slot!])
            setEdges(current => [...current, { id: `${sourceId}-${slot!.id}`, source: sourceId, target: slot!.id }])
          }
          filled.add(slot.id)
          const outputId = slot.id
          const next = slots.find(item => item.data.outputSourceId === sourceId && !filled.has(item.id))
          setNodes(current => current.map(node => node.id === outputId ? { ...node, data: { ...node.data, outputStatus: 'done', outputAsset: asset, subtitle: '已完成', ...outputCallbacks() } }
            : node.id === next?.id ? { ...node, data: { ...node.data, subtitle: plan.nodes.find(item => item.id === sourceId)?.data.kind === 'process' ? '正在处理…' : '正在生成…' } } : node))
          setAssets(current => [asset, ...current]); setProcessUndoStack([]); setActive(asset)
        }
      })
      setQueue(current => current.map(item => item.id === id ? { ...item, status: 'done' } : item))
      setMessage(`工作流完成，已保留 ${completed} 张结果`)
    } catch (error) {
      traceImageStudio('workflow.run.error', { error, completed })
      const detail = errorText(error)
      setNodes(current => current.map(node => node.data.outputRunId === id && !node.data.outputAsset ? { ...node, data: { ...node.data, outputStatus: stopRef.current ? 'cancelled' : 'error', outputError: detail } } : node))
      setQueue(current => current.map(item => item.id === id ? { ...item, status: stopRef.current ? 'stopped' : 'error' } : item))
      setMessage(`${detail}；已保留 ${completed} 张结果`)
    } finally { traceImageStudio('workflow.run.end', { runId: id, completed, stopped: stopRef.current }); runningRef.current = false; setBusy(false) }
  }

  const revealLatestOutputs = (): void => {
    const latest = queue[queue.length - 1]?.id
    const outputs = nodes.filter(node => node.data.outputRunId === latest)
    if (outputs.length) void flowRef.current?.fitView({ nodes: outputs, duration: 0, padding: 0.2, maxZoom: 1 })
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
  const processActive = async (operation: 'perfect-pixel' | 'remove-background'): Promise<void> => { if (!active || busy) return; setBusy(true); setMessage(operation === 'perfect-pixel' ? '正在使用 PerfectPixel…' : '正在检测并去除纯色背景…'); try { const result = await tracedImageStudio().process(operation, active.dataUrl, operation === 'perfect-pixel' ? { perfectPixel: perfectPixelOptions } : undefined); const processed = { ...active, id: `${active.id}-${operation}`, dataUrl: result.dataUrl }; setProcessUndoStack((current) => [...current, active]); setActive(processed); setAssets((current) => current.map((item) => item.id === active.id ? processed : item)); setMessage(result.detail) } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) } }
  const saveAssetAs = async (asset: ImageAsset | null): Promise<void> => { if (!asset) return; try { const saved = await tracedImageStudio().saveAsset(asset.dataUrl, `modmind-${asset.style}-${Date.now()}`); if (saved) setMessage(`已保存：${saved}`) } catch (error) { setMessage(errorText(error)) } }
  const addAssetToProject = async (asset: ImageAsset | null): Promise<void> => { if (!asset) return; try { const saved = await tracedImageStudio().saveToProject(asset.dataUrl, `modmind-${asset.style}-${Date.now()}`); setMessage(`已加入项目：${saved}`) } catch (error) { setMessage(errorText(error)) } }
  const renderNodeEditor = (): React.JSX.Element | null => {
    if (selectedEdge) {
      const source = nodes.find((node) => node.id === selectedEdge.source)
      const target = nodes.find((node) => node.id === selectedEdge.target)
      return <div className="image-connection-editor"><strong>{source?.data.title || selectedEdge.source} → {target?.data.title || selectedEdge.target}</strong></div>
    }
    if (!selectedNode) return null
    const data = selectedNode.data
    if (data.kind === 'prompt') return <label className="field-label">提示词<textarea value={data.prompt || ''} onChange={(event) => updateNode({ prompt: event.target.value })} rows={9} /></label>
    if (data.kind === 'reference') return <><label className="field-label">本地参考图<label className="secondary-button compact image-reference-upload"><Upload size={14} />选择图片<input type="file" accept="image/*" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; const epoch = workflowEpoch.current; updateNode({ referenceImage: await readFileAsDataUrl(file), referenceLabel: file.name }, selectedNode.id, epoch) }} /></label></label>{projectAssets.length ? <label className="field-label">项目内图片<select value={data.referenceLabel?.startsWith('项目：') ? data.referenceLabel.slice(3) : ''} onChange={async (event) => { const path = event.target.value; if (!path) return; const epoch = workflowEpoch.current; updateNode({ referenceImage: await window.modmind.project.readImageAsset(path), referenceLabel: `项目：${path}` }, selectedNode.id, epoch) }}><option value="">选择项目资源</option>{projectAssets.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>)}</select></label> : <small className="image-editor-help">当前项目没有可用图片资源</small>}{data.referenceImage ? <img className="image-reference-thumb" src={data.referenceImage} alt="参考图" /> : null}</>
    if (data.kind === 'generate') return <><ImagePresetFields data={data} onChange={updateNode} /><label className="field-label">尺寸<select value={data.size || '1024x1024'} onChange={(event) => updateNode({ size: event.target.value })}>{capabilities.sizes.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">质量<select value={data.quality || 'medium'} onChange={(event) => updateNode({ quality: event.target.value as ImageStudioQuality })}>{capabilities.qualities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">审核<select value={data.moderation || 'auto'} onChange={(event) => updateNode({ moderation: event.target.value as 'auto' | 'low' })}>{capabilities.moderations.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field-label">批量数量<input type="number" min={1} max={10} value={data.count || 1} onChange={(event) => updateNode({ count: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })} /></label></>
    if (data.kind === 'process') return <><label className="field-label">处理方式<select value={data.operation || 'none'} onChange={(event) => updateNode({ operation: event.target.value as ProcessOperation })}><option value="none">不处理</option><option value="perfect-pixel">PerfectPixel</option><option value="remove-background">纯色去背</option></select></label>{data.operation === 'perfect-pixel' ? <PerfectPixelControls value={data.perfectPixel} onChange={(value) => updateNode({ perfectPixel: value })} /> : null}</>
    return data.outputStatus === 'loading' ? <p role="status">正在生成…</p> : data.outputAsset ? null : <p role="status">{data.outputError || '未生成图片'}</p>
  }

  traceImageStudioSnapshot({ workflowId, workflowName, visible, tab, workflowReady, busy, storageBusy, selectedNodeId, selectedEdgeId, nodes, edges, queue, active, assets, perfectPixelOptions, message, previewAssetId: previewAsset?.id, editorOpened, undoAssetIds: processUndoStack.map(asset => asset.id) })
  return <div className={`image-studio-page ${tab === 'edit' ? 'image-studio-editing' : ''}`}><div className="content-toolbar image-studio-toolbar-heading"><h1 className="visually-hidden">图像工坊</h1><div className="image-studio-toolbar-controls"><div className="image-studio-tabs" role="tablist" aria-label="图像工坊模式">
      <button ref={(element) => { studioTabRefs.current[0] = element }} id="image-tab-workflow" className={tab === 'workflow' ? 'active' : ''} role="tab" aria-selected={tab === 'workflow'} aria-controls="image-panel-workflow" tabIndex={tab === 'workflow' ? 0 : -1} onClick={() => selectStudioTab('workflow')} onKeyDown={onStudioTabKeyDown}><Sparkles size={15} />工作流</button>
      <button ref={(element) => { studioTabRefs.current[1] = element }} id="image-tab-process" className={tab === 'process' ? 'active' : ''} role="tab" aria-selected={tab === 'process'} aria-controls="image-panel-process" tabIndex={tab === 'process' ? 0 : -1} onClick={() => selectStudioTab('process')} onKeyDown={onStudioTabKeyDown}><Grid3X3 size={15} />处理</button>
      <button ref={(element) => { studioTabRefs.current[2] = element }} id="image-tab-edit" className={tab === 'edit' ? 'active' : ''} role="tab" aria-selected={tab === 'edit'} aria-controls="image-panel-edit" tabIndex={tab === 'edit' ? 0 : -1} onClick={() => selectStudioTab('edit')} onKeyDown={onStudioTabKeyDown}><ImageIcon size={15} />编辑</button>
    </div><div className="image-studio-status">{import.meta.env?.VITE_IMAGE_TRACE === '1' ? <small data-image-recording-status /> : null} <span className={`status-dot ${busy ? 'warning' : 'success'}`} />{settings.hasStoredKey ? '自有图片 Key' : 'ModMind 托管额度'}<button className="icon-button" title="打开图像服务设置" onClick={onOpenSettings}><Settings2 size={15} /></button></div></div></div>
    {tab === 'workflow' ? <div className="image-workflow-library">
      <ImageWorkflowSwitcher workflows={library.workflows} activeId={workflowId} name={workflowDisplayName(nodes)} disabled={busy || storageBusy || !workflowReady} onSelect={id => void manageWorkflow('switch', id)} />
      {storageBusy || !workflowReady || !workflowId ? <span className="image-workflow-save-state" role="status">{storageBusy ? '正在保存…' : !workflowReady ? '正在载入…' : '尚未保存'}</span> : null}
      <div className="image-workflow-library-actions"><MoreActions label="添加节点" text="添加节点" icon={<Plus size={15} />}><button disabled={busy || storageBusy || !workflowReady} onClick={() => addNode('prompt')}><Plus size={13} />提示词</button><button disabled={busy || storageBusy || !workflowReady} onClick={() => addNode('reference')}><Plus size={13} />参考图</button><button disabled={busy || storageBusy || !workflowReady} onClick={() => addNode('generate')}><Plus size={13} />生图</button><button disabled={busy || storageBusy || !workflowReady} onClick={() => addNode('process')}><Plus size={13} />处理</button></MoreActions><button className="primary-button compact" disabled={busy || storageBusy || !workflowReady} onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}运行工作流</button>{busy ? <button className="secondary-button image-tool-button" onClick={() => { traceImageStudio('workflow.stop.requested'); stopRef.current = true; setMessage('将在当前请求完成后停止，结果会保留') }}>完成当前请求后停止</button> : null}
        <button className="secondary-button compact" disabled={busy || storageBusy || !workflowReady} onClick={saveWorkflow}><Save size={14} />保存</button>
        <button className="secondary-button compact" disabled={busy || storageBusy || !workflowReady} onClick={() => void manageWorkflow('new')}><Plus size={14} />新建</button>
        <details ref={workflowMenuRef} className="image-workflow-menu">
          <summary aria-label="更多工作流操作" title="更多工作流操作"><Ellipsis size={18} /></summary>
          <div className="image-workflow-menu-panel">
            <button disabled={busy || storageBusy || !workflowReady} onClick={() => void manageWorkflow('copy')}><Copy size={15} />另存为新工作流</button>
            <button disabled={busy || storageBusy || !workflowReady} onClick={resetWorkflow}><RotateCcw size={15} />恢复默认工作流</button>
            <div className="image-workflow-menu-divider" />
            <button className="image-workflow-delete" disabled={busy || storageBusy || !workflowReady || !workflowId} onClick={() => void manageWorkflow('delete')}><Trash2 size={15} />删除工作流</button>
          </div>
        </details>
      </div>
    </div> : null}
    {tab === 'workflow' && queue.length > 0 ? <details className="image-queue"><summary><span className="image-workflow-run-progress"><span />{queue[queue.length - 1]?.status === 'running' ? `正在生成 · ${queue[queue.length - 1].label}` : `生成记录 · ${queue.length} 轮`}</span><button type="button" className="image-workflow-reveal" onClick={event => { event.preventDefault(); revealLatestOutputs() }}>定位本轮结果</button></summary>{queue.slice(-5).map((item) => <div className="image-queue-row" key={item.id}><span>{item.label}</span><small>{item.status === 'running' ? '运行中' : item.status === 'done' ? '完成' : item.status === 'error' ? '失败' : item.status === 'stopped' ? '已停止' : '排队'}</small></div>)}</details> : null}
    {resourceTarget ? <div className="resource-pack-toolbar"><span>当前资源：{resourceTarget.file}</span><div className="resource-pack-actions"><button className="primary-button" disabled={busy || !active || tab === 'edit'} onClick={() => active && void saveResourceImage(active.dataUrl).catch(error => setMessage(errorText(error)))}><Save size={15} />保存到资源包</button><button className="secondary-button" disabled={busy} onClick={onCloseResource}>返回资源包</button></div></div> : null}
    {tab === 'workflow' ? <div id="image-panel-workflow" role="tabpanel" aria-labelledby="image-tab-workflow"><div className={`image-workflow-layout${selectedNode || selectedEdge ? ' has-selection' : ''}`}><section className="image-workflow-canvas"><ReactFlow colorMode={darkMode ? 'dark' : 'light'} nodes={nodes} edges={edges} onNodesChange={(changes) => { if (!runningRef.current && !storageLock.current) onNodesChange(changes) }} onEdgesChange={(changes) => { if (!runningRef.current && !storageLock.current) onEdgesChange(changes) }} nodesDraggable={!busy && !storageBusy} nodesConnectable={!busy && !storageBusy} onNodesDelete={deleteNodes} deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null} onConnect={onConnect} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={onPaneClick} onInit={(instance) => { flowRef.current = instance; if (visible && workflowReady) scheduleInitialFit() }} nodeTypes={workflowNodeTypes}><MiniMap pannable zoomable /><Controls /><Background gap={18} size={1} /></ReactFlow></section>{selectedNode || selectedEdge ? <aside className="image-workflow-sidebar"><div className="image-panel-title"><Settings2 size={16} />{selectedEdge ? '连接' : selectedNode ? `${selectedNode.data.title} 节点` : '节点参数'}<button className="icon-button" title={selectedEdge ? '删除连接' : '删除当前节点'} disabled={busy || storageBusy || (selectedEdge ? false : (!selectedNode || nodes.length <= 1))} onClick={selectedEdge ? removeSelectedEdge : removeSelectedNode}><Trash2 size={14} /></button></div><fieldset className="image-workflow-fields" disabled={busy || storageBusy || !workflowReady}>{renderNodeEditor()}</fieldset>{selectedNode && ['generate', 'process'].includes(selectedNode.data.kind) ? <button className="secondary-button image-tool-button" disabled={busy || storageBusy || !workflowReady} onClick={() => void generate(selectedNode.id)}>运行选中节点及其依赖</button> : null}</aside> : null}</div></div> : null}
    {tab === 'process' ? <div id="image-panel-process" role="tabpanel" aria-labelledby="image-tab-process"><div className="image-process-layout"><section className="image-process-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file) }}><Upload size={28} /><strong>上传图片</strong><label className="secondary-button compact"><FolderOpen size={14} />选择图片<input type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} /></label></section><section className="image-process-preview"><div className="image-panel-title"><ImageIcon size={16} />预览</div>{active ? <img className={activeIsPixelated ? 'image-pixelated-preview' : undefined} src={active.dataUrl} alt="待处理图片" /> : <div className="image-empty"><ImageIcon size={30} /><p>先上传或生成图片</p></div>}</section><aside className="image-process-tools"><div className="image-panel-title"><Grid3X3 size={16} />工具</div><PerfectPixelControls value={perfectPixelOptions} onChange={setPerfectPixelOptions} /><button className="secondary-button image-tool-button" disabled={!active || busy} onClick={() => void processActive('perfect-pixel')}><Grid3X3 size={15} />PerfectPixel</button><button className="secondary-button image-tool-button" disabled={!processUndoStack.length || busy} onClick={undoProcess}><Undo2 size={15} />撤销上一步</button><button className="secondary-button image-tool-button" disabled={!active || busy} onClick={() => void processActive('remove-background')}><Eraser size={15} />纯色去背</button><button className="secondary-button image-tool-button" disabled={!active} onClick={openEditor}><ImageIcon size={15} />在编辑器中打开</button></aside></div></div> : null}
    {tab === 'edit' ? <div id="image-panel-edit" className="image-edit-layout" role="tabpanel" aria-labelledby="image-tab-edit">{editorOpened && active ? <MiniPaintEditor asset={active} darkMode={darkMode} onError={setMessage} onSave={resourceTarget ? saveResourceImage : undefined} /> : <div className="image-editor-empty"><div className="image-editor-empty-icon"><ImageIcon size={25} /></div><h2>开始编辑图片</h2><div className="image-editor-empty-actions"><button className="primary-button" onClick={startNewCanvas}><Plus size={16} />新建画布</button><label className="secondary-button"><Upload size={16} />导入图片<input type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) { void upload(file).then(() => { setEditorOpened(true) }) } }} /></label></div></div>}</div> : null}
    {previewAsset ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setPreviewAsset(null)}><div className="image-result-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="image-panel-title"><span>生成结果</span><button className="icon-button" title="关闭预览" onClick={() => setPreviewAsset(null)}>×</button></div><img src={previewAsset.dataUrl} alt="生成结果大图" /><div className="dialog-footer"><button className="secondary-button" onClick={() => void saveAssetAs(previewAsset)}><Save size={15} />另存为</button><button className="primary-button" onClick={() => void addAssetToProject(previewAsset)}><FolderOpen size={15} />加入项目</button></div></div></div> : null}
    <ImageWorkflowPaste enabled={visible && tab === 'workflow' && workflowReady && !busy && !storageBusy} epoch={workflowEpoch.current} onPaste={({ kind, data }) => { traceImageStudio('clipboard.paste', { kind, data }); addNode(kind, data); setMessage(kind === 'prompt' ? '已粘贴为提示词节点' : '已粘贴为参考图节点') }} onMessage={setMessage} />
    {workflowConfirmDialog}{workflowNameDialog}
    {message ? <div className="image-studio-message" role="status">{message}<button className="icon-button" aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div> : null}</div>
}
