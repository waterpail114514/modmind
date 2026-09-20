// Refresh the bundled, offline context limits. No credentials or model requests.
// Optional --models-dev <file> --litellm <file> inputs support reproducible snapshots.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const sources = [
  'https://models.dev/api.json',
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
]
const args = process.argv.slice(2)
async function load(flag, url) {
  const index = args.indexOf(flag)
  if (index >= 0 && !args[index + 1]) throw new Error(`Missing ${flag} file`)
  const response = index < 0 ? await fetch(url, { signal: AbortSignal.timeout(30_000) }) : undefined
  if (response && !response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const text = response ? await response.text() : await readFile(args[index + 1], 'utf8')
  return { data: JSON.parse(text), sha256: createHash('sha256').update(text).digest('hex') }
}
const [modelsDev, lite] = await Promise.all([load('--models-dev', sources[0]), load('--litellm', sources[1])])
const providers = {}
const tokens = value => Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000 ? value : null
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const endpoint = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.origin + url.pathname.replace(/\/$/, '') : undefined } catch { return undefined } }
const officialApis = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta', xai: 'https://api.x.ai/v1', mistral: 'https://api.mistral.ai/v1' }
function provider(id) { return providers[id] ??= { models: new Map() } }
for (const [providerId, entry] of Object.entries(modelsDev.data)) {
  if (!validId(providerId) || !entry.models) continue
  const target = provider(providerId)
  target.api = endpoint(entry.api ?? officialApis[providerId])
  target.docs = endpoint(entry.doc)
  for (const [id, model] of Object.entries(entry.models)) {
    if (!validId(id) || !model.modalities?.input?.includes('text') || !model.modalities?.output?.includes('text')) continue
    const context = tokens(model.limit?.context)
    if (!context) continue
    // Keep dated and retired models; do not guess dates or strip provider/version suffixes.
    target.models.set(id, [context, tokens(model.limit.input), tokens(model.limit.output), 0])
  }
}
for (const [id, model] of Object.entries(lite.data)) {
  if (!validId(id) || model.mode !== 'chat' || !validId(model.litellm_provider)) continue
  const input = tokens(model.max_input_tokens)
  if (!input) continue
  const target = provider(model.litellm_provider)
  // LiteLLM's max_tokens often means output. Never mistake it for context.
  // Input is a conservative working ceiling when a total context is unspecified.
  if (!target.models.has(id)) target.models.set(id, [input, input, tokens(model.max_output_tokens), 1])
}
const sorted = Object.fromEntries(Object.entries(providers).filter(([, p]) => p.models.size).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([id, p]) => [id, {
  ...(p.api ? { api: p.api } : {}), ...(p.docs ? { docs: p.docs } : {}),
  models: Object.fromEntries([...p.models].sort(([a], [b]) => a.localeCompare(b, 'en')))
}]))
const count = Object.values(sorted).reduce((sum, p) => sum + Object.keys(p.models).length, 0)
if (count < 1000) throw new Error(`Incomplete source data (${count} entries); registry was not replaced`)
const registry = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  sources: sources.map((url, i) => ({ url, sha256: [modelsDev, lite][i].sha256, license: 'MIT' })),
  // Tuple layout keeps thousands of provider/model variants small and diffable.
  columns: ['context', 'input', 'output', 'source'], providers: sorted
}
// One model per line keeps release updates reviewable without verbose tuple arrays.
const text = JSON.stringify(registry, null, 2).replace(/\[\s*(\d+),\s*(\d+|null),\s*(\d+|null),\s*([01])\s*\]/g, '[$1,$2,$3,$4]') + '\n'
await writeFile(new URL('../src/main/modelContextRegistry.json', import.meta.url), text)
console.log(`Saved ${count} provider/model entries (${Object.keys(sorted).length} providers), ${Buffer.byteLength(text)} bytes`)
