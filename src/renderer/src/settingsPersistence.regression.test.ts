import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { agentSettingsPatch, mergeAgentSettingsPatch } from '../../shared/agentSettingsPatch'
import { verifySettingsSave } from './settingsSaveResult'
import type { AgentSettings } from '../../shared/types'

const ast = ts.createSourceFile('App.tsx', readFileSync('src/renderer/src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let declaration = ''
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'saveSettingsPatch') declaration = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
function fixture(outcomes: boolean[]) {
  let stored = { darkMode: false, closeBehavior: 'ask', notificationsEnabled: true,
    javaPreferences: { game: '', build: '', tools: '' }, externalAgents: { codex: { mode: 'hosted', model: 'original' } } } as AgentSettings
  const state: any = {
    settingsRef: { current: structuredClone(stored) }, settingsConfirmedRef: { current: structuredClone(stored) },
    settingsPendingPatchesRef: { current: new Map() }, settingsMutationRef: { current: 0 },
    settingsSaveTailRef: { current: Promise.resolve() }, settingsSavePendingRef: { current: 0 },
    agentSettingsPatch, mergeAgentSettingsPatch, verifySettingsSave,
    setSettings: vi.fn(), setSettingsFeedback: vi.fn(), setNotice: vi.fn(), errorMessage: (error: Error) => error.message,
    window: { modmind: { settings: { saveAgent: vi.fn(async patch => {
      if (!outcomes.shift()) throw new Error('disk full')
      stored = mergeAgentSettingsPatch(stored, patch)
      return structuredClone(stored)
    }) } } }
  }
  vm.runInNewContext(ts.transpileModule(`const ${declaration}; globalThis.savePatch = saveSettingsPatch;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return { state, stored: () => stored }
}

it.each([[false, false], [true, false], [false, true], [true, true]])('AUD110 displays only committed values after overlapping saves %s / %s', async (first, second) => {
  const { state, stored } = fixture([first, second])
  const results = await Promise.all([state.savePatch({ darkMode: true }), state.savePatch({ notificationsEnabled: false })])
  expect(results).toEqual([first, second])
  expect(state.settingsRef.current).toEqual(stored())
  expect(state.settingsRef.current.darkMode).toBe(first)
  expect(state.settingsRef.current.notificationsEnabled).toBe(!second)
  expect(state.settingsPendingPatchesRef.current.size).toBe(0)
  expect(state.settingsSavePendingRef.current).toBe(0)
  expect(state.setNotice).toHaveBeenCalledTimes(Number(!first) + Number(!second))
})

it('keeps later optimistic edits visible while an earlier failure settles, then restores confirmed state', async () => {
  const { state, stored } = fixture([])
  let rejectFirst!: (reason: Error) => void
  let resolveSecond!: (value: AgentSettings) => void
  state.window.modmind.settings.saveAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
  const first = state.savePatch({ darkMode: true })
  const second = state.savePatch({ notificationsEnabled: false })
  await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'))
  rejectFirst(new Error('first write failed'))
  expect(await first).toBe(false)
  expect(state.settingsRef.current).toMatchObject({ darkMode: false, notificationsEnabled: false })
  await vi.waitFor(() => expect(resolveSecond).toBeTypeOf('function'))
  resolveSecond({ ...stored(), notificationsEnabled: false })
  expect(await second).toBe(true)
  expect(state.settingsRef.current).toMatchObject({ darkMode: false, notificationsEnabled: false })
})

it('AUD034 sends changed nested leaves rather than full model and Java snapshots', async () => {
  const { state } = fixture([true])
  await state.savePatch({ javaPreferences: { game: 'new-game', build: '', tools: '' },
    externalAgents: { codex: { mode: 'hosted', model: 'new-model' } } })
  expect(state.window.modmind.settings.saveAgent).toHaveBeenCalledWith({ javaPreferences: { game: 'new-game' }, externalAgents: { codex: { model: 'new-model' } } })
})

it('can retry after all writes failed without resubmitting the failed earlier preference', async () => {
  const { state, stored } = fixture([false, false, true])
  await Promise.all([state.savePatch({ darkMode: true }), state.savePatch({ notificationsEnabled: false })])
  expect(await state.savePatch({ closeBehavior: 'quit' })).toBe(true)
  expect(stored()).toMatchObject({ darkMode: false, notificationsEnabled: true, closeBehavior: 'quit' })
})
