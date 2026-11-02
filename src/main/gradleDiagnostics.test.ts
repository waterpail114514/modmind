import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { collectBuildDiagnostics, gradleDiagnosticState, ownedJavaProcesses, watchGradleBuild } from './gradleDiagnostics'

const probe = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: probe.execute }) }))
const roots: string[] = []
const monitors: Array<ReturnType<typeof watchGradleBuild>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const monitor of monitors.splice(0)) await monitor.finish(0, false)
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  probe.execute.mockReset()
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-build-diagnostics-')); roots.push(root)
  const dataRoot = path.join(root, '.modmind'), gradleUserHome = path.join(root, 'gradle')
  await fs.mkdir(dataRoot, { recursive: true }); await fs.mkdir(gradleUserHome, { recursive: true })
  return { root, dataRoot, gradleUserHome }
}
async function file(target: string, content: string) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content) }
function monitor(f: Awaited<ReturnType<typeof fixture>>) {
  const child = { pid: 25000, exitCode: null, signalCode: null } as ChildProcess
  const value = watchGradleBuild({ child, projectPath: f.root, dataRoot: f.dataRoot, javaHome: path.join(f.root, 'jdk'), gradleUserHome: f.gradleUserHome, logPath: path.join(f.dataRoot, 'builds/build.log') })
  monitors.push(value); return value
}
function processTable(command: string) {
  return command === 'powershell.exe'
    ? JSON.stringify([{ ProcessId: 25000, ParentProcessId: 1, Name: 'cmd.exe' }, { ProcessId: 25001, ParentProcessId: 25000, Name: 'java.exe' }, { ProcessId: 99, ParentProcessId: 1, Name: 'java.exe' }])
    : '25000 1 cmd\n25001 25000 java\n99 1 java\n'
}

it('selects only the owned Java process tree, including a direct Java root', () => {
  const rows = [{ pid: 7, parent: 1, name: 'java.exe' }, { pid: 8, parent: 7, name: 'java' }, { pid: 9, parent: 1, name: 'java.exe' }]
  expect(ownedJavaProcesses(rows, 7)).toEqual([7, 8])
  expect(ownedJavaProcesses(rows, 0)).toEqual([])
})

it('captures a silent build once, redacts persisted evidence and keeps MCP state small', async () => {
  const f = await fixture()
  await file(path.join(f.gradleUserHome, 'daemon/8.8/daemon-25001.out.log'), 'daemon evidence token=secret-value\n')
  probe.execute.mockImplementation(async (command: string) => ({ stdout: /jcmd(?:\.exe)?$/.test(command) ? 'Thread.print token=secret-value\n waiting at SocketInputStream.read\n' : processTable(command) }))
  vi.useFakeTimers()
  const watch = monitor(f)
  await vi.advanceTimersByTimeAsync(90_000)
  const collector = new DiagnosticArchiveCollector()
  await collectBuildDiagnostics(collector, { projectPath: f.root, dataRoot: f.dataRoot, gradleUserHome: f.gradleUserHome })
  expect(gradleDiagnosticState(f.root)[0]).toMatchObject({ status: 'running', noOutputMs: 90_000, capture: { reason: 'no-output-90s', threads: [{ pid: 25001 }] } })
  expect(JSON.stringify(gradleDiagnosticState(f.root))).not.toContain('SocketInputStream')
  const entries = collector.finalize()
  const snapshot = entries.find(entry => /build-diagnostics\/[a-f0-9-]+\.json$/.test(entry.name))!
  expect(snapshot.data.toString()).toContain('SocketInputStream')
  expect(snapshot.data.toString()).toContain('daemon evidence')
  expect(snapshot.data.toString()).not.toContain('secret-value')
  const attaches = probe.execute.mock.calls.filter(call => /jcmd(?:\.exe)?$/.test(call[0]))
  expect(attaches).toHaveLength(1)
  expect(attaches[0][1]).toEqual(['25001', 'Thread.print', '-l'])
  expect(attaches[0][2]).toMatchObject({ timeout: 4_000, windowsHide: true, maxBuffer: 512 * 1024 })
  watch.output()
  expect(gradleDiagnosticState(f.root)[0].noOutputMs).toBe(0)
  await watch.finish(null, true)
  expect(gradleDiagnosticState(f.root)[0]).toMatchObject({ status: 'cancelled', exitCode: null })
})

