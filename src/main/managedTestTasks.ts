import { ManagedBuildTasks } from './managedBuildTasks'

/** Bounded MCP calls share the existing owned-task lifecycle and cancellation. */
export class ManagedTestTasks {
  private tasks = new Map<string, { fingerprint: string; run: (signal: AbortSignal) => Promise<unknown>; task: ManagedBuildTasks<Record<string, unknown>> }>()
  constructor(private owner: AbortSignal, private progress: () => unknown) {}
  async invoke(tool: string, input: Record<string, unknown>, run: (signal: AbortSignal) => Promise<unknown>) {
    const { operation, taskId, waitSeconds, ...parameters } = input
    if (operation !== undefined && !['start', 'state', 'cancel'].includes(String(operation))) throw new Error('operation 必须是 start、state 或 cancel')
    if (taskId !== undefined && (typeof taskId !== 'string' || !taskId || (operation ?? 'start') === 'start')) throw new Error('taskId 只用于查询或取消')
    if (waitSeconds !== undefined && (typeof waitSeconds !== 'number' || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 20)) throw new Error('waitSeconds 需要在 0–20 之间')
    if (Object.keys(parameters).some(key => tool !== 'modmind_test_matrix' || key !== 'targets')) throw new Error('测试参数包含未知字段')
    if ((operation ?? 'start') === 'start' && tool === 'modmind_test_matrix' && (!Array.isArray(parameters.targets) || !parameters.targets.length || parameters.targets.some(value => !['build', 'client', 'server', 'gametest'].includes(String(value))))) throw new Error('targets 需要选择有效测试目标')
    const fingerprint = JSON.stringify(parameters)
    let entry = this.tasks.get(tool)
    if (!entry) {
      if (operation && operation !== 'start') throw new Error('找不到当前会话的测试任务')
      for (const existing of this.tasks.values()) existing.task.assertCollected()
      const task = new ManagedBuildTasks(this.owner, async signal => {
        const result = await this.tasks.get(tool)!.run(signal)
        return result && typeof result === 'object' ? result as Record<string, unknown> : { result }
      }, this.progress, tool)
      entry = { fingerprint, task, run }; this.tasks.set(tool, entry)
    } else if ((operation ?? 'start') === 'start' && entry.fingerprint !== fingerprint) {
      entry.task.assertCollected()
      entry.fingerprint = fingerprint; entry.run = run
    }
    return entry.task.invoke({ operation, taskId, waitSeconds: waitSeconds ?? 0 })
  }
  assertCollected(): void { for (const entry of this.tasks.values()) entry.task.assertCollected() }
  async close(): Promise<void> { await Promise.all([...this.tasks.values()].map(entry => entry.task.close())) }
}
