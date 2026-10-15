import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copySnapshotFilesIncremental } from './snapshotStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
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
    expect((await fs.stat(path.join(second, 'file.txt'))).ino).not.toBe((await fs.stat(path.join(first, 'file.txt'))).ino)
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
    const baselineUnchanged = await fs.stat(path.join(first, 'config', 'large.txt'))
    const secondUnchanged = await fs.stat(path.join(second, 'config', 'large.txt'))
    const liveUnchanged = await fs.stat(path.join(project, 'config', 'large.txt'))
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
