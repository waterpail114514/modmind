import { requestAiTextResponse } from './aiTextRequest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ProjectInfo } from '../shared/types'
import { windowsCmdInvocation } from './windowsCommand'

export interface AiReviewerConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
  reasoningEffort?: string
  forceLocalFallback?: boolean
  /** Prefer the locally installed, independent Codex review agent. */
  reviewMode?: 'codex-auto'
  codexExecutable?: string
  projectPath?: string
  environment?: NodeJS.ProcessEnv
}

export interface AiReviewDecision {
  approved: boolean
  complete: boolean
  risk: 'low' | 'medium' | 'high'
  feedback: string
  dangerousOperations: string[]
  unavailable?: boolean
  fallback?: 'local-rules'
}

export interface AiReviewContext {
  project: ProjectInfo
  request: string
  action?: string
  input?: unknown
  summary?: string
  changedFiles?: string[]
  transcriptTail?: string
  workflow?: {
    required: string[]
    completed: string[]
    missing: string[]
    evidence: Record<string, string>
  }
}

const CODEX_REVIEW_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    complete: { type: 'boolean' },
    risk: { enum: ['low', 'medium', 'high'] },
    feedback: { type: 'string' },
    dangerousOperations: { type: 'array', items: { type: 'string' } }
  },
  required: ['approved', 'complete', 'risk', 'feedback', 'dangerousOperations']
})

function fallback(reason: string): AiReviewDecision {
  return { approved: true, complete: true, risk: 'low', feedback: reason, dangerousOperations: [], unavailable: true }
}

function localFallback(reason: string, dangerousOperations: string[] = []): AiReviewDecision {
  const dangerous = [...new Set(dangerousOperations)].slice(0, 20)
  return {
    approved: dangerous.length === 0,
    complete: true,
    risk: dangerous.length ? 'high' : 'medium',
    feedback: `${reason}，已改用本地规则审查${dangerous.length ? `；已拦截：${dangerous.join('、')}` : ''}`,
    dangerousOperations: dangerous,
    fallback: 'local-rules'
  }
}

function extractContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {}
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : first
  const content = message.content ?? root.output ?? root.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : String(item ?? '')).join('')
  return ''
}

function parseDecision(content: string): AiReviewDecision | null {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  let value: unknown
  try { value = JSON.parse(cleaned) } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { value = JSON.parse(match[0]) } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const risk = record.risk === 'high' || record.risk === 'medium' ? record.risk : 'low'
  const dangerousOperations = Array.isArray(record.dangerousOperations) ? record.dangerousOperations.map(String).slice(0, 20) : []
  return {
    approved: record.approved !== false,
    complete: record.complete !== false,
    risk,
    feedback: typeof record.feedback === 'string' ? record.feedback.slice(0, 8_000) : '',
    dangerousOperations
  }
}

function compactInput(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 24_000) } catch { return String(value).slice(0, 24_000) }
}

