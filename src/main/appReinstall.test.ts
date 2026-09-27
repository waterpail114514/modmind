import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseReinstallManifest, prepareCleanReinstall, reinstallCleanupDirectories, type ReinstallPaths } from './appReinstall'
import type { DownloadRequest, DownloadResult } from './downloadService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true }))) })
const bytes = Buffer.alloc(10 * 1024 * 1024, 7)
const hash = createHash('sha512').update(bytes).digest('base64')
const metadata = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ version: '1.4.11', files: [{ url: 'ModMind-Setup-1.4.11.exe', size: bytes.length, sha512: hash, ...overrides }] })
const base = 'https://updates.example.com/releases/'
const paths: ReinstallPaths = {
  executablePath: 'C:/Users/Alice/AppData/Local/Programs/ModMind/ModMind.exe',
  userDataPath: 'C:/Users/Alice/AppData/Roaming/modmind', appDataPath: 'C:/Users/Alice/AppData/Roaming',
  localAppDataPath: 'C:/Users/Alice/AppData/Local', homePath: 'C:/Users/Alice', tempPath: 'C:/Users/Alice/AppData/Local/Temp',
  protectedPaths: ['D:/Projects/MyMod']
}

describe('reinstall plan', () => {
  it('clears only the app, its data, legacy data and updater caches', () => {
    const targets = reinstallCleanupDirectories(paths).map(value => value.replaceAll(path.win32.sep, '/'))
    expect(targets).toHaveLength(7)
    expect(targets).toContain('C:/Users/Alice/AppData/Roaming/modtool')
    expect(targets).toContain('C:/Users/Alice/AppData/Local/modmind-updater')
    expect(targets).not.toContain(paths.homePath)
    expect(targets).not.toContain('C:/Users/Alice/.gradle')
    expect(targets).not.toContain(paths.protectedPaths[0])
  })
  it('refuses broad installation paths, arbitrary userData, and projects inside a cleanup directory', () => {
    for (const directory of ['C:/', paths.homePath, paths.appDataPath, paths.localAppDataPath, paths.homePath + '/Desktop']) {
      expect(() => reinstallCleanupDirectories({ ...paths, executablePath: directory + '/ModMind.exe' })).toThrow()
    }
    expect(() => reinstallCleanupDirectories({ ...paths, userDataPath: 'D:/Personal' })).toThrow('自定义')
    expect(() => reinstallCleanupDirectories({ ...paths, protectedPaths: [paths.userDataPath + '/projects/MyMod'] })).toThrow('项目')
  })
  it('accepts a stable same-version installer and rejects wrong origins, traversal, ambiguity and missing integrity', () => {
    expect(parseReinstallManifest(metadata(), base)).toEqual({ version: '1.4.11', url: base + 'ModMind-Setup-1.4.11.exe', size: bytes.length, sha512: Buffer.from(hash, 'base64').toString('hex') })
    for (const url of ['https://other.example.com/setup.exe', '../setup.exe', '%2e%2e%2fsetup.exe', 'setup.exe?x=.exe']) {
      expect(() => parseReinstallManifest(metadata({ url }), base)).toThrow()
    }
    expect(() => parseReinstallManifest(metadata({ sha512: '' }), base)).toThrow('SHA-512')
    expect(() => parseReinstallManifest(metadata({ size: 200 }), base)).toThrow('大小')
    expect(() => parseReinstallManifest(metadata().replace('"1.4.11"', '"1.4.11-beta.1"'), base)).toThrow('清单')
    const duplicate = JSON.parse(metadata()); duplicate.files.push(duplicate.files[0])
    expect(() => parseReinstallManifest(JSON.stringify(duplicate), base)).toThrow('唯一')
  })
})

describe.skipIf(process.platform !== 'win32')('staging a clean reinstall', () => {
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-reinstall-test-'))
    roots.push(root)
    const install = path.join(root, 'Programs', 'ModMind')
    const userDataPath = path.join(root, 'Roaming', 'modmind')
    await fs.mkdir(path.join(install, 'resources'), { recursive: true })
    for (const file of ['ModMind.exe', 'Uninstall ModMind.exe', 'resources/app.asar']) await fs.writeFile(path.join(install, file), 'fake installed file')
    await fs.mkdir(userDataPath, { recursive: true })
    await fs.writeFile(path.join(userDataPath, 'settings.json'), 'keep until verified shutdown')
    const download = vi.fn(async (request: DownloadRequest): Promise<DownloadResult> => {
      await fs.writeFile(request.destination, bytes)
      request.onProgress?.({ source: request.sources[0], downloaded: bytes.length, total: bytes.length })
      return { destination: request.destination, source: request.sources[0], bytes: bytes.length, attempts: 1, failures: [] }
    })
    const launchHelper = vi.fn(async () => undefined)
    const fetchManifest = vi.fn(async () => metadata())
    const options = {
      executablePath: path.join(install, 'ModMind.exe'), userDataPath, appDataPath: path.join(root, 'Roaming'),
      localAppDataPath: path.join(root, 'Local'), homePath: root, tempPath: root, protectedPaths: [], updateUrl: base,
      helperScriptPath: path.resolve('resources/reinstall-app.ps1'), report: vi.fn(), download, fetchManifest, launchHelper
    }
    return { root, options, download, launchHelper, fetchManifest }
  }
  it('downloads the full newest package outside cleanup targets before handing off', async () => {
    const { options, download, launchHelper, fetchManifest } = await setup()
    const launch = await prepareCleanReinstall(options)
    expect(fetchManifest).toHaveBeenCalledWith(base + 'latest.yml')
    expect(download.mock.calls[0][0].expectedHash).toEqual({ algorithm: 'sha512', value: Buffer.from(hash, 'base64').toString('hex') })
    expect(launchHelper).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(options.userDataPath, 'settings.json'), 'utf8')).toContain('keep until')
    await launch()
    expect(launchHelper).toHaveBeenCalledOnce()
  })
  it('never hands off or removes current data if the package is corrupt', async () => {
    const { options, download, launchHelper } = await setup()
    download.mockImplementation(async request => {
      await fs.writeFile(request.destination, Buffer.alloc(bytes.length, 8))
      return { destination: request.destination, source: request.sources[0], bytes: bytes.length, attempts: 1, failures: [] }
    })
    await expect(prepareCleanReinstall(options)).rejects.toThrow('SHA-512')
    expect(launchHelper).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(options.userDataPath, 'settings.json'), 'utf8')).toContain('keep until')
  })
  it('leaves installation data intact when the download fails', async () => {
    const { options, download, launchHelper } = await setup()
    download.mockRejectedValue(new Error('offline'))
    await expect(prepareCleanReinstall(options)).rejects.toThrow('offline')
    expect(launchHelper).not.toHaveBeenCalled()
    expect(await fs.readFile(options.executablePath, 'utf8')).toBe('fake installed file')
  })
})
