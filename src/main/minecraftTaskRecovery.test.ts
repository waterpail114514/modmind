import { describe, expect, it, vi } from 'vitest'
import type { Task, TaskContext } from '@xmcl/task'
import { runMinecraftTaskWithRecovery, minecraftDownloadRecoveryOptions } from './minecraftTaskRecovery'

function mockTask(run: (context?: TaskContext) => Promise<string>): Task<string> {
  let running = false
  let rejectCurrent: ((error: Error) => void) | undefined
  return {
    id: 0,
    name: 'mock',
    param: {},
    progress: 0,
    total: 100,
    from: undefined,
    to: undefined,
    path: 'mock',
    get isCancelled() { return false },
    get isPaused() { return false },
    get isDone() { return !running },
    get isRunning() { return running },
    state: 0,
    context: undefined,
    parent: undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => {
      running = false
      rejectCurrent?.(new Error('cancelled'))
    },
    start: () => undefined,
    wait: async () => '',
    startAndWait: async (context?: TaskContext) => {
      running = true
      context?.onStart?.(undefined as never)
      try {
        return await Promise.race([
          run(context),
          new Promise<string>((_resolve, reject) => { rejectCurrent = reject })
        ])
      } finally {
        running = false
      }
    },
    onChildUpdate: () => undefined,
    map: () => undefined as never
  } as unknown as Task<string>
}

describe('Minecraft task stall recovery', () => {
  it.each([
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('end of central directory record signature not found'), { name: 'InvalidZipError' }),
    new AggregateError([Object.assign(new Error('checksum not match'), { name: 'ChecksumNotMatchError' })]),
    Object.assign(new Error('Response Status Code Error'), { statusCode: 503 })
  ])('automatically recreates tasks after recoverable failures: %s', async failure => {
    const attempts: number[] = []
    await expect(runMinecraftTaskWithRecovery({
      createTask: attempt => mockTask(async () => { attempts.push(attempt); if (attempt === 1) throw failure; return 'done' })
    })).resolves.toBe('done')
    expect(attempts).toEqual([1, 2])
    expect(minecraftDownloadRecoveryOptions(1).rangePolicy).toBeUndefined()
    expect(minecraftDownloadRecoveryOptions(2).rangePolicy?.computeRanges()).toEqual([])
  })

  it.each([
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    Object.assign(new Error('denied'), { code: 'EACCES' }),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    Object.assign(new Error('Response Status Code Error'), { statusCode: 404 }),
    new AggregateError([Object.assign(new Error('corrupt archive'), { name: 'InvalidZipError' }), Object.assign(new Error('disk full'), { code: 'ENOSPC' })])
  ])('does not retry terminal failures: %s', async failure => {
    const factory = vi.fn(() => mockTask(async () => { throw failure }))
    await expect(runMinecraftTaskWithRecovery({ createTask: factory })).rejects.toBe(failure)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('limits persistent failures to three attempts and preserves the original error', async () => {
    const failure = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const factory = vi.fn(() => mockTask(async () => { throw failure }))
    await expect(runMinecraftTaskWithRecovery({ createTask: factory })).rejects.toBe(failure)
    expect(factory).toHaveBeenCalledTimes(3)
  })
  it('cancels a stalled attempt and recreates the task', async () => {
    vi.useFakeTimers()
    const retries: number[] = []
    let attempts = 0
    const resultPromise = runMinecraftTaskWithRecovery({
      stallTimeoutMs: 1_000,
      checkIntervalMs: 100,
      createTask: () => {
        attempts += 1
        return attempts === 1
          ? mockTask(async () => await new Promise<string>(() => undefined))
          : mockTask(async () => 'done')
      },
      onRetry: (attempt) => retries.push(attempt)
    })

    await vi.advanceTimersByTimeAsync(1_200)
    await expect(resultPromise).resolves.toBe('done')
    expect(attempts).toBe(2)
    expect(retries).toEqual([2])
    vi.useRealTimers()
  })

  it('cancels immediately when the caller aborts', async () => {
    const controller = new AbortController()
    const resultPromise = runMinecraftTaskWithRecovery({
      signal: controller.signal,
      createTask: () => mockTask(async () => await new Promise<string>(() => undefined))
    })
    controller.abort()
    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('treats received chunks as activity', async () => {
    vi.useFakeTimers()
    const resultPromise = runMinecraftTaskWithRecovery({
      stallTimeoutMs: 1_000,
      checkIntervalMs: 100,
      createTask: () => mockTask(async (context) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 700))
        context?.onUpdate?.(undefined as never, 32)
        await new Promise<void>((resolve) => setTimeout(resolve, 700))
        return 'done'
      })
    })

    await vi.advanceTimersByTimeAsync(1_500)
    await expect(resultPromise).resolves.toBe('done')
    vi.useRealTimers()
  })

  it('retries a recoverable download error without exposing an intermediate failure', async () => {
    const retries: number[] = []
    let attempts = 0
    const result = await runMinecraftTaskWithRecovery({
      createTask: () => mockTask(async () => {
        if (++attempts === 1) throw new Error('mirror returned corrupt data')
        return 'done'
      }),
      retryOnError: (error) => error instanceof Error && error.message.includes('corrupt data'),
      onRetry: (attempt) => retries.push(attempt)
    })
    expect(result).toBe('done')
    expect(attempts).toBe(2)
    expect(retries).toEqual([2])
  })

  it('does not retry an error rejected by the recovery predicate', async () => {
    let attempts = 0
    await expect(runMinecraftTaskWithRecovery({
      createTask: () => mockTask(async () => { attempts++; throw new Error('installer configuration is invalid') }),
      retryOnError: () => false
    })).rejects.toThrow('installer configuration is invalid')
    expect(attempts).toBe(1)
  })
})
