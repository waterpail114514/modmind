import { describe, expect, it, vi } from 'vitest'
import { createVanillaLanguageLoader } from './vanillaItemNames'

describe('vanilla item language downloads', () => {
  it('retries the same version at the upstream repository and shares successful requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('CDN offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'item.minecraft.diamond': '钻石' })))
    const load = createVanillaLanguageLoader(fetcher)
    const [first, second] = await Promise.all([load('1.20.4'), load('1.20.4')])
    expect(first).toEqual({ 'item.minecraft.diamond': '钻石' }); expect(second).toBe(first)
    expect(fetcher.mock.calls[1][0]).toContain('raw.githubusercontent.com/misode/mcmeta/1.20.4-assets')
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('expires a failed request and fetches again when the network recovers', async () => {
    let now = 0
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const load = createVanillaLanguageLoader(fetcher, () => now)
    await expect(load('1.21.1')).rejects.toThrow('temporarily unavailable')
    await expect(load('1.21.1')).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(4)
    now = 10_001
    fetcher.mockResolvedValue(new Response(JSON.stringify({ 'block.minecraft.stone': 'Stone' })))
    expect(await load('1.21.1')).toEqual({ 'block.minecraft.stone': 'Stone' })
  })
})
