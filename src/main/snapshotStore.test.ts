import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copySnapshotFilesIncremental, invalidateSnapshotCatalog, listSnapshotSummaries } from './snapshotStore'
import { validateSnapshotId } from './agentCore'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('snapshot summary catalog', () => {
  it('rejects directory aliases before resolving a snapshot selection', () => {
    expect(() => validateSnapshotId('.')).toThrow('Invalid snapshot ID')
    expect(() => validateSnapshotId('..')).toThrow('Invalid snapshot ID')
    expect(validateSnapshotId('2026-10-17T10-00-00-000Z')).toBe('2026-10-17T10-00-00-000Z')
  })
  async function project(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-catalog-'))
    roots.push(root)
    return root
  }
  async function save(root: string, id: string, label = id): Promise<void> {
    const directory = path.join(root, '.modmind', 'snapshots', id)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({ id, label, createdAt: id, fileCount: 1000, files: Array.from({ length: 1000 }, (_, i) => `source-${i}`), hashes: { hidden: 'large private manifest' }, projectPath: root }))
  }
  it('returns summaries, caches unchanged manifests, and refreshes known changes incrementally', async () => {
    const root = await project()
    await save(root, 'older')
    await save(root, 'newer')
    const reads = vi.spyOn(fs, 'readFile')
    const rows = await listSnapshotSummaries(root)
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'fileCount', 'id', 'label'])
    reads.mockClear()
    await listSnapshotSummaries(root)
    expect(reads.mock.calls.filter(([target]) => String(target).endsWith('snapshot.json'))).toHaveLength(0)
    await save(root, 'latest')
    invalidateSnapshotCatalog(root, 'latest')
    expect(await listSnapshotSummaries(root)).toHaveLength(3)
    expect(reads.mock.calls.filter(([target]) => String(target).endsWith('snapshot.json'))).toHaveLength(1)
  })
  it('observes external edits after expiry, and external additions and removals immediately', async () => {
    const root = await project()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await save(root, 'first')
    await listSnapshotSummaries(root)
    await save(root, 'first', 'external update')
    vi.mocked(Date.now).mockReturnValue(now + 5001)
    expect((await listSnapshotSummaries(root))[0].label).toBe('external update')
    await save(root, 'second')
    expect(await listSnapshotSummaries(root)).toHaveLength(2)
    await fs.rm(path.join(root, '.modmind', 'snapshots', 'first'), { recursive: true })
    expect((await listSnapshotSummaries(root)).map(row => row.id)).toEqual(['second'])
  })
  it('rebuilds corrupt indexes and skips malformed or incomplete manifests', async () => {
    const root = await project()
    await save(root, 'valid')
    await fs.mkdir(path.join(root, '.modmind', 'snapshots', 'incomplete'))
    await fs.writeFile(path.join(root, '.modmind', 'snapshot-index.json'), 'broken')
    expect((await listSnapshotSummaries(root)).map(row => row.id)).toEqual(['valid'])
    expect(JSON.parse(await fs.readFile(path.join(root, '.modmind', 'snapshot-index.json'), 'utf8')).version).toBe(1)
  })
  it('does not lose a manifest changed while its first catalog read is in flight', async () => {
    const root = await project()
    await save(root, 'first')
    const read = fs.readFile.bind(fs)
    let changed = false
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const content = await read(...args)
      if (!changed && String(args[0]).endsWith('snapshot.json')) {
        changed = true
        await save(root, 'first', 'updated while reading')
        invalidateSnapshotCatalog(root, 'first')
      }
      return content
    }) as typeof fs.readFile)
    expect((await listSnapshotSummaries(root))[0].label).toBe('updated while reading')
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('incremental snapshot storage', () => {
  it('replaces same-size corrupted baseline bytes from the live original', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-corrupt-'))
    roots.push(root)
    const project = path.join(root, 'project'), first = path.join(root, 'first'), second = path.join(root, 'second')
    await fs.mkdir(project)
    await fs.writeFile(path.join(project, 'file.txt'), 'GOOD')
    const original = await copySnapshotFilesIncremental(project, first, () => false)
    await fs.writeFile(path.join(first, 'file.txt'), 'EVIL')
    await copySnapshotFilesIncremental(project, second, () => false, { root: first, hashes: original.hashes, metadata: original.metadata })
    expect(await fs.readFile(path.join(second, 'file.txt'), 'utf8')).toBe('GOOD')
    expect((await fs.stat(path.join(second, 'file.txt'), { bigint: true })).ino).not.toBe((await fs.stat(path.join(first, 'file.txt'), { bigint: true })).ino)
  })
  it('reuses unchanged snapshot files without linking the live project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-store-'))
    roots.push(root)
    const project = path.join(root, 'project')
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    await fs.mkdir(path.join(project, 'config'), { recursive: true })
    await fs.writeFile(path.join(project, 'config', 'large.txt'), 'unchanged')
    await fs.writeFile(path.join(project, 'changed.txt'), 'before')

    const baseline = await copySnapshotFilesIncremental(project, first, () => false)
    await fs.writeFile(path.join(project, 'changed.txt'), 'after')
    const result = await copySnapshotFilesIncremental(project, second, () => false, { root: first, hashes: baseline.hashes })

    expect(result).toMatchObject({ fileCount: 2 })
    expect(result.hashes['config/large.txt']).toBe(sha256('unchanged'))
    expect(result.hashes['changed.txt']).toBe(sha256('after'))
    // Windows file IDs can exceed Number.MAX_SAFE_INTEGER; compare their exact values.
    const baselineUnchanged = await fs.stat(path.join(first, 'config', 'large.txt'), { bigint: true })
    const secondUnchanged = await fs.stat(path.join(second, 'config', 'large.txt'), { bigint: true })
    const liveUnchanged = await fs.stat(path.join(project, 'config', 'large.txt'), { bigint: true })
    expect(secondUnchanged.ino).toBe(baselineUnchanged.ino)
    expect(secondUnchanged.ino).not.toBe(liveUnchanged.ino)

    await fs.writeFile(path.join(project, 'config', 'large.txt'), 'live edit')
    await expect(fs.readFile(path.join(second, 'config', 'large.txt'), 'utf8')).resolves.toBe('unchanged')
    await expect(fs.readFile(path.join(second, 'changed.txt'), 'utf8')).resolves.toBe('after')
  })

  it('keeps ignored directories out of the snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-ignore-'))
    roots.push(root)
    const project = path.join(root, 'project')
    const snapshot = path.join(root, 'snapshot')
    await fs.mkdir(path.join(project, '.modmind'), { recursive: true })
    await fs.mkdir(path.join(project, 'src'), { recursive: true })
    await fs.writeFile(path.join(project, '.modmind', 'runtime.json'), '{}')
    await fs.writeFile(path.join(project, 'src', 'main.txt'), 'tracked')

    const result = await copySnapshotFilesIncremental(project, snapshot, (name) => name === '.modmind')

    expect(Object.keys(result.hashes)).toEqual(['src/main.txt'])
    await expect(fs.access(path.join(snapshot, '.modmind', 'runtime.json'))).rejects.toThrow()
  })
})
