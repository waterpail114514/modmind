import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import { validateQuiltServerLauncher } from './quiltServerLauncher'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(classpath = 'libraries/quilt.jar', mainPresent = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quilt-launcher-test-')); roots.push(root)
  await fs.mkdir(path.join(root, 'libraries'))
  const entry = 'org/quiltmc/loader/impl/launch/server/QuiltServerLauncher.class'
  await fs.writeFile(path.join(root, 'libraries/quilt.jar'), createStoredZip([{ name: mainPresent ? entry : 'Other.class', data: Buffer.from('fixture') }]))
  const launcher = path.join(root, 'quilt-server-launch.jar')
  await fs.writeFile(launcher, createStoredZip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from(`Manifest-Version: 1.0\r\nMain-Class: org.quiltmc.loader.impl.launch.server.QuiltServerLauncher\r\nClass-Path: ${classpath}\r\n\r\n`) }]))
  return launcher
}
it('accepts the official manifest-only launcher with a locally installed entry point', async () => {
  await expect(validateQuiltServerLauncher(await fixture())).resolves.toBeUndefined()
})
it('rejects a thin launcher whose entry point is absent', async () => {
  await expect(validateQuiltServerLauncher(await fixture(undefined, false))).rejects.toThrow('main class is missing')
})
it.each(['https://invalid.example/loader.jar', 'libraries/../../outside.jar', 'libraries/%2e%2e/outside.jar'])('rejects an escaping or remote classpath %s', async value => {
  await expect(validateQuiltServerLauncher(await fixture(value))).rejects.toThrow()
})
