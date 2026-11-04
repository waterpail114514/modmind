import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Bundled model metadata travels as JSON next to the application bundle instead
 * of being inlined into it. Nothing here runs at import time: the first consumer
 * pays for the read, and `preloadModelData` lets the main process start that read
 * while it is still doing other startup work.
 */

let modelDataRoot = process.cwd()
const syncCache = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()

/**
 * Point the loader at the directory that contains the bundled JSON. The main
 * process passes `app.getAppPath()`, which is the project root in development
 * and the packaged archive when released.
 */
export function configureModelDataRoot(root: string): void {
  modelDataRoot = root
  syncCache.clear()
  pending.clear()
}

function resolvePath(relativePath: string): string {
  return path.join(modelDataRoot, relativePath)
}

/** Read a bundled JSON document, reusing one in-flight read per document. */
export async function loadModelData<T>(relativePath: string): Promise<T> {
  const cached = syncCache.get(relativePath)
  if (cached !== undefined) return cached as T
  const inFlight = pending.get(relativePath)
  if (inFlight) return inFlight as Promise<T>
  const promise = fs.readFile(resolvePath(relativePath), 'utf8').then((text) => {
    const value = JSON.parse(text) as T
    syncCache.set(relativePath, value)
    return value
  }).finally(() => {
    // Only the current owner may clear the slot, so a reconfigured root cannot
    // drop a newer read that is still in flight.
    if (pending.get(relativePath) === promise) pending.delete(relativePath)
  })
  pending.set(relativePath, promise)
  return promise
}

/** Start reading bundled documents now so the first consumer finds them ready. */
export function preloadModelData(relativePaths: readonly string[]): void {
  for (const relativePath of relativePaths) {
    void loadModelData(relativePath).catch((error: unknown) => {
      console.warn(`内置数据 ${relativePath} 预加载失败，将在使用时重试`, error)
    })
  }
}

/**
 * Synchronous read for callers that cannot await. Prefer `loadModelData`; this
 * exists so a caller deep in a synchronous code path still gets the document.
 */
export function readModelDataSync<T>(relativePath: string): T {
  const cached = syncCache.get(relativePath)
  if (cached !== undefined) return cached as T
  const value = JSON.parse(readFileSync(resolvePath(relativePath), 'utf8')) as T
  syncCache.set(relativePath, value)
  return value
}

/**
 * Missing bundled data must degrade the model workflow to its defaults rather
 * than take the whole settings surface down. Keep the failure visible.
 */
export function readModelDataOrEmpty<T>(relativePath: string, label: string, fallback: T): T {
  try {
    return readModelDataSync<T>(relativePath)
  } catch (error) {
    console.warn(`内置数据 ${label} 不可用，相关模型将回退到默认预算`, error)
    return fallback
  }
}
