import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { windowsCmdInvocation } from './windowsCommand'

export interface InteractiveTerminalCommand { executable: string; args: string[]; cwd: string; title?: string }
export function quotePosixArgument(value: string): string {
  if (value.includes('\0')) throw new Error('终端参数不能包含 NUL')
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
export function terminalScript(command: InteractiveTerminalCommand): string {
  return ['#!/bin/sh', 'trap \'rm -f -- "$0"\' EXIT', `cd -- ${quotePosixArgument(command.cwd)} || exit 1`,
    [command.executable, ...command.args].map(quotePosixArgument).join(' '), 'exit "$?"', ''].join('\n')
}
export async function cleanupTerminalScripts(directory: string): Promise<void> {
  // Called once on app startup, never while opening another live session.
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith('session-')) await fs.rm(path.join(directory, entry.name), { recursive: true, force: true })
  }
}
export async function openInteractiveTerminal(command: InteractiveTerminalCommand, directory: string, platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    const invocation = windowsCmdInvocation(command.executable, command.args, '/k')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { cwd: command.cwd, detached: true, windowsHide: false, shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
    return
  }
  if (platform !== 'darwin') throw new Error('当前系统尚不支持自动打开交互终端')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const session = await fs.mkdtemp(path.join(directory, 'session-'))
  const script = path.join(session, 'login.command')
  await fs.writeFile(script, terminalScript(command), { mode: 0o700 })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', 'Terminal', script], { stdio: 'ignore' })
    const fail = (): void => reject(new Error(`无法打开 Terminal；请重试登录，或打开 ${session} 中的 login.command`))
    child.once('error', fail)
    child.once('close', (code) => code === 0 ? resolve() : fail())
  })
}
