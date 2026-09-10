import { spawn, type ChildProcess } from 'node:child_process'

const owned = new Map<ChildProcess, number>()
const stopping = new WeakMap<ChildProcess, Promise<void>>()
let shuttingDown = false

/** Only register a child actually created with detached:true on POSIX. */
function registerManagedChild<T extends ChildProcess>(child: T): T {
  const register = (): void => {
    if (!child.pid || child.pid === process.pid) return
    owned.set(child, child.pid)
    if (shuttingDown) void stopProcessTree(child)
  }
  register()
  child.once('spawn', register)
  // Do not leave orphan descendants or retain a stale PID after the leader exits.
  child.once('exit', () => {
    if (process.platform === 'win32') { owned.delete(child); return }
    try {
      if (groupExists(child)) void stopProcessTree(child)
      else owned.delete(child)
    } catch (error) { console.error('[process-tree] Cannot inspect exited group', error) }
  })
  return child
}

export const spawnManaged: typeof spawn = ((command: string, argvOrOptions?: string[] | import('node:child_process').SpawnOptions, options?: import('node:child_process').SpawnOptions) => {
  if (shuttingDown) throw new Error('应用正在退出，不能启动新任务')
  const argv = Array.isArray(argvOrOptions) ? argvOrOptions : []
  const settings = Array.isArray(argvOrOptions) ? options : argvOrOptions
  return registerManagedChild(spawn(command, argv, { ...settings, detached: process.platform !== 'win32' }))
}) as typeof spawn

function groupExists(child: ChildProcess): boolean {
  const pid = owned.get(child)
  if (!pid || pid <= 1 || pid === process.pid) return false
  try { process.kill(-pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

export function terminateProcessTree(child: ChildProcess, options: { gracefulTimeoutMs?: number } = {}): Promise<void> {
  const active = stopping.get(child)
  if (active) return active
  const task = (async () => {
    if (!child.pid || child.pid <= 1 || child.pid === process.pid) return
    if (process.platform === 'win32') {
      if (child.exitCode != null || child.signalCode != null) return
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', reject)
        killer.once('close', (code) => code === 0 || child.exitCode != null || child.signalCode != null ? resolve() : reject(new Error(`taskkill exited with ${code}`)))
      })
      owned.delete(child)
      return
    }
    const pid = owned.get(child)
    const alive = (): boolean => pid ? groupExists(child) : child.exitCode == null && child.signalCode == null
    const signal = (value: NodeJS.Signals): void => {
      try { if (pid) process.kill(-pid, value); else child.kill(value) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    if (!alive()) { owned.delete(child); return }
    signal('SIGTERM')
    const deadline = Date.now() + (options.gracefulTimeoutMs ?? 3000)
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    if (alive()) signal('SIGKILL')
    const killDeadline = Date.now() + 2000
    while (alive() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 50))
    if (alive()) throw new Error(`进程组 ${pid ?? child.pid} 未确认退出`)
    owned.delete(child)
  })()
  stopping.set(child, task)
  void task.finally(() => stopping.delete(child)).catch(() => undefined)
  return task
}

/** Cancellation callbacks cannot await; shutdown still joins their termination promises. */
export async function stopProcessTree(child: ChildProcess): Promise<void> {
  await terminateProcessTree(child).catch((error) => console.error('[process-tree]', error))
}

export function beginProcessShutdown(): void { shuttingDown = true }
export async function shutdownProcessTrees(): Promise<void> {
  beginProcessShutdown()
  const results = await Promise.allSettled([...owned.keys()].map((child) => terminateProcessTree(child)))
  const errors = results.filter((result) => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map((result) => (result as PromiseRejectedResult).reason), '进程树清理失败')
}
