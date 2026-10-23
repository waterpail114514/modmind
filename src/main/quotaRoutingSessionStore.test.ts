import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QuotaRoutingSessionStore } from './quotaRoutingSessionStore'
import * as fileLockRetry from './fileLockRetry'

const retryTransientFileLock = fileLockRetry.retryTransientFileLock
const encrypt = (text: string): Buffer => Buffer.from([...text].reverse().join(''))
const decrypt = (bytes: Buffer): string => [...bytes.toString()].reverse().join('')

afterEach(() => vi.restoreAllMocks())

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
      const ls = { ...session, pending: { model: 'upstream-model', route: { account: 'ls', group: '25' } } }
      await store.write(ls); expect(await store.read()).toEqual(ls)
      const scan = { ...ls, pending: { ...ls.pending, scan: true as const } }
      await store.write(scan); expect(await store.read()).toEqual(scan)
      for (const invalid of [false, 'true', 1]) {
        await store.write({ ...scan, pending: { ...scan.pending, scan: invalid } } as unknown as typeof scan)
        await expect(store.read()).rejects.toThrow('重新连接账号')
      }
      for (const route of [{ account: 'ls', group: null }, { account: 'unknown', group: '25' }, { account: 'trial:valid', group: '25' }]) {
        await store.write({ ...session, pending: { model: 'upstream-model', route } })
        await expect(store.read()).rejects.toThrow('重新连接账号')
      }
      await fs.writeFile(file, 'corrupt')
      await expect(store.read()).rejects.toThrow('重新连接账号')
      await store.clear(); expect(await store.read()).toBeNull()
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each([1, 2])('retries %i temporary rename locks and replaces the encrypted session', async failures => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-session-'))
    const file = path.join(directory, 'session.enc')
    const store = new QuotaRoutingSessionStore(file, encrypt, decrypt)
    const previous = { owner: 'a'.repeat(64), token: 'previous-private', expiresAt: Date.now() + 10000 }
    const next = { ...previous, token: 'next-private', pending: { model: 'kimi-k3', route: { account: 'secondary', group: 'Kimi' } } }
    try {
      await store.write(previous)
      const rename = fs.rename
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(rename)
      for (let attempt = 0; attempt < failures; attempt++) renameSpy.mockRejectedValueOnce(Object.assign(new Error('temporarily locked'), { code: 'EPERM' }))
      await store.write(next)
      expect(renameSpy).toHaveBeenCalledTimes(failures + 1)
      expect(new Set(renameSpy.mock.calls.map(([source]) => source)).size).toBe(1)
      expect(renameSpy.mock.calls.every(([, target]) => target === file)).toBe(true)
      expect(await store.read()).toEqual(next)
      expect(await fs.readFile(file, 'utf8')).not.toContain('next-private')
      expect(await fs.readdir(directory)).toEqual(['session.enc'])
    } finally { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each([
    { code: 'EPERM', calls: 3 },
    { code: 'EIO', calls: 1 }
  ])('preserves the previous encrypted session and removes temporary files after $code', async ({ code, calls }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-session-'))
    const file = path.join(directory, 'session.enc')
    const store = new QuotaRoutingSessionStore(file, encrypt, decrypt)
    const previous = { owner: 'a'.repeat(64), token: 'previous-private', expiresAt: Date.now() + 10000 }
    try {
      await store.write(previous)
      const encoded = await fs.readFile(file, 'utf8')
      const failure = Object.assign(new Error('rename failed'), { code })
      // Keep the shared retry policy while bounding this test's delay and attempts.
      vi.spyOn(fileLockRetry, 'retryTransientFileLock').mockImplementation(operation => retryTransientFileLock(operation, [0, 0]))
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValue(failure)
      await expect(store.write({ ...previous, token: 'next-private' })).rejects.toBe(failure)
      expect(renameSpy).toHaveBeenCalledTimes(calls)
      expect(await fs.readFile(file, 'utf8')).toBe(encoded)
      expect(await store.read()).toEqual(previous)
      expect(await fs.readdir(directory)).toEqual(['session.enc'])
    } finally { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) }
  })
})
