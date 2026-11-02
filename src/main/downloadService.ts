import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { diagnosticJournal } from './diagnosticLog'
import { downloadActivities } from './downloadActivityService'
import { retryTransientFileLock } from './fileLockRetry'
import { disposeResponseBody, proxiedUndiciRequest, retryAfterDelay } from './networkRequest'
import { setTimeout as delay } from 'node:timers/promises'
import { withToolInstallLock } from './managedToolInstall'
import { readDiagnosticNodeResponse } from './networkDiagnostics'

export type DownloadHashAlgorithm = 'sha1' | 'sha256' | 'sha512' | 'md5'

export interface DownloadSource {
  id: string
  label: string
  url: string
  headers?: Record<string, string>
}

export interface DownloadRequest {
  sources: DownloadSource[]
  destination: string
  activityLabel?: string
  expectedHash?: { algorithm: DownloadHashAlgorithm; value: string }
  maxBytes?: number
  timeoutMs?: number
  /** Time without response data; unlike timeoutMs, progressing transfers may continue. */
  stallTimeoutMs?: number
  headersTimeoutMs?: number
  /** Persist resumable, hash-verified partial files. Serialized per destination. */
  resume?: boolean
  retriesPerSource?: number
  trackActivity?: boolean
  signal?: AbortSignal
  validate?: (file: string) => Promise<void>
  onAttempt?: (progress: { source: DownloadSource; attempt: number; attemptsPerSource: number }) => void
  onProgress?: (progress: { source: DownloadSource; downloaded: number; total?: number }) => void
}

export interface DownloadAttemptFailure {
  source: DownloadSource
  attempt: number
  message: string
}

export interface DownloadResult {
  source: DownloadSource
  destination: string
  bytes: number
  hash?: string
  attempts: number
  failures: DownloadAttemptFailure[]
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_STALL_TIMEOUT_MS = 180_000
// Total attempts per source. Defaults: one retry for permanent responses,
// two retries for transient network failures.
const DEFAULT_RETRIES = 3
const destinationQueues = new Map<string, Promise<void>>()

function destinationQueueKey(destination: string): string {
  const normalized = path.normalize(destination)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Serialize promotion of files to the same destination across all managers in
 * this process. Windows can report EPERM when two partial files are renamed to
 * one target at the same time; the queue keeps that normal user action from
 * becoming a failed download while still allowing different destinations to
 * transfer in parallel.
 */
async function withDestinationQueue<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const key = destinationQueueKey(destination)
  const previous = destinationQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  destinationQueues.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (destinationQueues.get(key) === current) destinationQueues.delete(key)
  }
}

function isPermanentDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\bHTTP\s+(\d{3})\b/i)
  if (match) {
    const status = Number(match[1])
    if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return true
  }
  return /(?:mismatch|empty file|exceeds|maxBytes|non-HTTPS|invalid response|content length)/i.test(message)
}

function normalizeSources(sources: DownloadSource[]): DownloadSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    if (!source || !isAllowedDownloadUrl(source.url) || !source.id || seen.has(source.url)) return false
    seen.add(source.url)
    return true
  })
}

function isAllowedDownloadUrl(value: string): boolean {
  if (/^https:\/\//i.test(value)) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
  } catch {
    return false
  }
}

function abortSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function diagnosticSource(source: DownloadSource): { id: string; label: string; url: string } {
  try {
    const url = new URL(source.url)
    return { id: source.id, label: source.label, url: `${url.origin}${url.pathname}` }
  } catch {
    return { id: source.id, label: source.label, url: source.url }
  }
}

function downloadDisplayName(destination: string): string {
  return path.basename(destination)
    .replace(/\.partial-\d+-\d+$/i, '')
    .replace(/^modmind-\d+-\d+-/i, '')
}

function hashStream(algorithm: DownloadHashAlgorithm): Transform {
  const hash = createHash(algorithm)
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      ;(this as Transform & { digest?: string }).digest = hash.digest('hex')
      callback()
    }
  })
}

