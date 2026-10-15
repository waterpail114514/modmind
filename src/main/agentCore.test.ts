import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listManagedFiles,
  redactSensitiveContent,
  restoreManagedPathsFromSnapshot,
  restoreManagedTreeExact,
  snapshotManifestBelongsToProject,
  validateSnapshotId
} from './agentCore'

const temporaryRoots: string[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-agent-core-'))
  temporaryRoots.push(root)
  return root
}

async function copyTree(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else await fs.copyFile(from, to)
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('redactSensitiveContent', () => {
  it('redacts property and JSON credentials while preserving ordinary settings', () => {
    expect(redactSensitiveContent('gradle.properties', 'minecraft_version=1.21.1\nrepoToken=secret-value'))
      .toBe('minecraft_version=1.21.1\nrepoToken=<redacted>')
    expect(redactSensitiveContent('config.json', '{"apiKey":"secret","model":"test"}'))
      .toBe('{"apiKey":"<redacted>","model":"test"}')
  })
})

describe('restoreManagedTreeExact', () => {
  it('rejects unlisted snapshot files before restoring any live file', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project')
    await fs.mkdir(snapshot); await fs.mkdir(project)
    await fs.writeFile(path.join(snapshot, 'listed.txt'), 'before')
    await fs.writeFile(path.join(snapshot, 'unlisted.txt'), 'unexpected')
    await fs.writeFile(path.join(project, 'listed.txt'), 'current')
    await expect(restoreManagedTreeExact(snapshot, project, ['listed.txt'], () => false, copyTree)).rejects.toThrow(/unlisted/)
    expect(await fs.readFile(path.join(project, 'listed.txt'), 'utf8')).toBe('current')
    await expect(fs.stat(path.join(project, 'unlisted.txt'))).rejects.toThrow()
  })
  it('rejects a missing original before changing any live file', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project')
    await fs.mkdir(snapshot); await fs.mkdir(project)
    await fs.writeFile(path.join(snapshot, 'first.txt'), 'before')
    await fs.writeFile(path.join(project, 'first.txt'), 'current')
    await fs.writeFile(path.join(project, 'missing.txt'), 'keep')
    await expect(restoreManagedTreeExact(snapshot, project, ['first.txt', 'missing.txt'], () => false, copyTree)).rejects.toThrow()
    expect(await fs.readFile(path.join(project, 'first.txt'), 'utf8')).toBe('current')
    expect(await fs.readFile(path.join(project, 'missing.txt'), 'utf8')).toBe('keep')
  })
  it('does not restore through an ancestor junction', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project'), outside = path.join(root, 'outside')
    await fs.mkdir(path.join(snapshot, 'src'), { recursive: true }); await fs.mkdir(project); await fs.mkdir(outside)
    await fs.writeFile(path.join(snapshot, 'src', 'file.txt'), 'before')
    await fs.writeFile(path.join(outside, 'file.txt'), 'outside')
    await fs.symlink(outside, path.join(project, 'src'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(restoreManagedTreeExact(snapshot, project, ['src/file.txt'], () => false, copyTree)).rejects.toThrow(/link/)
    expect(await fs.readFile(path.join(outside, 'file.txt'), 'utf8')).toBe('outside')
  })
  it('restores changed files and removes files created after the snapshot', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot')
    const project = path.join(root, 'project')
    await fs.mkdir(path.join(snapshot, 'src'), { recursive: true })
    await fs.writeFile(path.join(snapshot, 'src', 'Existing.java'), 'original')
    await fs.mkdir(path.join(project, 'src'), { recursive: true })
    await fs.writeFile(path.join(project, 'src', 'Existing.java'), 'modified')
    await fs.writeFile(path.join(project, 'src', 'CreatedByAi.java'), 'half finished')
    await fs.mkdir(path.join(project, 'mods', 'generated', 'nested'), { recursive: true })
    await fs.writeFile(path.join(project, 'mods', 'generated', 'nested', 'target-version.jar'), 'new')
    await fs.mkdir(path.join(snapshot, 'empty-by-design'), { recursive: true })
    await fs.mkdir(path.join(project, '.modmind'), { recursive: true })
    await fs.writeFile(path.join(project, '.modmind', 'keep.json'), '{}')

    const expected = await listManagedFiles(snapshot, (name) => name === '.modmind')
    await restoreManagedTreeExact(snapshot, project, expected, (name) => name === '.modmind', copyTree)

    await expect(fs.readFile(path.join(project, 'src', 'Existing.java'), 'utf8')).resolves.toBe('original')
    await expect(fs.stat(path.join(project, 'src', 'CreatedByAi.java'))).rejects.toThrow()
    await expect(fs.stat(path.join(project, 'mods'))).rejects.toThrow()
    await expect(fs.stat(path.join(project, 'empty-by-design'))).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    await expect(fs.readFile(path.join(project, '.modmind', 'keep.json'), 'utf8')).resolves.toBe('{}')
  })
})

