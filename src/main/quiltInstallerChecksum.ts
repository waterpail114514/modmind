import { fetchTextWithRetry } from './networkRequest'

/** Only Quilt's own exact-version Maven artifact may recover its generated Meta hash.
 * This never accepts a user/pinned checksum: the caller supplies official Meta entries only. */
export async function quiltOfficialInstallerChecksum(url: string, signal?: AbortSignal): Promise<string> {
  const parsed = new URL(url)
  const match = /^\/repository\/release\/org\/quiltmc\/quilt-installer\/([0-9]+\.[0-9]+\.[0-9]+)\/quilt-installer-\1\.jar$/.exec(parsed.pathname)
  if (parsed.origin !== 'https://maven.quiltmc.org' || parsed.username || parsed.password || parsed.search || parsed.hash || !match) {
    throw new Error('Quilt checksum recovery requires the official exact-version Maven artifact')
  }
  const checksum = (await fetchTextWithRetry(`${url}.sha256`, { signal })).trim()
  if (!/^[0-9a-f]{64}$/i.test(checksum)) throw new Error('Quilt Maven SHA-256 response is invalid')
  return checksum.toLowerCase()
}
