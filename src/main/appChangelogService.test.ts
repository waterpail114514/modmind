import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppChangelogService } from './appChangelogService'
import { APP_CHANGELOG } from '../shared/appChangelog'
import { compareSemanticAppVersions, parseAppVersion } from './appUpdatePolicy'

let root: string
const current = '1.4.14'
const stateName = 'app-changelog-state.json'
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-changelog-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
async function launch(version = current, isPackaged = true): Promise<AppChangelogService> {
  const service = new AppChangelogService({ currentVersion: version, userDataPath: root, isPackaged, installMarkerPath: path.join(root, 'install.txt') })
  await service.initialize()
  return service
}

describe('app changelog startup persistence', () => {
  it('keeps a fresh install quiet across restarts and offers offline notes', async () => {
    const releasedNotes = APP_CHANGELOG.slice(APP_CHANGELOG.findIndex(release => release.version === current))
    expect((await launch()).snapshot()).toMatchObject({ automatic: false, currentVersion: current, releases: releasedNotes })
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it('shows an upgrade once, including simultaneous presentation acknowledgements', async () => {
    await launch('1.4.12')
    const upgraded = await launch()
    expect(upgraded.snapshot().automatic).toBe(true)
    await Promise.all([upgraded.markPresented(), upgraded.markPresented()])
    expect(upgraded.snapshot().automatic).toBe(false)
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it('does not lose the notice when startup stops before the dialog appears', async () => {
    await launch('1.4.10')
    expect((await launch()).snapshot().automatic).toBe(true)
    const resumed = await launch()
    expect(resumed.snapshot().automatic).toBe(true)
    await resumed.markPresented()
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it('handles skipped releases and subsequent upgrades', async () => {
    await launch('1.4.0')
    const first = await launch('1.4.12')
    expect(first.snapshot().automatic).toBe(true)
    await first.markPresented()
    expect((await launch()).snapshot().automatic).toBe(true)
  })
  it('suppresses downgrade and returning to an already run version', async () => {
    await launch()
    expect((await launch('1.4.12')).snapshot().automatic).toBe(false)
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it.each([
    [`${current}\r\n1.4.12\r\n`, true],
    [`${current}\r\n\r\n`, false],
    [`${current}\n${current}\n`, false],
    [`${current}\n1.4.15\n`, false],
    ['1.4.12\n1.4.10\n', false],
    [`${current}\ninvalid\n`, false]
  ])('migrates only a matching installer upgrade hint: %s', async (marker, automatic) => {
    await fs.writeFile(path.join(root, 'install.txt'), marker)
    const service = await launch()
    expect(service.snapshot().automatic).toBe(automatic)
    await service.markPresented()
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it('prefers an existing user record over the installer hint', async () => {
    await launch()
    await fs.writeFile(path.join(root, 'install.txt'), `${current}\n1.4.12`)
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it.each(['{', 'null', '{}', '[]', '{"schemaVersion":1,"highestVersion":"bad","pendingVersion":null}', 'x'.repeat(17 * 1024)])('recovers a corrupt record quietly', async raw => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.writeFile(path.join(root, stateName), raw)
    await fs.writeFile(path.join(root, 'install.txt'), `${current}\n1.4.12`)
    expect((await launch()).snapshot().automatic).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(root, stateName), 'utf8')).highestVersion).toBe(current)
  })
  it('does not block startup or repeat a dialog when persistence fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await launch('1.4.12')
    await fs.mkdir(path.join(root, stateName + '.tmp'))
    expect((await launch()).snapshot().automatic).toBe(false)
  })
  it('leaves packaged launch records untouched in development', async () => {
    await launch('1.4.12')
    const before = await fs.readFile(path.join(root, stateName), 'utf8')
    expect((await launch(current, false)).snapshot().automatic).toBe(false)
    expect(await fs.readFile(path.join(root, stateName), 'utf8')).toBe(before)
    expect((await launch()).snapshot().automatic).toBe(true)
  })
  it('does not auto-open an empty changelog or expose future notes', async () => {
    await launch('1.3.0')
    const snapshot = (await launch('1.4.0')).snapshot()
    expect(snapshot.automatic).toBe(false)
    expect(snapshot.releases).toEqual([])
  })
})

it('ships notes for the package version with unique descending versions and nonempty content', async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'))
  // Future release drafts may precede the currently packaged version.
  expect(APP_CHANGELOG.some(release => release.version === pkg.version)).toBe(true)
  expect((await launch(pkg.version)).snapshot().releases[0]?.version).toBe(pkg.version)
  expect(new Set(APP_CHANGELOG.map(release => release.version)).size).toBe(APP_CHANGELOG.length)
  APP_CHANGELOG.forEach((release, index) => {
    expect(parseAppVersion(release.version)).not.toBeNull()
    if (index) expect(compareSemanticAppVersions(APP_CHANGELOG[index - 1].version, release.version)).toBeGreaterThan(0)
    expect(release.sections.length).toBeGreaterThan(0)
    for (const section of release.sections) {
      expect(section.title.trim()).not.toBe('')
      expect(section.items.length).toBeGreaterThan(0)
      for (const item of section.items) expect(item.trim()).not.toBe('')
    }
  })
})
