import { MinecraftFolder } from '@xmcl/core'
import { DownloadForgeInstallerTask, DownloadNeoForgedInstallerTask, resolveLibraryDownloadUrls } from '@xmcl/installer'
import type { LibraryOptions } from '@xmcl/installer'
import { verifiedDownload, type DownloadRequest } from './downloadService'
import { fetchTextWithRetry } from './networkRequest'
import { validateJavaArchive } from './javaArchive'
import { BMCLAPI_BASE_URL } from './minecraftVersionManifest'
import { diagnosticJournal } from './diagnosticLog'

// Keep XMCL's artifact coordinates and legacy archive selection in one place.
class ForgeInstaller extends DownloadForgeInstallerTask { get request() { return this.options } }
class NeoForgeInstaller extends DownloadNeoForgedInstallerTask { get request() { return this.options } }

export function loaderLibraryHost(mavenHost: string[]): NonNullable<LibraryOptions['libraryHost']> {
  return library => resolveLibraryDownloadUrls(library, { mavenHost }).filter(url =>
    !library.download.path.startsWith('net/neoforged/') || !url.startsWith('https://repo1.maven.org/'))
}

export async function prepareLoaderInstaller(options: {
  loader: 'forge' | 'neoforge'
  minecraftVersion: string
  version: string
  resourceRoot: string
  signal?: AbortSignal
  onProgress?: DownloadRequest['onProgress']
}): Promise<void> {
  const folder = MinecraftFolder.from(options.resourceRoot)
  const legacy = options.loader === 'forge' && options.minecraftVersion.startsWith('1.4.')
  const hosts = [`${BMCLAPI_BASE_URL}/maven`, options.loader === 'forge' ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases']
  const installOptions = { mavenHost: hosts, libraryHost: loaderLibraryHost(hosts) }
  const forgeVersion = `${options.minecraftVersion}-${options.version}${/^1\.(?:7|8)\./.test(options.minecraftVersion) ? `-${options.minecraftVersion}` : ''}`
  const request = options.loader === 'forge'
    ? new ForgeInstaller(forgeVersion, undefined, folder, installOptions, legacy).request
    : new NeoForgeInstaller(options.minecraftVersion === '1.20.1' ? 'forge' : 'neoforge', options.version, folder, installOptions).request
  const urls = typeof request.url === 'string' ? [request.url] : request.url
  const validate = async (file: string): Promise<void> => {
    await validateJavaArchive(file, { installer: !legacy })
  }
  options.signal?.throwIfAborted()
  if (await validate(request.destination).then(() => true, () => false)) return
  let expectedHash: DownloadRequest['expectedHash']
  try {
    const official = urls.find(url => url.startsWith(hosts[1]))!
    const hash = (await fetchTextWithRetry(`${official}.sha1`, { attempts: 1, timeoutMs: 5_000, signal: options.signal })).trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{40}$/i.test(hash)) throw new Error('安装器 SHA-1 格式无效')
    expectedHash = { algorithm: 'sha1', value: hash }
  } catch (error) {
    options.signal?.throwIfAborted()
    diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'installer-checksum', phase: 'unavailable', level: 'warning', message: 'Installer checksum unavailable; requiring JAR content validation', error })
  }
  await verifiedDownload.download({
    sources: urls.map((url, index) => ({ id: `loader-${index}`, label: index === 0 ? 'BMCLAPI' : `${options.loader} 官方源`, url })),
    destination: request.destination, expectedHash, validate, maxBytes: 128 * 1024 * 1024,
    retriesPerSource: 2, signal: options.signal, trackActivity: false, onProgress: options.onProgress
  })
}
