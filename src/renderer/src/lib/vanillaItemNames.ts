type Language = Record<string, string>
export function createVanillaLanguageLoader(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { expires: number; promise: Promise<Language> }>()
  return (version: string): Promise<Language> => {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(version)) return Promise.reject(new Error('Invalid Minecraft version'))
    const cached = cache.get(version)
    if (cached && cached.expires > now()) return cached.promise
    const entry = { expires: Infinity, promise: Promise.resolve({}) as Promise<Language> }
    entry.promise = (async () => {
      const bases = [`https://cdn.jsdelivr.net/gh/misode/mcmeta@${version}-assets/assets/minecraft/lang`, `https://raw.githubusercontent.com/misode/mcmeta/${version}-assets/assets/minecraft/lang`]
      for (const language of ['zh_cn', 'en_us']) for (const base of bases) {
        try {
          const response = await fetcher(`${base}/${language}.json`, { mode: 'cors', signal: AbortSignal.timeout(8_000) })
          if (!response.ok) { await response.body?.cancel(); continue }
          const value: unknown = await response.json()
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const result = Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === 'string')) as Language
          if (!Object.keys(result).length) continue
          entry.expires = now() + 24 * 60 * 60 * 1000
          return result
        } catch { /* Try the same version at the next public source. */ }
      }
      entry.expires = now() + 10_000
      throw new Error('Minecraft item names are temporarily unavailable')
    })()
    cache.set(version, entry)
    while (cache.size > 8) cache.delete(cache.keys().next().value!)
    return entry.promise
  }
}

export const vanillaLang = createVanillaLanguageLoader()
