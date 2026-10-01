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
  it('names the default namespace before scaffolding and keeps it stable after initialization', async () => {
    const draft = await createDraftProject(await documents(), 'Fabric 1.21.1 \u95ea\u7535\u5251\u6a21\u7ec4')
    const history = path.join(draft.path, '.modmind', 'history.json')
    await fs.writeFile(history, '["existing conversation"]')
    const suggestNamespace = vi.fn(async () => '{"namespace":"lightning_sword"}')
    const services = { resolve: async () => compatibility, scaffold, suggestNamespace }
    const ready = await initializeDraftProject(draft.path, services)
    expect(ready.namespace).toBe('lightning_sword')
    expect(ready.path).toBe(draft.path)
    expect(ready.namespaceSource).toBe('ai')
    expect(await fs.readFile(path.join(ready.path, 'gradle.properties'), 'utf8')).toContain('mod_id=lightning_sword')
    expect(await fs.readFile(history, 'utf8')).toBe('["existing conversation"]')
    expect((await initializeDraftProject(draft.path, services)).namespace).toBe('lightning_sword')
    expect(suggestNamespace).toHaveBeenCalledTimes(1)
  })

  it('can initialize offline without discarding the generated namespace', async () => {
    const draft = await createDraftProject(await documents(), 'Fabric 1.21.1 \u6a21\u7ec4')
    const ready = await initializeDraftProject(draft.path, { resolve: async () => compatibility, scaffold, suggestNamespace: async () => { throw new Error('offline') } })
    expect(ready.namespace).toBe(draft.namespace)
    expect(ready.draft).toBeUndefined()
  })

  it('does not overwrite a manual rename that arrives while AI naming is pending', async () => {
    const draft = await createDraftProject(await documents(), 'Fabric 1.21.1 \u6a21\u7ec4')
    const generate = vi.fn(scaffold)
    await expect(initializeDraftProject(draft.path, {
      resolve: async () => compatibility, scaffold: generate,
      suggestNamespace: async () => {
        await fs.writeFile(path.join(draft.path, 'modmind.project.json'), JSON.stringify({ ...draft, namespace: 'manual_name', namespaceSource: 'manual' }))
        return '{"namespace":"late_ai_name"}'
      }
    })).rejects.toThrow('\u5df2\u53d8\u5316')
    expect(generate).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(path.join(draft.path, 'modmind.project.json'), 'utf8')).namespace).toBe('manual_name')
  })

  it('creates from the agent structured selection without keyword routing and does not reinitialize', async () => {
    const draft = await createDraftProject(await documents(), '按推荐的来')
    const selection = { kind: 'mod' as const, loader: 'fabric' as const, minecraftVersion: '1.21.1' }
    const services = { resolve: vi.fn(async () => compatibility), scaffold: vi.fn(scaffold) }
    const ready = await initializeDraftProject(draft.path, services, selection)
    expect(ready).toMatchObject({ ...selection, path: draft.path, namespace: draft.namespace })
    expect(ready.draft).toBeUndefined()
    expect(await initializeDraftProject(draft.path, services, selection)).toEqual(ready)
    expect(services.scaffold).toHaveBeenCalledTimes(1)
    await expect(initializeDraftProject(draft.path, services, { ...selection, loader: 'forge' })).rejects.toThrow('迁移')
  })

  it('rejects incompatible structured choices before generating files', async () => {
    const draft = await createDraftProject(await documents(), '做个项目')
    const services = { resolve: vi.fn(async () => compatibility), scaffold: vi.fn(scaffold) }
    for (const selection of [
      { kind: 'mod' as const, loader: 'paper' as const, minecraftVersion: '1.21.1' },
      { kind: 'server-plugin' as const, loader: 'fabric' as const, minecraftVersion: '1.21.1' },
      { kind: 'modpack' as const, loader: 'bedrock' as const, minecraftVersion: '1.21.1' },
      { kind: 'mod' as const, loader: 'fabric' as const, minecraftVersion: '' }
    ]) await expect(initializeDraftProject(draft.path, services, selection)).rejects.toThrow()
    expect(services.resolve).not.toHaveBeenCalled()
    expect(services.scaffold).not.toHaveBeenCalled()
    expect((await fs.readdir(draft.path)).sort()).toEqual(['.modmind', 'modmind.project.json'])
  })
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
