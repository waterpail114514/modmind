import path from 'node:path'
import { diagnosticJournal } from './diagnosticLog'

let contributionStatus: (() => unknown) | undefined
export function setContributionDiagnosticProvider(provider: () => unknown): void { contributionStatus = provider }

export function readDiagnosticState(projectPath: string | undefined, input: unknown = {}): unknown {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  if (Object.keys(value).some(key => key !== 'limit') || value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error('诊断查询仅支持 limit=1–100')
  const identity = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  const events = diagnosticJournal.snapshot().filter(event => {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    const owner = typeof data.projectPath === 'string' ? data.projectPath : event.project?.path
    if (owner) return Boolean(projectPath && identity(owner) === identity(projectPath))
    return ['app', 'process', 'diagnostics', 'network'].includes(event.subsystem)
  }).slice(-(typeof value.limit === 'number' ? value.limit : 20))
  let bytes = 0
  const bounded = events.reverse().filter(event => { bytes += Buffer.byteLength(JSON.stringify(event)); return bytes <= 256 * 1024 }).reverse()
  return { projectPath, journal: diagnosticJournal.status(), events: bounded, omittedByByteLimit: events.length - bounded.length,
    ...(contributionStatus ? { contribution: contributionStatus() } : {}),
    evidencePolicy: { operationInputs: 'identity and content hashes; secrets removed', nativeDumps: 'local only; explicit selection required for export', externalEvidence: 'provider bills, remote platform logs and original artifacts must be supplied when relevant' } }
}
