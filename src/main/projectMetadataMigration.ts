import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { sameProjectPath } from './projectPath'

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
  const temporary = `${target}.tmp-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, target)
}

async function migrateSnapshotManifests(root: string, currentPath: string): Promise<boolean> {
  const snapshots = path.join(root, 'snapshots')
  const entries = await fs.readdir(snapshots, { withFileTypes: true }).catch(() => [])
  let relocated = false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const target = path.join(snapshots, entry.name, 'snapshot.json')
    const manifest = await readJson(target)
    if (!manifest || typeof manifest.projectPath !== 'string') continue
    if (!await canRelocate(manifest.projectPath, currentPath)) continue
    manifest.projectPath = currentPath
    await writeJson(target, manifest)
    relocated = true
  }
  return relocated
}

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
export async function migrateMovedProjectMetadata(project: ProjectInfo): Promise<ProjectMetadataMigrationResult> {
  const root = path.join(project.path, dataDirectory(project))
  let relocated = await migrateSnapshotManifests(root, project.path)
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
  return { relocated, discardedActiveTask }
}
