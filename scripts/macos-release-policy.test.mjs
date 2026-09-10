import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { macArtifactNames, assertMacArchitecture, sha256 } from './macos-release-policy.mjs'

test('macOS release naming and architecture cannot silently fall back', () => {
  assert.deepEqual(macArtifactNames('1.4.4', 'arm64'), ['ModMind-1.4.4-arm64.dmg', 'ModMind-1.4.4-arm64.zip'])
  assert.throws(() => macArtifactNames('1.4.4', 'ia32'))
  assert.throws(() => assertMacArchitecture('x86_64 arm64', 'arm64'))
  assert.throws(() => assertMacArchitecture('x86_64', 'arm64'))
  assertMacArchitecture('x86_64\n', 'x64')
})
test('release SHA-256 matches the known vector', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-hash-'))
  try {
    const file = path.join(root, 'sample')
    await fs.writeFile(file, 'abc')
    assert.equal(await sha256(file), 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
