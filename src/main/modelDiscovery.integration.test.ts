import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { hasApiVersionPath, normalizeAiApiBase } from '../shared/apiConnection'
import { retryAfterDelay } from './networkRequest'
import { parseModelPayload } from './deviceIntegration'

function fixture(respond: (url: string) => Response | Promise<Response>) {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const state = {
    URL, Error, AbortSignal, parseModelPayload,
    networkFetch: vi.fn(async (url: string, init?: RequestInit) => { init?.signal?.throwIfAborted(); return respond(url) }),
    modelReasoningCatalog: { refresh: async () => {}, enrich: (models: unknown) => models },
    quotaConfiguration: { current: vi.fn(() => 0) },
    scannedModelCapabilities: new Map(), quotaPreferenceKey: (base: string, key: string) => `${base}:${key}`,
    normalizeAiApiBase, hasApiVersionPath, retryAfterDelay, delay,
    MODEL_SCAN_TOTAL_TIMEOUT_MS: 30_000, MODEL_SCAN_REQUEST_TIMEOUT_MS: 20_000, MODEL_SCAN_MAX_ATTEMPTS: 3,
    modelScanTasks: new Map(),
    discoverAvailableModels: undefined as unknown as (url: string, key: string, message: string, signal?: AbortSignal) => Promise<{ baseUrl: string; models: Array<{ id: string }> }>
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
  expect(state.networkFetch.mock.calls.map(([url]) => url)).toEqual(['https://provider.example/models', 'https://provider.example/model', 'https://provider.example/v1/models'])
})

it('retains a working unversioned endpoint without trying /v1', async () => {
  const state = fixture(models)
  expect((await state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).baseUrl).toBe('https://provider.example')
  expect(state.networkFetch).toHaveBeenCalledTimes(1)
})

it.each(['/v1', '/api/v1/', '/v2'])('does not append another version to %s', async suffix => {
  const state = fixture(() => new Response('', { status: 404 }))
  await expect(state.discoverAvailableModels(`https://provider.example${suffix}`, 'fixture', 'failed')).rejects.toThrow('failed')
  expect(state.networkFetch).toHaveBeenCalledTimes(2)
  expect(state.networkFetch.mock.calls.every(([url]) => !url.includes('/v1/v1') && !url.includes('/v2/v1'))).toBe(true)
})

it.each([401, 403])('does not mask HTTP %s errors with path retries', async status => {
  const state = fixture(() => new Response('', { status }))
  await expect(state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).rejects.toThrow(`HTTP ${status}`)
  expect(state.networkFetch).toHaveBeenCalledTimes(1)
})

it.each([429, 500])('retries HTTP %s before surfacing it', async status => {
  const state = fixture(() => new Response('', { status }))
  await expect(state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).rejects.toThrow(`HTTP ${status}`)
  expect(state.networkFetch).toHaveBeenCalledTimes(3)
})

it('honours Retry-After and recovers when a throttled provider starts answering', async () => {
  let calls = 0
  const state = fixture(() => {
    calls += 1
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : models()
  })
  await expect(state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).resolves.toMatchObject({ models: expect.arrayContaining([{ id: 'provider-first' }]) })
  expect(state.networkFetch).toHaveBeenCalledTimes(2)
})

it('shares one sweep between concurrent callers for the same endpoint', async () => {
  let release: (make: () => Response) => void = () => undefined
  const gate = new Promise<() => Response>(resolve => { release = resolve })
  const state = fixture(() => gate.then(make => make()))
  const first = state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')
  const second = state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')
  release(models)
  await expect(first).resolves.toMatchObject({ models: expect.arrayContaining([{ id: 'provider-first' }]) })
  await expect(second).resolves.toMatchObject({ models: expect.arrayContaining([{ id: 'provider-first' }]) })
  expect(state.networkFetch).toHaveBeenCalledTimes(1)
})

it('does not share a sweep across different endpoints', async () => {
  let release: (make: () => Response) => void = () => undefined
  const gate = new Promise<() => Response>(resolve => { release = resolve })
  const state = fixture(() => gate.then(make => make()))
  const first = state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')
  const second = state.discoverAvailableModels('https://other.example', 'fixture', 'failed')
  release(models)
  await Promise.all([first, second])
  expect(state.networkFetch).toHaveBeenCalledTimes(2)
})

it('stops probing before the first request once the caller cancels the scan', async () => {
  const state = fixture(() => new Promise<Response>(() => undefined))
  const controller = new AbortController()
  const pending = state.discoverAvailableModels('https://provider.example', 'fixture', 'failed', controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('模型列表读取已取消')
  expect(state.networkFetch).not.toHaveBeenCalled()
})

it('can recover when the unversioned path returns an HTML site instead of models', async () => {
  const state = fixture(url => url.endsWith('/v1/models') ? models() : new Response('<html>site</html>'))
  expect((await state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')).baseUrl).toBe('https://provider.example/v1')
})

it('caches the discovered models under both the original and resolved API paths', async () => {
  const state = fixture(url => url.endsWith('/v1/models') ? models() : new Response('', { status: 404 }))
  await state.discoverAvailableModels('https://provider.example', 'fixture', 'failed')
  expect([...state.scannedModelCapabilities.keys()]).toEqual(['https://provider.example:fixture', 'https://provider.example/v1:fixture'])
})
