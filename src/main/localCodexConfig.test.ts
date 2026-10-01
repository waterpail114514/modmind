import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLocalCodexApiKey, readLocalCodexConfig } from './localCodexConfig'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('reads the native default and profile models without returning provider secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-local-codex-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_provider = "custom"',
    'model_context_window = 1000000',
    'model_auto_compact_token_limit = 512000',
    'model_reasoning_effort = "high"',
    '[model_providers.custom]',
    'base_url = "https://example.test/v1"',
    'experimental_bearer_token = "private-token"',
    '[profiles.quick]',
    'model = "gpt-6-luna"'
  ].join('\n'))
  const result = await readLocalCodexConfig(root)
  expect(result).toMatchObject({ model: 'gpt-6-astra', baseUrl: 'https://example.test/v1', hasApiKey: true, contextWindow: 1000000, autoCompactTokenLimit: 512000, reasoningEffort: 'high', models: ['gpt-6-astra', 'gpt-6-luna'] })
  expect(JSON.stringify(result)).not.toContain('private-token')
  expect(await readLocalCodexApiKey(root)).toBe('private-token')
})

it('allows a fresh installation without a config file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-local-codex-'))
  roots.push(root)
  expect(await readLocalCodexConfig(root)).toMatchObject({ model: '', models: [], hasApiKey: false })
})

it('uses the selected Codex profile as the effective default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-local-codex-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_context_window = 1000000',
    'profile = "quick"',
    '[profiles.quick]',
    'model = "gpt-6-luna"',
    'model_context_window = 200000',
    'model_provider = "profile-provider"',
    '[model_providers.profile-provider]',
    'base_url = "https://profile.example/v1"',
    'experimental_bearer_token = "profile-secret"'
  ].join('\n'))
  expect(await readLocalCodexConfig(root)).toMatchObject({ model: 'gpt-6-luna', contextWindow: 200000, baseUrl: 'https://profile.example/v1', hasApiKey: true })
  expect(await readLocalCodexApiKey(root)).toBe('profile-secret')
})
