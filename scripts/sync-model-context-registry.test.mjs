import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

test('refreshes known limits, keeps removed models with provenance, and rejects incomplete downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-registry-sync-'))
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
    await fs.mkdir(path.join(root, 'src/main'), { recursive: true })
    const script = path.join(root, 'scripts/sync.mjs')
    await fs.copyFile(new URL('./sync-model-context-registry.mjs', import.meta.url), script)
    const target = path.join(root, 'src/main/modelContextRegistry.json')
    const sources = [{ url: 'https://fixture.example/models', sha256: 'old', license: 'MIT' }]
    await fs.writeFile(target, JSON.stringify({ updatedAt: '2026-09-20', sources, providers: {
      official: { api: 'https://fixture.example/v1', models: { retained: [8192, null, 1024, 0], updated: [32768, null, 4096, 0] } }
    } }))
    const models = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`new-${i}`, { modalities: { input: ['text'], output: ['text'] }, limit: { context: 524288, output: 8192 } }]))
    models.updated = { modalities: { input: ['text'], output: ['text'] }, limit: { context: 1050000, input: 922000, output: 128000 } }
    const modelsDev = path.join(root, 'models.json'), lite = path.join(root, 'lite.json')
    await fs.writeFile(modelsDev, JSON.stringify({ official: { api: 'https://fixture.example/v1', models } }))
    await fs.writeFile(lite, '{}')
    const run = () => execFileSync(process.execPath, [script, '--models-dev', modelsDev, '--litellm', lite], { windowsHide: true, stdio: 'pipe' })
    run()
    const result = JSON.parse(await fs.readFile(target, 'utf8'))
    assert.deepEqual(result.providers.official.models.retained, [8192, null, 1024, 0])
    assert.deepEqual(result.providers.official.models.updated, [1050000, 922000, 128000, 0])
    assert.equal(Object.keys(result.providers.official.models).length, 1002)
    assert.deepEqual(result.retainedSnapshots, [{ updatedAt: '2026-09-20', sources }])
    const before = await fs.readFile(target, 'utf8')
    await fs.writeFile(modelsDev, '{}')
    assert.throws(run, /Incomplete source data/)
    assert.equal(await fs.readFile(target, 'utf8'), before)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
