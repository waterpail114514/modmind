import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDecompileCacheStaging,
  DECOMPILE_OUTPUT_DIRECTORY,
  enforceDecompileCacheLimit,
  readDecompileCacheEntry
} from './decompileCache'

describe('decompileCache', () => {
  let cacheRoot: string

  beforeEach(async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-cache-test-'))
  })

  afterEach(async () => {
    await fs.rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
  })

  const sha = (text: string): string => Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64)

  const provenanceFor = (sourceSha256: string) => ({
    schemaVersion: 1 as const,
    sourceSha256,
    sourceFileName: 'example.jar',
    sourceSize: 10,
    createdAt: '2026-08-26T00:00:00.000Z',
    engine: 'vineflower' as const,
    engineVersion: '1.11.1',
    engineArgs: [],
    obfuscationHint: 'clear' as const,
    readOnly: true as const
  })

  it('round-trips a staged entry into a readable cache hit', async () => {
    const key = sha('alpha')
    expect(await readDecompileCacheEntry(cacheRoot, key)).toBeNull()
    const staging = await createDecompileCacheStaging(cacheRoot, key)
    expect(await readDecompileCacheEntry(cacheRoot, key)).toBeNull()
    await fs.writeFile(path.join(staging.staging, DECOMPILE_OUTPUT_DIRECTORY, 'Example.java'), 'class Example {}', 'utf8')
    const finalized = await staging.finalize(provenanceFor(key))
    expect(finalized.provenance?.sourceSha256).toBe(key)
    expect(await fs.readdir(path.join(finalized.directory, DECOMPILE_OUTPUT_DIRECTORY))).toEqual(['Example.java'])
    const hit = await readDecompileCacheEntry(cacheRoot, key)
    expect(hit?.provenance?.engine).toBe('vineflower')
    // Staging leftovers must not survive a successful finalize.
    await expect(fs.readdir(path.join(cacheRoot, 'jars'))).resolves.toEqual([key])
  })

  it('abandons staging without polluting the cache', async () => {
    const key = sha('beta')
    const staging = await createDecompileCacheStaging(cacheRoot, key)
    await fs.writeFile(path.join(staging.staging, DECOMPILE_OUTPUT_DIRECTORY, 'Broken.java'), 'partial', 'utf8')
    await staging.abandon()
    expect(await readDecompileCacheEntry(cacheRoot, key)).toBeNull()
    expect((await fs.readdir(path.join(cacheRoot, 'jars'), { withFileTypes: true }).catch(() => []))).toHaveLength(0)
  })

  it('rejects malformed cache keys', async () => {
    await expect(createDecompileCacheStaging(cacheRoot, '../escape')).rejects.toThrow(/invalid decompile cache key/i)
  })

  it('treats entries with missing provenance or wrong schema as present but unprovenanced', async () => {
    const key = sha('gamma')
    const staging = await createDecompileCacheStaging(cacheRoot, key)
    await fs.writeFile(path.join(staging.staging, 'sources', 'Example.java'), 'class Example {}')
    const entry = await staging.finalize(provenanceFor(key))
    await fs.writeFile(path.join(entry.directory, 'provenance.json'), '{"schemaVersion":99}', 'utf8')
    const hit = await readDecompileCacheEntry(cacheRoot, key)
    expect(hit?.directory).toBe(entry.directory)
    expect(hit?.provenance).toBeNull()
  })

  it('enforces the LRU budget while keeping the active entry', async () => {
    const write = async (name: string, bytes: number): Promise<string> => {
      const key = sha(name)
      const staging = await createDecompileCacheStaging(cacheRoot, key)
      await fs.writeFile(path.join(staging.staging, DECOMPILE_OUTPUT_DIRECTORY, 'blob.bin'), Buffer.alloc(bytes, 1))
      await staging.finalize({ ...provenanceFor(key), createdAt: `2026-08-${(name.charCodeAt(0) % 27) + 1}T00:00:00.000Z` })
      return key
    }
    const oldKey = await write('old-entry', 4 * 1024 * 1024)
    const midKey = await write('mid-entry', 4 * 1024 * 1024)
    // Refresh access on the oldest entry so LRU order flips.
    await readDecompileCacheEntry(cacheRoot, oldKey)
    const removed = await enforceDecompileCacheLimit(cacheRoot, 6 * 1024 * 1024, midKey)
    expect(removed).toContain(oldKey)
    expect(await fs.stat(path.join(cacheRoot, 'jars', midKey)).then(() => true).catch(() => false)).toBe(true)
    expect(await fs.stat(path.join(cacheRoot, 'jars', oldKey)).then(() => true).catch(() => false)).toBe(false)
  })

  it('rejects missing, changed and legacy outputs instead of reusing damaged results', async () => {
    const key = sha('integrity')
    const staging = await createDecompileCacheStaging(cacheRoot, key)
    await fs.writeFile(path.join(staging.staging, 'sources', 'Example.java'), 'class Example {}')
    const entry = await staging.finalize(provenanceFor(key))
    expect((await readDecompileCacheEntry(cacheRoot, key))?.provenance).toBeTruthy()
    const file = path.join(entry.directory, 'sources', 'Example.java')
    await fs.writeFile(file, 'class Changed {}') // Same byte length.
    expect((await readDecompileCacheEntry(cacheRoot, key))?.provenance).toBeNull()
    expect((await readDecompileCacheEntry(cacheRoot, key, 'sources/Example.java'))?.provenance).toBeNull()
    await fs.unlink(file)
    expect((await readDecompileCacheEntry(cacheRoot, key))?.provenance).toBeNull()
    await fs.writeFile(file, 'class Example {}')
    await fs.unlink(path.join(entry.directory, 'output-manifest.json'))
    expect((await readDecompileCacheEntry(cacheRoot, key))?.provenance).toBeNull()
  })

  it('keeps active staging directories when enforcing the completed cache budget', async () => {
    const staging = await createDecompileCacheStaging(cacheRoot, sha('running'))
    await fs.writeFile(path.join(staging.staging, 'sources', 'Example.java'), 'class Example {}')
    expect(await enforceDecompileCacheLimit(cacheRoot, 0)).toEqual([])
    expect(await fs.readFile(path.join(staging.staging, 'sources', 'Example.java'), 'utf8')).toBe('class Example {}')
    await staging.abandon()
  })
})
