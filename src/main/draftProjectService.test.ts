import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDraftProject, initializeDraftProject, recordDraftMessage } from './draftProjectService'
import { projectTemplateFiles } from './projectTemplates'
import { createModpackTemplate } from './modpackService'
import type { LoaderVersionOption, ProjectInfo } from '../shared/types'

const roots: string[] = []
async function documents(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-draft-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const compatibility: LoaderVersionOption = { loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.14', apiVersion: '0.116.4+1.21.1', javaVersion: 21, channel: 'release', supportTier: 'stable', notes: [] }
const scaffold = async (project: ProjectInfo): Promise<void> => {
  for (const [relative, content] of Object.entries(projectTemplateFiles(project))) {
    const target = path.join(project.path, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

describe('conversation-only projects', () => {
  it('creates distinct minimal projects under Documents without selecting a game version', async () => {
    const parent = await documents()
    const first = await createDraftProject(parent, '做一把闪电剑')
    const second = await createDraftProject(parent, '做一把闪电剑')
    expect(path.dirname(first.path)).toBe(path.join(parent, 'modmindproject'))
    expect(second.path).not.toBe(first.path)
    expect(first.draft?.target).toEqual({})
    expect(first.minecraftVersion).toBe('')
    expect((await fs.readdir(first.path)).sort()).toEqual(['.modmind', 'modmind.project.json'])
  })

  it('records choices across turns, preserves history, and initializes once in the same directory', async () => {
    const draft = await createDraftProject(await documents(), '制作模组')
    await recordDraftMessage(draft.path, '1.21.1')
    await recordDraftMessage(draft.path, 'Fabric')
    const history = path.join(draft.path, '.modmind', 'workbench-timeline-test.json')
    await fs.writeFile(history, '[{"content":"keep me"}]')
    const create = vi.fn(scaffold)
    const services = { resolve: vi.fn(async () => compatibility), scaffold: create }
    const [first, second] = await Promise.all([initializeDraftProject(draft.path, services), initializeDraftProject(draft.path, services)])
    expect(first.draft).toBeUndefined()
    expect(first.path).toBe(draft.path)
    expect(second.path).toBe(first.path)
    expect(first.namespace).toBe(draft.namespace)
    expect(first.minecraftVersion).toBe('1.21.1')
    expect(await fs.readFile(history, 'utf8')).toContain('keep me')
    expect(await fs.readFile(path.join(first.path, 'build.gradle'), 'utf8')).toContain('fabric')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not scaffold missing details or overwrite existing files', async () => {
    const draft = await createDraftProject(await documents(), '一个模组')
    const services = { resolve: vi.fn(async () => compatibility), scaffold }
    await expect(initializeDraftProject(draft.path, services)).rejects.toThrow('请先在对话中补充')
    expect(services.resolve).not.toHaveBeenCalled()
    await recordDraftMessage(draft.path, '1.21.1 Fabric')
    await fs.writeFile(path.join(draft.path, 'README.md'), 'existing document')
    await expect(initializeDraftProject(draft.path, services)).rejects.toThrow('未覆盖')
    expect(await fs.readFile(path.join(draft.path, 'README.md'), 'utf8')).toBe('existing document')
    expect(JSON.parse(await fs.readFile(path.join(draft.path, 'modmind.project.json'), 'utf8')).draft).toBeDefined()
  })

  it('keeps the original draft after generation failure and supports retry', async () => {
    const draft = await createDraftProject(await documents(), 'Fabric 1.21.1 模组')
    await expect(initializeDraftProject(draft.path, { resolve: async () => compatibility, scaffold: async () => { throw new Error('template failed') } })).rejects.toThrow('template failed')
    expect((await fs.readdir(draft.path)).sort()).toEqual(['.modmind', 'modmind.project.json'])
    expect((await initializeDraftProject(draft.path, { resolve: async () => compatibility, scaffold })).draft).toBeUndefined()
  })

  it('creates modpack metadata without losing the same project identity', async () => {
    const draft = await createDraftProject(await documents(), 'Fabric 1.21.1 整合包')
    const ready = await initializeDraftProject(draft.path, { resolve: async () => compatibility, scaffold: createModpackTemplate })
    expect(ready.kind).toBe('modpack')
    expect(JSON.parse(await fs.readFile(path.join(ready.path, 'modmind.pack.json'), 'utf8'))).toMatchObject({ name: ready.name, loader: 'fabric', minecraftVersion: '1.21.1' })
  })
})
