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
async function installedRuntime(directory: string, version = CODEX_RUNTIME_VERSION): Promise<string> {
  const executable = path.join(directory, 'codex-runtime', `${version}-${requireCodexRuntimeTarget().id}`, requireCodexRuntimeTarget().executableRelativePath)
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, version)
  return executable
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
  it('retires all obsolete versions on a cache hit while preserving user data and unrelated directories', async () => {
    const directory = await root()
    const executable = await installedRuntime(directory)
    const old = await installedRuntime(directory, '0.146.0')
    const other = await installedRuntime(directory, '0.153.0')
    const preserved = ['codex-home/config.toml', 'codex-home/sessions/history.json', 'codex-runtime/custom/README', 'codex-runtime/0.146.0-other-x64/README', `codex-runtime/0.146.0-${requireCodexRuntimeTarget().id}.staging-active/README`]
    for (const file of preserved) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await fs.writeFile(path.join(directory, file), 'keep')
    }
    vi.mocked(probeCodexExecutable).mockResolvedValue(CODEX_RUNTIME_VERSION)
    const download = vi.spyOn(verifiedDownload, 'download')
    expect(await ensureManagedCodexRuntime({ rootDir: directory })).toBe(executable)
    for (const file of [old, other]) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const file of preserved) expect(await fs.readFile(path.join(directory, file), 'utf8')).toBe('keep')
    expect(await fs.readFile(executable, 'utf8')).toBe(CODEX_RUNTIME_VERSION)
    expect(download).not.toHaveBeenCalled()
  })
  it('cleans the previous version only after successfully installing the new runtime', async () => {
    const directory = await root()
    const old = await installedRuntime(directory, '0.146.0')
    const fixture = await archive(directory, true)
    vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
      expect(await fs.readFile(old, 'utf8')).toBe('0.146.0')
      await fs.copyFile(fixture, request.destination)
      return {} as Awaited<ReturnType<typeof verifiedDownload.download>>
    })
    vi.mocked(probeCodexExecutable).mockImplementation(async () => {
      expect(await fs.readFile(old, 'utf8')).toBe('0.146.0')
      return CODEX_RUNTIME_VERSION
    })
    const executable = await ensureManagedCodexRuntime({ rootDir: directory })
    expect(await fs.readFile(executable, 'utf8')).toBe('fixture')
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retries a locked obsolete directory on the next preparation without blocking the current runtime', async () => {
    const directory = await root()
    const executable = await installedRuntime(directory)
    const old = await installedRuntime(directory, '0.146.0')
    vi.mocked(probeCodexExecutable).mockResolvedValue(CODEX_RUNTIME_VERSION)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    expect(await ensureManagedCodexRuntime({ rootDir: directory })).toBe(executable)
    expect(await fs.readFile(old, 'utf8')).toBe('0.146.0')
    remove.mockRestore()
    expect(await ensureManagedCodexRuntime({ rootDir: directory })).toBe(executable)
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never follows an obsolete installation junction or symlink', async () => {
    const directory = await root()
    const outside = await root()
    await fs.writeFile(path.join(outside, 'keep'), 'user installation')
    await installedRuntime(directory)
    const link = path.join(directory, 'codex-runtime', `0.146.0-${requireCodexRuntimeTarget().id}`)
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      vi.mocked(probeCodexExecutable).mockResolvedValue(CODEX_RUNTIME_VERSION)
      await ensureManagedCodexRuntime({ rootDir: directory })
      expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('user installation')
    } finally {
      // Remove the junction before concurrently disposing its target on Windows.
      await fs.unlink(link)
    }
  })
  it('shares concurrent installation and cleanup for the same cache', async () => {
    const directory = await root()
    await installedRuntime(directory, '0.146.0')
    const fixture = await archive(directory, true)
    vi.mocked(probeCodexExecutable).mockResolvedValue(CODEX_RUNTIME_VERSION)
    const download = vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
      await fs.copyFile(fixture, request.destination)
      return {} as Awaited<ReturnType<typeof verifiedDownload.download>>
    })
    const results = await Promise.all(Array.from({ length: 3 }, () => ensureManagedCodexRuntime({ rootDir: directory })))
    expect(new Set(results).size).toBe(1)
    expect(download).toHaveBeenCalledTimes(1)
  })
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
    const old = await installedRuntime(directory, '0.146.0')
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
    expect(await fs.readFile(old, 'utf8')).toBe('0.146.0')
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
