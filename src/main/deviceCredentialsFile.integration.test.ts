import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryTransientFileLock } from './fileLockRetry'

const source = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const writer = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'writeDeviceFileAtomically')
if (!writer) throw new Error('Missing credential writer')
const code = ts.transpileModule(writer.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const reader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readDeviceCredentials')
if (!reader) throw new Error('Missing credential reader')
const readCode = ts.transpileModule(reader.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

afterEach(() => vi.restoreAllMocks())

describe('production credential file replacement', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('reads the valid account after a temporary %s read lock', async errorCode => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'device-credentials-')), file = path.join(directory, 'device-credentials.json')
    try {
      await fs.writeFile(file, JSON.stringify({ version: 1, username: 'test-user', balanceCents: '0', encryptedApiKey: Buffer.from('test-key').toString('base64'), siteUrl: 'https://site.example', baseUrl: 'https://relay.example/v1' }))
      const read = fs.readFile
      const readSpy = vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => { throw Object.assign(new Error('temporarily locked'), { code: errorCode }) }).mockImplementation(read)
      const sandbox = { fs, Buffer, safeStorage: { isEncryptionAvailable: () => true, decryptString: (bytes: Buffer) => bytes.toString() }, deviceCredentialsFile: () => file, normalizeSiteUrl: (value: string) => value, normalizeRelayBaseUrl: (value: string) => value, retryTransientFileLock: (operation: () => Promise<unknown>) => retryTransientFileLock(operation, [0, 0]), readDeviceCredentials: undefined as unknown as () => Promise<unknown> }
      vm.runInNewContext(readCode, sandbox)
      await expect(sandbox.readDeviceCredentials()).resolves.toMatchObject({ username: 'test-user', apiKey: 'test-key' })
      expect(readSpy).toHaveBeenCalledTimes(2)
    } finally { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('keeps the previous readable file during a temporary %s lock', async errorCode => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'device-credentials-'))
    const file = path.join(directory, 'device-credentials.json')
    const previous = { encryptedApiKey: 'previous-ciphertext' }, next = { encryptedApiKey: 'next-ciphertext' }
    const rename = fs.rename
    try {
      await fs.writeFile(file, JSON.stringify(previous))
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(previous)
        throw Object.assign(new Error('temporarily locked'), { code: errorCode })
      }).mockImplementation(async (from, to) => {
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(previous)
        return rename(from, to)
      })
      const sandbox = { fs, path, randomUUID, deviceCredentialsFile: () => file, retryTransientFileLock: (operation: () => Promise<unknown>) => retryTransientFileLock(operation, [0, 0]), writeDeviceFileAtomically: undefined as unknown as (value: unknown) => Promise<void> }
      vm.runInNewContext(code, sandbox)
      await sandbox.writeDeviceFileAtomically(next)
      expect(renameSpy).toHaveBeenCalledTimes(2)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(next)
      expect(await fs.readdir(directory)).toEqual(['device-credentials.json'])
    } finally { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each([{ errorCode: 'EPERM', attempts: 3 }, { errorCode: 'EIO', attempts: 1 }])('preserves the original ciphertext after persistent $errorCode and cleans temporary files', async ({ errorCode, attempts }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'device-credentials-'))
    const file = path.join(directory, 'device-credentials.json'), original = '{"encryptedApiKey":"unchanged-ciphertext"}'
    try {
      await fs.writeFile(file, original)
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('locked'), { code: errorCode }))
      const sandbox = { fs, path, randomUUID, deviceCredentialsFile: () => file, retryTransientFileLock: (operation: () => Promise<unknown>) => retryTransientFileLock(operation, [0, 0]), writeDeviceFileAtomically: undefined as unknown as (value: unknown) => Promise<void> }
      vm.runInNewContext(code, sandbox)
      await expect(sandbox.writeDeviceFileAtomically({ encryptedApiKey: 'new-ciphertext' })).rejects.toMatchObject({ code: errorCode })
      expect(renameSpy).toHaveBeenCalledTimes(attempts)
      expect(await fs.readFile(file, 'utf8')).toBe(original)
      expect(await fs.readdir(directory)).toEqual(['device-credentials.json'])
    } finally { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) }
  })
})
