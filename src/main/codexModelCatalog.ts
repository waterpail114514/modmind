import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import builtinCatalog from './codexBuiltinModels.json'
import { resolveModelContextBudget, UNKNOWN_MODEL_CONTEXT, type ModelBudgetOptions } from './modelContextRegistry'

// Snapshot of the managed 0.154.0 runtime, including its original instructions.
// model_catalog_json REPLACES the built-in catalog; always retain these entries.
export const CODEX_MODEL_CATALOG_VERSION = '0.154.0'

/** A conservative working budget, not a claim about the provider's maximum. */
export const THIRD_PARTY_CONTEXT_BUDGET = UNKNOWN_MODEL_CONTEXT

export function buildCodexModelCatalog(model: string, options: ModelBudgetOptions = {}) {
  const budget = resolveModelContextBudget(model, options)
  const exact = builtinCatalog.models.find(entry => entry.slug === model)
  const customizeNative = budget.source === 'override' || budget.source === 'provider' && exact && budget.contextWindow < exact.context_window
  if (exact && !customizeNative) return undefined

  // Codex recognizes dated/suffixed variants by prefix. Preserve those capabilities.
  const native = exact ?? [...builtinCatalog.models]
    .sort((a, b) => b.slug.length - a.slug.length)
    .find(entry => model.startsWith(`${entry.slug}-`) && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(entry.slug.length + 1)))
  const nativeBudget = native && (budget.source === 'override' || budget.source === 'provider' && budget.contextWindow < native.context_window)
    ? { context_window: budget.contextWindow, auto_compact_token_limit: budget.autoCompactTokenLimit } : {}
  const custom = native ? { ...native, ...nativeBudget, slug: model, display_name: model } : {
    slug: model,
    display_name: model,
    description: 'Third-party model through the ModMind provider',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'default',
    visibility: 'list',
    supported_in_api: true,
    priority: 100,
    base_instructions: [
      'You are a coding assistant working in ModMind with the user in a shared workspace.',
      'Follow the user instructions and project guidance. Inspect relevant files before editing.',
      'Use the available tools to complete the task, preserve unrelated changes, and verify your work.',
      'Report what changed, the validation performed, and any remaining limitations accurately.'
    ].join('\n'),
    // Do not advertise OpenAI-specific request parameters or code-mode tools.
    supports_reasoning_summaries: false,
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    prefer_websockets: false,
    use_responses_lite: false,
    apply_patch_tool_type: null,
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    context_window: budget.contextWindow,
    auto_compact_token_limit: budget.autoCompactTokenLimit,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    // Family names alone do not imply vision (e.g. deepseek-chat, qwen-coder).
    input_modalities: /(?:^|\/)(?:gemini-|grok-(?:4|2-vision)|qwen[^/]*-vl(?:-|:|$))/i.test(model)
      ? ['text', 'image'] : ['text']
  }
  return { models: [...builtinCatalog.models.filter(entry => entry.slug !== model), custom] }
}

export async function prepareCodexModelCatalog(home: string, model: string, options: ModelBudgetOptions = {}): Promise<{ path?: string; changed: boolean }> {
  const catalog = buildCodexModelCatalog(model, options)
  if (!catalog) return { changed: false }
  const content = JSON.stringify(catalog)
  // Immutable, content-addressed files avoid races between runs switching models.
  const hash = createHash('sha256').update(content).digest('hex')
  const catalogPath = path.resolve(home, 'model-catalogs', `${hash}.json`)
  if (await fs.readFile(catalogPath, 'utf8').catch(() => '') === content) return { path: catalogPath, changed: false }
  await fs.mkdir(path.dirname(catalogPath), { recursive: true })
  await fs.writeFile(catalogPath, content, 'utf8')
  return { path: catalogPath, changed: true }
}
