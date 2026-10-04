import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QuotaRoutingSessionStore } from './quotaRoutingSessionStore'

describe('encrypted quota routing session', () => {
  it('persists a pending selection without plaintext credentials and rejects corrupt storage', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-session-'))
    const file = path.join(directory, 'session.enc')
    const store = new QuotaRoutingSessionStore(file, text => Buffer.from([...text].reverse().join('')), bytes => [...bytes.toString()].reverse().join(''))
    try {
      expect(await store.read()).toBeNull()
      const session = { owner: 'a'.repeat(64), token: 'routing-private', expiresAt: Date.now() + 10000, pending: { model: 'kimi-k3', route: { account: 'secondary', group: 'Kimi' } } }
      await store.write(session)
      expect(await fs.readFile(file, 'utf8')).not.toContain('routing-private')
      expect(await store.read()).toEqual(session)
      await store.write({ ...session, pending: undefined })
      expect((await store.read())?.pending).toBeUndefined()
      const free = { ...session, pending: {model:'deepseek-v4.1-flash',route:{account:'trial:free-example',group:null}} }
      await store.write(free); expect(await store.read()).toEqual(free)
      await fs.writeFile(file, 'corrupt')
      await expect(store.read()).rejects.toThrow('重新连接账号')
      await store.clear(); expect(await store.read()).toBeNull()
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
})
