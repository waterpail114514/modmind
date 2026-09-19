// Refresh the catalog snapshot from the version-pinned, verified managed executable.
// node scripts/sync-codex-model-catalog.mjs <path-to-managed-codex>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const executable = path.resolve(process.argv[2] || 'missing-codex-path')
const descriptors = JSON.parse(await readFile(new URL('../src/main/codexRuntimeDescriptors.json', import.meta.url), 'utf8'))
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
assert.equal(version.match(/\b\d+\.\d+\.\d+\b/)?.[0], descriptors.version, 'Use the managed runtime version')
const binary = (await readFile(executable)).toString('utf8')
const match = /\{\r?\n  "models": \[\r?\n/.exec(binary)
assert.ok(match, 'Embedded model catalog not found; inspect the new runtime before updating')
let depth = 0, inString = false, escaped = false, end = match.index
for (; end < binary.length; end++) {
  const char = binary[end]
  if (inString) {
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (char === '"') inString = false
  } else if (char === '"') inString = true
  else if (char === '{') depth++
  else if (char === '}' && --depth === 0) { end++; break }
}
const catalog = JSON.parse(binary.slice(match.index, end))
assert.ok(catalog.models.length && catalog.models.every(model => typeof model.slug === 'string'))
await writeFile(new URL('../src/main/codexBuiltinModels.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n')
console.log(`Saved ${catalog.models.length} models from ${version}. Update CODEX_MODEL_CATALOG_VERSION and run catalog tests and the runtime smoke test.`)
