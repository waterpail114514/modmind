import { promises as fs } from 'node:fs'
import path from 'node:path'
import { validateSnapshotId } from './agentCore'
import type { SnapshotInfo } from '../shared/types'

export function validateSnapshotSelection(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) throw new Error('请选择 1–10000 个快照')
  return [...new Set(value.map(validateSnapshotId))]
}

/** The caller holds the project mutation lock and supplies the authoritative manifest reader. */
export async function deleteSnapshotSelection(projectPath: string, input: unknown, options: {
  read: (id: string) => Promise<{ id: string; directory: string }>
  protectedReason: (id: string) => string | undefined
  onDeleted: (id: string) => void
}): Promise<{ deletedIds: string[]; failed: { id: string; message: string }[] }> {
  const ids = validateSnapshotSelection(input)
  const root = path.resolve(projectPath, '.modmind', 'snapshots')
  const deletedIds: string[] = [], failed: { id: string; message: string }[] = []
  for (const id of ids) {
    try {
      const reason = options.protectedReason(id)
      if (reason) throw new Error(reason)
      const selected = await options.read(id)
      const directory = path.resolve(root, id)
      if (selected.id !== id || path.resolve(selected.directory) !== directory) throw new Error('快照不属于当前项目')
      // Check every managed directory before recursive removal; never follow a linked backup outside the project.
      for (const target of [path.dirname(root), root, directory]) {
        const stat = await fs.lstat(target)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('快照路径不能包含目录链接')
      }
      const expected = path.join(await fs.realpath(projectPath), '.modmind', 'snapshots', id)
      const actual = await fs.realpath(directory)
      if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !== (process.platform === 'win32' ? expected.toLowerCase() : expected)) throw new Error('快照路径超出当前项目')
      await fs.rm(directory, { recursive: true, force: true })
      deletedIds.push(id)
      options.onDeleted(id)
    } catch (error) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { deletedIds, failed }
}

export function snapshotListPage(projectPath: string, snapshots: SnapshotInfo[], input: Record<string, unknown>) {
  const offset = input.offset === undefined ? 0 : input.offset
  const limit = input.limit === undefined ? 100 : input.limit
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('快照分页参数无效')
  if (input.query !== undefined && typeof input.query !== 'string') throw new Error('query 须为字符串')
  const term = String(input.query ?? '').trim().toLocaleLowerCase()
  const filtered = term ? snapshots.filter(s => `${s.id}\n${s.label}`.toLocaleLowerCase().includes(term)) : snapshots
  const end = Number(offset) + Number(limit)
  return { projectPath, total: filtered.length, snapshots: filtered.slice(Number(offset), end), nextOffset: end < filtered.length ? end : null }
}
