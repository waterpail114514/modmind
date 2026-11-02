import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadQuotaModelCatalog } from './loadQuotaModelCatalog'

afterEach(() => vi.unstubAllGlobals())

describe('cached model inventory loading', () => {
  it('publishes the disk inventory before the live request finishes', async () => {
    const saved = { models: [{ id: 'cached-model' }] }
    let finish!: (value: unknown) => void
    const live = new Promise(resolve => { finish = resolve })
    const getModelCatalog = vi.fn().mockResolvedValueOnce(saved).mockReturnValueOnce(live)
    vi.stubGlobal('window', { modmind: { device: { getModelCatalog } } })
    const display = vi.fn()
    const loading = loadQuotaModelCatalog(display)
    await vi.waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(2))
    expect(getModelCatalog.mock.calls).toEqual([[false, true], [false]])
    expect(display).toHaveBeenCalledWith(saved)
    const next = { models: [{ id: 'new-model' }] }
    finish(next)
    await expect(loading).resolves.toEqual(next)
  })

  it('leaves the displayed inventory intact when a refresh fails', async () => {
    const saved = { models: [{ id: 'saved-model' }] }
    const getModelCatalog = vi.fn().mockResolvedValue(saved)
    const discoverModels = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('window', { modmind: { device: { getModelCatalog, discoverModels } } })
    const display = vi.fn()
    await expect(loadQuotaModelCatalog(display, true)).rejects.toThrow('offline')
    expect(display).toHaveBeenCalledExactlyOnceWith(saved)
    expect(discoverModels).toHaveBeenCalledOnce()
    expect(getModelCatalog).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('still loads live models when no cache exists or disk reads fail', async () => {
    const getModelCatalog = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce({ models: [{ id: 'fresh-model' }] })
    vi.stubGlobal('window', { modmind: { device: { getModelCatalog } } })
    const display = vi.fn()
    await expect(loadQuotaModelCatalog(display, false, true)).resolves.toMatchObject({ models: [{ id: 'fresh-model' }] })
    expect(display).not.toHaveBeenCalled()
    expect(getModelCatalog).toHaveBeenLastCalledWith(true)
  })
})
