import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { diagnosticJournal } from './diagnosticLog'
import { verifiedDownload } from './downloadService'
import { fetchJsonWithRetry } from './networkRequest'

interface AdoptiumAsset {
  binary?: {
    package?: { checksum?: string; link?: string; name?: string; size?: number }
  }
}

const DOWNLOAD_ATTEMPTS_PER_SOURCE = 2

export interface ManagedJdkResult {
  home: string
  major: number
  source: string
}

export interface ManagedJdkProgress {
  downloaded: number
  total: number
  source: string
}

function platformName(platform: NodeJS.Platform): 'windows' | 'linux' | 'mac' {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return 'linux'
  throw new Error(`不支持的 JDK 平台：${platform}`)
}

function architectureName(architecture: string): 'x64' | 'aarch64' {
  if (architecture === 'arm64') return 'aarch64'
  if (architecture === 'x64') return 'x64'
  throw new Error(`不支持的 JDK 架构：${architecture}`)
}

export function adoptiumMetadataUrl(major: number, platform = process.platform, architecture = process.arch): string {
  const query = new URLSearchParams({
    architecture: architectureName(architecture),
    image_type: 'jdk',
    os: platformName(platform),
    vendor: 'eclipse'
  })
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query}`
}

export function jdkDownloadSources(fileName: string, major: number, officialUrl: string, platform = process.platform, architecture = process.arch): Array<{ label: string; url: string }> {
  const suffix = `${major}/jdk/${architectureName(architecture)}/${platformName(platform)}/${encodeURIComponent(fileName)}`
  const sources = [
    { label: '清华大学 TUNA Adoptium 镜像', url: `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${suffix}` },
  ]
  if (officialUrl.startsWith('https://github.com/adoptium/')) {
    sources.push({ label: '中国科学技术大学 Adoptium 镜像', url: officialUrl.replace('https://github.com/adoptium/', 'https://mirrors.ustc.edu.cn/adoptium/releases/') })
  }
  sources.push({ label: 'Eclipse Adoptium 官方源', url: officialUrl })
  return sources
}

async function fetchAsset(major: number): Promise<Required<AdoptiumAsset>['binary']['package'] & { checksum: string; link: string; name: string }> {
  const url = adoptiumMetadataUrl(major)
  const startedAt = Date.now()
  let assets: AdoptiumAsset[]
  try {
    assets = await fetchJsonWithRetry<AdoptiumAsset[]>(url, {
      headers: { 'User-Agent': 'ModMind/1.2 (managed-jdk)' },
      attempts: 4,
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'jdk-download', operation: 'metadata', phase: 'error', message: `Unable to fetch JDK ${major} metadata`, durationMs: Date.now() - startedAt, data: { url }, error })
    throw error
  }
  const value = assets[0]?.binary?.package
  if (!value?.checksum || !value.link || !value.name || !/^[a-f0-9]{64}$/i.test(value.checksum)) {
    throw new Error(`JDK ${major} 元数据不完整`)
  }
  return { ...value, checksum: value.checksum.toLowerCase(), link: value.link, name: value.name }
}

async function downloadVerified(
  sources: Array<{ label: string; url: string }>,
  target: string,
  checksum: string,
  expectedSize: number,
  onProgress?: (progress: ManagedJdkProgress) => void
): Promise<string> {
  const result = await verifiedDownload.download({
    sources: sources.map((source, index) => ({ id: `jdk-${index + 1}`, ...source, headers: { 'User-Agent': 'ModMind/1.3 (managed-jdk)' } })),
    destination: target,
    expectedHash: { algorithm: 'sha256', value: checksum },
    maxBytes: Math.max(expectedSize || 0, 512 * 1024 * 1024),
    timeoutMs: 15 * 60_000,
    retriesPerSource: DOWNLOAD_ATTEMPTS_PER_SOURCE,
    onProgress: ({ downloaded, total, source }) => onProgress?.({ downloaded, total: total ?? expectedSize, source: source.label })
  })
  return result.source.label
}

async function extractTar(archive: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destination], { windowsHide: true, shell: false })
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `tar exited with ${code}`)))
  })
}

async function findJdkHome(root: string): Promise<string | null> {
  const executable = process.platform === 'win32' ? 'javac.exe' : 'javac'
  const direct = path.join(root, 'bin', executable)
  if (await fs.access(direct).then(() => true).catch(() => false)) return root
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name)
    if (await fs.access(path.join(candidate, 'bin', executable)).then(() => true).catch(() => false)) return candidate
    if (process.platform === 'darwin') {
      const bundle = path.join(candidate, 'Contents', 'Home')
      if (await fs.access(path.join(bundle, 'bin', executable)).then(() => true).catch(() => false)) return bundle
    }
  }
  return null
}

export async function ensureManagedJdk(
  cacheRoot: string,
  major: number,
  onProgress?: (progress: ManagedJdkProgress) => void
): Promise<ManagedJdkResult> {
  await fs.mkdir(cacheRoot, { recursive: true })
  const destination = path.join(cacheRoot, `temurin-${major}-${platformName(process.platform)}-${architectureName(process.arch)}`)
  const installed = await findJdkHome(destination).catch(() => null)
  if (installed) return { home: installed, major, source: 'ModMind JDK 缓存' }

  const asset = await fetchAsset(major)
  const temporary = await fs.mkdtemp(path.join(cacheRoot, `.temurin-${major}-`))
  const archive = path.join(os.tmpdir(), `modmind-${process.pid}-${Date.now()}-${asset.name}`)
  try {
    const source = await downloadVerified(jdkDownloadSources(asset.name, major, asset.link), archive, asset.checksum, asset.size ?? 0, onProgress)
    const extracted = path.join(temporary, 'extracted')
    await fs.mkdir(extracted, { recursive: true })
    if (asset.name.endsWith('.zip')) await extractZip(archive, { dir: extracted })
    else if (asset.name.endsWith('.tar.gz')) await extractTar(archive, extracted)
    else throw new Error(`不支持的 JDK 归档格式：${asset.name}`)
    const home = await findJdkHome(extracted)
    if (!home) throw new Error('JDK 归档中没有找到 javac')
    if (process.platform !== 'win32') {
      for (const tool of ['java', 'javac', 'javap']) await fs.chmod(path.join(home, 'bin', tool), 0o755)
    }
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(home, destination)
    return { home: destination, major, source }
  } finally {
    await fs.rm(archive, { force: true }).catch(() => undefined)
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}
