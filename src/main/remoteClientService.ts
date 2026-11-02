import { WebSocket as UndiciWebSocket } from 'undici'
import type { RemoteConnectionState } from '../shared/types'
import { diagnosticJournal } from './diagnosticLog'
import { diagnosticValue } from './diagnosticContext'

export interface RemoteServerCommand {
  type: 'server.command'
  requestId: string
  text: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export interface RemoteServerCancel {
  type: 'server.cancel'
  requestId: string
  targetRequestId: string
  createdAt?: string
}

export interface RemoteResponse {
  status: 'COMPLETED' | 'FAILED'
  text?: string
  error?: string
  result?: Record<string, unknown>
}

export interface RemoteClientCallbacks {
  getCredential: () => Promise<string | null>
  onCommand: (command: RemoteServerCommand, context: { signal: AbortSignal; activity: (text: string, progress?: number) => void }) => Promise<RemoteResponse>
  onCancel: (message: RemoteServerCancel) => Promise<string>
  onState?: (state: RemoteConnectionState) => void
}

interface RemoteMessage {
  type?: unknown
  requestId?: unknown
  targetRequestId?: unknown
  code?: unknown
  message?: unknown
}

const MAX_FRAME_BYTES = 128 * 1024
const MAX_ACTIVITY_CHARS = 2_000
const MAX_RESULT_CHARS = 20_000
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000]
const RECENT_RESPONSE_TTL_MS = 10 * 60_000
const MAX_RECENT_RESPONSES = 100

function boundedText(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max)
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return '' }
}

