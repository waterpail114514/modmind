import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sevenZip from '7zip-bin'
import { gradleWrapperChecksums, verifyGradleWrapperAssets, verifyInstallerGradleWrapper } from './verify-gradle-wrapper.mjs'

const repository = path.resolve(import.meta.dirname, '..')
const vendored = path.join(repository, 'vendor/gradle-wrapper')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`)
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-wrapper-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const assets = path.join(root, 'resources/gradle-wrapper')
  await fs.mkdir(assets, { recursive: true })
  for (const name of Object.keys(gradleWrapperChecksums)) {
    await fs.copyFile(path.join(vendored, name), path.join(assets, name))
  }
  return { root, assets }
}

test('vendored Wrapper assets retain the exact upstream bytes', async () => {
  assert.equal((await verifyGradleWrapperAssets(vendored)).length, 3)
})

for (const name of ['gradlew', 'gradlew.bat']) {
  test(`rejects CRLF conversion of ${name} before building`, async (t) => {
    const f = await fixture(t)
    const file = path.join(f.assets, name)
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\n/g, '\r\n'))
    await assert.rejects(verifyGradleWrapperAssets(f.assets), new RegExp(`verification failed: ${name.replace('.', '\\.')}`))
  })
}

test('rejects a damaged Wrapper JAR', async (t) => {
  const f = await fixture(t)
  await fs.appendFile(path.join(f.assets, 'gradle-wrapper.jar'), 'corrupt')
  await assert.rejects(verifyGradleWrapperAssets(f.assets), /verification failed: gradle-wrapper\.jar/)
})

test('rejects a missing Wrapper asset', async (t) => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.assets, 'gradlew.bat'))
  await assert.rejects(verifyGradleWrapperAssets(f.assets), /ENOENT/)
})

test('verifies the installer payload independently of healthy source files', async (t) => {
  const f = await fixture(t)
  const good = path.join(f.root, 'valid installer.exe')
  run(sevenZip.path7za, ['a', '-t7z', good, 'resources'], f.root)
  assert.equal(verifyInstallerGradleWrapper(good).length, 3)

  const script = path.join(f.assets, 'gradlew')
  await fs.writeFile(script, (await fs.readFile(script, 'utf8')).replace(/\n/g, '\r\n'))
  const bad = path.join(f.root, 'broken installer.exe')
  run(sevenZip.path7za, ['a', '-t7z', bad, 'resources'], f.root)
  assert.throws(() => verifyInstallerGradleWrapper(bad), /verification failed: gradlew/)
  assert.equal((await verifyGradleWrapperAssets(vendored)).length, 3)
})

test('rejects an installer missing a bundled script', async (t) => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.assets, 'gradlew.bat'))
  const installer = path.join(f.root, 'missing script.exe')
  run(sevenZip.path7za, ['a', '-t7z', installer, 'resources'], f.root)
  assert.throws(() => verifyInstallerGradleWrapper(installer), /verification failed: gradlew\.bat/)
})

test('Git checkout preserves Wrapper hashes with core.autocrlf=true', async (t) => {
  const f = await fixture(t)
  const source = path.join(f.root, 'vendor/gradle-wrapper')
  const checkout = path.join(f.root, 'checkout')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(checkout)
  await fs.copyFile(path.join(repository, '.gitattributes'), path.join(f.root, '.gitattributes'))
  for (const name of Object.keys(gradleWrapperChecksums)) {
    await fs.copyFile(path.join(vendored, name), path.join(source, name))
  }
  run('git', ['init', '--quiet'], f.root)
  run('git', ['-c', 'core.autocrlf=true', 'add', '.gitattributes', 'vendor'], f.root)
  run('git', ['-c', 'core.autocrlf=true', 'checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`], f.root)
  assert.equal((await verifyGradleWrapperAssets(path.join(checkout, 'vendor/gradle-wrapper'))).length, 3)
})
