import { expect, it, vi } from 'vitest'
import { loaderMetadataFetch } from './loaderMetadataDownload'

it.each(['fabric', 'quilt'] as const)('recovers %s stale mirror metadata without changing the pinned version', async loader => {
  const request = vi.fn<typeof fetch>(async input => new Response(JSON.stringify([{ version: String(input).includes('bangbang93') ? 'old' : 'pinned' }])))
  const fetchMetadata = loaderMetadataFetch(loader, request, 'pinned')
  const result = await fetchMetadata(`https://meta.${loader}mc.org/v3/versions/loader`)
  expect(await result.json()).toEqual([{ version: 'pinned' }])
  expect(request.mock.calls.map(call => String(call[0]))).toEqual([
    `https://bmclapi2.bangbang93.com/${loader}-meta/v3/versions/loader`,
    `https://meta.${loader}mc.org/v3/versions/loader`
  ])
})

it('retries the official profile after a mirror HTTP failure and retains cancellation', async () => {
  const controller = new AbortController()
  const request = vi.fn<typeof fetch>(async input => new Response('{}', { status: String(input).includes('bangbang93') ? 404 : 200 }))
  const run = loaderMetadataFetch('quilt', request, '0.27.1')
  expect((await run('https://meta.quiltmc.org/v3/versions/loader/1.20.1/0.27.1/profile/json', { signal: controller.signal })).status).toBe(200)
  controller.abort()
  await expect(run('https://meta.quiltmc.org/v3/versions/loader', { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
  expect(request).toHaveBeenCalledTimes(2)
})
