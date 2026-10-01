import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'

export interface LocalCodexConfig {
  home: string
  model: string
  baseUrl?: string
  hasApiKey: boolean
  contextWindow?: number
  autoCompactTokenLimit?: number
  reasoningEffort?: string
  models: string[]
}

async function readNativeConfig(home: string): Promise<Record<string, unknown>> {
  const configPath = path.join(home, 'config.toml')
  try {
    return parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机 Codex 配置，请检查 config.toml')
    return {}
  }
}

function activeProvider(config: Record<string, unknown>): Record<string, unknown> {
  const profiles = config.profiles && typeof config.profiles === 'object' ? config.profiles as Record<string, unknown> : {}
  const profile = typeof config.profile === 'string' ? profiles[config.profile] : undefined
  const active = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {}
  const providerName = active.model_provider ?? config.model_provider
  const providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers as Record<string, unknown> : {}
  const provider = typeof providerName === 'string' ? providers[providerName] : undefined
  return provider && typeof provider === 'object' ? provider as Record<string, unknown> : {}
}

function providerApiKey(provider: Record<string, unknown>): string {
  if (typeof provider.experimental_bearer_token === 'string' && provider.experimental_bearer_token.trim()) return provider.experimental_bearer_token.trim()
  const envKey = typeof provider.env_key === 'string' ? provider.env_key : ''
  return envKey ? process.env[envKey]?.trim() ?? '' : ''
}

export async function readLocalCodexApiKey(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): Promise<string> {
  return providerApiKey(activeProvider(await readNativeConfig(home)))
}

export async function readLocalCodexConfig(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): Promise<LocalCodexConfig> {
  const config = await readNativeConfig(home)
  const provider = activeProvider(config)
  const activeProfile = typeof config.profile === 'string' && config.profiles && typeof config.profiles === 'object'
    ? (config.profiles as Record<string, unknown>)[config.profile] : undefined
  const active = activeProfile && typeof activeProfile === 'object' ? activeProfile as Record<string, unknown> : {}
  const modelValue = active.model ?? config.model
  const model = typeof modelValue === 'string' ? modelValue.trim() : ''
  const profiles = config.profiles && typeof config.profiles === 'object' ? Object.values(config.profiles) : []
  const models = new Set<string>(model ? [model] : [])
  if (typeof config.model === 'string' && config.model.trim()) models.add(config.model.trim())
  for (const profile of profiles) {
    if (profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).model === 'string') {
      const candidate = String((profile as Record<string, unknown>).model).trim()
      if (candidate) models.add(candidate)
    }
  }
  const contextWindowValue = active.model_context_window ?? config.model_context_window
  const compactValue = active.model_auto_compact_token_limit ?? config.model_auto_compact_token_limit
  const contextWindow = Number.isSafeInteger(contextWindowValue) ? contextWindowValue as number : undefined
  const autoCompactTokenLimit = Number.isSafeInteger(compactValue) ? compactValue as number : undefined
  const effortValue = active.model_reasoning_effort ?? config.model_reasoning_effort
  return {
    home, model, contextWindow, autoCompactTokenLimit,
    baseUrl: typeof provider.base_url === 'string' ? provider.base_url.trim() : undefined,
    hasApiKey: Boolean(providerApiKey(provider)),
    reasoningEffort: typeof effortValue === 'string' ? effortValue : undefined,
    models: [...models]
  }
}
