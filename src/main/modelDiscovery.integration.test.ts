import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { parseModelPayload } from './deviceIntegration'

function fixture(respond: (url: string) => Response) {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const state = {
    URL, Error, AbortSignal, parseModelPayload,
    fetch: vi.fn(async (url: string) => respond(url)),
    modelReasoningCatalog: { refresh: async () => {}, enrich: (models: unknown) => models },
    modelImageCapabilities: { enrich: async (models: unknown) => models },
    scannedModelCapabilities: new Map(), quotaPreferenceKey: (base: string, key: string) => `${base}:${key}`,
    discoverAvailableModels: undefined as unknown as (url: string, key: string, message: string) => Promise<{ baseUrl: string; models: Array<{ id: string }> }>
  }
  const names = ['normalizeApiBaseUrl', 'discoverAvailableModels']
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  vm.runInNewContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return state
}
const models = () => Response.json({ data: [{ id: 'provider-first' }, { id: 'provider-second' }] })

it('tries the supplied path first, then /v1 and returns the working base for persistence', async () => {
  const state = fixture(url => url.endsWith('/v1/models') ? models() : new Response('', { status: 404 }))
  expect(await state.discoverAvailableModels('https://provider.example/', 'fixture', 'failed')).toMatchObject({ baseUrl: 'https://provider.example/v1', models: [{ id: 'provider-first' }, { id: 'provider-second' }] })
  expect(state.fetch.mock.calls.map(([url]) => url)).toEqual(['https://provider.example/models', 'https://provider.example/model', 'https://provider.example/v1/models'])
})

it('retains a working unversioned endpoint without trying /v1', async () => {
  const state = fixture(models)
  expect((await state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).baseUrl).toBe('https://provider.example')
  expect(state.fetch).toHaveBeenCalledTimes(1)
})

it.each(['/v1', '/api/v1/', '/v2'])('does not append another version to %s', async suffix => {
  const state = fixture(() => new Response('', { status: 404 }))
  await expect(state.discoverAvailableModels(`https://provider.example${suffix}`, 'fixture', 'failed')).rejects.toThrow('failed')
  expect(state.fetch).toHaveBeenCalledTimes(2)
  expect(state.fetch.mock.calls.every(([url]) => !url.includes('/v1/v1') && !url.includes('/v2/v1'))).toBe(true)
})

it.each([401, 403, 429, 500])('does not mask HTTP %s errors with path retries', async status => {
  const state = fixture(() => new Response('', { status }))
  await expect(state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).rejects.toThrow(`HTTP ${status}`)
  expect(state.fetch).toHaveBeenCalledTimes(1)
})

it('can recover when the unversioned path returns an HTML site instead of models', async () => {
  const state = fixture(url => url.endsWith('/v1/models') ? models() : new Response('<html>site</html>'))
  expect((await state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).baseUrl).toBe('https://provider.example/v1')
})