function localActionFallback(context: AiReviewContext, reason: string): AiReviewDecision {
  const input = compactInput(context.input)
  const dangerousOperations: string[] = []
  if (/(?:^|[\\/"'])\.\.(?:[\\/]|$)/.test(input)) dangerousOperations.push('project-boundary path')
  if (/(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*["'][^"']{8,})/i.test(input)) {
    dangerousOperations.push('credential-like value')
  }
  return localFallback(reason, dangerousOperations)
}

function localActionReview(context: AiReviewContext): AiReviewDecision {
  const decision = localActionFallback(context, '本地安全策略已检查')
  return {
    ...decision,
    feedback: decision.dangerousOperations.length
      ? `已拦截：${decision.dangerousOperations.join('、')}`
      : '本地安全策略已放行',
    fallback: undefined
  }
}

export async function reviewAiAction(config: AiReviewerConfig | null, context: AiReviewContext, signal?: AbortSignal): Promise<AiReviewDecision> {
  if (config?.reviewMode === 'codex-auto') {
    // Keep per-operation safety deterministic and fast. Codex Auto-review is
    // launched once for the completed change set, as an independent agent.
    return localActionReview(context)
  }
  if (!config?.baseUrl || !config.apiKey || !config.model) return fallback('审查模型未配置，已跳过额外审批')
  if (config.forceLocalFallback) return localActionFallback(context, '远程审查在本次任务中不可用')
  const prompt = actionPrompt(context)
  return requestReview(config, prompt, () => localActionFallback(context, '远程审查服务暂时不可用'), signal)
}

export async function reviewAiCompletion(config: AiReviewerConfig | null, context: AiReviewContext, signal?: AbortSignal): Promise<AiReviewDecision> {
  const workflow = context.workflow ?? { required: [], completed: [], missing: [], evidence: {} }
  const prompt = completionPrompt(context, workflow)
  if (config?.reviewMode === 'codex-auto') {
    return reviewWithCodexAutoReview(config, prompt, async () => config.forceLocalFallback
      ? localFallback('Codex Auto-review 在本次任务中不可用')
      : config.baseUrl && config.apiKey && config.model
      ? requestReview(config, prompt, (reason) => localFallback(reason), signal)
      : localFallback('Codex Auto-review 暂时不可用'), signal)
  }
  if (!config?.baseUrl || !config.apiKey || !config.model) return fallback('审查模型未配置，已跳过完成度审查')
  if (config.forceLocalFallback) return localFallback('远程完成度审查在本次任务中不可用')
  return requestReview(config, prompt, () => localFallback('远程完成度审查暂时不可用'), signal)
}

function actionPrompt(context: AiReviewContext): string {
  return `Review one operation from a local Minecraft development Agent. Approve ordinary project work that is aligned with the user's request. Deny only operations that are clearly destructive, credential-exposing, outside the project, or unrelated. Return JSON only: {"approved":boolean,"complete":true,"risk":"low|medium|high","feedback":"...","dangerousOperations":[]}.

PROJECT: ${context.project.name} (${context.project.loader}, Minecraft ${context.project.minecraftVersion})
USER REQUEST: ${context.request.slice(0, 12_000)}
OPERATION: ${context.action ?? 'unknown'}
INPUT: ${compactInput(context.input)}`
}

function completionPrompt(context: AiReviewContext, workflow: NonNullable<AiReviewContext['workflow']>): string {
  return `Act as an independent completion reviewer for a Minecraft coding task. Compare the user's request with the Agent's result and changed files. If anything material is missing, set complete=false and give concrete next steps. Approve normal implementation work; flag only clearly dangerous or unrelated changes. When the workflow audit requires managed_download, the matching ModMind download tool is mandatory: addon_prepare for add-on targets and their transitive dependencies, dependency_install or maven_dependency_install for ordinary Java dependencies, modpack_apply_plan or modpack_apply_optimization_profile for modpack mods, and modpack_download_content for pack content. Java, Gradle, loader, Minecraft assets, HeadlessMC, server runtime, and JDK downloads belong to ModMind build/test/runtime/server-pack tools and must not be replaced with native commands. Native downloads are acceptable for a covered resource only when the recorded matching ModMind tool actually failed; they are otherwise acceptable for resources ModMind does not implement. Return JSON only: {"approved":boolean,"complete":boolean,"risk":"low|medium|high","feedback":"...","dangerousOperations":[]}.

The ModMind completion audit is mandatory, but only stages listed in required are hard gates. Planning helpers not listed there are optional. This is a completeness checklist rather than a required order; do not reject a task merely because stages happened in a different order. If any required workflow stage is missing, set complete=false even when the Agent claims completion. List every missing stage in feedback. Do not approve a task merely because the Agent claimed completion. Evidence must come from the recorded tool evidence below; native Agent actions may be used for the work, but a corresponding ModMind evidence tool is required when available.

USER REQUEST: ${context.request.slice(0, 16_000)}
AGENT SUMMARY: ${(context.summary ?? '').slice(0, 8_000)}
CHANGED FILES: ${(context.changedFiles ?? []).slice(0, 200).join('\n')}
TRANSCRIPT TAIL: ${(context.transcriptTail ?? '').slice(-24_000)}
WORKFLOW AUDIT: ${JSON.stringify(workflow, null, 2)}`
}

async function reviewWithCodexAutoReview(
  config: AiReviewerConfig,
  prompt: string,
  fallbackReview: () => Promise<AiReviewDecision>,
  signal?: AbortSignal
): Promise<AiReviewDecision> {
  if (config.forceLocalFallback || !config.projectPath) return fallbackReview()
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-review-'))
  const outputPath = path.join(temporaryDirectory, 'review.json')
  const schemaPath = path.join(temporaryDirectory, 'schema.json')
  try {
    await fs.writeFile(schemaPath, CODEX_REVIEW_SCHEMA, 'utf8')
    const hasGitMetadata = await fs.stat(path.join(config.projectPath, '.git')).then(() => true).catch(() => false)
    const content = await runCodexAutoReview(config, prompt, outputPath, schemaPath, hasGitMetadata, signal)
    const decision = parseDecision(content)
    return decision ?? fallbackReview()
  } catch (error) {
    if (signal?.aborted) throw error
    return fallbackReview()
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function runCodexAutoReview(config: AiReviewerConfig, prompt: string, outputPath: string, schemaPath: string, hasGitMetadata: boolean, signal?: AbortSignal): Promise<string> {
  const executable = config.codexExecutable?.trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const reviewPrompt = `You are an independent, read-only ModMind review agent. Do not edit files, run mutating commands, or delegate this review. Inspect the project only as needed, then return the requested JSON decision.\n\n${prompt}`
  const args = [
    '-C', config.projectPath!,
    '--sandbox', 'read-only',
    'exec', ...(hasGitMetadata ? ['review', '--uncommitted'] : []),
    '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    '-'
  ]
  return new Promise((resolve, reject) => {
    const windowsScript = process.platform === 'win32' && /\.ps1$/i.test(executable)
    const windowsBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
    const invocation = windowsBatch
      ? windowsCmdInvocation(executable, args)
      : windowsScript
        ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args], windowsVerbatimArguments: false }
        : { command: executable, args, windowsVerbatimArguments: false }
    const child = spawn(invocation.command, invocation.args, {
      cwd: config.projectPath,
      env: config.environment ? { ...process.env, ...config.environment } : undefined,
      windowsHide: true,
      shell: false,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let settled = false
    const terminate = (): void => {
      if (child.killed) return
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref()
        return
      }
      child.kill('SIGTERM')
    }
    const timeout = setTimeout(() => {
      terminate()
      fail(new Error('Codex Auto-review timed out after 180 seconds'))
    }, 180_000)
    timeout.unref()
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      terminate()
      fail(signal?.reason ?? new Error('Codex review aborted'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', fail)
    child.stdin.end(reviewPrompt)
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000) })
    child.once('error', fail)
    child.once('close', async (code) => {
      if (settled) return
      if (code !== 0) {
        fail(new Error(`Codex Auto-review exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        return
      }
      try {
        const content = await fs.readFile(outputPath, 'utf8')
        settled = true
        cleanup()
        resolve(content)
      } catch (error) {
        fail(error)
      }
    })
  })
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = Number.parseFloat(response?.headers.get('retry-after') ?? '')
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(Math.round(retryAfter * 1_000), 5_000)
  return attempt === 0 ? 400 : 1_200
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 300) || 'unknown network error'
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function requestReview(
  config: AiReviewerConfig,
  prompt: string,
  onUnavailable: (reason: string) => AiReviewDecision,
  signal?: AbortSignal
): Promise<AiReviewDecision> {
  let lastFailure = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    try {
      const response = await requestAiTextResponse({ baseUrl: config.baseUrl!, apiKey: config.apiKey!, model: config.model! }, [
            { role: 'system', content: 'You are ModMind Review Agent. You advise the coding Agent; you do not edit files or run commands.' },
            { role: 'user', content: prompt }
          ], { signal: requestSignal, reasoningEffort: config.reasoningEffort, temperature: 0 })
      if (response.ok) {
        const decision = parseDecision(extractContent(await response.json()))
        return decision ?? onUnavailable('审查模型返回格式无效')
      }
      lastFailure = `HTTP ${response.status}`
      if (!retryableStatus(response.status) || attempt === 2) break
      await waitForRetry(retryDelay(response, attempt), signal)
    } catch (error) {
      if (signal?.aborted) throw error
      lastFailure = failureReason(error)
      if (attempt === 2) break
      await waitForRetry(retryDelay(null, attempt), signal)
    }
  }
  return onUnavailable(`远程审查请求失败（${lastFailure || 'unknown error'}，已重试 3 次）`)
}
