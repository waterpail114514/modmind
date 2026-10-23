import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectInfo } from '../shared/types'
import { sameProjectPath } from './projectPath'
import { serializeProjectMutation } from './projectMutation'
import { invalidateSnapshotCatalog } from './snapshotStore'

type JsonRecord = Record<string, unknown>

export interface ProjectMetadataMigrationResult {
  relocated: boolean
  discardedActiveTask: boolean
}

function dataDirectory(_project: ProjectInfo): string {
  return '.modmind'
}

function manifestNames(): string[] {
  return ['modmind.project.json']
}

function isAbsoluteProjectPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value)
}

async function exists(target: string): Promise<boolean> {
  return await fs.stat(target).then(() => true).catch(() => false)
}

async function sourceProjectStillExists(storedPath: string): Promise<boolean> {
  if (!isAbsoluteProjectPath(storedPath)) return true
  return (await Promise.all(manifestNames().map((name) => exists(path.join(storedPath, name))))).some(Boolean)
}

async function canRelocate(storedPath: unknown, currentPath: string): Promise<boolean> {
  if (typeof storedPath !== 'string' || !storedPath.trim() || sameProjectPath(storedPath, currentPath)) return false
  // A copied project normally contains metadata from a path that no longer
  // exists on the new machine. Do not adopt a checkpoint that still belongs
  // to another live ModMind project on the same machine.
  return !(await sourceProjectStillExists(storedPath))
}

async function readJson(target: string): Promise<JsonRecord | null> {
  return await fs.readFile(target, 'utf8')
    .then((value) => JSON.parse(value) as JsonRecord)
    .catch(() => null)
}

async function writeJson(target: string, value: JsonRecord): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function migrateSnapshotManifests(root: string, currentPath: string): Promise<boolean> {
  const snapshots = path.join(root, 'snapshots')
  const entries = await fs.readdir(snapshots, { withFileTypes: true }).catch(() => [])
  let relocated = false
  const sources = new Map<string, Promise<boolean>>()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const target = path.join(snapshots, entry.name, 'snapshot.json')
      const manifest = await readJson(target)
      if (!manifest || typeof manifest.projectPath !== 'string') continue
      let allowed = sources.get(manifest.projectPath)
      if (!allowed) { allowed = canRelocate(manifest.projectPath, currentPath); sources.set(manifest.projectPath, allowed) }
      if (!await allowed) continue
      manifest.projectPath = currentPath
      await writeJson(target, manifest)
      relocated = true
    }
  }))
  return relocated
}

/** An imported old backup can be repaired on selection without rescanning its siblings. */
export const migrateSelectedSnapshotMetadata = serializeProjectMutation(async (project: ProjectInfo, id: string): Promise<void> => {
  if (id === '.' || id === '..' || !/^[0-9A-Za-z._-]{1,120}$/.test(id)) throw new Error('Invalid snapshot ID')
  const directory = path.join(project.path, dataDirectory(project), 'snapshots', id)
  const stat = await fs.lstat(directory).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return
  const target = path.join(directory, 'snapshot.json')
  const manifest = await readJson(target)
  if (manifest?.id === id && await canRelocate(manifest.projectPath, project.path)) {
    manifest.projectPath = project.path
    await writeJson(target, manifest)
    invalidateSnapshotCatalog(project.path, id)
  }
})

async function migrateAgentContext(root: string, currentPath: string): Promise<boolean> {
  const target = path.join(root, 'external-agents', 'agent-context.md')
  const content = await fs.readFile(target, 'utf8').catch(() => '')
  if (!content) return false
  const match = content.match(/^(Project path:\s*)(.+)$/m)
  if (!match || !await canRelocate(match[2].trim(), currentPath)) return false
  const next = content.replace(match[0], `${match[1]}${currentPath}`)
  await fs.writeFile(target, next, 'utf8')
  return true
}

async function clearPersistedExternalSessions(root: string): Promise<void> {
  await Promise.all(['codex'].map((kind) =>
    fs.rm(path.join(root, 'external-agents', `session-${kind}.json`), { force: true }).catch(() => undefined)
  ))
}

/**
 * Reconciles path-bearing ModMind state after a project directory is moved.
 * The project directory is the trust boundary; metadata inside it can be
 * updated in place, while checkpoints copied from another live project are
 * discarded rather than resumed.
 */
export const migrateMovedProjectMetadata = serializeProjectMutation(async (project: ProjectInfo): Promise<ProjectMetadataMigrationResult> => {
  const root = path.join(project.path, dataDirectory(project))
  const markerPath = path.join(root, 'metadata-migration.json')
  const marker = await readJson(markerPath)
  const checkedSnapshots = marker?.version === 1 && typeof marker.projectPath === 'string' && sameProjectPath(marker.projectPath, project.path)
  let relocated = checkedSnapshots ? false : await migrateSnapshotManifests(root, project.path)
  let discardedActiveTask = false

  const activeTarget = path.join(root, 'active-ai-task.json')
  const active = await readJson(activeTarget)
  if (active && typeof active.projectPath === 'string' && !sameProjectPath(active.projectPath, project.path)) {
    if (await canRelocate(active.projectPath, project.path)) {
      const snapshotTarget = path.join(root, 'snapshots', String(active.snapshotId ?? ''), 'snapshot.json')
      const snapshot = await readJson(snapshotTarget)
      if (snapshot && snapshot.id === active.snapshotId && snapshot.taskId === active.taskId) {
        active.projectPath = project.path
        // A CLI session is tied to the original working directory. A fresh
        // session can safely continue from the disk checkpoint instead.
        delete active.sessionId
        await writeJson(activeTarget, active)
        relocated = true
      } else {
        await fs.rm(activeTarget, { force: true })
        discardedActiveTask = true
      }
    } else {
      await fs.rm(activeTarget, { force: true })
      discardedActiveTask = true
    }
  }

  relocated = (await migrateAgentContext(root, project.path)) || relocated
  if (relocated) await clearPersistedExternalSessions(root)
  if (!checkedSnapshots) {
    await fs.mkdir(root, { recursive: true })
    await writeJson(markerPath, { version: 1, projectPath: path.resolve(project.path) }).catch(() => undefined)
  }
  if (relocated) invalidateSnapshotCatalog(project.path)
  return { relocated, discardedActiveTask }
})
