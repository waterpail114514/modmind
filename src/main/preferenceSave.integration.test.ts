import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { normalizeModelAutoCompactTokenLimits, normalizeModelContextWindows, validModelContext } from '../shared/modelContext'
import { normalizeQuotaModelPreferences } from './quotaModelPreferences'
import { buildCodexModelCatalog, validateCodexAutoCompactTokenLimit } from './codexModelCatalog'
import { isReasoningEffort, reasoningSelectionEffort } from '../shared/modelReasoning'
import { codexReasoningCapabilities, selectedReasoningEfforts } from '../shared/modelReasoning'
import type { BeginnerAiPreferences } from '../shared/types'
import type { CodexServerConfig } from './codexSetup'
import type { AiModelSelection } from '../shared/aiSelection'

// Exercise the real Electron entrypoint function without launching its app/IPC side effects.
it('saving unchanged preferences neither interrupts the task nor writes settings', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveBeginnerAiPreferences')!
  const prefs: BeginnerAiPreferences = { model: 'test', reasoningLevel: 'medium', fastMode: false, modelContextWindows: { test: 524288, another: 1048576 }, modelAutoCompactTokenLimits: { test: 200000, another: 500000 } }
  const revision = { signal: new AbortController().signal }
  const begin = vi.fn(() => revision)
  const write = vi.fn()
  const sandbox = {
    AbortSignal, DEFAULT_BEGINNER_AI_PREFERENCES: prefs,
    normalizeQuotaModelPreferences, validModelContext, validateCodexAutoCompactTokenLimit, isReasoningEffort, reasoningSelectionEffort, selectedReasoningEfforts,
    modelReasoningCatalog: { resolve: () => ({ efforts: ['medium'] }) },
    readBeginnerAiPreferences: async () => prefs,
    readDeviceCredentials: async () => null,
    quotaConfiguration: { acquire: async () => revision, current: () => revision, begin, finish: () => undefined },
    preferenceWrites: { run: (operation: () => unknown) => operation() },
    throwIfAborted: () => undefined,
    readStoredBeginnerAiPreferences: async () => ({}),
    updateQuotaModelPreferences: () => ({}),
    writeStoredBeginnerAiPreferences: write,
    saveBeginnerAiPreferences: undefined as unknown as (v: unknown) => Promise<unknown>
  }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelContextWindows: { another: 1048576, test: 524288 } })
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelAutoCompactTokenLimits: { another: 500000, test: 200000 } })
  expect(begin).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  await sandbox.saveBeginnerAiPreferences({ ...prefs, model: 'changed' })
  expect(begin).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledTimes(1)
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelContextWindows: { ...prefs.modelContextWindows, test: 1050000 } })
  expect(write).toHaveBeenCalledTimes(2)
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelContextWindows: {} })
  expect(write).toHaveBeenCalledTimes(3)
  await expect(sandbox.saveBeginnerAiPreferences({ ...prefs, modelContextWindows: { test: 512 } })).rejects.toThrow('上下文窗口')
  expect(write).toHaveBeenCalledTimes(3)
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelAutoCompactTokenLimits: { ...prefs.modelAutoCompactTokenLimits, test: 300000 } })
  expect(write).toHaveBeenCalledTimes(4)
  await sandbox.saveBeginnerAiPreferences({ ...prefs, modelAutoCompactTokenLimits: {} })
  expect(write).toHaveBeenCalledTimes(5)
  await expect(sandbox.saveBeginnerAiPreferences({ ...prefs, modelAutoCompactTokenLimits: { test: 0 } })).rejects.toThrow('自动压缩阈值')
  await expect(sandbox.saveBeginnerAiPreferences({ ...prefs, modelAutoCompactTokenLimits: { test: 500000 } })).rejects.toThrow('90%')
  await expect(sandbox.saveBeginnerAiPreferences({ ...prefs, modelContextWindows: { test: 100000 } })).rejects.toThrow('90%')
  expect(write).toHaveBeenCalledTimes(5)
})