describe('restoreManagedPathsFromSnapshot', () => {
  it('uses the manifest to identify originals and never reads unlisted files through source junctions', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project'), outside = path.join(root, 'outside')
    await fs.mkdir(snapshot); await fs.mkdir(path.join(project, 'extra'), { recursive: true }); await fs.mkdir(outside)
    await fs.writeFile(path.join(snapshot, 'original.txt'), 'before')
    await fs.writeFile(path.join(outside, 'unlisted.txt'), 'outside')
    await fs.symlink(outside, path.join(snapshot, 'extra'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.writeFile(path.join(project, 'extra', 'unlisted.txt'), 'task-created')
    await restoreManagedPathsFromSnapshot(snapshot, project, ['extra/unlisted.txt'], { files: ['original.txt'] })
    await expect(fs.stat(path.join(project, 'extra', 'unlisted.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'unlisted.txt'), 'utf8')).toBe('outside')
  })
  it('distinguishes a missing backup from a task-created file using the manifest', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project')
    await fs.mkdir(snapshot); await fs.mkdir(project)
    await fs.writeFile(path.join(project, 'original.txt'), 'current')
    await fs.writeFile(path.join(project, 'new.txt'), 'new')
    await expect(restoreManagedPathsFromSnapshot(snapshot, project, ['new.txt', 'original.txt'], { files: ['original.txt'] })).rejects.toThrow()
    expect(await fs.readFile(path.join(project, 'original.txt'), 'utf8')).toBe('current')
    expect(await fs.readFile(path.join(project, 'new.txt'), 'utf8')).toBe('new')
  })
  it('rolls back only Agent-attributed files and preserves unrelated user changes', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot')
    const project = path.join(root, 'project')
    await fs.mkdir(path.join(snapshot, 'src'), { recursive: true })
    await fs.mkdir(path.join(project, 'src'), { recursive: true })
    await fs.writeFile(path.join(snapshot, 'src', 'Changed.java'), 'before Agent')
    await fs.writeFile(path.join(snapshot, 'src', 'DeletedByUser.java'), 'user later deleted this')
    await fs.writeFile(path.join(project, 'src', 'Changed.java'), 'half-finished Agent edit')
    await fs.writeFile(path.join(project, 'src', 'CreatedByAgent.java'), 'new Agent file')
    await fs.writeFile(path.join(project, 'src', 'UnrelatedUserEdit.java'), 'keep me')

    await restoreManagedPathsFromSnapshot(snapshot, project, ['src/Changed.java', 'src/CreatedByAgent.java'])

    await expect(fs.readFile(path.join(project, 'src', 'Changed.java'), 'utf8')).resolves.toBe('before Agent')
    await expect(fs.stat(path.join(project, 'src', 'CreatedByAgent.java'))).rejects.toThrow()
    await expect(fs.stat(path.join(project, 'src', 'DeletedByUser.java'))).rejects.toThrow()
    await expect(fs.readFile(path.join(project, 'src', 'UnrelatedUserEdit.java'), 'utf8')).resolves.toBe('keep me')
  })

  it('does not mutate project files when no Agent changes were recorded', async () => {
    const root = await temporaryDirectory()
    const snapshot = path.join(root, 'snapshot')
    const project = path.join(root, 'project')
    await fs.mkdir(snapshot)
    await fs.mkdir(project)
    await fs.writeFile(path.join(snapshot, 'kept.txt'), 'snapshot')
    await fs.writeFile(path.join(project, 'kept.txt'), 'current user edit')

    await restoreManagedPathsFromSnapshot(snapshot, project, [])

    await expect(fs.readFile(path.join(project, 'kept.txt'), 'utf8')).resolves.toBe('current user edit')
  })

  it('rejects recovery paths outside the project', async () => {
    const root = await temporaryDirectory()
    await expect(restoreManagedPathsFromSnapshot(path.join(root, 'snapshot'), path.join(root, 'project'), ['../outside.txt']))
      .rejects.toThrow(/Unsafe managed recovery path/)
  })
})

describe('snapshot identity validation', () => {
  it('accepts generated IDs and rejects path traversal', () => {
    expect(validateSnapshotId('2026-07-29T13-20-10-123Z')).toBe('2026-07-29T13-20-10-123Z')
    expect(() => validateSnapshotId('../snapshot')).toThrow(/Invalid snapshot ID/)
    expect(() => validateSnapshotId('folder\\snapshot')).toThrow(/Invalid snapshot ID/)
  })

  it('rejects manifests copied from another project', () => {
    const current = path.join(os.tmpdir(), 'modmind-current-project')
    const other = path.join(os.tmpdir(), 'modmind-other-project')
    expect(snapshotManifestBelongsToProject({ id: 'snapshot-1', projectPath: current }, 'snapshot-1', current)).toBe(true)
    expect(snapshotManifestBelongsToProject({ id: 'snapshot-1' }, 'snapshot-1', current)).toBe(true)
    expect(snapshotManifestBelongsToProject({ id: 'snapshot-1', projectPath: other }, 'snapshot-1', current)).toBe(false)
  })
})
