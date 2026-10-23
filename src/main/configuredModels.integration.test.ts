import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import type { AgentSettings, ExternalAgentConfiguration, LocalCodexScan } from '../shared/types'
import { sameApiBaseUrl } from '../shared/apiConnection'

// Run the same functions used by settings refresh and workbench model discovery.
function fixture(configuration: ExternalAgentConfiguration = {}) {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const native = { home: '/native', model: 'gpt-native', models: ['gpt-native'], hasApiKey: false, baseUrl: undefined as string | undefined }
  const state = {
    Error,
    sameApiBaseUrl,
    publicAgentSettings: (settings: AgentSettings) => ({ ...settings, externalAgents: { codex: { ...settings.externalAgents?.codex, apiKey: '' } } }),
    app: { getPath: () => '/modmind' },
    readSettings: vi.fn(async () => ({ codingBackend: 'quota', externalAgents: { codex: configuration } })),
    saveAgentSettings: vi.fn(async (settings: AgentSettings) => settings),
    reasoningSelectionEffort: vi.fn(), modelReasoningFor: vi.fn(), selectedReasoningEfforts: vi.fn(),
    readLocalCodexConfig: vi.fn(async () => native),
    readLocalCodexApiKey: vi.fn(async () => 'native-key'),
    detectInstalledCodex: vi.fn(async () => ({ installed: true, kind: 'codex', executable: 'codex' })),
    listLocalCodexModels: vi.fn(async () => ['gpt-default']),
    modelReasoningCatalog: { refresh: vi.fn(), enrich: (models: unknown) => models },
    normalizeApiBaseUrl: (url: string) => new URL(url).toString().replace(/\/$/, ''),
    fetchAvailableModels: vi.fn(async (_base?: string, _key?: string, _error?: string) => [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]),
    discoverAvailableModels: vi.fn(async (baseUrl: string, apiKey: string, error: string) => ({ baseUrl, models: await state.fetchAvailableModels(baseUrl, apiKey, error) })),
    scanConfiguredCodex: undefined as unknown as () => Promise<LocalCodexScan>,
    listAvailableAgentModels: undefined as unknown as (kind: string, input: ExternalAgentConfiguration) => Promise<unknown>,
    configureExternalAgentConnection: undefined as unknown as (kind: string, input: ExternalAgentConfiguration) => Promise<{ settings: AgentSettings }>
  }
  const names = ['listAvailableAgentModels', 'scanConfiguredCodex', 'configureExternalAgentConnection']
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  vm.runInNewContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return { state, native }
}

it('refreshes the saved DeepSeek connection without importing native GPT models or secrets', async () => {
  const configuration: ExternalAgentConfiguration = { mode: 'hosted', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'saved-key', model: 'gpt-stale' }
  const { state } = fixture(configuration)
  const result = await state.scanConfiguredCodex()
  expect(result.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  expect(result.baseUrl).toBe(configuration.baseUrl)
  expect(state.fetchAvailableModels).toHaveBeenCalledWith(configuration.baseUrl, 'saved-key', expect.any(String))
  expect(state.listLocalCodexModels).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('saved-key')
  configuration.baseUrl = 'https://another.example/v1'
  configuration.apiKey = 'new-key'
  await state.scanConfiguredCodex()
  expect(state.fetchAvailableModels).toHaveBeenLastCalledWith(configuration.baseUrl, 'new-key', expect.any(String))
})

it('queries a custom native provider rather than the CLI built-in catalog', async () => {
  const { state, native } = fixture({ mode: 'local' })
  native.baseUrl = 'https://api.deepseek.com/v1'
  expect((await state.scanConfiguredCodex()).models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  expect(state.fetchAvailableModels).toHaveBeenCalledWith(native.baseUrl, 'native-key', expect.any(String))
  expect(state.listLocalCodexModels).not.toHaveBeenCalled()
})

it('keeps CLI model discovery for native login without a custom endpoint', async () => {
  const { state } = fixture({ mode: 'local' })
  expect((await state.scanConfiguredCodex()).models).toEqual(['gpt-default', 'gpt-native'])
  expect(state.fetchAvailableModels).not.toHaveBeenCalled()
})

it('keeps settings editable after a failed lookup, clears stale models, and supports retry', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'key' })
  state.fetchAvailableModels.mockRejectedValueOnce(new Error('服务不可用'))
  const failed = await state.scanConfiguredCodex()
  expect(failed.status.installed).toBe(true)
  expect(failed.models).toEqual([])
  expect(failed.modelsError).toBe('服务不可用')
  expect(state.listLocalCodexModels).not.toHaveBeenCalled()
  expect((await state.scanConfiguredCodex()).models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
})