function jsonSafeRecord(value: unknown): Record<string, unknown> | undefined {
  const serialized = safeJson(value)
  if (!serialized) return undefined
  try {
    const parsed = JSON.parse(serialized) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function responsePayload(requestId: string, response: RemoteResponse): Record<string, unknown> {
  const text = typeof response.text === 'string' ? response.text : ''
  const error = typeof response.error === 'string' ? response.error : ''
  const result = response.result && typeof response.result === 'object' ? jsonSafeRecord(response.result) : undefined
  let payload: Record<string, unknown> = {
    type: 'device.response',
    requestId,
    status: response.status,
    ...(response.status === 'FAILED' ? { error: boundedText(error || text || 'Remote Agent 执行失败', MAX_RESULT_CHARS) } : { text: boundedText(text, MAX_RESULT_CHARS) }),
    ...(result ? { result } : {})
  }
  if (Buffer.byteLength(safeJson(payload), 'utf8') <= MAX_FRAME_BYTES && safeJson({ text: payload.text, result: payload.result }).length <= MAX_RESULT_CHARS) return payload
  payload = { type: 'device.response', requestId, status: response.status, ...(response.status === 'FAILED' ? { error: boundedText(error || text || 'Remote Agent 执行失败', MAX_RESULT_CHARS) } : { text: boundedText(text, MAX_RESULT_CHARS) }) }
  if (Buffer.byteLength(safeJson(payload), 'utf8') <= MAX_FRAME_BYTES) return payload
  if (response.status === 'FAILED') return { type: 'device.response', requestId, status: 'FAILED', error: boundedText(error || text || 'Remote Agent 执行失败', 4_000) }
  return { type: 'device.response', requestId, status: 'COMPLETED', text: boundedText(text, 4_000) }
}

export function remoteEndpointFromSite(siteUrl: string): string {
  const url = new URL(siteUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/ws/remote'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class RemoteClientService {
  private socket: InstanceType<typeof UndiciWebSocket> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private retryIndex = 0
  private currentRequestId: string | undefined
  private activeController: AbortController | null = null
  private activityTimes: number[] = []
  private readonly pendingResponses = new Map<string, Record<string, unknown>>()
  private readonly recentResponses = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>()
  private readonly listeners = new Set<(state: RemoteConnectionState) => void>()
  private state: RemoteConnectionState

  constructor(
    private readonly endpoint: string,
    private readonly deviceId: string,
    private readonly deviceName: string,
    private readonly clientVersion: string,
    private readonly callbacks: RemoteClientCallbacks
  ) {
    this.state = { status: 'disabled', enabled: false, endpoint, deviceId }
  }

  getState(): RemoteConnectionState { return this.state }

  onState(listener: (state: RemoteConnectionState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<RemoteConnectionState> {
    this.stopped = false
    this.retryIndex = 0
    this.update({ enabled: true, status: this.socket ? this.state.status : 'connecting', lastError: undefined })
    if (!this.socket) this.connect()
    return this.state
  }

  async stop(): Promise<RemoteConnectionState> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.authTimer) clearTimeout(this.authTimer)
    this.retryTimer = null
    this.authTimer = null
    this.activeController?.abort()
    this.activeController = null
    this.currentRequestId = undefined
    this.pendingResponses.clear()
    this.recentResponses.clear()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < socket.CLOSING) socket.close(1000, 'client shutdown')
    this.update({ status: 'disabled', enabled: false, activeRequestId: undefined, reconnectAt: undefined, lastError: undefined })
    return this.state
  }

  private update(next: Partial<RemoteConnectionState>): void {
    this.state = {...this.state, ...next}
    for (const listener of this.listeners) listener(this.state)
    this.callbacks.onState?.(this.state)
  }

  private connect(): void {
    if (this.stopped || this.socket) return
    this.update({ status: 'connecting', lastError: undefined })
    let socket: InstanceType<typeof UndiciWebSocket>
    try { socket = new UndiciWebSocket(this.endpoint) } catch (error) {
      this.handleDisconnect(error instanceof Error ? error.message : String(error), 0)
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => { void this.authenticate(socket) })
    socket.addEventListener('message', (event) => { void this.handleMessage(event.data, socket) })
    socket.addEventListener('error', () => this.update({ lastError: 'Remote WebSocket 连接错误' }))
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = null
      this.handleDisconnect(event.reason || `Remote WebSocket 已关闭（${event.code}）`, event.code)
    })
  }

  private async authenticate(socket: InstanceType<typeof UndiciWebSocket>): Promise<void> {
    if (this.stopped || this.socket !== socket) return
    this.update({ status: 'authenticating' })
    this.authTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState < socket.CLOSING) socket.close(4001, 'authentication timeout')
    }, 10_000)
    try {
      const credential = await this.callbacks.getCredential()
      if (typeof credential !== 'string' || credential.length < 1 || credential.length > 1_024) throw new Error('没有可用的 ModMind 接入 Key')
      if (this.deviceId.length < 1 || this.deviceId.length > 100) throw new Error('Remote 设备 ID 无效')
      if (this.deviceName.length < 1 || this.deviceName.length > 100) throw new Error('Remote 设备名称无效')
      const hello = {
        type: 'device.hello',
        credential,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        deviceType: 'DESKTOP',
        clientVersion: this.clientVersion
      }
      const serialized = JSON.stringify(hello)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) throw new Error('Remote 鉴权消息过大')
      socket.send(serialized)
    } catch (error) {
      if (this.authTimer) clearTimeout(this.authTimer)
      this.authTimer = null
      if (this.socket === socket && socket.readyState < socket.CLOSING) socket.close(4003, 'authentication failed')
      this.update({ status: 'error', lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  private async handleMessage(raw: unknown, sourceSocket: InstanceType<typeof UndiciWebSocket>): Promise<void> {
    if (this.socket !== sourceSocket) return
    const text = typeof raw === 'string' ? raw : String(raw ?? '')
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) return
    let message: RemoteMessage
    try { message = JSON.parse(text) as RemoteMessage } catch { return }
    if (['server.command', 'server.cancel', 'response.ack', 'server.error'].includes(String(message.type))) {
      diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'received', message: `Remote ${String(message.type)}`, data: { requestId: message.requestId, targetRequestId: message.targetRequestId, type: message.type, input: diagnosticValue(message) } })
    }
    if (message.type === 'server.ready') {
      if (this.authTimer) clearTimeout(this.authTimer)
      this.authTimer = null
      this.retryIndex = 0
      const protocolVersion = typeof (message as { protocolVersion?: unknown }).protocolVersion === 'number' ? Number((message as { protocolVersion: number }).protocolVersion) : 2
      this.update({ status: 'ready', protocolVersion, lastError: undefined, reconnectAt: undefined })
      for (const payload of this.pendingResponses.values()) this.send(payload)
      return
    }
    if (this.state.status !== 'ready') return
    if (message.type === 'activity.ack') return
    if (message.type === 'response.ack') {
      if (typeof message.requestId === 'string') this.pendingResponses.delete(message.requestId)
      return
    }
    if (message.type === 'server.error') {
      const code = typeof message.code === 'string' ? message.code : 'REMOTE_ERROR'
      const detail = typeof message.message === 'string' ? message.message : code
      if (code === 'REMOTE_DISABLED') this.disablePermanently(detail)
      else this.update({ lastError: detail })
      return
    }
    if (message.type === 'server.command') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : ''
      const commandText = typeof (message as { text?: unknown }).text === 'string' ? String((message as { text: string }).text) : ''
      if (!requestId || !commandText) return
      const previousResponse = this.pendingResponses.get(requestId)
      if (previousResponse) {
        diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'deduplicated', message: 'Resending an unacknowledged result without executing again', data: { requestId } })
        this.send(previousResponse)
        return
      }
      const recentResponse = this.recentResponses.get(requestId)
      if (recentResponse) {
        if (recentResponse.expiresAt > Date.now()) {
          diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'deduplicated', message: 'Replayed completed response without executing again', data: { requestId } })
          this.send(recentResponse.payload)
          return
        }
        this.recentResponses.delete(requestId)
      }
      if (this.currentRequestId === requestId) {
        diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'deduplicated-active', message: 'Duplicate in-flight command ignored', data: { requestId } }); return
      }
      if (this.currentRequestId) {
        this.sendResponse(requestId, { status: 'FAILED', error: '设备当前已有 Remote 任务正在运行' })
        return
      }
      const command = message as unknown as RemoteServerCommand
      this.currentRequestId = requestId
      this.activeController = new AbortController()
      this.update({ activeRequestId: requestId })
      void this.handleCommand(command, this.activeController).finally(() => {
        if (this.currentRequestId === requestId) {
          this.currentRequestId = undefined
          this.activeController = null
          this.update({ activeRequestId: undefined })
        }
      })
      return
    }
    if (message.type === 'server.cancel') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : ''
      const targetRequestId = typeof message.targetRequestId === 'string' ? message.targetRequestId : ''
      if (!requestId || !targetRequestId) return
      const cancel = message as unknown as RemoteServerCancel
      if (targetRequestId !== this.currentRequestId) {
        this.sendResponse(requestId, { status: 'COMPLETED', text: 'Remote 目标任务当前不在运行' })
        return
      }
      this.activeController?.abort()
      try {
        const text = await this.callbacks.onCancel(cancel)
        this.sendResponse(requestId, { status: 'COMPLETED', text })
      } catch (error) {
        this.sendResponse(requestId, { status: 'FAILED', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  private async handleCommand(command: RemoteServerCommand, controller: AbortController): Promise<void> {
    try {
      const response = await this.callbacks.onCommand(command, {
        signal: controller.signal,
        activity: (text, progress) => this.sendActivity(command.requestId, text, progress)
      })
      this.sendActivity(command.requestId, response.status === 'COMPLETED' ? 'Remote 任务已完成' : 'Remote 任务失败', response.status === 'COMPLETED' ? 1 : undefined, response.status)
      this.sendResponse(command.requestId, response)
    } catch (error) {
      this.sendActivity(command.requestId, 'Remote 任务失败', undefined, 'FAILED')
      this.sendResponse(command.requestId, { status: 'FAILED', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private sendActivity(requestId: string, text: string, progress?: number, state: 'RUNNING' | 'COMPLETED' | 'FAILED' = 'RUNNING'): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN || this.state.status !== 'ready') return
    const now = Date.now()
    this.activityTimes = this.activityTimes.filter((value) => now - value < 60_000)
    if (this.activityTimes.length >= 60) return
    this.activityTimes.push(now)
    const payload = {
      type: 'device.activity',
      requestId,
      text: boundedText(text, MAX_ACTIVITY_CHARS),
      state,
      ...(typeof progress === 'number' && Number.isFinite(progress) ? { progress: Math.max(0, Math.min(1, progress)) } : {})
    }
    this.send(payload)
  }

  private sendResponse(requestId: string, response: RemoteResponse): void {
    diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'result', level: response.status === 'FAILED' ? 'warning' : 'info', message: 'Remote execution returned', data: { requestId, result: diagnosticValue(response) } })
    const payload = responsePayload(requestId, response)
    this.pendingResponses.set(requestId, payload)
    this.recentResponses.set(requestId, { payload, expiresAt: Date.now() + RECENT_RESPONSE_TTL_MS })
    while (this.recentResponses.size > MAX_RECENT_RESPONSES) {
      const oldest = this.recentResponses.keys().next().value
      if (typeof oldest !== 'string') break
      this.recentResponses.delete(oldest)
    }
    this.send(payload)
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return
    const serialized = safeJson(payload)
    if (!serialized) return
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) return
    this.socket.send(serialized)
    if (payload.type === 'device.response') diagnosticJournal.record({ subsystem: 'remote', operation: 'message', phase: 'sent', message: 'Remote result sent; awaiting acknowledgement', data: { requestId: payload.requestId, status: payload.status } })
  }

  private handleDisconnect(message: string, code: number): void {
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    if (this.stopped) return
    if (code === 4004 || /(?:remote|远程控制).*(?:disabled|关闭|尚未启用|未启用)/i.test(message)) {
      this.disablePermanently(message || '远程控制尚未启用')
      return
    }
    if (code === 4003) {
      this.update({ status: 'error', lastError: message, enabled: true })
      return
    }
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)]
    this.retryIndex += 1
    const reconnectAt = new Date(Date.now() + delay).toISOString()
    this.update({ status: 'backoff', lastError: message, reconnectAt })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private disablePermanently(message: string): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.authTimer) clearTimeout(this.authTimer)
    this.retryTimer = null
    this.authTimer = null
    this.activeController?.abort()
    this.activeController = null
    this.currentRequestId = undefined
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < socket.CLOSING) socket.close(4004, 'remote disabled')
    this.update({ status: 'disabled', enabled: false, activeRequestId: undefined, reconnectAt: undefined, lastError: message })
  }
}
