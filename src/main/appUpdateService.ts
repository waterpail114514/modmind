import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
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
  /** Override only when the updater was configured with a custom cache root. */
  updateCachePath?: string
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
  private actionInProgress = false
  private installAfterDownload = false

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
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') return
    this.candidate = result?.updateAvailable ? result : null
    if (this.state.phase === 'downloaded' && this.pending?.targetVersion === result?.latestVersion) return
    if (!this.candidate) {
      this.setState({ phase: result ? 'up-to-date' : 'idle', currentVersion: this.options.currentVersion })
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
    if (this.actionInProgress || this.state.phase === 'installing') return Promise.reject(new Error('更新或重装正在进行，请等待完成'))
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  async installDownloadedUpdate(): Promise<boolean> {
    this.assertIdle()
    this.actionInProgress = true
    try { return await this.performInstall(false) } finally { this.actionInProgress = false }
  }

  private assertIdle(): void {
    if (this.actionInProgress || this.downloadPromise || this.state.phase === 'installing') throw new Error('更新或重装正在进行，请等待完成')
  }

  async checkForUpdates(check: () => Promise<AppVersionCheckResult>): Promise<AppVersionCheckResult> {
    this.assertIdle()
    this.actionInProgress = true
    try { return await this.performCheck(check) } finally { this.actionInProgress = false }
  }

  private async performCheck(check: () => Promise<AppVersionCheckResult>): Promise<AppVersionCheckResult> {
    this.setState({ phase: 'checking', currentVersion: this.options.currentVersion })
    try {
      const result = await check()
      this.setAvailableUpdate(result)
      return result
    } catch (error) {
      this.setState({ phase: 'error', currentVersion: this.options.currentVersion, message: describeError(error) })
      throw error
    }
  }

  async updateNow(check: () => Promise<AppVersionCheckResult>): Promise<AppUpdateState> {
    this.assertIdle()
    this.actionInProgress = true
    this.installAfterDownload = true
    try {
      const result = await this.performCheck(check)
      if (!result.updateAvailable) return this.snapshot()
      if (!this.supported()) throw new Error('当前程序没有可用的安装记录，无法执行自动安装')
      if (!this.pending || this.pending.targetVersion !== result.latestVersion || !await this.validatePendingUpdate(this.pending)) {
        await this.performDownload()
      }
      if (!await this.performInstall(true)) throw new Error('安装包不可用，请重新下载更新')
      return this.snapshot()
    } catch (error) {
      this.setState({ phase: 'error', currentVersion: this.options.currentVersion, message: describeError(error) })
      throw error
    } finally {
      this.actionInProgress = false
      this.installAfterDownload = false
    }
  }

  async reinstallLatest(
    confirm: () => Promise<boolean>,
    prepare: (report: (state: Partial<AppUpdateState>) => void) => Promise<() => Promise<void>>,
    prepareOverwrite?: (report: (state: Partial<AppUpdateState>) => void) => Promise<() => Promise<void>>
  ): Promise<AppUpdateState | null> {
    this.assertIdle()
    this.actionInProgress = true
    try {
      if (!await confirm()) return null
      if (!this.options.isPackaged || (this.options.platform ?? process.platform) !== 'win32') throw new Error('当前程序没有可用的 Windows 安装记录，无法执行清理重装')
      this.setState({ phase: 'downloading', operation: 'reinstall', currentVersion: this.options.currentVersion, message: '正在读取最新版安装清单' })
      const report = (patch: Partial<AppUpdateState>): void => this.setState({ ...this.state, ...patch, operation: 'reinstall', currentVersion: this.options.currentVersion })
      let overwrite = false
      try {
        const launch = await prepare(report)
        // The helper acknowledges readiness before shutdown and cleanup.
        await launch()
      } catch (cleanError) {
        if (!prepareOverwrite) throw cleanError
        overwrite = true
        console.warn('[reinstall] clean preparation failed; using overwrite installer', cleanError)
        report({ phase: 'downloading', message: '清理重装未能启动，正在准备最新版覆盖安装（保留现有数据）', downloadedBytes: 0, totalBytes: undefined })
        try { await (await prepareOverwrite(report))() }
        catch (overwriteError) { throw new Error('清理重装失败：' + describeError(cleanError) + '；覆盖安装也失败：' + describeError(overwriteError)) }
      }
      this.setState({ ...this.state, phase: 'installing', message: overwrite ? '正在退出并覆盖安装，现有数据保留…' : '安装包已校验，正在退出并清理重装…' })
      this.options.beforeInstall()
      this.options.quit()
      return this.snapshot()
    } catch (error) {
      this.setState({ phase: 'error', operation: 'reinstall', currentVersion: this.options.currentVersion, message: describeError(error) })
      throw error
    } finally { this.actionInProgress = false }
  }

  private async performInstall(silent: boolean): Promise<boolean> {
    const pending = this.pending ?? await this.readPendingUpdate()
    if (!pending) return false
    if (!await (this.downloadedInCurrentProcess ? this.validateInstallerIntegrity(pending) : this.validatePendingUpdate(pending))) {
      // A stale marker must not wedge the UI in the downloaded phase; drop it so the update can be re-downloaded.
      await this.removePendingMarker()
      this.setState({ phase: 'idle', currentVersion: this.options.currentVersion })
      return false
    }
    try {
      if (this.downloadedInCurrentProcess && this.pending) {
        this.setState({ ...this.state, phase: 'installing', message: '正在重启并安装更新…' })
        this.options.beforeInstall()
        this.updater.quitAndInstall(silent, true)
        return true
      }
      return await this.resumeInstaller(pending, silent)
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
      return await this.resumeInstaller(pending)
    } catch (error) {
      // Startup must never be blocked by a failed installer launch (antivirus locks, file in use).
      // Keep the marker so the next startup retries, but let the app boot normally.
      console.warn('[update] failed to launch pending update on startup', error)
      this.setState({ ...this.state, phase: 'downloaded', message: `更新已保留，安装暂未完成：${describeError(error)}` })
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
      const extension = this.installerExtension()
      const installerPath = files.find((file) => file.toLowerCase().endsWith(extension))
      if (!installerPath) throw new Error('更新器没有返回已下载的安装包')
      const installerInfo = checked.updateInfo.files.find((file) => new URL(file.url, updateBaseUrl).pathname.toLowerCase().endsWith(extension))
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
      if (!this.installAfterDownload) this.options.notifyDownloaded(candidate.latestVersion)
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
    if (this.options.updateCachePath) return path.resolve(this.options.updateCachePath)
    const platform = this.options.platform ?? process.platform
    // Match electron-updater's ElectronAppAdapter/getAppCacheDir on each OS.
    const base = platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
    return path.join(base, 'modmind-updater', 'pending')
  }

  private installerExtension(): string {
    const platform = this.options.platform ?? process.platform
    return platform === 'win32' ? '.exe' : platform === 'darwin' ? '.zip' : '.appimage'
  }

  private async writePendingUpdate(pending: PendingAppUpdate): Promise<void> {
    const target = this.pendingMarkerPath()
    const temporary = `${target}.tmp-${randomUUID()}`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(pending, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { await fs.rename(temporary, target) }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
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
    const extension = this.installerExtension()
    if (!isPathInside(this.updateCacheRoot(), pending.installerPath) || path.extname(pending.installerPath).toLowerCase() !== extension) return false
    return this.validateInstallerIntegrity(pending)
  }

  private async validateInstallerIntegrity(pending: PendingAppUpdate): Promise<boolean> {
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
    this.downloadedInCurrentProcess = false
    await fs.rm(this.pendingMarkerPath(), { force: true })
  }

  private async resumeInstaller(pending: PendingAppUpdate, silent = false): Promise<boolean> {
    if ((this.options.platform ?? process.platform) === 'win32') return this.launchInstaller(pending, silent)

    // A ZIP is not an executable, and AppImage replacement belongs to its updater.
    // Rehydrate the platform updater from the already verified local artifact.
    // The private loopback feed also allows a downloaded update to resume offline.
    const token = randomUUID()
    const fileName = path.basename(pending.installerPath)
    const fileUrl = `${token}/${encodeURIComponent(fileName)}`
    const stat = await fs.stat(pending.installerPath)
    const directory = await fs.mkdtemp(path.join(this.options.userDataPath, 'update-resume-'))
    const backup = path.join(directory, fileName)
    let preserveBackup = false
    try { await fs.copyFile(pending.installerPath, backup) }
    catch (error) { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error }
    // The updater can clear its old cache when update-info.json is missing or
    // damaged. Serve an independent copy so that recovery never deletes its input.
    const manifest = JSON.stringify({ version: pending.targetVersion, files: [{ url: encodeURIComponent(fileName), size: stat.size, sha512: pending.sha512 }], path: encodeURIComponent(fileName), sha512: pending.sha512, releaseDate: pending.downloadedAt })
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      if (pathname.startsWith(`/${token}/`) && pathname.endsWith('.yml')) {
        response.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(manifest) })
        response.end(manifest)
      } else if (pathname === `/${fileUrl}`) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size })
        const stream = createReadStream(backup)
        stream.once('error', () => response.destroy())
        response.once('close', () => stream.destroy())
        stream.pipe(response)
      } else { response.writeHead(404); response.end() }
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const decision = decideAppUpdate(this.options.currentVersion, pending.targetVersion)!
      const address = server.address() as { port: number }
      this.updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${address.port}/${token}/`, channel: decision.targetChannel === 'beta' ? 'beta' : 'latest', useMultipleRangeRequest: false })
      this.updater.allowPrerelease = decision.targetChannel === 'beta'
      this.updater.allowDowngrade = decision.currentChannel === 'beta' && decision.targetChannel === 'stable'
      this.updater.disableDifferentialDownload = true
      const checked = await this.updater.checkForUpdates()
      if (!checked?.isUpdateAvailable || checked.updateInfo.version !== pending.targetVersion) throw new Error('无法恢复已下载的更新')
      const files = await this.updater.downloadUpdate()
      const installer = files.find(file => file.toLowerCase().endsWith(this.installerExtension()))
      if (!installer || !await this.validateInstallerIntegrity({ ...pending, installerPath: installer })) throw new Error('恢复的安装包校验失败')
      this.downloadedInCurrentProcess = true
      this.setState({ ...this.state, phase: 'installing', message: '正在重启并安装更新…' })
      this.options.beforeInstall()
      this.updater.quitAndInstall(silent, true)
      return true
    } catch (error) {
      if (!await this.validateInstallerIntegrity(pending)) {
        try {
          await fs.mkdir(path.dirname(pending.installerPath), { recursive: true })
          await fs.copyFile(backup, pending.installerPath)
        } catch (restoreError) {
          preserveBackup = true
          throw new AggregateError([error, restoreError], `更新恢复失败，完整安装包保留在：${backup}`)
        }
      }
      throw error
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (!preserveBackup) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async launchInstaller(pending: PendingAppUpdate, silent = false): Promise<boolean> {
    if (this.options.launchInstaller) await this.options.launchInstaller(pending.installerPath)
    else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(pending.installerPath, [...(silent ? ['/S'] : []), '--updated', '--force-run'], {
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
    this.setState({ ...this.state, phase: 'installing', message: '正在重启并安装更新…' })
    this.options.beforeInstall()
    this.options.quit()
    return true
  }

  private speedLabel(bytesPerSecond: number): string {
    const megabytes = bytesPerSecond / (1024 * 1024)
    return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB/s`
  }

  private setState(state: AppUpdateState): void {
    this.state = { ...state, ...(this.installAfterDownload ? { installAfterDownload: true } : {}) }
    for (const listener of this.listeners) listener(this.snapshot())
  }
}
