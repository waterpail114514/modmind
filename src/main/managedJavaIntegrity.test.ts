import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MANAGED_JAVA_MANIFEST, validManagedJavaCache } from './managedJavaIntegrity'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-java-integrity-')); roots.push(home)
  await fs.mkdir(path.join(home, 'bin'))
  const bytes = Buffer.from('verified dll')
  await fs.writeFile(path.join(home, 'bin/runtime.dll'), bytes)
  const manifest = { files: { 'bin/runtime.dll': { type: 'file', downloads: { raw: { size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') } } } } }
  await fs.writeFile(path.join(home, MANAGED_JAVA_MANIFEST), JSON.stringify(manifest))
  return home
}
it('validates cached files offline and detects truncated or same-size corrupt DLLs after reuse', async () => {
  const home = await fixture()
  expect(await validManagedJavaCache(home)).toBe(true)
  await fs.writeFile(path.join(home, 'bin/runtime.dll'), 'corrupted!!!')
  expect(await validManagedJavaCache(home)).toBe(false)
  await fs.writeFile(path.join(home, 'bin/runtime.dll'), '')
  expect(await validManagedJavaCache(home)).toBe(false)
})
it('rejects missing manifest files and invalid cache manifests', async () => {
  const home = await fixture()
  await fs.rm(path.join(home, 'bin/runtime.dll'))
  expect(await validManagedJavaCache(home)).toBe(false)
  await fs.writeFile(path.join(home, MANAGED_JAVA_MANIFEST), 'invalid json')
  expect(await validManagedJavaCache(home)).toBe(false)
})
it('rejects empty native files in older installations without requiring network access', async () => {
  const home = await fixture()
  await fs.rm(path.join(home, MANAGED_JAVA_MANIFEST))
  expect(await validManagedJavaCache(home)).toBe(true)
  await fs.writeFile(path.join(home, 'bin/runtime.dll'), '')
  expect(await validManagedJavaCache(home)).toBe(false)
})
