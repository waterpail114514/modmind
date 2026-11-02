import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { normalizeAiModelSelection } from '../shared/aiSelection'
import { providerFixture } from './__fixtures__/providerSync'

// Exercise the actual IPC handler without booting Electron or using account credentials.
const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
function handlerSource(): string {
  let source = ''
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'diagnosticHandle' && node.arguments[0]?.getText(ast) === "'beginner-codex:prepare'") source = node.arguments[1].getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!source) throw new Error('Preparation IPC handler is missing')
  return ts.transpileModule(`globalThis.prepare = ${source}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
function harness() {
  const project = { path: path.resolve('test-project'), name: 'Preparation QA' }
  const serverConfig = { baseUrl: 'https://fixture.invalid/v1', model: 'qwen3.8-flash', apiKey: 'fixture-key' }
  const readConfig = vi.fn(async (_selection?: unknown) => serverConfig)
  const prepareRuntime = vi.fn(async (_project, _scope, progress, _signal, _override) => {
    progress({ stage: 'ready', title: '开发工具已就绪', status: 'success' })
    return { version: 'fixture', configChanged: false, configSource: 'device' }
  })
  const clear = vi.fn(), send = vi.fn()
  const context = vm.createContext({ path, currentProject: project, normalizeAiModelSelection, readProjectInfo: async () => project, readBeginnerAgentServerConfig: readConfig, prepareQuotaCodex: prepareRuntime, clearPreparedCodexCredentials: clear })
  vm.runInContext(handlerSource(), context)
  const event = { sender: { isDestroyed: () => false, send } }
  return { run: (selection?: unknown) => context.prepare(event, project.path, selection), readConfig, prepareRuntime, clear, send, project, serverConfig }
}

describe('workbench Codex preparation', () => {
  it('prepares the requested free route even when the default paid provider cannot list models', async () => {
    const h = harness(), f = providerFixture()
    f.listModels.mockImplementation(async connection => {
      if (connection.kind === 'paid') throw new Error('无法读取供应商模型列表')
      return (connection.models ?? []).map(id => ({ id }))
    })
    const selection = { backend: 'quota', model: 'qwen3.8-flash', account: 'trial:two', billing: 'free', reasoningLevel: 'auto' }
    h.readConfig.mockImplementation(async input => {
      const resolved = await f.service.resolve(input as Parameters<typeof f.service.resolve>[0])
      return { ...h.serverConfig, baseUrl: resolved.connection.inferenceBaseUrl, model: resolved.model }
    })
    await expect(h.run(selection)).resolves.toMatchObject({ ready: true })
    expect(f.listModels.mock.calls.map(([connection]) => connection.account)).toEqual(['trial:two'])
    expect(h.prepareRuntime.mock.calls[0][4]).toMatchObject({ model: selection.model, baseUrl: 'https://site.example/api/trial/v1' })
    expect(h.clear).toHaveBeenCalledOnce()
  })

  it('preserves the selected paid group and passes its verified config to runtime preparation', async () => {
    const h = harness()
    const selection = { model: 'gpt-6-astra', account: 'secondary', billing: 'quota', group: 'chosen-group', reasoningLevel: 'high' }
    await h.run(selection)
    expect(h.readConfig).toHaveBeenCalledExactlyOnceWith(selection)
    expect(h.prepareRuntime.mock.calls[0][4]).toBe(h.serverConfig)
    expect(h.send).toHaveBeenCalledWith('beginner-codex:progress', expect.objectContaining({ projectPath: h.project.path, status: 'success' }))
  })

  it('rejects unavailable providers, reports the project error and clears preparation credentials', async () => {
    const h = harness()
    h.readConfig.mockRejectedValueOnce(new Error('无法读取供应商模型列表（网络请求超时）'))
    await expect(h.run()).rejects.toThrow('网络请求超时')
    expect(h.prepareRuntime).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('beginner-codex:progress', expect.objectContaining({ projectPath: h.project.path, status: 'error', detail: expect.stringContaining('网络请求超时') }))
    expect(h.clear).toHaveBeenCalledOnce()
    await expect(h.run()).resolves.toMatchObject({ ready: true })
  })
})
