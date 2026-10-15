import { BMCLAPI_BASE_URL } from './minecraftVersionManifest'

/** Preserve the requested loader version while recovering from stale mirror metadata. */
export function loaderMetadataFetch(loader: 'fabric' | 'quilt', request: typeof fetch, requestedVersion?: string): typeof fetch {
  return async (input, init) => {
    const official = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const mirror = `${BMCLAPI_BASE_URL}/${loader}-meta${official.pathname}${official.search}`
    const failures: string[] = []
    for (const url of [mirror, official.href]) {
      init?.signal?.throwIfAborted()
      try {
        const response = await request(url, init)
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`HTTP ${response.status}`)
        }
        if (requestedVersion && /\/versions\/loader\/?$/.test(official.pathname)) {
          const entries = await response.clone().json() as Array<{ version?: string }>
          if (!Array.isArray(entries) || !entries.some(entry => entry.version === requestedVersion)) {
            await response.body?.cancel()
            throw new Error(`Loader ${requestedVersion} missing from metadata`)
          }
        }
        return response
      } catch (error) {
        init?.signal?.throwIfAborted()
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`${loader} metadata sources failed: ${failures.join('; ')}`)
  }
}
