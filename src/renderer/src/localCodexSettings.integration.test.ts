import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['configureExternalAgent', 'scanLocalCodex', 'saveLocalCodexPreference', 'installExternalAgent']
const declarations: string[] = []
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`)
  ts.forEachChild(node, visit)
}
visit(ast)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const configuration = { mode: 'hosted', baseUrl: 'https://old.example/v1', model: 'manual-id' }
  const saved = { externalAgents: { codex: { ...configuration, baseUrl: 'https://new.example/v1' } } }
  const state: any = {
    Number, Promise, Error, setTimeout, clearTimeout, externalAgentLabel: () => 'Codex',
    settingsRef: { current: { externalAgents: { codex: configuration } } },
    settingsMutationRef: { current: 0 }, settingsSaveTailRef: { current: Promise.resolve() },
    localCodexScanInFlight: { current: null }, localCodexScanGeneration: { current: 0 },
    aiSettingsSelectionGeneration: { current: 0 },
    agentDraft: { baseUrl: 'https://new.example/v1', apiKey: 'fixture-key' },
    configuringAgents: {}, installingAgents: {}, scans: null, agents: [], notices: [],
    setConfiguringAgents: (update: any) => { state.configuringAgents = update(state.configuringAgents) },
    setInstallingAgents: (update: any) => { state.installingAgents = update(state.installingAgents) },
    setSettings: vi.fn(), setAgentDraft: vi.fn(), setExternalAgentsReady: vi.fn(),
    setLocalCodexScanning: (value: boolean) => { state.scanning = value },
    setLocalCodexScanError: (value: string) => { state.scanError = value },
    setLocalCodexScan: (value: any) => { state.scans = typeof value === 'function' ? value(state.scans) : value },
    setExternalAgents: (update: any) => { state.agents = update(state.agents) },
    setNotice: (value: string) => state.notices.push(value), errorMessage: (error: Error) => error.message,
    saveSettingsPatch: vi.fn(async (patch: any) => { state.settingsRef.current = { ...state.settingsRef.current, ...patch }; return true }),
    window: { modmind: {
      externalAgents: {
        configure: vi.fn(async () => ({ settings: saved })),
        scanLocal: vi.fn(() => new Promise(() => {})),
        install: vi.fn(async () => ({ kind: 'codex', installed: true, label: 'Codex' }))
      }, settings: { getAgent: vi.fn(async () => saved) }
    } }
  }
  vm.runInNewContext(ts.transpileModule(`${declarations.join('\n')}\nObject.assign(globalThis, { ${names.join(',')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, state)
  return state
}

afterEach(() => vi.useRealTimers())

it('saves new credentials while an old scan is pending and releases save state before the new scan finishes', async () => {
  vi.useFakeTimers()
  const state = fixture()
  const oldScan = deferred<any>()
  state.window.modmind.externalAgents.scanLocal.mockReturnValueOnce(oldScan.promise)
  const retired = state.scanLocalCodex()
  await state.configureExternalAgent('codex')
  expect(state.window.modmind.externalAgents.configure).toHaveBeenCalledOnce()
  expect(state.configuringAgents.codex).toBe(false)
  expect(state.notices).toContain('连接已保存到本地设置')
  expect(state.scanning).toBe(true)
  oldScan.resolve({ status: { kind: 'codex', installed: true }, baseUrl: 'https://old.example/v1', models: ['stale-model'] })
  await retired
  expect(state.scans).toBe(null)
  expect(state.scanning).toBe(true)
  expect(state.saveSettingsPatch).not.toHaveBeenCalled()
  expect(state.settingsRef.current.externalAgents.codex.baseUrl).toBe('https://new.example/v1')
})

it('times out stuck model scans, releases refresh state and permits retry', async () => {
  vi.useFakeTimers()
  const state = fixture()
  const scan = state.scanLocalCodex()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await scan).toBe(null)
  expect(state.scanError).toContain('超时')
  expect(state.scanning).toBe(false)
  state.window.modmind.externalAgents.scanLocal.mockResolvedValueOnce({ status: { kind: 'codex', installed: true }, models: ['manual-id'], baseUrl: 'https://old.example/v1' })
  expect(await state.scanLocalCodex()).toHaveProperty('models', ['manual-id'])
})

it('retains a manually selected model even when discovery omits that ID', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.window.modmind.externalAgents.scanLocal.mockResolvedValueOnce({ status: { kind: 'codex', installed: true }, models: ['other-model'], baseUrl: 'https://old.example/v1' })
  await state.scanLocalCodex()
  expect(state.settingsRef.current.externalAgents.codex.model).toBe('manual-id')
  expect(state.saveSettingsPatch).not.toHaveBeenCalled()
})

it('retains connection drafts after a local write failure and allows a successful retry', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.window.modmind.externalAgents.configure.mockRejectedValueOnce(new Error('disk write failed'))
  await state.configureExternalAgent('codex')
  expect(state.configuringAgents.codex).toBe(false)
  expect(state.setAgentDraft).not.toHaveBeenCalled()
  expect(state.notices.at(-1)).toContain('disk write failed')
  await state.configureExternalAgent('codex')
  expect(state.notices.at(-1)).toBe('连接已保存到本地设置')
})

it('uses the shared integration installer and does not wait for an old model scan', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.localCodexScanInFlight.current = new Promise(() => {})
  await state.installExternalAgent('codex')
  expect(state.window.modmind.externalAgents.install).toHaveBeenCalledWith('codex')
  expect(state.installingAgents.codex).toBe(false)
  expect(state.window.modmind.externalAgents.scanLocal).toHaveBeenCalledOnce()
})

it('keeps unrelated preference writes queued during connection save from restoring the old endpoint', async () => {
  vi.useFakeTimers()
  const state = fixture()
  let preferenceDeclaration = ''
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'saveSettingsPatch') preferenceDeclaration = node.getText(ast)
    ts.forEachChild(node, find)
  }
  find(ast)
  state.settingsSavePendingRef = { current: 0 }
  state.setSettingsFeedback = vi.fn()
  state.verifySettingsSave = vi.fn()
  state.window.modmind.settings.saveAgent = vi.fn(async (settings: any) => settings)
  vm.runInNewContext(ts.transpileModule(`const ${preferenceDeclaration}; globalThis.performPreferenceSave = saveSettingsPatch;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, state)
  const pending = deferred<any>()
  state.window.modmind.externalAgents.configure.mockReturnValueOnce(pending.promise)
  const connectionSave = state.configureExternalAgent('codex')
  const preferenceSave = state.performPreferenceSave({ darkMode: true })
  pending.resolve({ settings: { externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://new.example/v1', model: 'manual-id' } } } })
  await Promise.all([connectionSave, preferenceSave])
  expect(state.window.modmind.settings.saveAgent.mock.calls[0][0]).toMatchObject({
    darkMode: true, externalAgents: { codex: { baseUrl: 'https://new.example/v1' } }
  })
  expect(state.settingsRef.current.externalAgents.codex.baseUrl).toBe('https://new.example/v1')
})
