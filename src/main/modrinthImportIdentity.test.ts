import { afterEach, describe, expect, it, vi } from 'vitest'
import * as network from './networkRequest'
import { resolveImportedModrinthIdentity } from './modrinthImportIdentity'

afterEach(() => vi.restoreAllMocks())
const hashes = { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128), size: 36039 }
const legacy = ['https://cdn.modrinth.com/data/sGmHWmeL/versions/1.1.1%2B1.17/mixintrace.jar']

describe('imported Modrinth identities', () => {
  it('uses modern CDN IDs without an extra metadata request', async () => {
    const fetch = vi.spyOn(network, 'fetchJsonWithRetry')
    expect(await resolveImportedModrinthIdentity(['https://cdn-alt.modrinth.com/data/Abc12345/versions/Xyz12345/mod.jar'], hashes)).toEqual({ projectId: 'Abc12345', versionId: 'Xyz12345' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('resolves legacy version-number paths by exact file hash', async () => {
    const fetch = vi.spyOn(network, 'fetchJsonWithRetry').mockResolvedValue({ id: 'Xyz12345', project_id: 'sGmHWmeL', version_number: '1.1.1+1.17', files: [{ size: hashes.size, hashes }] })
    expect(await resolveImportedModrinthIdentity(legacy, hashes)).toEqual({ projectId: 'sGmHWmeL', versionId: 'Xyz12345', versionName: '1.1.1+1.17' })
    expect(fetch).toHaveBeenCalledWith(`https://api.modrinth.com/v2/version_file/${hashes.sha1}?algorithm=sha1`, expect.any(Object))
  })
  it('does not assign an identity if metadata points to different bytes or another project', async () => {
    const fetch = vi.spyOn(network, 'fetchJsonWithRetry').mockResolvedValue({ id: 'Xyz12345', project_id: 'sGmHWmeL', files: [{ size: hashes.size, hashes: { ...hashes, sha512: 'c'.repeat(128) } }] })
    expect(await resolveImportedModrinthIdentity(legacy, hashes)).toBeNull()
    fetch.mockResolvedValue({ id: 'Xyz12345', project_id: 'Abc12345', files: [{ size: hashes.size, hashes }] })
    expect(await resolveImportedModrinthIdentity(legacy, hashes)).toBeNull()
  })
  it('keeps unknown sources and metadata outages importable without inventing IDs', async () => {
    const fetch = vi.spyOn(network, 'fetchJsonWithRetry').mockRejectedValue(new Error('offline'))
    expect(await resolveImportedModrinthIdentity(['https://example.test/data/sGmHWmeL/versions/Xyz12345/mod.jar'], hashes)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(await resolveImportedModrinthIdentity(legacy, hashes)).toBeNull()
  })
})
