import { describe, expect, it, vi } from 'vitest'
import { planImageWorkflow, runImageWorkflow, type WorkflowNodeType, type WorkflowKind } from './imageWorkflow'
import { createWorkflowOutputSlots, newWorkflowNodePosition, nextOutputColumn, OUTPUT_SIZE, workflowDisplayName, workflowOutputCounts } from './imageWorkflowPresentation'

const node = (id: string, kind: WorkflowKind, x = 0, y = 0, data: Partial<WorkflowNodeType['data']> = {}): WorkflowNodeType => ({ id, position: { x, y }, data: { kind, title: id, subtitle: '', ...data } })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const asset = { id: 'image', dataUrl: 'data:image/png;base64,AA==', model: 'test', createdAt: '', style: 'free' as const, quality: 'medium' as const, size: '1024x1024', hosted: false, credits: 0 }

describe('workflow presentation', () => {
  it('names from the first prompt, normalizes whitespace, and retains the full long title for fading', () => {
    const text = '很长的提示词'.repeat(100)
    expect(workflowDisplayName([node('p', 'prompt', 0, 0, { prompt: `  ${text}\n后半部分 ` })])).toBe(`${text} 后半部分`)
    expect(workflowDisplayName([node('p', 'prompt'), node('p2', 'prompt', 0, 0, { prompt: 'second' })])).toBe('未命名工作流')
    expect(workflowDisplayName([])).toBe('未命名工作流')
  })

  it('places a new node in the visible centre, avoiding occupied nodes and large measured images', () => {
    const center = { x: 1900, y: -750 }
    expect(newWorkflowNodePosition([], center)).toEqual({ x: 1810, y: -790 })
    const occupied = node('existing', 'output', 1700, -900)
    occupied.measured = { width: 500, height: 500 }
    const position = newWorkflowNodePosition([occupied], center)
    expect(position.x + 180 <= 1700 || position.x >= 2200 || position.y + 80 <= -900 || position.y >= -400).toBe(true)
  })

  it('extends rounds right from their own producer and each result down within the round', () => {
    const p = node('p', 'prompt', 0, 80, { prompt: 'cat' })
    const g = node('g', 'generate', 400, 80, { count: 3 })
    const unrelated = node('other-output', 'output', 9000, 2000)
    const plan = planImageWorkflow([p, g], [edge('p', 'g')])
    const first = createWorkflowOutputSlots(plan, [p, g, unrelated], [], 'first')
    expect(first).toHaveLength(3)
    expect(first.map(item => item.position.x)).toEqual([668, 668, 668])
    expect(first.map(item => item.position.y)).toEqual([80, 354, 628])
    expect(first.every(item => item.data.outputStatus === 'loading' && item.data.outputSourceId === 'g')).toBe(true)
    const second = createWorkflowOutputSlots(plan, [p, g, ...first], [], 'second')
    expect(second[0].position.x).toBe(first[0].position.x + OUTPUT_SIZE.width + 88)
    expect(second[0].position.y).toBe(80)
  })

  it('avoids occupied columns and understands output provenance from older saves', () => {
    const source = node('g', 'generate', 0, 0)
    const old = node('old', 'output', 280, 0)
    const obstacle = node('process', 'process', 600, 0)
    expect(nextOutputColumn(source, [source, old, obstacle], [edge('g', 'old')], 3)).toEqual({ x: 868, y: 0 })
  })

  it('matches existing generation fan-out and processing without changing requests', async () => {
    const nodes = [node('p', 'prompt', 0, 0, { prompt: 'cat' }), node('g', 'generate', 300, 0, { count: 3 }),
      node('r', 'reference', 0, 100, { referenceImage: asset.dataUrl }), node('o', 'output', 0, 200, { outputAsset: asset, outputStatus: 'done' }),
      node('process', 'process', 600, 0, { operation: 'perfect-pixel' }), node('none', 'process', 900, 0, { operation: 'none' })]
    const edges = [edge('p', 'g'), edge('r', 'g'), edge('o', 'g'), edge('g', 'process'), edge('process', 'none')]
    const plan = planImageWorkflow(nodes, edges)
    expect([...workflowOutputCounts(plan)]).toEqual([['g', 6], ['process', 6]])
    const generate = vi.fn(async () => ({ jobId: 'test', assets: [asset], hosted: false, credits: 0 }))
    const process = vi.fn(async () => ({ dataUrl: asset.dataUrl, operation: 'perfect-pixel' as const, detail: '' }))
    const onAsset = vi.fn()
    const slots = createWorkflowOutputSlots(plan, nodes, edges, 'test')
    await runImageWorkflow(plan, { generate, process }, { onAsset })
    expect(generate).toHaveBeenCalledTimes(6)
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ count: 1, prompt: 'cat', referenceImage: asset.dataUrl }))
    expect(process).toHaveBeenCalledTimes(6)
    expect(onAsset).toHaveBeenCalledTimes(slots.length)
  })
})
