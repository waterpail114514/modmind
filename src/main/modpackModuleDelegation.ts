import type { ProjectInfo } from '../shared/types'
import { resolveAgentModpackModule } from './modpackModuleTools'
import { throwIfAborted } from './asyncControl'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const activeModules = new Set<string>()

/** Hold ownership until the child has actually stopped, including cancellation cleanup. */
export async function delegateModpackModule<T>(pack: ProjectInfo, input: Record<string, unknown>, options: {
  signal: AbortSignal
  beforeRun?: (module: ProjectInfo) => Promise<void>
  run: (module: ProjectInfo, request: string, signal: AbortSignal) => Promise<T>
}): Promise<T> {
  throwIfAborted(options.signal)
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 32_000) throw new Error('委派需要 1–32000 字符的具体需求')
  const module = await resolveAgentModpackModule(pack, input.namespace)
  const key = process.platform === 'win32' ? path.resolve(module.path).toLowerCase() : path.resolve(module.path)
  if (activeModules.has(key)) throw new Error(`自制 Mod ${module.name} 已有委派任务正在运行`)
  activeModules.add(key)
  try {
    throwIfAborted(options.signal)
    await options.beforeRun?.(module)
    throwIfAborted(options.signal)
    const request = [
      `你是自制模组工作台，正在接收整合包工作台的委派。只在当前模组项目中实现以下需求。`,
      `来源整合包：${pack.name}；目标：Minecraft ${pack.minecraftVersion} / ${pack.loader}。`,
      `当前模组：${module.name} (${module.namespace})。保留 namespace、Loader 和游戏版本，不擅自修改整合包或其他模组。`,
      '使用当前模组的依赖、源码、资源和托管构建/测试工具完成任务。不要再次委派。完成后报告改动、构建及功能验证证据、未完成事项；整合包工作台负责最终整合测试。',
      '', '具体需求：', input.request.trim()
    ].join('\n')
    const result = await options.run(module, request, options.signal)
    throwIfAborted(options.signal)
    return result
  } finally { activeModules.delete(key) }
}

interface DelegatedTask<T> {
  id: string
  namespace: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  result?: T
  error?: string
  collected: boolean
  finished: Promise<void>
}

/** Long agent tasks must not hold one MCP request open beyond its timeout. */
export class ModpackModuleTasks<T> {
  private readonly tasks = new Map<string, DelegatedTask<T>>()
  private readonly controller = new AbortController()
  private readonly abort = (): void => this.controller.abort(this.parentSignal.reason)

  constructor(private readonly parentSignal: AbortSignal, private readonly run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<T>) {
    parentSignal.addEventListener('abort', this.abort, { once: true })
    if (parentSignal.aborted) this.abort()
  }

  start(input: Record<string, unknown>) {
    throwIfAborted(this.controller.signal)
    if (typeof input.namespace !== 'string' || !input.namespace || typeof input.request !== 'string' || !input.request.trim() || input.request.length > 32_000) throw new Error('委派需要模组 namespace 和具体需求')
    if ([...this.tasks.values()].some(task => task.namespace === input.namespace && task.status === 'running')) throw new Error('该模组已有委派任务正在运行，请先查询现有任务')
    if (this.tasks.size >= 32) throw new Error('本轮委派任务已达到 32 个上限')
    const task: DelegatedTask<T> = { id: randomUUID(), namespace: input.namespace, status: 'running', collected: false, finished: Promise.resolve() }
    this.tasks.set(task.id, task)
    task.finished = Promise.resolve().then(() => this.run(input, this.controller.signal)).then(result => {
      if (this.controller.signal.aborted) task.status = 'cancelled'
      else { task.status = 'completed'; task.result = result }
    }, error => {
      task.status = this.controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed'
      task.error = error instanceof Error ? error.message : String(error)
    })
    return { taskId: task.id, namespace: task.namespace, status: task.status, instruction: 'Use modmind_modpack_module_task with taskId and waitSeconds up to 20 until finished. Read the result before integrating or answering. Parent cancellation stops unfinished child tasks.' }
  }

  async read(input: Record<string, unknown>) {
    const task = typeof input.taskId === 'string' ? this.tasks.get(input.taskId) : undefined
    if (!task) throw new Error('找不到本轮委派任务')
    const seconds = input.waitSeconds ?? 0
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 20) throw new Error('waitSeconds 必须在 0–20 之间')
    if (task.status === 'running' && seconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    if (task.status !== 'running') task.collected = true
    return { taskId: task.id, namespace: task.namespace, status: task.status, ...(task.result !== undefined ? { result: task.result } : {}), ...(task.error ? { error: task.error } : {}) }
  }

  assertCollected(): void {
    if ([...this.tasks.values()].some(task => task.status === 'running' || !task.collected)) throw new Error('还有自制模组委派未完成或未读取结果；请先用 modmind_modpack_module_task 获取结果，再构建整合包或结束任务')
  }

  async close(): Promise<void> {
    this.parentSignal.removeEventListener('abort', this.abort)
    this.controller.abort()
    await Promise.all([...this.tasks.values()].map(task => task.finished))
  }
}
