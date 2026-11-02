import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { redactDiagnosticText } from './diagnosticLog'

const execute = promisify(execFile)
const records = new Map<string, BuildRecord>()
const MAX_HISTORY = 32
const SILENCE_MS = 90_000
const LOG_BYTES = 2 * 1024 * 1024
interface ProcessRow { pid: number; parent: number; name: string }
interface BuildOptions {
  child: ChildProcess
  projectPath: string
  dataRoot: string
  javaHome: string
  gradleUserHome: string
  logPath: string
}
interface BuildRecord extends BuildOptions {
  id: string
  startedAt: number
  lastOutputAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  exitCode?: number | null
  capture?: unknown
  capturing?: Promise<void>
  writing?: Promise<void>
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(a) === normalize(b)
}

export function ownedJavaProcesses(rows: ProcessRow[], rootPid: number): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const owned = new Set([rootPid])
  for (let depth = 0; depth < 32; depth += 1) {
    const size = owned.size
    for (const row of rows) if (row.pid > 0 && owned.has(row.parent)) owned.add(row.pid)
    if (owned.size === size) break
  }
  return rows.filter(row => owned.has(row.pid) && /^java(?:w)?(?:\.exe)?$/i.test(path.basename(row.name))).map(row => row.pid).slice(0, 4)
}

async function processRows(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 4_000, maxBuffer: 2 * 1024 * 1024 })
    const value = JSON.parse(stdout)
    return (Array.isArray(value) ? value : [value]).map(row => ({ pid: Number(row.ProcessId), parent: Number(row.ParentProcessId), name: String(row.Name) }))
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 4_000, maxBuffer: 2 * 1024 * 1024 })
  return stdout.trim().split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), name: match[3] }] : []
  })
}

function summary(record: BuildRecord, fullCapture = false): Record<string, unknown> {
  const captured = record.capture as { reason?: string; capturedAt?: string; error?: string; threads?: Array<{ pid: number; error?: string }>; logs?: Array<{ name: string }> } | undefined
  return { id: record.id, projectPath: record.projectPath, pid: record.child.pid, javaHome: record.javaHome,
    gradleUserHome: record.gradleUserHome, logPath: record.logPath, status: record.status,
    startedAt: new Date(record.startedAt).toISOString(), lastOutputAt: new Date(record.lastOutputAt).toISOString(),
    noOutputMs: Math.max(0, (record.endedAt ?? Date.now()) - record.lastOutputAt),
    endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : undefined, exitCode: record.exitCode,
    capture: fullCapture ? record.capture : captured && { reason: captured.reason, capturedAt: captured.capturedAt, error: captured.error,
      threads: captured.threads?.map(thread => ({ pid: thread.pid, error: thread.error })), logs: captured.logs?.map(log => log.name) } }
}

export function gradleDiagnosticState(projectPath: string): Record<string, unknown>[] {
  return [...records.values()].filter(record => samePath(record.projectPath, projectPath)).map(record => summary(record))
}