async function streamDownload(
  source: DownloadSource,
  partial: string,
  request: DownloadRequest,
  maxBytes: number,
  timeoutMs?: number
): Promise<{ bytes: number; hash?: string }> {
  const resumable = Boolean(request.resume && request.expectedHash)
  const stat = resumable ? await fs.lstat(partial).catch(() => null) : null
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid partial download file')
  let offset = stat?.size ?? 0
  const metadataFile = `${partial}.json`
  const previous = offset ? await fs.readFile(metadataFile, 'utf8').then(text => JSON.parse(text) as { etag?: string; modified?: string; total?: number }).catch(() => ({} as { etag?: string; modified?: string; total?: number })) : undefined
  if (offset > maxBytes) { await fs.unlink(partial); offset = 0 }
  const response = await proxiedUndiciRequest(source.url, {
    method: 'GET',
    headers: { 'User-Agent': 'ModMind/1.3 (verified-download)', ...(source.headers ?? {}), ...(resumable ? { 'Accept-Encoding': 'identity' } : {}), ...(offset ? { Range: `bytes=${offset}-`, ...((previous?.etag && !previous.etag.startsWith('W/') || previous?.modified) ? { 'If-Range': previous?.etag && !previous.etag.startsWith('W/') ? previous.etag : previous!.modified! } : {}) } : {}) },
    signal: abortSignal(request.signal, timeoutMs),
    bodyTimeout: request.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    headersTimeout: request.headersTimeoutMs ?? 60_000,
    requireHttpsRedirects: true
  })
  let bytes = 0
  try {
    diagnosticJournal.record({
      subsystem: 'download', operation: 'verified-download', phase: 'response',
      message: `Received download response for ${path.basename(request.destination)}`,
      data: { source: diagnosticSource(source), finalUrl: diagnosticSource({ ...source, url: response.finalUrl ?? source.url }).url, status: response.statusCode, contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'), proxyMode: response.proxyMode }
    })
    if (response.statusCode === 416 && offset) { await fs.unlink(partial); throw new Error('Range no longer available; restart download') }
    if (!response.ok) {
      const body = await readDiagnosticNodeResponse(response.body as unknown as Readable)
      for (const [name, value] of Object.entries(source.headers ?? {})) {
        if (!/authorization|cookie|token|api.?key|secret|credential/i.test(name)) continue
        const credential = value.replace(/^(?:Bearer|Basic)\s+/i, '')
        if (credential.length >= 4) body.text = body.text.replaceAll(credential, '[REDACTED]')
      }
      throw Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode,
        responseBody: body.text, responseTruncated: body.truncated, responseBodyTimedOut: body.timedOut, responseBodyIncomplete: body.incomplete,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
        retryAfterMs: retryAfterDelay(response.headers.get('retry-after'), 250) })
    }
    if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[3]) > maxBytes || Number(range[2]) + 1 !== Number(range[3]) || (previous?.total && Number(range[3]) !== previous.total) || (previous?.etag && response.headers.get('etag') && previous.etag !== response.headers.get('etag'))) {
        await fs.rm(partial, { force: true }); throw new Error('invalid response content range')
      }
    } else offset = 0 // Server ignored Range or changed the resource: overwrite safely.
    bytes = offset
    if (!isAllowedDownloadUrl(source.url)) throw new Error('redirected to a non-HTTPS URL')
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('invalid response content length')
    if (declared + offset > maxBytes) throw new Error(`content length ${declared + offset} exceeds ${maxBytes}`)
    const total = declared ? declared + offset : undefined
    if (resumable) {
      await fs.mkdir(path.dirname(partial), { recursive: true })
      const temporaryMetadata = `${metadataFile}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporaryMetadata, JSON.stringify({ etag: response.headers.get('etag'), modified: response.headers.get('last-modified'), total }), { flag: 'wx', mode: 0o600 })
        await fs.rename(temporaryMetadata, metadataFile)
      } finally { await fs.rm(temporaryMetadata, { force: true }) }
    }
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > maxBytes) {
          callback(new Error(`download exceeds ${maxBytes} bytes`))
          return
        }
        request.onProgress?.({ source, downloaded: bytes, total })
        callback(null, chunk)
      }
    })
    const hasher = request.expectedHash && !resumable ? hashStream(request.expectedHash.algorithm) : undefined
    await fs.mkdir(path.dirname(partial), { recursive: true })
    const input = response.body as unknown as NodeJS.ReadableStream
    const output = createWriteStream(partial, { flags: offset ? 'a' : 'w', mode: 0o600 })
    if (hasher) await pipeline(input, meter, hasher, output)
    else await pipeline(input, meter, output)
    if (!bytes) throw new Error('download returned an empty file')
    if (declared && bytes !== declared + offset) throw new Error('content length mismatch')
    let hash = hasher ? (hasher as Transform & { digest?: string }).digest : undefined
    if (resumable && request.expectedHash) {
      const digest = createHash(request.expectedHash.algorithm)
      for await (const chunk of createReadStream(partial)) { request.signal?.throwIfAborted(); digest.update(chunk) }
      hash = digest.digest('hex')
    }
    if (request.expectedHash && hash?.toLowerCase() !== request.expectedHash.value.toLowerCase()) {
      await fs.rm(partial, { force: true })
      throw new Error(`${request.expectedHash.algorithm} mismatch: expected ${request.expectedHash.value}, got ${hash ?? 'unknown'}`)
    }
    await request.validate?.(partial)
    return { bytes, hash }
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'download', operation: 'verified-download', phase: 'transfer-failed', level: 'warning', message: `Download transfer or validation failed for ${path.basename(request.destination)}`, data: { source: diagnosticSource(source), bytes }, error })
    throw error
  } finally { disposeResponseBody(response) }
}

export class DownloadManager {
  private readonly shutdownController = new AbortController()
  private readonly pending = new Set<Promise<DownloadResult>>()
  beginShutdown(): void { this.shutdownController.abort() }
  async shutdown(): Promise<void> {
    this.beginShutdown()
    await Promise.allSettled([...this.pending])
  }

  download(request: DownloadRequest): Promise<DownloadResult> {
    request = { ...request, signal: AbortSignal.any([this.shutdownController.signal, ...(request.signal ? [request.signal] : [])]) }
    const operation = request.resume && request.expectedHash
      ? withToolInstallLock(`${path.resolve(request.destination)}.download`, request.signal, () => this.performDownload(request))
      : this.performDownload(request)
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined)
    return operation
  }

  private async performDownload(request: DownloadRequest): Promise<DownloadResult> {
    if (this.shutdownController.signal.aborted) throw new Error('应用正在退出，不能开始下载')
    request = { ...request, signal: AbortSignal.any([this.shutdownController.signal, ...(request.signal ? [request.signal] : [])]) }

    const sources = normalizeSources(request.sources)
    if (!sources.length) throw new Error('no valid HTTPS download sources were provided')
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
    const timeoutMs = request.timeoutMs
    request.signal?.throwIfAborted()
    for (const limit of [maxBytes, timeoutMs, request.stallTimeoutMs, request.headersTimeoutMs]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Invalid download size or timeout limit')
    }
    if (request.resume && request.expectedHash) {
      const cached = await fs.lstat(request.destination).catch(() => null)
      if (cached?.isFile() && !cached.isSymbolicLink() && cached.size > 0 && cached.size <= maxBytes) {
        const digest = createHash(request.expectedHash.algorithm)
        for await (const chunk of createReadStream(request.destination)) { request.signal?.throwIfAborted(); digest.update(chunk) }
        const hash = digest.digest('hex')
        if (hash.toLowerCase() === request.expectedHash.value.toLowerCase()) {
          await request.validate?.(request.destination)
          return { source: { ...sources[0], id: 'cache', label: '已校验的本地缓存' }, destination: path.resolve(request.destination), bytes: cached.size, hash, attempts: 0, failures: [] }
        }
      }
    }
    const configuredRetries = request.retriesPerSource === undefined
      ? undefined
      : Math.min(Math.max(Math.floor(request.retriesPerSource), 1), 5)
    const retries = configuredRetries ?? DEFAULT_RETRIES
    const failures: DownloadAttemptFailure[] = []
    const destination = path.resolve(request.destination)
    let partial = `${destination}.partial-${randomUUID()}`
    const resumable = Boolean(request.resume && request.expectedHash)
    const downloadId = randomUUID()
    const activityId = request.trackActivity === false
      ? ''
      : downloadActivities.start({
          label: request.activityLabel?.trim() || downloadDisplayName(destination),
          detail: sources[0]?.label ?? '正在连接下载源'
        })
    let lastActivityReportedAt = 0
    const startedAt = Date.now()
    let attempts = 0
    diagnosticJournal.record({
      subsystem: 'download',
      operation: 'verified-download',
      phase: 'start',
      message: `Starting verified download to ${path.basename(destination)}`,
    data: { downloadId, destination, sources: sources.map(diagnosticSource), maxBytes, timeoutMs, stallTimeoutMs: request.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS, headersTimeoutMs: request.headersTimeoutMs ?? 60_000, resumable, retriesPerSource: retries, expectedHash: request.expectedHash?.algorithm }
    })
    try {
      for (const source of sources) {
        if (resumable) partial = `${destination}.partial-${createHash('sha256').update(JSON.stringify([source.url, request.expectedHash])).digest('hex').slice(0, 24)}`
        for (let attempt = 1; attempt <= retries; attempt += 1) {
          attempts += 1
          if (!resumable) await fs.rm(partial, { force: true }).catch(() => undefined)
          const attemptStartedAt = Date.now()
          let lastReportedAt = 0
          let lastReportedPercent = -1
          diagnosticJournal.record({
            subsystem: 'download',
            operation: 'verified-download',
            phase: 'attempt',
            message: `Downloading ${path.basename(destination)} from ${source.label} (${attempt}/${retries})`,
            data: { downloadId, attempt, source: diagnosticSource(source) }
          })
          request.onAttempt?.({ source, attempt, attemptsPerSource: retries })
          downloadActivities.update(activityId, { detail: `${source.label} · 第 ${attempt}/${retries} 次尝试`, downloadedBytes: 0 })
          try {
            const originalProgress = request.onProgress
            const result = await streamDownload(source, partial, {
              ...request,
              onProgress: (progress) => {
                originalProgress?.(progress)
                const percent = progress.total ? Math.floor(progress.downloaded / progress.total * 20) * 5 : -1
                const now = Date.now()
                if (now - lastActivityReportedAt >= 100 || (progress.total !== undefined && progress.downloaded >= progress.total)) {
                  lastActivityReportedAt = now
                  downloadActivities.update(activityId, {
                    detail: progress.source.label,
                    downloadedBytes: progress.downloaded,
                    ...(progress.total !== undefined ? { totalBytes: progress.total } : {})
                  })
                }
                if (percent === lastReportedPercent && now - lastReportedAt < 5_000) return
                lastReportedPercent = percent
                lastReportedAt = now
                diagnosticJournal.record({
                  subsystem: 'download',
                  operation: 'verified-download',
                  phase: 'progress',
                  message: `Downloading ${path.basename(destination)} from ${source.label}`,
                  data: { downloadId, attempt, downloaded: progress.downloaded, total: progress.total, percent: percent >= 0 ? percent : undefined }
                })
              }
            }, maxBytes, timeoutMs)
            await fs.mkdir(path.dirname(destination), { recursive: true })
            const promote = async () => {
              request.signal?.throwIfAborted()
              await retryTransientFileLock(() => fs.rename(partial, destination))
            }
            if (resumable) await promote()
            else await withDestinationQueue(destination, promote)
            if (resumable) for (const candidate of sources) {
              const completedPartial = `${destination}.partial-${createHash('sha256').update(JSON.stringify([candidate.url, request.expectedHash])).digest('hex').slice(0, 24)}`
              await fs.rm(completedPartial, { force: true }).catch(() => undefined)
              await fs.rm(`${completedPartial}.json`, { force: true }).catch(() => undefined)
            }
            diagnosticJournal.record({
              subsystem: 'download',
              operation: 'verified-download',
              phase: 'success',
              message: `Downloaded and verified ${path.basename(destination)}`,
              durationMs: Date.now() - startedAt,
              data: { downloadId, source: diagnosticSource(source), bytes: result.bytes, attempts, previousFailures: failures }
            })
            downloadActivities.complete(activityId, `已从 ${source.label} 下载${request.expectedHash ? `并通过 ${request.expectedHash.algorithm} 校验` : request.validate ? '并通过内容校验' : '（上游未提供校验值）'}`)
            return { source, destination, bytes: result.bytes, ...(result.hash ? { hash: result.hash } : {}), attempts, failures }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push({ source, attempt, message })
            diagnosticJournal.record({
              subsystem: 'download',
              operation: 'verified-download',
              phase: 'attempt-failed',
              level: 'warning',
              message: `Download attempt failed for ${path.basename(destination)} from ${source.label}`,
              durationMs: Date.now() - attemptStartedAt,
              data: { downloadId, attempt, source: diagnosticSource(source) },
              error
            })
            if (request.signal?.aborted) throw Object.assign(new Error('download cancelled'), { name: 'AbortError', cause: error })
            if (/^(?:ENOSPC|EACCES|EPERM|EROFS|EBUSY)$/.test((error as NodeJS.ErrnoException)?.code ?? '')) throw error
            if (/^HTTP (?:400|401|403|404|410)\b/.test(message)) break
            const maxAttempts = configuredRetries ?? (isPermanentDownloadError(error) ? 2 : 3)
            if (attempt < maxAttempts) await delay((error as { retryAfterMs?: number })?.retryAfterMs ?? 250 * attempt, undefined, { signal: request.signal })
            else break
          }
        }
      }
      const detail = failures.map((failure) => `${failure.source.label}#${failure.attempt}: ${failure.message}`).join('; ')
      throw new Error(`all download sources failed${detail ? `: ${detail}` : ''}`)
    } catch (error) {
      diagnosticJournal.record({
        subsystem: 'download',
        operation: 'verified-download',
        phase: request.signal?.aborted ? 'cancelled' : 'error',
        message: request.signal?.aborted ? `Download cancelled for ${path.basename(destination)}` : `Download failed for ${path.basename(destination)}`,
        durationMs: Date.now() - startedAt,
        data: { downloadId, attempts, failures },
        error
      })
      downloadActivities.fail(activityId, error)
      throw error
    } finally {
      if (!resumable) await fs.rm(partial, { force: true }).catch(() => undefined)
    }
  }
}

export const verifiedDownload = new DownloadManager()
