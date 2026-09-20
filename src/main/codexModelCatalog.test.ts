import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import builtinCatalog from './codexBuiltinModels.json'
import { CODEX_RUNTIME_VERSION } from './runtimeTarget'
import { buildCodexModelCatalog, CODEX_MODEL_CATALOG_VERSION, prepareCodexModelCatalog, THIRD_PARTY_CONTEXT_BUDGET } from './codexModelCatalog'
import { resolveModelContextBudget } from './modelContextRegistry'

describe('managed Codex model metadata', () => {
  it('pins the built-in catalog to the managed runtime', () => {
    expect(CODEX_MODEL_CATALOG_VERSION).toBe(CODEX_RUNTIME_VERSION)
    expect(builtinCatalog.models.some(model => model.slug === 'codex-auto-review')).toBe(true)
    for (const model of builtinCatalog.models) expect(buildCodexModelCatalog(model.slug)).toBeUndefined()
  })

  it.each(['grok-4', 'google/gemini-2.5-pro', 'deepseek-chat', 'qwen/qwen3-coder', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'custom-model'])('registers the exact upstream name %s while retaining native metadata', model => {
    const catalog = buildCodexModelCatalog(model)!
    expect(catalog.models.slice(0, -1)).toEqual(builtinCatalog.models)
    const budget = resolveModelContextBudget(model)
    expect(catalog.models.at(-1)).toMatchObject({
      slug: model, context_window: budget.contextWindow,
      auto_compact_token_limit: budget.autoCompactTokenLimit,
      supports_reasoning_summaries: false, support_verbosity: false,
      supports_parallel_tool_calls: false, apply_patch_tool_type: null
    })
  })

  it('uses the registry for large models, keeps legacy small limits and permits explicit private deployments', () => {
    expect(buildCodexModelCatalog('deepseek-v4-flash')!.models.at(-1)!.context_window).toBe(1_000_000)
    expect(buildCodexModelCatalog('gpt-4-0314')!.models.at(-1)!.context_window).toBe(8192)
    expect(buildCodexModelCatalog('custom-model')!.models.at(-1)!.context_window).toBe(THIRD_PARTY_CONTEXT_BUDGET)
    expect(buildCodexModelCatalog('private', { contextWindow: 524288 })!.models.at(-1)!.context_window).toBe(524288)
  })

  it('does not apply native capabilities to arbitrary lookalike suffixes', () => {
    expect(buildCodexModelCatalog('gpt-5.4-mini-private')!.models.at(-1)!.supports_reasoning_summaries).toBe(false)
  })

  it('overrides only the selected native model, retaining internal helper entries exactly', () => {
    const catalog = buildCodexModelCatalog('gpt-5.4-mini', { contextWindow: 65536 })!
    expect(catalog.models.filter(m => m.slug === 'gpt-5.4-mini')).toHaveLength(1)
    expect(catalog.models.find(m => m.slug === 'codex-auto-review')).toEqual(builtinCatalog.models.find(m => m.slug === 'codex-auto-review'))
    expect(catalog.models.at(-1)!.context_window).toBe(65536)
  })

  it('preserves the capabilities and instructions of native dated variants', () => {
    const base = builtinCatalog.models.find(model => model.slug === 'gpt-5.4-mini')!
    expect(buildCodexModelCatalog('gpt-5.4-mini-2026-03-17')!.models.at(-1)).toEqual({
      ...base, slug: 'gpt-5.4-mini-2026-03-17', display_name: 'gpt-5.4-mini-2026-03-17'
    })
  })

  it.each([
    ['gemini-2.5-pro', true], ['google/gemini-2.5-flash', true], ['grok-4', true],
    ['grok-3', false], ['deepseek-chat', false], ['qwen3-coder', false],
    ['qwen/qwen2.5-vl-72b-instruct', true], ['unknown-model', false]
  ])('does not infer vision from text-only family names: %s', (model, image) => {
    expect(buildCodexModelCatalog(model)!.models.at(-1)!.input_modalities).toEqual(image ? ['text', 'image'] : ['text'])
  })

  it('isolates model switches, skips identical writes and repairs corrupted catalogs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-model-catalog-'))
    try {
      const first = await prepareCodexModelCatalog(home, 'deepseek-chat')
      const second = await prepareCodexModelCatalog(home, 'gemini-2.5-pro')
      expect(first.changed).toBe(true)
      expect(second.path).not.toBe(first.path)
      expect(await prepareCodexModelCatalog(home, 'deepseek-chat')).toEqual({path: first.path, changed: false})
      expect(JSON.parse(await fs.readFile(first.path!, 'utf8')).models.at(-1).slug).toBe('deepseek-chat')
      await fs.writeFile(first.path!, '{broken')
      expect((await prepareCodexModelCatalog(home, 'deepseek-chat')).changed).toBe(true)
      expect(JSON.parse(await fs.readFile(first.path!, 'utf8')).models.at(-1).slug).toBe('deepseek-chat')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
