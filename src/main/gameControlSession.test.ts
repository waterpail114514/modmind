import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { BackgroundGameControlSession, backgroundGameWindowsHide } from '../../feature-plugins/testing/src/main/gameControlSession'
import artifact from '../../feature-plugins/testing/src/main/gameControlAgent.json'

let compilerAvailable = true
try { execFileSync('javac', ['-version'], { stdio: 'pipe', windowsHide: true }) } catch { compilerAvailable = false }
const javaSettings = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8', windowsHide: true }).stderr || ''
const javaHome = javaSettings.match(/java.home\s*=\s*([^\r\n]+)/)?.[1].trim()
const javaExecutable = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
let root: string, classes: string
const active: { directory: string; session: BackgroundGameControlSession; child: ChildProcess }[] = []
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const value = await read().catch(() => null)
    if (value !== null && check(value)) return value
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Fixture condition did not become true')
}
async function start() {
  const directory = await fs.mkdtemp(path.join(root, '会话-'))
  const session = await BackgroundGameControlSession.prepare(directory, directory)
  const child = spawn(javaExecutable, [session.jvmArgument, '-cp', classes, 'ControlFixture', directory], { cwd: directory, env: session.environment(process.env), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  child.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4000) })
  child.once('exit', code => { if (code && !child.killed && diagnostic) console.error('Game-control JVM fixture exited:', diagnostic) })
  session.bind(child); active.push({ directory, session, child })
  await session.waitUntilReady(undefined, 10_000)
  const consumer = () => fs.readFile(path.join(directory, 'consumer.json'), 'utf8').then(JSON.parse)
  await eventually(consumer, value => typeof value.presses === 'number')
  return { directory, session, child, consumer }
}

describe('game control artifact', () => {
  it('uses a hidden Java startup for legacy Win32 Display only', () => {
    expect(backgroundGameWindowsHide('1.12.2', 'win32')).toBe(true)
    expect(backgroundGameWindowsHide('1.6.4', 'win32')).toBe(true)
    expect(backgroundGameWindowsHide('1.13.2', 'win32')).toBe(false)
    expect(backgroundGameWindowsHide('26.2', 'win32')).toBe(false)
    expect(backgroundGameWindowsHide('1.12.2', 'linux')).toBe(false)
  })
  it('embeds a verified Java 8 agent matching its maintained sources', async () => {
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    expect(digest(Buffer.from(artifact.data, 'base64'))).toBe(artifact.jarSha256)
    for (const [name, hash] of Object.entries(artifact.sourceHashes)) expect(digest((await fs.readFile(path.join('resources/game-control', name), 'utf8')).replaceAll('\r\n', '\n'))).toBe(hash)
    expect(artifact.minimumJava).toBe(8)
  })
  it('exposes only the owned Agent to Fabric while preserving selected system libraries', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-knot-'))
    const session = await BackgroundGameControlSession.prepare(directory, directory)
    try {
      const existing = ['-Xmx2G', '-Dfabric.systemLibraries=' + path.resolve(directory, 'selected.jar')]
      const args = session.jvmArguments(existing, 'fabric')
      expect(args.filter(value => value.startsWith('-Dfabric.systemLibraries='))).toHaveLength(1)
      const libraries = args.find(value => value.startsWith('-Dfabric.systemLibraries='))!.slice('-Dfabric.systemLibraries='.length).split(path.delimiter)
      expect(libraries).toEqual([path.resolve(directory, 'selected.jar'), session.jvmArgument.slice('-javaagent:'.length)])
      expect(args).not.toContain('-Dfabric.debug.disableClassPathIsolation=true')
      expect(session.jvmArguments(['-Xmx2G'], 'forge')).toEqual(['-Xmx2G', session.jvmArgument])
    } finally { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
  })
})

