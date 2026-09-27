import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SoundDefinition } from '../shared/soundLibrary'
import { bundledSoundCatalog } from './soundCatalogBundled'
import { verifiedDownload } from './downloadService'
import { fetchJsonWithRetry } from './networkRequest'
import { resolveMinecraftVersionFromManifests, BMCLAPI_BASE_URL } from './minecraftVersionManifest'
import { AUDIO_LIMIT, readSoundBytes, safeSoundPath, soundJson, writeSoundAtomic } from './soundFiles'

type Asset = { hash: string; size: number }
type Index = { objects: Record<string, Asset> }
type Metadata = { id: string; inheritsFrom?: string; assets?: string; assetIndex?: { id: string; url: string; sha1: string } }
const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex')
export class SoundVanilla {
  private index: Index | null = null
  private checkedLocal = false
  private metadata: Metadata | null = null
  constructor(readonly version: string, readonly cache: string, readonly roots: string[]) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(version)) throw new Error('Minecraft 版本无效')
  }
  refreshLocal(): void { this.checkedLocal = false; this.index = null }
  private file(name: string): string { return path.join(this.cache, 'catalogs', this.version, name) }
  async localIndex(): Promise<Index | null> {
    if (this.index) return this.index
    if (this.checkedLocal) return null
    this.checkedLocal = true
    for (const root of this.roots) {
      const candidates: string[] = [this.version]
      const versions = await fs.readdir(path.join(root, 'versions'), { withFileTypes: true }).catch(() => [])
      for (const entry of versions) {
        if (entry.isDirectory() && entry.name !== this.version && /^[a-zA-Z0-9_.-]{1,120}$/.test(entry.name)) candidates.push(entry.name)
        if (candidates.length >= 512) break
      }
      for (const candidate of candidates) {
        try {
          const metadataPath = await safeSoundPath(root, 'versions/' + candidate + '/' + candidate + '.json')
          const meta = await soundJson<Metadata>(metadataPath)
          const matchesVersion = meta?.id === this.version || meta?.inheritsFrom === this.version || meta?.id === candidate && (candidate.endsWith('-' + this.version) || candidate.startsWith(this.version + '-'))
          if (!matchesVersion || !meta.assetIndex || !/^[a-zA-Z0-9_.-]+$/.test(meta.assetIndex.id) || !/^[a-f0-9]{40}$/.test(meta.assetIndex.sha1)) continue
          for (const indexName of new Set([meta.assetIndex.id, meta.assetIndex.sha1])) {
            const bytes = await readSoundBytes(root, 'assets/indexes/' + indexName + '.json', 8 * 1024 * 1024).catch(() => null)
            if (!bytes || sha1(bytes) !== meta.assetIndex.sha1) continue
            const parsed = JSON.parse(bytes.toString()) as Index
            if (!parsed?.objects || typeof parsed.objects !== 'object') continue
            this.metadata = meta
            this.index = parsed
            return this.index
          }
        } catch { /* Missing or corrupt local metadata falls back to the next candidate. */ }
      }
    }
    const meta = await soundJson<Metadata>(this.file('version.json')).catch(() => null)
    if (meta?.id !== this.version || !meta.assetIndex) return null
    const bytes = await fs.readFile(this.file('index.json')).catch(() => null)
    if (!bytes || sha1(bytes) !== meta.assetIndex.sha1) return null
    try { this.index = JSON.parse(bytes.toString()) as Index }
    catch { return null }
    this.metadata = meta
    return this.index?.objects ? this.index : null
  }
  async ensureIndex(signal: AbortSignal): Promise<Index> {
    this.refreshLocal()
    const local = await this.localIndex()
    if (local) return local
    const resolved = await resolveMinecraftVersionFromManifests<{ id: string; url: string }>(this.version, source => fetchJsonWithRetry(source.url, { attempts: 1, signal }))
    const meta = await fetchJsonWithRetry<Metadata>(resolved.version.url, { attempts: 1, signal })
    if (meta.id !== this.version || !meta.assetIndex || !/^https:\/\//.test(meta.assetIndex.url) || !/^[a-f0-9]{40}$/.test(meta.assetIndex.sha1)) throw new Error('原版资源索引无效')
    await verifiedDownload.download({ sources: [{ id: 'mojang-index', label: '原版声音索引', url: meta.assetIndex.url }], destination: this.file('index.json'), expectedHash: { algorithm: 'sha1', value: meta.assetIndex.sha1 }, maxBytes: 8 * 1024 * 1024, timeoutMs: 20000, retriesPerSource: 1, signal })
    await writeSoundAtomic(this.file('version.json'), JSON.stringify(meta))
    this.metadata = meta
    this.index = await soundJson<Index>(this.file('index.json'))
    this.checkedLocal = false
    if (!this.index?.objects) throw new Error('原版资源索引没有资源条目')
    return this.index
  }
  async catalog(): Promise<{ definitions: Record<string, SoundDefinition>; language: Record<string, string> } | null> {
    const bundled = bundledSoundCatalog(this.version)
    if (bundled) return bundled
    const saved = await soundJson<{ definitions: Record<string, SoundDefinition>; language: Record<string, string> }>(this.file('sounds.json')).catch(() => null)
    if (saved) return saved
    const bytes = await this.bytes('minecraft/sounds.json', false).catch(() => null)
    if (!bytes) return null
    return { definitions: JSON.parse(bytes.toString()), language: {} }
  }
  async fetchCatalog(signal: AbortSignal): Promise<void> {
    await this.ensureIndex(signal)
    const bytes = await this.bytes('minecraft/sounds.json', true, signal)
    const languageBytes = await this.bytes('minecraft/lang/zh_cn.json', true, signal).catch(error => { signal.throwIfAborted(); return null })
    const language = languageBytes ? JSON.parse(languageBytes.toString()) : {}
    const definitions = JSON.parse(bytes.toString()) as Record<string, SoundDefinition>
    await writeSoundAtomic(this.file('sounds.json'), JSON.stringify({ definitions, language }))
  }
  async info(name: string): Promise<Asset | undefined> { return (await this.localIndex())?.objects[name] }
  async hasLocalAudio(name: string): Promise<boolean> {
    const entry = await this.info(name)
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.hash) || !Number.isFinite(entry.size) || entry.size < 1 || entry.size > AUDIO_LIMIT) return false
    for (const root of this.roots) {
      const file = path.join(root, 'assets', 'objects', entry.hash.slice(0, 2), entry.hash)
      const stat = await fs.lstat(file).catch(() => null)
      if (stat?.isFile() && stat.size === entry.size) return true
    }
    const cached = await fs.lstat(path.join(this.cache, 'audio', entry.hash)).catch(() => null)
    return Boolean(cached?.isFile() && cached.size === entry.size)
  }
  async bytes(name: string, download: boolean, signal = new AbortController().signal): Promise<Buffer> {
    const index = download ? await this.ensureIndex(signal) : await this.localIndex()
    const entry = index?.objects[name]
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.hash)) {
      throw new Error(index ? '此原版声音不在当前版本资源索引中' : '原版资源索引不存在，请先准备 Minecraft 实例或获取资源索引')
    }
    if (!Number.isFinite(entry.size) || entry.size < 1 || entry.size > AUDIO_LIMIT) throw new Error('单个声音资源超过 64 MiB 限制')
    for (const root of this.roots) {
      const bytes = await readSoundBytes(root, 'assets/objects/' + entry.hash.slice(0, 2) + '/' + entry.hash).catch(() => null)
      if (bytes && sha1(bytes) === entry.hash) return bytes
    }
    const target = path.join(this.cache, 'audio', entry.hash)
    const cached = await fs.readFile(target).catch(() => null)
    if (cached && sha1(cached) === entry.hash) { await fs.utimes(target, new Date(), new Date()).catch(() => undefined); return cached }
    if (!download) throw new Error('此音频尚未下载，选择“下载并试听”按需获取')
    await verifiedDownload.download({ sources: [{ id: 'mojang-sound', label: '原版声音', url: 'https://resources.download.minecraft.net/' + entry.hash.slice(0, 2) + '/' + entry.hash }, { id: 'bmcl-sound', label: '原版声音镜像', url: BMCLAPI_BASE_URL + '/assets/' + entry.hash.slice(0, 2) + '/' + entry.hash }], destination: target, expectedHash: { algorithm: 'sha1', value: entry.hash }, maxBytes: Math.min(AUDIO_LIMIT, entry.size), timeoutMs: 45000, retriesPerSource: 1, signal })
    const bytes = await fs.readFile(target)
    await this.prune()
    return bytes
  }
  async prune(clear = false): Promise<void> {
    const directory = path.join(this.cache, 'audio')
    const entries = await fs.readdir(directory).catch(() => [])
    const files = (await Promise.all(entries.filter(name => /^[a-f0-9]{40}$/.test(name)).map(async name => ({ file: path.join(directory, name), stat: await fs.stat(path.join(directory, name)) })))).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    let bytes = 0
    for (const file of files) { bytes += file.stat.size; if (clear || bytes > 256 * 1024 * 1024 || Date.now() - file.stat.mtimeMs > 90 * 86400000) await fs.rm(file.file, { force: true }) }
  }
}
