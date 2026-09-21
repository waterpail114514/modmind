import { describe, expect, it, vi } from 'vitest'
import { connectionIsValid, planImageWorkflow, runImageWorkflow, snapshotImageWorkflow, type WorkflowNodeType, type WorkflowKind } from './imageWorkflow'
import { parseImageWorkflowLibrary, parseWorkflowGraph } from './imageWorkflowStorage'
import type { ImageAsset, ImageGenerationResult } from '../../../shared/imageStudio'
import { imageStudioPresets } from './imageStudioPresets'

const image: ImageAsset = { id: 'chosen', dataUrl: 'data:image/png;base64,AA==', model: 'test', hosted: true, credits: 1, createdAt: '', quality: 'low', size: '1024x1024', style: 'free' }
const node = (id: string, kind: WorkflowKind, data: Partial<WorkflowNodeType['data']> = {}): WorkflowNodeType => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { kind, title: id, subtitle: '', ...data } })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const basic = () => ({ nodes: [node('p', 'prompt', { prompt: 'cat' }), node('g', 'generate', { count: 3 })], edges: [edge('p', 'g')] })
const api = () => ({ generate: vi.fn(async (): Promise<ImageGenerationResult> => ({ jobId: 'job', assets: [{ ...image, id: crypto.randomUUID() }], credits: 1, hosted: true })), process: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AQ==', operation: 'perfect-pixel' as const, detail: '' })) })

describe('image workflow execution safety', () => {
  it('uses saved outputs without rerunning their original producer and preserves the same reference after saving', async () => {
    const graph = basic()
    graph.nodes.push(node('o', 'output', { outputStatus: 'done', outputAsset: image }), node('p2', 'prompt', { prompt: 'edit' }), node('g2', 'generate', { count: 2 }), node('old-tail', 'process', { operation: 'none' }))
    graph.edges.push(edge('g', 'o'), edge('o', 'g2'), edge('p2', 'g2'), edge('g', 'old-tail'))
    const plan = planImageWorkflow(graph.nodes, graph.edges)
    expect(plan.nodes.map(n => n.id)).not.toContain('g')
    expect(plan.totalCount).toBe(2)
    const calls = api()
    await runImageWorkflow(plan, calls, { onAsset: vi.fn() })
    expect(calls.generate).toHaveBeenCalledTimes(2)
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ referenceImage: image.dataUrl, prompt: 'edit', count: 1 }))
    const saved = parseWorkflowGraph(JSON.parse(JSON.stringify(snapshotImageWorkflow(graph))))
    expect(planImageWorkflow(saved.nodes, saved.edges).nodes.map(n => n.id)).not.toContain('g')
    expect(saved.nodes.find(n => n.id === 'o')?.data.outputAsset?.dataUrl).toBe(image.dataUrl)
  })

  it('runs only the selected node and its dependencies', () => {
    const graph = basic()
    graph.nodes.push(node('unrelated', 'generate'))
    expect(planImageWorkflow(graph.nodes, graph.edges, 'g').nodes.map(n => n.id)).toEqual(['p', 'g'])
  })

  it('rejects an empty reference before any paid work can start', () => {
    const graph = basic()
    graph.nodes.push(node('r', 'reference'))
    graph.edges.push(edge('r', 'g'))
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('没有可用参考图片')
  })

  it('rejects multiple prompts, duplicate edges, cycles and dangling edges', () => {
    const graph = basic()
    graph.nodes.push(node('p2', 'prompt', { prompt: 'dog' }))
    expect(connectionIsValid({ source: 'p2', target: 'g', sourceHandle: null, targetHandle: null }, graph.nodes, graph.edges)).toBe(false)
    expect(() => planImageWorkflow(graph.nodes, [...graph.edges, edge('p2', 'g')])).toThrow('多个提示词')
    expect(() => planImageWorkflow(graph.nodes, [...graph.edges, edge('p', 'g')])).toThrow('重复')
    expect(() => planImageWorkflow(graph.nodes, [...graph.edges, edge('g', 'p')])).toThrow('循环')
    expect(() => planImageWorkflow(graph.nodes, [...graph.edges, edge('missing', 'g')])).toThrow('失效')
  })

  it.each([0, 1.5, 11, Infinity])('rejects an invalid count %s', count => {
    const graph = basic(); graph.nodes[1].data.count = count
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('整数')
  })

  it('bounds cascading requests before starting generation', () => {
    const graph = basic(); graph.nodes[1].data.count = 10
    graph.nodes.push(node('p2', 'prompt', { prompt: 'edit' }), node('g2', 'generate', { count: 10 }))
    graph.edges.push(edge('g', 'g2'), edge('p2', 'g2'))
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('超过 100 张')
  })

  it('publishes every completed image immediately, preserves it on later failure and makes no further requests', async () => {
    const graph = basic()
    const calls = api()
    calls.generate.mockRejectedValueOnce(new Error('first failed'))
    const completed = vi.fn()
    await expect(runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: completed })).rejects.toThrow('first failed')
    expect(completed).not.toHaveBeenCalled()
    calls.generate.mockReset().mockResolvedValueOnce({ jobId: 'j', assets: [image], hosted: true, credits: 1 }).mockRejectedValueOnce(new Error('second failed'))
    await expect(runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: completed })).rejects.toThrow('second failed')
    expect(completed).toHaveBeenCalledWith(image, 'g')
    expect(calls.generate).toHaveBeenCalledTimes(2)
  })

  it('retains an in-flight result when stopped and never launches the next request', async () => {
    const graph = basic(); const calls = api(); let stopped = false
    calls.generate.mockImplementation(async () => { stopped = true; return { jobId: 'j', assets: [image], hosted: true, credits: 1 } })
    const completed = vi.fn()
    await expect(runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: completed, stopped: () => stopped })).rejects.toThrow('已停止')
    expect(completed).toHaveBeenCalledWith(image, 'g')
    expect(calls.generate).toHaveBeenCalledTimes(1)
  })

  it('preserves generation results when downstream processing fails', async () => {
    const graph = basic(); graph.nodes[1].data.count = 1
    graph.nodes.push(node('process', 'process', { operation: 'perfect-pixel' })); graph.edges.push(edge('g', 'process'))
    const calls = api(); calls.process.mockRejectedValue(new Error('processing failed'))
    const completed = vi.fn()
    await expect(runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: completed })).rejects.toThrow('processing failed')
    expect(completed).toHaveBeenCalledTimes(1)
  })
})

