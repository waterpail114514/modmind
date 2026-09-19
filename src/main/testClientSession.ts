import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnManaged, stopProcessTree } from './processTree'
import { SerialState } from './liveConfiguration'
import { managedJavaEnvironment } from './javaEnvironment'

export interface TestClientStart {
  javaPath: string; launcherPath: string; profile: string; minecraftRoot: string; gameDirectory: string
  mode: 'headless' | 'rendered'; username: string; offline: boolean; inventorySupported: boolean; keysSupported: boolean
}
export interface ClientObservation { revision: string; cursor: number; text: string; acknowledged: boolean }
const quote = (text: string): string => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** Owns one real Minecraft process. No OS keyboard injection and no arbitrary HMC reflection commands. */
export class TestClientSession {
  private child?: ChildProcessWithoutNullStreams
  private sequence = 0
  private entries: Array<{ sequence: number; text: string }> = []
  private queue = new SerialState()
  private revision = ''
  private transcriptError = ''
  private processError = ''
  private mode: 'headless' | 'rendered' = 'headless'
  private directory = ''
  private commands = new Set<string>()
  private inventorySupported = false
  private keysSupported = false
  private transcript?: ReturnType<typeof createWriteStream>
  isRunning(): boolean { return Boolean(this.child && this.child.exitCode === null && !this.child.killed) }
  capabilities(): Record<string, boolean> { return { inventory: this.inventorySupported && this.commands.has('menu'), tooltip: this.inventorySupported && this.commands.has('gui'), ...Object.fromEntries(['gui', 'click', 'text', 'menu', 'close', 'msg', 'connect', 'key'].map(name => [name, this.commands.has(name)])) } }
  logs(after = 0): { cursor: number; lines: string[]; truncated: boolean } {
    const entries = this.entries.filter(e => e.sequence > after)
    return { cursor: this.sequence, lines: entries.slice(-200).map(e => e.text), truncated: entries.length > 200 || Boolean(this.entries[0] && after < this.entries[0].sequence - 1) }
  }
  async start(input: TestClientStart, signal?: AbortSignal): Promise<void> {
    if (this.isRunning()) throw new Error('测试客户端已在运行')
    if (!/^[\w.+:-]+$/.test(input.profile) || !/^[A-Za-z0-9_]{3,16}$/.test(input.username)) throw new Error('测试 profile 或角色名称无效')
    this.inventorySupported = input.inventorySupported; this.keysSupported = input.keysSupported
    this.mode = input.mode; this.directory = input.gameDirectory; this.sequence = 0; this.entries = []; this.commands.clear()
    await fs.mkdir(path.join(input.gameDirectory, 'logs'), { recursive: true })
    this.transcriptError = ''; this.processError = ''; this.revision = ''
    this.transcript = createWriteStream(path.join(input.gameDirectory, 'logs', 'modmind-client.log'))
    this.transcript.on('error', error => { this.transcriptError = error.message })
    const child = spawnManaged(input.javaPath, [
      `-Dhmc.gamedir=${input.gameDirectory}`, `-Dhmc.mcdir=${input.minecraftRoot}`, `-Dhmc.java.versions=${input.javaPath}`,
      '-Dhmc.jline.enabled=false', '-Dhmc.no.auto.config=true', '-Dhmc.auto.download.specifics=false',
      `-Dhmc.offline.username=${input.username}`, `-Dhmc.assets.dummy=${input.mode === 'headless'}`,
      '-jar', input.launcherPath
    ], { cwd: path.dirname(input.launcherPath), env: managedJavaEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    this.child = child
    let processError: Error | undefined
    child.once('error', error => { processError = error })
    child.stdin.on('error', error => { this.processError = error.message })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', error => { this.processError = error.message })
      const decoder = new StringDecoder('utf8'); let pending = ''
      stream.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk); if (!this.transcriptError) this.transcript?.write(text); pending += text
        const lines = pending.split(/\r?\n|\r/); pending = lines.pop() ?? ''
        if (pending.length > 64000) { lines.push(pending.slice(0, 64000)); pending = pending.slice(64000) }
        for (const line of lines) { this.entries.push({ sequence: ++this.sequence, text: line.replace(/\x1b\[[0-9;]*m/g, '') }); if (this.entries.length > 2000) this.entries.shift() }
      })
    }
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.stdin.write(`launch ${input.profile}${input.mode === 'headless' ? ' -lwjgl' : ''}${input.offline ? ' -offline' : ''}\n`)
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (processError) throw processError
        if (this.processError) throw new Error(`客户端输入通道已关闭：${this.processError}`)
        if (!this.isRunning()) throw new Error('测试客户端提前退出；请读取客户端日志')
        const output = this.logs().lines.join('\n')
        if (/Couldn't launch|Could not find Java|LaunchException/.test(output)) throw new Error('客户端启动失败；请读取测试日志')
        if (/authentication failed|not logged in|no account|login required/i.test(output)) throw new Error('客户端需要登录测试账号；请使用现有 HeadlessMC 登录入口')
        if (/HeadlessMc|headlessmc/i.test(output) && /Minecraft|fabric/i.test(output)) {
          const result = await this.exchange('help', /Dumps the currently displayed screen|Lists all currently displayed gui|Connects you to a server/i, signal, 2500)
          if (result.acknowledged) {
            for (const name of ['gui', 'click', 'text', 'menu', 'close', 'msg', 'connect', 'key']) if (new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'm').test(result.text)) this.commands.add(name)
            if (!this.keysSupported) this.commands.delete('key')
            if (this.commands.has('gui') && this.commands.has('connect')) return
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      throw new Error('测试客户端未就绪或未加载匹配的 hmc-specifics；检查日志')
    } catch (error) { await this.stop(); throw error }
  }
  private async exchange(command: string, expected: RegExp | undefined, signal?: AbortSignal, timeout = 5000): Promise<ClientObservation> {
    if (!this.isRunning()) throw new Error('测试客户端未运行')
    if (this.processError) throw new Error(`客户端输入通道已关闭：${this.processError}`)
    if (this.transcriptError) throw new Error(`客户端日志写入失败：${this.transcriptError}`)
    signal?.throwIfAborted()
    const cursor = this.sequence
    this.child!.stdin.write(`${command}\n`)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (this.processError) throw new Error(`客户端输入通道已关闭：${this.processError}`)
      if (!this.isRunning()) throw new Error('客户端在操作期间退出，动作结果未知，不要盲目重试')
      const text = this.entries.filter(entry => entry.sequence > cursor).map(entry => entry.text).join('\n')
      if (/Unknown command|Couldn't find|Please specify|need to be ingame|Exception|ERROR/i.test(text)) return { cursor: this.sequence, text, revision: '', acknowledged: false }
      if (expected?.test(text)) {
        await new Promise(resolve => setTimeout(resolve, 150))
        const fresh = this.entries.filter(entry => entry.sequence > cursor).map(entry => entry.text).join('\n')
        return { cursor: this.sequence, text: fresh.slice(-16000), revision: '', acknowledged: !/Unknown command|Couldn't find|Please specify|need to be ingame|Exception|ERROR/i.test(fresh) }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { cursor: this.sequence, text: this.entries.filter(entry => entry.sequence > cursor).map(entry => entry.text).join('\n').slice(-16000), revision: '', acknowledged: false }
  }
  observe(signal?: AbortSignal, tooltip?: number): Promise<ClientObservation> {
    return this.queue.run(async () => {
      if (tooltip !== undefined && !this.inventorySupported) throw new Error('此版本不支持物品 tooltip')
      const result = await this.exchange(tooltip === undefined ? 'gui' : `gui --tooltip ${integer(tooltip, 0, 10000)}`, tooltip === undefined ? /Screen:|not displaying|No Gui/i : /./, signal)
      this.revision = result.acknowledged ? guiRevision(result.text) : ''
      return { ...result, revision: this.revision }
    })
  }
  connect(port: number, signal?: AbortSignal): Promise<ClientObservation> { return this.queue.run(() => this.exchange(`connect 127.0.0.1 ${integer(port, 1024, 65535)}`, /Connecting to server/i, signal)) }
  action(input: Record<string, unknown>, signal?: AbortSignal): Promise<ClientObservation> {
    return this.queue.run(async () => {
      let command: string; let expected: RegExp | undefined
      const operation = String(input.operation)
      if (operation === 'inventory' && !this.inventorySupported) throw new Error('此版本不支持背包操作')
      if (operation === 'click' || operation === 'text') {
        if (!input.revision || input.revision !== this.revision) throw new Error('界面观测已过期，请先重新读取菜单')
        const fresh = await this.exchange('gui', /Screen:|not displaying|No Gui/i, signal)
        if (!fresh.acknowledged || guiRevision(fresh.text) !== this.revision) { this.revision = ''; throw new Error('界面已改变，请重新观察') }
      }
      if (operation === 'click') { command = `click ${integer(input.slot, 0, 10000)} ${integer(input.button ?? 0, 0, 1)}`; expected = /Clicking at/ }
      else if (operation === 'text') { command = `text ${integer(input.slot, 0, 10000)} ${quote(singleLine(input.text, 500))}`; expected = /Setting text field/ }
      else if (operation === 'inventory') { command = 'menu -inventory'; expected = /Opening inventory/ }
      else if (operation === 'close') { command = 'close'; expected = /closed|Closing|not displaying/i }
      else if (operation === 'command') { command = `msg ${quote('/' + singleLine(input.command, 500).replace(/^\//, ''))}`; expected = /\[CHAT\]|chat|command/i }
      else if (operation === 'key') {
        if (!this.commands.has('key')) throw new Error('此版本 hmc-specifics 不支持按键；本次能力未验证')
        const key = singleLine(input.key, 30)
        if (!/^[a-z0-9_]+$/i.test(key)) throw new Error('按键名称无效')
        command = `key ${key} --duration ${integer(input.durationMs ?? 80, 1, 2000)}`
      } else throw new Error('不支持的玩家操作')
      this.revision = ''
      return this.exchange(command, expected, signal, operation === 'key' ? 2200 : 5000)
    })
  }
  async capture(signal?: AbortSignal): Promise<{ path: string; dataUrl: string; createdAt: string }> {
    if (this.mode !== 'rendered' || !this.commands.has('key')) throw new Error('当前客户端不支持真实画面采集：需要渲染模式及 key 命令，不能使用无头空画面')
    const directory = path.join(this.directory, 'screenshots')
    const before = new Set(await fs.readdir(directory).catch(() => []))
    await this.action({ operation: 'key', key: 'f2' }, signal)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const fresh = (await fs.readdir(directory).catch(() => [])).find(name => !before.has(name) && name.endsWith('.png'))
      if (fresh) {
        const file = path.join(directory, fresh); const bytes = await fs.readFile(file)
        if (bytes.length > 8 * 1024 * 1024) throw new Error('截图过大')
        const sharp = (await import('sharp')).default
        const stats = await sharp(bytes).stats()
        if (stats.channels.slice(0, 3).every(channel => channel.stdev < 1)) throw new Error('截图为空白或单色，不能作为视觉验收')
        return { path: file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, createdAt: new Date().toISOString() }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('没有获得新的截图')
  }
  async stop(): Promise<void> {
    const child = this.child
    if (child && child.exitCode === null) { try { child.stdin.write('quit\n') } catch { /* closed */ }; await stopProcessTree(child) }
    this.child = undefined; this.commands.clear(); this.revision = ''
    const log = this.transcript; this.transcript = undefined
    if (log && !log.destroyed) await new Promise<void>(resolve => log.end(resolve))
  }
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`数值必须是 ${min}–${max} 的整数`)
  return value
}
function singleLine(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new Error('操作文字无效')
  return value
}

function guiRevision(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.replace(/^(?:\[[^\]]+\]\s*)+/, ''))
  const start = lines.findIndex(line => /^(Screen:|Minecraft is currently not displaying|No Gui)/.test(line))
  return createHash('sha256').update((start < 0 ? lines : lines.slice(start)).join('\n').trim()).digest('hex')
}
