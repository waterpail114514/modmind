import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const source = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'discoverAvailableModels')!.getText(ast)
function harness() {
  const networkFetch = vi.fn(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  const context = vm.createContext({ URL, AbortSignal, networkFetch,
    normalizeApiBaseUrl: (base: string) => base.replace(/\/$/, ''),
    quotaConfiguration: { current: () => 1 }, scannedModelCapabilities: new Map(), quotaPreferenceKey: (base: string) => base,
    modelReasoningCatalog: { refresh: async () => {}, enrich: (models: unknown) => models },
    parseModelPayload: (payload: { data: unknown[] }) => payload.data ?? [],
    orderModelsForAgent: (models: unknown[]) => models
  })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { fetch: networkFetch, run: () => context.discoverAvailableModels('https://fixture.invalid/v1', 'do-not-expose-key', '无法读取供应商模型列表') }
}

describe('model discovery failure reasons', () => {
  it.each([
    [new DOMException('timeout', 'TimeoutError'), '网络请求超时'],
    [Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }), '无法解析供应商地址'],
    [Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), '供应商证书校验失败'],
    [new Error('request to secret-url?key=do-not-expose-key failed'), '网络连接失败']
  ])('reports a useful network reason without exposing credentials', async (failure, reason) => {
    const h = harness()
    h.fetch.mockRejectedValue(failure)
    const error = await h.run().catch((value: Error) => value)
    expect(error.message).toContain(reason)
    expect(error.message).not.toMatch(/do-not-expose-key|secret-url/)
  })

  it('explains missing endpoints after trying the supported singular and plural routes', async () => {
    const h = harness()
    h.fetch.mockResolvedValue(new Response('', { status: 404 }))
    await expect(h.run()).rejects.toThrow('模型列表接口不存在或不支持访问')
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 429, 503])('keeps HTTP %s failures explicit and does not try another route', async status => {
    const h = harness()
    h.fetch.mockResolvedValue(new Response('', { status }))
    await expect(h.run()).rejects.toThrow(`HTTP ${status}`)
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('keeps invalid JSON distinct from a missing endpoint', async () => {
    const h = harness()
    h.fetch.mockImplementation(async () => new Response('invalid JSON'))
    await expect(h.run()).rejects.toThrow('模型服务返回了无效数据')
  })

  it('still returns an explicitly empty model list without masking it as a network failure', async () => {
    const h = harness()
    h.fetch.mockImplementation(async () => Response.json({ data: [] }))
    await expect(h.run()).resolves.toMatchObject({ models: [] })
  })
})
