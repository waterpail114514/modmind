import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deleteSnapshotSelection, snapshotListPage } from './snapshotBatchDelete'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-snapshot-delete-')); roots.push(root)
  await fs.writeFile(path.join(root, 'current.txt'), 'live project')
  for (const id of ['first', 'second', 'protected']) {
    const directory = path.join(root, '.modmind/snapshots', id)
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'content.txt'), id)
  }
  const onDeleted = vi.fn()
  const options = { read: async (id: string) => ({ id, directory: path.join(root, '.modmind/snapshots', id) }), protectedReason: (id: string) => id === 'protected' ? '恢复依据受保护' : undefined, onDeleted }
  return { root, options, onDeleted }
}
it('removes only selected backups, deduplicates ids and reports protected/missing items individually', async () => {
  const { root, options, onDeleted } = await fixture()
  const result = await deleteSnapshotSelection(root, ['first', 'protected', 'first', 'missing'], options)
  expect(result.deletedIds).toEqual(['first'])
  expect(result.failed.map(item => item.id)).toEqual(['protected', 'missing'])
  expect(result.failed[0].message).toContain('保护')
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith('first')
  expect(await fs.readFile(path.join(root, 'current.txt'), 'utf8')).toBe('live project')
  expect(await fs.readFile(path.join(root, '.modmind/snapshots/second/content.txt'), 'utf8')).toBe('second')
  await expect(fs.access(path.join(root, '.modmind/snapshots/first'))).rejects.toThrow()
  expect((await deleteSnapshotSelection(root, ['second'], options)).deletedIds).toEqual(['second'])
})
it.each([[], ['first', '..'], ['first', '../outside'], ['first', 7], 'first'])('rejects malformed selections before removing any backup: %j', async ids => {
  const { root, options, onDeleted } = await fixture()
  await expect(deleteSnapshotSelection(root, ids, options)).rejects.toThrow()
  expect(onDeleted).not.toHaveBeenCalled()
  await fs.access(path.join(root, '.modmind/snapshots/first/content.txt'))
})
it('rejects foreign resolved directories and directory links without touching their target', async () => {
  const { root, options } = await fixture()
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
  const foreign = await deleteSnapshotSelection(root, ['first'], { ...options, read: async id => ({ id, directory: outside }) })
  expect(foreign.failed[0].message).toContain('不属于')
  const link = path.join(root, '.modmind/snapshots/linked')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect((await deleteSnapshotSelection(root, ['linked'], options)).failed[0].message).toContain('链接')
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  } finally { await fs.unlink(link) }
})
it('bounds snapshot search results and rejects invalid pagination', () => {
  const snapshots = Array.from({ length: 250 }, (_, n) => ({ id: `id-${n}`, label: n % 2 ? '保留' : '清理', createdAt: '', fileCount: 1 }))
  const page = snapshotListPage('/project', snapshots, { query: '清理', limit: 20, offset: 20 })
  expect(page).toMatchObject({ total: 125, nextOffset: 40 }); expect(page.snapshots).toHaveLength(20)
  expect(() => snapshotListPage('/project', snapshots, { offset: -1 })).toThrow()
  expect(() => snapshotListPage('/project', snapshots, { limit: 201 })).toThrow()
})
