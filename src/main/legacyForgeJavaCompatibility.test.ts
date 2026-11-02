import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { prepareLegacyForgeJavaCompatibility } from '../../feature-plugins/testing/src/main/legacyForgeJavaCompatibility'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-legacy-java-')); roots.push(root); return root }

it('limits the compatibility coremod to Forge 1.7.2 and verifies its bytes and license offline', async () => {
  const root = await directory()
  expect(await prepareLegacyForgeJavaCompatibility('fabric', '1.7.2', root)).toEqual({ applied: false })
  expect(await prepareLegacyForgeJavaCompatibility('forge', '1.7.10', root)).toEqual({ applied: false })
  expect(await fs.readdir(root)).toEqual([])
  const result = await prepareLegacyForgeJavaCompatibility('forge', '1.7.2', root)
  const jar = await fs.readFile(path.join(root, 'mods/modmind-java8-fix.jar'))
  expect(result).toEqual({ applied: true, sha256: createHash('sha256').update(jar).digest('hex') })
  expect(jar.length).toBe(6630)
  expect(await fs.readFile(path.join(root, 'mods/modmind-java8-fix-LICENSE.txt'), 'utf8')).toContain('Copyright (c) 2014 LexManos')
  await fs.writeFile(path.join(root, 'mods/modmind-java8-fix.jar'), 'interrupted copy')
  await prepareLegacyForgeJavaCompatibility('forge', '1.7.2', root)
  expect(await fs.readFile(path.join(root, 'mods/modmind-java8-fix.jar'))).toEqual(jar)
})

it('preserves a supplied LegacyJavaFixer and removes only its own duplicate', async () => {
  const root = await directory()
  await prepareLegacyForgeJavaCompatibility('forge', '1.7.2', root)
  await fs.writeFile(path.join(root, 'mods/legacyjavafixer-1.0.jar'), 'selected existing patch')
  expect(await prepareLegacyForgeJavaCompatibility('forge', '1.7.2', root)).toEqual({ applied: false, existing: 'legacyjavafixer-1.0.jar' })
  expect(await fs.readFile(path.join(root, 'mods/legacyjavafixer-1.0.jar'), 'utf8')).toBe('selected existing patch')
  await expect(fs.access(path.join(root, 'mods/modmind-java8-fix.jar'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a linked mods directory instead of writing outside the owned instance', async () => {
  const root = await directory(), outside = await directory(), link = path.join(root, 'mods')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(prepareLegacyForgeJavaCompatibility('forge', '1.7.2', root)).rejects.toThrow('实际 mods 目录')
    expect(await fs.readdir(outside)).toEqual([])
  } finally { await fs.unlink(link) }
})
