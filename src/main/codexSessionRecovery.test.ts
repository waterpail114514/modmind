import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { findCodexRollout, isMissingCodexHistory } from './codexSessionRecovery'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('recognizes both reported missing-history errors without treating rejected prompts or permissions as missing files', () => {
  expect(isMissingCodexHistory('no rollout found for thread id abc')).toBe(true)
  expect(isMissingCodexHistory('failed to resolve rollout path `C:\\old\\rollout.jsonl`: file does not exist (code -32600)')).toBe(true)
  expect(isMissingCodexHistory('Invalid Responses API request')).toBe(false)
  expect(isMissingCodexHistory('failed to resolve rollout path: permission denied')).toBe(false)
})

it('selects the newest matching history and excludes corrupt, unrelated and archived files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-rollout-search-'))
  roots.push(root)
  const project = { path: root } as ProjectInfo
  const homes = path.join(root, '.modmind', 'external-agents', 'codex-homes')
  const seed = async (home: string, content: string, time: number, archived = false) => {
    const file = path.join(homes, 'scope', home, archived ? 'archived_sessions' : 'sessions', '2026', '09', '02', 'rollout-date-target.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    await fs.utimes(file, time, time)
    return file
  }
  const valid = JSON.stringify({ type: 'session_meta', payload: { id: 'target' } }) + '\n'
  await seed('old', valid, 1)
  const newest = await seed('new', valid, 2)
  await seed('corrupt', '{broken', 3)
  await seed('wrong-id', JSON.stringify({ type: 'session_meta', payload: { id: 'another-thread' } }), 4)
  await seed('archived', valid, 5, true)
  expect(await findCodexRollout(project, 'target')).toBe(newest)
  expect(await findCodexRollout(project, 'missing')).toBeUndefined()
  expect(await findCodexRollout(project, '../target')).toBeUndefined()
})
