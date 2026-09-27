import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyNarratorPreference, gameDirectoryForLaunch, validateJvmArguments } from './minecraftLaunchPreferences'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('isolates a game-only launch from the project mod directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-clean-game-'))
  roots.push(root)
  const game = gameDirectoryForLaunch(root, true)
  expect(game).toBe(path.join(root, 'clean-game'))
  expect(gameDirectoryForLaunch(root)).toBe(root)
  await fs.mkdir(path.join(root, 'mods'))
  await fs.writeFile(path.join(root, 'mods', 'project.jar'), 'mod')
  await fs.mkdir(game, { recursive: true })
  await expect(fs.readdir(path.join(game, 'mods'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('disables narrator onboarding without deleting other game options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-options-'))
  roots.push(root)
  const file = path.join(root, 'options.txt')
  await fs.writeFile(file, 'renderDistance:12\nnarrator:2\nonboardAccessibility:true\n')
  await applyNarratorPreference(root, true)
  expect(await fs.readFile(file, 'utf8')).toBe('renderDistance:12\nnarrator:0\nonboardAccessibility:false\n')
  await applyNarratorPreference(root, true)
  expect(await fs.readFile(file, 'utf8')).toBe('renderDistance:12\nnarrator:0\nonboardAccessibility:false\n')
  await applyNarratorPreference(root, false)
  expect(await fs.readFile(file, 'utf8')).toContain('narrator:0')
})

it('keeps custom JVM arguments bounded and memory under the dedicated setting', () => {
  expect(validateJvmArguments(['-Dexample=value', '--add-opens=java.base/java.lang=ALL-UNNAMED'])).toHaveLength(2)
  expect(() => validateJvmArguments(['-Xmx8G'])).toThrow('最大内存')
  expect(() => validateJvmArguments(['-Dkey=value\n-Dother=value'])).toThrow('每行一项')
  expect(() => validateJvmArguments(Array(21).fill('-Dvalue=1'))).toThrow('最多 20 项')
})
