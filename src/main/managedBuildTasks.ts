import { randomUUID } from 'node:crypto'
import { throwIfAborted } from './asyncControl'

interface BuildTask<T> {
  id: string
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  controller: AbortController
  finished: Promise<void>
  result?: T
  error?: string
  collected: boolean
}

/** One project/run owns its tasks; a slow build must not outlive its owner. */
export class ManagedBuildTasks<T extends object> {
  private tasks = new Map<string, BuildTask<T>>()
  private closed = false
  private abort = (): void => { for (const task of this.tasks.values()) this.abortTask(task) }

  constructor(private parent: AbortSignal, private run: (signal: AbortSignal) => Promise<T>, private progress: () => unknown, private tool = 'modmind_build_project') {
    parent.addEventListener('abort', this.abort, { once: true })
  }

  private abortTask(task: BuildTask<T>): void {
    if (!['running', 'cancelling'].includes(task.status)) return
    task.status = 'cancelling'
    task.controller.abort()
  }

  async invoke(input: Record<string, unknown> = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('构建参数必须是对象')
    if (Object.keys(input).some(key => !['operation', 'taskId', 'waitSeconds'].includes(key))) throw new Error('构建参数包含未知字段')
    const operation = input.operation === undefined ? 'start' : input.operation
    if (typeof operation !== 'string' || !['start', 'state', 'cancel'].includes(operation)) throw new Error('构建 operation 必须是 start、state 或 cancel')
    const seconds = input.waitSeconds === undefined ? (operation === 'state' ? 0 : 20) : input.waitSeconds
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 20) throw new Error('waitSeconds 必须在 0–20 之间')
    if (input.taskId !== undefined && (typeof input.taskId !== 'string' || !input.taskId)) throw new Error('taskId 无效')
    if (operation === 'start' && input.taskId !== undefined) throw new Error('start 不接受 taskId；查询现有任务请使用 state')
    let task = input.taskId ? this.tasks.get(String(input.taskId)) : [...this.tasks.values()].at(-1)
    if (input.taskId && !task) throw new Error('找不到当前项目、本轮拥有的构建任务')
    if (operation === 'start') {
      throwIfAborted(this.parent, '构建已取消')
      if (this.closed) throw new Error('构建会话已关闭')
      task = [...this.tasks.values()].find(value => ['running', 'cancelling'].includes(value.status))
      if (!task) {
        // Keep a bounded amount of history, retaining every uncollected result.
        if (this.tasks.size >= 32) {
          const oldest = [...this.tasks.values()].find(value => value.collected)
          if (!oldest) throw new Error('请先读取已有构建结果')
          this.tasks.delete(oldest.id)
        }
        const created: BuildTask<T> = { id: randomUUID(), status: 'running', controller: new AbortController(), finished: Promise.resolve(), collected: false }
        this.tasks.set(created.id, created)
        created.finished = Promise.resolve().then(() => {
          throwIfAborted(created.controller.signal, '构建已取消')
          return this.run(created.controller.signal)
        }).then(result => {
          if (created.controller.signal.aborted) created.status = 'cancelled'
          else { created.status = 'completed'; created.result = result }
        }, error => {
          created.status = created.controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed'
          created.error = error instanceof Error ? error.message : String(error)
        })
        task = created
      }
    }
    if (!task) return { taskId: undefined, status: 'idle' as const, state: this.progress() }
    if (operation === 'cancel') this.abortTask(task)
    if (['running', 'cancelling'].includes(task.status) && seconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000) })]) }
      finally { clearTimeout(timer) }
    }
    if (!['running', 'cancelling'].includes(task.status)) task.collected = true
    return {
      taskId: task.id, status: task.status,
      ...(task.result ?? {}),
      ...(['failed', 'cancelled'].includes(task.status) ? { success: false } : {}),
      ...(task.error ? { error: task.error } : {}),
      state: this.progress(),
      ...(['running', 'cancelling'].includes(task.status) ? { instruction: `Poll ${this.tool} with operation=state, this taskId and waitSeconds<=20. Running is not success. Use operation=cancel to stop it.` } : {})
    }
  }

  assertCollected(): void {
    if ([...this.tasks.values()].some(task => !task.collected)) throw new Error(`构建尚未完成或结果未读取；请用 ${this.tool} operation=state 查询，再结束任务`)
  }

  async close(): Promise<void> {
    this.closed = true
    this.parent.removeEventListener('abort', this.abort)
    this.abort()
    await Promise.all([...this.tasks.values()].map(task => task.finished))
  }
}
