import { describe, expect, it, vi } from 'vitest'
import { DeviceDeepLinkQueue } from './deviceDeepLinkQueue'

describe('DeviceDeepLinkQueue', () => {
  it('deduplicates a deep link after the first handler completes', async () => {
    const handle = vi.fn(async () => undefined)
    const queue = new DeviceDeepLinkQueue(handle)
    const link = 'mcdev://sync?code=K7M3QX&customApi=secret-content'
    queue.enqueue(link)
    queue.setReady()
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1))
    queue.enqueue(link)
    expect(handle).toHaveBeenCalledTimes(1)
  })
})
