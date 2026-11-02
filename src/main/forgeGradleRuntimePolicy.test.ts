import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BuildRuntimeManager, summarizeGradleFailure } from './buildRuntime'
import { gradleRepositoryArguments } from './gradleRepositoryPolicy'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
// A partial cache must not bring back the hard-coded official HEAD check.
vi.mock('./forgeGradleDownloads', () => ({ prepareForgeGradleDownloads: vi.fn().mockRejectedValue(new Error('mirror temporarily unavailable')) }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
class PolicyRuntime extends BuildRuntimeManager {
  async policy(project: ProjectInfo, fallback = false) {
    await this.prepareGradleMavenFallback(project, undefined, fallback)
    return gradleRepositoryArguments(project.path, this.managedRepositoryOfficial, this.managedForge6)
  }
}

it('keeps the Forge policy through preparation failure and automatic fallback, but resets it on project or source changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-forge-runtime-')); roots.push(root)
  await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'net.minecraftforge.gradle' version '6.0.54' }")
  const project = { path: root, loader: 'forge', minecraftVersion: '1.20.1' } as ProjectInfo
  let preference: 'auto' | 'official' = 'auto'
  const runtime = new PolicyRuntime({ getProject: () => project, onState: () => undefined, onEvent: () => undefined, getGradleDownloadSource: async () => preference })
  for (const fallback of [false, true]) {
    const args = await runtime.policy(project, fallback)
    expect(await fs.readFile(args[1], 'utf8')).toContain('forgePreflightKey')
  }
  preference = 'official'
  expect(await runtime.policy(project)).toEqual([])
  preference = 'auto'
  const other = await runtime.policy({ ...project, loader: 'fabric' })
  expect(await fs.readFile(other[1], 'utf8')).not.toContain('forgePreflightKey')
})

it('reports the actual pre-compilation network failure without recommending a certificate bypass', () => {
  const output = "Failed to validate certificate for host 'https://maven.minecraftforge.net/'. To disable this check, re-run with '-Dnet.minecraftforge.gradle.check.certs=false'.\nCaused by: javax.net.ssl.SSLHandshakeException: Remote host terminated the handshake"
  const summary = summarizeGradleFailure(output)
  expect(summary).toContain('官网连接预检失败')
  expect(summary).toContain('Remote host terminated')
  expect(summary).not.toContain('check.certs=false')
  expect(summarizeGradleFailure(output + '\n/Example.java:12: error: cannot find symbol\nexample();')).toContain('cannot find symbol')
})
