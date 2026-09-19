import { fetchJsonWithRetry } from './networkRequest'

interface ImportedFileIdentity { projectId: string; versionId: string; versionName?: string }

export async function resolveImportedModrinthIdentity(
  downloads: string[],
  hashes: { sha1: string; sha512: string; size: number }
): Promise<ImportedFileIdentity | null> {
  const upstream = downloads.map(url => {
    const parsed = new URL(url)
    return ['cdn.modrinth.com', 'cdn-alt.modrinth.com'].includes(parsed.hostname)
      ? parsed.pathname.match(/^\/data\/([A-Za-z0-9]{8})\/versions\/([^/]+)\/[^/]+$/)
      : null
  }).find(Boolean)
  if (!upstream) return null
  if (/^[A-Za-z0-9]{8}$/.test(upstream[2])) return { projectId: upstream[1], versionId: upstream[2] }
  // Older CDN URLs use version numbers. These are not API version IDs.
  const version = await fetchJsonWithRetry<{
    id?: string; project_id?: string; version_number?: string
    files?: Array<{ size?: number; hashes?: { sha1?: string; sha512?: string } }>
  }>(`https://api.modrinth.com/v2/version_file/${hashes.sha1}?algorithm=sha1`, {
    attempts: 1, signal: AbortSignal.timeout(15_000)
  }).catch(() => null)
  // Metadata failure must not discard an otherwise verified, usable import.
  if (!version || version.project_id !== upstream[1] || !/^[A-Za-z0-9]{8}$/.test(version.id ?? '')) return null
  if (!version.files?.some(file => file.size === hashes.size && file.hashes?.sha1 === hashes.sha1 && file.hashes?.sha512 === hashes.sha512)) return null
  return { projectId: version.project_id, versionId: version.id!, versionName: version.version_number }
}
