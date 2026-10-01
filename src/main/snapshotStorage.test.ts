import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listManagedFiles, restoreManagedTreeExact } from './agentCore'
import { ignoreSnapshotDirectory, repairLegacySnapshotCaches, snapshotStorageInfo } from './snapshotStorage'

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-maintenance-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('snapshot storage maintenance', () => {
  it('excludes runtime data and rebuildable caches from new snapshots', () => {
    for (const name of ['.modmind', '.git', '.gradle', '.gradle-cloud-storage-test', 'build', 'run', 'logs', 'node_modules']) {
      expect(ignoreSnapshotDirectory(name)).toBe(true)
    }
    expect(ignoreSnapshotDirectory('src')).toBe(false)
    expect(ignoreSnapshotDirectory('mods')).toBe(false)
  })

  it('removes only a known legacy cache and updates its manifest', async () => {
    const project = await temporaryProject()
    const id = '2026-09-24T11-44-58-616Z'
    const root = path.join(project, '.modmind', 'snapshots', id)
    await fs.mkdir(path.join(root, 'files', '.gradle-cloud-storage-test', 'wrapper'), { recursive: true })
    await fs.mkdir(path.join(root, 'files', 'modules', 'example', '.gradle-cloud-storage-test'), { recursive: true })
    await fs.mkdir(path.join(root, 'files', 'run', 'world'), { recursive: true })
    await fs.mkdir(path.join(root, 'files', 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'files', '.gradle-cloud-storage-test', 'wrapper', 'cache.jar'), 'rebuildable')
    await fs.writeFile(path.join(root, 'files', 'modules', 'example', '.gradle-cloud-storage-test', 'nested.jar'), 'rebuildable')
    await fs.writeFile(path.join(root, 'files', 'run', 'world', 'level.dat'), 'world')
    await fs.writeFile(path.join(root, 'files', 'src', 'Main.java'), 'source')
    const files = ['.gradle-cloud-storage-test/wrapper/cache.jar', 'modules/example/.gradle-cloud-storage-test/nested.jar', 'run/world/level.dat', 'src/Main.java']
    await fs.writeFile(path.join(root, 'snapshot.json'), JSON.stringify({
      id, projectPath: project, fileCount: files.length, files,
      hashes: Object.fromEntries(files.map(file => [file, 'hash'])),
      fileMetadata: Object.fromEntries(files.map(file => [file, { size: 1 }]))
    }))

    await expect(repairLegacySnapshotCaches(project)).resolves.toEqual({ repaired: 1, skipped: 0 })
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'))
    expect(manifest.files).toEqual(['run/world/level.dat', 'src/Main.java'])
    expect(manifest.fileCount).toBe(2)
    expect(Object.keys(manifest.hashes)).toEqual(manifest.files)
    expect(Object.keys(manifest.fileMetadata)).toEqual(manifest.files)
    await expect(fs.stat(path.join(root, 'files', '.gradle-cloud-storage-test'))).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'files', 'modules', 'example', '.gradle-cloud-storage-test'))).rejects.toThrow()
    await expect(fs.readFile(path.join(root, 'files', 'run', 'world', 'level.dat'), 'utf8')).resolves.toBe('world')
    await expect(repairLegacySnapshotCaches(project)).resolves.toEqual({ repaired: 0, skipped: 0 })
  })

  it('leaves a cache alone when it contains files absent from the manifest', async () => {
    const project = await temporaryProject()
    const id = '2026-09-25T14-25-46-730Z'
    const root = path.join(project, '.modmind', 'snapshots', id)
    const cache = path.join(root, 'files', '.gradle-cloud-storage-test')
    await fs.mkdir(cache, { recursive: true })
    await fs.writeFile(path.join(cache, 'tracked.jar'), 'tracked')
    await fs.writeFile(path.join(cache, 'unknown.jar'), 'unknown')
    await fs.writeFile(path.join(root, 'snapshot.json'), JSON.stringify({ id, projectPath: project, fileCount: 1, files: ['.gradle-cloud-storage-test/tracked.jar'] }))

    await expect(repairLegacySnapshotCaches(project)).resolves.toEqual({ repaired: 0, skipped: 1 })
    await expect(fs.readFile(path.join(cache, 'unknown.jar'), 'utf8')).resolves.toBe('unknown')
    expect(JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8')).fileCount).toBe(1)
  })

  it('counts hard-linked files once for its disk estimate', async () => {
    const project = await temporaryProject()
    const first = path.join(project, '.modmind', 'snapshots', 'first', 'files')
    const second = path.join(project, '.modmind', 'snapshots', 'second', 'files')
    await fs.mkdir(first, { recursive: true })
    await fs.mkdir(second, { recursive: true })
    await fs.writeFile(path.join(first, 'source.txt'), 'unchanged')
    await fs.link(path.join(first, 'source.txt'), path.join(second, 'source.txt'))

    const status = await snapshotStorageInfo(project)
    expect(status).toMatchObject({ snapshotCount: 2, logicalBytes: 18, uniqueBytes: 9, warning: false, incomplete: false })
  })

  it('restores source files without rolling back a current test world', async () => {
    const project = await temporaryProject()
    const snapshot = path.join(project, '.modmind', 'snapshots', 'old', 'files')
    const live = path.join(project, 'live')
    await fs.mkdir(path.join(snapshot, 'src'), { recursive: true })
    await fs.mkdir(path.join(snapshot, 'run', 'world'), { recursive: true })
    await fs.mkdir(path.join(live, 'src'), { recursive: true })
    await fs.mkdir(path.join(live, 'run', 'world'), { recursive: true })
    await fs.writeFile(path.join(snapshot, 'src', 'Main.java'), 'before')
    await fs.writeFile(path.join(snapshot, 'run', 'world', 'level.dat'), 'old world')
    await fs.writeFile(path.join(live, 'src', 'Main.java'), 'after')
    await fs.writeFile(path.join(live, 'run', 'world', 'level.dat'), 'current world')
    const files = await listManagedFiles(snapshot, ignoreSnapshotDirectory)
    await restoreManagedTreeExact(snapshot, live, files, ignoreSnapshotDirectory, async (source, destination) => {
      await fs.cp(source, destination, { recursive: true, filter: file => file === source || !ignoreSnapshotDirectory(path.basename(file)) })
    })
    await expect(fs.readFile(path.join(live, 'src', 'Main.java'), 'utf8')).resolves.toBe('before')
    await expect(fs.readFile(path.join(live, 'run', 'world', 'level.dat'), 'utf8')).resolves.toBe('current world')
  })
})
