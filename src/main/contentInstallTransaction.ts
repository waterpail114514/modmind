import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Check every ancestor before a download/import is allowed to write beneath a project. */
export async function assertContentTarget(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('内容路径越界')
  let current = path.resolve(root)
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error(`内容目标包含链接：${relative}`)
  }
}

/** Keep previous bytes until every file and its owning manifest have committed. */
export async function installContentTransaction<T>(root: string, entries: Array<{ source: string | null; destination: string }>, finalize: () => Promise<T>): Promise<T> {
  const states: Array<{ destination: string; pending: string; backup: string; backedUp: boolean; installed: boolean; remove: boolean }> = []
  let preserveRecovery = false
  try {
    const destinations = new Set<string>()
    for (const entry of entries) {
      await assertContentTarget(root, entry.destination)
      const key = path.resolve(entry.destination).toLowerCase()
      if (destinations.has(key)) throw new Error('同一批内容包含重复目标路径')
      destinations.add(key)
      const token = randomUUID()
      const state = { destination: entry.destination, pending: `${entry.destination}.pending-${token}`, backup: `${entry.destination}.backup-${token}`, backedUp: false, installed: false, remove: entry.source === null }
      states.push(state)
      await fs.mkdir(path.dirname(entry.destination), { recursive: true })
      // Copy to the destination volume first. Never remove an old target to attempt an EXDEV rename.
      if (entry.source !== null) await fs.cp(entry.source, state.pending, { recursive: true, errorOnExist: true, force: false })
    }
    for (const state of states) {
      await assertContentTarget(root, state.destination)
      const exists = await fs.lstat(state.destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (exists) { await fs.rename(state.destination, state.backup); state.backedUp = true }
      if (!state.remove) { await fs.rename(state.pending, state.destination); state.installed = true }
    }
    return await finalize()
  } catch (error) {
    const failures: unknown[] = []
    for (const state of [...states].reverse()) {
      try {
        if (state.installed) await fs.rm(state.destination, { recursive: true, force: true })
        if (state.backedUp) await fs.rename(state.backup, state.destination)
      } catch (failure) { failures.push(failure) }
    }
    if (failures.length) {
      preserveRecovery = true
      throw new AggregateError([error, ...failures], `自动恢复未完成，备份保留在：${states.filter(state => state.backedUp).map(state => state.backup).join('；')}`)
    }
    throw error
  } finally {
    for (const state of states) {
      await fs.rm(state.pending, { recursive: true, force: true }).catch(() => undefined)
      if (!preserveRecovery) await fs.rm(state.backup, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
