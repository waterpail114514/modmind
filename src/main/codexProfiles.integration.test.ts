import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { sameApiBaseUrl } from '../shared/apiConnection'
import { mergeAgentSettingsPatch } from '../shared/agentSettingsPatch'
import { normalizeModelContextWindows, normalizeDeclaredModelContextWindows, normalizeModelAutoCompactTokenLimits } from '../shared/modelContext'
import { isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts, reasoningSelectionEffort } from '../shared/modelReasoning'
import { codexProfileConfiguration, normalizeCodexProfile, synchronizeCodexProfiles } from './codexProfiles'
import { validateCodexAutoCompactTokenLimit } from './codexModelCatalog'
import { orderModelsForAgent, parseModelPayload } from './deviceIntegration'
import { ExternalAgentContextWindowError } from './agentContextWindow'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { ProjectInfo } from '../shared/types'

const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
function fixture(initial: any = {}) {
  let disk = structuredClone(initial)
  const writes: any[] = []
  const state: any = vm.createContext({
    Buffer, URL, AbortSignal, console, LEGACY_CODEX_PROFILE_ID: 'legacy-codex',
    fs: { readFile: async () => JSON.stringify(disk) }, settingsFile: () => 'synthetic.json',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (key: string) => Buffer.from(key), decryptString: (key: Buffer) => key.toString() },
    normalizeModelContextWindows, normalizeDeclaredModelContextWindows, normalizeModelAutoCompactTokenLimits,
    sameApiBaseUrl, mergeAgentSettingsPatch, normalizeCodexProfile, synchronizeCodexProfiles, codexProfileConfiguration,
    isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts, reasoningSelectionEffort, validateCodexAutoCompactTokenLimit,
    normalizeAppearance: () => ({}), normalizeAgentApprovalMode: (value: unknown) => value,
    normalizeJavaPreferences: (value: unknown) => value, normalizeNetworkProxyUrl: (value: unknown) => value,
    app: { getPath: () => '/synthetic' }, BrowserWindow: { getAllWindows: () => [] }, pruneSavedBackgroundMedia: async () => {},
    writeAgentSettingsAtomically: vi.fn(async (next: any) => { disk = JSON.parse(JSON.stringify(next)); writes.push(structuredClone(disk)) }),
    agentSettingsWriteTail: Promise.resolve(), readLocalCodexConfig: async () => null,
    ExternalAgentContextWindowError, randomUUID: () => 'synthetic-id', orderModelsForAgent, parseModelPayload,
    networkFetch: fetch, modelReasoningCatalog: { refresh: async () => {}, enrich: (models: unknown) => models },
    quotaConfiguration: { current: () => 1 }, scannedModelCapabilities: new Map(), quotaPreferenceKey: (base: string) => base,
    APP_SETTING_KEYS: [], detectInstalledCodex: async () => ({ installed: true })
  })
  const names = ['readSettings', 'saveAgentSettings', 'normalizeApiBaseUrl', 'publicAgentSettings', 'configureExternalAgentConnection', 'manageCodexProfiles', 'testCodexProfileConnection', 'probeCodexConnection', 'discoverAvailableModels', 'adoptDeclaredContextWindow', 'scanConfiguredCodex', 'adaptContextWindowAfterOverflow', 'applyAppSettingWrite']
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n')
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  const save = (id: string, url = `https://${id}.example/v1`, key = `${id}-synthetic-key`) => state.manageCodexProfiles({ action: 'save', profile: { id, name: id, mode: 'hosted', baseUrl: url, model: 'm', reasoningEffort: 'high', apiKey: key } })
  return { state, save, writes, disk: () => structuredClone(disk) }
}

