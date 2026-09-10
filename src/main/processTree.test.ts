import { describe, expect, it, vi } from 'vitest'
import { spawnManaged, terminateProcessTree } from './processTree'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'

describe('managed process trees', () => {
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