it('passes the selected quota model override into the runtime catalog', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readBeginnerAgentServerConfig')!
  let preferences: BeginnerAiPreferences = { model: 'gpt-5.6-sol', reasoningLevel: 'medium', fastMode: false, modelContextWindows: { 'gpt-5.6-sol': 1050000 }, modelAutoCompactTokenLimits: { 'gpt-5.6-sol': 800000 } }
  const sandbox = {
    readDeviceCredentials: async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'fixture' }),
    quotaModelsForCredentials: async () => [preferences.model, 'inspiration-model'].map(id => ({ id, reasoning: { efforts: ['medium', 'max'], source: 'provider', controls: ['effort'] } })),
    reconcileQuotaModelPreferences: vi.fn(async () => preferences),
    readBeginnerAiPreferences: async () => preferences,
    sameDeviceCredentials: () => true,
    openAiV1BaseUrl: (url: string) => url,
    reasoningSelectionEffort,
    modelReasoningCatalog: { resolve: () => ({ efforts: ['medium'] }) },
    normalizeModelContextWindows, normalizeModelAutoCompactTokenLimits, selectedReasoningEfforts, codexReasoningCapabilities,
    readBeginnerAgentServerConfig: undefined as unknown as (selection?: AiModelSelection) => Promise<CodexServerConfig>
  }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
  const config = await sandbox.readBeginnerAgentServerConfig()
  expect(config.contextWindow).toBe(1050000)
  expect(config.autoCompactTokenLimit).toBe(800000)
  expect(config.reasoningCapabilities?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(buildCodexModelCatalog(config.model, config)?.models.at(-1)?.context_window).toBe(1050000)
  preferences = { ...preferences, model: 'gpt-5.6-terra' }
  expect((await sandbox.readBeginnerAgentServerConfig()).contextWindow).toBeUndefined()
  expect((await sandbox.readBeginnerAgentServerConfig()).autoCompactTokenLimit).toBeUndefined()
  sandbox.reconcileQuotaModelPreferences.mockClear()
  const independent = await sandbox.readBeginnerAgentServerConfig({ model: 'inspiration-model', reasoningLevel: 'max' })
  expect(independent).toMatchObject({ model: 'inspiration-model', reasoningEffort: 'max' })
  expect(independent.contextWindow).toBeUndefined()
  expect(independent.autoCompactTokenLimit).toBeUndefined()
  expect(preferences.model).toBe('gpt-5.6-terra')
  expect(sandbox.reconcileQuotaModelPreferences).not.toHaveBeenCalled()
  await expect(sandbox.readBeginnerAgentServerConfig({ model: 'unavailable', reasoningLevel: 'auto' })).rejects.toThrow('当前线路没有模型')
})

it('passes exact-model thresholds through the configured Codex route', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'configuredCodexServerConfig')!
  const sandbox = {
    normalizeApiBaseUrl: (url: string) => url,
    refreshConfiguredReasoning: async () => undefined,
    modelReasoningFor: () => ({ efforts: [] }),
    reasoningSelectionEffort, normalizeModelContextWindows, normalizeModelAutoCompactTokenLimits, selectedReasoningEfforts, codexReasoningCapabilities,
    configuredCodexServerConfig: undefined as unknown as (configuration: import('../shared/types').ExternalAgentConfiguration) => Promise<CodexServerConfig>
  }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
  const configuration = { baseUrl: 'https://relay.example/v1', apiKey: 'fixture', model: 'private', reasoningEffort: 'max' as const, reasoningEffortOptions: { private: ['low', 'medium', 'high', 'max', 'ultra'] as const }, modelContextWindows: { private: 512000 }, modelAutoCompactTokenLimits: { private: 400000 } }
  expect(await sandbox.configuredCodexServerConfig(configuration as unknown as import('../shared/types').ExternalAgentConfiguration)).toMatchObject({ contextWindow: 512000, autoCompactTokenLimit: 400000, reasoningEffort: 'max', reasoningCapabilities: { efforts: ['low', 'medium', 'high', 'max', 'ultra'] } })
  const switched = await sandbox.configuredCodexServerConfig({ ...configuration, model: 'another', reasoningEffort: undefined } as unknown as import('../shared/types').ExternalAgentConfiguration)
  expect(switched.contextWindow).toBeUndefined()
  expect(switched.autoCompactTokenLimit).toBeUndefined()
})
