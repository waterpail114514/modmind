import type { Edge, XYPosition } from '@xyflow/react'
import { type ImageWorkflowPlan, type WorkflowNodeType } from './imageWorkflow'

export const OUTPUT_SIZE = { width: 224, height: 242 }
const GAP = 32
const COLUMN_GAP = 88

export function workflowDisplayName(nodes: WorkflowNodeType[], fallback = '未命名工作流'): string {
  return nodes.find(node => node.data.kind === 'prompt')?.data.prompt?.trim().replace(/\s+/g, ' ') || fallback
}

export function workflowNodeSize(node: WorkflowNodeType): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? (node.data.kind === 'output' ? OUTPUT_SIZE.width : 180),
    height: node.measured?.height ?? node.height ?? (node.data.kind === 'output' ? OUTPUT_SIZE.height : 80)
  }
}

function overlaps(position: XYPosition, size: { width: number; height: number }, node: WorkflowNodeType): boolean {
  const other = workflowNodeSize(node)
  return position.x < node.position.x + other.width + GAP && position.x + size.width + GAP > node.position.x
    && position.y < node.position.y + other.height + GAP && position.y + size.height + GAP > node.position.y
}

/** Find the nearest vacant place, starting at the current visible canvas centre. */
export function newWorkflowNodePosition(nodes: WorkflowNodeType[], center: XYPosition): XYPosition {
  const size = { width: 180, height: 80 }
  const origin = { x: center.x - size.width / 2, y: center.y - size.height / 2 }
  for (let ring = 0; ring <= nodes.length + 1; ring += 1) {
    const candidates: XYPosition[] = []
    for (let x = -ring; x <= ring; x += 1) for (let y = -ring; y <= ring; y += 1) {
      if (Math.max(Math.abs(x), Math.abs(y)) === ring) candidates.push({ x: origin.x + x * (size.width + GAP), y: origin.y + y * (size.height + GAP) })
    }
    candidates.sort((a, b) => (a.x - origin.x) ** 2 + (a.y - origin.y) ** 2 - (b.x - origin.x) ** 2 - (b.y - origin.y) ** 2)
    const vacant = candidates.find(position => !nodes.some(node => overlaps(position, size, node)))
    if (vacant) return vacant
  }
  return { x: Math.max(origin.x, ...nodes.map(node => node.position.x + workflowNodeSize(node).width + GAP)), y: origin.y }
}

/** Presentation-only counts: match the existing runner, including reference fan-out and processing. */
export function workflowOutputCounts(plan: ImageWorkflowPlan): Map<string, number> {
  const counts = new Map<string, number>()
  const outputs = new Map<string, number>()
  for (const node of plan.nodes) {
    const inputCount = plan.edges.filter(edge => edge.target === node.id).reduce((sum, edge) => sum + (counts.get(edge.source) ?? 0), 0)
    if (node.data.kind === 'reference' || node.data.kind === 'output') counts.set(node.id, 1)
    if (node.data.kind === 'generate') {
      const count = (node.data.count ?? 1) * Math.max(1, inputCount)
      counts.set(node.id, count); outputs.set(node.id, count)
    }
    if (node.data.kind === 'process') {
      counts.set(node.id, inputCount)
      if (node.data.operation && node.data.operation !== 'none') outputs.set(node.id, inputCount)
    }
  }
  return outputs
}

export function nextOutputColumn(source: WorkflowNodeType, nodes: WorkflowNodeType[], edges: Edge[], count: number): XYPosition {
  const previous = nodes.filter(node => node.data.kind === 'output' && (node.data.outputSourceId === source.id || edges.some(edge => edge.source === source.id && edge.target === node.id)))
  let x = Math.max(source.position.x + workflowNodeSize(source).width + COLUMN_GAP, ...previous.map(node => node.position.x + workflowNodeSize(node).width + COLUMN_GAP))
  const y = source.position.y
  const size = { width: OUTPUT_SIZE.width, height: Math.max(1, count) * (OUTPUT_SIZE.height + GAP) - GAP }
  // Keep a round in one column. Skip occupied columns instead of pushing it below older rounds.
  while (true) {
    const collisions = nodes.filter(node => overlaps({ x, y }, size, node))
    if (!collisions.length) return { x, y }
    x = Math.max(...collisions.map(node => node.position.x + workflowNodeSize(node).width + COLUMN_GAP))
  }
}

export function createWorkflowOutputSlots(plan: ImageWorkflowPlan, nodes: WorkflowNodeType[], edges: Edge[], runId: string): WorkflowNodeType[] {
  const slots: WorkflowNodeType[] = []
  for (const [sourceId, count] of workflowOutputCounts(plan)) {
    const source = plan.nodes.find(node => node.id === sourceId)!
    const position = nextOutputColumn(source, [...nodes, ...slots], edges, count)
    for (let index = 0; index < count; index += 1) slots.push({
      id: `runtime-output-${runId}-${sourceId}-${index}`, type: 'workflow',
      position: { x: position.x, y: position.y + index * (OUTPUT_SIZE.height + GAP) },
      ...OUTPUT_SIZE,
      data: { kind: 'output', title: '输出', subtitle: '等待生成', outputStatus: 'loading', outputRunId: runId, outputSourceId: sourceId, outputIndex: index + 1, outputTotal: count }
    })
  }
  return slots
}
