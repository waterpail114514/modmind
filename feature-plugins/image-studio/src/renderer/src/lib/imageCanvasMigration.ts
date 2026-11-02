import { loadImageWorkflows } from './imageWorkflowStorage'
import { createDefaultCanvasNodeData, createEmptyCanvasGraph, type SerializedCanvasGraph } from '../../../../vendor/open-canvas/components/open-canvas/upstream/shared/lib/canvas/types'
import type { SavedImageWorkflow } from './imageWorkflowStorage'

/** Creates a copy. Original workflow records, including processing chains, remain untouched. */
export function migrateImageWorkflow(saved: SavedImageWorkflow): { title: string; graph: SerializedCanvasGraph } {
  const graph = createEmptyCanvasGraph()
  const retained = new Set<string>()
  for (const node of saved.nodes) {
    const data = node.data
    if (data.kind === 'process') continue
    const type = data.kind === 'prompt' ? 'text' : 'image'
    const base = createDefaultCanvasNodeData(type, 'zh')
    const url = data.kind === 'reference' ? data.referenceImage : data.outputAsset?.dataUrl
    const media = url ? { url, source: data.kind === 'reference' ? 'uploaded' as const : 'generated' as const, mimeType: 'image/png' } : null
    graph.nodes.push({ id: node.id, type, position: node.position, width: type === 'image' ? 400 : undefined, data: {
      ...base, title: data.referenceLabel || data.title, prompt: data.prompt || '',
      ...(type === 'text' ? { plainText: data.prompt || '' } : { image: media, imageOutputs: media ? [media] : [], referenceImage: data.kind === 'reference' ? media : null,
        inputMode: data.kind === 'reference' || data.kind === 'output' ? 'upload' : 'generate', count: data.count || 1, quality: data.quality || 'medium', moderation: data.moderation || 'auto',
        presetId: data.presetId, presetPrompt: data.presetPrompt, style: data.style, aspectRatio: '1:1', resolution: data.size?.startsWith('2048') ? '2K' : '1K' })
    } })
    retained.add(node.id)
  }
  graph.edges = saved.edges.filter(edge => retained.has(edge.source) && retained.has(edge.target) && saved.nodes.find(node => node.id === edge.target)?.data.kind === 'generate')
    .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: 'right', targetHandle: 'left', type: 'default' }))
  return { title: saved.name, graph }
}

export async function legacyImageCanvases() {
  return (await loadImageWorkflows()).workflows.map(migrateImageWorkflow)
}
