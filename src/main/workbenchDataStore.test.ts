import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDataStore } from './workbenchDataStore'

const temporaryRoots: string[] = []

async function fixture(): Promise<{ root: string; project: string; userData: string; store: WorkbenchDataStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-workbench-store-'))
  temporaryRoots.push(root)
  const project = path.join(root, 'project')
  const userData = path.join(root, 'user-data')
  await fs.mkdir(path.join(project, '.modmind'), { recursive: true })
  return { root, project, userData, store: new WorkbenchDataStore(userData) }
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) result.push(target)
    }
  }
  await visit(root)
  return result
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('WorkbenchDataStore', () => {
  it('imports and preserves a legacy timeline larger than the old 32 MB byte limit', async () => {
    const { project, userData, store } = await fixture()
    const key = '.modmind/workbench-timeline-ws-large.json'
    const content = JSON.stringify([{ id: 'large', kind: 'answer', content: '中'.repeat(11 * 1024 * 1024), time: '2026-01-01T00:00:00.000Z' }])
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(32 * 1024 * 1024)
    await fs.writeFile(path.join(project, ...key.split('/')), content, 'utf8')

    const loaded = await store.read(project, key)

    expect(loaded).toMatchObject({ status: 'ok', source: 'legacy', revision: 1 })
    expect(loaded.content).toBe(content)
    expect((await filesBelow(path.join(project, '.modmind', 'workbench-store'))).some((file) => file.endsWith('.snapshot.gz'))).toBe(true)
    expect((await filesBelow(path.join(userData, 'workbench-mirror'))).some((file) => file.endsWith('.snapshot.gz'))).toBe(true)
  }, 30_000)

  it('recovers from the mirror when every project-store snapshot is corrupted', async () => {
    const { project, store } = await fixture()
    const key = '.modmind/workbench-timeline-ws-recover.json'
    const content = JSON.stringify([{ id: 'saved', kind: 'user', content: '不能丢', time: '2026-01-01T00:00:00.000Z' }])
    await store.write(project, key, content)
    const projectStore = path.join(project, '.modmind', 'workbench-store')
    for (const file of await filesBelow(projectStore)) {
      if (file.endsWith('.snapshot.gz')) await fs.writeFile(file, 'corrupt', 'utf8')
    }
    await fs.writeFile(path.join(project, ...key.split('/')), '{broken', 'utf8')

    const loaded = await new WorkbenchDataStore(path.join(path.dirname(project), 'user-data')).read(project, key)

    expect(loaded.status).toBe('ok')
    expect(loaded.content).toBe(content)
    expect(loaded.source).toBe('user-mirror')
  })

  it('serializes and coalesces concurrent writes without allowing an older snapshot to win', async () => {
    const { project, store } = await fixture()
    const key = '.modmind/workbench-timeline-ws-race.json'
    const values = ['one', 'two', 'three'].map((value) => JSON.stringify([{ id: value, kind: 'answer', content: value, time: '2026-01-01T00:00:00.000Z' }]))

    await Promise.all(values.map((value) => store.write(project, key, value)))
    await store.flush()

    const loaded = await store.read(project, key)
    expect(loaded).toMatchObject({ status: 'ok', content: values[2] })
    expect(loaded.revision).toBeGreaterThanOrEqual(1)
  })

  it('blocks overwrite when the only existing copy is malformed', async () => {
    const { project, store } = await fixture()
    const key = '.modmind/workbench-timeline-ws-corrupt.json'
    const target = path.join(project, ...key.split('/'))
    await fs.writeFile(target, '{"not":"an array"}', 'utf8')

    const loaded = await store.read(project, key)

    expect(loaded.status).toBe('unavailable')
    await expect(store.write(project, key, '[]')).rejects.toThrow(/阻止覆盖/)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"not":"an array"}')
  })

  it('uses a durable tombstone while retaining historical revisions', async () => {
    const { project, store } = await fixture()
    const key = '.modmind/workbench-timeline-ws-delete.json'
    const content = JSON.stringify([{ id: 'saved', kind: 'user', content: '保留历史', time: '2026-01-01T00:00:00.000Z' }])
    await store.write(project, key, content)

    await store.delete(project, key)
    const loaded = await store.read(project, key)

    expect(loaded).toMatchObject({ status: 'missing', source: 'tombstone' })
    expect((await filesBelow(path.join(project, '.modmind', 'workbench-store'))).filter((file) => file.endsWith('.snapshot.gz')).length).toBeGreaterThanOrEqual(2)
  })

  it('serializes concurrent journal appends across store instances', async () => {
    const { project, userData } = await fixture()
    const journal = '.modmind/conversations-v3/ws-race.jsonl'
    const a = new WorkbenchDataStore(userData)
    const b = new WorkbenchDataStore(userData)
    const lines = Array.from({ length: 12 }, (_, index) => `${JSON.stringify({ eventId: `e-${index}`, conversationId: 'ws-race', generation: 0, turnId: `t-${index}`, sequence: index + 1, kind: 'system', time: new Date().toISOString(), payload: { index } })}\n`)
    await Promise.all(lines.map((line, index) => (index % 2 ? b : a).appendJournal(project, journal, line)))
    const stored = await a.readJournal(project, journal)
    expect(new Set(stored).size).toBe(12)
  })
})
