import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type builtinCatalog from './codexBuiltinModels.json'
import { readModelDataOrEmpty } from './modelData'
import { resolveModelContextBudget, UNKNOWN_MODEL_CONTEXT, type ModelBudgetOptions } from './modelContextRegistry'
import type { ModelReasoningCapabilities } from '../shared/types'
import { validModelContext } from '../shared/modelContext'
interface CatalogOptions extends ModelBudgetOptions { reasoning?: ModelReasoningCapabilities }

// Snapshot of the managed 0.154.0 runtime, including its original instructions.
// model_catalog_json REPLACES the built-in catalog; always retain these entries.
export const CODEX_MODEL_CATALOG_VERSION = '0.154.0'

/** Default working budget for unknown models, not a provider capacity claim. */
export const THIRD_PARTY_CONTEXT_BUDGET = UNKNOWN_MODEL_CONTEXT

type BuiltinCatalog = typeof builtinCatalog
/**
 * A catalog entry is either a native runtime entry or one ModMind derives for a
 * third-party model, so only the fields consumers rely on are declared here.
 */
export interface CodexModelEntry {
  slug: string
  display_name: string
  description?: string
  context_window?: number
  max_context_window?: number
  auto_compact_token_limit?: number | null
  default_reasoning_level?: string | null
  supported_reasoning_levels?: unknown[]
  apply_patch_tool_type?: string | null
  input_modalities?: string[]
  [key: string]: unknown
}
export interface CodexModelCatalogDocument { models: CodexModelEntry[] }

const BUILTIN_PATH = 'src/main/codexBuiltinModels.json'
const EMPTY_BUILTIN = { models: [] } as unknown as BuiltinCatalog

/** The bundled runtime catalog is read on first use, never at import time. */
export function builtinCodexModels(): CodexModelEntry[] {
  return readModelDataOrEmpty<BuiltinCatalog>(BUILTIN_PATH, '内置 Codex 模型目录', EMPTY_BUILTIN).models
}

function effectiveModelEntry(model: string, options: ModelBudgetOptions) {
  return buildCodexModelCatalog(model, options)?.models.find(entry => entry.slug === model)
    ?? builtinCodexModels().find(entry => entry.slug === model)
}

/** Share the runtime's actual catalog/window check with settings validation. */
export function validateCodexAutoCompactTokenLimit(model: string, options: ModelBudgetOptions, limit?: number): void {
  if (limit === undefined) return
  if (!validModelContext(limit)) throw new Error('自动压缩阈值必须是 1,024–100,000,000 之间的整数')
  const window = effectiveModelEntry(model, options)?.context_window
  if (window && limit > Math.floor(window * 0.9)) {
    throw new Error(`自动压缩阈值不能超过当前模型上下文窗口的 90%（${Math.floor(window * 0.9).toLocaleString('zh-CN')} tokens）`)
  }
}

export function resolveCodexAutoCompactTokenLimit(model: string, options: ModelBudgetOptions, manualLimit?: number): number {
  validateCodexAutoCompactTokenLimit(model, options, manualLimit)
  if (manualLimit !== undefined) return manualLimit
  const entry = effectiveModelEntry(model, options)
  if (!entry?.context_window) throw new Error(`无法确定模型 ${model} 的自动压缩阈值`)
  // Native entries with a null limit use Codex's 90% default; custom entries
  // already carry ModMind's input/output-aware budget.
  const calculatedLimit = entry.auto_compact_token_limit ?? Math.floor(entry.context_window * 0.9)
  return options.allowLongerContext ? calculatedLimit : Math.min(calculatedLimit, resolveModelContextBudget(model, options).autoCompactTokenLimit)
}

export function buildCodexModelCatalog(model: string, options: CatalogOptions = {}): CodexModelCatalogDocument | undefined {
  const builtin = builtinCodexModels()
  const budget = resolveModelContextBudget(model, options)
  const exact = builtin.find(entry => entry.slug === model)
  const customizeNative = budget.source === 'override' || budget.source === 'provider' || budget.source === 'registry'
  if (exact && !customizeNative && !options.reasoning) return undefined

  // Codex recognizes dated/suffixed variants by prefix. Preserve those capabilities.
  const native = exact ?? [...builtin]
    .sort((a, b) => b.slug.length - a.slug.length)
    .find(entry => model.startsWith(`${entry.slug}-`) && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(entry.slug.length + 1)))
  const nativeBudget = native && customizeNative
    ? { context_window: budget.contextWindow, max_context_window: budget.contextWindow, auto_compact_token_limit: budget.autoCompactTokenLimit } : {}
  const custom = native ? { ...native, ...nativeBudget, slug: model, display_name: exact ? native.display_name : model } : {
    slug: model,
    display_name: model,
    description: budget.source === 'inferred'
      ? `Estimated context window inherited from ${budget.inferredProvider}/${budget.inferredFrom}`
      : 'Third-party model through the ModMind provider',
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
    max_context_window: budget.contextWindow,
    auto_compact_token_limit: budget.autoCompactTokenLimit,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    // This enables transport, not a provider capability claim. Names and aliases
    // cannot establish lack of vision; let the upstream validate image support.
    input_modalities: ['text', 'image']
  }
  const reasoningMetadata = options.reasoning ? {
    default_reasoning_level: null,
    supported_reasoning_levels: options.reasoning.efforts.map(effort => ({ effort, description: effort }))
  } : {}
  return { models: [...builtin.filter(entry => entry.slug !== model), { ...custom, ...reasoningMetadata }] }
}

/** Content-addressed files make every distinct configuration immutable and race-free. */
export async function writeCodexModelCatalog(home: string, catalog: CodexModelCatalogDocument | undefined): Promise<{ path?: string; changed: boolean }> {
  if (!catalog) return { changed: false }
  const content = JSON.stringify(catalog)
  const hash = createHash('sha256').update(content).digest('hex')
  const directory = path.resolve(home, 'model-catalogs')
  const catalogPath = path.join(directory, `${hash}.json`)
  if (await fs.readFile(catalogPath, 'utf8').catch(() => '') === content) return { path: catalogPath, changed: false }
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(catalogPath, content, 'utf8')
  await pruneModelCatalogs(directory, path.basename(catalogPath))
  return { path: catalogPath, changed: true }
}

export async function prepareCodexModelCatalog(home: string, model: string, options: CatalogOptions = {}): Promise<{ path?: string; changed: boolean }> {
  return writeCodexModelCatalog(home, buildCodexModelCatalog(model, options))
}

const MODEL_CATALOG_KEEP = 16
const CATALOG_FILE_PATTERN = /^[0-9a-f]{64}\.json$/

/** Switching models otherwise accumulates one immutable file per configuration. */
async function pruneModelCatalogs(directory: string, keepName: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const candidates: { name: string; mtime: number }[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !CATALOG_FILE_PATTERN.test(entry.name) || entry.name === keepName) continue
      try { candidates.push({ name: entry.name, mtime: (await fs.stat(path.join(directory, entry.name))).mtimeMs }) } catch { /* Vanished or locked; leave it for the next pass. */ }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    for (const entry of candidates.slice(MODEL_CATALOG_KEEP)) {
      await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => undefined)
    }
  } catch { /* Pruning must never block a model switch. */ }
}
