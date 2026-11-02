import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { gameKeyCode, type GameCaptureView } from '../../../../src/shared/gameControl'
import type { BackgroundGameControlSession, BackgroundGameInput, BackgroundGameState } from './gameControlSession'
import { DiagnosticHistory } from '../../../../src/main/diagnosticHistory'
import { diagnosticValue } from '../../../../src/main/diagnosticContext'

type Transport = Pick<BackgroundGameControlSession, 'sessionId' | 'status' | 'sync' | 'input' | 'capture' | 'release' | 'settle' | 'ownership'>
type Action = Record<string, unknown>
type Receipt = { requestId: string; status: 'running' | 'completed' | 'cancelled' | 'failed'; operation: string; completedSteps: number; acknowledged: boolean; gameplayVerified: false; error?: string; frameId?: number; captures?: GameCaptureView[] }
const coordinateOperations = new Set(['click', 'double_click', 'move', 'drag', 'button_down', 'button_up'])
const allowed = new Set(['click', 'double_click', 'move', 'drag', 'look', 'scroll', 'text', 'command', 'key', 'key_down', 'key_up', 'button_down', 'button_up', 'combo', 'wait', 'inventory', 'close', 'interact'])
function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${label} 需在 ${min}–${max} 之间`)
  return value
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label} 无效或过长`)
  return value
}
function idFor(requestId: string, index: number): string {
  const value = createHash('sha256').update(`${requestId}:${index}`).digest('hex').slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Action)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}

/** UI and MCP share action validation, serialization, cancellation and image coordinates. */
export class GameControlActions {
  private observations = new Map<string, { geometry: string; width: number; height: number; logicalWidth: number; logicalHeight: number; observedAt: number }>()
  private receipts = new Map<string, { fingerprint: string; result: Receipt; finished: Promise<Receipt> }>()
  private seen = new Set<string>()
  private current?: { id: string; controller: AbortController }
  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private readonly diagnostics: DiagnosticHistory
  constructor(readonly transport: Transport, private readonly directory: string) { this.diagnostics = new DiagnosticHistory(path.join(directory, 'diagnostic-activity')) }
  private record(operation: string, data: unknown): void { this.diagnostics.record({ time: new Date().toISOString(), ...{ sessionId: this.transport.sessionId, operation, data: diagnosticValue(data) } }) }