describe.skipIf(!compilerAvailable)('game control real JVM transport and transformed input fixture', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-game-control-'))
    classes = path.join(root, 'classes'); await fs.mkdir(classes)
    const sources: string[] = []
    async function collect(directory: string) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await collect(file); else if (file.endsWith('.java')) sources.push(file) } }
    await collect(path.resolve('src/main/__fixtures__/game-control'))
    execFileSync('javac', ['--release', '8', '-encoding', 'UTF-8', '-d', classes, ...sources], { windowsHide: true, stdio: 'pipe' })
  })
  afterEach(async () => {
    for (const { session, child } of active.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited }
      await session.dispose()
    }
  })
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('isolates the project and substitutes virtual polling and real event consumption', async () => {
    const { session, consumer, directory } = await start()
    expect(() => session.assertProject(path.join(directory, 'another-project'))).toThrow('不属于')
    expect(await eventually(consumer, value => value.focus)).toMatchObject({ key: false, button: false, focus: true, callbackInvocations: 2 })
    expect((await session.status()).physicalCallbacksFiltered).toBe(true)
    await session.input({ type: 'key', code: 17, state: 'down', leaseMs: 2000 })
    expect(await eventually(consumer, value => value.key)).toMatchObject({ presses: 1, key: true })
    await session.input({ type: 'key', code: 17, state: 'up' })
    expect(await eventually(consumer, value => !value.key && value.releases === 1)).toMatchObject({ key: false })
  })

  it('expires held input while the game thread is stopped, then delivers release', async () => {
    const { session, consumer, directory } = await start()
    await session.input({ type: 'key', code: 17, state: 'down', leaseMs: 350 })
    await eventually(consumer, value => value.key)
    await fs.writeFile(path.join(directory, 'pause'), '')
    await eventually(() => session.status(), state => !state.keysDown.length)
    await fs.rm(path.join(directory, 'pause'))
    expect(await eventually(consumer, value => value.releases === 1)).toMatchObject({ key: false })
  })

  it('delivers the control character used by old text fields for Ctrl+A', async () => {
    const { session, consumer } = await start()
    await session.input({ type: 'key', code: 29, state: 'down', leaseMs: 1000 })
    await session.input({ type: 'key', code: 30, state: 'down', leaseMs: 1000 })
    expect(await eventually(consumer, value => value.selectAll === 1)).toMatchObject({ selectAll: 1 })
    await session.release()
  })

  it('deduplicates actions and rejects reuse for a different action', async () => {
    const { session } = await start(), requestId = randomUUID()
    const action = { type: 'key' as const, code: 17, state: 'down' as const, leaseMs: 1000 }
    const first = await session.input(action, { requestId })
    expect(await session.input(action, { requestId })).toEqual(first)
    await expect(session.input({ ...action, code: 18 }, { requestId })).rejects.toThrow('reused')
    expect((await session.status()).actionSequence).toBe(1)
    await session.release(); expect((await session.status()).keysDown).toEqual([])
  })

  it('cancels a queued action before it can reach a resumed game thread', async () => {
    const { session, directory, consumer } = await start()
    await fs.writeFile(path.join(directory, 'pause'), ''); await new Promise(resolve => setTimeout(resolve, 80))
    const controller = new AbortController()
    const input = session.input({ type: 'key', code: 17, state: 'down', leaseMs: 1000 }, { signal: controller.signal })
    const rejection = expect(input).rejects.toThrow('取消')
    await new Promise(resolve => setTimeout(resolve, 100)); controller.abort(); await rejection
    await new Promise(resolve => setTimeout(resolve, 100)); await fs.rm(path.join(directory, 'pause'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await consumer()).presses).toBe(0)
    expect((await session.status()).keysDown).toEqual([])
  })

  // JVM startup plus 128 sequential transport calls can exceed 15s on Intel CI.
  // This checks eviction semantics, not throughput; retain every real action.
  it('does not repeat an action after its cached result is evicted', async () => {
    const { session } = await start(), requestId = randomUUID()
    const action = { type: 'key' as const, code: 17, state: 'down' as const, leaseMs: 100 }
    await session.input(action, { requestId })
    for (let index = 0; index < 128; index++) await session.input({ type: 'look', x: 1, y: 0 })
    const sequence = (await session.status()).actionSequence
    await expect(session.input(action, { requestId })).rejects.toThrow('expired')
    expect((await session.status()).actionSequence).toBe(sequence)
  }, 30_000)

  it('rejects unauthenticated peers and endpoint PID substitution', async () => {
    const { session } = await start()
    const endpointFile = session.configurationPath + '.endpoint'
    const endpoint = JSON.parse(await fs.readFile(endpointFile, 'utf8'))
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: endpoint.port }); let text = ''
      socket.once('error', reject); socket.on('data', bytes => { text += bytes }); socket.once('end', () => resolve(text))
      socket.once('connect', () => socket.end([randomUUID(), '0'.repeat(64), session.sessionId, 'key', '17', 'down', '5000'].join('\t') + '\n'))
    })
    expect(reply).toBe(''); expect((await session.status()).keysDown).toEqual([])
    await fs.writeFile(endpointFile, JSON.stringify({ ...endpoint, pid: endpoint.pid + 1 }))
    await expect(session.status()).rejects.toThrow('不匹配')
  })

  it('reports missing framebuffer support without fabricating an image', async () => {
    const { session } = await start()
    await expect(session.capture()).rejects.toThrow('org.lwjgl.opengl.GL11')
    expect((await session.status()).error).toBeNull()
    await expect(session.input({ type: 'move', x: NaN, y: 0 })).rejects.toThrow('参数无效')
    await expect(session.input({ type: 'key', code: 17, state: 'down', leaseMs: 5001 })).rejects.toThrow('5000')
  })

  it('checks geometry on the game thread and prevents stale pointer actions after resizing', async () => {
    const { session, directory } = await start(); const before = await session.sync()
    await fs.writeFile(path.join(directory, 'resize'), '')
    const after = await eventually(() => session.sync(), state => state.logicalWidth === 800)
    expect(after.coordinateRevision).not.toBe(before.coordinateRevision)
    await expect(session.input({ type: 'move', x: 10, y: 10 }, { coordinateRevision: before.coordinateRevision })).rejects.toThrow('STALE_COORDINATES')
    await expect(session.input({ type: 'move', x: 10, y: 10 }, { coordinateRevision: after.coordinateRevision })).resolves.toMatchObject({ dispatched: true })
  })

  it('hands off input ownership, rejects AI input while paused/human, and resumes cleanly', async () => {
    const { session, consumer } = await start()
    expect(await consumer()).toMatchObject({ positionFlags: 52 })
    await session.input({ type: 'key', code: 17, state: 'down', leaseMs: 2000 })
    expect(await session.ownership('paused')).toMatchObject({ ownership: 'paused', keysDown: [] })
    await expect(session.input({ type: 'key', code: 17, state: 'down' })).rejects.toThrow('paused')
    expect(await session.ownership('human')).toMatchObject({ ownership: 'human', active: false })
    expect(await eventually(consumer, value => value.positionFlags === 36)).toMatchObject({ positionFlags: 36 })
    await expect(session.input({ type: 'key', code: 17, state: 'down' })).rejects.toThrow('handed')
    expect(await session.ownership('ai')).toMatchObject({ ownership: 'ai', active: true })
    expect(await eventually(consumer, value => value.positionFlags === 52)).toMatchObject({ positionFlags: 52 })
    await session.input({ type: 'key', code: 17, state: 'down', leaseMs: 100 })
    expect(await session.settle()).toMatchObject({ settled: true })
  })
})
