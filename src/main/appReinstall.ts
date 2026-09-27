import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'yaml'
import type { AppUpdateState } from '../shared/types'
import { parseAppVersion } from './appUpdatePolicy'
import { normalizeAppUpdateUrl } from './appUpdateService'
import { verifiedDownload, type DownloadRequest, type DownloadResult } from './downloadService'
import { downloadActivities } from './downloadActivityService'
import { fetchTextWithRetry } from './networkRequest'

const MIN_INSTALLER_BYTES = 10 * 1024 * 1024
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024

export interface ReinstallPaths {
  executablePath: string
  userDataPath: string
  appDataPath: string
  localAppDataPath: string
  homePath: string
  tempPath: string
  protectedPaths: string[]
}

export interface ReinstallPlan {
  schemaVersion: 1
  userDataPath: string
  installDirectory: string
  cleanupDirectories: string[]
  appDataPath: string
  localAppDataPath: string
  homePath: string
  stageDirectory: string
  installerPath: string
  sha512: string
  version: string
  parentPid: number
}

interface ReinstallOptions extends ReinstallPaths {
  updateUrl: string
  helperScriptPath: string
  report: (state: Partial<AppUpdateState>) => void
  fetchManifest?: (url: string) => Promise<string>
  download?: (request: DownloadRequest) => Promise<DownloadResult>
  launchHelper?: (plan: ReinstallPlan) => Promise<void>
}

function within(parent: string, candidate: string): boolean {
  const relative = path.win32.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.win32.sep) && !path.win32.isAbsolute(relative))
}

/** All recursive deletion targets are derived here, never accepted from IPC. */
export function reinstallCleanupDirectories(options: ReinstallPaths): string[] {
  const normalize = (value: string): string => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  for (const value of [options.executablePath, options.userDataPath, options.appDataPath, options.localAppDataPath, options.homePath, options.tempPath]) {
    if (!/^[a-z]:[\\/]/i.test(value) || value.includes('\0')) throw new Error('重装路径必须是本机绝对路径')
  }
  if (path.win32.basename(options.executablePath).toLowerCase() !== 'modmind.exe') throw new Error('当前程序不是已安装的 ModMind')
  const installDirectory = path.win32.dirname(options.executablePath)
  const allowedData = [
    path.win32.join(options.appDataPath, 'modmind'), path.win32.join(options.appDataPath, 'modtool'),
    path.win32.join(options.localAppDataPath, 'modmind'), path.win32.join(options.localAppDataPath, 'modtool'),
    path.win32.join(options.localAppDataPath, 'modmind-updater'), path.win32.join(options.localAppDataPath, 'modtool-updater')
  ]
  if (!allowedData.slice(0, 4).some(value => normalize(value) === normalize(options.userDataPath))) {
    throw new Error('当前使用自定义应用数据目录，无法自动彻底重装')
  }
  const targets = [installDirectory, ...allowedData]
  const protectedRoots = [options.homePath, options.appDataPath, options.localAppDataPath, options.tempPath,
    ...['Desktop', 'Documents', 'Downloads'].map(name => path.win32.join(options.homePath, name)),
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
    path.win32.join(options.localAppDataPath, 'Programs'), ...options.protectedPaths]
  for (const target of targets) {
    if (normalize(path.win32.parse(target).root) === normalize(target)
      || protectedRoots.some(root => within(target, root))) {
      throw new Error('清理目录包含项目或共享目录，请将项目移出 ModMind 的程序和数据目录后重试：' + target)
    }
  }
  // Collapse nested targets, preserving original spelling for display and logs.
  return targets.filter((target, index) => !targets.some((other, otherIndex) => otherIndex !== index && within(other, target) && (normalize(other) !== normalize(target) || otherIndex < index)))
}

export function parseReinstallManifest(text: string, baseUrl: string): { version: string; url: string; size: number; sha512: string } {
  if (text.length > 1024 * 1024) throw new Error('更新清单过大')
  const metadata = parse(text, { maxAliasCount: 0 }) as { version?: unknown; files?: unknown }
  const version = typeof metadata?.version === 'string' ? parseAppVersion(metadata.version) : null
  if (!version || version.channel !== 'stable' || !Array.isArray(metadata.files)) throw new Error('最新版安装清单无效')
  const installers = metadata.files.filter(file => file && typeof file.url === 'string' && file.url.toLowerCase().endsWith('.exe'))
  // The existing Windows publisher emits a single universal/x64 NSIS installer.
  // Refuse ambiguous feeds instead of silently choosing the wrong architecture.
  if (installers.length !== 1) throw new Error('更新清单未提供唯一的 Windows 安装包')
  const file = installers[0]
  if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    || !Number.isSafeInteger(file.size) || file.size < MIN_INSTALLER_BYTES || file.size > MAX_INSTALLER_BYTES) throw new Error('安装包大小或 SHA-512 校验信息无效')
  const base = new URL(normalizeAppUpdateUrl(baseUrl))
  const url = new URL(file.url, base)
  const filename = decodeURIComponent(url.pathname.slice(base.pathname.length))
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password
    || !filename || /[\\/]/.test(filename) || filename.includes('..') || !filename.toLowerCase().endsWith('.exe')) throw new Error('安装包地址超出受信任的更新目录')
  return { version: version.raw, url: url.toString(), size: file.size, sha512: Buffer.from(file.sha512, 'base64').toString('hex') }
}

