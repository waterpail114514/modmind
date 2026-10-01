import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeJavaHomeInfo } from "../../feature-plugins/testing/src/main/minecraftRuntime"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('Java runtime probing', () => {
  it('treats a zero-byte Java executable as a broken cache instead of throwing spawn UNKNOWN', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-zero-java-'))
    temporaryRoots.push(home)
    const bin = path.join(home, 'bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'), Buffer.alloc(0))

    await expect(probeJavaHomeInfo(home)).resolves.toEqual({ valid: false, major: 0 })
  })
})
