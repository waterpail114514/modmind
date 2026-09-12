import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { diagnosticJournal } from './diagnosticLog'
import { downloadActivities } from './downloadActivityService'
import { disposeResponseBody, proxiedUndiciRequest, retryAfterDelay } from './networkRequest'
import { setTimeout as delay } from 'node:timers/promises'

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
  retriesPerSource?: number
  trackActivity?: boolean
  signal?: AbortSignal
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
const DEFAULT_TIMEOUT_MS = 15 * 60_000
// Total attempts per source. Defaults: one retry for permanent responses,
// two retries for transient network failures.
const DEFAULT_RETRIES = 3

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

function abortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
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
  timeoutMs: number
): Promise<{ bytes: number; hash?: string }> {
  const response = await proxiedUndiciRequest(source.url, {
    method: 'GET',
    headers: { 'User-Agent': 'ModMind/1.3 (verified-download)', ...(source.headers ?? {}) },
    signal: abortSignal(request.signal, timeoutMs),
    bodyTimeout: timeoutMs,
    headersTimeout: Math.min(timeoutMs, 60_000),
    requireHttpsRedirects: true
  })
  try {
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.statusCode}`), { retryAfterMs: retryAfterDelay(response.headers.get('retry-after'), 250) })
    if (!isAllowedDownloadUrl(source.url)) throw new Error('redirected to a non-HTTPS URL')
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('invalid response content length')
    if (declared > maxBytes) throw new Error(`content length ${declared} exceeds ${maxBytes}`)
    const total = declared || undefined
    let bytes = 0
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
    const hasher = request.expectedHash ? hashStream(request.expectedHash.algorithm) : undefined
    await fs.mkdir(path.dirname(partial), { recursive: true })
    const input = response.body as unknown as NodeJS.ReadableStream
    const output = createWriteStream(partial, { flags: 'w', mode: 0o600 })
    if (hasher) await pipeline(input, meter, hasher, output)
    else await pipeline(input, meter, output)
    if (!bytes) throw new Error('download returned an empty file')
    if (declared && bytes !== declared) throw new Error('content length mismatch')
    const hash = hasher ? (hasher as Transform & { digest?: string }).digest : undefined
    if (request.expectedHash && hash?.toLowerCase() !== request.expectedHash.value.toLowerCase()) {
      throw new Error(`${request.expectedHash.algorithm} mismatch: expected ${request.expectedHash.value}, got ${hash ?? 'unknown'}`)
    }
    return { bytes, hash }
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
    const operation = this.performDownload(request)
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
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const configuredRetries = request.retriesPerSource === undefined
      ? undefined
      : Math.min(Math.max(Math.floor(request.retriesPerSource), 1), 5)
    const retries = configuredRetries ?? DEFAULT_RETRIES
    const failures: DownloadAttemptFailure[] = []
    const destination = path.resolve(request.destination)
    const partial = `${destination}.partial-${randomUUID()}`
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
      data: { downloadId, destination, sources: sources.map(diagnosticSource), maxBytes, timeoutMs, retriesPerSource: retries, expectedHash: request.expectedHash?.algorithm }
    })
    try {
      for (const source of sources) {
        for (let attempt = 1; attempt <= retries; attempt += 1) {
          attempts += 1
          await fs.rm(partial, { force: true }).catch(() => undefined)
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
            request.signal?.throwIfAborted()
            await fs.rename(partial, destination)
            diagnosticJournal.record({
              subsystem: 'download',
              operation: 'verified-download',
              phase: 'success',
              message: `Downloaded and verified ${path.basename(destination)}`,
              durationMs: Date.now() - startedAt,
              data: { downloadId, source: diagnosticSource(source), bytes: result.bytes, attempts, previousFailures: failures }
            })
            downloadActivities.complete(activityId, `已从 ${source.label} 下载${request.expectedHash ? `并通过 ${request.expectedHash.algorithm} 校验` : '（上游未提供校验值）'}`)
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
      await fs.rm(partial, { force: true }).catch(() => undefined)
    }
  }
}

export const verifiedDownload = new DownloadManager()