async function assertRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('重装所需文件无效：' + file)
}

export async function prepareCleanReinstall(options: ReinstallOptions): Promise<() => Promise<void>> {
  const cleanupDirectories = reinstallCleanupDirectories(options)
  const installDirectory = path.dirname(options.executablePath)
  await assertRegularFile(options.executablePath)
  await assertRegularFile(path.join(installDirectory, 'resources', 'app.asar'))
  await assertRegularFile(path.join(installDirectory, 'Uninstall ModMind.exe'))
  const base = normalizeAppUpdateUrl(options.updateUrl)
  const fetchManifest = options.fetchManifest ?? ((url: string) => fetchTextWithRetry(url, { timeoutMs: 15_000, attempts: 2, headers: { 'Cache-Control': 'no-cache' } }))
  const manifest = parseReinstallManifest(await fetchManifest(new URL('latest.yml', base).toString()), base)
  options.report({ latestVersion: manifest.version, targetChannel: 'stable', message: '正在下载最新版完整安装包', downloadedBytes: 0, totalBytes: manifest.size })
  // The package survives deletion of userData and the normal updater cache.
  const stageDirectory = await fs.mkdtemp(path.join(options.tempPath, 'ModMind-reinstall-'))
  if (cleanupDirectories.some(root => within(root, stageDirectory))) throw new Error('安装包暂存目录与清理目录重叠')
  const installerPath = path.join(stageDirectory, 'ModMind-Setup.exe')
  const activityId = downloadActivities.start({ label: '重装 ModMind ' + manifest.version, detail: '正在下载完整安装包' })
  try {
    await (options.download ?? (request => verifiedDownload.download(request)))({
      sources: [{ id: 'modmind-reinstall', label: 'ModMind 官方更新源', url: manifest.url }],
      destination: installerPath, expectedHash: { algorithm: 'sha512', value: manifest.sha512 },
      maxBytes: manifest.size, timeoutMs: 30 * 60_000, trackActivity: false,
      onProgress: progress => {
        options.report({ downloadedBytes: progress.downloaded, totalBytes: manifest.size })
        downloadActivities.update(activityId, { downloadedBytes: progress.downloaded, totalBytes: manifest.size })
      }
    })
    await assertRegularFile(installerPath)
    if ((await fs.stat(installerPath)).size !== manifest.size) throw new Error('完整安装包大小与清单不符')
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(installerPath)) hash.update(chunk)
    if (hash.digest('hex') !== manifest.sha512) throw new Error('安装包 SHA-512 校验失败，未执行清理')
    const plan: ReinstallPlan = {
      schemaVersion: 1, userDataPath: options.userDataPath, installDirectory, cleanupDirectories, appDataPath: options.appDataPath,
      localAppDataPath: options.localAppDataPath, homePath: options.homePath, stageDirectory,
      installerPath, sha512: manifest.sha512, version: manifest.version, parentPid: process.pid
    }
    await fs.writeFile(path.join(stageDirectory, 'reinstall.ps1'), '\ufeff' + (await fs.readFile(options.helperScriptPath, 'utf8')).replace(/^\ufeff/, ''), 'utf8')
    await fs.writeFile(path.join(stageDirectory, 'plan.json'), JSON.stringify(plan), 'utf8')
    downloadActivities.complete(activityId, '完整安装包已校验，准备退出后清理重装')
    options.report({ message: '安装包已校验，正在准备重装', downloadedBytes: manifest.size, totalBytes: manifest.size })
    return () => (options.launchHelper ?? launchReinstallHelper)(plan)
  } catch (error) {
    downloadActivities.fail(activityId, error)
    // Only remove this invocation's freshly-created staging directory on failure.
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function launchReinstallHelper(plan: ReinstallPlan): Promise<void> {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(plan.stageDirectory, 'reinstall.ps1'), '-PlanPath', path.join(plan.stageDirectory, 'plan.json')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: plan.stageDirectory })
  let launchError: Error | null = null
  child.on('error', error => { launchError = error })
  child.unref()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    const error = await fs.readFile(path.join(plan.stageDirectory, 'error.txt'), 'utf8').catch(() => '')
    if (error) throw new Error(error.trim())
    if (await fs.stat(path.join(plan.stageDirectory, 'ready')).then(() => true, () => false)) {
      await fs.writeFile(path.join(plan.stageDirectory, 'proceed'), 'confirmed', 'utf8')
      return
    }
    await delay(150)
  }
  await fs.writeFile(path.join(plan.stageDirectory, 'cancel'), 'timeout', 'utf8')
  throw new Error('重装准备超时，未清理原程序。请检查 Windows 权限提示后重试。安装包保留在：' + plan.stageDirectory)
}
