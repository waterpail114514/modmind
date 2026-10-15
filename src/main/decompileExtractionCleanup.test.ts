import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectForDecompilation } from './decompilePipeline'
import { createStoredZip } from './bedrockAddon'

const control = vi.hoisted(() => ({ failedDirectory: '', fail: true }))
vi.mock('extract-zip', async original => {
  const extract = (await original<{ default: typeof import('extract-zip') }>()).default
  return { default: async (source: string, options: { dir: string }) => {
    if (control.fail && path.basename(options.dir).startsWith('modmind-decompile-scan-')) {
      control.failedDirectory = options.dir
      await fs.writeFile(path.join(options.dir, 'partially-extracted.class'), 'partial bytes')
      throw Object.assign(new Error('ENOSPC after a partial extraction'), { code: 'ENOSPC' })
    }
    return extract(source, options)
  } }
})
let root = ''
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); control.fail = true })

it('removes partially extracted content on inspection failure and allows retry', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-extraction-cleanup-'))
  const jar = path.join(root, 'fixture.jar')
  await fs.writeFile(jar, createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"schemaVersion":1,"id":"audit_fixture","version":"1"}') }, { name: 'Audit.class', data: Buffer.from('fixture class') }]))
  await expect(inspectForDecompilation(jar, { cacheRoot: path.join(root, 'cache') })).rejects.toThrow('ENOSPC')
  expect(control.failedDirectory).toContain('modmind-decompile-scan-')
  await expect(fs.access(control.failedDirectory)).rejects.toThrow()
  control.fail = false
  await expect(inspectForDecompilation(jar, { cacheRoot: path.join(root, 'cache') })).resolves.toMatchObject({ hasClasses: true, loader: 'fabric' })
})
