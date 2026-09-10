import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { verifiedDownload } from './downloadService'

import { CODEX_RUNTIME_VERSION, requireCodexRuntimeTarget } from './runtimeTarget'
import { probeCodexExecutable, validateCodexFile } from './codexExecutable'
export { CODEX_RUNTIME_VERSION } from './runtimeTarget'
const CODEX_ENV_KEY = 'MODMIND_THIRD_PARTY_API_KEY'
const DOWNLOAD_ATTEMPTS_PER_SOURCE = 2

export type CodexSetupStage = 'checking' | 'downloading' | 'verifying' | 'configuring' | 'ready' | 'error'

export interface CodexSetupProgress {
  stage: CodexSetupStage
  title: string
  detail: string
  status: 'running' | 'success' | 'warning' | 'error'
}

export interface CodexServerConfig {
  apiKey: string
  baseUrl: string
  model: string
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
}

export interface CodexSetupResult {
  executable: string
  version: string
  configPath: string
  runtimePath: string
  home: string
  environment: Record<string, string>
  configChanged: boolean
  configSource: 'device' | 'local-settings'
}

export interface PrepareCodexOptions {
  rootDir: string
  /** Optional isolated CODEX_HOME; the managed runtime cache still uses rootDir. */
  homeDir?: string
  serverConfig: CodexServerConfig
  configSource?: 'device' | 'local-settings'
  existingExecutable?: string
  bundledSkillsDir?: string
  imageToolsEnabled?: boolean
  rememberPrepared?: boolean
  onProgress?: (progress: CodexSetupProgress) => void
}

export interface EnsureManagedCodexOptions {
  rootDir: string
  onProgress?: (progress: CodexSetupProgress) => void
}

let preparedExecutable = ''
let preparedHome = ''
let preparedEnvironment: Record<string, string> = {}
const managedRuntimePreparations = new Map<string, Promise<string>>()

/**
 * The quota workflow must not silently run an arbitrary global Codex CLI.
 * `codex --version` prefixes vary between releases, so compare the first
 * standalone semantic version rather than the whole display string.
 */
export function isManagedCodexVersion(version: string | undefined): boolean {
  const match = version?.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)
  return match?.[1] === CODEX_RUNTIME_VERSION
}

function progress(options: Pick<PrepareCodexOptions, 'onProgress'>, value: CodexSetupProgress): void {
  options.onProgress?.(value)
}

export function managedCodexRuntimePath(rootDir: string, platform: string = process.platform, arch: string = process.arch): string {
  return path.join(rootDir, 'codex-runtime', `${CODEX_RUNTIME_VERSION}-${requireCodexRuntimeTarget(platform, arch).id}`)
}

export function managedCodexExecutablePath(rootDir: string, platform: string = process.platform, arch: string = process.arch): string {
  return path.join(managedCodexRuntimePath(rootDir, platform, arch), requireCodexRuntimeTarget(platform, arch).executableRelativePath)
}

async function usableManagedCodex(root: string, executable: string): Promise<boolean> {
  try { await validateCodexFile(root, executable); return await probeCodexExecutable(executable) === CODEX_RUNTIME_VERSION }
  catch { return false }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('第三方 AI 地址必须使用 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('第三方 AI 地址不能包含账号密码')
  return url.toString().replace(/\/$/, '')
}

function validateConfig(value: unknown): CodexServerConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const baseUrl = typeof record.baseUrl === 'string' ? normalizeBaseUrl(record.baseUrl) : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  const reasoningEffort = record.reasoningEffort === 'low' || record.reasoningEffort === 'medium' || record.reasoningEffort === 'high' || record.reasoningEffort === 'xhigh' || record.reasoningEffort === 'max' || record.reasoningEffort === 'ultra' ? record.reasoningEffort : 'high'
  if (!apiKey || !baseUrl || !model) throw new Error('服务端配置缺少 API Key、Base URL 或模型名')
  return {apiKey, baseUrl, model, reasoningEffort}
}

