import { it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureManagedCodexRuntime, CODEX_RUNTIME_VERSION } from '../src/main/codexSetup'
import { probeCodexExecutable } from '../src/main/codexExecutable'
it('installs the real pinned archive and reuses its verified cache', async () => {
  const rootDir = path.resolve('test-results/codex-upgrade-install-cache')
  const stages: string[] = []
  const executable = await ensureManagedCodexRuntime({ rootDir, onProgress: item => stages.push(item.stage) })
  expect(await probeCodexExecutable(executable)).toBe(CODEX_RUNTIME_VERSION)
  const stat = await fs.stat(executable)
  expect(await ensureManagedCodexRuntime({ rootDir })).toBe(executable)
  expect((await fs.stat(executable)).mtimeMs).toBe(stat.mtimeMs)
  await fs.writeFile(path.resolve('test-results/codex-upgrade-install.json'), JSON.stringify({ version: CODEX_RUNTIME_VERSION, executable, stages, cacheReused: true }, null, 2))
}, 240_000)
