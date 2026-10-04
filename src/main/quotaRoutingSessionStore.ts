import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RoutingSession } from './quotaModelRouting'
import { isSelectableQuotaModel } from '../shared/quotaModels'

export class QuotaRoutingSessionStore {
  constructor(private file: string, private encrypt: (text: string) => Buffer, private decrypt: (bytes: Buffer) => string) {}
  async clear(): Promise<void> { await fs.rm(this.file, { force: true }) }
  async read(): Promise<RoutingSession | null> {
    let encoded: string
    try { encoded = await fs.readFile(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('无法读取模型切换会话')
    }
    try {
      const value = JSON.parse(this.decrypt(Buffer.from(encoded, 'base64'))) as RoutingSession
      if (!/^[a-f0-9]{64}$/.test(value.owner) || typeof value.token !== 'string' || !value.token || value.token.length > 4096 || !Number.isFinite(value.expiresAt)) throw new Error()
      if (value.pending && (!isSelectableQuotaModel(value.pending.model) || !(['primary','secondary','deepseek'].includes(value.pending.route.account) && typeof value.pending.route.group === 'string'
        || /^trial:[a-zA-Z0-9._-]{1,128}$/.test(value.pending.route.account) && value.pending.route.group === null))) throw new Error()
      return value
    } catch { throw new Error('模型切换会话无法解密，请重新连接账号') }
  }
  async write(value: RoutingSession): Promise<void> {
    const encoded = this.encrypt(JSON.stringify(value)).toString('base64')
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      await fs.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }
}
