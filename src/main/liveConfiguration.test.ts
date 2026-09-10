import { describe, expect, it } from 'vitest'
import { LiveConfiguration, SerialState } from './liveConfiguration'

describe('live execution configuration', () => {
  it('invalidates old requests immediately and waits for a fully committed replacement', async () => {
    const live = new LiveConfiguration()
    const old = await live.acquire(new AbortController().signal)
    const next = live.begin()
    expect(old.signal.aborted).toBe(true)
    let ready = false
    const acquired = live.acquire(new AbortController().signal).then(value => { ready = true; return value })
    await Promise.resolve()
    expect(ready).toBe(false)
    live.finish(next)
    expect(await acquired).toBe(next)
  })

  it('skips superseded configurations and lets user cancellation win', async () => {
    const live = new LiveConfiguration()
    const b = live.begin()
    const controller = new AbortController()
    const result = live.acquire(controller.signal)
    const c = live.begin()
    live.finish(b)
    live.finish(c)
    expect(await result).toBe(c)
    live.begin()
    const cancelled = live.acquire(controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('compares the current credential inside the same serialized operation as a write', async () => {
    const state = new SerialState()
    let credential = 'A'
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const sync = state.run(async () => { await gate; credential = 'B' })
    const staleUsage = state.run(async () => { if (credential === 'A') credential = 'A-with-usage' })
    release()
    await Promise.all([sync, staleUsage])
    expect(credential).toBe('B')
  })
})
