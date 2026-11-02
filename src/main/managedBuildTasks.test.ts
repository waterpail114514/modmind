import { expect, it, vi } from 'vitest'
import { ManagedBuildTasks } from './managedBuildTasks'
import { AbortableResourceQueue } from './abortableResourceQueue'

it('returns a task promptly, deduplicates starts and retains real completion evidence', async () => {
  let finish!: (value: { success: boolean; artifact: string }) => void
  const run = vi.fn(() => new Promise<{ success: boolean; artifact: string }>(resolve => { finish = resolve }))
  const tasks = new ManagedBuildTasks(new AbortController().signal, run, () => ({ message: 'Downloading Forge artifact' }))
  const first = await tasks.invoke({ waitSeconds: 0 })
  expect(first).toMatchObject({ status: 'running', state: { message: 'Downloading Forge artifact' } })
  expect(first).not.toHaveProperty('success')
  expect(await tasks.invoke({ waitSeconds: 0 })).toMatchObject({ taskId: first.taskId })
  expect(run).toHaveBeenCalledOnce()
  expect(() => tasks.assertCollected()).toThrow('构建尚未完成')
  finish({ success: true, artifact: 'project.jar' })
  expect(await tasks.invoke({ operation: 'state', taskId: first.taskId, waitSeconds: 1 })).toMatchObject({ status: 'completed', success: true, artifact: 'project.jar' })
  expect(() => tasks.assertCollected()).not.toThrow()
  await expect(tasks.invoke({ operation: 'state', taskId: 'another-project' })).rejects.toThrow('当前项目')
  await expect(tasks.invoke({ waitSeconds: 21 })).rejects.toThrow('0–20')
  await expect(tasks.invoke({ operation: null })).rejects.toThrow('operation')
  await expect(tasks.invoke({ waitSeconds: null })).rejects.toThrow('0–20')
  await expect(tasks.invoke({ operation: 'state', taskId: 'another-project', path: 'foreign' })).rejects.toThrow('未知字段')
  await expect(tasks.invoke({ taskId: first.taskId })).rejects.toThrow('start 不接受')
  await tasks.close()
})

it('reports cancelling until process cleanup finishes and cancels on owner abort', async () => {
  const owner = new AbortController()
  let cleanup!: () => void
  let aborted = false
  const tasks = new ManagedBuildTasks(owner.signal, signal => new Promise<{ success: true }>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true
      cleanup = () => reject(Object.assign(new Error('构建已取消'), { name: 'AbortError' }))
    }, { once: true })
  }), () => ({}))
  const first = await tasks.invoke({ waitSeconds: 0 })
  owner.abort()
  expect(aborted).toBe(true)
  expect(await tasks.invoke({ operation: 'cancel', taskId: first.taskId, waitSeconds: 0 })).toMatchObject({ status: 'cancelling' })
  cleanup()
  expect(await tasks.invoke({ operation: 'state', taskId: first.taskId, waitSeconds: 1 })).toMatchObject({ status: 'cancelled', success: false })
  await expect(tasks.invoke({ waitSeconds: 0 })).rejects.toMatchObject({ name: 'AbortError' })
  await tasks.close()
})

it('returns a failed build as failure and keeps history bounded', async () => {
  const tasks = new ManagedBuildTasks(new AbortController().signal, async () => { throw new Error('Maven read timed out') }, () => ({}))
  const first = await tasks.invoke({ waitSeconds: 1 })
  expect(first).toMatchObject({ status: 'failed', success: false, error: 'Maven read timed out' })
  for (let count = 0; count < 35; count++) await tasks.invoke({ waitSeconds: 1 })
  await expect(tasks.invoke({ operation: 'state', taskId: first.taskId })).rejects.toThrow('找不到')
  await tasks.close()
})

it('cancels a queued build immediately without releasing the active build lock', async () => {
  const queue = new AbortableResourceQueue(), abort = new AbortController()
  let finish!: () => void
  const first = queue.run(() => new Promise<void>(resolve => { finish = resolve }))
  await Promise.resolve()
  const skipped = vi.fn(async () => undefined), last = vi.fn(async () => 'last')
  const waiting = queue.run(skipped, abort.signal)
  const third = queue.run(last)
  abort.abort()
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  expect(last).not.toHaveBeenCalled()
  finish()
  await first
  expect(await third).toBe('last')
  expect(skipped).not.toHaveBeenCalled()
})

it('retains ownership through cancellation cleanup after a queued task has started', async () => {
  const queue = new AbortableResourceQueue(), abort = new AbortController()
  let cleanup!: () => void, settled = false
  const active = queue.run(() => new Promise<void>(resolve => { cleanup = resolve }), abort.signal).finally(() => { settled = true })
  await Promise.resolve()
  const next = vi.fn(async () => undefined), pending = queue.run(next)
  abort.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(next).not.toHaveBeenCalled()
  cleanup()
  await active; await pending
  expect(next).toHaveBeenCalledOnce()
})
