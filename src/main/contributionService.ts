import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { retryTransientFileLock } from './fileLockRetry'
import {
  CONTRIBUTION_CONFIRM_MS, CONTRIBUTION_MAX_REPORT_BYTES, CONTRIBUTION_TERMS_VERSION,
  CONTRIBUTION_TICKET_URL, CONTRIBUTION_UPLOAD_URL,
  type ContributionChallenge, type ContributionMetric, type ContributionPreview,
  type ContributionReport, type ContributionState, type ContributionUploadTicket
} from '../shared/contributions'

// Exact names only. Never derive telemetry fields from input, output, errors or UI text.
const FEATURES: Readonly<Record<string, string>> = {
  'project:create': 'project.create', 'project:createDraft': 'project.draft',
  'project:initializeDraft': 'project.initialize', 'project:adoptExisting': 'project.import',
  'project:openRecent': 'project.open', 'project:writeFile': 'file.save',
  'project:migrate': 'project.migrate', 'ai:createCode': 'ai.task',
  'ai:cancelCode': 'ai.cancel', 'ai:resumeRecovery': 'ai.recover',
  'build:preflight': 'build.preflight', 'minecraft:buildProject': 'build.project',
  'minecraft:launch': 'game.launch', 'minecraft:testLaunch': 'game.test-launch',
  'modpack:importContent': 'content.import', 'modpack:downloadContent': 'content.download',
  'modpack:installProviderFile': 'content.install', 'modpack:searchProviders': 'content.search',
  'modpack:applyPlan': 'modpack.apply', 'modpack:buildServerPack': 'server.export',
  'modpack:startServer': 'server.start', 'modpack:runServerScenario': 'server.test',
  'modpack:verifyServerJoin': 'server.verify-join', 'modpack:saveFtbQuestBook': 'quests.save',
  'modpack:writePatchouliBook': 'patchouli.save', 'release:publish': 'release.publish',
  'snapshots:create': 'snapshot.create', 'snapshots:restore': 'snapshot.restore',
  'blockbench:show': 'model.open', 'blockbench:saveAssetBundle': 'model.save',
  'blockbench:captureViews': 'model.preview', 'feature-plugins:invoke': 'extension.call'
}
const FEATURE_NAMES = new Set([...Object.values(FEATURES), 'app.start'])
const DURATIONS: ContributionMetric['duration'][] = ['<100ms', '<1s', '<10s', '<60s', '>=60s']
const OUTCOMES = new Set(['returned', 'failed', 'cancelled'])
const MAX_QUEUE_BYTES = 2 * 1024 * 1024
const MAX_REPORTS = 100
const MAX_AGE_MS = 7 * 86400_000
const MAX_DAILY_BYTES = 1024 * 1024
type Entry = { folder: string; report: ContributionReport }
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>

export function contributionFolder(username: string | undefined, seed: string): string {
  const owner = username?.trim()
  const original = owner || 'guest'
  const safe = original.normalize('NFKC').replace(/[\p{C}<>:"/\\|?*%.$]/gu, '_').replace(/\s+/g, '_').slice(0, 80) || 'user'
  const hash = createHash('sha256').update(`${seed}\0${owner ? 'account:' : 'guest:'}${original}`).digest('hex').slice(0, 10)
  return `${safe}_${hash}`
}

function validReport(input: unknown): input is ContributionReport {
  if (!input || typeof input !== 'object') return false
  const r = input as ContributionReport
  if (Object.keys(r).sort().join(',') !== 'appVersion,arch,day,format,id,metrics,platform,schemaVersion,termsVersion') return false
  return r.format === 'modmind-contribution' && r.schemaVersion === 1 && r.termsVersion === CONTRIBUTION_TERMS_VERSION
    && /^[a-f0-9-]{36}$/.test(r.id) && /^\d{4}-\d{2}-\d{2}$/.test(r.day)
    && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(r.appVersion)
    && ['win32', 'darwin', 'linux', 'other'].includes(r.platform) && ['x64', 'arm64', 'ia32', 'other'].includes(r.arch)
    && Array.isArray(r.metrics) && r.metrics.length <= 256 && r.metrics.every(m =>
      m && Object.keys(m).sort().join(',') === 'count,duration,feature,outcome'
      && FEATURE_NAMES.has(m.feature) && OUTCOMES.has(m.outcome) && DURATIONS.includes(m.duration)
      && Number.isInteger(m.count) && m.count > 0 && m.count <= 1_000_000)
}

async function boundedJson(response: Response, max: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('network')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > max) throw new Error('size')
      parts.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined) }
}

