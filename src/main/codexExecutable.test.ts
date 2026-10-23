import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { probeCodexExecutable } from './codexExecutable'

it('probes an ordinary native executable without changing version parsing', async () => {
  expect(await probeCodexExecutable(process.execPath)).toBe(process.versions.node)
})

it.skipIf(process.platform !== 'win32')('executes a verified native file beyond the Windows legacy path limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-native-long-path-'))
  try {
    const directory = path.join(root, 'deep-'.repeat(30), 'nested-'.repeat(14))
    await fs.mkdir(directory, { recursive: true })
    const executable = path.join(directory, 'codex.exe')
    await fs.copyFile(process.execPath, executable)
    expect(executable.length).toBeGreaterThan(260)
    expect(await probeCodexExecutable(executable)).toBe(process.versions.node)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
