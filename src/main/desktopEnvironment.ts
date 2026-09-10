import os from 'node:os'
import path from 'node:path'

/** Finder/Dock launches do not inherit a user's interactive shell PATH. */
export function desktopProcessEnvironment(environment: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): NodeJS.ProcessEnv {
  if (platform !== 'darwin') return { ...environment }
  const directories = [
    ...(environment.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin',
    path.posix.join(home, '.local/bin'), path.posix.join(home, '.npm-global/bin'), path.posix.join(home, '.npm/bin'),
    ...(environment.NPM_CONFIG_PREFIX ? [path.posix.join(environment.NPM_CONFIG_PREFIX, 'bin')] : []),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ]
  return { ...environment, PATH: [...new Set(directories.filter(Boolean))].join(':') }
}
