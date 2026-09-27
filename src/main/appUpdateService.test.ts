import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater, UpdateCheckResult } from 'electron-updater'
import { AppUpdateService, normalizeAppUpdateUrl } from './appUpdateService'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowPrerelease = false
  allowDowngrade = false
  disableDifferentialDownload = false
  channel: string | null = null
  feed: unknown
  feeds: unknown[] = []
  checkCalls = 0
  downloadCalls = 0
  failuresBeforeSuccess = 0
  quitAndInstall = vi.fn()

  constructor(private readonly result: UpdateCheckResult, private readonly installerPath: string) {
    super()
  }

  setFeedURL(value: unknown): void {
    this.feed = value
    this.feeds.push(value)
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.checkCalls += 1
    return this.result
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1
    if (this.downloadCalls <= this.failuresBeforeSuccess) throw new Error(`download mode ${this.downloadCalls} failed`)
    const stat = await fs.stat(this.installerPath)
    this.emit('download-progress', { total: stat.size, delta: stat.size, transferred: stat.size, percent: 100, bytesPerSecond: 4 * 1024 * 1024 })
    return [this.installerPath]
  }
}

const temporaryRoots: string[] = []
const originalLocalAppData = process.env.LOCALAPPDATA

afterEach(async () => {
  process.env.LOCALAPPDATA = originalLocalAppData
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(version: string): Promise<{ root: string; userData: string; installer: string; sha512: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-update-'))
  temporaryRoots.push(root)
  process.env.LOCALAPPDATA = root
  const userData = path.join(root, 'user-data')
  const installer = path.join(root, 'modmind-updater', 'pending', `ModMind-Setup-${version}.exe`)
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 7)
  await fs.mkdir(path.dirname(installer), { recursive: true })
  await fs.writeFile(installer, bytes)
  return { root, userData, installer, sha512: createHash('sha512').update(bytes).digest('base64') }
}

describe('AppUpdateService', () => {
  async function maintenanceFixture(isPackaged = true) {
    const files = await fixture('1.4.11')
    const info = { version: '1.4.11', files: [{ url: 'ModMind-Setup-1.4.11.exe', sha512: files.sha512, size: 10 * 1024 * 1024 + 1 }], path: 'ModMind-Setup-1.4.11.exe', sha512: files.sha512, releaseDate: '2026-09-26T00:00:00.000Z' }
    const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: info, versionInfo: info }, files.installer)
    const quit = vi.fn(), beforeInstall = vi.fn(), notifyDownloaded = vi.fn()
    const service = new AppUpdateService({ currentVersion: '1.4.10', updateUrl: 'https://updates.example.com/', userDataPath: files.userData, isPackaged, platform: 'win32', updater: updater as unknown as AppUpdater, beforeInstall, quit, notifyDownloaded })
    const result = { currentVersion: '1.4.10', latestVersion: '1.4.11', currentChannel: 'stable' as const, targetChannel: 'stable' as const, updateAvailable: true }
    return { files, updater, service, quit, beforeInstall, notifyDownloaded, result }
  }

  it('checks without downloading and distinguishes no update from a network failure', async () => {
    const { service, updater, result } = await maintenanceFixture()
    await service.checkForUpdates(async () => ({ ...result, latestVersion: result.currentVersion, updateAvailable: false }))
    expect(service.snapshot().phase).toBe('up-to-date')
    expect(updater.downloadCalls).toBe(0)
    await expect(service.checkForUpdates(async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(service.snapshot()).toMatchObject({ phase: 'error', message: 'offline' })
  })

  it('checks, downloads, and silently installs in one action without a second update dialog', async () => {
    const { service, updater, result, notifyDownloaded, beforeInstall } = await maintenanceFixture()
    const states: unknown[] = []
    service.subscribe(state => states.push(state))
    await expect(service.updateNow(async () => result)).resolves.toMatchObject({ phase: 'installing' })
    expect(updater.downloadCalls).toBe(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(notifyDownloaded).not.toHaveBeenCalled()
    expect(states).toContainEqual(expect.objectContaining({ phase: 'downloaded', installAfterDownload: true }))
  })

  it('does not download or quit when one-click update finds the current version', async () => {
    const { service, updater, result, quit } = await maintenanceFixture()
    await expect(service.updateNow(async () => ({ ...result, updateAvailable: false, latestVersion: result.currentVersion }))).resolves.toMatchObject({ phase: 'up-to-date' })
    expect(updater.downloadCalls).toBe(0)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('shows confirmation and checks versions before validating the installation record', async () => {
    const { service, result } = await maintenanceFixture(false)
    const confirm = vi.fn(async () => false), prepare = vi.fn()
    await expect(service.reinstallLatest(confirm, prepare)).resolves.toBeNull()
    expect(confirm).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    await expect(service.updateNow(async () => ({ ...result, updateAvailable: false }))).resolves.toMatchObject({ phase: 'up-to-date' })
  })

  it('cancels reinstall before preparing or downloading anything', async () => {
    const { service, quit, beforeInstall } = await maintenanceFixture()
    const prepare = vi.fn()
    await expect(service.reinstallLatest(async () => false, prepare)).resolves.toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(service.snapshot().phase).toBe('idle')
  })

  it('waits for the helper to be ready before shutdown and blocks concurrent maintenance', async () => {
    const { service, quit, result } = await maintenanceFixture()
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const prepare = vi.fn(async () => async () => ready)
    const pending = service.reinstallLatest(async () => true, prepare)
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
    await expect(service.updateNow(async () => result)).rejects.toThrow('正在进行')
    await expect(service.downloadUpdate()).rejects.toThrow('正在进行')
    await expect(service.installDownloadedUpdate()).rejects.toThrow('正在进行')
    release()
    await expect(pending).resolves.toMatchObject({ phase: 'installing', operation: 'reinstall' })
    expect(quit).toHaveBeenCalledOnce()
  })

  it('keeps the app running if preparing the reinstall or launching its helper fails', async () => {
    const { service, quit, beforeInstall } = await maintenanceFixture()
    await expect(service.reinstallLatest(async () => true, async () => { throw new Error('hash mismatch') })).rejects.toThrow('hash mismatch')
    await expect(service.reinstallLatest(async () => true, async () => async () => { throw new Error('permission denied') })).rejects.toThrow('permission denied')
    expect(quit).not.toHaveBeenCalled()
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(service.snapshot()).toMatchObject({ phase: 'error', operation: 'reinstall' })
  })

  it('normalizes only trusted HTTPS update bases', () => {
    expect(normalizeAppUpdateUrl('https://updates.example.com/modmind')).toBe('https://updates.example.com/modmind/')
    expect(() => normalizeAppUpdateUrl('http://updates.example.com/')).toThrow(/HTTPS/)
    expect(() => normalizeAppUpdateUrl('https://user:secret@updates.example.com/')).toThrow(/HTTPS/)
  })

  it('downloads a stable release, reports progress, and persists the verified metadata', async () => {
    const files = await fixture('1.3.12')
    const updateInfo = {
      version: '1.3.12',
      files: [{ url: 'ModMind-Setup-1.3.12.exe', sha512: files.sha512, size: 10 * 1024 * 1024 + 1 }],
      path: 'ModMind-Setup-1.3.12.exe',
      sha512: files.sha512,
      releaseDate: '2026-08-25T00:00:00.000Z'
    }
    const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo, versionInfo: updateInfo }, files.installer)
    const notifyDownloaded = vi.fn()
    const service = new AppUpdateService({
      currentVersion: '2.0.0-beta.5',
      updateUrl: 'https://updates.example.com/',
      userDataPath: files.userData,
      isPackaged: true,
      platform: 'win32',
      updater: updater as unknown as AppUpdater,
      beforeInstall: vi.fn(),
      quit: vi.fn(),
      notifyDownloaded
    })
    service.setAvailableUpdate({
      currentVersion: '2.0.0-beta.5',
      latestVersion: '1.3.12',
      currentChannel: 'beta',
      targetChannel: 'stable',
      updateAvailable: true
    })

    await expect(service.downloadUpdate()).resolves.toMatchObject({
      phase: 'downloaded', latestVersion: '1.3.12', downloadedBytes: 10 * 1024 * 1024 + 1
    })
    expect(updater.feed).toMatchObject({ provider: 'generic', channel: 'latest', url: 'https://updates.example.com/' })
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(true)
    expect(notifyDownloaded).toHaveBeenCalledWith('1.3.12')
    await expect(fs.readFile(path.join(files.userData, 'pending-app-update.json'), 'utf8')).resolves.toContain('ModMind-Setup-1.3.12.exe')

    const beforeImmediateInstall = vi.fn()
    const immediateService = new AppUpdateService({
      currentVersion: '2.0.0-beta.5',
      updateUrl: 'https://updates.example.com/',
      userDataPath: files.userData,
      isPackaged: true,
      platform: 'win32',
      updater: updater as unknown as AppUpdater,
      beforeInstall: beforeImmediateInstall,
      quit: vi.fn(),
      notifyDownloaded: vi.fn()
    })
    immediateService.setAvailableUpdate({
      currentVersion: '2.0.0-beta.5', latestVersion: '1.3.12', currentChannel: 'beta', targetChannel: 'stable', updateAvailable: true
    })
    await immediateService.downloadUpdate()
    await expect(immediateService.installDownloadedUpdate()).resolves.toBe(true)
    expect(beforeImmediateInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)

    const launchInstaller = vi.fn(async () => undefined)
    const beforeRestartInstall = vi.fn()
    const quit = vi.fn()
    const restartedService = new AppUpdateService({
      currentVersion: '2.0.0-beta.5',
      updateUrl: 'https://updates.example.com/',
      userDataPath: files.userData,
      isPackaged: true,
      platform: 'win32',
      updater: new FakeUpdater({ isUpdateAvailable: true, updateInfo, versionInfo: updateInfo }, files.installer) as unknown as AppUpdater,
      beforeInstall: beforeRestartInstall,
      quit,
      notifyDownloaded: vi.fn(),
      launchInstaller
    })
    await expect(restartedService.installPendingUpdateOnStartup()).resolves.toBe(true)
    expect(launchInstaller).toHaveBeenCalledWith(files.installer)
    expect(beforeRestartInstall).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('refuses downloads that were not offered by the version policy', async () => {
    const files = await fixture('1.4.0-beta.2')
    const updateInfo = { version: '1.4.0-beta.2', files: [], path: '', sha512: files.sha512, releaseDate: '' }
    const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo, versionInfo: updateInfo }, files.installer)
    const service = new AppUpdateService({
      currentVersion: '1.3.12',
      updateUrl: 'https://updates.example.com/',
      userDataPath: files.userData,
      isPackaged: true,
      platform: 'win32',
      updater: updater as unknown as AppUpdater,
      beforeInstall: vi.fn(),
      quit: vi.fn(),
      notifyDownloaded: vi.fn()
    })
    service.setAvailableUpdate({
      currentVersion: '1.3.12',
      latestVersion: '1.4.0-beta.2',
      currentChannel: 'stable',
      targetChannel: 'beta',
      updateAvailable: false
    })
    await expect(service.downloadUpdate()).rejects.toThrow(/没有可下载/)
  })

  it('falls back from multi-range to single-range and then full installer download', async () => {
    const files = await fixture('1.4.1')
    const updateInfo = {
      version: '1.4.1',
      files: [{ url: 'ModMind-Setup-1.4.1.exe', sha512: files.sha512, size: 10 * 1024 * 1024 + 1 }],
      path: 'ModMind-Setup-1.4.1.exe',
      sha512: files.sha512,
      releaseDate: '2026-08-31T00:00:00.000Z'
    }
    const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo, versionInfo: updateInfo }, files.installer)
    updater.failuresBeforeSuccess = 2
    const service = new AppUpdateService({
      currentVersion: '1.4.0',
      updateUrl: 'https://updates.example.com/',
      userDataPath: files.userData,
      isPackaged: true,
      platform: 'win32',
      updater: updater as unknown as AppUpdater,
      beforeInstall: vi.fn(),
      quit: vi.fn(),
      notifyDownloaded: vi.fn()
    })
    service.setAvailableUpdate({
      currentVersion: '1.4.0', latestVersion: '1.4.1', currentChannel: 'stable', targetChannel: 'stable', updateAvailable: true
    })

    await expect(service.downloadUpdate()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(updater.downloadCalls).toBe(3)
    expect(updater.checkCalls).toBe(3)
    expect(updater.feeds.map((feed) => (feed as { useMultipleRangeRequest?: boolean }).useMultipleRangeRequest)).toEqual([true, true, false, false])
    expect(updater.feed).toMatchObject({ useMultipleRangeRequest: false })
    expect(updater.disableDifferentialDownload).toBe(true)
  })
})
