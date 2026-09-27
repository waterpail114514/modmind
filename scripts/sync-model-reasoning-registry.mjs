import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'

const flag = process.argv.indexOf('--models-dev')
if (flag >= 0 && !process.argv[flag + 1]) throw new Error('Missing --models-dev file')
const response = flag < 0 ? await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(30000) }) : undefined
if (response && !response.ok) throw new Error(`Metadata request failed: ${response.status}`)
const text = response ? await response.text() : await fs.readFile(process.argv[flag + 1], 'utf8')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-reasoning-sync-'))
try {
  const bundle = path.join(temporary, 'registry.cjs')
  await build({ entryPoints: ['src/shared/modelReasoningRegistry.ts'], outfile: bundle, platform: 'node', format: 'cjs', bundle: true })
  const { buildReasoningRegistry } = createRequire(import.meta.url)(bundle)
  const registry = buildReasoningRegistry(JSON.parse(text))
  const count = Object.values(registry.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0)
  if (count < 1000) throw new Error(`Incomplete reasoning catalog: ${count}`)
  await fs.writeFile(new URL('../src/main/modelReasoningRegistry.json', import.meta.url), JSON.stringify({ ...registry, sha256: createHash('sha256').update(text).digest('hex'), license: 'MIT' }) + '\n')
  console.log(`Saved ${count} reasoning capability records`)
} finally { await fs.rm(temporary, { recursive: true, force: true }) }