describe('workflow library persistence', () => {
  it('keeps independent named workflows, including image results, without serializing callbacks', () => {
    const graph = basic()
    graph.nodes.push(node('o', 'output', { outputStatus: 'done', outputAsset: image, onOpenOutput: vi.fn() }))
    graph.edges.push(edge('g', 'o'))
    const snapshot = snapshotImageWorkflow(graph)
    expect(snapshot.nodes[2].data).not.toHaveProperty('onOpenOutput')
    expect(snapshot.nodes[2].data.outputAsset).toEqual(image)
    const library = parseImageWorkflowLibrary({ version: 2, revision: 3, activeId: 'two', workflows: [{ ...snapshot, id: 'one', name: '图标', updatedAt: '' }, { ...basic(), id: 'two', name: '纹理', updatedAt: '' }] })
    expect(library.activeId).toBe('two')
    expect(library.workflows.map(item => item.name)).toEqual(['图标', '纹理'])
    expect(library.workflows[1].nodes).toHaveLength(2)
  })

  it('rejects corrupt saves instead of overwriting them with a default', () => {
    expect(() => parseWorkflowGraph({ nodes: [{}], edges: [] })).toThrow('无效节点')
    expect(() => parseImageWorkflowLibrary({ version: 3, workflows: [] })).toThrow('原存档未被修改')
    const graph = basic()
    expect(() => parseWorkflowGraph({ ...graph, edges: [edge('unknown', 'g')] })).toThrow('失效连线')
  })
})