  result(id: unknown): Receipt | { requestId: unknown; status: string; instruction: string } {
    const receipt = typeof id === 'string' ? this.receipts.get(id) : undefined
    return receipt ? { ...receipt.result } : { requestId: id, status: this.seen.has(String(id)) ? 'expired' : 'unknown', instruction: 'Do not replay an uncertain action with a new requestId.' }
  }
  active() { return this.current ? { requestId: this.current.id, status: 'running' } : undefined }
  private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.tail.then(run, run); this.tail = result.catch(() => undefined); return result }

  async cancel(): Promise<{ cancelled: true }> {
    this.generation++; this.current?.controller.abort()
    this.observations.clear()
    await this.transport.release()
    return { cancelled: true }
  }
  async ownership(owner: 'ai' | 'paused' | 'human'): Promise<BackgroundGameState> {
    await this.cancel()
    return this.serial(async () => { const state = await this.transport.ownership(owner); this.observations.clear(); return state })
  }
  capture(signal?: AbortSignal): Promise<GameCaptureView> { return this.serial(() => this.captureNow(signal)) }
  private async captureNow(signal?: AbortSignal): Promise<GameCaptureView> {
    const frame = await this.transport.capture(signal)
    signal?.throwIfAborted()
    const rendered = await sharp(frame.image).resize({ width: 1600, height: 900, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
    if (rendered.data.length > 8 * 1024 * 1024) throw new Error('画面超过 MCP 图片容量限制')
    const revision = createHash('sha256').update(`${this.transport.sessionId}:${frame.coordinateRevision}:${rendered.info.width}:${rendered.info.height}:${frame.frameId}`).digest('hex')
    const observedAt = Date.now()
    this.observations.set(revision, { geometry: frame.coordinateRevision, width: rendered.info.width, height: rendered.info.height, logicalWidth: frame.logicalWidth, logicalHeight: frame.logicalHeight, observedAt })
    for (const [key, view] of this.observations) if (this.observations.size > 32 || observedAt - view.observedAt > 60000) this.observations.delete(key)
    const captures = path.join(this.directory, 'screenshots'); await fs.mkdir(captures, { recursive: true })
    const file = path.join(captures, `frame-${frame.frameId}-${randomUUID()}.png`)
    await fs.writeFile(file, rendered.data, { flag: 'wx' })
    const files = await Promise.all((await fs.readdir(captures)).filter(name => /^frame-\d+-[a-f0-9-]{36}\.png$/.test(name)).map(async name => { const file = path.join(captures, name); const stat = await fs.lstat(file); return { file, size: stat.size, mtime: stat.mtimeMs, regular: stat.isFile() && !stat.isSymbolicLink() } }))
    let count = 0, bytes = 0
    for (const entry of files.filter(file => file.regular).sort((a, b) => b.mtime - a.mtime)) { count++; bytes += entry.size; if (count > 24 || bytes > 32 * 1024 * 1024) await fs.rm(entry.file, { force: true }) }
    const capture = { path: file, dataUrl: `data:image/png;base64,${rendered.data.toString('base64')}`, mimeType: 'image/png' as const, width: rendered.info.width, height: rendered.info.height,
      logicalWidth: frame.logicalWidth, logicalHeight: frame.logicalHeight, framebufferWidth: frame.width, framebufferHeight: frame.height, frameId: frame.frameId, capturedAt: frame.capturedAt, actionSequence: frame.actionSequence, revision }
    this.record('capture', { ...capture, dataUrl: undefined, pid: frame.pid, coordinateRevision: frame.coordinateRevision, sha256: createHash('sha256').update(rendered.data).digest('hex') })
    return capture
  }

  action(input: Action, ownerSignal?: AbortSignal): Promise<Receipt | { cancelled: true }> {
    if (input.operation === 'cancel' || input.operation === 'release') return this.cancel()
    const requestId = input.requestId === undefined ? randomUUID() : String(input.requestId)
    if (!/^[a-f0-9-]{36}$/.test(requestId)) return Promise.reject(new Error('requestId 需要 UUID'))
    const { requestId: _requestId, sessionId: _sessionId, ...parameters } = input
    const fingerprint = canonical(parameters)
    const existing = this.receipts.get(requestId)
    if (existing) return existing.fingerprint === fingerprint ? existing.finished : Promise.reject(new Error('同一 requestId 不可用于不同动作'))
    if (this.seen.has(requestId)) return Promise.reject(new Error('请求结果已过期，不会重复执行；请重新观察'))
    if (this.seen.size >= 4096) return Promise.reject(new Error('会话动作记录已满，请结束后重新启动'))
    if ([...this.receipts.values()].filter(receipt => receipt.result.status === 'running').length >= 32) return Promise.reject(new Error('后台动作排队已满'))
    this.seen.add(requestId)
    const result: Receipt = { requestId, status: 'running', operation: String(input.operation), completedSteps: 0, acknowledged: false, gameplayVerified: false }
    this.record('action-request', { requestId, input })
    const entry = { fingerprint, result, finished: Promise.resolve(result) }
    const generation = this.generation
    entry.finished = this.serial(async () => {
      const controller = new AbortController()
      const signal = ownerSignal ? AbortSignal.any([ownerSignal, controller.signal]) : controller.signal
      let primitiveIndex = 0
      const send = (action: BackgroundGameInput, geometry?: string) => this.transport.input(action, { signal, requestId: idFor(requestId, ++primitiveIndex), coordinateRevision: geometry })
      try {
        signal.throwIfAborted()
        if (generation !== this.generation) throw new Error('动作排队期间已取消或交接控制')
        const state = await this.transport.sync(signal)
        signal.throwIfAborted()
        if (state.error) throw new Error(state.error)
        if (generation !== this.generation) throw new Error('动作排队期间已取消或交接控制')
        if (state.ownership !== 'ai') throw new Error('AI 控制已暂停或由用户接管，请先恢复')
        if (state.family === 'waiting' || !state.ready) throw new Error('游戏输入或渲染尚未就绪')
        const family = state.family
        const steps: Action[] = input.operation === 'batch' ? (input.steps as Action[]) : [input]
        if (!Array.isArray(steps) || !steps.length || steps.length > 32) throw new Error('动作批次需要 1–32 步')
        let budget = 0
        // Full validation precedes the first input, including every batch step.
        for (const step of steps) budget += this.validate(step, state.family)
        if (budget > 10_000) throw new Error('动作批次累计时长不能超过 10 秒')
        const needsCoordinates = steps.some(step => coordinateOperations.has(String(step.operation)))
        // The preview and MCP can observe concurrently. Refreshing one viewer
        // must not revoke another viewer's still-current geometry token.
        const view = typeof input.revision === 'string' ? this.observations.get(input.revision) : undefined
        if (needsCoordinates && (!view || Date.now() - view.observedAt > 60000 || state.coordinateRevision !== view.geometry)) { this.observations.clear(); throw new Error('画面坐标已过期，请重新截图并使用返回的 revision') }
        if (view) for (const step of steps) {
          if (['click', 'double_click', 'move', 'drag'].includes(String(step.operation))) { number(step.x, 'x', 0, view.width - 1); number(step.y, 'y', 0, view.height - 1) }
          if (step.operation === 'drag') { number(step.toX, 'toX', 0, view.width - 1); number(step.toY, 'toY', 0, view.height - 1) }
        }
        this.current = { id: requestId, controller }
        const point = (x: unknown, y: unknown) => {
          if (!view) throw new Error('需要先截图')
          const px = number(x, 'x', 0, view.width - 1), py = number(y, 'y', 0, view.height - 1)
          return { type: 'move' as const, x: px * view.logicalWidth / view.width, y: py * view.logicalHeight / view.height }
        }
        const press = async (code: number, duration: number, mouse = false, geometry?: string) => {
          await send({ type: mouse ? 'button' : 'key', code, state: 'down', leaseMs: Math.min(5000, duration + 1000) }, geometry)
          await delay(duration, undefined, { signal })
          await send({ type: mouse ? 'button' : 'key', code, state: 'up' }, geometry)
        }
        for (const step of steps) {
          signal.throwIfAborted()
          const op = String(step.operation), duration = Number(step.durationMs ?? 80), button = Number(step.button ?? 0), code = step.key === undefined ? 0 : gameKeyCode(step.key, state.family)
          const geometry = needsCoordinates ? view!.geometry : undefined
          if (['click', 'double_click', 'move', 'drag'].includes(op)) await send(point(step.x, step.y), geometry)
          switch (op) {
            case 'move': break
            case 'click': await press(button, 50, true, geometry); break
            case 'double_click': await press(button, 40, true, geometry); await delay(70, undefined, { signal }); await press(button, 40, true, geometry); break
            case 'drag': {
              await send({ type: 'button', code: button, state: 'down', leaseMs: Math.min(5000, duration + 1000) }, geometry)
              const destination = point(step.toX, step.toY), start = point(step.x, step.y), count = Math.max(2, Math.min(24, Math.ceil(duration / 30)))
              for (let index = 1; index <= count; index++) { await delay(duration / count, undefined, { signal }); await send({ type: 'move', x: start.x + (destination.x - start.x) * index / count, y: start.y + (destination.y - start.y) * index / count }, geometry) }
              await send({ type: 'button', code: button, state: 'up' }, geometry); break
            }
            case 'button_down': case 'button_up': await send({ type: 'button', code: button, state: op === 'button_down' ? 'down' : 'up', leaseMs: duration }, geometry); break
            case 'key_down': case 'key_up': await send({ type: 'key', code, state: op === 'key_down' ? 'down' : 'up', leaseMs: duration }); break
            case 'key': await press(code, duration); break
            case 'combo': {
              const codes = (step.keys as string[]).map(key => gameKeyCode(key, family))
              for (const code of codes) await send({ type: 'key', code, state: 'down', leaseMs: Math.min(5000, duration + 1000) })
              await delay(duration, undefined, { signal }); for (const code of codes.reverse()) await send({ type: 'key', code, state: 'up' }); break
            }
            case 'look': await send({ type: 'look', x: Number(step.dx), y: Number(step.dy) }); break
            case 'scroll': await send({ type: 'scroll', x: Number(step.horizontal ?? 0), y: Number(step.clicks) }); break
            case 'text': await send({ type: 'text', text: String(step.text) }); if (step.pressEnter) await press(gameKeyCode('Enter', state.family), 50); break
            case 'command': await press(gameKeyCode('T', state.family), 50); await send({ type: 'text', text: '/' + String(step.command).replace(/^\//, '') }); await press(gameKeyCode('Enter', state.family), 50); break
            case 'inventory': await press(gameKeyCode('E', state.family), 50); break
            case 'close': await press(gameKeyCode('Escape', state.family), 50); break
            case 'interact': await press(1, 50, true); break
            case 'wait': await delay(duration, undefined, { signal }); break
          }
          result.completedSteps++
        }
        if (input.operation === 'batch') await this.transport.release()
        const settled = await this.transport.settle(signal)
        const consumed = await this.transport.status(signal)
        if (consumed.error) throw new Error(consumed.error)
        result.frameId = settled.frameId; result.acknowledged = true; result.status = 'completed'
        // High-level input may open a different screen. Preserve only raw
        // pointer gesture continuity; a subsequent key/click requires a new view.
        if (input.operation === 'batch' || !['move', 'button_down', 'button_up', 'wait'].includes(String(input.operation))) this.observations.clear()
        if (input.capture === true) result.captures = [await this.captureNow(signal)]
        let images = 0
        for (const receipt of [...this.receipts.values()].reverse()) if (receipt.result.captures && ++images > 2) receipt.result.captures = undefined
      } catch (error) {
        result.status = signal.aborted || generation !== this.generation ? 'cancelled' : 'failed'
        result.error = error instanceof Error ? error.message : String(error)
        this.observations.clear()
        await this.transport.release().catch(() => undefined)
      } finally {
        if (this.current?.id === requestId) this.current = undefined
        const lightweight = { ...result, captures: result.captures?.map(({ dataUrl: _data, ...rest }) => rest) }
        this.record('action-result', lightweight)
        await fs.mkdir(this.directory, { recursive: true }).then(() => fs.writeFile(path.join(this.directory, 'last-action.json'), JSON.stringify(lightweight, null, 2))).catch(() => undefined)
      }
      return result
    })
    this.receipts.set(requestId, entry)
    for (const [id, receipt] of this.receipts) if (this.receipts.size > 128 && receipt.result.status !== 'running') this.receipts.delete(id)
    return entry.finished
  }

  private validate(step: Action, family: 'glfw' | 'lwjgl2' | 'sdl'): number {
    if (!step || typeof step !== 'object' || !allowed.has(String(step.operation))) throw new Error('不支持的后台动作；批次不能嵌套')
    const op = String(step.operation), duration = number(step.durationMs ?? 80, 'durationMs', 1, 5000, true)
    if (step.button !== undefined) number(step.button, 'button', 0, 7, true)
    if (['key', 'key_down', 'key_up'].includes(op)) gameKeyCode(step.key, family)
    if (op === 'combo') { if (!Array.isArray(step.keys) || !step.keys.length || step.keys.length > 8 || new Set(step.keys).size !== step.keys.length) throw new Error('组合键需要 1–8 个不重复按键'); step.keys.forEach(key => gameKeyCode(key, family)) }
    if (['click', 'double_click', 'move', 'drag'].includes(op)) { number(step.x, 'x', 0, 16384); number(step.y, 'y', 0, 16384) }
    if (op === 'drag') { number(step.toX, 'toX', 0, 16384); number(step.toY, 'toY', 0, 16384); if (duration > 4000) throw new Error('单次拖动最长 4000 毫秒') }
    if (op === 'look') { number(step.dx, 'dx', -4096, 4096); number(step.dy, 'dy', -4096, 4096); if (step.yaw !== undefined || step.pitch !== undefined) throw new Error('后台视角使用相对 dx/dy，不能指定绝对角度') }
    if (op === 'scroll') { number(step.clicks, 'clicks', -100, 100); number(step.horizontal ?? 0, 'horizontal', -100, 100) }
    if (op === 'text') text(step.text, 'text', 512)
    if (op === 'command') text(step.command, 'command', 500)
    return ['key', 'combo', 'drag', 'wait'].includes(op) ? duration : op === 'double_click' ? 150 : ['click', 'inventory', 'close', 'interact'].includes(op) ? 50 : 0
  }
}
