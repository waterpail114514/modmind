import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitCommitInput, GitRemote, GitStatus } from '../shared/production'
import type { ProjectInfo } from '../shared/types'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_UNTRACKED_PREVIEW = 256 * 1024

async function git(cwd: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: MAX_OUTPUT, encoding: 'utf8' })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
    if (allowFailure) return { stdout: value.stdout ?? '', stderr: value.stderr ?? value.message, code: typeof value.code === 'number' ? value.code : 1 }
    if (value.code === 'ENOENT') throw new Error('未检测到 Git，请先安装 Git')
    throw new Error((value.stderr || value.message || 'Git 命令失败').trim())
  }
}

function parseStatus(output: string, available = true): GitStatus {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const header = lines.find((line) => line.startsWith('## '))?.slice(3) ?? ''
  const branch = header.split('...')[0].replace('No commits yet on ', '').trim()
  const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0)
  return {
    available,
    initialized: true,
    branch,
    ahead,
    behind,
    changes: lines.filter((line) => !line.startsWith('## ')).map((line) => ({
      index: line[0] ?? ' ',
      worktree: line[1] ?? ' ',
      path: line.slice(3).replace(/^.* -> /, '')
    }))
  }
}

async function untrackedDiff(project: ProjectInfo, relativePath: string): Promise<string> {
  const normalized = relativePath.replaceAll('\\', '/')
  if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath) || normalized.split('/').includes('..')) return ''
  const target = path.resolve(project.path, ...normalized.split('/'))
  const relative = path.relative(project.path, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return ''
  const stat = await fs.lstat(target).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) return `# Untracked\nBinary or non-file: ${normalized}\n`
  if (stat.size > MAX_UNTRACKED_PREVIEW) return `# Untracked\nFile is too large to preview: ${normalized} (${stat.size} bytes)\n`
  const content = await fs.readFile(target)
  if (content.includes(0)) return `# Untracked\nBinary file: ${normalized}\n`
  const lines = content.toString('utf8').split(/\r?\n/)
  return [`# Untracked`, `--- /dev/null`, `+++ b/${normalized}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
}

async function ensureGitignore(project: ProjectInfo): Promise<void> {
  const target = path.join(project.path, '.gitignore')
  const existing = await fs.readFile(target, 'utf8').catch(() => '')
  const entries = ['.gradle/', '.gradle-cloud-storage-test/', 'build/', 'run/', 'logs/', '.modmind/']
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const missing = entries.filter((entry) => !lines.has(entry))
  if (!missing.length) return
  await fs.writeFile(target, `${existing.trimEnd()}${existing.trim() ? '\n' : ''}${missing.join('\n')}\n`, 'utf8')
}

function remoteName(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) throw new Error('远程仓库名称无效')
  return normalized
}

function branchRef(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(normalized) || normalized.includes('..') || normalized.endsWith('/')) {
    throw new Error('分支名称无效')
  }
  return normalized
}

function remoteUrl(value: string): string {
  const normalized = value.trim()
  if (!/^(?:https?:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(normalized)) {
    throw new Error('远程仓库地址必须使用 HTTPS 或 SSH')
  }
  return normalized
}

export class GitService {
  constructor(private readonly getProject: () => ProjectInfo) {}

  async status(): Promise<GitStatus> {
    const project = this.getProject()
    const version = await git(project.path, ['--version'], true)
    if (version.code !== 0) return { available: false, initialized: false, branch: '', ahead: 0, behind: 0, changes: [] }
    const result = await git(project.path, ['status', '--porcelain=v1', '--branch'], true)
    if (result.code !== 0 && /not a git repository/i.test(result.stderr)) {
      return { available: true, initialized: false, branch: '', ahead: 0, behind: 0, changes: [] }
    }
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取 Git 状态')
    return parseStatus(result.stdout)
  }

  async initialize(): Promise<GitStatus> {
    const project = this.getProject()
    await git(project.path, ['init', '-b', 'main'])
    await ensureGitignore(project)
    return this.status()
  }

  async diff(relativePath?: string): Promise<string> {
    const project = this.getProject()
    const status = await this.status()
    if (!status.initialized) throw new Error('当前项目尚未初始化 Git')
    const pathArgs = relativePath?.trim() ? ['--', relativePath.replaceAll('\\', '/')] : []
    const [working, staged] = await Promise.all([
      git(project.path, ['diff', '--no-ext-diff', '--', ...pathArgs.slice(1)], true),
      git(project.path, ['diff', '--cached', '--no-ext-diff', '--', ...pathArgs.slice(1)], true)
    ])
    const untracked = status.changes
      .filter((change) => change.index === '?' && change.worktree === '?' && (!relativePath?.trim() || change.path === relativePath.replaceAll('\\', '/')))
      .slice(0, relativePath?.trim() ? 1 : 20)
    const previews = await Promise.all(untracked.map((change) => untrackedDiff(project, change.path)))
    return [`# Working tree\n${working.stdout}`, `# Staged\n${staged.stdout}`, ...previews.filter(Boolean)].join('\n').slice(0, MAX_OUTPUT)
  }

  async commit(input: GitCommitInput): Promise<GitStatus> {
    const project = this.getProject()
    const message = input.message?.trim()
    if (!message || message.length > 200) throw new Error('提交说明需要 1-200 个字符')
    if (!(await this.status()).initialized) await this.initialize()
    await git(project.path, ['add', '--all'])
    const args = [
      ...(input.authorName?.trim() ? ['-c', `user.name=${input.authorName.trim()}`] : []),
      ...(input.authorEmail?.trim() ? ['-c', `user.email=${input.authorEmail.trim()}`] : []),
      'commit', '-m', message
    ]
    await git(project.path, args)
    return this.status()
  }

  async createBranch(name: string): Promise<GitStatus> {
    const project = this.getProject()
    const normalized = branchRef(name)
    if (!(await this.status()).initialized) await this.initialize()
    await git(project.path, ['switch', '-c', normalized])
    return this.status()
  }

  async listRemotes(): Promise<GitRemote[]> {
    const project = this.getProject()
    if (!(await this.status()).initialized) return []
    const result = await git(project.path, ['remote', '-v'])
    const remotes = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
      if (match) remotes.set(match[1], match[2])
    }
    return [...remotes].map(([name, url]) => ({ name, url }))
  }

  async addRemote(name: string, url: string): Promise<GitRemote[]> {
    const project = this.getProject()
    if (!(await this.status()).initialized) await this.initialize()
    await git(project.path, ['remote', 'add', remoteName(name), remoteUrl(url)])
    return this.listRemotes()
  }

  async removeRemote(name: string): Promise<GitRemote[]> {
    const project = this.getProject()
    await git(project.path, ['remote', 'remove', remoteName(name)])
    return this.listRemotes()
  }

  async fetch(remote = 'origin'): Promise<GitStatus> {
    const project = this.getProject()
    await git(project.path, ['fetch', '--prune', remoteName(remote)])
    return this.status()
  }

  async pull(remote = 'origin', branch?: string): Promise<GitStatus> {
    const project = this.getProject()
    const status = await this.status()
    if (status.changes.length) throw new Error('拉取前请先提交或清理本地变更')
    const targetBranch = branch?.trim() || status.branch
    if (!targetBranch) throw new Error('当前不在可拉取的分支上')
    await git(project.path, ['pull', '--ff-only', remoteName(remote), targetBranch])
    return this.status()
  }

  async push(remote = 'origin', branch?: string): Promise<GitStatus> {
    const project = this.getProject()
    const status = await this.status()
    const targetBranch = branch?.trim() || status.branch
    if (!targetBranch) throw new Error('当前不在可推送的分支上')
    await git(project.path, ['push', '--set-upstream', remoteName(remote), targetBranch])
    return this.status()
  }

  private async integrate(mode: 'merge' | 'rebase', branch: string): Promise<GitStatus> {
    const project = this.getProject()
    const status = await this.status()
    if (status.changes.length) throw new Error(`${mode === 'merge' ? '合并' : '变基'}前请先提交或清理本地变更`)
    const target = branchRef(branch)
    const result = await git(project.path, mode === 'merge' ? ['merge', '--no-edit', target] : ['rebase', target], true)
    if (result.code !== 0) {
      await git(project.path, [mode, '--abort'], true)
      throw new Error(`${mode === 'merge' ? '合并' : '变基'}失败并已自动回滚：${result.stderr.trim() || result.stdout.trim()}`)
    }
    return this.status()
  }

  merge(branch: string): Promise<GitStatus> {
    return this.integrate('merge', branch)
  }

  rebase(branch: string): Promise<GitStatus> {
    return this.integrate('rebase', branch)
  }

  async pullRequestUrl(remote = 'origin'): Promise<string> {
    const status = await this.status()
    if (!status.branch) throw new Error('当前不在可创建 PR 的分支上')
    const selected = (await this.listRemotes()).find((entry) => entry.name === remoteName(remote))
    if (!selected) throw new Error(`找不到远程仓库：${remote}`)
    const match = selected.url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i)
    if (!match) throw new Error('当前 PR 快捷入口仅支持 GitHub 远程仓库')
    return `https://github.com/${match[1]}/${match[2]}/compare/${encodeURIComponent(status.branch)}?expand=1`
  }
}

export { parseStatus }
