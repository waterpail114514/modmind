import { snapshotImageWorkflow, type ImageWorkflowGraph } from './imageWorkflow'

export interface SavedImageWorkflow extends ImageWorkflowGraph { id: string; name: string; updatedAt: string }
export interface ImageWorkflowLibrary { version: 2; revision: number; activeId: string; workflows: SavedImageWorkflow[] }
const legacyKey = 'modmind.image-studio.workflow.v1'

export function parseWorkflowGraph(value: unknown): ImageWorkflowGraph {
  if (!value || typeof value !== 'object') throw new Error('工作流存档格式无效')
  const graph = value as ImageWorkflowGraph
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('工作流存档缺少节点或连线')
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || !node.data || !['prompt', 'reference', 'generate', 'process', 'output'].includes(node.data.kind) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new Error('工作流存档包含无效节点')
    ids.add(node.id)
    if (typeof node.data.title !== 'string' || typeof node.data.subtitle !== 'string') throw new Error('工作流节点信息无效')
    for (const key of ['prompt', 'referenceImage', 'referenceLabel', 'size'] as const) {
      if (node.data[key] !== undefined && typeof node.data[key] !== 'string') throw new Error('工作流节点参数无效')
    }
    if (node.data.outputAsset && (typeof node.data.outputAsset.id !== 'string' || typeof node.data.outputAsset.dataUrl !== 'string')) throw new Error('工作流输出图片无效')
  }
  if (graph.edges.some(edge => !edge || typeof edge.id !== 'string' || !ids.has(edge.source) || !ids.has(edge.target))) throw new Error('工作流存档包含失效连线')
  return snapshotImageWorkflow(graph)
}

export function parseImageWorkflowLibrary(value: unknown): ImageWorkflowLibrary {
  const library = value as ImageWorkflowLibrary | null
  if (!library || library.version !== 2 || !Number.isInteger(library.revision) || !Array.isArray(library.workflows)) throw new Error('工作流列表格式无效，原存档未被修改')
  const ids = new Set<string>()
  const workflows = library.workflows.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) throw new Error('工作流名称或编号无效')
    ids.add(item.id)
    return { id: item.id, name: item.name, updatedAt: item.updatedAt, ...parseWorkflowGraph(item) }
  })
  return { version: 2, revision: library.revision, activeId: ids.has(library.activeId) ? library.activeId : workflows[0]?.id ?? '', workflows }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('modmind-image-workflows', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('library') }
    request.onerror = () => reject(request.error ?? new Error('无法打开工作流存储'))
    request.onblocked = () => reject(new Error('工作流存储正在被其他窗口占用，请关闭其他窗口后重试'))
    request.onsuccess = () => resolve(request.result)
  })
}

export async function saveImageWorkflows(library: ImageWorkflowLibrary): Promise<ImageWorkflowLibrary> {
  const validated = parseImageWorkflowLibrary(library)
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('library', 'readwrite')
      const store = transaction.objectStore('library')
      const request = store.get('current')
      let failure: Error | undefined
      const next = { ...validated, revision: validated.revision + 1 }
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== validated.revision) {
          failure = new Error('工作流已被其他窗口修改；当前画布已保留，请重新打开应用后再保存')
          transaction.abort()
          return
        }
        store.put(next, 'current')
      }
      transaction.oncomplete = () => resolve(next)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('工作流保存失败，可能是存储空间不足；当前画布已保留'))
      transaction.onerror = () => { /* onabort reports the failed atomic transaction. */ }
    })
  } finally { db.close() }
}

export async function loadImageWorkflows(): Promise<ImageWorkflowLibrary> {
  const db = await openDatabase()
  let stored: unknown
  try {
    stored = await new Promise((resolve, reject) => {
      const transaction = db.transaction('library', 'readonly')
      const request = transaction.objectStore('library').get('current')
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? new Error('无法读取工作流存档'))
    })
  } finally { db.close() }
  if (stored !== undefined) return parseImageWorkflowLibrary(stored)
  const legacy = localStorage.getItem(legacyKey)
  if (!legacy) return { version: 2, revision: 0, activeId: '', workflows: [] }
  const graph = parseWorkflowGraph(JSON.parse(legacy))
  // Keep the original localStorage entry as a backup even after successful migration.
  return saveImageWorkflows({ version: 2, revision: 0, activeId: 'legacy', workflows: [{ id: 'legacy', name: '原有工作流', updatedAt: new Date().toISOString(), ...graph }] })
}