// Resolve every selected path under its configured root. Nested symlinks may not
// pull unrelated projects, credentials, or game resources into a diagnostic ZIP.
async function contained(root: string, target: string): Promise<boolean> {
  const [base, actual] = await Promise.all([fs.realpath(root), fs.realpath(target)])
  const relative = path.relative(base, actual)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function recent(root: string, directory: string, kind: 'file' | 'directory', limit: number, pattern = /./): Promise<string[]> {
  if (!await contained(root, directory).catch(() => false)) return []
  const handle = await fs.opendir(directory).catch(() => null)
  if (!handle) return []
  const values: Array<{ file: string; time: number }> = []
  let inspected = 0
  for await (const entry of handle) {
    if (++inspected > 2_000) break
    if (entry.isSymbolicLink() || !pattern.test(entry.name) || (kind === 'file' ? !entry.isFile() : !entry.isDirectory())) continue
    const file = path.join(directory, entry.name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat) values.push({ file, time: stat.mtimeMs })
  }
  return values.sort((a, b) => b.time - a.time).slice(0, limit).map(value => value.file)
}

async function daemonLogs(home: string): Promise<string[]> {
  const versions = await recent(home, path.join(home, 'daemon'), 'directory', 4)
  const logs = (await Promise.all(versions.map(version => recent(home, version, 'file', 6, /^daemon-\d+\.out\.log$/)))).flat()
  const times = await Promise.all(logs.map(async file => ({ file, time: (await fs.stat(file)).mtimeMs })))
  return times.sort((a, b) => b.time - a.time).slice(0, 6).map(value => value.file)
}

async function persist(record: BuildRecord): Promise<void> {
  const operation = async (): Promise<void> => {
    const directory = path.join(record.dataRoot, 'builds', 'diagnostics')
    await fs.mkdir(directory, { recursive: true })
    if (!await contained(record.dataRoot, directory)) return
    const target = path.join(directory, `${record.id}.json`)
    // Atomic replacement also avoids following a pre-existing target symlink.
    const temporary = path.join(directory, `${record.id}-${randomUUID()}.tmp`)
    await fs.writeFile(temporary, redactDiagnosticText(JSON.stringify(summary(record, true), null, 2)), { flag: 'wx' })
    await fs.rename(temporary, target)
    const files = await recent(record.dataRoot, directory, 'file', 2_000, /^[a-f0-9-]{36}\.json$/)
    for (const file of files.slice(8)) await fs.unlink(file).catch(() => undefined)
  }
  record.writing = (record.writing ?? Promise.resolve()).catch(() => undefined).then(operation)
  return record.writing
}

async function capture(record: BuildRecord, reason: string): Promise<void> {
  if (record.capturing) return record.capturing
  record.capturing = (async () => {
    const startedAt = new Date().toISOString()
    const threads: Array<{ pid: number; text?: string; error?: string }> = []
    let error: string | undefined
    try {
      const rows = await processRows()
      const pids = ownedJavaProcesses(rows, record.child.pid ?? 0)
      for (const pid of pids) {
        if (record.status !== 'running' || record.child.exitCode !== null || record.child.signalCode !== null) break
        try {
          const { stdout } = await execute(path.join(record.javaHome, 'bin', process.platform === 'win32' ? 'jcmd.exe' : 'jcmd'), [String(pid), 'Thread.print', '-l'], { timeout: 4_000, windowsHide: true, maxBuffer: 512 * 1024 })
          threads.push({ pid, text: redactDiagnosticText(stdout) })
        } catch (failure) { threads.push({ pid, error: redactDiagnosticText(String(failure)).slice(0, 2_000) }) }
      }
      if (!pids.length) error = 'No owned Java process available for thread capture'
    } catch (failure) { error = redactDiagnosticText(String(failure)).slice(0, 2_000) }
    // Preserve a bounded daemon tail before cancellation can remove the daemon.
    const collector = new DiagnosticArchiveCollector({ maxFileBytes: LOG_BYTES, maxFiles: 8, maxTotalBytes: 8 * LOG_BYTES })
    for (const file of (await daemonLogs(record.gradleUserHome).catch(() => [])).slice(0, 2)) {
      await collector.addFile(file, `daemon/${path.basename(path.dirname(file))}/${path.basename(file)}`)
    }
    const evidence = collector.finalize()
    const collection = JSON.parse(evidence.find(entry => entry.name === 'collection-report.json')!.data.toString('utf8')).items
    const logs = evidence.filter(entry => entry.name.startsWith('daemon/')).map(entry => ({ name: entry.name, text: entry.data.toString('utf8') }))
    record.capture = { reason, startedAt, capturedAt: new Date().toISOString(), error, threads, logs, collection }
    await persist(record)
  })().catch(() => undefined).finally(() => { record.capturing = undefined })
  return record.capturing
}

export function watchGradleBuild(options: BuildOptions): { output: () => void; finish: (code: number | null, cancelled: boolean) => Promise<void> } {
  // Keep active entries; evict completed history first.
  for (const [id, record] of records) {
    if (records.size < MAX_HISTORY) break
    if (record.status !== 'running') records.delete(id)
  }
  const record: BuildRecord = { ...options, id: randomUUID(), startedAt: Date.now(), lastOutputAt: Date.now(), status: 'running' }
  if (records.size < MAX_HISTORY) records.set(record.id, record)
  void persist(record).catch(() => undefined)
  let captured = false
  const timer = setInterval(() => {
    if (!captured && Date.now() - record.lastOutputAt >= SILENCE_MS) {
      captured = true
      void capture(record, 'no-output-90s')
    }
  }, 15_000)
  timer.unref()
  return {
    output: () => { record.lastOutputAt = Date.now() },
    finish: async (code, cancelled) => {
      if (record.endedAt) { await record.writing?.catch(() => undefined); return }
      clearInterval(timer)
      record.status = cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed'
      record.exitCode = code
      record.endedAt = Date.now()
      await record.capturing
      await persist(record).catch(() => undefined)
    }
  }
}

export async function collectBuildDiagnostics(collector: DiagnosticArchiveCollector, options: { projectPath?: string; dataRoot?: string; gradleUserHome: string }): Promise<void> {
  const active = [...records.values()].filter(record => record.status === 'running' && options.projectPath && samePath(record.projectPath, options.projectPath)).slice(0, 2)
  await Promise.all(active.map(record => capture(record, 'diagnostic-export')))
  if (options.projectPath) collector.addJson('project/build-diagnostics/state.json', gradleDiagnosticState(options.projectPath))
  for (const file of await daemonLogs(options.gradleUserHome).catch(() => [])) {
    await collector.addFile(file, `app-runtime/gradle/daemon/${path.basename(path.dirname(file))}/${path.basename(file)}`, LOG_BYTES)
  }
  if (!options.dataRoot) return
  const root = options.dataRoot
  for (const file of await recent(root, path.join(root, 'builds', 'diagnostics'), 'file', 8, /^[a-f0-9-]{36}\.json$/)) {
    await collector.addFile(file, `project/build-diagnostics/${path.basename(file)}`, 16 * LOG_BYTES)
  }
  // Only isolated-test evidence. Never walk saves, assets, screenshots or JARs.
  for (const session of await recent(root, path.join(root, 'player-tests'), 'directory', 6)) {
    const prefix = `project/player-tests/${path.basename(session)}`
    for (const subdir of ['', 'game']) {
      for (const file of await recent(root, path.join(session, subdir), 'file', 4, /^(?:launcher-console|console|session|events).*\.(?:log|json|jsonl)$/i)) {
        await collector.addFile(file, path.posix.join(prefix, subdir, path.basename(file)), LOG_BYTES)
      }
    }
    for (const subdir of ['game/logs', 'game/crash-reports', 'logs', 'crash-reports']) {
      const directory = path.join(session, subdir)
      for (const file of await recent(root, directory, 'file', 4, /\.(?:log|txt|jsonl)$/i)) await collector.addFile(file, `${prefix}/${subdir}/${path.basename(file)}`, LOG_BYTES)
    }
  }
}
