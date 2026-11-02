import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import { verifiedDownload } from './downloadService'
import { createHash } from 'node:crypto'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

class NetworkBuildRuntime extends MinecraftRuntimeManager {
  environment() { return (this as unknown as { gradleEnvironment: (runtime: unknown) => NodeJS.ProcessEnv }).gradleEnvironment({ executable: 'gradlew', usesWrapper: true, source: 'wrapper', javaHome: 'jdk' }) }
  prepareWrapper(project: ProjectInfo) { return (this as unknown as { prepareGradleWrapperDownload: (project: ProjectInfo, attempt: number) => Promise<void> }).prepareGradleWrapperDownload(project, 0) }
  retryMirror(project: ProjectInfo, log: string, attempt: number) { return (this as unknown as { retryGradleVerification: (project: ProjectInfo, log: string, signal: undefined, toolchainAttempt: number, attempt: number) => Promise<unknown> }).retryGradleVerification(project, log, undefined, 0, attempt) }
}

it('retries a managed Maven mirror failure once without rotating or re-downloading the Gradle ZIP', async () => {
  const project = { path: 'fixture', kind: 'mod', loader: 'fabric', minecraftVersion: '1.20.1' } as ProjectInfo
  const runtime = new NetworkBuildRuntime({ getProject: () => project, onState: () => undefined, onEvent: () => undefined })
  const internals = runtime as unknown as { ensureDetectedBuildToolchains: () => Promise<boolean>; prepareGradleWrapperDownload: () => Promise<void> }
  internals.ensureDetectedBuildToolchains = vi.fn(async () => false)
  internals.prepareGradleWrapperDownload = vi.fn(async () => {})
  const log = "Could not GET 'https://bmclapi2.bangbang93.com/maven/example.jar'. Read timed out"
  expect(await runtime.retryMirror(project, log, 0)).toEqual({ toolchainRetryAttempt: 0, distributionRetryAttempt: 1 })
  expect(await runtime.retryMirror(project, log, 1)).toBeNull()
  expect(internals.prepareGradleWrapperDownload).not.toHaveBeenCalled()
})

it('applies finite Java and Gradle download limits without a testing plugin', () => {
  const runtime = new NetworkBuildRuntime({ getProject: () => null, onState: () => undefined, onEvent: () => undefined })
  expect(runtime.environment().JAVA_TOOL_OPTIONS).toContain('-Dsun.net.client.defaultReadTimeout=60000')
  expect(runtime.environment().JAVA_TOOL_OPTIONS).toContain('-Dorg.gradle.internal.http.connectionTimeout=30000')

})

it('prefetches a checksummed mod Wrapper through managed downloads and repairs an incomplete archive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-wrapper-')); roots.push(root)
  const version = 'qa-' + path.basename(root), filename = `gradle-${version}-bin.zip`
  const url = 'https://wrapper.example.invalid/' + filename, bytes = Buffer.from('checksummed fixture, not an executable distribution')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const cache = path.join(os.tmpdir(), 'gradle-runtime/cache/wrapper/dists', filename.slice(0, -4), BigInt('0x' + createHash('md5').update(url).digest('hex')).toString(36))
  roots.push(path.dirname(cache))
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, filename), 'partial')
  const properties = path.join(root, 'gradle/wrapper/gradle-wrapper.properties')
  await fs.mkdir(path.dirname(properties), { recursive: true })
  const content = `distributionUrl=${url}\ndistributionSha256Sum=${checksum}\n`
  await fs.writeFile(properties, content)
  const project = { path: root, kind: 'mod', loader: 'forge', minecraftVersion: '1.20.1' } as ProjectInfo
  const runtime = new NetworkBuildRuntime({ getProject: () => project, onState: () => undefined, onEvent: () => undefined })
  const download = vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
    expect(request).toMatchObject({ expectedHash: { algorithm: 'sha256', value: checksum }, sources: [{ url }] })
    await fs.writeFile(request.destination, bytes)
    return { source: request.sources[0], destination: request.destination, bytes: bytes.length, attempts: 1, failures: [] }
  })
  try {
    await runtime.prepareWrapper(project)
    await runtime.prepareWrapper(project)
    expect(download).toHaveBeenCalledOnce()
    expect(await fs.readFile(properties, 'utf8')).toBe(content)
    for (const unsupported of [content + 'zipStorePath=custom/cache\n', `distributionUrl=${url}\n`, 'distributionUrl=file:///offline/gradle-8.12.1-bin.zip\n']) {
      await fs.writeFile(properties, unsupported)
      await runtime.prepareWrapper(project)
      expect(await fs.readFile(properties, 'utf8')).toBe(unsupported)
    }
    expect(download).toHaveBeenCalledOnce()
  } finally { download.mockRestore() }
})

