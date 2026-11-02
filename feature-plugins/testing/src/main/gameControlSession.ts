import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import artifact from './gameControlAgent.json'

export interface BackgroundGameState {
  protocol: 1
  pid: number
  family: 'waiting' | 'lwjgl2' | 'glfw' | 'sdl'
  active: boolean
  ready: boolean
  frameId: number
  actionSequence: number
  width: number
  height: number
  logicalWidth: number
  logicalHeight: number
  lastPumpAgeMs: number
  keysDown: number[]
  buttonsDown: number[]
  hookClasses: number
  physicalCallbacksFiltered: boolean
  coordinateRevision: string
  ownership: 'ai' | 'paused' | 'human'
  error: string | null
}

export interface BackgroundGameFrame {
  pid?: number
  frameId: number
  capturedAt: number
  width: number
  height: number
  logicalWidth: number
  logicalHeight: number
  actionSequence: number
  coordinateRevision: string
  image: Buffer
  mimeType: 'image/png'
}

/** Numeric key codes deliberately use the reported LWJGL family, not OS key codes. */
export type BackgroundGameInput =
  | { type: 'key' | 'button'; code: number; state: 'down' | 'up'; leaseMs?: number }
  | { type: 'move' | 'look' | 'scroll'; x: number; y: number }
  | { type: 'text'; text: string }

interface Endpoint { protocol: 1; sessionId: string; port: number; pid: number }
interface Reply { requestId: string; sessionId: string; ok: boolean; result: unknown; error: string | null; imageBytes: number }
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const MAX_REPLY = 36 * 1024 * 1024

/** Legacy Win32 Display's first ShowWindow honors STARTUPINFO, before its own flag. */
export function backgroundGameWindowsHide(version: string, platform: NodeJS.Platform = process.platform): boolean {
  const minor = /^1\.(\d+)(?:\.|$)/.exec(version)?.[1]
  return platform === 'win32' && minor !== undefined && Number(minor) <= 12
}

/** Core transport shared by the future testing UI and MCP adapter. No Electron dependency. */
export class BackgroundGameControlSession {
  readonly sessionId = randomUUID()
  readonly projectPath: string
  readonly configurationPath: string
  readonly jvmArgument: string
  private readonly token = randomBytes(32).toString('hex')
  private pid?: number
  private closed = false
  private readonly connections = new Set<ReturnType<typeof createConnection>>()

  private constructor(projectPath: string, configurationPath: string, private readonly jarPath: string) {
    this.projectPath = path.resolve(projectPath)
    this.configurationPath = configurationPath
    this.jvmArgument = `-javaagent:${jarPath}`
  }

  jvmArguments(existing: readonly string[], loader: string): string[] {
    if (loader !== 'fabric') return [...existing, this.jvmArgument]
    // Knot explicitly restricts parent code sources, including bootstrap JARs.
    // Register only this immutable helper through Fabric's supported system-
    // library property; retain isolation for every other library and mod.
    const property = '-Dfabric.systemLibraries='
    const previous = existing.filter(value => value.startsWith(property)).at(-1)?.slice(property.length)
    const libraries = [...new Set([...(previous ? previous.split(path.delimiter) : []), this.jarPath])]
    return [...existing.filter(value => !value.startsWith(property)), property + libraries.join(path.delimiter), this.jvmArgument]
  }

