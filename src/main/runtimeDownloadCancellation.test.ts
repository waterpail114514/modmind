import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import type { ProjectInfo } from '../shared/types'

const control = vi.hoisted(() => ({ root: '', download: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => control.root } }))
vi.mock('./jdkDownload', () => ({ ensureManagedJdk: (...args: unknown[]) => control.download(...args) }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  setImmediate(() => child.emit('error', new Error('No preinstalled Java in isolated fixture')))
  return child
} }))
beforeEach(async () => {
  control.root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-download-cancel-'))
  control.download.mockReset()
  for (const name of ['JAVA_HOME', 'JDK_HOME', 'PATH']) vi.stubEnv(name, '')
})
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(control.root, { recursive: true, force: true }) })

it.each(['gradleRuntime', 'ensureDetectedBuildToolchains', 'ensureJavaRuntimeForTools'] as const)('%s propagates cancellation into a pending JDK download', async method => {
  const project = { path: control.root, loader: 'forge', minecraftVersion: '1.20.1', kind: 'mod' } as ProjectInfo
  const manager = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: () => {}, getJavaPreference: async () => ({}) })
  const controller = new AbortController()
  control.download.mockImplementation(async (_root, _major, _progress, signal: AbortSignal | undefined) => {
    expect(signal).toBe(controller.signal)
    return await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  })
  const methods = manager as unknown as {
    gradleRuntime(project: ProjectInfo, signal: AbortSignal): Promise<unknown>
    ensureDetectedBuildToolchains(log: string, project: ProjectInfo, signal: AbortSignal): Promise<unknown>
  }
  const operation = method === 'gradleRuntime' ? methods.gradleRuntime(project, controller.signal)
    : method === 'ensureDetectedBuildToolchains' ? methods.ensureDetectedBuildToolchains('No locally installed toolchains match languageVersion=21', project, controller.signal)
      : manager.ensureJavaRuntimeForTools(21, undefined, undefined, controller.signal)
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(control.download).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
})
