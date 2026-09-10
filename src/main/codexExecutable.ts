import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { windowsCmdInvocation } from './windowsCommand'

export async function validateCodexFile(root: string, executable: string): Promise<void> {
  const relative = path.relative(await fs.realpath(root), await fs.realpath(executable))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.lstat(executable)).isFile()) {
    throw new Error('Codex 执行文件必须是运行时目录内的普通文件')
  }
}
export async function probeCodexExecutable(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = process.platform === 'win32' && /\.cmd$/i.test(executable)
      ? windowsCmdInvocation(executable, ['--version'])
      : process.platform === 'win32' && /\.ps1$/i.test(executable)
        ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, '--version'], windowsVerbatimArguments: false }
        : { command: executable, args: ['--version'], windowsVerbatimArguments: false }
    execFile(invocation.command, invocation.args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (error, stdout, stderr) => {
      const version = `${stdout}\n${stderr}`.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1]
      if (error || !version) reject(new Error(`无法运行 Codex (${executable})：${error?.message ?? '版本输出无效'}；请检查架构和执行权限`))
      else resolve(version)
    })
  })
}
