import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { normalizeModelAutoCompactTokenLimits, normalizeModelContextWindows } from '../shared/modelContext'
import { isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts } from '../shared/modelReasoning'

function fixture() {
  const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveAgentSettings')!
  let stored: any = { externalAgents: { codex: { mode: 'hosted', baseUrl: 'invalid-old-url', model: 'manual', modelAutoCompactTokenLimits: { manual: 99999999 } } }, encryptedAgentKeys: { codex: 'old-encrypted-key' } }
  const state: any = {
    Promise, JSON, Error, console, Buffer,
    agentSettingsWriteTail: Promise.resolve(),
    fs: { readFile: async () => JSON.stringify(stored) }, settingsFile: () => 'settings.json',
    normalizeAgentApprovalMode: (value: any) => value, normalizeNetworkProxyUrl: (value: any) => value,
    normalizeJavaPreferences: (value: any) => value, normalizeAppearance: () => ({}),
    normalizeModelContextWindows, normalizeModelAutoCompactTokenLimits, normalizeReasoningEffortOptions, isReasoningEffort, selectedReasoningEfforts,
    validateCodexAutoCompactTokenLimit: vi.fn(() => { throw new Error('invalid old model threshold') }),
    reasoningSelectionEffort: vi.fn(),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (key: string) => Buffer.from(key) },
    writeAgentSettingsAtomically: vi.fn(async (value: any) => { stored = value }),
    readSettings: async () => stored,
    pruneSavedBackgroundMedia: vi.fn(() => new Promise(() => {})),
    app: { getPath: () => '/fixture' }, BrowserWindow: { getAllWindows: () => [] }
  }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return { state, readStored: () => stored }
}

it('allows unrelated preferences to save despite invalid historical model settings and pending media cleanup', async () => {
  const { state, readStored } = fixture()
  await state.saveAgentSettings({ ...readStored(), darkMode: true })
  expect(state.validateCodexAutoCompactTokenLimit).not.toHaveBeenCalled()
  expect(readStored().darkMode).toBe(true)
})

it('still validates explicitly edited model preferences', async () => {
  const { state, readStored } = fixture()
  const settings = readStored()
  settings.externalAgents.codex.model = 'edited'
  // Supply a separate persisted snapshot so this is an actual preference edit.
  state.fs.readFile = async () => JSON.stringify({ externalAgents: { codex: { model: 'previous' } } })
  await expect(state.saveAgentSettings(settings)).rejects.toThrow('invalid old model threshold')
  expect(state.writeAgentSettingsAtomically).not.toHaveBeenCalled()
})

it('does not let an old invalid context threshold block changes to reasoning or unrelated preferences', async () => {
  const { state, readStored } = fixture()
  const settings = readStored()
  state.fs.readFile = async () => JSON.stringify({ ...settings, externalAgents: { codex: { ...settings.externalAgents.codex, reasoningEffort: 'invalid-old-effort' } } })
  await state.saveAgentSettings({ ...settings, darkMode: true })
  await state.saveAgentSettings({ ...settings, externalAgents: { codex: { ...settings.externalAgents.codex, reasoningEffort: 'low' } } })
  expect(state.validateCodexAutoCompactTokenLimit).not.toHaveBeenCalled()
  expect(state.reasoningSelectionEffort).toHaveBeenCalledWith('low', undefined, expect.any(Array))
})

it('clears the encrypted old endpoint key and does not persist save-only flags or plaintext', async () => {
  const { state, readStored } = fixture()
  const settings = readStored()
  await state.saveAgentSettings({ ...settings, externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://new.example/v1', apiKey: '', clearApiKey: true } } }, false)
  expect(readStored().encryptedAgentKeys).toBeUndefined()
  expect(JSON.stringify(readStored())).not.toContain('clearApiKey')
  expect(readStored().externalAgents.codex.apiKey).toBeUndefined()
})

it('recovers the write queue after a disk failure', async () => {
  const { state, readStored } = fixture()
  state.writeAgentSettingsAtomically.mockRejectedValueOnce(new Error('disk full'))
  await expect(state.saveAgentSettings(readStored(), false)).rejects.toThrow('disk full')
  await expect(state.saveAgentSettings({ ...readStored(), darkMode: true }, false)).resolves.toHaveProperty('darkMode', true)
})
