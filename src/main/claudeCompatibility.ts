import os from 'node:os'
import path from 'node:path'
import type { ExternalAgentConfiguration } from '../shared/types'

// Detect the protocol we actually use rather than guessing a minimum release.
export const CLAUDE_REQUIRED_FLAGS = [
  '--print', '--permission-mode', '--tools', '--allowedTools', '--settings',
  '--setting-sources', '--input-format', '--output-format', '--verbose',
  '--include-partial-messages', '--strict-mcp-config', '--mcp-config',
  '--add-dir', '--append-system-prompt', '--resume', '--fork-session'
] as const

export function claudeCompatibilityProblem(help: string, hosted = false): string | undefined {
  const flags = [...CLAUDE_REQUIRED_FLAGS, ...(hosted ? ['--bare'] : [])]
  const missing = flags.filter(flag => !help.includes(flag))
  if (!/\bdontAsk\b/.test(help)) missing.push('permission-mode=dontAsk')
  return missing.length ? `Claude Code 不支持当前托管协议（缺少 ${missing.join(', ')}）。请更新 Claude Code，或在设置中选择兼容的命令路径。` : undefined
}

export function claudeSessionHome(environment: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(environment.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'))
}

export function claudeHostedEnvironment(configuration: ExternalAgentConfiguration, configDirectory: string): NodeJS.ProcessEnv {
  const apiKey = configuration.apiKey?.trim()
  const model = configuration.model?.trim()
  if (!apiKey) throw new Error('请先填写 API Key')
  if (!model) throw new Error('请先选择模型')
  const url = new URL(configuration.baseUrl?.trim() ?? '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Claude 服务地址必须是无凭据、查询参数和片段的 HTTP(S) 地址')
  }
  // Claude appends /v1/messages itself; accept the common /v1 UI input too.
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '')
  const environment: NodeJS.ProcessEnv = {
    MODMIND_CLAUDE_HOSTED: '1', CLAUDE_CONFIG_DIR: path.resolve(configDirectory),
    ANTHROPIC_BASE_URL: url.toString().replace(/\/$/, ''), ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: configuration.reasoningEffort === 'ultra' ? 'max' : configuration.reasoningEffort ?? 'high'
  }
  // Undefined entries deliberately override inherited credentials/provider switches.
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_SMALL_FAST_MODEL'
  ]) environment[key] = undefined
  return environment
}

export function claudeFailureMessage(event: Record<string, unknown>): string {
  const failed = event.is_error === true || String(event.subtype ?? '').startsWith('error')
  if (!failed) return ''
  return [typeof event.result === 'string' ? event.result : '',
    ...(Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === 'string') : [])
  ].filter(Boolean).join('\n') || 'Claude Code 返回了失败结果'
}

/** Discovery is protocol-specific; listing models is not a generation health check. */
export async function fetchClaudeModels(baseUrl: string, apiKey: string): Promise<unknown> {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Claude 服务地址无效')
  }
  const models: unknown[] = []
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(20_000), redirect: 'error'
    })
    if (!response.ok) throw new Error(`Claude 模型扫描失败（HTTP ${response.status}）。服务需支持 Anthropic 协议；也可手动填写模型 ID。`)
    const payload = await response.json() as { data?: unknown[]; has_more?: boolean; last_id?: string }
    if (!Array.isArray(payload.data)) throw new Error('Claude 模型服务返回了无效数据')
    models.push(...payload.data)
    if (!payload.has_more) return { data: models }
    if (!payload.last_id || payload.last_id === url.searchParams.get('after_id')) throw new Error('Claude 模型列表分页无效')
    url.searchParams.set('after_id', payload.last_id)
  }
  throw new Error('Claude 模型列表分页过多，请手动填写模型 ID')
}
