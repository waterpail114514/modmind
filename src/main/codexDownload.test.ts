import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureManagedCodexRuntime, managedCodexExecutablePath, managedCodexRuntimePath, CODEX_RUNTIME_VERSION } from './codexSetup'
import { verifiedDownload } from './downloadService'
import { probeCodexExecutable } from './codexExecutable'
import { requireCodexRuntimeTarget } from './runtimeTarget'

vi.mock('./codexExecutable', async (original) => ({ ...await original<typeof import('./codexExecutable')>(), probeCodexExecutable: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'Codex 中文 cache '))
  roots.push(directory)
  return directory
}
async function archive(directory: string, includeExecutable: boolean): Promise<string> {
  const unpack = path.join(directory, 'fixture')
  const file = path.join(unpack, requireCodexRuntimeTarget().executableRelativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(includeExecutable ? file : path.join(unpack, 'README'), 'fixture')
  const result = path.join(directory, 'fixture.tgz')
  await promisify(execFile)(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', result, '-C', unpack, 'package', ...(includeExecutable ? [] : ['README'])])
  return result
}
describe('managed Codex cache protection', () => {
  it('probes an existing valid runtime without downloading', async () => {
    const directory = await root()
    const executable = managedCodexExecutablePath(directory)
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'working')
    vi.mocked(probeCodexExecutable).mockResolvedValue(CODEX_RUNTIME_VERSION)
    const download = vi.spyOn(verifiedDownload, 'download')
    expect(await ensureManagedCodexRuntime({ rootDir: directory })).toBe(executable)
    expect(download).not.toHaveBeenCalled()
  })
  it.each(['hash', 'missing', 'probe'])('preserves the existing cache when %s validation fails', async failure => {
    const directory = await root()
    const runtime = managedCodexRuntimePath(directory)
    const executable = managedCodexExecutablePath(directory)
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'previous-runtime')
    vi.mocked(probeCodexExecutable).mockRejectedValue(new Error('probe failed'))
    const fixture = failure === 'hash' ? undefined : await archive(directory, failure !== 'missing')
    vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
      expect(request.expectedHash).toEqual({ algorithm: 'sha512', value: requireCodexRuntimeTarget().sha512 })
      if (!fixture) throw new Error('sha512 mismatch')
      await fs.copyFile(fixture, request.destination)
      return {} as Awaited<ReturnType<typeof verifiedDownload.download>>
    })
    await expect(ensureManagedCodexRuntime({ rootDir: directory })).rejects.toThrow()
    expect(await fs.readFile(executable, 'utf8')).toBe('previous-runtime')
    expect((await fs.readdir(path.dirname(runtime))).filter(name => name.includes('.staging-'))).toEqual([])
  })
  it.skipIf(process.platform === 'win32')('sets Unix execute bits before the version probe and commits a valid runtime', async () => {
    const directory = await root()
    const fixture = await archive(directory, true)
    vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
      await fs.copyFile(fixture, request.destination)
      return {} as Awaited<ReturnType<typeof verifiedDownload.download>>
    })
    vi.mocked(probeCodexExecutable).mockImplementation(async executable => {
      expect((await fs.stat(executable)).mode & 0o777).toBe(0o755)
      return CODEX_RUNTIME_VERSION
    })
    const executable = await ensureManagedCodexRuntime({ rootDir: directory })
    expect(await fs.readFile(executable, 'utf8')).toBe('fixture')
  })
})
