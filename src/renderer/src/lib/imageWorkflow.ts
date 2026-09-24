import type { Connection, Edge, Node } from '@xyflow/react'
import { findImageStudioPreset, imageWorkflowPrompt } from './imageStudioPresets'
import type { ImageAsset, ImageGenerationRequest, ImageGenerationResult, ImageProcessingOptions, ImageProcessingResult, ImageStudioStyle, ImageStudioQuality, PerfectPixelOptions } from '../../../shared/imageStudio'

export type WorkflowKind = 'prompt' | 'reference' | 'generate' | 'process' | 'output'
export type ProcessOperation = 'none' | 'perfect-pixel' | 'remove-background'
export type WorkflowData = {
  kind: WorkflowKind
  title: string
  subtitle: string
  prompt?: string
  referenceImage?: string
  referenceLabel?: string
  style?: ImageStudioStyle
  presetId?: string
  presetPrompt?: string
  size?: string
  quality?: ImageStudioQuality
  moderation?: 'auto' | 'low'
  count?: number
  operation?: ProcessOperation
  perfectPixel?: PerfectPixelOptions
  outputStatus?: 'loading' | 'done' | 'error' | 'cancelled'
  outputRunId?: string
  outputSourceId?: string
  outputIndex?: number
  outputTotal?: number
  outputAsset?: ImageAsset
  outputError?: string
  onOpenOutput?: (asset: ImageAsset) => void
  onSaveOutput?: (asset: ImageAsset) => void
  onAddOutputToProject?: (asset: ImageAsset) => void
}
export type WorkflowNodeType = Node<WorkflowData>

export function imageProducingKind(kind: WorkflowKind): boolean { return kind === 'reference' || kind === 'generate' || kind === 'process' || kind === 'output' }

export function connectionIsValid(connection: Connection, nodes: WorkflowNodeType[], edges: Edge[]): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  if (edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) return false
  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return false
  if (source.data.kind === 'prompt' && edges.some(edge => edge.target === target.id && nodes.find(node => node.id === edge.source)?.data.kind === 'prompt')) return false
  const allowed = source.data.kind === 'output'
    ? Boolean(source.data.outputAsset) && source.data.outputStatus === 'done' && target.data.kind === 'generate'
    : (source.data.kind === 'prompt' || source.data.kind === 'reference')
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

export interface ImageWorkflowGraph { nodes: WorkflowNodeType[]; edges: Edge[] }
export interface ImageWorkflowPlan extends ImageWorkflowGraph { totalCount: number }

