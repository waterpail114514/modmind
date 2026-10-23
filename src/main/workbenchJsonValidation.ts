import { Worker } from 'node:worker_threads'

// Large persisted projections are validated off the Electron main thread. The
// queue still belongs to WorkbenchDataStore, so validation cannot reorder writes.
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
let idle: ReturnType<typeof setTimeout> | undefined
const source = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, content, object }) => {
  try {
    const parsed = JSON.parse(content);
    const valid = object ? parsed && typeof parsed === 'object' && !Array.isArray(parsed) : Array.isArray(parsed);
    parentPort.postMessage({ id, ...(valid ? {} : { error: 'shape' }) });
  } catch { parentPort.postMessage({ id, error: 'json' }); }
});
`

function activeWorker(): Worker {
  if (idle) clearTimeout(idle)
  if (worker) return worker
  const current = new Worker(source, { eval: true })
  worker = current
  current.on('message', (result: { id: number; error?: string }) => {
    const waiter = pending.get(result.id)
    pending.delete(result.id)
    if (waiter) { if (result.error) waiter.reject(new Error(result.error)); else waiter.resolve() }
    if (!pending.size) {
      current.unref()
      idle = setTimeout(() => { if (worker === current && !pending.size) { worker = undefined; void current.terminate() } }, 30_000)
      idle.unref?.()
    }
  })
  const fail = (error: Error): void => {
    if (worker === current) worker = undefined
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  current.on('error', fail)
  current.on('exit', code => { if (code && worker === current) fail(new Error('工作台数据校验进程已退出')) })
  return current
}

export function validateLargeWorkbenchJson(content: string, object: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = activeWorker(), id = ++nextId
    pending.set(id, { resolve, reject }); current.ref()
    try { current.postMessage({ id, content, object }) }
    catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
  })
}
