import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createModpackTemplate, addModpackModule } from './modpackService'
import { delegateModpackModule, ModpackModuleTasks } from './modpackModuleDelegation'
import { inspectModpackModules } from './modpackModuleTools'
import { CreationFeedbackService } from './creationFeedbackService'
import { configureAgentProtection } from './agentProtection'

const roots: string[] = []
afterEach(async () => {
  configureAgentProtection([])
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
async function fixture(linked = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'module-delegation-')); roots.push(root)
  const pack: ProjectInfo = { kind: 'modpack', path: path.join(root, 'pack'), name: 'Pack', namespace: 'pack', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  await fs.mkdir(pack.path)
  await createModpackTemplate(pack)
  const module: ProjectInfo = { ...pack, kind: 'mod', namespace: 'cards', name: 'Cards', path: linked ? path.join(root, 'external') : path.join(pack.path, 'modules/cards') }
  await fs.mkdir(path.join(module.path, 'src'), { recursive: true })
  await fs.writeFile(path.join(module.path, 'modmind.project.json'), JSON.stringify(module))
  await fs.writeFile(path.join(module.path, 'src/Card.java'), 'class Card { int power = 1; }')
  await addModpackModule(pack, { name: module.name, namespace: module.namespace, path: linked ? module.path : 'modules/cards', linked, createdAt: '' })
  return { pack, module }
}

it.each([false, true])('delegates to the actual module and records its changes (linked=%s)', async linked => {
  const { pack, module } = await fixture(linked)
  const feedback = new CreationFeedbackService(pack)
  await feedback.begin('parent', '修改卡牌效果')
  const run = vi.fn(async (selected: ProjectInfo, request: string) => {
    expect(selected.path).toBe(module.path)
    expect(selected.kind).toBe('mod')
    expect(request).toContain('Minecraft 1.21.1 / fabric')
    expect(request).toContain('将卡牌伤害改为 5')
    await fs.writeFile(path.join(selected.path, 'src/Card.java'), 'class Card { int power = 5; }')
    return { summary: '已修改', tests: ['build passed'] }
  })
  const result = await delegateModpackModule(pack, { namespace: 'cards', request: '将卡牌伤害改为 5' }, {
    signal: new AbortController().signal,
    beforeRun: async selected => { await feedback.target('parent', selected.path) }, run
  })
  expect(result.summary).toBe('已修改')
  expect(run).toHaveBeenCalledOnce()
  expect((await feedback.finishTargets('parent'))[0].changedFiles).toEqual(['src/Card.java'])
  expect(await inspectModpackModules(pack, { operation: 'read', namespace: 'cards', path: 'src/Card.java' })).toMatchObject({ content: 'class Card { int power = 5; }' })
  expect(pack.kind).toBe('modpack')
})

it('rejects unknown modules, empty tasks, incompatible projects and protected roots before starting a child', async () => {
  const { pack, module } = await fixture(true)
  const run = vi.fn(async () => 'unexpected')
  const options = { signal: new AbortController().signal, run }
  await expect(delegateModpackModule(pack, { namespace: '../external', request: 'change' }, options)).rejects.toThrow('找不到')
  await expect(delegateModpackModule(pack, { namespace: 'cards', request: ' ' }, options)).rejects.toThrow('具体需求')
  await fs.writeFile(path.join(module.path, 'modmind.project.json'), JSON.stringify({ ...module, minecraftVersion: '1.20.1' }))
  await expect(delegateModpackModule(pack, { namespace: 'cards', request: 'change' }, options)).rejects.toThrow('目标版本已改变')
  await fs.writeFile(path.join(module.path, 'modmind.project.json'), JSON.stringify(module))
  configureAgentProtection([module.path])
  await expect(delegateModpackModule(pack, { namespace: 'cards', request: 'change' }, options)).rejects.toThrow('internal')
  expect(run).not.toHaveBeenCalled()
})

it('holds the module lock through cancellation cleanup and releases it after a failed child', async () => {
  const { pack } = await fixture()
  const controller = new AbortController()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = new Promise<void>(resolve => { started = resolve })
  const input = { namespace: 'cards', request: 'change' }
  const first = delegateModpackModule(pack, input, { signal: controller.signal, run: async (_module, _request, signal) => {
    expect(signal).toBe(controller.signal)
    started()
    await gate
    throw Object.assign(new Error('cancelled child'), { name: 'AbortError' })
  } })
  const failure = expect(first).rejects.toThrow('cancelled child')
  await running
  controller.abort()
  const run = vi.fn(async () => 'second result')
  await expect(delegateModpackModule(pack, input, { signal: new AbortController().signal, run })).rejects.toThrow('正在运行')
  expect(run).not.toHaveBeenCalled()
  release()
  await failure
  await expect(delegateModpackModule(pack, input, { signal: new AbortController().signal, run })).resolves.toBe('second result')
  await expect(delegateModpackModule(pack, input, { signal: controller.signal, run })).rejects.toThrow()
  expect(run).toHaveBeenCalledOnce()
})

it('rejects module directory junctions and file traversal', async () => {
  const { pack, module } = await fixture()
  await expect(inspectModpackModules(pack, { operation: 'read', namespace: 'cards', path: '../../modmind.pack.json' })).rejects.toThrow('inside')
  const renamed = path.join(pack.path, 'actual-source')
  await fs.rename(module.path, renamed)
  await fs.symlink(renamed, module.path, process.platform === 'win32' ? 'junction' : 'dir')
  const run = vi.fn(async () => ({}))
  await expect(delegateModpackModule(pack, { namespace: 'cards', request: 'change' }, { signal: new AbortController().signal, run })).rejects.toThrow('符号链接')
  expect(run).not.toHaveBeenCalled()
})

it('returns immediately, requires result collection and reports child failures without losing the task', async () => {
  let finish!: (value: string) => void
  const gate = new Promise<string>(resolve => { finish = resolve })
  const tasks = new ModpackModuleTasks(new AbortController().signal, async input => {
    if (input.namespace === 'broken') throw new Error('构建失败')
    return gate
  })
  try {
    const started = tasks.start({ namespace: 'cards', request: 'implement cards' })
    expect(started.status).toBe('running')
    expect(() => tasks.assertCollected()).toThrow('未完成')
    expect(() => tasks.start({ namespace: 'cards', request: 'duplicate' })).toThrow('正在运行')
    expect(await tasks.read({ taskId: started.taskId })).toMatchObject({ status: 'running' })
    finish('verified child result')
    expect(await tasks.read({ taskId: started.taskId, waitSeconds: 1 })).toMatchObject({ status: 'completed', result: 'verified child result' })
    expect(() => tasks.assertCollected()).not.toThrow()
    const failed = tasks.start({ namespace: 'broken', request: 'repair' })
    expect(await tasks.read({ taskId: failed.taskId, waitSeconds: 1 })).toMatchObject({ status: 'failed', error: '构建失败' })
    await expect(tasks.read({ taskId: 'other-run' })).rejects.toThrow('找不到')
    await expect(tasks.read({ taskId: failed.taskId, waitSeconds: 30 })).rejects.toThrow('0–20')
  } finally { await tasks.close() }
})

it('cancels child work when the parent stops and waits for cleanup before closing', async () => {
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let stopped = false
  const tasks = new ModpackModuleTasks(controller.signal, (_input, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { stopped = true; resolve('cancelled') }, { once: true })
    started()
  }))
  const task = tasks.start({ namespace: 'cards', request: 'implement' })
  await ready
  controller.abort()
  await tasks.close()
  expect(stopped).toBe(true)
  expect(await tasks.read({ taskId: task.taskId })).toMatchObject({ status: 'cancelled' })
  expect(() => tasks.start({ namespace: 'cards', request: 'again' })).toThrow()
})
