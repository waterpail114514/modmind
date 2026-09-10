import { awaitWithAbort, throwIfAborted } from './asyncControl'

export interface ConfigurationRevision {
  sequence: number
  signal: AbortSignal
  ready: Promise<void>
}

/** A configuration update invalidates old work before publishing its replacement. */
export class LiveConfiguration {
  private controller = new AbortController()
  private release: () => void = () => undefined
  private revision: ConfigurationRevision = { sequence: 0, signal: this.controller.signal, ready: Promise.resolve() }

  current(): ConfigurationRevision { return this.revision }

  begin(): ConfigurationRevision {
    const previous = this.controller
    this.release()
    this.controller = new AbortController()
    const ready = new Promise<void>((resolve) => { this.release = resolve })
    this.revision = { sequence: this.revision.sequence + 1, signal: this.controller.signal, ready }
    previous.abort(Object.assign(new Error('Execution configuration changed'), { name: 'AbortError' }))
    return this.revision
  }

  finish(revision: ConfigurationRevision): void {
    if (revision === this.revision) this.release()
  }

  async acquire(signal: AbortSignal): Promise<ConfigurationRevision> {
    for (;;) {
      throwIfAborted(signal)
      const revision = this.revision
      await awaitWithAbort(revision.ready, signal)
      if (revision === this.revision) return revision
    }
  }
}

/** Serialize a compare-and-write operation; atomic rename alone cannot prevent stale writes. */
export class SerialState {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}
