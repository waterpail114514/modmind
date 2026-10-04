import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import type { ProjectInfo } from '../shared/types'
import type { GradleVerificationResult } from '../shared/minecraft'
import { downloadActivities } from './downloadActivityService'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
  downloadActivities.clearFinished()
})

const networkFailure = 'Downloading https://services.gradle.org/distributions/gradle-8.12.1-bin.zip\njava.net.ConnectException: Connection timed out\n at org.gradle.wrapper.Install.forceFetch(SourceFile:2)'
const toolchainFailure = 'BUILD FAILED\nNo locally installed toolchains match\nlanguageVersion=17'
interface Attempt { output?: string; code?: number; error?: string; pending?: boolean }
interface Harness {
  testGradleTask(tasks: string[], stable?: number, signal?: AbortSignal): Promise<GradleVerificationResult>
  runGradleBuild(project: ProjectInfo): Promise<void>
  buildProjectInternal(): Promise<unknown>
  verificationProcess: EventEmitter | null
}

async function fixture(attempts: Attempt[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-gradle-recovery-'))
  roots.push(root)
  const properties = path.join(root, 'gradle/wrapper/gradle-wrapper.properties')
  await fs.mkdir(path.dirname(properties), { recursive: true })
  await fs.writeFile(properties, 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12.1-bin.zip\n')
  const project = { path: root, name: 'Recovery', namespace: 'recovery', loader: 'forge', minecraftVersion: '1.20.1' } as ProjectInfo
  const manager = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: () => {} })
  const urls: string[] = []
  let prepared = false
  const recover = vi.fn(async (log: string) => {
    if (!prepared && log.includes('languageVersion=17')) { prepared = true; return true }
    return false
  })
  const spawn = vi.fn(() => {
    const attempt = attempts.shift()
    if (!attempt) throw new Error('Unexpected Gradle retry')
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    setImmediate(() => {
      if (attempt.error) child.emit('error', new Error(attempt.error))
      if (attempt.output) child.stdout.emit('data', Buffer.from(attempt.output))
      if (!attempt.pending) child.emit('close', attempt.code ?? 0, null)
    })
    return child
  })
  Object.assign(manager, {
    gradleRuntime: async () => { urls.push(await fs.readFile(properties, 'utf8')); return { javaHome: root, executable: 'gradlew' } },
    gradleEnvironment: () => ({}), spawnGradle: spawn, stopStaleGradleDaemons: async () => {},
    ensureDetectedBuildToolchains: recover, syncProjectMod: async () => ({ name: 'result.jar' }),
    killProcessTree: (child: EventEmitter) => { setImmediate(() => child.emit('close', 1, null)) }
  })
  return { manager: manager as unknown as Harness, project, root, urls, spawn, recover }
}

describe('Gradle failure recovery', () => {
  it.each(['runGradleBuild', 'buildProjectInternal'] as const)('%s preserves the selected mirror after a toolchain retry', async method => {
    const f = await fixture([{ output: networkFailure, code: 1 }, { output: toolchainFailure, code: 1 }, { output: 'BUILD SUCCESSFUL' }])
    if (method === 'runGradleBuild') await f.manager.runGradleBuild(f.project)
    else await f.manager.buildProjectInternal()
    expect(f.urls).toHaveLength(3)
    expect(f.urls[1]).not.toBe(f.urls[0])
    expect(f.urls[2]).toBe(f.urls[1])
  })

  it('recovers discovery and execution failures and writes EULA to the server directory', async () => {
    const f = await fixture([{ output: networkFailure, code: 1 }, { output: 'runServer - Server' }, { output: toolchainFailure, code: 1 }, { output: 'runServer - Server' }, { output: 'BUILD SUCCESSFUL' }])
    expect((await f.manager.testGradleTask(['runServer'])).success).toBe(true)
    expect(f.urls[2]).toBe(f.urls[1])
    expect(await fs.readFile(path.join(f.root, 'run-server/eula.txt'), 'utf8')).toBe('eula=true\n')
    expect(await fs.readFile(path.join(f.root, 'run/eula.txt'), 'utf8')).toBe('eula=true\n')
  })

  it('reports spawn failures without an unhandled error or waiting for the timeout', async () => {
    const f = await fixture([{ output: 'runServer - Server' }, { error: 'spawn ENOENT', code: 1 }])
    const result = await f.manager.testGradleTask(['runServer'])
    expect(result.success).toBe(false)
    expect(result.summary).toContain('spawn ENOENT')
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('cancels task discovery without retrying', async () => {
    const f = await fixture([{ pending: true }])
    const controller = new AbortController()
    const result = f.manager.testGradleTask(['runServer'], 0, controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.manager.verificationProcess).toBeTruthy())
    controller.abort()
    await rejected
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.manager.verificationProcess).toBeNull()
  })

  it('does not report a crashed server as stable merely because polling was delayed', async () => {
    const f = await fixture([{ output: 'runServer - Server' }, { output: 'Done (1.0s)!', code: 1 }])
    expect((await f.manager.testGradleTask(['runServer'], 1)).success).toBe(false)
  })

  it.each([
    ['Downloading https://services.gradle.org/distributions/gradle-8.12.1-bin.zip\nBUILD FAILED\ncompileJava error', 'completed'],
    ['Downloading https://services.gradle.org/distributions/gradle-8.12.1-bin.zip\nunknown bootstrap error', 'failed']
  ])('settles distribution status independently of build failure: %s', async (output, status) => {
    const complete = vi.spyOn(downloadActivities, 'complete')
    const fail = vi.spyOn(downloadActivities, 'fail')
    const f = await fixture([{ output, code: 1 }])
    await expect(f.manager.runGradleBuild(f.project)).rejects.toThrow()
    expect(complete).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0)
    expect(fail).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0)
  })
})
