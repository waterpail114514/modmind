import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyWorkspace } from './verify-workspace.mjs'
import { mcpTestSource } from './mcp-test-source.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-workspace-'))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { example: '^1.0.0' } }))
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { version: '1.2.0' } } }))
  return root
}
async function dependency(root, version) {
  await fs.mkdir(path.join(root, 'node_modules/example'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules/example/package.json'), JSON.stringify({ version }))
}

test('rejects shared dependencies without changing their target', async t => {
  const root = await fixture(t)
  const target = path.join(root, 'shared-dependencies')
  await fs.mkdir(target)
  await fs.writeFile(path.join(target, 'keep.txt'), 'main workspace')
  const link = path.join(root, 'node_modules')
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyWorkspace(root), /Shared node_modules link/)
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'main workspace')
  await fs.unlink(link)
})

test('requires installed versions to match the local lock file', async t => {
  const root = await fixture(t)
  await assert.rejects(verifyWorkspace(root), /Dependencies are missing/)
  await dependency(root, '2.0.0')
  await assert.rejects(verifyWorkspace(root), /differs from package-lock/)
  await dependency(root, '1.2.0')
  await verifyWorkspace(root)
  await assert.rejects(verifyWorkspace(root, { mcp: true }), /setup:tests/)
})

test('MCP source pin matches both CI checkout steps', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  for (const workflow of ['build-macos.yml', 'release-macos.yml']) {
    const text = await fs.readFile(path.join(root, '.github/workflows', workflow), 'utf8')
    assert.ok(text.includes(`ref: ${mcpTestSource.revision}`), workflow)
  }
})
