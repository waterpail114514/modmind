import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import type { AppUpdateState, AppVersionCheckResult } from '../shared/types'
import { decideAppUpdate } from './appUpdatePolicy'
import { downloadActivities } from './downloadActivityService'

const PENDING_UPDATE_SCHEMA = 1
const MIN_INSTALLER_BYTES = 10 * 1024 * 1024

interface PendingAppUpdate {
  schemaVersion: 1
  targetVersion: string
  installerPath: string
  sha512: string
  downloadedAt: string
}

interface AppUpdateServiceOptions {
  currentVersion: string
  updateUrl: string
  userDataPath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  updater?: AppUpdater
  beforeInstall: () => void
  quit: () => void
  notifyDownloaded: (version: string) => void
  launchInstaller?: (installerPath: string) => Promise<void>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function sha512(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

export function normalizeAppUpdateUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('自动更新地址必须是无凭据、查询参数和片段的 HTTPS 地址')
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.toString()
}

export class AppUpdateService {
  private readonly updater: AppUpdater
  private readonly listeners = new Set<(state: AppUpdateState) => void>()
  private state: AppUpdateState
  private candidate: AppVersionCheckResult | null = null
  private pending: PendingAppUpdate | null = null
  private downloadedInCurrentProcess = false
  private downloadPromise: Promise<AppUpdateState> | null = null
  private activityId = ''

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.updater = options.updater ?? autoUpdater
    this.state = { phase: 'idle', currentVersion: options.currentVersion }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.autoRunAppAfterInstall = true
    this.updater.on('download-progress', (progress) => {
      if (!this.activityId) return
      downloadActivities.update(this.activityId, {
        detail: progress.bytesPerSecond > 0 ? `应用更新 · ${this.speedLabel(progress.bytesPerSecond)}` : '应用更新',
        downloadedBytes: progress.transferred,
        totalBytes: progress.total
      })
      this.setState({
        phase: 'downloading',
        currentVersion: this.options.currentVersion,
        latestVersion: this.candidate?.latestVersion,
        targetChannel: this.candidate?.targetChannel,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      })
    })
    // EventEmitter treats an unhandled error event as fatal. The active promise reports it to the UI.
    this.updater.on('error', (error) => {
      if (!this.downloadPromise) console.warn('[update] updater error', error)
    })
  }

  subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): AppUpdateState {
    return { ...this.state }
  }

  setAvailableUpdate(result: AppVersionCheckResult | null): void {
    this.candidate = result?.updateAvailable ? result : null
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') return
    if (!this.candidate) {
      this.setState({ phase: 'idle', currentVersion: this.options.currentVersion })
      return
    }
    this.setState({
      phase: 'available',
      currentVersion: result!.currentVersion,
      latestVersion: result!.latestVersion,
      targetChannel: result!.targetChannel
    })
  }

  hasDownloadedUpdate(): boolean {
    return this.state.phase === 'downloaded' && Boolean(this.pending)
  }

  downloadUpdate(): Promise<AppUpdateState> {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  async installDownloadedUpdate(): Promise<boolean> {
    if (this.downloadedInCurrentProcess && this.pending) {
      this.options.beforeInstall()
      this.updater.quitAndInstall(false, true)
      return true
    }
    const pending = this.pending ?? await this.readPendingUpdate()
    if (!pending) return false
    if (!await this.validatePendingUpdate(pending)) {
      // A stale marker must not wedge the UI in the downloaded phase; drop it so the update can be re-downloaded.
      await this.removePendingMarker()
      this.setState({ phase: 'idle', currentVersion: this.options.currentVersion })
      return false
    }
    try {
      return await this.launchInstaller(pending)
    } catch (error) {
      // Keep the validated marker so the install can be retried from the UI.
      this.setState({
        phase: 'downloaded',
        currentVersion: this.options.currentVersion,
        latestVersion: pending.targetVersion,
        message: `无法启动安装程序：${describeError(error)}`
      })
      throw error
    }
  }

  async installPendingUpdateOnStartup(): Promise<boolean> {
    if (!this.supported()) return false
    const pending = await this.readPendingUpdate()
    if (!pending) return false
    if (pending.targetVersion === this.options.currentVersion) {
      await this.removePendingMarker()
      return false
    }
    const decision = decideAppUpdate(this.options.currentVersion, pending.targetVersion)
    if (!decision?.updateAvailable || !await this.validatePendingUpdate(pending)) {
      await this.removePendingMarker()
      return false
    }
    this.pending = pending
    this.setState({
      phase: 'downloaded',
      currentVersion: this.options.currentVersion,
      latestVersion: pending.targetVersion,
      targetChannel: decision.targetChannel,
      message: '更新已下载，正在启动安装程序'
    })
    try {
      return await this.launchInstaller(pending)
    } catch (error) {
      // Startup must never be blocked by a failed installer launch (antivirus locks, file in use).
      // Keep the marker so the next startup retries, but let the app boot normally.
      console.warn('[update] failed to launch pending update on startup', error)
      return false
    }
  }

  private async performDownload(): Promise<AppUpdateState> {
    const candidate = this.candidate
    if (!candidate?.updateAvailable) throw new Error('当前没有可下载的应用更新')
    if (!this.supported()) throw new Error('自动更新仅支持已安装的桌面版本')

    this.activityId = downloadActivities.start({ label: `ModMind ${candidate.latestVersion}`, detail: '正在读取更新清单' })
    this.setState({
      phase: 'downloading',
      currentVersion: candidate.currentVersion,
      latestVersion: candidate.latestVersion,
      targetChannel: candidate.targetChannel,
      downloadedBytes: 0
    })

    try {
      const channel = candidate.targetChannel === 'beta' ? 'beta' : 'latest'
      const updateBaseUrl = normalizeAppUpdateUrl(this.options.updateUrl)
      const configureUpdater = (useMultipleRangeRequest: boolean, disableDifferentialDownload: boolean): void => {
        this.updater.setFeedURL({ provider: 'generic', url: updateBaseUrl, channel, useMultipleRangeRequest })
        this.updater.channel = channel
        this.updater.allowPrerelease = candidate.targetChannel === 'beta'
        this.updater.allowDowngrade = candidate.currentChannel === 'beta' && candidate.targetChannel === 'stable'
        this.updater.disableDifferentialDownload = disableDifferentialDownload
      }
      configureUpdater(true, false)

      let checked = await this.updater.checkForUpdates()
      if (!checked) throw new Error('更新服务当前不可用')
      if (checked.updateInfo.version !== candidate.latestVersion) {
        throw new Error(`更新清单版本 ${checked.updateInfo.version} 与服务器版本 ${candidate.latestVersion} 不一致`)
      }
      if (!checked.isUpdateAvailable) throw new Error('更新清单未提供适用于当前版本的更新')

      let files: string[] = []
      let differentialError: unknown
      for (const [modeIndex, mode] of [
        { label: '多 Range 差分', multiple: true, full: false },
        { label: '单 Range 差分', multiple: false, full: false },
        { label: '完整安装包', multiple: false, full: true }
      ].entries()) {
        try {
          configureUpdater(mode.multiple, mode.full)
          // electron-updater captures the provider (and its range capability)
          // during checkForUpdates, so refresh it before every fallback mode.
          if (modeIndex > 0) {
            const modeChecked = await this.updater.checkForUpdates()
            if (!modeChecked?.isUpdateAvailable) throw new Error('更新清单未提供当前回退方式所需的安装包')
            if (modeChecked.updateInfo.version !== candidate.latestVersion) {
              throw new Error(`回退下载清单版本 ${modeChecked.updateInfo.version} 与服务器版本 ${candidate.latestVersion} 不一致`)
            }
            checked = modeChecked
          }
          this.setState({
            phase: 'downloading',
            currentVersion: candidate.currentVersion,
            latestVersion: candidate.latestVersion,
            targetChannel: candidate.targetChannel,
            message: `正在尝试${mode.label}更新下载`
          })
          files = await this.updater.downloadUpdate()
          if (files.length) break
        } catch (error) {
          differentialError = error
          this.setState({
            phase: 'downloading',
            currentVersion: candidate.currentVersion,
            latestVersion: candidate.latestVersion,
            targetChannel: candidate.targetChannel,
            message: `${mode.label}下载失败，准备下一种回退方式`
          })
        }
      }
      if (!files.length) {
        throw differentialError instanceof Error ? differentialError : new Error('更新器未返回安装包路径')
      }
      const extension = (this.options.platform ?? process.platform) === 'win32' ? '.exe' : '.zip'
      const installerPath = files.find((file) => file.toLowerCase().endsWith(extension)) ?? files[0]
      if (!installerPath) throw new Error('更新器没有返回已下载的安装包')
      const installerInfo = checked.updateInfo.files.find((file) => file.url.toLowerCase().endsWith(extension)) ?? checked.updateInfo.files[0]
      const expectedSha512 = installerInfo?.sha512 ?? checked.updateInfo.sha512
      if (!expectedSha512) throw new Error('更新清单缺少安装包 SHA-512')

      const stat = await fs.stat(installerPath)
      const pending: PendingAppUpdate = {
        schemaVersion: PENDING_UPDATE_SCHEMA,
        targetVersion: candidate.latestVersion,
        installerPath: path.resolve(installerPath),
        sha512: expectedSha512,
        downloadedAt: new Date().toISOString()
      }
      await this.writePendingUpdate(pending)
      this.pending = pending
      this.downloadedInCurrentProcess = true
      downloadActivities.complete(this.activityId, '安装包已校验，等待重启安装')
      this.activityId = ''
      this.setState({
        phase: 'downloaded',
        currentVersion: candidate.currentVersion,
        latestVersion: candidate.latestVersion,
        targetChannel: candidate.targetChannel,
        downloadedBytes: stat.size,
        totalBytes: stat.size,
        message: '更新已下载，下次启动 ModMind 时将自动安装'
      })
      this.options.notifyDownloaded(candidate.latestVersion)
      return this.snapshot()
    } catch (error) {
      if (this.activityId) downloadActivities.fail(this.activityId, error)
      this.activityId = ''
      this.setState({
        phase: 'error',
        currentVersion: candidate.currentVersion,
        latestVersion: candidate.latestVersion,
        targetChannel: candidate.targetChannel,
        message: describeError(error)
      })
      throw error
    }
  }

  private supported(): boolean {
    const platform = this.options.platform ?? process.platform
    return this.options.isPackaged && (platform === 'win32' || platform === 'darwin' || platform === 'linux')
  }

  private pendingMarkerPath(): string {
    return path.join(this.options.userDataPath, 'pending-app-update.json')
  }

  private updateCacheRoot(): string {
    const platform = this.options.platform ?? process.platform
    const base = platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(this.options.userDataPath, 'updater-cache')
    return path.join(base, 'modmind-updater', 'pending')
  }

  private async writePendingUpdate(pending: PendingAppUpdate): Promise<void> {
    const target = this.pendingMarkerPath()
    const temporary = `${target}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(pending, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rm(target, { force: true })
    await fs.rename(temporary, target)
  }

  private async readPendingUpdate(): Promise<PendingAppUpdate | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.pendingMarkerPath(), 'utf8')) as Partial<PendingAppUpdate>
      if (value.schemaVersion !== PENDING_UPDATE_SCHEMA
        || typeof value.targetVersion !== 'string'
        || typeof value.installerPath !== 'string'
        || typeof value.sha512 !== 'string'
        || typeof value.downloadedAt !== 'string') return null
      return value as PendingAppUpdate
    } catch {
      return null
    }
  }

  private async validatePendingUpdate(pending: PendingAppUpdate): Promise<boolean> {
    const extension = (this.options.platform ?? process.platform) === 'win32' ? '.exe' : '.zip'
    if (!isPathInside(this.updateCacheRoot(), pending.installerPath) || path.extname(pending.installerPath).toLowerCase() !== extension) return false
    try {
      const stat = await fs.stat(pending.installerPath)
      if (!stat.isFile() || stat.size < MIN_INSTALLER_BYTES) return false
      return await sha512(pending.installerPath) === pending.sha512
    } catch {
      return false
    }
  }

  private async removePendingMarker(): Promise<void> {
    this.pending = null
    await fs.rm(this.pendingMarkerPath(), { force: true })
  }

  private async launchInstaller(pending: PendingAppUpdate): Promise<boolean> {
    if (this.options.launchInstaller) await this.options.launchInstaller(pending.installerPath)
    else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(pending.installerPath, ['--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
        child.once('error', reject)
      })
    }
    this.options.beforeInstall()
    this.options.quit()
    return true
  }

  private speedLabel(bytesPerSecond: number): string {
    const megabytes = bytesPerSecond / (1024 * 1024)
    return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB/s`
  }

  private setState(state: AppUpdateState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.snapshot())
  }
}