function codexConfigText(config: CodexServerConfig): string {
  return [
    '# ModMind managed Codex provider',
    `model = ${JSON.stringify(config.model)}`,
    `model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`,
    'model_provider = "thirdparty"',
    '',
    '[features]',
    'enable_request_compression = false',
    '',
    '[model_providers.thirdparty]',
    'name = "Third-party AI"',
    `base_url = ${JSON.stringify(config.baseUrl)}`,
    `env_key = ${JSON.stringify(CODEX_ENV_KEY)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join('\n')
}

async function writeCodexConfig(configPath: string, config: CodexServerConfig): Promise<boolean> {
  const desired = codexConfigText(config)
  const current = await fs.readFile(configPath, 'utf8').catch(() => '')
  if (current === desired) return false
  await fs.mkdir(path.dirname(configPath), {recursive: true})
  await fs.writeFile(configPath, desired, 'utf8')
  return true
}

async function syncBundledSkills(sourceDirectory: string | undefined, home: string): Promise<boolean> {
  if (!sourceDirectory) return false
  const sourceExists = await fs.stat(sourceDirectory).then((value) => value.isDirectory()).catch(() => false)
  if (!sourceExists) return false
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true })
  const targetRoot = path.join(home, 'skills')
  await fs.mkdir(targetRoot, { recursive: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await fs.cp(path.join(sourceDirectory, entry.name), path.join(targetRoot, entry.name), { recursive: true, force: true })
  }
  return true
}

async function runTar(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'tar.exe' : 'tar', args, {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']})
    let error = ''
    child.stderr.on('data', (chunk) => { error += String(chunk).slice(-4_000) })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `tar 退出码 ${code}`)))
  })
}

async function downloadCodex(rootDir: string, options: EnsureManagedCodexOptions): Promise<string> {
  const descriptor = requireCodexRuntimeTarget()
  const urls = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'].map((origin) => `${origin}/@openai/codex/-/${descriptor.archiveName}`)
  const runtimePath = managedCodexRuntimePath(rootDir)
  const executable = managedCodexExecutablePath(rootDir)
  if (await usableManagedCodex(runtimePath, executable)) return executable

  const staging = `${runtimePath}.staging-${randomUUID()}`
  const archive = path.join(staging, 'codex.tgz')
  await fs.mkdir(staging, {recursive: true})
  progress(options, {stage: 'downloading', title: '正在准备开发工具', detail: `正在连接 ${urls.length} 个可用下载源`, status: 'running'})
  try {
    await verifiedDownload.download({
      sources: urls.map((url, index) => ({ id: `codex-${index + 1}`, label: `Codex 下载源 ${index + 1}`, url })),
      destination: archive,
      maxBytes: 256 * 1024 * 1024,
      timeoutMs: 120_000,
      retriesPerSource: DOWNLOAD_ATTEMPTS_PER_SOURCE,
      activityLabel: `Codex ${CODEX_RUNTIME_VERSION}`,
      expectedHash: { algorithm: 'sha512', value: descriptor.sha512 }
    })
    progress(options, {stage: 'verifying', title: '正在验证开发工具', detail: '下载完整性已通过，正在解压', status: 'running'})
    await runTar(['-xzf', archive, '-C', staging])
    const stagedExecutable = path.join(staging, descriptor.executableRelativePath)
    await validateCodexFile(staging, stagedExecutable)
    if (process.platform !== 'win32') await fs.chmod(stagedExecutable, 0o755)
    if (await probeCodexExecutable(stagedExecutable) !== CODEX_RUNTIME_VERSION) throw new Error('Codex 版本探测不匹配')
    await fs.rm(archive, { force: true })
    const backup = `${runtimePath}.previous-${randomUUID()}`
    const hasPrevious = await fs.stat(runtimePath).then(() => true).catch(() => false)
    if (hasPrevious) await fs.rename(runtimePath, backup)
    try { await fs.rename(staging, runtimePath) }
    catch (error) { if (hasPrevious) await fs.rename(backup, runtimePath); throw error }
    if (hasPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
    return executable
  } finally {
    await fs.rm(staging, {recursive: true, force: true}).catch(() => undefined)
  }
}

export async function ensureManagedCodexRuntime(options: EnsureManagedCodexOptions): Promise<string> {
  const runtimePath = managedCodexRuntimePath(options.rootDir)
  const executable = managedCodexExecutablePath(options.rootDir)
  if (await usableManagedCodex(runtimePath, executable)) return executable

  const key = process.platform === 'win32' ? runtimePath.toLowerCase() : runtimePath
  const active = managedRuntimePreparations.get(key)
  if (active) return active

  const preparation = downloadCodex(options.rootDir, options)
  managedRuntimePreparations.set(key, preparation)
  try {
    return await preparation
  } finally {
    if (managedRuntimePreparations.get(key) === preparation) managedRuntimePreparations.delete(key)
  }
}

export async function prepareCodex(options: PrepareCodexOptions): Promise<CodexSetupResult> {
  progress(options, {stage: 'checking', title: '正在检查开发工具', detail: '正在检测本机 Codex', status: 'running'})
  const executable = options.existingExecutable || await ensureManagedCodexRuntime(options)
  const version = await probeCodexExecutable(executable)
  const runtimePath = options.existingExecutable ? path.dirname(options.existingExecutable) : managedCodexRuntimePath(options.rootDir)
  const home = options.homeDir ? path.resolve(options.homeDir) : path.join(options.rootDir, 'codex-home')
  const configPath = path.join(home, 'config.toml')
  const config = validateConfig(options.serverConfig)
  progress(options, {stage: 'configuring', title: '正在检查开发工具配置', detail: '正在比对本地配置并准备项目助手', status: 'running'})
  const configChanged = await writeCodexConfig(configPath, config)
  const skillsSynced = await syncBundledSkills(options.bundledSkillsDir, home)
  if (!skillsSynced && options.bundledSkillsDir) {
    progress(options, {
      stage: 'configuring',
      title: '内置技能未同步',
      detail: '未找到随应用附带的 Codex 技能目录；已继续使用 Codex，建议更新或重装 ModMind',
      status: 'warning'
    })
  }
  const environment = {CODEX_HOME: home, [CODEX_ENV_KEY]: config.apiKey}
  if (options.rememberPrepared !== false) {
    preparedExecutable = executable
    preparedHome = home
    preparedEnvironment = environment
  }
  progress(options, {stage: 'ready', title: '开发工具已准备好', detail: configChanged ? '配置已更新，可以开始制作' : '配置没有变化，可以开始制作', status: 'success'})
  return {
    executable,
    version,
    configPath,
    runtimePath,
    home,
    environment,
    configChanged,
    configSource: options.configSource ?? 'local-settings'
  }
}

export function getPreparedCodexExecutable(): string | undefined {
  return preparedExecutable || undefined
}

export function getPreparedCodexEnvironment(): Record<string, string> {
  return {...preparedEnvironment}
}

/**
 * Device credentials are only valid for the active quota-backed task. The
 * managed config contains no secret; this removes the process-only API key
 * and prevents later local Codex runs from inheriting it.
 */
export function clearPreparedCodexCredentials(): void {
  preparedEnvironment = {}
  preparedExecutable = ''
  preparedHome = ''
}

export function getPreparedCodexHome(): string | undefined {
  return preparedHome || undefined
}