it('does not reuse credentials after an endpoint changes', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://old.example/v1', apiKey: 'old-key' })
  await expect(state.listAvailableAgentModels('codex', { mode: 'hosted', baseUrl: 'https://new.example/v1' })).rejects.toThrow('API Key')
  expect(state.fetchAvailableModels).not.toHaveBeenCalled()
})

it('does not replace an empty provider catalog with built-in GPT models', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'key' })
  state.fetchAvailableModels.mockResolvedValue([])
  expect((await state.scanConfiguredCodex()).models).toEqual([])
  expect(state.listLocalCodexModels).not.toHaveBeenCalled()
})


it('saves a connection with no model without waiting for provider discovery or CLI detection', async () => {
  const { state } = fixture()
  state.discoverAvailableModels.mockResolvedValue({ baseUrl: 'https://api.example/v1', models: [{ id: 'first' }, { id: 'second' }] })
  const saved = await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://api.example', apiKey: 'fixture-key', model: '' })
  expect(saved.settings).toMatchObject({ codingBackend: 'codex', externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://api.example', model: '', apiKey: '' } } })
  expect(state.saveAgentSettings).toHaveBeenCalledOnce()
  expect(state.discoverAvailableModels).not.toHaveBeenCalled()
  expect(state.detectInstalledCodex).not.toHaveBeenCalled()
  expect(state.readLocalCodexConfig).not.toHaveBeenCalled()
})

it('keeps a user-selected model on the same connection instead of resetting to first', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://api.example/v1', apiKey: 'fixture-key', model: 'deepseek-reasoner' })
  const saved = await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://api.example/v1', model: 'deepseek-reasoner' })
  expect(saved.settings.externalAgents?.codex?.model).toBe('deepseek-reasoner')
  expect(state.saveAgentSettings.mock.calls[0][0].externalAgents?.codex?.apiKey).toBe('fixture-key')
})

it('overwrites malformed historical URLs and does not inspect native config when a new key is supplied', async () => {
  const { state, native } = fixture({ mode: 'hosted', baseUrl: 'invalid-old-url', apiKey: 'old-key', model: 'manual-id' })
  native.baseUrl = 'also-invalid'
  state.normalizeApiBaseUrl = (url: string) => new URL(url).toString().replace(/\/$/, '')
  state.discoverAvailableModels.mockImplementation(() => new Promise(() => {}))
  const saved = await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://new.example/v1', apiKey: 'new-key', model: 'manual-id' })
  expect(saved.settings.externalAgents?.codex?.baseUrl).toBe('https://new.example/v1')
  expect(state.readLocalCodexConfig).not.toHaveBeenCalled()
  expect(state.discoverAvailableModels).not.toHaveBeenCalled()
  expect(state.saveAgentSettings).toHaveBeenCalledWith(expect.anything(), false)
})

it('saves an incomplete new connection while clearing credentials belonging to the old endpoint', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://old.example/v1', apiKey: 'old-key' })
  const saved = await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://new.example/v1', model: '' })
  expect(saved.settings.externalAgents?.codex).toMatchObject({ baseUrl: 'https://new.example/v1', model: '', apiKey: '', clearApiKey: true })
  expect(state.saveAgentSettings.mock.calls[0][0].externalAgents?.codex?.apiKey).toBe('')
})

it('reports a local persistence failure and allows the next save to retry', async () => {
  const { state } = fixture()
  state.saveAgentSettings.mockRejectedValueOnce(new Error('disk write failed'))
  const connection = { mode: 'hosted' as const, baseUrl: 'https://new.example/v1', apiKey: 'key' }
  await expect(state.configureExternalAgentConnection('codex', connection)).rejects.toThrow('disk write failed')
  await expect(state.configureExternalAgentConnection('codex', connection)).resolves.toHaveProperty('settings')
})

it('never switches saved custom connections to native configuration when credentials are unavailable', async () => {
  const { state } = fixture({ mode: 'hosted', baseUrl: 'https://api.example/v1', model: 'saved-model' })
  const result = await state.scanConfiguredCodex()
  expect(result.model).toBe('saved-model')
  expect(result.modelsError).toContain('API Key')
  expect(state.readLocalCodexConfig).not.toHaveBeenCalled()
  expect(state.listLocalCodexModels).not.toHaveBeenCalled()
})