export function parseContributionTicket(value: unknown, now: number): ContributionUploadTicket {
  if (!value || typeof value !== 'object') throw new Error('ticket')
  const t = value as ContributionUploadTicket
  if (t.format !== 'modmind-contribution-upload' || t.schemaVersion !== 1 || t.url !== CONTRIBUTION_UPLOAD_URL
    || !Number.isFinite(Date.parse(t.expiresAt)) || Date.parse(t.expiresAt) <= now + 30_000
    || Date.parse(t.expiresAt) > now + 8 * 86400_000 || t.maxBytes !== CONTRIBUTION_MAX_REPORT_BYTES
    || !t.fields || typeof t.fields !== 'object' || Array.isArray(t.fields)) throw new Error('ticket')
  const allowed = new Set(['key', 'bucket', 'Content-Type', 'Policy', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Signature'])
  if (Object.entries(t.fields).some(([k, v]) => !allowed.has(k) || typeof v !== 'string' || v.length > 12_000)
    || t.fields['Content-Type'] !== 'application/json' || t.fields['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256'
    || !/^[A-Za-z0-9]{8,128}\/\d{8}\/rainyun\/s3\/aws4_request$/.test(t.fields['X-Amz-Credential'] ?? '')
    || !/^[a-f0-9]{64}$/.test(t.fields['X-Amz-Signature'] ?? '')) throw new Error('ticket')
  const p = JSON.parse(Buffer.from(t.fields.Policy ?? '', 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] }
  if (p.expiration !== t.expiresAt || !Array.isArray(p.conditions)
    || !p.conditions.some(c => c && typeof c === 'object' && !Array.isArray(c) && (c as { bucket?: string }).bucket === 'contribute')
    || !p.conditions.some(c => Array.isArray(c) && c[0] === 'content-length-range' && c[1] === 1 && c[2] === t.maxBytes)
    || !p.conditions.some(c => Array.isArray(c) && c[0] === 'starts-with' && c[1] === '$key' && c[2] === '')) throw new Error('ticket')
  return { ...t, fields: { ...t.fields } }
}

export class ContributionService {
  private seed = randomBytes(32).toString('hex')
  private enabled = false
  private username: string | undefined
  private entries: Entry[] = []
  private current: Entry | undefined
  private phase: ContributionState['phase'] = 'disabled'
  private message = ''
  private lastUploadedAt: string | undefined
  private droppedReports = 0
  private ticket: ContributionUploadTicket | undefined
  private ticketFetchedAt = 0
  private abort: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private uploadPromise: Promise<void> | undefined
  private nextAttempt = 0
  private failures = 0
  private epoch = 0
  private stopped = false
  private closing: Promise<void> | undefined
  private daily = { day: '', bytes: 0 }
  private readonly challenges = new Map<number, { token: string; at: number }>()
  constructor(private readonly file: string, private readonly options: {
    appVersion: string; platform: string; arch: string; fetch: Fetcher; now?: () => number
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
  private get folder(): string { return contributionFolder(this.username, this.seed) }

  async initialize(): Promise<void> {
    try {
      if ((await fs.stat(this.file)).size > MAX_QUEUE_BYTES + 100_000) throw new Error('size')
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (typeof value.seed === 'string' && /^[a-f0-9]{64}$/.test(value.seed)) this.seed = value.seed
      this.enabled = value.enabled === true && value.termsVersion === CONTRIBUTION_TERMS_VERSION
      if (this.enabled && Array.isArray(value.entries)) this.entries = value.entries.filter((e: Entry) => e && typeof e.folder === 'string' && /^[^/\\\p{C}]{1,90}_[a-f0-9]{10}$/u.test(e.folder) && validReport(e.report)).slice(-MAX_REPORTS)
      if (typeof value.lastUploadedAt === 'string' && Number.isFinite(Date.parse(value.lastUploadedAt))) this.lastUploadedAt = value.lastUploadedAt
      if (value.daily && /^\d{4}-\d{2}-\d{2}$/.test(value.daily.day) && Number.isInteger(value.daily.bytes) && value.daily.bytes >= 0) this.daily = value.daily
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.message = '贡献设置无法读取，已保持关闭。'
      this.enabled = false; this.entries = []
    }
    this.prune()
    this.phase = this.enabled ? 'idle' : 'disabled'
    if (this.enabled) this.record('app.start', 'returned', 0)
    this.timer = setInterval(() => { void this.flush().catch(() => undefined) }, 60_000)
    this.timer.unref()
  }

  setUsername(username?: string): void {
    if (this.username === username) return
    this.seal(); this.username = username
    if (this.enabled) this.scheduleSave()
  }

  challenge(sender: number): ContributionChallenge {
    const token = randomUUID()
    this.challenges.set(sender, { token, at: performance.now() })
    return { token, termsVersion: CONTRIBUTION_TERMS_VERSION, waitMs: CONTRIBUTION_CONFIRM_MS, folder: this.folder }
  }

  async enable(sender: number, token: unknown, version: unknown): Promise<ContributionState> {
    const c = this.challenges.get(sender)
    if (!c || c.token !== token || version !== CONTRIBUTION_TERMS_VERSION || performance.now() - c.at < CONTRIBUTION_CONFIRM_MS || performance.now() - c.at > 5 * 60_000) throw new Error('请重新打开使用条例，阅读 3 秒后确认。')
    this.challenges.delete(sender)
    this.enabled = true; this.epoch++; this.phase = 'idle'; this.message = ''; this.nextAttempt = 0
    try { await this.save() } catch { this.enabled = false; this.phase = 'disabled'; throw new Error('贡献设置未能保存，仍保持关闭，请重试。') }
    return this.state()
  }

  async disable(): Promise<ContributionState> {
    this.enabled = false; this.epoch++; this.abort?.abort(); this.entries = []; this.current = undefined
    this.challenges.clear(); this.phase = 'disabled'; this.message = ''; this.ticket = undefined
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    await this.save()
    return this.state()
  }

  recordOperation(metric: { operation: string; outcome: ContributionMetric['outcome']; durationMs: number }): void {
    const feature = FEATURES[metric.operation]
    if (feature) this.record(feature, metric.outcome, metric.durationMs)
  }

  private record(feature: string, outcome: ContributionMetric['outcome'], ms: number): void {
    if (!this.enabled || this.stopped) return
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (this.current && (this.current.folder !== this.folder || this.current.report.day !== day)) this.seal()
    this.current ??= { folder: this.folder, report: {
      format: 'modmind-contribution', schemaVersion: 1, termsVersion: CONTRIBUTION_TERMS_VERSION,
      id: randomUUID(), day, appVersion: /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(this.options.appVersion) ? this.options.appVersion : '0.0.0',
      platform: ['win32', 'darwin', 'linux'].includes(this.options.platform) ? this.options.platform : 'other',
      arch: ['x64', 'arm64', 'ia32'].includes(this.options.arch) ? this.options.arch : 'other', metrics: []
    } }
    const duration = DURATIONS[ms < 100 ? 0 : ms < 1000 ? 1 : ms < 10000 ? 2 : ms < 60000 ? 3 : 4]
    const existing = this.current.report.metrics.find(m => m.feature === feature && m.outcome === outcome && m.duration === duration)
    if (existing) existing.count = Math.min(existing.count + 1, 1_000_000)
    else this.current.report.metrics.push({ feature, outcome, duration, count: 1 })
    if (this.current.report.metrics.length >= 250) this.seal()
    this.prune(); this.scheduleSave()
  }

  state(): ContributionState {
    const entries = [...this.entries, ...(this.current ? [this.current] : [])]
    return { enabled: this.enabled, termsVersion: CONTRIBUTION_TERMS_VERSION, folder: this.folder,
      pendingReports: entries.length, pendingBytes: entries.length ? Buffer.byteLength(JSON.stringify(entries)) : 0, phase: this.phase,
      message: this.message, lastUploadedAt: this.lastUploadedAt, ticketExpiresAt: this.ticket?.expiresAt, droppedReports: this.droppedReports }
  }
  preview(): ContributionPreview {
    const entries = [...this.entries, ...(this.current ? [this.current] : [])].filter(e => e.folder === this.folder)
    return { folder: this.folder, reports: structuredClone(entries.slice(0, 3).map(e => e.report)), truncated: entries.length > 3 }
  }
  private seal(): void { if (this.current) { this.entries.push(this.current); this.current = undefined; this.prune() } }
  private prune(): void {
    this.entries = this.entries.filter(e => {
      const keep = Date.parse(e.report.day) >= this.now() - MAX_AGE_MS
      if (!keep) this.droppedReports++
      return keep
    })
    while (this.entries.length && (this.entries.length + Number(Boolean(this.current)) > MAX_REPORTS || Buffer.byteLength(JSON.stringify([...this.entries, ...(this.current ? [this.current] : [])])) > MAX_QUEUE_BYTES)) { this.entries.shift(); this.droppedReports++ }
  }
  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save().catch(() => { this.message = '待传统计暂时无法保存，请检查磁盘空间。' }) }, 1000)
    this.saveTimer.unref()
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ seed: this.seed, enabled: this.enabled, termsVersion: CONTRIBUTION_TERMS_VERSION,
      entries: this.enabled ? [...this.entries, ...(this.current ? [this.current] : [])] : [], lastUploadedAt: this.lastUploadedAt, daily: this.daily })
    const write = this.writeChain.catch(() => undefined).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      try { await fs.writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await retryTransientFileLock(() => fs.rename(temporary, this.file)) }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    })
    this.writeChain = write
    return write
  }

  flush(): Promise<void> {
    if (this.uploadPromise) return this.uploadPromise
    if (!this.enabled || this.stopped || this.now() < this.nextAttempt) return Promise.resolve()
    this.uploadPromise = this.upload().finally(() => { this.uploadPromise = undefined })
    return this.uploadPromise
  }
  private async upload(): Promise<void> {
    this.seal(); this.prune()
    if (!this.entries.length) { this.phase = 'idle'; this.message = ''; return }
    const epoch = this.epoch
    const controller = new AbortController(); this.abort = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    this.phase = 'uploading'; this.message = ''
    try {
      if (!this.ticket || this.now() - this.ticketFetchedAt > 3600_000 || Date.parse(this.ticket.expiresAt) <= this.now() + 60_000) {
        const response = await this.options.fetch(CONTRIBUTION_TICKET_URL, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store' })
        this.ticket = parseContributionTicket(await boundedJson(response, 24 * 1024), this.now())
        this.ticketFetchedAt = this.now()
      }
      for (let i = 0; i < 5 && this.enabled && epoch === this.epoch && this.entries.length; i++) {
        const entry = this.entries[0]
        if (!validReport(entry.report)) { this.entries.shift(); this.droppedReports++; continue }
        const body = JSON.stringify(entry.report), size = Buffer.byteLength(body)
        if (size > this.ticket.maxBytes) { this.entries.shift(); this.droppedReports++; continue }
        const day = new Date(this.now()).toISOString().slice(0, 10)
        if (this.daily.day !== day) this.daily = { day, bytes: 0 }
        if (this.daily.bytes + size > MAX_DAILY_BYTES) { this.phase = 'waiting'; this.message = '今日贡献上传已达 1 MiB，明日自动继续。'; this.nextAttempt = this.now() + 3600_000; break }
        const form = new FormData()
        for (const [key, value] of Object.entries(this.ticket.fields)) if (key !== 'key') form.append(key, value)
        form.append('key', `${entry.folder}/${entry.report.day}/${entry.report.id}.json`)
        form.append('file', new Blob([body], { type: 'application/json' }), 'report.json')
        // Reserve before sending, including failed attempts, so retries/restarts cannot bypass the daily budget.
        this.daily.bytes += size
        await this.save()
        if (!this.enabled || epoch !== this.epoch) return
        signal.throwIfAborted()
        const response = await this.options.fetch(CONTRIBUTION_UPLOAD_URL, { method: 'POST', body: form, signal, redirect: 'error', credentials: 'omit' })
        await response.body?.cancel().catch(() => undefined)
        if (!response.ok) { if ([400, 403].includes(response.status)) this.ticket = undefined; throw new Error('upload') }
        if (!this.enabled || epoch !== this.epoch) return
        if (this.entries[0] === entry) this.entries.shift()
        this.lastUploadedAt = new Date(this.now()).toISOString()
        await this.save()
      }
      if (!this.enabled || epoch !== this.epoch) return
      if (this.phase === 'uploading') { this.phase = 'idle'; this.message = '' }
      this.failures = 0
    } catch {
      if (!this.enabled || epoch !== this.epoch) return
      this.phase = 'waiting'
      this.message = this.ticket ? '上传暂未完成，已保留统计并等待重试。' : '上传授权暂不可用或已过期，已保留统计，稍后自动重试。'
      this.nextAttempt = this.now() + Math.min(3600_000, 60_000 * 2 ** Math.min(this.failures++, 6))
      await this.save().catch(() => undefined)
    } finally { if (this.abort === controller) this.abort = undefined }
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    this.epoch++; this.abort?.abort()
    if (this.timer) clearInterval(this.timer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.seal()
    return this.closing = this.save()
  }
}
