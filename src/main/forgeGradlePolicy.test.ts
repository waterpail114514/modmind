import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isForgeGradle6Project } from './forgeGradlePolicy'
import { gradleRepositoryArguments } from './gradleRepositoryPolicy'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

it('scopes the adapter to supported Forge 6 projects in Groovy and Kotlin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-forge-policy-')); roots.push(root)
  for (const [name, source, loader, supported] of [
    ['build.gradle', "plugins { id 'net.minecraftforge.gradle' version '6.0.54' }", 'forge', true],
    ['build.gradle.kts', 'plugins { id("net.minecraftforge.gradle") version "6.0.54" }', 'forge', true],
    ['build.gradle', "plugins { id 'net.minecraftforge.gradle' version '5.1.0' }", 'forge', false],
    ['build.gradle', "plugins { id 'net.minecraftforge.gradle' version '7.0.0' }", 'forge', false],
    ['build.gradle', "plugins { id 'net.minecraftforge.gradle' version '6.0.54' }", 'fabric', false]
  ] as const) {
    await Promise.all(['build.gradle', 'build.gradle.kts'].map(file => fs.rm(path.join(root, file), { force: true })))
    await fs.writeFile(path.join(root, name), source)
    expect(await isForgeGradle6Project({ path: root, loader })).toBe(supported)
  }
})

it('does not reuse a Forge preflight script for other loaders or an explicit official build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-forge-init-')); roots.push(root)
  const forge = gradleRepositoryArguments(root, false, true)[1]
  const standard = gradleRepositoryArguments(root)[1]
  const fallback = gradleRepositoryArguments(root, true, true)[1]
  expect(new Set([forge, standard, fallback]).size).toBe(3)
  expect(await fs.readFile(forge, 'utf8')).toContain('forgePreflightKey')
  expect(await fs.readFile(standard, 'utf8')).not.toContain('forgePreflightKey')
  expect(await fs.readFile(fallback, 'utf8')).not.toContain('configureMirrors')
  expect(gradleRepositoryArguments(root, true)).toEqual([])
})
