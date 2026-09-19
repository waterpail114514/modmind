import { describe, expect, it } from 'vitest'
import { windowsCmdInvocation } from './windowsCommand'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

describe('windowsCmdInvocation', () => {
  it('quotes an executable path containing spaces for cmd.exe', () => {
    const invocation = windowsCmdInvocation('C:\\Program Files\\Gradle\\bin\\gradlew.bat', ['build'])

    expect(invocation.command.toLowerCase()).toMatch(/(?:^|[\\/])cmd(?:\.exe)?$/)
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\Gradle\\bin\\gradlew.bat" build"'])
    expect(invocation.windowsVerbatimArguments).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('preserves nested JSON and trailing backslashes through a command shim', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'modmind command '))
    try {
      const executable = path.join(root, 'echo-args.cmd')
      writeFileSync(path.join(root, 'echo-args.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
      writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0echo-args.cjs" %*\r\n`)
      const args = ['developer_instructions=' + JSON.stringify('Connection: {"model":"test"}\nAnswer directly.'), 'C:\\Project Files\\']
      const invocation = windowsCmdInvocation(executable, args)
      const result = spawnSync(invocation.command, invocation.args, { windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(args)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