it('retains an attach error without breaking export or build completion', async () => {
  const f = await fixture(); const watch = monitor(f)
  probe.execute.mockImplementation(async (command: string) => {
    if (/jcmd(?:\.exe)?$/.test(command)) throw new Error('jcmd unavailable or timeout')
    return { stdout: processTable(command) }
  })
  await expect(collectBuildDiagnostics(new DiagnosticArchiveCollector(), { projectPath: f.root, dataRoot: f.dataRoot, gradleUserHome: f.gradleUserHome })).resolves.toBeUndefined()
  expect(gradleDiagnosticState(f.root)[0]).toMatchObject({ capture: { threads: [{ pid: 25001, error: expect.stringContaining('unavailable') }] } })
  await watch.finish(1, false)
  expect(gradleDiagnosticState(f.root)[0].status).toBe('failed')
})

it('exports isolated session logs and daemon tails while excluding game resources and escaped links', async () => {
  const f = await fixture()
  await file(path.join(f.dataRoot, 'player-tests/current/game/logs/latest.log'), 'isolated test evidence\n')
  await file(path.join(f.dataRoot, 'player-tests/current/game/launcher-console.log'), 'launcher evidence\n')
  await file(path.join(f.dataRoot, 'player-tests/current/game/crash-reports/crash.txt'), 'crash evidence\n')
  await file(path.join(f.dataRoot, 'player-tests/current/game/saves/private.txt'), 'private world')
  await file(path.join(f.dataRoot, 'player-tests/current/game/mods/mod.jar'), 'binary')
  const outside = path.join(f.root, 'outside'); await file(path.join(outside, 'latest.log'), 'outside log')
  await fs.mkdir(path.join(f.dataRoot, 'player-tests/escaped/game'), { recursive: true })
  await fs.symlink(outside, path.join(f.dataRoot, 'player-tests/escaped/game/logs'), process.platform === 'win32' ? 'junction' : 'dir')
  await file(path.join(f.gradleUserHome, 'daemon/8.8/daemon-1.out.log'), 'daemon evidence\n')
  const collector = new DiagnosticArchiveCollector()
  await collectBuildDiagnostics(collector, { projectPath: f.root, dataRoot: f.dataRoot, gradleUserHome: f.gradleUserHome })
  const entries = collector.finalize()
  expect(entries.map(entry => entry.name)).toEqual(expect.arrayContaining(['project/player-tests/current/game/launcher-console.log', 'project/player-tests/current/game/logs/latest.log', 'project/player-tests/current/game/crash-reports/crash.txt', 'app-runtime/gradle/daemon/8.8/daemon-1.out.log']))
  expect(entries.some(entry => /private|mod\.jar|escaped/.test(entry.name))).toBe(false)
  expect(Buffer.concat(entries.map(entry => entry.data)).toString()).not.toContain('outside log')
  await fs.unlink(path.join(f.dataRoot, 'player-tests/escaped/game/logs'))
})

it('records bounded tail offsets for large logs', async () => {
  const f = await fixture(); const target = path.join(f.root, 'large.log')
  await file(target, 'old line\n'.repeat(500) + 'recent evidence\n')
  const collector = new DiagnosticArchiveCollector()
  await collector.addFile(target, 'large.log', 128)
  const entries = collector.finalize()
  expect(entries.find(entry => entry.name === 'large.log')!.data.byteLength).toBeLessThanOrEqual(128)
  expect(entries.find(entry => entry.name === 'large.log')!.data.toString()).toContain('recent evidence')
  expect(JSON.parse(entries.find(entry => entry.name === 'collection-report.json')!.data.toString()).items[0]).toMatchObject({ truncated: true, startOffset: expect.any(Number), endOffset: expect.any(Number) })
})

it('bounds persisted history without pruning unrelated files or exposing another project state', async () => {
  const f = await fixture(), other = await fixture()
  for (let index = 0; index < 10; index += 1) await monitor(f).finish(0, false)
  await monitor(other).finish(1, false)
  const directory = path.join(f.dataRoot, 'builds/diagnostics')
  await file(path.join(directory, 'keep-user-note.txt'), 'retained note')
  await monitor(f).finish(0, false)
  const entries = await fs.readdir(directory)
  expect(entries.filter(name => name.endsWith('.json'))).toHaveLength(8)
  expect(entries).toContain('keep-user-note.txt')
  expect(gradleDiagnosticState(f.root)).toHaveLength(11)
  expect(gradleDiagnosticState(f.root).every(record => record.projectPath === f.root)).toBe(true)
  expect(gradleDiagnosticState(other.root)).toHaveLength(1)
})
