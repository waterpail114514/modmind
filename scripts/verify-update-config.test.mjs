import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { stringify } from 'yaml'
import sevenZip from '7zip-bin'
import { verifyInstallerUpdateConfig } from './verify-update-config.mjs'

const require = createRequire(import.meta.url)
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager')
const { getRepositoryInfo } = require('app-builder-lib/out/util/repositoryInfo')
const { Platform } = require('app-builder-lib/out/index')
const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
const repository = path.resolve(import.meta.dirname, '..')
const metadata = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'))
const services = JSON.parse(await fs.readFile(path.join(repository, 'resources/service-config.json'), 'utf8'))

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-update-config-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'resources'))
  return root
}

async function generatedConfig(root, version = '1.4.16') {
  // Use the real builder resolver with no repository fallback, as in a worktree
  // or downloaded source archive. Only the packager context is a fixture.
  const appInfo = { version, channel: version.includes('-') ? 'beta' : null, updaterCacheDirName: 'modmind-updater' }
  return getAppUpdatePublishConfiguration({
    info: { projectDir: root, config: metadata.build, appInfo, repositoryInfo: Promise.resolve(null) },
    config: metadata.build, platformSpecificBuildOptions: metadata.build.win,
    appInfo, platform: Platform.WINDOWS, isForceCodeSigningVerification: false,
    expandMacro: value => value
  }, 1, false)
}

async function pack(root, config, serviceUrl = services.updateUrl) {
  if (config !== null) await fs.writeFile(path.join(root, 'resources/app-update.yml'), stringify(config))
  await fs.writeFile(path.join(root, 'resources/service-config.json'), JSON.stringify({ updateUrl: serviceUrl }))
  const installer = path.join(root, 'fixture.exe')
  const result = spawnSync(sevenZip.path7za, ['a', '-t7z', installer, 'resources'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return installer
}

for (const layout of ['source archive', 'worktree']) {
  test(`builder generates a working updater config in a ${layout}`, async t => {
    const root = await fixture(t)
    if (layout === 'worktree') await fs.writeFile(path.join(root, '.git'), 'gitdir: /unavailable/main/.git/worktrees/build\n')
    assert.equal(await getRepositoryInfo(root, {}), null)
    const config = await generatedConfig(root)
    assert.equal(config.provider, 'generic')
    assert.equal(config.url, services.updateUrl)
    const installer = await pack(root, config)
    assert.equal(verifyInstallerUpdateConfig(installer, services.updateUrl).updaterCacheDirName, 'modmind-updater')

    const updater = new NsisUpdater(null, {
      version: '1.4.15', name: 'modmind', isPackaged: true,
      appUpdateConfigPath: path.join(root, 'resources/app-update.yml'),
      baseCachePath: path.join(root, 'cache'), userDataPath: path.join(root, 'profile')
    })
    updater.logger = null
    updater.setFeedURL({ provider: 'generic', url: services.updateUrl })
    const helper = await updater.getOrCreateDownloadHelper()
    assert.equal(helper.cacheDirForPendingUpdate, path.join(root, 'cache/modmind-updater/pending'))
  })
}

test('prerelease config retains the beta channel without repository discovery', async t => {
  const config = await generatedConfig(await fixture(t), '1.4.17-beta.1')
  assert.equal(config.channel, 'beta')
  assert.equal(config.provider, 'generic')
})

test('real updater reproduces ENOENT without embedded config even after setFeedURL', async t => {
  const root = await fixture(t)
  const updater = new NsisUpdater(null, {
    version: '1.4.15', name: 'modmind', isPackaged: true,
    appUpdateConfigPath: path.join(root, 'resources/app-update.yml'), baseCachePath: path.join(root, 'cache')
  })
  updater.logger = null
  updater.setFeedURL({ provider: 'generic', url: services.updateUrl })
  await assert.rejects(updater.getOrCreateDownloadHelper(), { code: 'ENOENT' })
})

for (const problem of ['missing', 'cache name', 'provider', 'insecure URL', 'embedded URL mismatch', 'release URL mismatch']) {
  test(`release verifier rejects ${problem}`, async t => {
    const root = await fixture(t)
    const config = await generatedConfig(root)
    if (problem === 'cache name') config.updaterCacheDirName = '../modmind'
    if (problem === 'provider') config.provider = 'github'
    if (problem === 'insecure URL') config.url = 'http://updates.example/'
    const installer = await pack(root, problem === 'missing' ? null : config,
      problem === 'embedded URL mismatch' ? 'https://wrong.example/' : services.updateUrl)
    // Healthy loose files cannot hide missing/broken bytes in the installer.
    await fs.writeFile(path.join(root, 'resources/app-update.yml'), stringify(await generatedConfig(root)))
    assert.throws(() => verifyInstallerUpdateConfig(installer,
      problem === 'release URL mismatch' ? 'https://wrong.example/' : services.updateUrl),
    /Missing.*app-update\.yml|Invalid updaterCacheDirName|expected.*generic|HTTPS|URL mismatch/)
  })
}
