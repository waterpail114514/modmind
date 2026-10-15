import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateMovedProjectMetadata } from './projectMetadataMigration'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})))
})

describe('moved project metadata', () => {
  it('serializes concurrent relocation requests without losing an active checkpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-metadata-concurrent-'))
    roots.push(root)
    const project: ProjectInfo = { name: 'Moved', path: root, namespace: 'moved', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: 'T' }
    const data = path.join(root, '.modmind')
    const snapshot = path.join(data, 'snapshots', 'saved')
    await fs.mkdir(snapshot, { recursive: true })
    const previous = path.join(root, 'missing-old-root')
    await fs.writeFile(path.join(snapshot, 'snapshot.json'), JSON.stringify({ id: 'saved', taskId: 'task', projectPath: previous }))
    await fs.writeFile(path.join(data, 'active-ai-task.json'), JSON.stringify({ taskId: 'task', snapshotId: 'saved', projectPath: previous }))
    await Promise.all(Array.from({ length: 8 }, () => migrateMovedProjectMetadata(project)))
    expect(JSON.parse(await fs.readFile(path.join(data, 'active-ai-task.json'), 'utf8')).projectPath).toBe(root)
    expect(JSON.parse(await fs.readFile(path.join(snapshot, 'snapshot.json'), 'utf8')).projectPath).toBe(root)
    expect((await fs.readdir(snapshot)).filter(name => name.includes('.tmp-'))).toEqual([])
  })
  it('relocates checkpoints and removes the old external session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-metadata-move-'))
    roots.push(root)
    const project: ProjectInfo = {
      name: 'Moved project', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'moved_project', createdAt: new Date().toISOString()
    }
    const data = path.join(root, '.modmind')
    const snapshot = path.join(data, 'snapshots', 'snapshot-1')
    await fs.mkdir(path.join(snapshot, 'files'), {recursive: true})
    await fs.writeFile(path.join(snapshot, 'snapshot.json'), JSON.stringify({
      id: 'snapshot-1', taskId: 'task-1', projectPath: 'E:\\AAAMOD\\villagerwheretogo'
    }), 'utf8')
    await fs.writeFile(path.join(data, 'active-ai-task.json'), JSON.stringify({
      taskId: 'task-1', snapshotId: 'snapshot-1', projectPath: 'E:\\AAAMOD\\villagerwheretogo', sessionId: 'old-session'
    }), 'utf8')
    const context = path.join(data, 'external-agents', 'agent-context.md')
    await fs.mkdir(path.dirname(context), {recursive: true})
    await fs.writeFile(context, 'Project path: E:\\AAAMOD\\villagerwheretogo\n', 'utf8')
    await fs.writeFile(path.join(path.dirname(context), 'session-codex.json'), '{}', 'utf8')

    await expect(migrateMovedProjectMetadata(project)).resolves.toMatchObject({relocated: true, discardedActiveTask: false})
    const active = JSON.parse(await fs.readFile(path.join(data, 'active-ai-task.json'), 'utf8')) as Record<string, unknown>
    const manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'snapshot.json'), 'utf8')) as Record<string, unknown>
    expect(active.projectPath).toBe(root)
    expect(active.sessionId).toBeUndefined()
    expect(manifest.projectPath).toBe(root)
    await expect(fs.stat(path.join(path.dirname(context), 'session-codex.json'))).rejects.toThrow()
  })

  it('discards a checkpoint whose source project is still present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-metadata-foreign-'))
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-source-'))
    roots.push(root, source)
    await fs.writeFile(path.join(source, 'modmind.project.json'), '{}', 'utf8')
    const project: ProjectInfo = {
      name: 'Foreign checkpoint', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'foreign_checkpoint', createdAt: new Date().toISOString()
    }
    const target = path.join(root, '.modmind', 'active-ai-task.json')
    await fs.mkdir(path.dirname(target), {recursive: true})
    await fs.writeFile(target, JSON.stringify({taskId: 'task-2', snapshotId: 'missing', projectPath: source}), 'utf8')
    await expect(migrateMovedProjectMetadata(project)).resolves.toMatchObject({relocated: false, discardedActiveTask: true})
    await expect(fs.stat(target)).rejects.toThrow()
  })
})
