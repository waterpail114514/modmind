import { awaitWithAbort, throwIfAborted } from './asyncControl'

/** Cancellation removes the caller's wait without releasing another owner's lock. */
export class AbortableResourceQueue {
  private tail = Promise.resolve()

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('构建已取消'), { name: 'AbortError' }))
    let started = false
    const scheduled = this.tail.then(() => {
      if (signal) throwIfAborted(signal, '构建已取消')
      started = true
      return operation()
    })
    this.tail = scheduled.then(() => undefined, () => undefined)
    // Once started, wait for the owner's cleanup before reporting cancellation.
    if (!signal) return scheduled
    const waiting = new AbortController()
    const onAbort = (): void => { if (!started) waiting.abort() }
    signal.addEventListener('abort', onAbort, { once: true })
    return awaitWithAbort(scheduled, waiting.signal, '构建已取消').finally(() => signal.removeEventListener('abort', onAbort))
  }
}