describe('image generation presets', () => {
  it.each(imageStudioPresets)('executes $label with its full template and required image', async preset => {
    const nodes = [node('g', 'generate', { presetId: preset.id, style: 'minecraft' })]
    const edges: ReturnType<typeof edge>[] = []
    if (preset.requiresReference) {
      nodes.push(node('r', 'reference', { referenceImage: image.dataUrl }))
      edges.push(edge('r', 'g'))
    }
    const calls = api()
    await runImageWorkflow(planImageWorkflow(nodes, edges), calls, { onAsset: vi.fn() })
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(preset.prompt), style: 'free', ...(preset.requiresReference ? { referenceImage: image.dataUrl } : {}) }))
  })

  it('keeps edited templates per generator without changing shared user prompts, including after reload', async () => {
    const graph = { nodes: [node('p', 'prompt', { prompt: '主体改成红色机器人' }), node('a', 'generate', { presetId: 'creature-views', presetPrompt: '正面、侧面、背面。保持长方体结构。' }), node('b', 'generate', { presetId: 'item-icon' })], edges: [edge('p', 'a'), edge('p', 'b')] }
    const saved = parseWorkflowGraph(JSON.parse(JSON.stringify(snapshotImageWorkflow(graph))))
    const calls = api()
    await runImageWorkflow(planImageWorkflow(saved.nodes, saved.edges), calls, { onAsset: vi.fn() })
    expect(calls.generate).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: expect.stringContaining('正面、侧面、背面。保持长方体结构。') }))
    expect(calls.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: expect.stringContaining('物品栏图标') }))
    for (const [request] of calls.generate.mock.calls as unknown as [{ prompt: string }][]) expect(request.prompt).toContain('主体改成红色机器人')
    expect(saved.nodes[0].data.prompt).toBe('主体改成红色机器人')
  })

  it.each(imageStudioPresets.filter(preset => preset.requiresReference))('blocks $label without a reference before any upstream generation', preset => {
    const graph = basic()
    graph.nodes.push(node('missing', 'generate', { presetId: preset.id }))
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('需要参考图')
  })

  it('accepts an upstream generated image as the reference for a variant', async () => {
    const graph = basic()
    graph.nodes[1].data.count = 1
    graph.nodes.push(node('variant', 'generate', { presetId: 'material-variant' }))
    graph.edges.push(edge('g', 'variant'))
    const calls = api()
    await runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: vi.fn() })
    expect(calls.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ referenceImage: image.dataUrl, prompt: expect.stringContaining('钻石等级') }))
  })

  it('validates missing, emptied and oversized templates and malformed saved fields', () => {
    const graph = basic()
    graph.nodes[1].data.presetId = 'removed-preset'
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('预设不可用')
    graph.nodes[1].data.presetId = 'creature-views'
    graph.nodes[1].data.presetPrompt = ' '
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('预设提示词不能为空')
    graph.nodes[1].data.presetPrompt = 'x'.repeat(31_999)
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('32000')
    expect(() => parseWorkflowGraph({ nodes: [node('g', 'generate', { presetId: 123 as unknown as string })], edges: [] })).toThrow('参数无效')
  })

  it('preserves legacy style requests and requires a prompt when no template is selected', async () => {
    const graph = basic()
    graph.nodes[1].data.style = 'minecraft'
    graph.nodes[1].data.count = 1
    const calls = api()
    await runImageWorkflow(planImageWorkflow(graph.nodes, graph.edges), calls, { onAsset: vi.fn() })
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ style: 'minecraft', prompt: 'cat' }))
    graph.nodes[0].data.prompt = ''
    expect(() => planImageWorkflow(graph.nodes, graph.edges)).toThrow('有效提示词')
  })
})
