import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

const queues = new Map<string, Promise<void>>()
const ownership = new AsyncLocalStorage<Map<string, { active: boolean }>>()

/** Serialize read/modify/commit as one operation, including nested service calls. */
export async function withProjectMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (ownership.getStore()?.get(key)?.active) return operation()
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  queues.set(key, current)
  await previous
  const owner = { active: true }
  const context = new Map(ownership.getStore())
  context.set(key, owner)
  try { return await ownership.run(context, operation) }
  finally {
    owner.active = false
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}

export function serializeProjectMutation<P extends { path: string }, A extends unknown[], T>(operation: (project: P, ...args: A) => Promise<T>): (project: P, ...args: A) => Promise<T> {
  return (project, ...args) => withProjectMutation(project.path, () => operation(project, ...args))
}
