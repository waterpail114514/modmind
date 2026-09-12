import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installToolDirectory, withToolInstallLock } from './managedToolInstall'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function root(): Promise<string> { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-install-')); roots.push(value); return value }
it('does not publish an interrupted extraction and recovers on the next attempt', async () => {
  const directory = path.join(await root(), 'maven')
  await expect(installToolDirectory(directory, undefined, async stage => { await fs.writeFile(path.join(stage, 'partial'), 'broken'); throw new Error('interrupted') }, ['bin/mvn'])).rejects.toThrow('interrupted')
  expect(await fs.readdir(path.dirname(directory))).toEqual([])
  await installToolDirectory(directory, undefined, async stage => { const extracted = path.join(stage, 'maven'); await fs.mkdir(path.join(extracted, 'bin'), { recursive: true }); await fs.writeFile(path.join(extracted, 'bin/mvn'), 'complete'); return extracted }, ['bin/mvn'])
  expect(await fs.readFile(path.join(directory, 'bin/mvn'), 'utf8')).toBe('complete')
  expect(await fs.stat(path.join(directory, '.modmind-complete')).then(s => s.isFile())).toBe(true)
})
it('serializes competing installers and permits cancellation while waiting', async () => {
  const directory = path.join(await root(), 'jdk')
  let unlock!: () => void
  const held = new Promise<void>(r => { unlock = r })
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r })
  const first = withToolInstallLock(directory, undefined, async () => { entered(); await held })
  await ready
  const controller = new AbortController()
  const second = withToolInstallLock(directory, controller.signal, async () => { throw new Error('must not enter') })
  controller.abort()
  await expect(second).rejects.toThrow()
  unlock(); await first
  expect(await withToolInstallLock(directory, undefined, async () => 'recovered')).toBe('recovered')
})
