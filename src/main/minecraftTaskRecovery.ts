import type { Task } from '@xmcl/task'
import { downloadFailureText } from '../shared/downloadFailure'

export function isRecoverableMinecraftDownloadError(error: unknown): boolean {
  const text = downloadFailureText(error)
  if (/AbortError|UND_ERR_ABORTED|已取消|ENOSPC|EACCES|EPERM|EROFS|EBUSY/i.test(text)) return false
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|socket hang up|fetch failed|InvalidZipError|ChecksumNotMatchError|checksum mismatch|checksum.*mismatch|RequestError|SocketError|TimeoutError|HTTP (?:408|425|429|5\d\d)/i.test(text)
}

/** A fresh task resets files; retries also avoid broken parallel Range responses. */
export function minecraftDownloadRecoveryOptions(attempt: number): { rangePolicy?: { computeRanges: () => [] } } {
  return attempt > 1 ? { rangePolicy: { computeRanges: () => [] } } : {}
}

type RecoveryTaskFactory<T> = (attempt: number) => Task<T>

export interface MinecraftTaskRecoveryOptions<T> {
  createTask: RecoveryTaskFactory<T>
  signal?: AbortSignal
  maxAttempts?: number
  stallTimeoutMs?: number
  checkIntervalMs?: number
  onUpdate?: (root: Task<T>, active: Task<unknown>, chunkSize: number) => void
  onRetry?: (nextAttempt: number, error: Error) => void
  retryOnError?: (error: unknown) => boolean
}

export class MinecraftDownloadStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`Minecraft 下载连续 ${Math.ceil(timeoutMs / 1000)} 秒没有进度`)
    this.name = 'MinecraftDownloadStalledError'
  }
}

function abortError(): Error {
  return Object.assign(new Error('Minecraft 操作已取消'), { name: 'AbortError' })
}

/** Cancels stalled XMCL task trees and recreates them so verified files are reused. */
export async function runMinecraftTaskWithRecovery<T>(options: MinecraftTaskRecoveryOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const stallTimeoutMs = Math.max(1_000, options.stallTimeoutMs ?? 60_000)
  const checkIntervalMs = Math.max(100, Math.min(options.checkIntervalMs ?? 2_000, stallTimeoutMs))

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError()
    const task = options.createTask(attempt)
    let lastActivityAt = Date.now()
    let stalled = false
    let cancelPromise: Promise<void> | null = null
    const touch = (): void => { lastActivityAt = Date.now() }
    const cancel = (): void => {
      cancelPromise ??= task.cancel(5_000).catch(() => undefined)
    }
    const onAbort = (): void => cancel()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const watchdog = setInterval(() => {
      if (!task.isRunning || Date.now() - lastActivityAt < stallTimeoutMs) return
      stalled = true
      cancel()
    }, checkIntervalMs)
    watchdog.unref?.()

    try {
      return await task.startAndWait({
        onStart: touch,
        onUpdate: (active, chunkSize) => {
          if (chunkSize > 0) touch()
          options.onUpdate?.(task, active, chunkSize)
        },
        onSucceed: touch
      })
    } catch (error) {
      if (cancelPromise) await cancelPromise
      if (options.signal?.aborted) throw abortError()
      const failure = stalled ? new MinecraftDownloadStalledError(stallTimeoutMs) : error
      if (!stalled && !(options.retryOnError ?? isRecoverableMinecraftDownloadError)(error)) throw error
      if (attempt >= maxAttempts) throw failure
      options.onRetry?.(attempt + 1, new Error(downloadFailureText(failure), { cause: failure }))
    } finally {
      clearInterval(watchdog)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error('Minecraft 下载重试次数已耗尽')
}
