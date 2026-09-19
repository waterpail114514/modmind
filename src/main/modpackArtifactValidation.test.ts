import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import { validateRuntimeModArtifact } from './modpackArtifactValidation'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function jar(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-artifact-')); roots.push(root)
  const target = path.join(root, 'test.jar')
  await fs.writeFile(target, createStoredZip(Object.entries({ 'assets/padding.bin': Buffer.alloc(2048), ...files }).map(([name, data]) => ({ name, data: Buffer.from(data) }))))
  return target
}

describe('launcher-compatible modpack JAR validation', () => {
  it('accepts lowcodefml data-only mods without requiring Java classes', async () => {
    const target = await jar({ 'META-INF/mods.toml': "modLoader='lowcodefml'\n[[mods]]\nmodId='data_pack'", 'data/example/loot_tables/test.json': '{}' })
    await expect(validateRuntimeModArtifact(target, 'forge')).resolves.toEqual([])
  })
  it('accepts Forge libraries with jar-in-jar classes', async () => {
    const nested = createStoredZip([{ name: 'example/Class.class', data: Buffer.alloc(2048) }])
    const target = await jar({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nFMLModType: LIBRARY\r\n', 'META-INF/jarjar/lib.jar': nested })
    await expect(validateRuntimeModArtifact(target, 'forge')).resolves.toEqual([])
  })
  it('recognizes Forge/Fabric bootstrap wrappers', async () => {
    const target = await jar({ 'META-INF/MANIFEST.MF': 'MixinConfigs: bootstrap.json\r\n', 'META-INF/core/forge1.20.jar': Buffer.alloc(2048), 'Bootstrap.class': Buffer.alloc(2048), 'fabric.mod.json': '{}' })
    await expect(validateRuntimeModArtifact(target, 'forge', target, true)).resolves.toEqual([])
  })
  it('preserves a foreign-loader file only in imported packs, with an explicit warning', async () => {
    const target = await jar({ 'fabric.mod.json': '{}', 'example/Test.class': Buffer.alloc(2048) })
    await expect(validateRuntimeModArtifact(target, 'forge')).rejects.toThrow('forge descriptor')
    await expect(validateRuntimeModArtifact(target, 'forge', target, true)).resolves.toEqual([expect.stringContaining('仅声明 Fabric')])
  })
  it('still rejects ordinary code mods that have no code', async () => {
    const target = await jar({ 'META-INF/mods.toml': "modLoader='javafml'" })
    await expect(validateRuntimeModArtifact(target, 'forge', target, true)).rejects.toThrow('compiled class')
  })
})
