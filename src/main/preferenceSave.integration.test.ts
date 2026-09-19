import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

// Exercise the real Electron entrypoint function without launching its app/IPC side effects.
it('saving unchanged preferences neither interrupts the task nor writes settings', async () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveBeginnerAiPreferences')!
  const prefs = { model: 'test', reasoningLevel: 'medium', fastMode: false }
  const revision = { signal: new AbortController().signal }
  const begin = vi.fn(() => revision)
  const write = vi.fn()
  const sandbox = {
    AbortSignal, DEFAULT_BEGINNER_AI_PREFERENCES: prefs,
    normalizeQuotaModelPreferences: (v: unknown) => v,
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
  await sandbox.saveBeginnerAiPreferences({ ...prefs })
  expect(begin).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  await sandbox.saveBeginnerAiPreferences({ ...prefs, model: 'changed' })
  expect(begin).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledTimes(1)
})
