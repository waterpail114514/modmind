import { expect, it, vi } from 'vitest'
import { ManagedTestTasks } from './managedTestTasks'

it('returns promptly, deduplicates in-flight starts, and retains completion results', async () => {
  const owner = new AbortController(); const tasks = new ManagedTestTasks(owner.signal, () => ({ phase: 'downloading' }))
  let finish!: (value: object) => void
  const run = vi.fn(() => new Promise<object>(resolve => { finish = resolve }))
  const first = await tasks.invoke('modmind_test_matrix', { targets: ['server'] }, run)
  expect(first).toMatchObject({ status: 'running' }); expect('instruction' in first && first.instruction).toContain('modmind_test_matrix')
  expect(await tasks.invoke('modmind_test_matrix', { targets: ['server'] }, run)).toMatchObject({ taskId: first.taskId })
  expect(() => tasks.assertCollected()).toThrow('尚未完成')
  finish({ success: true, results: ['server passed'] })
  expect(await tasks.invoke('modmind_test_matrix', { operation: 'state', taskId: first.taskId, waitSeconds: 1 }, run)).toMatchObject({ status: 'completed', success: true })
  expect(await tasks.invoke('modmind_test_matrix', { operation: 'state', taskId: first.taskId }, run)).toMatchObject({ taskId: first.taskId, status: 'completed' })
  expect(run).toHaveBeenCalledOnce(); expect(() => tasks.assertCollected()).not.toThrow()
  await tasks.close()
})

it('cancels preparation and rejects foreign IDs or invalid arguments before starting', async () => {
  const tasks = new ManagedTestTasks(new AbortController().signal, () => ({}))
  const run = vi.fn(async (signal: AbortSignal) => await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  await expect(tasks.invoke('modmind_test_rendered', { waitSeconds: 21 }, run)).rejects.toThrow('0–20')
  expect(run).not.toHaveBeenCalled()
  const started = await tasks.invoke('modmind_test_rendered', {}, run)
  await expect(tasks.invoke('modmind_test_rendered', { operation: 'cancel', taskId: 'foreign' }, run)).rejects.toThrow('找不到')
  expect(await tasks.invoke('modmind_test_rendered', { operation: 'cancel', taskId: started.taskId, waitSeconds: 1 }, run)).toMatchObject({ status: 'cancelled', success: false })
  await tasks.close()
})
