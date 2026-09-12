import { describe, expect, it, vi } from 'vitest'
import { spawnManaged, terminateProcessTree } from './processTree'
import { EventEmitter, once } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFileSync: vi.fn(actual.execFileSync) }
})

describe('managed process trees', () => {
  it.each(['absent', 'present', 'unreadable'] as const)('checks Darwin EPERM against the process table (%s)', async (state) => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw denied })
    const fixture = Object.assign(new EventEmitter(), {
      pid: 99999999,
      exitCode: null as number | null,
      signalCode: null
    })
    const fake = fixture as ChildProcess
    vi.mocked(spawn).mockReturnValueOnce(fake as ReturnType<typeof spawn>)
    if (state === 'unreadable') vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('ps failed') })
    else vi.mocked(execFileSync).mockReturnValueOnce(state === 'absent' ? '1\n42\n' : '1\n99999999\n')
    try {
      const child = spawnManaged('test-fixture', [])
      if (state === 'absent') await expect(terminateProcessTree(child)).resolves.toBeUndefined()
      else await expect(terminateProcessTree(child)).rejects.toBe(denied)
      expect(kill).toHaveBeenCalledWith(-99999999, 0)
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
    } finally {
      // Remove the fake owned group without touching a real process.
      fixture.exitCode = 0
      kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
      await terminateProcessTree(fake)
      kill.mockRestore()
      platform.mockRestore()
    }
  })
  it('ignores missing PIDs and the application PID', async () => {
    await terminateProcessTree({} as ChildProcess)
    await terminateProcessTree({ pid: process.pid } as ChildProcess)
  })
  it.skipIf(process.platform === 'win32')('surfaces permission errors and never signals an unowned process group', async () => {
    const groupSignal = vi.spyOn(process, 'kill')
    const child = { pid: 99999999, exitCode: null, signalCode: null, kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } as unknown as ChildProcess
    try {
      await expect(terminateProcessTree(child)).rejects.toMatchObject({ code: 'EPERM' })
      expect(groupSignal).not.toHaveBeenCalled()
    } finally { groupSignal.mockRestore() }
  })
  it.skipIf(process.platform === 'win32')('terminates a parent, child and grandchild, escalating after the grace period', async () => {
    const leaf = 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)'
    const middle = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','inherit','inherit']}); process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)`
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','inherit','inherit']}); process.on('SIGTERM',()=>console.log('TERM')); console.log(process.pid); setInterval(()=>{},1000)`
    const child = spawnManaged(process.execPath, ['-e', parent], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    try {
      const deadline = Date.now() + 5000
      while (output.trim().split('\n').length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      expect(output.trim().split('\n')).toHaveLength(3)
      const closed = once(child, 'close')
      const started = Date.now()
      const first = terminateProcessTree(child, { gracefulTimeoutMs: 250 })
      expect(terminateProcessTree(child)).toBe(first)
      await first
      await closed
      expect(Date.now() - started).toBeGreaterThanOrEqual(240)
      expect(output).toContain('TERM')
      expect(child.signalCode).toBe('SIGKILL')
      for (const pid of output.trim().split('\n').filter(line => /^\d+$/.test(line)).map(Number)) expect(() => process.kill(pid, 0)).toThrow()
      await terminateProcessTree(child)
    } finally { await terminateProcessTree(child, { gracefulTimeoutMs: 0 }) }
  }, 15000)
})
