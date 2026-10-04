import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import { hasConnectorBridge, validateRuntimeModArtifact } from './modpackArtifactValidation'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function jar(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-artifact-')); roots.push(root)
  const target = path.join(root, 'test.jar')
  await fs.writeFile(target, createStoredZip(Object.entries({ 'assets/padding.bin': Buffer.alloc(2048), ...files }).map(([name, data]) => ({ name, data: Buffer.from(data) }))))
  return target
}

describe('launcher-compatible modpack JAR validation', () => {
  const forgeLocator = 'META-INF/services/net.minecraftforge.forgespi.locating.IModLocator'
  it.each([
    'net.minecraftforge.forgespi.locating.IModLocator',
    'net.minecraftforge.forgespi.locating.IDependencyLocator',
    'cpw.mods.modlauncher.api.ITransformationService'
  ])('accepts Forge service entrypoints without a top-level mod descriptor: %s', async service => {
    const target = await jar({ [`META-INF/services/${service}`]: '# provider\nexample.Bootstrap # comment\n', 'example/Bootstrap.class': Buffer.alloc(2048) })
    await expect(validateRuntimeModArtifact(target, 'forge')).resolves.toEqual([])
    await expect(validateRuntimeModArtifact(target, 'forge', target, true)).resolves.toEqual([])
    await expect(validateRuntimeModArtifact(target, 'neoforge')).rejects.toThrow('neoforge descriptor')
  })
  it.each(['', '# no provider', 'missing.Class', '../Locator', 'example.Bootstrap\nmissing.Class'])('rejects invalid Forge service providers: %j', async service => {
    const target = await jar({ [forgeLocator]: service, 'example/Bootstrap.class': Buffer.alloc(2048) })
    await expect(validateRuntimeModArtifact(target, 'forge', target, true)).rejects.toThrow('forge descriptor')
  })
  it('detects Forge Connector embedded metadata and permits its Fabric companions', async () => {
    const nested = createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="connectormod"') }])
    const bridge = await jar({ [forgeLocator]: 'org.sinytra.connector.locator.EarlyLocator', 'org/sinytra/connector/locator/EarlyLocator.class': Buffer.alloc(2048), 'META-INF/jarjar/connector-mod.jar': nested })
    const companion = await jar({ 'fabric.mod.json': '{}', 'example/Fabric.class': Buffer.alloc(2048) })
    expect(await hasConnectorBridge([companion, bridge], 'forge')).toBe(true)
    expect(await hasConnectorBridge([bridge], 'neoforge')).toBe(false)
    expect(await hasConnectorBridge([companion], 'forge')).toBe(false)
    await expect(validateRuntimeModArtifact(companion, 'forge', companion, true, true)).resolves.toEqual([])
    await expect(validateRuntimeModArtifact(companion, 'forge', companion, true, false)).resolves.toEqual([expect.stringContaining('尚未检测到 Connector')])
    await expect(validateRuntimeModArtifact(companion, 'forge', companion, false, true)).rejects.toThrow('forge descriptor')
  })
  it('does not detect Connector from a service with missing provider classes', async () => {
    const bridge = await jar({ [forgeLocator]: 'org.sinytra.connector.locator.Missing', 'META-INF/jarjar/connector-mod.jar': createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('[[mods]]\nmodId="connectormod"') }]) })
    expect(await hasConnectorBridge([bridge], 'forge')).toBe(false)
  })
  it('preserves NeoForge files without claiming the original Forge loading chain cannot load them', async () => {
    const target = await jar({ 'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="modefite"\n[[dependencies.modefite]]\nmodId="minecraft"\nversionRange="[1.21.1,)"', 'example/Mod.class': Buffer.alloc(2048) })
    const warnings = await validateRuntimeModArtifact(target, 'forge', target, true, true)
    expect(warnings).toEqual([expect.stringMatching(/NeoForge.*1\.21\.1.*尚未验证/)])
    expect(warnings.join('')).not.toMatch(/不匹配|不兼容|不能转换/)
    await expect(validateRuntimeModArtifact(target, 'forge')).rejects.toThrow('forge descriptor')
    const malformed = await jar({ 'META-INF/neoforge.mods.toml': 'not valid TOML', 'example/Mod.class': Buffer.alloc(2048) })
    await expect(validateRuntimeModArtifact(malformed, 'forge', malformed, true)).rejects.toThrow('Invalid Mod JAR')
  })
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
  const locatorService = 'META-INF/services/net.neoforged.neoforgespi.locating.IModFileCandidateLocator'
  const locatorClass = 'org/sinytra/connector/locator/ConnectorEarlyLocatorBootstrap.class'
  const nestedMod = 'META-INF/jarjar/org.sinytra.connector-mod.jar'
  const connectorDescriptor = 'modLoader="javafml"\n[[mods]]\nmodId="connector"'
  function embeddedMod(descriptor = connectorDescriptor, compiled = true): Buffer {
    return createStoredZip([
      { name: 'META-INF/neoforge.mods.toml', data: Buffer.from(descriptor) },
      ...(compiled ? [{ name: 'org/sinytra/connector/Connector.class', data: Buffer.alloc(2048) }] : [])
    ])
  }
  async function connector(overrides: Record<string, string | Buffer> = {}): Promise<string> {
    return jar({
      [locatorService]: '# NeoForge locator\r\norg.sinytra.connector.locator.ConnectorEarlyLocatorBootstrap # provider\r\n',
      [locatorClass]: Buffer.alloc(2048),
      [nestedMod]: embeddedMod(),
      ...overrides
    })
  }
  it('accepts Connector-style NeoForge locator wrappers in both launch and import validation', async () => {
    const target = await connector()
    await expect(validateRuntimeModArtifact(target, 'neoforge')).resolves.toEqual([])
    await expect(validateRuntimeModArtifact(target, 'neoforge', target, true)).resolves.toEqual([])
    await expect(validateRuntimeModArtifact(target, 'forge')).rejects.toThrow('forge descriptor')
    await expect(validateRuntimeModArtifact(target, 'fabric')).rejects.toThrow('fabric descriptor')
  })
  it.each(['', '# no provider\n', 'missing.Locator', 'org.sinytra.connector.locator.ConnectorEarlyLocatorBootstrap\nmissing.Locator', '../Locator'])
    ('rejects a bootstrap with an invalid locator service: %j', async service => {
      const target = await connector({ [locatorService]: service })
      await expect(validateRuntimeModArtifact(target, 'neoforge')).rejects.toThrow('neoforge descriptor')
    })
  it('does not accept a nested descriptor without a locator service', async () => {
    const target = await jar({ [locatorClass]: Buffer.alloc(2048), [nestedMod]: embeddedMod() })
    await expect(validateRuntimeModArtifact(target, 'neoforge')).rejects.toThrow('neoforge descriptor')
  })
  it.each([
    Buffer.alloc(2048),
    createStoredZip([{ name: 'example/Class.class', data: Buffer.alloc(2048) }]),
    embeddedMod('not valid TOML'),
    embeddedMod('modLoader="javafml"'),
    embeddedMod('modLoader="javafml"\n[[mods]]\nmodId="../invalid"'),
    embeddedMod(connectorDescriptor, false)
  ])('rejects a bootstrap with a missing, malformed or code-free embedded mod (%#)', async nested => {
    const target = await connector({ [nestedMod]: nested })
    await expect(validateRuntimeModArtifact(target, 'neoforge')).rejects.toThrow('neoforge descriptor')
  })
  it('checks other embedded JARs when an earlier one is not a valid mod', async () => {
    const target = await connector({ [nestedMod]: Buffer.alloc(2048), 'META-INF/jarjar/valid-mod.jar': embeddedMod() })
    await expect(validateRuntimeModArtifact(target, 'neoforge')).resolves.toEqual([])
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
