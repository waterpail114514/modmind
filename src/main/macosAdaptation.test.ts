import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexRuntimeTarget } from './runtimeTarget'
import { managedCodexRuntimePath } from './codexSetup'
import { validateCodexFile, probeCodexExecutable } from './codexExecutable'
import { runtimePlatformInfo } from '../shared/platform'
import { platformWindowOptions } from './platformWindow'
import { DeviceDeepLinkQueue } from './deviceDeepLinkQueue'
import { quotePosixArgument, terminalScript } from './nativeTerminal'
import { desktopProcessEnvironment } from './desktopEnvironment'

describe('macOS platform contracts', () => {
  it('supplies Homebrew and user npm paths to Finder-launched subprocesses', () => {
    const environment = desktopProcessEnvironment({ PATH: '/usr/bin:/bin', NPM_CONFIG_PREFIX: '/Users/中文 user/npm' }, 'darwin', '/Users/中文 user')
    expect(environment.PATH?.split(':')).toContain('/opt/homebrew/bin')
    expect(environment.PATH?.split(':')).toContain('/Users/中文 user/npm/bin')
    expect(desktopProcessEnvironment({ PATH: 'custom' }, 'win32').PATH).toBe('custom')
  })
  it('resolves distinct targets and never falls back from an unsupported architecture', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
      const target = resolveCodexRuntimeTarget(platform, arch)
      expect(target.supported).toBe(true)
      if (!target.supported) return
      expect(target.descriptor.id).toBe(`${platform}-${arch}`)
      expect(Buffer.from(target.descriptor.integrity.slice(7), 'base64')).toHaveLength(64)
      expect(managedCodexRuntimePath('/cache', platform, arch)).toContain(`${platform}-${arch}`)
    }
    expect(resolveCodexRuntimeTarget('darwin', 'ia32').supported).toBe(false)
    expect(resolveCodexRuntimeTarget('freebsd', 'x64').supported).toBe(false)
  })
  it('exposes immutable platform information and native window controls only on macOS', () => {
    expect(runtimePlatformInfo('darwin', 'arm64', true)).toEqual({ os: 'macos', arch: 'arm64', packaged: true })
    expect(Object.isFrozen(runtimePlatformInfo('win32', 'x64', false))).toBe(true)
    expect(platformWindowOptions('darwin')).toMatchObject({ frame: true, titleBarStyle: 'hiddenInset' })
    expect(platformWindowOptions('win32').frame).toBe(false)
  })
  it('retains cold-start links, deduplicates and serializes warm links', async () => {
    const seen: string[] = []
    const handler = vi.fn(async (url: string) => { seen.push(url) })
    const queue = new DeviceDeepLinkQueue(handler)
    queue.enqueue('mcdev://one'); queue.enqueue('mcdev://one')
    expect(handler).not.toHaveBeenCalled()
    queue.setReady()
    queue.enqueue('mcdev://two')
    await vi.waitFor(() => expect(seen).toEqual(['mcdev://one', 'mcdev://two']))
  })
  it('caps a pre-ready queue and ignores oversized or unrelated input', async () => {
    const handler = vi.fn(async () => undefined)
    const queue = new DeviceDeepLinkQueue(handler)
    queue.enqueue('https://example.com'); queue.enqueue(`mcdev://${'x'.repeat(9000)}`)
    for (let i = 0; i < 50; i++) queue.enqueue(`mcdev://${i}`)
    queue.setReady()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(16))
  })
  it('rejects NUL terminal input and unavailable executables', async () => {
    expect(() => quotePosixArgument('bad\0path')).toThrow()
    await expect(probeCodexExecutable(path.join(os.tmpdir(), 'missing-modmind-codex'))).rejects.toThrow(/无法运行/)
  })
  it.skipIf(process.platform === 'win32')('executes hostile POSIX arguments literally and removes the script', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "Mac 中文 ' path-"))
    try {
      const script = path.join(root, 'test.command')
      const output = path.join(root, 'args.json')
      const args = ["single'quote", '$(touch INJECTED)', '`touch INJECTED`', 'line\nbreak', '空 格']
      await fs.writeFile(script, terminalScript({ executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))', output, ...args], cwd: root }), { mode: 0o700 })
      expect((await fs.stat(script)).mode & 0o777).toBe(0o700)
      await promisify(execFile)(script, [])
      expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual(args)
      await expect(fs.access(script)).rejects.toThrow()
      await expect(fs.access(path.join(root, 'INJECTED'))).rejects.toThrow()
      await fs.symlink(process.execPath, path.join(root, 'escape'))
      await expect(validateCodexFile(root, path.join(root, 'escape'))).rejects.toThrow()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