describe('custom API profile transactions and discovery', () => {
  it('rotates and clears both copies of the key without carrying it to another endpoint', async () => {
    const { state, save, disk } = fixture()
    await save('a')
    await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://a.example/v1', model: 'm', apiKey: 'replacement' })
    expect((await state.readSettings()).externalAgents.codex.apiKey).toBe('replacement')
    expect(Buffer.from(disk().encryptedAgentKeys['codex:a'], 'base64').toString()).toBe('replacement')
    await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://a.example/v1', model: 'm', clearApiKey: true })
    expect((await state.readSettings()).externalAgents.codex.apiKey).toBe('')
    await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://a.example/v1', model: 'm', apiKey: 'replacement' })
    await state.configureExternalAgentConnection('codex', { mode: 'hosted', baseUrl: 'https://other.example/v1', model: 'm' })
    expect((await state.readSettings()).externalAgents.codex.apiKey).toBe('')
    expect(disk().encryptedAgentKeys?.codex).toBeUndefined()
    expect(disk().encryptedAgentKeys?.['codex:a']).toBeUndefined()
  })
  it('switches endpoint and key in one write and round-trips reasoning preferences', async () => {
    const { state, save, writes } = fixture()
    await save('a'); await save('b'); writes.length = 0
    await state.manageCodexProfiles({ action: 'activate', id: 'b' })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ activeCodexProfileId: 'b', externalAgents: { codex: { baseUrl: 'https://b.example/v1', reasoningEffort: 'high' } } })
    expect(Buffer.from(writes[0].encryptedAgentKeys.codex, 'base64').toString()).toBe('b-synthetic-key')
    await state.manageCodexProfiles({ action: 'activate', id: 'a' })
    expect((await state.readSettings()).externalAgents.codex.reasoningEffort).toBe('high')
  })
  it('keeps the former connection after disk failure and permits retry', async () => {
    const { state, save, disk } = fixture()
    await save('a'); await save('b'); const before = disk()
    state.writeAgentSettingsAtomically.mockRejectedValueOnce(new Error('disk full'))
    await expect(state.manageCodexProfiles({ action: 'activate', id: 'b' })).rejects.toThrow('disk full')
    expect(disk()).toEqual(before)
    await state.manageCodexProfiles({ action: 'activate', id: 'b' })
    expect(disk().activeCodexProfileId).toBe('b')
  })
  it('deletes keys and never resurrects the last removed connection', async () => {
    const { state, save, disk } = fixture()
    await save('a'); await save('b')
    await state.manageCodexProfiles({ action: 'delete', id: 'a' })
    expect(disk().encryptedAgentKeys['codex:a']).toBeUndefined()
    expect((await state.readSettings()).externalAgents.codex.baseUrl).toBe('https://b.example/v1')
    await state.manageCodexProfiles({ action: 'delete', id: 'b' })
    await state.saveAgentSettings({ darkMode: true })
    expect((await state.readSettings()).codexProfiles).toEqual([])
    expect(disk().encryptedAgentKeys).toBeUndefined()
  })
  it('migrates old credentials while invalid historical thresholds do not block theme edits', async () => {
    const { state, disk } = fixture({ externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://legacy.example/v1', model: 'm', modelContextWindows: { m: 65536 }, modelAutoCompactTokenLimits: { m: 100000 }, reasoningEffort: 'high' } }, encryptedAgentKeys: { codex: Buffer.from('legacy-key').toString('base64') } })
    await state.saveAgentSettings({ darkMode: true })
    expect(disk().darkMode).toBe(true)
    expect(disk().codexProfiles[0].reasoningEffort).toBe('high')
    expect(disk().encryptedAgentKeys['codex:legacy-codex']).toBe(disk().encryptedAgentKeys.codex)
  })
  it('rejects saved-key reuse at a different origin or tenant path before sending a request', async () => {
    const { state, save } = fixture(); await save('a'); state.probeCodexConnection = vi.fn()
    for (const baseUrl of ['https://b.example/v1', 'https://a.example/other']) expect(await state.testCodexProfileConnection({ id: 'a', baseUrl })).toMatchObject({ ok: false, failureKind: 'credential-required' })
    expect(state.probeCodexConnection).not.toHaveBeenCalled()
  })
  it('migrates shared-key storage before creating the profile list', async () => {
    const { state, disk } = fixture({ externalAgentProvider: 'codex', baseUrl: 'https://legacy.example/v1', model: 'm', encryptedKey: Buffer.from('old-shared-key').toString('base64') })
    expect((await state.readSettings()).codexProfiles[0].id).toBe('legacy-codex')
    await state.saveAgentSettings({ darkMode: true })
    expect((await state.readSettings()).externalAgents.codex.apiKey).toBe('old-shared-key')
    expect(disk().encryptedAgentKeys['codex:legacy-codex']).toBe(disk().encryptedAgentKeys.codex)
    expect(disk().encryptedKey).toBeUndefined()
  })
  it('tests real HTTP through discovery, selecting chat models and keeping the saved URL', async () => {
    const headers: Array<string | undefined> = []
    const server = createServer((request, response) => {
      headers.push(request.headers.authorization); response.setHeader('Content-Type', 'application/json')
      if (request.url !== '/v1/models') { response.statusCode = 404; response.end('{}'); return }
      response.end(JSON.stringify({ data: [{ id: 'baai/bge-m3' }, { id: 'z-chat', supported_parameters: ['tools'] }] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { state, save } = fixture(), baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      await save('a', baseUrl)
      expect(await state.testCodexProfileConnection({ id: 'a', baseUrl })).toMatchObject({ ok: true, models: ['z-chat'] })
      expect(headers.every(header => header === 'Bearer a-synthetic-key')).toBe(true)
      expect((await state.readSettings()).externalAgents.codex.baseUrl).toBe(baseUrl)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('refreshes only-output changes and removes declarations missing from the next catalog', async () => {
    const { state, save } = fixture(); await save('a')
    for (const output of [8192, 32768]) await state.adoptDeclaredContextWindow([{ id: 'm', declaredContextWindow: 65536, declaredMaxOutputTokens: output }], (await state.readSettings()).externalAgents.codex)
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextOutputTokens.m).toBe(32768)
    await state.adoptDeclaredContextWindow([{ id: 'm' }], (await state.readSettings()).externalAgents.codex)
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextWindows).toBeUndefined()
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextOutputTokens).toBeUndefined()
  })
  it('rejects late scan results after switching and after key rotation', async () => {
    const { state, save } = fixture(); await save('a'); await save('b')
    const a = (await state.readSettings()).externalAgents.codex
    await state.manageCodexProfiles({ action: 'activate', id: 'b' })
    await state.adoptDeclaredContextWindow([{ id: 'm', declaredContextWindow: 65536 }], a)
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextWindows).toBeUndefined()
    const b = (await state.readSettings()).externalAgents.codex
    await state.configureExternalAgentConnection('codex', { ...b, apiKey: 'rotated' })
    await state.adoptDeclaredContextWindow([{ id: 'm', declaredContextWindow: 65536 }], b)
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextWindows).toBeUndefined()
  })
  it('rechecks thresholds changed during discovery without persisting an invalid budget', async () => {
    const { state, save, disk } = fixture(); await save('a')
    const snapshot = (await state.readSettings()).externalAgents.codex
    await state.saveAgentSettings({ externalAgents: { codex: { modelAutoCompactTokenLimits: { m: 200000 } } } })
    expect((await state.adoptDeclaredContextWindow([{ id: 'm', declaredContextWindow: 65536 }], snapshot)).warning).toContain('压缩阈值冲突')
    expect(disk().externalAgents.codex.declaredModelContextWindows).toBeUndefined()
    expect(disk().externalAgents.codex.modelAutoCompactTokenLimits.m).toBe(200000)
  })
  it('keeps declarations with their saved profile when switching away and back', async () => {
    const { state, save } = fixture(); await save('a')
    await state.adoptDeclaredContextWindow([{ id: 'm', declaredContextWindow: 65536 }], (await state.readSettings()).externalAgents.codex)
    await save('b'); await state.manageCodexProfiles({ action: 'activate', id: 'b' })
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextWindows).toBeUndefined()
    await state.manageCodexProfiles({ action: 'activate', id: 'a' })
    expect((await state.readSettings()).externalAgents.codex.declaredModelContextWindows.m).toBe(65536)
  })
  it('provides overflow recovery instructions without changing another saved connection', async () => {
    const { state, save, disk } = fixture(); await save('a'); await save('b')
    await state.manageCodexProfiles({ action: 'activate', id: 'b' }); const before = disk()
    const error = await state.adaptContextWindowAfterOverflow(new ExternalAgentContextWindowError('m', undefined, 65536, 'raw'), 'm')
    expect(error.message).toContain('新建会话'); expect(error.message).toContain('65,536')
    expect(disk()).toEqual(before); expect(error.message).not.toContain('已把')
  })
  it('reuses the existing MCP settings operation and refuses plaintext credentials', async () => {
    const { state, save } = fixture(); await save('a'); await save('b')
    const result = await state.applyAppSettingWrite({ key: 'codexConnection', value: { action: 'activate', id: 'b' } })
    expect(result.activeCodexProfileId).toBe('b'); expect(JSON.stringify(result)).not.toContain('synthetic-key')
    await expect(state.applyAppSettingWrite({ key: 'codexConnection', value: { action: 'save', profile: { id: 'b', apiKey: 'do-not-log-me' } } })).rejects.toThrow('不接收密钥')
  })
  it('discovers and invokes saved-connection operations over real stdio MCP, including read-only denial', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-profiles-mcp-'))
    const { state, save } = fixture(); await save('a'); await save('b')
    const project = { name: 'Profiles', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'profiles', createdAt: '' } as ProjectInfo
    const rpc = (child: ChildProcessWithoutNullStreams, id: number, method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => { child.stdout.off('data', onData); reject(new Error('MCP response timeout')) }, 10000)
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString()
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          const response = JSON.parse(line)
          if (response.id === id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(response) }
        }
      }
      child.stdout.on('data', onData)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    try {
      for (const readOnly of [false, true]) {
        const bridge = new ModMindBridge(project, { appSettingsRead: async () => state.publicAgentSettings(await state.readSettings()), appSettingsWrite: (input: Record<string, unknown>) => state.applyAppSettingWrite(input) } as ExternalAgentBridgeHandlers, 'profile-test', undefined, readOnly)
        let child: ChildProcessWithoutNullStreams | undefined
        try {
          const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
          const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
          child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          const listed = await rpc(child, 1, 'tools/list')
          const tool = listed.result.tools.find((entry: any) => entry.name === 'modmind_set_app_setting')
          expect(tool.inputSchema.properties.key.enum).toContain('codexConnection')
          const result = await rpc(child, 2, 'tools/call', { name: 'modmind_set_app_setting', arguments: { key: 'codexConnection', value: { action: 'activate', id: readOnly ? 'a' : 'b' } } })
          if (readOnly) expect(JSON.stringify(result)).toContain('只读')
          else {
            expect(result.result.isError).not.toBe(true)
            const back = await rpc(child, 3, 'tools/call', { name: 'modmind_get_app_settings', arguments: {} })
            expect(JSON.parse(back.result.content[0].text).activeCodexProfileId).toBe('b')
            expect(JSON.stringify(back)).not.toContain('synthetic-key')
          }
          expect((await state.readSettings()).activeCodexProfileId).toBe('b')
        } finally { child?.kill(); await bridge.stop() }
      }
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) }
  })
})
