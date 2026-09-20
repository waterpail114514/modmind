import { redactDiagnosticText } from '../shared/redactDiagnosticText'
export { redactDiagnosticText } from '../shared/redactDiagnosticText'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isExpectedCancellation } from '../shared/diagnostics'

export type DiagnosticLevel = 'debug' | 'info' | 'warning' | 'error'

export interface DiagnosticError {
  name: string
  message: string
  stack?: string
  componentStack?: string
  code?: string
  cause?: DiagnosticError
  errors?: DiagnosticError[]
  details?: unknown
}

export interface DiagnosticEvent {
  id: string
  sessionId: string
  time: string
  pid: number
  level: DiagnosticLevel
  subsystem: string
  operation: string
  phase: string
  message: string
  durationMs?: number
  project?: {
    name?: string
    namespace?: string
    kind?: string
    loader?: string
    minecraftVersion?: string
  }
  data?: unknown
  error?: DiagnosticError
}

export interface DiagnosticRecordInput {
  level?: DiagnosticLevel
  subsystem: string
  operation: string
  phase?: string
  message: string
  durationMs?: number
  data?: unknown
  error?: unknown
}

export interface DiagnosticJournalStatus {
  sessionId: string
  logFile?: string
  bufferedEvents: number
  criticalFile?: string
  pendingEvents: number
  pendingBytes: number
  oldestPendingAgeMs: number
  droppedEvents: number
  writeFailures: number
  rotations: number
  lastSuccessfulWriteAt?: string
  lastWriteError?: string
}

