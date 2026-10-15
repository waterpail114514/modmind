import { readFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppearance } from '../shared/appTheme'
import { normalizeAgentApprovalMode } from '../shared/agentApproval'
import { mergeAgentSettingsPatch } from '../shared/agentSettingsPatch'
import { normalizeModelContextWindows, normalizeModelAutoCompactTokenLimits } from '../shared/modelContext'
import { isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts, reasoningSelectionEffort } from '../shared/modelReasoning'
import { writeSettingsFile } from './settingsFile'

const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
function original(name: string, ipc = false): string {
  let result: ts.Node | undefined
  function visit(node: ts.Node): void {
    if (!ipc && ts.isFunctionDeclaration(node) && node.name?.text === name) result = node
    if (ipc && ts.isCallExpression(node) && node.expression.getText(ast) === 'diagnosticHandle' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) result = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!result) throw new Error(`Missing original: ${name}`)
  return result.getText(ast)
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('modmind-settings-regression-')) throw new Error('Unsafe test cleanup')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-settings-regression-'))
  roots.push(root)
  const target = path.join(root, 'settings.json')
  const initial = {
    codingBackend: 'codex', darkMode: false, closeBehavior: 'ask', notificationsEnabled: true,
    externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model' } },
    encryptedAgentKeys: { codex: Buffer.from('synthetic-key').toString('base64') }
  }
  await fs.writeFile(target, JSON.stringify(initial))
  const state: any = vm.createContext({
    fs: { ...fs }, path, Buffer, URL, randomUUID, console,
    app: { getPath: () => root }, agentSettingsWriteTail: Promise.resolve(),
    normalizeAppearance, normalizeAgentApprovalMode, mergeAgentSettingsPatch,
    normalizeModelContextWindows, normalizeModelAutoCompactTokenLimits, isReasoningEffort,
    normalizeReasoningEffortOptions, selectedReasoningEfforts, reasoningSelectionEffort,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    writeSettingsFile, readLocalCodexConfig: async () => null, validateCodexAutoCompactTokenLimit: () => {},
    pruneSavedBackgroundMedia: async () => {}, BrowserWindow: { getAllWindows: () => [] }, setNetworkProxy: vi.fn(),
    APP_SETTING_KEYS: ['darkMode', 'closeBehavior', 'javaPreferences']
  })
  for (const name of ['settingsFile', 'normalizeNetworkProxyUrl', 'normalizeJavaPreferences', 'readSettings',
    'writeAgentSettingsAtomically', 'saveAgentSettings', 'publicAgentSettings', 'applyAppSettingWrite', 'writeStoredBeginnerAiPreferences']) {
    vm.runInContext(ts.transpileModule(original(name), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  }
  state.beginnerAiPreferencesFile = () => path.join(root, 'beginner-ai-preferences.json')
  vm.runInContext(ts.transpileModule(`globalThis.saveIpc = (${original('settings:saveAgent', true)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return { state, root, target, initial, raw: async () => JSON.parse(await fs.readFile(target, 'utf8')) }
}

describe('settings persistence audit regressions', () => {
  it('AUD034 keeps a completed MCP change when UI saves an unrelated patch through the original IPC', async () => {
    const { state, raw } = await fixture()
    await state.applyAppSettingWrite({ key: 'closeBehavior', value: 'quit' })
    await state.saveIpc({}, { darkMode: true })
    expect(await raw()).toMatchObject({ closeBehavior: 'quit', darkMode: true })
    expect(await raw()).toHaveProperty('encryptedAgentKeys.codex')
    expect((await raw()).externalAgents.codex).not.toHaveProperty('apiKey')
  })

  it('AUD034 merges separate nested Java and model preferences in write order', async () => {
    const { state, raw } = await fixture()
    await Promise.all([
      state.saveIpc({}, { javaPreferences: { game: 'game-jdk' }, externalAgents: { codex: { modelContextWindows: { a: 4096 } } } }),
      state.saveIpc({}, { javaPreferences: { build: 'build-jdk' }, externalAgents: { codex: { modelContextWindows: { b: 8192 } } } })
    ])
    expect(await raw()).toMatchObject({ javaPreferences: { game: 'game-jdk', build: 'build-jdk' }, externalAgents: { codex: { modelContextWindows: { a: 4096, b: 8192 } } } })
  })

  it.each(['EPERM', 'EEXIST', 'EACCES'])('AUD108 preserves old main and AI settings when rename fails with %s', async code => {
    const { state, target, root } = await fixture()
    const beginner = state.beginnerAiPreferencesFile()
    await fs.writeFile(beginner, '{"model":"old-model"}')
    const old = await fs.readFile(target)
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error(code), { code }))
    await expect(state.writeAgentSettingsAtomically({ darkMode: true })).rejects.toMatchObject({ code })
    await expect(state.writeStoredBeginnerAiPreferences({ model: 'new-model' })).rejects.toMatchObject({ code })
    expect(await fs.readFile(target)).toEqual(old)
    expect(await fs.readFile(beginner, 'utf8')).toBe('{"model":"old-model"}')
    expect((await fs.readdir(root)).sort()).toEqual(['beginner-ai-preferences.json', 'settings.json'])
  })

  it('AUD108 preserves old bytes after a partial temporary write failure and permits retry', async () => {
    const { target } = await fixture()
    const old = await fs.readFile(target)
    const realWrite = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await realWrite(args[0], '{partial', args[2])
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    await expect(writeSettingsFile(target, { darkMode: true })).rejects.toThrow('disk full')
    expect(await fs.readFile(target)).toEqual(old)
    await writeSettingsFile(target, { darkMode: true })
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ darkMode: true })
  })

  it('AUD109 rejects read I/O errors while allowing fallback startup; original file and key stay intact', async () => {
    const { state, target, raw } = await fixture()
    const old = await fs.readFile(target)
    state.fs.readFile = async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }) }
    expect(await state.readSettings()).toHaveProperty('codingBackend', 'quota')
    await expect(state.saveIpc({}, { darkMode: true })).rejects.toThrow('已保留原文件')
    expect(await fs.readFile(target)).toEqual(old)
    state.fs.readFile = fs.readFile
    await state.saveIpc({}, { darkMode: true })
    expect(await raw()).toHaveProperty('encryptedAgentKeys.codex')
  })

  it.each(['{broken', 'null', '[]', '"wrong-shape"'])('AUD109 rejects corrupt JSON or non-object config without overwriting it: %s', async content => {
    const { state, target } = await fixture()
    await fs.writeFile(target, content)
    await expect(state.saveIpc({}, { darkMode: true })).rejects.toThrow('已保留原文件')
    expect(await fs.readFile(target, 'utf8')).toBe(content)
  })

  it('AUD109 rejects failure reading the existing encrypted fields after a successful initial read', async () => {
    const { state, target } = await fixture()
    const old = await fs.readFile(target)
    let reads = 0
    state.fs.readFile = async (...args: Parameters<typeof fs.readFile>) => {
      if (++reads === 2) throw Object.assign(new Error('I/O failure'), { code: 'EIO' })
      return fs.readFile(...args)
    }
    await expect(state.saveIpc({}, { darkMode: true })).rejects.toThrow('已保留原文件')
    expect(await fs.readFile(target)).toEqual(old)
  })

  it('creates settings on first use, reads from a fresh context, and recovers the queue after failure', async () => {
    const { state, target } = await fixture()
    await fs.rm(target)
    await state.saveIpc({}, { darkMode: true })
    const fresh: any = vm.createContext({ ...state })
    vm.runInContext(ts.transpileModule(original('readSettings'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, fresh)
    expect(await fresh.readSettings()).toHaveProperty('darkMode', true)
    state.writeAgentSettingsAtomically = vi.fn().mockRejectedValueOnce(new Error('write failure')).mockImplementationOnce((value: unknown) => writeSettingsFile(target, value))
    await expect(state.saveIpc({}, { darkMode: false })).rejects.toThrow('write failure')
    await state.saveIpc({}, { notificationsEnabled: false })
    expect(await fresh.readSettings()).toMatchObject({ darkMode: true, notificationsEnabled: false })
  })
})