/** Output nodes are immutable snapshots. Their incoming edges only record provenance. */
export function planImageWorkflow(nodes: WorkflowNodeType[], edges: Edge[], targetId?: string): ImageWorkflowPlan {
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('工作流存在重复节点，请删除重复节点')
  if (edges.some(edge => !byId.has(edge.source) || !byId.has(edge.target))) throw new Error('工作流存在失效连线，请删除后重新连接')
  if (!topologicalNodes(nodes, edges)) throw new Error('工作流包含循环连接，无法执行')
  for (const edge of edges) {
    // Output incoming edges describe the saved image's origin, never an executable input.
    if (byId.get(edge.target)?.data.kind === 'output') continue
    if (!connectionIsValid({ source: edge.source, target: edge.target, sourceHandle: null, targetHandle: null }, nodes, edges.filter(item => item !== edge))) throw new Error('工作流存在不兼容、重复的连线或多个提示词，请检查连接')
  }
  const computational = (node: WorkflowNodeType): boolean => node.data.kind === 'generate' || node.data.kind === 'process'
  const frozen = new Set<string>()
  const freezeAncestors = (id: string): void => {
    if (frozen.has(id)) return
    frozen.add(id)
    edges.filter(edge => edge.target === id).forEach(edge => freezeAncestors(edge.source))
  }
  nodes.filter(node => node.data.kind === 'output' && edges.some(edge => edge.source === node.id)).forEach(node => {
    edges.filter(edge => edge.target === node.id).forEach(edge => freezeAncestors(edge.source))
  })
  // A leftover processing tail of a frozen producer must not trigger that producer again.
  for (const node of topologicalNodes(nodes, edges)!) {
    const inputs = edges.filter(edge => edge.target === node.id && imageProducingKind(byId.get(edge.source)!.data.kind))
    if (node.data.kind === 'process' && inputs.length && inputs.every(edge => frozen.has(edge.source))) frozen.add(node.id)
  }
  const targets = targetId ? nodes.filter(node => node.id === targetId && computational(node)) : nodes.filter(node => computational(node) && !frozen.has(node.id) && !edges.some(edge => {
    if (edge.source !== node.id) return false
    const target = byId.get(edge.target)!
    return computational(target) || (target.data.kind === 'output' && edges.some(next => next.source === target.id))
  }))
  if (!targets.length) throw new Error('没有可运行的生图或处理节点，请检查是否存在循环连接')
  const needed = new Set<string>()
  const visit = (id: string): void => {
    if (needed.has(id)) return
    needed.add(id)
    if (byId.get(id)?.data.kind === 'output') return
    edges.filter(edge => edge.target === id).forEach(edge => visit(edge.source))
  }
  targets.forEach(node => visit(node.id))
  const runNodes = nodes.filter(node => needed.has(node.id))
  const runEdges = edges.filter(edge => needed.has(edge.source) && needed.has(edge.target) && byId.get(edge.target)?.data.kind !== 'output')
  const ordered = topologicalNodes(runNodes, runEdges)
  if (!ordered) throw new Error('工作流包含循环连接，无法执行')
  const counts = new Map<string, number>()
  let totalCount = 0
  for (const node of ordered) {
    const incoming = runEdges.filter(edge => edge.target === node.id).map(edge => byId.get(edge.source)!)
    if (node.data.kind === 'reference' || node.data.kind === 'output') {
      const image = node.data.kind === 'reference' ? node.data.referenceImage : node.data.outputAsset?.dataUrl
      if (!image?.startsWith('data:image/')) throw new Error(`“${node.data.title}”没有可用参考图片`)
      counts.set(node.id, 1)
    }
    if (node.data.kind === 'generate') {
      const prompts = incoming.filter(item => item.data.kind === 'prompt')
      const preset = findImageStudioPreset(node.data.presetId)
      if (node.data.presetId && !preset) throw new Error(`“${node.data.title}”的预设不可用，请重新选择`)
      const prompt = imageWorkflowPrompt(node.data, prompts[0]?.data.prompt)
      if (prompts.length > 1 || !prompt) throw new Error(preset ? `“${node.data.title}”的预设提示词不能为空` : `“${node.data.title}”需要连接且只能连接一个有效提示词`)
      if (prompt.length > 32_000) throw new Error('图片描述不能超过 32000 个字符（含预设与补充要求）')
      const count = node.data.count ?? 1
      if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('每个生图节点的数量必须是 1～10 的整数')
      const inputCount = incoming.filter(item => imageProducingKind(item.data.kind)).reduce((sum, item) => sum + (counts.get(item.id) ?? 0), 0)
      if (preset?.requiresReference && !inputCount) throw new Error(`“${preset.label}”需要参考图，请连接参考图、已有结果或上游图片节点`)
      const outputCount = count * Math.max(1, inputCount)
      counts.set(node.id, outputCount)
      totalCount += outputCount
      if (totalCount > 100) throw new Error('工作流级联生成超过 100 张，请减少节点数量或批量数量')
    }
    if (node.data.kind === 'process') {
      const count = incoming.filter(item => imageProducingKind(item.data.kind)).reduce((sum, item) => sum + (counts.get(item.id) ?? 0), 0)
      if (!count) throw new Error(`“${node.data.title}”需要连接图片输入`)
      counts.set(node.id, count)
    }
  }
  return { nodes: ordered, edges: runEdges, totalCount }
}

