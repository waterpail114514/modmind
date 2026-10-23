import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createStoredZip } from '../../../../src/main/bedrockAddon'
import agent from './shaderSessionAgent.json'
import { hash } from './shaderFiles'
import type { ShaderRuntimeObservation } from '../../../../src/shared/shaderStudio'

export function shaderSessionAgentJar(): Buffer {
  const classes = agent.classes.map(entry => {
    const data = Buffer.from(entry.data, 'base64')
    if (hash(data) !== entry.sha256) throw new Error('光影测试适配器校验失败')
    return { name: entry.path, data }
  })
  return createStoredZip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\nPremain-Class: dev.modmind.shader.ShaderSessionAgent\r\n\r\n') }, ...classes], true)
}
export class ShaderSessionAgentClient {
  constructor(private readonly port: number, private readonly pid: number, private readonly sessionId: string, private readonly secret: string, private readonly alive: () => boolean) {}
  private request(operation: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive()) return Promise.reject(new Error('光影测试进程已退出'))
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = randomUUID(), socket = createConnection({ host: '127.0.0.1', port: this.port })
      let text = '', settled = false
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort); socket.destroy()
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(new Error('光影测试操作已取消'))
      const timeout = setTimeout(() => finish(new Error('光影测试适配器响应超时')), 15000)
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('connect', () => socket.write(`${id}\t${this.secret}\t${operation}\n`))
      socket.once('error', error => finish(error))
      socket.once('end', () => { if (!settled) finish(new Error('光影适配器连接已关闭')) })
      socket.on('data', bytes => {
        text += bytes.toString('utf8')
        if (text.length > 2 * 1024 * 1024) { finish(new Error('光影适配器返回过大')); return }
        const newline = text.indexOf('\n'); if (newline < 0) return
        try {
          const parts = text.slice(0, newline).split('\t')
          if (parts.length !== 3 || parts[0] !== id || !/^[A-Za-z0-9+/=]*$/.test(parts[2])) throw new Error('光影适配器响应标识无效')
          const payload = Buffer.from(parts[2], 'base64').toString('utf8')
          if (parts[1] !== 'ok') throw new Error(payload)
          finish(undefined, JSON.parse(payload))
        } catch (error) { finish(error as Error) }
      })
      if (signal?.aborted) abort()
    })
  }
  async verify(signal?: AbortSignal): Promise<void> {
    const value = await this.request('hello', signal) as { protocol?: number; sessionId?: string; pid?: number }
    if (value.protocol !== 1 || value.sessionId !== this.sessionId || value.pid !== this.pid) throw new Error('光影测试进程身份不匹配')
  }
  async observe(operation: 'state' | 'reload' = 'state', signal?: AbortSignal): Promise<ShaderRuntimeObservation> {
    await this.verify(signal)
    const value = await this.request(operation, signal) as ShaderRuntimeObservation
    if (!value || value.gameReady !== true || typeof value.shaderPackLoaded !== 'boolean' || !value.effectiveOptions || typeof value.effectiveOptions !== 'object' || Array.isArray(value.effectiveOptions)
      || [value.packName, value.pipeline, value.pipelineError, value.profile].some(field => field !== null && typeof field !== 'string') || typeof value.observedAt !== 'string') throw new Error('光影运行状态不完整')
    return value
  }
  async stop(): Promise<void> { await this.verify(); await this.request('stop') }
}
