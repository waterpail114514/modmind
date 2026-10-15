import { AsyncLocalStorage } from 'node:async_hooks'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BlockbenchBridge } from './blockbenchBridge'

let root = ''
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }) })

function bridge(project: () => string | null, serialize?: () => Promise<void>): BlockbenchBridge {
  return Object.assign(Object.create(BlockbenchBridge.prototype), {
    operationProject: new AsyncLocalStorage<string | null>(), actionQueue: Promise.resolve(),
    getProjectRoot: project, assertAlive: () => {}, status: { phase: 'ready' },
    invokePage: async (action: { type: string }) => {
      if (action.type === 'serialize-project') { await serialize?.(); return { content: '{}' } }
      if (action.type === 'serialize-texture') return { content: 'data:image/png;base64,AQIDBA==' }
      return {}
    }
  })
}

it('does not save into another project after serialization yields', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockbench-project-'))
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await fs.mkdir(a); await fs.mkdir(b)
  let current = a
  const service = bridge(() => current, async () => { current = b })
  await expect(service.executeAction({ type: 'save-project', relativePath: 'model.bbmodel' })).rejects.toThrow(/no longer active/)
  expect(await fs.readdir(a)).toEqual([]); expect(await fs.readdir(b)).toEqual([])
})

it('does not treat an unreadable backup as a missing file or overwrite it', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockbench-backup-'))
  const model = path.join(root, 'model.bbmodel'); await fs.writeFile(model, 'valuable original')
  const canonicalModel = await fs.realpath(model)
  const original = fs.readFile.bind(fs)
  const read = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === canonicalModel) throw Object.assign(new Error('EACCES backup denied'), { code: 'EACCES' })
    return original(...args)
  }) as typeof fs.readFile)
  await expect(bridge(() => root).saveAssetBundle({ projectRelativePath: 'model.bbmodel', textureRelativePath: 'texture.png', textureName: 'texture', metadata: { source: 'GENERATED' } })).rejects.toThrow(/EACCES/)
  read.mockRestore()
  expect(await fs.readFile(model, 'utf8')).toBe('valuable original')
  expect(await fs.stat(path.join(root, 'texture.png')).catch(() => null)).toBeNull()
})
