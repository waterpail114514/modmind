import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGitRepositoryRoot } from './gitService'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { GiteeBuildResult, GiteeBuildSettings, GiteeBuildValidation } from '../shared/production'
import type { ProjectInfo } from '../shared/types'
import { isJavaLoader, platformLabel } from '../shared/projectPlatform'

const execFileAsync = promisify(execFile)
const GITEE_API = 'https://gitee.com/api/v5'

const defaultGiteeCi = `stages:
  - build

build:
  stage: build
  script:
    - chmod +x gradlew
    - ./gradlew build --no-daemon --stacktrace
  artifacts:
    name: modmind
    paths:
      - build/libs/*.jar
    expire_in: 30 days
`

interface ParsedRepository {
  owner: string
  repository: string
  gitUrl: string
  pipelineUrl: string
}

interface GiteeBuildServiceOptions {
  getProject: () => ProjectInfo
  readSettings: () => Promise<GiteeBuildSettings>
}

function parseRepository(value: string): ParsedRepository {
  const input = value.trim().replace(/\/+$/, '')
  const match = input.match(/^(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i)
  if (!match) throw new Error('Gitee 仓库地址应为 https://gitee.com/用户名/仓库名')
  const owner = match[1]
  const repository = match[2]
  return {
    owner,
    repository,
    gitUrl: `https://${encodeURIComponent(owner)}@gitee.com/${owner}/${repository}.git`,
    pipelineUrl: `https://gitee.com/${owner}/${repository}/pipelines`
  }
}

function normalizeBranch(value: string): string {
  const branch = value.trim() || 'main'
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw new Error('Gitee 构建分支名称无效')
  }
  return branch
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv, allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('git', args, { cwd, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
    const result = { stdout: value.stdout ?? '', stderr: value.stderr ?? value.message ?? 'Git 命令失败', code: typeof value.code === 'number' ? value.code : 1 }
    if (allowFailure) return result
    if (value.code === 'ENOENT') throw new Error('未检测到 Git，请先安装 Git')
    throw new Error(result.stderr.trim())
  }
}

async function giteeRequest<T>(token: string, endpoint: string): Promise<T> {
  const url = new URL(`${GITEE_API}${endpoint}`)
  url.searchParams.set('access_token', token)
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ModMind/1.2' }, signal: AbortSignal.timeout(15_000) })
  const body = await response.text()
  let payload: unknown = null
  try { payload = body ? JSON.parse(body) : null } catch { payload = null }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string' ? payload.message : `Gitee API 返回 HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

async function createAskpass(token: string): Promise<{ file: string; env: NodeJS.ProcessEnv }> {
  const windows = process.platform === 'win32'
  const file = path.join(os.tmpdir(), `modmind-gitee-askpass-${randomUUID()}${windows ? '.cmd' : '.sh'}`)
  const script = windows
    ? '@echo off\r\necho %MODMIND_GIT_TOKEN%\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' "$MODMIND_GIT_TOKEN"\n'
  await fs.writeFile(file, script, { encoding: 'utf8', mode: windows ? 0o600 : 0o700 })
  if (!windows) await fs.chmod(file, 0o700)
  return {
    file,
    env: { GIT_ASKPASS: file, GIT_TERMINAL_PROMPT: '0', MODMIND_GIT_TOKEN: token }
  }
}

export class GiteeBuildService {
  constructor(private readonly options: GiteeBuildServiceOptions) {}

  async validate(settings?: GiteeBuildSettings): Promise<GiteeBuildValidation> {
    const current = settings ?? await this.options.readSettings()
    try {
      if (!current.token.trim()) return { valid: false, detail: '请先填写 Gitee Personal Access Token' }
      const repository = parseRepository(current.repositoryUrl)
      const [user, repo] = await Promise.all([
        giteeRequest<{ login?: string }>(current.token.trim(), '/user'),
        giteeRequest<{ default_branch?: string; full_name?: string }>(current.token.trim(), `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`)
      ])
      const owner = user.login || repository.owner
      return {
        valid: true,
        owner,
        repository: repo.full_name || `${repository.owner}/${repository.repository}`,
        defaultBranch: repo.default_branch || normalizeBranch(current.branch),
        detail: `已连接 Gitee：${owner}/${repository.repository}`
      }
    } catch (error) {
      return { valid: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async trigger(): Promise<GiteeBuildResult> {
    const project = this.options.getProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 项目不使用 Gradle，不能触发 Gitee Java 构建流水线`)
    const settings = await this.options.readSettings()
    if (!settings.token.trim()) throw new Error('请先配置 Gitee Token')
    const repository = parseRepository(settings.repositoryUrl)
    const validation = await this.validate(settings)
    if (!validation.valid) throw new Error(validation.detail)
    const projectRoot = path.resolve(project.path)
    const branch = normalizeBranch(settings.branch || validation.defaultBranch || 'main')
    const configPath = path.join(projectRoot, '.gitee-ci.yml')
    const gitRoot = await runGit(projectRoot, ['rev-parse', '--show-toplevel'], undefined, true)
    if (gitRoot.code === 0) await assertGitRepositoryRoot(projectRoot, gitRoot.stdout)
    if (gitRoot.code !== 0) await runGit(projectRoot, ['init', '-b', branch])
    if (!(await fileExists(configPath))) await fs.writeFile(configPath, defaultGiteeCi, 'utf8')
    const currentBranch = (await runGit(projectRoot, ['branch', '--show-current'], undefined, true)).stdout.trim()
    if (!currentBranch) await runGit(projectRoot, ['switch', '-c', branch], undefined, true)
    await runGit(projectRoot, ['add', '--all'])
    const staged = await runGit(projectRoot, ['diff', '--cached', '--quiet'], undefined, true)
    if (staged.code !== 0) {
      await runGit(projectRoot, ['-c', 'user.name=ModMind', '-c', 'user.email=build@modmind.local', 'commit', '-m', `ModMind remote build ${new Date().toISOString()}`])
    }

    const remote = await runGit(projectRoot, ['remote', 'get-url', 'gitee'], undefined, true)
    if (remote.code === 0) await runGit(projectRoot, ['remote', 'set-url', 'gitee', repository.gitUrl])
    else await runGit(projectRoot, ['remote', 'add', 'gitee', repository.gitUrl])

    const askpass = await createAskpass(settings.token.trim())
    try {
      await runGit(projectRoot, ['push', 'gitee', `HEAD:refs/heads/${branch}`], askpass.env)
    } finally {
      await fs.rm(askpass.file, { force: true }).catch(() => undefined)
    }
    const sha = (await runGit(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim()
    return {
      success: true,
      branch,
      commitSha: sha,
      pipelineUrl: repository.pipelineUrl,
      detail: '项目已推送到 Gitee。若已启用 Gitee Go，流水线会自动开始；请打开流水线页面查看日志和 JAR 制品'
    }
  }
}

export { defaultGiteeCi, parseRepository }
