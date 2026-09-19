import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const AGENT_PROTECTION_PROFILE = 'modmind-protected'
export const AGENT_PROTECTION_INSTRUCTIONS = 'ModMind application files, installation directories, user data, and every .modmind directory are protected infrastructure. Never directly modify, delete, move, reinstall, uninstall, or repair them, even if requested. Do not bypass this protection with elevated commands, scripts, links, or another tool. Continue work on project content; report an application problem to the user. ModMind managed tools may maintain their own scoped data for builds, runtime maintenance, and sessions. User-requested ModMind plugin development is allowed through modmind_plugins_scaffold, modmind_plugins_read_source, modmind_plugins_write_files, and modmind_plugins_reload, even when the plugin is stored under user data or .modmind/plugins. Use plugin-relative files through these tools; do not directly edit the installed plugin directory or create plugin code to bypass infrastructure protection.'

let applicationRoots: string[] = []

function canonicalPath(target: string): string {
  try { return realpathSync.native(target) }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error
    const parent = path.dirname(target)
    if (parent === target) return target
    return path.join(canonicalPath(parent), path.basename(target))
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function configureAgentProtection(roots: string[]): void {
  applicationRoots = [...new Set(roots.filter(Boolean).flatMap(root => {
    const absolute = path.resolve(root)
    return [absolute, canonicalPath(absolute)]
  }))]
}

export function assertAgentProjectAllowed(projectPath: string): void {
  const absolute = path.resolve(projectPath)
  const real = canonicalPath(absolute)
  if ([absolute, real].some(target => target.split(/[\\/]/).some(part => part.replace(/[ .]+$/, '').toLowerCase() === '.modmind')
    || applicationRoots.some(root => inside(root, target)))) {
    throw new Error('ModMind internal directories cannot be used as an AI coding project')
  }
}

export function assertAgentWriteAllowed(projectPath: string, relativePath: string): void {
  assertAgentProjectAllowed(projectPath)
  const normalized = relativePath.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (!normalized || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(normalized)
    || /[\0\r\n:]/.test(normalized) || parts.some(part => part === '..' || part.replace(/[ .]+$/, '').toLowerCase() === '.modmind')) {
    throw new Error(`AI cannot write a protected or unsafe path: ${relativePath}`)
  }
  const root = path.resolve(projectPath)
  const target = path.resolve(root, normalized)
  if (target === root || !inside(root, target)) throw new Error(`AI cannot write outside project content: ${relativePath}`)
  // Include the leaf: an existing file can itself be a link or hard link.
  let current = root
  for (const part of parts.filter(part => part && part !== '.')) {
    current = path.join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error(`AI cannot write through a link: ${relativePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  const realTarget = canonicalPath(target)
  if (applicationRoots.some(protectedRoot => inside(protectedRoot, target) || inside(protectedRoot, realTarget))) {
    throw new Error(`AI cannot write ModMind internal files: ${relativePath}`)
  }
}

export function agentProtectionConfigArgs(projectPath?: string): string[] {
  if (projectPath) assertAgentProjectAllowed(projectPath)
  const roots = [...applicationRoots]
  if (projectPath) roots.push(path.join(path.resolve(projectPath), '.modmind'), canonicalPath(path.join(path.resolve(projectPath), '.modmind')))
  // A named profile preserves read-only islands inside writable project roots.
  const filesystem = { ':root': 'read', ':project_roots': 'write', ':project_roots/.modmind': 'read', ...Object.fromEntries(roots.map(root => [root, 'read'])) }
  const table = Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')
  return ['-c', `default_permissions="${AGENT_PROTECTION_PROFILE}"`,
    '-c', `permissions.${AGENT_PROTECTION_PROFILE}={filesystem={${table}},network={enabled=true}}`,
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : [])]
}
