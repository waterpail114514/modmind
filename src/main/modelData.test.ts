import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureModelDataRoot, loadModelData, preloadModelData, readModelDataOrEmpty, readModelDataSync } from './modelData'

const PROJECT_ROOT = process.cwd()
const CONTEXT_REGISTRY = 'src/main/modelContextRegistry.json'
const REASONING_REGISTRY = 'src/main/modelReasoningRegistry.json'
const BUILTIN_MODELS = 'src/main/codexBuiltinModels.json'

afterEach(() => {
  configureModelDataRoot(PROJECT_ROOT)
  vi.restoreAllMocks()
})

describe('bundled model data loading', () => {
  it('loads the shipped documents from the project root', () => {
    expect(readModelDataSync<{ providers: Record<string, unknown> }>(CONTEXT_REGISTRY).providers).toBeTruthy()
    expect(readModelDataSync<{ providers: Record<string, unknown> }>(REASONING_REGISTRY).providers).toBeTruthy()
    expect(readModelDataSync<{ models: unknown[] }>(BUILTIN_MODELS).models.length).toBeGreaterThan(0)
  })

  it('caches a document across callers and shares one in-flight read', async () => {
    const first = await loadModelData(CONTEXT_REGISTRY)
    const [second, third] = await Promise.all([loadModelData(CONTEXT_REGISTRY), loadModelData(CONTEXT_REGISTRY)])
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(readModelDataSync(CONTEXT_REGISTRY)).toBe(first)
  })

  it('resolves documents relative to the configured root', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-model-data-'))
    try {
      await fs.writeFile(path.join(directory, 'sample.json'), JSON.stringify({ ok: true }), 'utf8')
      configureModelDataRoot(directory)
      expect(readModelDataSync('sample.json')).toEqual({ ok: true })
      expect(await loadModelData('sample.json')).toEqual({ ok: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('degrades to the supplied fallback when a document is unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fallback = { providers: {} }
    expect(readModelDataOrEmpty('src/main/__missing__.json', '测试数据', fallback)).toBe(fallback)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed preload from surfacing as an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    preloadModelData(['src/main/__missing__.json'])
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