export async function runImageWorkflow(plan: ImageWorkflowPlan, api: {
  generate: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>
  process: (operation: 'perfect-pixel' | 'remove-background', dataUrl: string, options?: ImageProcessingOptions) => Promise<ImageProcessingResult>
}, options: {
  stopped?: () => boolean
  onAsset: (asset: ImageAsset, sourceId: string) => void
  onProgress?: (completed: number, total: number) => void
  onNodeStart?: (nodeId: string) => void
}): Promise<void> {
  const values = new Map<string, ImageAsset[]>()
  let completed = 0
  const checkStopped = (): void => { if (options.stopped?.()) throw new Error('工作流已停止，已完成的图片已保留') }
  for (const node of plan.nodes) {
    checkStopped()
    options.onNodeStart?.(node.id)
    const incoming = plan.edges.filter(edge => edge.target === node.id).map(edge => plan.nodes.find(item => item.id === edge.source)!)
    if (node.data.kind === 'output') values.set(node.id, [node.data.outputAsset!])
    if (node.data.kind === 'reference') values.set(node.id, [{ id: node.id, dataUrl: node.data.referenceImage!, createdAt: '', model: 'reference', style: 'free', size: 'original', quality: 'auto', hosted: false, credits: 0 }])
    if (node.data.kind === 'generate') {
      const prompt = imageWorkflowPrompt(node.data, incoming.find(item => item.data.kind === 'prompt')?.data.prompt)
      const images = incoming.filter(item => imageProducingKind(item.data.kind)).flatMap(item => values.get(item.id) ?? [])
      const output: ImageAsset[] = []
      for (const reference of images.length ? images : [null]) {
        for (let index = 0; index < (node.data.count ?? 1); index += 1) {
          checkStopped()
          const result = await api.generate({ prompt, style: node.data.presetId ? 'free' : node.data.style ?? 'free', size: node.data.size ?? '1024x1024', quality: node.data.quality ?? 'medium', moderation: node.data.moderation ?? 'auto', count: 1, background: !node.data.presetId && node.data.style === 'minecraft' ? 'solid' : 'auto', backgroundColor: '#ffffff', removeBackground: false, source: 'manual', ...(reference ? { referenceImage: reference.dataUrl } : {}) })
          for (const asset of result.assets) { output.push(asset); options.onAsset(asset, node.id) }
          if (result.error) throw new Error(result.error)
          if (!result.assets.length) throw new Error('图片服务没有返回图片，已停止后续生成')
          completed += 1
          options.onProgress?.(completed, plan.totalCount)
        }
      }
      values.set(node.id, output)
    }
    if (node.data.kind === 'process') {
      const images = incoming.flatMap(item => values.get(item.id) ?? [])
      const output: ImageAsset[] = []
      for (const asset of images) {
        checkStopped()
        if (!node.data.operation || node.data.operation === 'none') { output.push(asset); continue }
        const result = await api.process(node.data.operation, asset.dataUrl, node.data.operation === 'perfect-pixel' ? { perfectPixel: node.data.perfectPixel } : undefined)
        const next = { ...asset, id: `${asset.id}-${node.id}`, dataUrl: result.dataUrl }
        output.push(next)
        options.onAsset(next, node.id)
      }
      values.set(node.id, output)
    }
  }
  checkStopped()
}

/** Strip callbacks, measurements and selection state while retaining actual image results. */
export function snapshotImageWorkflow(graph: ImageWorkflowGraph): ImageWorkflowGraph {
  return {
    nodes: graph.nodes.filter(node => node.data.kind !== 'output' || node.data.outputAsset).map(node => {
      const { onOpenOutput, onSaveOutput, onAddOutputToProject, ...data } = node.data
      return { id: node.id, type: 'workflow', position: { ...node.position }, data: { ...data } }
    }),
    edges: graph.edges.filter(edge => graph.nodes.some(node => node.id === edge.source && (node.data.kind !== 'output' || node.data.outputAsset)) && graph.nodes.some(node => node.id === edge.target && (node.data.kind !== 'output' || node.data.outputAsset))).map(edge => ({ id: edge.id, source: edge.source, target: edge.target }))
  }
}

export function topologicalNodes(nodes: WorkflowNodeType[], edges: Edge[]): WorkflowNodeType[] | null {
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
