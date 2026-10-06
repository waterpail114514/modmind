import { describe, expect, it, vi } from 'vitest'
import { DownloadActivityStore } from './downloadActivityService'

describe('download activity store', () => {
  it('retains nested failure reasons when AggregateError has an empty message', () => {
    const store = new DownloadActivityStore()
    const id = store.start({ label: 'NeoForge installer' })
    store.fail(id, new AggregateError([new Error('read ECONNRESET'), Object.assign(new Error('invalid archive'), { name: 'InvalidZipError' })]))
    expect(store.snapshot().activities[0].error).toContain('ECONNRESET')
    expect(store.snapshot().activities[0].error).toContain('InvalidZipError')
  })
  it('publishes progress and keeps failure reasons until dismissed', () => {
    const store = new DownloadActivityStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const id = store.start({ label: 'example.jar', detail: 'Modrinth' })
    store.update(id, { downloadedBytes: 50, totalBytes: 100 })
    store.fail(id, new Error('HTTP 503 from mirror'))

    expect(store.snapshot().activities[0]).toMatchObject({
      id,
      label: 'example.jar',
      status: 'failed',
      downloadedBytes: 50,
      totalBytes: 100,
      error: 'HTTP 503 from mirror'
    })
    expect(listener).toHaveBeenCalled()
    expect(store.dismiss(id).activities).toEqual([])
  })

  it('does not dismiss an active download', () => {
    const store = new DownloadActivityStore()
    const id = store.start({ label: 'minecraft-assets' })
    expect(store.dismiss(id).activities).toHaveLength(1)
    store.complete(id)
    expect(store.dismiss(id).activities).toEqual([])
  })

  it('keeps concurrent downloads in their start order while progress updates alternate', () => {
    const store = new DownloadActivityStore()
    const first = store.start({ label: 'A.jar' })
    const second = store.start({ label: 'B.jar' })
    const initialOrder = store.snapshot().activities.map((activity) => activity.id)

    store.update(second, { downloadedBytes: 20, totalBytes: 100 })
    store.update(first, { downloadedBytes: 10, totalBytes: 100 })
    store.update(second, { downloadedBytes: 40, totalBytes: 100 })

    expect(store.snapshot().activities.map((activity) => activity.id)).toEqual(initialOrder)
  })

  it('restarts a registered operation from the failed activity row', async () => {
    const store = new DownloadActivityStore()
    const operation = vi.fn(async () => undefined)
    const id = store.start({ label: 'pack.mrpack', retry: operation })
    store.fail(id, new Error('temporary network failure'))

    expect(store.snapshot().activities[0]).toMatchObject({ status: 'failed', retryable: true })

    const snapshot = await store.retry(id)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(snapshot.activities[0]).toMatchObject({ status: 'completed', retryable: false })
  })

  it('keeps a full-operation retry available when the retry also fails', async () => {
    const store = new DownloadActivityStore()
    const operation = vi.fn(async () => { throw new Error('mirror still unavailable') })
    const id = store.start({ label: 'pack.mrpack', retry: operation })
    store.fail(id, new Error('first failure'))

    const snapshot = await store.retry(id)

    expect(snapshot.activities[0]).toMatchObject({
      status: 'failed',
      retryable: true,
      error: 'mirror still unavailable'
    })
    await store.retry(id)
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('cancels an active operation and keeps its cache-aware retry', async () => {
    const store = new DownloadActivityStore()
    const cancel = vi.fn(async () => undefined)
    const retry = vi.fn(async () => undefined)
    const id = store.start({ label: 'Minecraft assets', cancel, retry })

    expect(store.snapshot().activities[0]).toMatchObject({ cancellable: true, restartable: false })
    const cancelled = await store.cancel(id)

    expect(cancel).toHaveBeenCalledOnce()
    expect(cancelled.activities[0]).toMatchObject({ status: 'cancelled', retryable: true })
    await store.retry(id)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('restarts an active operation in place', async () => {
    const store = new DownloadActivityStore()
    const restart = vi.fn(async () => undefined)
    const id = store.start({ label: 'Minecraft assets', restart })

    expect(store.snapshot().activities[0]).toMatchObject({ restartable: true })
    const snapshot = await store.restart(id)

    expect(restart).toHaveBeenCalledOnce()
    expect(snapshot.activities[0]).toMatchObject({ status: 'completed' })
  })
})
