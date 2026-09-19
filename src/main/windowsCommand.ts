export interface WindowsCommandInvocation {
  command: string
  args: string[]
  windowsVerbatimArguments: true
}

export type WindowsCmdMode = '/c' | '/k'

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./\\:=+@-]+$/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** Build an explicit cmd.exe invocation with stable quoting for paths containing spaces. */
export function windowsCmdInvocation(executable: string, args: readonly string[] = [], mode: WindowsCmdMode = '/c'): WindowsCommandInvocation {
  const command = [quoteCommandPart(executable), ...args.map(quoteCommandPart)].join(' ')
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', mode, `"${command}"`],
    windowsVerbatimArguments: true
  }
}
