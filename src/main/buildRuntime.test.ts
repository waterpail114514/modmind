import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BuildRuntimeManager, summarizeGradleFailure } from './buildRuntime'
import { verifiedDownload } from './downloadService'
import { createHash } from 'node:crypto'
import { CreationFeedbackService } from './creationFeedbackService'
import { archiveRead } from './archiveInspection'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

class NetworkBuildRuntime extends BuildRuntimeManager {
  environment() { return this.gradleEnvironment({ executable: 'gradlew', usesWrapper: true, source: 'wrapper', javaHome: 'jdk' }) }
  prepare(project: ProjectInfo) { return this.prepareGradleWrapperDownload(project, 0) }
}

it('applies finite Java and Gradle download limits without a testing plugin', () => {
  const runtime = new NetworkBuildRuntime({ getProject: () => null, onState: () => undefined, onEvent: () => undefined })
  expect(runtime.environment().JAVA_TOOL_OPTIONS).toContain('-Dsun.net.client.defaultReadTimeout=60000')
  expect(runtime.environment().JAVA_TOOL_OPTIONS).toContain('-Dorg.gradle.internal.http.connectionTimeout=30000')
  const failure = summarizeGradleFailure("Could not get resource 'https://maven.minecraftforge.net/example.jar'.\njava.net.SocketTimeoutException: Read timed out")
  expect(failure).toContain('Maven')
  expect(failure).toContain('example.jar')
  expect(failure).not.toContain('Gradle 分发包')
  expect(summarizeGradleFailure(failure + '\n/project/Main.java:12: error: cannot find symbol\n missingMethod();')).toContain('cannot find symbol')
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
    await runtime.prepare(project)
    await runtime.prepare(project)
    expect(download).toHaveBeenCalledOnce()
    expect(await fs.readFile(properties, 'utf8')).toBe(content)
    for (const unsupported of [content + 'zipStorePath=custom/cache\n', `distributionUrl=${url}\n`, 'distributionUrl=file:///offline/gradle-8.12.1-bin.zip\n']) {
      await fs.writeFile(properties, unsupported)
      await runtime.prepare(project)
      expect(await fs.readFile(properties, 'utf8')).toBe(unsupported)
    }
    expect(download).toHaveBeenCalledOnce()
  } finally { download.mockRestore() }
})

it('builds a real modpack artifact and records evidence without a testing plugin or game runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-core-build-')); roots.push(root)
  const project = { path: root, kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', name: 'Core pack', namespace: 'core_pack', createdAt: '' } as ProjectInfo
  await fs.writeFile(path.join(root, 'modmind.project.json'), JSON.stringify(project))
  await fs.writeFile(path.join(root, 'modmind.pack.json'), JSON.stringify({ version: 1, name: project.name, loader: project.loader, minecraftVersion: project.minecraftVersion, mods: [], modules: [] }))
  const manager = new BuildRuntimeManager({ getProject: () => project, onState: () => undefined, onEvent: () => undefined })
  const feedback = new CreationFeedbackService(project)
  const artifact = await feedback.build(() => manager.buildProject())
  expect(artifact.path).toMatch(/\.mrpack$/)
  expect((await fs.stat(artifact.path)).isFile()).toBe(true)
  expect((await archiveRead(artifact.path, 'modrinth.index.json')).toString('utf8')).toContain('Core pack')
  expect((await feedback.state()).builds.at(-1)).toMatchObject({ status: 'built', path: artifact.path })
  expect(await feedback.verifyLatestBuild()).toBe(true)
  await expect(fs.stat(path.join(root, '.modmind', 'minecraft'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await manager.refresh()).stage).toBe('idle')
  await manager.stop()
})
