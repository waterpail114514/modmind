import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { normalizeModelContextWindows, validModelContext } from '../shared/modelContext'
import { normalizeQuotaModelPreferences } from './quotaModelPreferences'
import { buildCodexModelCatalog } from './codexModelCatalog'
import { isReasoningEffort, reasoningSelectionEffort } from '../shared/modelReasoning'
import type { BeginnerAiPreferences } from '../shared/types'
import type { CodexServerConfig } from './codexSetup'
import type { AiModelSelection } from '../shared/aiSelection'

// Exercise the real Electron entrypoint function without launching its app/IPC side effects.
it('saving unchanged preferences neither interrupts the task nor writes settings', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveBeginnerAiPreferences')!
  const prefs: BeginnerAiPreferences = { model: 'test', reasoningLevel: 'medium', fastMode: false, modelContextWindows: { test: 524288, another: 1048576 } }
  const revision = { signal: new AbortController().signal }
  const begin = vi.fn(() => revision)
  const write = vi.fn()
  const sandbox = {
    AbortSignal, DEFAULT_BEGINNER_AI_PREFERENCES: prefs,
    normalizeQuotaModelPreferences, validModelContext, isReasoningEffort, reasoningSelectionEffort,
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
})

it('passes the selected quota model override into the runtime catalog', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readBeginnerAgentServerConfig')!
  let preferences: BeginnerAiPreferences = { model: 'gpt-5.6-sol', reasoningLevel: 'medium', fastMode: false, modelContextWindows: { 'gpt-5.6-sol': 1050000 } }
  const sandbox = {
    readDeviceCredentials: async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'fixture' }),
    quotaModelsForCredentials: async () => [preferences.model, 'inspiration-model'].map(id => ({ id, reasoning: { efforts: ['medium', 'ultra'], source: 'provider', controls: ['effort'] } })),
    reconcileQuotaModelPreferences: vi.fn(async () => preferences),
    readBeginnerAiPreferences: async () => preferences,
    sameDeviceCredentials: () => true,
    openAiV1BaseUrl: (url: string) => url,
    reasoningSelectionEffort,
    modelReasoningCatalog: { resolve: () => ({ efforts: ['medium'] }) },
    normalizeModelContextWindows,
    readBeginnerAgentServerConfig: undefined as unknown as (selection?: AiModelSelection) => Promise<CodexServerConfig>
  }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
  const config = await sandbox.readBeginnerAgentServerConfig()
  expect(config.contextWindow).toBe(1050000)
  expect(buildCodexModelCatalog(config.model, config)?.models.at(-1)?.context_window).toBe(1050000)
  preferences = { ...preferences, model: 'gpt-5.6-terra' }
  expect((await sandbox.readBeginnerAgentServerConfig()).contextWindow).toBeUndefined()
  sandbox.reconcileQuotaModelPreferences.mockClear()
  const independent = await sandbox.readBeginnerAgentServerConfig({ model: 'inspiration-model', reasoningLevel: 'ultra' })
  expect(independent).toMatchObject({ model: 'inspiration-model', reasoningEffort: 'ultra' })
  expect(independent.contextWindow).toBeUndefined()
  expect(preferences.model).toBe('gpt-5.6-terra')
  expect(sandbox.reconcileQuotaModelPreferences).not.toHaveBeenCalled()
  await expect(sandbox.readBeginnerAgentServerConfig({ model: 'unavailable', reasoningLevel: 'auto' })).rejects.toThrow('当前线路没有模型')
})
