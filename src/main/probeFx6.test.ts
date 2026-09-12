import { afterEach, describe, expect, it } from 'vitest'
import { inspectForDecompilation } from './decompilePipeline'
import { createStoredZip } from './bedrockAddon'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const javac = String(process.env.PATH ?? '').split(path.delimiter)
  .map((directory) => path.join(directory, process.platform === 'win32' ? 'javac.exe' : 'javac'))
  .find(existsSync)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

describe('probe pipeline on real fixture', () => {
  it.skipIf(!javac)('inspects a compiled Forge jar when a JDK is available', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-pipe-'))
    roots.push(root)
    const src = path.join(root, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'MyMod.java'), 'public class MyMod { public static int compute(int v) { return v * 42; } }\n')
    execFileSync(javac!, ['-d', src, path.join(src, 'MyMod.java')], { stdio: 'pipe' })
    const files: Array<{ name: string; data: Buffer }> = [
      { name: 'META-INF/mods.toml', data: Buffer.from(['modLoader="javafml"', 'loaderVersion="[1,)"', '[[mods]]', 'modId="mymod"', 'version="1.0.0"', 'displayName="My Mod"'].join('\n') + '\n', 'utf8') }
    ]
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.class')) files.push({ name: entry.name, data: await fs.readFile(path.join(src, entry.name)) })
    }
    const jarPath = path.join(root, 'mymod.jar')
    await fs.writeFile(jarPath, createStoredZip(files))
    const inspected = await inspectForDecompilation(jarPath, { cacheRoot: root })
    expect(inspected.modId).toBe('mymod')
    expect(inspected.loader).toBe('forge')
  })
})
