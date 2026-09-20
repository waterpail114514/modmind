import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStoredZip } from './bedrockAddon'
import { runInspirationResearch } from './inspirationResearch'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspiration-research-'))
  roots.push(root)
  const project: ProjectInfo = { path: path.join(root, 'project'), name: 'Research', namespace: 'research', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  await fs.mkdir(path.join(project.path, '.modmind', 'attachments'), { recursive: true })
  const options = { cacheRoot: path.join(root, 'cache'), signal: new AbortController().signal, ensureJava: vi.fn(async () => { throw new Error('Must not launch Java') }) }
  const jar = (version: string, config: string) => createStoredZip([
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'research', name: 'Research', version, depends: { minecraft: '>=1.21', helper: '*' } })) },
    { name: 'config.json', data: Buffer.from(config) }
  ])
  await fs.writeFile(path.join(project.path, 'before.jar'), jar('1.0', '{"x":1}'))
  await fs.writeFile(path.join(project.path, 'after.jar'), jar('2.0', '{"x":2}'))
  return { root, project, options }
}

describe('inspiration material analysis', () => {
  it('inspects real archives, reads evidence and detects same-size content changes without executing Java', async () => {
    const { project, options } = await fixture()
    const original = await fs.readFile(path.join(project.path, 'before.jar'))
    const inspect = await runInspirationResearch(project, { operation: 'inspect', path: 'before.jar', limit: 1 }, options) as any
    expect(inspect.metadata.profile.primaryModId).toBe('research')
    expect(inspect.nextOffset).toBe(1)
    expect(inspect.metadata.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ modId: 'helper' })]))
    const resource = await runInspirationResearch(project, { operation: 'resource', path: 'before.jar', relativePath: 'config.json' }, options) as any
    expect(resource.lines).toEqual([{ line: 1, text: '{"x":1}' }])
    const compare = await runInspirationResearch(project, { operation: 'compare', path: 'before.jar', otherPath: 'after.jar' }, options) as any
    expect(compare.items).toEqual(expect.arrayContaining([{ path: 'config.json', status: 'changed' }]))
    expect(await fs.readFile(path.join(project.path, 'before.jar'))).toEqual(original)
    expect(options.ensureJava).not.toHaveBeenCalled()
  })

  it('reads cached source by the current JAR hash with paging and refuses arbitrary cache paths', async () => {
    const { project, options } = await fixture()
    const inspect = await runInspirationResearch(project, { operation: 'inspect', path: 'before.jar' }, options) as any
    const sources = path.join(options.cacheRoot, 'jars', inspect.sha256, 'sources')
    await fs.mkdir(sources, { recursive: true })
    await fs.writeFile(path.join(sources, 'Feature.java'), 'class Feature {\n int damage = 42;\n}')
    await fs.writeFile(path.join(path.dirname(sources), 'provenance.json'), JSON.stringify({ schemaVersion: 1, readOnly: true, sourceSha256: inspect.sha256 }))
    const cached = await runInspirationResearch(project, { operation: 'decompile', path: 'before.jar' }, options) as any
    expect(cached.reused).toBe(true)
    expect(options.ensureJava).not.toHaveBeenCalled()
    const source = await runInspirationResearch(project, { operation: 'read', path: 'before.jar', relativePath: 'Feature.java', startLine: 2, limit: 1 }, options) as any
    expect(source.lines).toEqual([{ line: 2, text: ' int damage = 42;' }])
    expect(source.nextStartLine).toBe(3)
    const search = await runInspirationResearch(project, { operation: 'search', path: 'before.jar', query: 'damage' }, options) as any
    expect(search.matches[0]).toMatchObject({ file: 'Feature.java', line: 2 })
    await expect(runInspirationResearch(project, { operation: 'read', path: 'before.jar', relativePath: '../private' }, options)).rejects.toThrow()
    await expect(runInspirationResearch(project, { operation: 'inspect', path: '../private.jar' }, options)).rejects.toThrow()
    await expect(runInspirationResearch(project, { operation: 'inspect', path: '.modmind/private.jar' }, options)).rejects.toThrow()
  })

  it('extracts numbered log evidence, pages results and stops aborted analysis', async () => {
    const { project, options } = await fixture()
    const logPath = '.modmind/attachments/crash.log'
    await fs.writeFile(path.join(project.path, logPath), 'start\nERROR failed\nCaused by: missing helper\nend')
    const result = await runInspirationResearch(project, { operation: 'logs', path: logPath, limit: 2 }, options) as any
    expect(result.items).toEqual([{ line: 1, text: 'start' }, { line: 2, text: 'ERROR failed' }])
    expect(result.nextOffset).toBe(2)
    expect(result.matches).toBe(2)
    const raw = await runInspirationResearch(project, { operation: 'text', path: logPath, startLine: 3, limit: 1 }, options) as any
    expect(raw.lines).toEqual([{ line: 3, text: 'Caused by: missing helper' }])
    await expect(runInspirationResearch(project, { operation: 'logs', path: logPath }, { ...options, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(options.ensureJava).not.toHaveBeenCalled()
  })
})

it('persists project knowledge independently and serializes simultaneous edits', async () => {
  const { root, project } = await fixture()
  const store = new InspirationKnowledgeStore(path.join(root, 'knowledge'))
  await Promise.all([
    store.update(project.path, { id: 'a', title: '玩法', content: '雷电剑' }),
    store.update(project.path, { id: 'b', title: '技术', content: 'Fabric' })
  ])
  const reopened = new InspirationKnowledgeStore(path.join(root, 'knowledge'))
  expect(await reopened.read(project.path)).toHaveLength(2)
  expect(await reopened.read(path.join(root, 'other'))).toEqual([])
  await reopened.update(project.path, { id: 'a', title: '玩法', content: '冷却 10 秒' })
  expect((await reopened.read(project.path)).find(item => item.id === 'a')?.content).toBe('冷却 10 秒')
  expect(await reopened.update(project.path, { id: 'b', remove: true })).toHaveLength(1)
  await expect(reopened.update(project.path, { title: '', content: '' })).rejects.toThrow()
})
