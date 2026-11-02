import { randomUUID } from 'node:crypto'
import { sameProjectPath } from './projectPath'
import type { ProjectInfo } from '../shared/types'

/** The ID and cancellation handle exist before any installation is queued. */
export class OwnedTestPreparation {
  private task?: { id: string; project: ProjectInfo; owner?: AbortSignal; fingerprint: string; controller: AbortController; status: 'running' | 'ready' | 'failed' | 'cancelled'; result?: object; error?: string; finished: Promise<void> }
  owns(signal: AbortSignal): boolean { return this.task?.owner === signal }
  belongsTo(projectPath?: string): boolean { return Boolean(this.task && projectPath && sameProjectPath(this.task.project.path, projectPath)) }
  cancel(): void { this.task?.controller.abort() }
  get id(): string | undefined { return this.task?.id }
  get running(): boolean { return this.task?.status === 'running' }
  assertReadyForSignal(signal: AbortSignal): void { if (this.owns(signal) && this.running) throw new Error('玩家测试仍在准备；请用 modmind_test_session operation=state 等待 ready=true 后再结束任务') }
  async invoke(project: ProjectInfo, input: Record<string, unknown>, owner: AbortSignal | undefined, run: (id: string, signal: AbortSignal) => Promise<object>, snapshot: () => object) {
    owner?.throwIfAborted()
    const wait = input.waitSeconds ?? 0
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0 || wait > 20) throw new Error('waitSeconds 需要在 0–20 之间')
    if (input.operation === 'start') {
      const { operation: _operation, sessionId: _sessionId, waitSeconds: _wait, ...parameters } = input
      const fingerprint = JSON.stringify([project.path, project.minecraftVersion, project.loader, parameters])
      if (this.task && !this.task.controller.signal.aborted && ['running', 'ready'].includes(this.task.status)) {
        if (this.task.owner !== owner || this.task.fingerprint !== fingerprint) throw new Error('已有不同输入或其他会话拥有的测试任务，请先停止')
      } else {
        const task: NonNullable<OwnedTestPreparation['task']> = { id: randomUUID(), project: { ...project }, owner, fingerprint, controller: new AbortController(), status: 'running', finished: Promise.resolve() }
        this.task = task
        const combined = owner ? AbortSignal.any([owner, task.controller.signal]) : task.controller.signal
        task.finished = Promise.resolve().then(() => { combined.throwIfAborted(); return run(task.id, combined) }).then(result => {
          task.result = result; task.status = combined.aborted ? 'cancelled' : 'ready'
        }, error => { task.status = combined.aborted ? 'cancelled' : 'failed'; task.error = String(error) })
      }
    }
    const task = this.task
    if (!task || !this.belongsTo(project.path) || input.sessionId && input.sessionId !== task.id) throw new Error('测试会话已过期，请先启动当前会话')
    if (wait && task.status === 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, wait * 1000) })]) }
      finally { clearTimeout(timer) }
    }
    const state = snapshot() as { running?: boolean }
    const exited = task.status === 'ready' && state.running === false
    return { ...task.result, ...state, sessionId: task.id, taskId: task.id, status: task.controller.signal.aborted || task.owner?.aborted ? (task.status === 'running' ? 'cancelling' : 'cancelled') : exited ? 'failed' : task.status,
      ready: task.status === 'ready' && !task.controller.signal.aborted && !task.owner?.aborted && !exited, error: exited ? '测试客户端已退出，请检查日志' : task.error,
      instruction: task.status === 'running' ? 'Poll modmind_test_session operation=state with sessionId and waitSeconds<=20 until ready=true; stop cancels preparation.' : undefined }
  }
}