interface DiagnosticJournalOptions {
  maxFileBytes?: number
  maxBufferedEvents?: number
  maxPendingBytes?: number
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_BUFFERED_EVENTS = 2_000
const MAX_TEXT_LENGTH = 64_000
const MAX_ARRAY_LENGTH = 100
const MAX_OBJECT_KEYS = 100
const MAX_SANITIZE_DEPTH = 6
const SENSITIVE_KEY = /(?:authorization|cookie|credential|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|captcha)/i

function boundedText(value: string, limit = MAX_TEXT_LENGTH): string {
  const redacted = redactDiagnosticText(value)
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}\n[TRUNCATED ${redacted.length - limit} CHARS]`
}


function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (typeof value === 'string') return boundedText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth >= MAX_SANITIZE_DEPTH) return '[MAX_DEPTH]'
  if (value instanceof Error) return serializeError(value, depth, seen)
  if (Buffer.isBuffer(value)) return { type: 'Buffer', bytes: value.byteLength }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_LENGTH) items.push(`[TRUNCATED ${value.length - MAX_ARRAY_LENGTH} ITEMS]`)
    return items
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
    for (const [key, entry] of entries) output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(entry, depth + 1, seen)
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) output.__truncated = true
    return output
  }
  return boundedText(String(value))
}

function serializeError(error: unknown, depth = 0, seen = new WeakSet<object>()): DiagnosticError {
  if (!(error instanceof Error)) return {
    name: 'Error',
    message: boundedText(error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)),
    ...(error && typeof error === 'object' ? { details: sanitizeValue(error, depth + 1, seen) } : {})
  }
  if (seen.has(error)) return { name: error.name || 'Error', message: '[CIRCULAR ERROR]' }
  seen.add(error)
  const code = 'code' in error && typeof (error as Error & { code?: unknown }).code !== 'undefined'
    ? String((error as Error & { code?: unknown }).code)
    : undefined
  const cause = depth < 5 && 'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined
  const errors = depth < 5 && error instanceof AggregateError ? error.errors.slice(0, 25).map((entry) => serializeError(entry, depth + 1, seen)) : undefined
  // Provider SDKs attach status, request IDs, bodies and headers to Error objects.
  // Preserve these fields as well as the standard, non-enumerable message/stack/cause.
  const details = Object.fromEntries(Object.getOwnPropertyNames(error)
    .filter(key => !['name', 'message', 'stack', 'cause', 'errors', 'componentStack'].includes(key))
    .slice(0, MAX_OBJECT_KEYS).map(key => {
      try { return [key, (error as unknown as Record<string, unknown>)[key]] }
      catch { return [key, '[UNREADABLE]'] }
    }))
  return {
    name: boundedText(error.name || 'Error', 200),
    message: boundedText(error.message || String(error)),
    ...(error.stack ? { stack: boundedText(error.stack, 96_000) } : {}),
    ...('componentStack' in error && typeof error.componentStack === 'string' ? { componentStack: boundedText(error.componentStack, 32_000) } : {}),
    ...(code ? { code: boundedText(code, 200) } : {}),
    ...(cause !== undefined ? { cause: serializeError(cause, depth + 1, seen) } : {}),
    ...(errors?.length ? { errors } : {}),
    ...(Object.keys(details).length ? { details: sanitizeValue(details, depth + 1, seen) } : {})
  }
}

function safeSegment(value: string, fallback: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || fallback
}

export class DiagnosticJournal {
  readonly sessionId = randomUUID()
  private readonly maxFileBytes: number
  private readonly maxBufferedEvents: number
  private directory = ''
  private currentFile = ''
  private previousFile = ''
  private criticalFile = ''
  private readonly maxPendingBytes: number
  private pendingWrites = new Map<string, { bytes: number; queuedAt: number }>()
  private pendingBytes = 0
  private droppedEvents = 0
  private writeFailures = 0
  private rotations = 0
  private lastSuccessfulWriteAt = ''
  private writeChain = Promise.resolve()
  private buffered: DiagnosticEvent[] = []
  private pendingBeforeConfigure: DiagnosticEvent[] = []
  private contextProvider: (() => DiagnosticEvent['project']) | undefined
  private lastWriteError = ''

  constructor(options: DiagnosticJournalOptions = {}) {
    this.maxFileBytes = Math.max(256 * 1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.maxBufferedEvents = Math.max(100, options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS)
    this.maxPendingBytes = Math.max(64 * 1024, options.maxPendingBytes ?? 4 * 1024 * 1024)
  }

  configure(directory: string, contextProvider?: () => DiagnosticEvent['project']): void {
    this.directory = path.resolve(directory)
    this.currentFile = path.join(this.directory, 'diagnostic-events.jsonl')
    this.previousFile = path.join(this.directory, 'diagnostic-events.previous.jsonl')
    this.criticalFile = path.join(this.directory, 'diagnostic-critical.jsonl')
    this.contextProvider = contextProvider
    const pending = this.pendingBeforeConfigure.splice(0)
    for (const event of pending) {
      if (event.level === 'error' || event.level === 'warning' || event.subsystem === 'app' || event.subsystem === 'process') this.writeCritical(event)
      this.queueWrite(event)
    }
  }

  record(input: DiagnosticRecordInput): DiagnosticEvent {
    const event = this.createEvent(input)
    this.remember(event)
    if (this.currentFile) {
      if (event.level === 'error' || event.level === 'warning') this.writeCritical(event)
      this.queueWrite(event)
    } else this.rememberPending(event)
    return event
  }

  recordCritical(input: DiagnosticRecordInput): DiagnosticEvent {
    const event = this.createEvent(input)
    this.remember(event)
    if (!this.currentFile) {
      this.rememberPending(event)
      return event
    }
    this.writeCritical(event)
    return event
  }

  private rememberPending(event: DiagnosticEvent): void {
    this.pendingBeforeConfigure.push(event)
    if (this.pendingBeforeConfigure.length > this.maxBufferedEvents) {
      this.pendingBeforeConfigure.shift()
      this.droppedEvents += 1
    }
  }

  private writeCritical(event: DiagnosticEvent): void {
    const line = `${JSON.stringify(event)}\n`
    try {
      mkdirSync(this.directory, { recursive: true })
      let currentSize = 0
      try {
        currentSize = statSync(this.criticalFile).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (currentSize + Buffer.byteLength(line) > this.maxFileBytes) {
        const previous = path.join(this.directory, 'diagnostic-critical.previous.jsonl')
        rmSync(previous, { force: true })
        try {
          renameSync(this.criticalFile, previous)
          this.rotations += 1
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      appendFileSync(this.criticalFile, line, { encoding: 'utf8', mode: 0o600 })
      this.lastSuccessfulWriteAt = new Date().toISOString()
    } catch (error) {
      this.noteWriteFailure(error)
    }
  }

  private noteWriteFailure(error: unknown): void {
    this.writeFailures += 1
    this.lastWriteError = boundedText(error instanceof Error ? error.message : String(error), 2_000)
  }

  private createEvent(input: DiagnosticRecordInput): DiagnosticEvent {
    let project: DiagnosticEvent['project'] | undefined
    let data: unknown
    let error: DiagnosticError | undefined
    try {
      const projectContext = this.contextProvider?.()
      if (projectContext) project = sanitizeValue(projectContext) as DiagnosticEvent['project']
    } catch {
      project = undefined
    }
    try {
      if (input.data !== undefined) data = sanitizeValue(input.data)
    } catch (sanitizeError) {
      data = `[UNSERIALIZABLE DATA: ${boundedText(sanitizeError instanceof Error ? sanitizeError.message : String(sanitizeError), 2_000)}]`
    }
    try {
      if (input.error !== undefined) error = serializeError(input.error)
    } catch (serializeFailure) {
      error = { name: 'Error', message: boundedText(serializeFailure instanceof Error ? serializeFailure.message : String(serializeFailure), 2_000) }
    }
    const event: DiagnosticEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      time: new Date().toISOString(),
      pid: process.pid,
      level: input.level ?? (input.error ? 'error' : 'info'),
      subsystem: safeSegment(input.subsystem, 'app'),
      operation: safeSegment(input.operation, 'event'),
      phase: safeSegment(input.phase ?? 'event', 'event'),
      message: boundedText(input.message),
      ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
      ...(project ? { project } : {}),
      ...(input.data !== undefined ? { data } : {}),
      ...(error ? { error } : {})
    }
    return event
  }

  private remember(event: DiagnosticEvent): void {
    this.buffered.push(event)
    if (this.buffered.length > this.maxBufferedEvents) this.buffered.splice(0, this.buffered.length - this.maxBufferedEvents)
  }

  snapshot(): DiagnosticEvent[] {
    return this.buffered.map((event) => structuredClone(event))
  }

  status(): DiagnosticJournalStatus {
    return {
      sessionId: this.sessionId,
      ...(this.currentFile ? { logFile: this.currentFile } : {}),
      bufferedEvents: this.buffered.length,
      ...(this.criticalFile ? { criticalFile: this.criticalFile } : {}),
      pendingEvents: this.pendingWrites.size + this.pendingBeforeConfigure.length,
      pendingBytes: this.pendingBytes,
      oldestPendingAgeMs: this.pendingWrites.size ? Date.now() - this.pendingWrites.values().next().value!.queuedAt : 0,
      droppedEvents: this.droppedEvents,
      writeFailures: this.writeFailures,
      rotations: this.rotations,
      ...(this.lastSuccessfulWriteAt ? { lastSuccessfulWriteAt: this.lastSuccessfulWriteAt } : {}),
      ...(this.lastWriteError ? { lastWriteError: this.lastWriteError } : {})
    }
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private queueWrite(event: DiagnosticEvent): void {
    const line = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(line)
    if (this.pendingBytes + bytes > this.maxPendingBytes) {
      this.droppedEvents += 1
      return
    }
    this.pendingBytes += bytes
    this.pendingWrites.set(event.id, { bytes, queuedAt: Date.now() })
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(this.directory, { recursive: true })
        const currentSize = await fs.stat(this.currentFile).then((stat) => stat.size).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return 0
        })
        if (currentSize + Buffer.byteLength(line) > this.maxFileBytes) {
          await fs.rm(this.previousFile, { force: true })
          await fs.rename(this.currentFile, this.previousFile).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
          this.rotations += 1
        }
        await fs.appendFile(this.currentFile, line, { encoding: 'utf8', mode: 0o600 })
        this.lastSuccessfulWriteAt = new Date().toISOString()
      } catch (error) {
        this.noteWriteFailure(error)
      } finally {
        this.pendingBytes -= bytes
        this.pendingWrites.delete(event.id)
      }
    })
  }
}

let processHandlersInstalled = false
let consoleCaptureInstalled = false

export const diagnosticJournal = new DiagnosticJournal()

export function installProcessDiagnosticHandlers(): void {
  if (processHandlersInstalled) return
  processHandlersInstalled = true
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    diagnosticJournal.recordCritical({ subsystem: 'process', operation: 'uncaught-exception', phase: 'error', message: `Uncaught exception (${origin})`, error })
  })
  process.on('unhandledRejection', (reason) => {
    diagnosticJournal.record({ subsystem: 'process', operation: 'unhandled-rejection', phase: 'error', message: 'Unhandled promise rejection', error: reason })
  })
  process.on('warning', (warning) => {
    diagnosticJournal.record({ subsystem: 'process', operation: 'warning', phase: 'warning', level: 'warning', message: warning.message, error: warning })
  })
}

export function installConsoleDiagnosticCapture(): void {
  if (consoleCaptureInstalled) return
  consoleCaptureInstalled = true
  const originalWarn = console.warn.bind(console)
  const originalError = console.error.bind(console)
  console.warn = (...args: unknown[]): void => {
    diagnosticJournal.record({ subsystem: 'console', operation: 'warn', phase: 'warning', level: 'warning', message: args.map((value) => value instanceof Error ? value.message : String(value)).join(' '), data: args })
    originalWarn(...args)
  }
  console.error = (...args: unknown[]): void => {
    const error = args.find((value) => value instanceof Error)
    const message = args.map((value) => value instanceof Error ? value.message : String(value)).join(' ')
    const cancelled = isExpectedCancellation(error ?? message)
    diagnosticJournal.record({ subsystem: 'console', operation: 'error', phase: cancelled ? 'cancelled' : 'error', level: cancelled ? 'warning' : 'error', message, data: args, ...(error ? { error } : {}) })
    originalError(...args)
  }
}