  static async prepare(projectPath: string, gameDirectory: string): Promise<BackgroundGameControlSession> {
    const directory = path.resolve(gameDirectory, '.modmind-game-control')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const bytes = Buffer.from(artifact.data, 'base64')
    if (bytes.length !== artifact.jarBytes || sha256(bytes) !== artifact.jarSha256) throw new Error('后台控制 Agent 完整性校验失败')
    // Bootstrap class-path append uses older native path APIs on Java 8/17.
    // Keep the immutable helper outside long project/session paths on Windows;
    // project identity and secrets remain in the owned session directory.
    const agentDirectory = process.platform === 'win32' ? await fs.mkdir(path.join(os.tmpdir(), 'modmind-game-control'), { recursive: true }).then(() => fs.realpath(path.join(os.tmpdir(), 'modmind-game-control'))) : directory
    const jarPath = path.join(agentDirectory, `agent-${artifact.jarSha256}.jar`)
    if (await fs.readFile(jarPath).then(value => sha256(value) !== artifact.jarSha256, () => true)) {
      const temporary = `${jarPath}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, jarPath) }
      finally { await fs.rm(temporary, { force: true }) }
    }
    const configurationPath = path.join(directory, `${randomUUID()}.properties`)
    const session = new BackgroundGameControlSession(projectPath, configurationPath, jarPath)
    await fs.writeFile(configurationPath, `sessionId=${session.sessionId}\n`, { flag: 'wx', mode: 0o600 })
    return session
  }

  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, MODMIND_GAME_CONTROL_TOKEN: this.token, MODMIND_GAME_CONTROL_CONFIG: this.configurationPath }
  }

  bind(child: ChildProcess): void {
    if (this.closed || this.pid !== undefined || !child.pid) throw new Error('后台控制只能绑定一个已启动的受管游戏进程')
    this.pid = child.pid
    child.once('exit', () => { void this.dispose() })
    child.once('error', () => { void this.dispose() })
  }

  assertProject(projectPath: string): void {
    const current = path.resolve(projectPath)
    if ((process.platform === 'win32' ? current.toLowerCase() : current) !== (process.platform === 'win32' ? this.projectPath.toLowerCase() : this.projectPath)) throw new Error('后台控制会话不属于当前项目')
  }

  async waitUntilReady(signal?: AbortSignal, timeoutMs = 60_000): Promise<BackgroundGameState> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (this.closed) throw new Error('受管游戏进程已退出')
      const state = await this.status(signal).catch(error => {
        if (signal?.aborted || this.closed || error?.code === 'GAME_CONTROL_IDENTITY_MISMATCH') throw error
        if (!(error instanceof SyntaxError) && !['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) throw error
        return null
      })
      if (state?.error) throw new Error(state.error)
      if (state?.ready) return state
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    throw new Error('游戏尚未连接后台输入和渲染通道')
  }

  async status(signal?: AbortSignal): Promise<BackgroundGameState> {
    const { header } = await this.request(['status'], { signal })
    const state = header.result as BackgroundGameState
    if (state.protocol !== 1 || state.pid !== this.pid || !['waiting', 'lwjgl2', 'glfw', 'sdl'].includes(state.family) || typeof state.ready !== 'boolean') throw new Error('后台控制状态无效')
    return state
  }

  async input(action: BackgroundGameInput, options: { signal?: AbortSignal; requestId?: string; coordinateRevision?: string } = {}): Promise<{ dispatched: true; actionSequence: number }> {
    let arguments_: string[]
    if (action.type === 'key' || action.type === 'button') {
      if (!Number.isInteger(action.code) || action.code < 0 || action.code > (action.type === 'button' ? 7 : 348) || !['down', 'up'].includes(action.state)) throw new Error('虚拟按键参数无效')
      const lease = action.leaseMs ?? 1000
      if (!Number.isInteger(lease) || lease < 1 || lease > 5000) throw new Error('虚拟按住时间需在 1–5000 毫秒之间')
      arguments_ = [action.type, String(action.code), action.state, String(lease)]
    } else if (action.type === 'text') {
      if (typeof action.text !== 'string' || action.text.length > 512) throw new Error('单次文字输入不能超过 512 个 UTF-16 单元')
      arguments_ = ['text', Buffer.from(action.text).toString('base64')]
    } else if ('x' in action) {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || Math.abs(action.x) > 16384 || Math.abs(action.y) > 16384) throw new Error('虚拟鼠标参数无效')
      arguments_ = [action.type, String(action.x), String(action.y)]
    } else throw new Error('未知的后台输入类型')
    if (options.coordinateRevision !== undefined) {
      if (!/^[a-f0-9-]{36}:\d+$/.test(options.coordinateRevision)) throw new Error('画面坐标版本无效')
      arguments_.push('revision:' + options.coordinateRevision)
    }
    const { header } = await this.request(arguments_, options)
    return header.result as { dispatched: true; actionSequence: number }
  }

  async capture(signal?: AbortSignal): Promise<BackgroundGameFrame> {
    const { header, image } = await this.request(['capture'], { signal })
    const result = header.result as Omit<BackgroundGameFrame, 'image' | 'mimeType'>
    if (!image.length || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || !Number.isSafeInteger(result.frameId) || result.width < 1 || result.height < 1) throw new Error('游戏未返回有效的新画面')
    return { ...result, pid: this.pid, image, mimeType: 'image/png' }
  }

  async release(signal?: AbortSignal): Promise<void> { await this.request(['release'], { signal }) }

  async sync(signal?: AbortSignal): Promise<BackgroundGameState> { return (await this.request(['sync'], { signal })).header.result as BackgroundGameState }
  async settle(signal?: AbortSignal): Promise<{ settled: true; frameId: number; actionSequence: number }> { return (await this.request(['settle'], { signal })).header.result as { settled: true; frameId: number; actionSequence: number } }
  async ownership(owner: 'ai' | 'paused' | 'human', signal?: AbortSignal): Promise<BackgroundGameState> {
    return (await this.request(['ownership', owner], { signal })).header.result as BackgroundGameState
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const socket of this.connections) socket.destroy(new Error('后台控制会话已关闭'))
    // The JVM watchdog releases held state independently if its owner goes away.
    await Promise.all([this.configurationPath, `${this.configurationPath}.endpoint`].map(file => fs.rm(file, { force: true }).catch(() => undefined)))
  }

  private async endpoint(): Promise<Endpoint> {
    if (this.closed || !this.pid) throw new Error('后台控制未绑定到运行中的游戏')
    const file = `${this.configurationPath}.endpoint`
    if ((await fs.stat(file)).size > 4096) throw new Error('后台控制端点无效')
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Endpoint
    if (value.protocol !== 1 || value.sessionId !== this.sessionId || value.pid !== this.pid || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw Object.assign(new Error('后台控制端点与受管进程不匹配'), { code: 'GAME_CONTROL_IDENTITY_MISMATCH' })
    return value
  }

  private async request(arguments_: string[], { signal, requestId = randomUUID() }: { signal?: AbortSignal; requestId?: string } = {}): Promise<{ header: Reply; image: Buffer }> {
    signal?.throwIfAborted()
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('后台控制请求 ID 无效')
    const endpoint = await this.endpoint()
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: endpoint.port })
      this.connections.add(socket)
      let size = 0, settled = false
      const chunks: Buffer[] = []
      const finish = (error?: Error, value?: { header: Reply; image: Buffer }) => {
        if (settled) return; settled = true
        signal?.removeEventListener('abort', abort); this.connections.delete(socket); socket.destroy()
        if (error) reject(error); else resolve(value!)
      }
      const abort = () => {
        finish(new Error('后台控制调用已取消；已派发的输入由租约自动释放'))
        if (arguments_[0] !== 'status') void this.request(['cancel', requestId]).catch(() => undefined)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      socket.setTimeout(13_000, () => finish(new Error('后台控制响应超时；不要以新请求 ID 重复动作')))
      socket.once('error', error => finish(error))
      socket.once('connect', () => socket.end([requestId, this.token, this.sessionId, ...arguments_].join('\t') + '\n'))
      socket.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_REPLY) finish(new Error('后台控制响应超出容量限制')); else chunks.push(chunk) })
      socket.once('end', () => {
        try {
          const bytes = Buffer.concat(chunks), newline = bytes.indexOf(10)
          if (newline < 0 || newline > 8192) throw new Error('后台控制响应头无效')
          const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as Reply
          if (header.requestId !== requestId || header.sessionId !== this.sessionId || !Number.isInteger(header.imageBytes) || header.imageBytes < 0 || bytes.length - newline - 1 !== header.imageBytes) throw new Error('后台控制响应身份或图片长度不匹配')
          if (header.ok !== true) throw new Error(header.error || '后台输入执行失败')
          finish(undefined, { header, image: bytes.subarray(newline + 1) })
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      })
    })
  }
}
