import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sevenZip from '7zip-bin'
import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { prepareUpdateArtifacts } from './prepare-update-artifacts.mjs'

async function fixture(t, version = '1.4.15') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-update-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const release = path.join(root, 'release')
  const update = path.join(release, 'update')
  const installer = path.join(release, `ModMind Setup ${version}.exe`)
  await fs.mkdir(release)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
  await fs.mkdir(path.join(root, 'resources'))
  await fs.writeFile(path.join(root, 'resources/service-config.json'), JSON.stringify({ updateUrl: 'https://updates.example/' }))
  await fs.writeFile(path.join(root, 'resources/app-update.yml'), 'provider: generic\nurl: https://updates.example/\nupdaterCacheDirName: modmind-updater\n')
  const packed = spawnSync(sevenZip.path7za, ['a', '-t7z', installer, 'resources'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000
  })
  assert.equal(packed.status, 0, packed.error?.message ?? packed.stderr)
  const installerBytes = await fs.readFile(installer)
  await fs.writeFile(`${installer}.blockmap`, Buffer.alloc(2048, 17))
  return { root, release, update, installer, installerBytes }
}

async function assertArtifacts(f, result, metadataName) {
  const text = await fs.readFile(path.join(f.update, metadataName), 'utf8')
  const metadata = parseUpdateInfo(text, metadataName, `https://updates.example/${metadataName}`)
  const [file] = resolveFiles(metadata, new URL('https://updates.example/'))
  assert.equal(metadata.version, result.version)
  assert.equal(file.url.href, `https://updates.example/ModMind-Setup-${result.version}.exe`)
  const staged = await fs.readFile(path.join(f.update, metadata.path))
  assert.deepEqual(staged, await fs.readFile(f.installer))
  assert.equal(metadata.files[0].size, staged.length)
  assert.equal(metadata.files[0].sha512, createHash('sha512').update(staged).digest('base64'))
  assert.equal(metadata.sha512, metadata.files[0].sha512)
  assert.equal(metadata.path, metadata.files[0].url)
  assert.equal(new Date(metadata.releaseDate).toISOString(), (await fs.stat(f.installer)).mtime.toISOString())
  assert.deepEqual(await fs.readFile(path.join(f.update, `${metadata.path}.blockmap`)), await fs.readFile(`${f.installer}.blockmap`))
  assert.equal(await fs.readFile(path.join(f.release, metadataName), 'utf8'), text)
  assert.deepEqual((await fs.readdir(f.update)).sort(), [...result.uploadFiles].sort())
  return metadata
}

test('fresh local build produces metadata accepted by electron-updater without builder YAML', async (t) => {
  const f = await fixture(t)
  const result = await prepareUpdateArtifacts(f.root)
  assert.equal(result.channel, 'stable')
  await assertArtifacts(f, result, 'latest.yml')
})

for (const staleVersion of ['1.4.14', '1.4.15']) {
  test(`regenerates stale ${staleVersion} metadata from current installer bytes`, async (t) => {
    const f = await fixture(t)
    await fs.writeFile(path.join(f.release, 'latest.yml'), `version: ${staleVersion}\npath: obsolete.exe\nsha512: stale\n`)
    const oldInstaller = path.join(f.release, 'ModMind Setup 1.4.14.exe')
    await fs.writeFile(oldInstaller, 'old installer')
    await fs.mkdir(f.update)
    await fs.writeFile(path.join(f.update, 'obsolete.exe'), 'old upload')
    await assertArtifacts(f, await prepareUpdateArtifacts(f.root), 'latest.yml')
    assert.equal(await fs.readFile(oldInstaller, 'utf8'), 'old installer')
    const firstMetadata = await fs.readFile(path.join(f.update, 'latest.yml'), 'utf8')
    await prepareUpdateArtifacts(f.root)
    assert.equal(await fs.readFile(path.join(f.update, 'latest.yml'), 'utf8'), firstMetadata)
    assert.deepEqual(await fs.readFile(f.installer), f.installerBytes)
  })
}

for (const version of ['1.4.16-beta.1', '1.4.16-rc.1']) {
  test(`${version} produces beta metadata and preserves the stable channel`, async (t) => {
    const f = await fixture(t, version)
    const stable = 'version: 1.4.15\npath: stable.exe\n'
    await fs.writeFile(path.join(f.release, 'latest.yml'), stable)
    const result = await prepareUpdateArtifacts(f.root)
    assert.equal(result.channel, 'beta')
    await assertArtifacts(f, result, 'beta.yml')
    assert.equal(await fs.readFile(path.join(f.release, 'latest.yml'), 'utf8'), stable)
  })
}

test('hyphens in build metadata do not change a stable version to beta', async (t) => {
  const f = await fixture(t, '1.4.15+build-local')
  const result = await prepareUpdateArtifacts(f.root)
  assert.equal(result.channel, 'stable')
  await assertArtifacts(f, result, 'latest.yml')
})

for (const failure of ['missing installer', 'empty installer', 'missing blockmap', 'small blockmap', 'directory blockmap', 'wrong version']) {
  test(`${failure} fails before replacing existing update files`, async (t) => {
    const f = await fixture(t)
    await fs.mkdir(f.update)
    await fs.writeFile(path.join(f.update, 'keep.txt'), 'previous upload')
    const metadata = 'version: 1.4.14\n'
    await fs.writeFile(path.join(f.release, 'latest.yml'), metadata)
    if (failure === 'missing installer') await fs.unlink(f.installer)
    if (failure === 'empty installer') await fs.writeFile(f.installer, '')
    if (failure === 'missing blockmap') await fs.unlink(`${f.installer}.blockmap`)
    if (failure === 'small blockmap') await fs.writeFile(`${f.installer}.blockmap`, 'incomplete')
    if (failure === 'directory blockmap') {
      await fs.unlink(`${f.installer}.blockmap`)
      await fs.mkdir(`${f.installer}.blockmap`)
    }
    if (failure === 'wrong version') await fs.writeFile(path.join(f.root, 'package.json'), '{"version":"1.4.16"}')
    await assert.rejects(prepareUpdateArtifacts(f.root), /ENOENT|missing|empty|too small/)
    assert.equal(await fs.readFile(path.join(f.update, 'keep.txt'), 'utf8'), 'previous upload')
    assert.equal(await fs.readFile(path.join(f.release, 'latest.yml'), 'utf8'), metadata)
  })
}

test('version cannot point outside the release directory', async (t) => {
  const f = await fixture(t)
  for (const version of ['../../outside', '..\\..\\outside']) {
    await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ version }))
    await assert.rejects(prepareUpdateArtifacts(f.root), /Unsafe update artifact version/)
  }
})

test('missing embedded update config blocks staging and preserves the previous update directory', async (t) => {
  const f = await fixture(t)
  const removed = spawnSync(sevenZip.path7za, ['d', f.installer, 'resources/app-update.yml'], {
    windowsHide: true, encoding: 'utf8', timeout: 30000
  })
  assert.equal(removed.status, 0, removed.error?.message ?? removed.stderr)
  await fs.mkdir(f.update)
  await fs.writeFile(path.join(f.update, 'keep.txt'), 'previous upload')
  await fs.writeFile(path.join(f.release, 'latest.yml'), 'previous metadata')
  await assert.rejects(prepareUpdateArtifacts(f.root), /Missing.*app-update\.yml/)
  assert.equal(await fs.readFile(path.join(f.update, 'keep.txt'), 'utf8'), 'previous upload')
  assert.equal(await fs.readFile(path.join(f.release, 'latest.yml'), 'utf8'), 'previous metadata')
})
