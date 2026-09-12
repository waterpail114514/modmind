import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deployServerInstance } from './serverInstance'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('preserves worlds and local config while replacing/removing owned jars', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-deploy-')); roots.push(root)
  const source = path.join(root, 'build'), target = path.join(root, 'instance')
  await fs.mkdir(path.join(source, 'mods'), { recursive: true })
  await fs.writeFile(path.join(source, 'mods', 'old.jar'), 'old')
  await fs.writeFile(path.join(source, 'server.properties'), 'motd=default')
  await deployServerInstance(source, target)
  await fs.mkdir(path.join(target, 'world'))
  await fs.writeFile(path.join(target, 'world', 'level.dat'), 'world-data')
  await fs.writeFile(path.join(target, 'server.properties'), 'motd=local')
  await fs.writeFile(path.join(target, 'mods', 'manual.jar'), 'manual')
  await fs.rm(path.join(source, 'mods', 'old.jar'))
  await fs.writeFile(path.join(source, 'mods', 'new.jar'), 'new')
  await fs.writeFile(path.join(source, 'server.properties'), 'motd=changed')
  expect((await deployServerInstance(source, target)).conflicts).toContain('server.properties')
  expect(await fs.readFile(path.join(target, 'world', 'level.dat'), 'utf8')).toBe('world-data')
  expect(await fs.readFile(path.join(target, 'server.properties'), 'utf8')).toBe('motd=local')
  expect(await fs.readdir(path.join(target, 'mods'))).toEqual(['manual.jar', 'new.jar'])
})

it('does not mutate an instance after cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-deploy-cancel-')); roots.push(root)
  const source = path.join(root, 'build'), target = path.join(root, 'instance')
  await fs.mkdir(source); await fs.mkdir(target)
  await fs.writeFile(path.join(target, 'keep'), 'unchanged')
  await expect(deployServerInstance(source, target, AbortSignal.abort())).rejects.toThrow()
  expect(await fs.readdir(target)).toEqual(['keep'])
})
