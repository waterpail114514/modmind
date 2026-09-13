import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import { inspectModJar, readModJarIdentities } from './jarInspection'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function fixture(entries: Array<{ name: string; data: string | Buffer }>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-jar-inspection-'))
  roots.push(root)
  const target = path.join(root, 'fixture.jar')
  await fs.writeFile(target, createStoredZip(entries.map((entry) => ({ name: entry.name, data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data) }))))
  return target
}

function annotatedModClass(values: { modid: string; name?: string; version?: string; dependencies?: string }): Buffer {
  const entries = [
    'example/LegacyMod',
    'java/lang/Object',
    'RuntimeVisibleAnnotations',
    'Lcpw/mods/fml/common/Mod;',
    ...Object.entries(values).flat()
  ]
  const chunks: Buffer[] = []
  const u1 = (value: number): void => { chunks.push(Buffer.from([value])) }
  const u2 = (value: number): void => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); chunks.push(bytes) }
  const u4 = (value: number): void => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); chunks.push(bytes) }
  const utf8 = (value: string): void => {
    const bytes = Buffer.from(value)
    u1(1)
    u2(bytes.length)
    chunks.push(bytes)
  }
  u4(0xcafebabe)
  u2(0)
  u2(52)
  u2(entries.length + 3)
  utf8(entries[0])
  u1(7); u2(1)
  utf8(entries[1])
  u1(7); u2(3)
  for (const entry of entries.slice(2)) utf8(entry)
  u2(0x21)
  u2(2)
  u2(4)
  u2(0)
  u2(0)
  u2(0)
  u2(1)
  u2(5)
  const pairs = Object.entries(values)
  u4(6 + pairs.length * 5)
  u2(1)
  u2(6)
  u2(pairs.length)
  for (const [name, value] of pairs) {
    u2(entries.indexOf(name) + 3)
    u1('s'.charCodeAt(0))
    u2(entries.indexOf(value) + 3)
  }
  return Buffer.concat(chunks)
}

describe('mod JAR inspection', () => {
  it.each([
    ['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'create', name: 'Create', version: '1' })],
    ['quilt.mod.json', JSON.stringify({ quilt_loader: { id: 'create', version: '1', metadata: { name: 'Create' } } })],
    ['META-INF/mods.toml', '[[mods]]\nmodId="create"\ndisplayName="Create"\nversion="1"'],
    ['META-INF/neoforge.mods.toml', '[[mods]]\nmodId="create"\ndisplayName="Create"\nversion="1"'],
    ['mcmod.info', JSON.stringify([{ modid: 'create', name: 'Create', version: '1' }])]
  ])('reads configuration identities from %s without class analysis', async (name, data) => {
    const target = await fixture([{ name, data }, { name: 'ignored/Invalid.class', data: 'not a class' }])
    expect(await readModJarIdentities(target)).toEqual([{ id: 'create', name: 'Create' }])
  })

  it('leaves missing or invalid metadata unidentified', async () => {
    const target = await fixture([{ name: 'fabric.mod.json', data: '{broken' }])
    expect(await readModJarIdentities(target)).toEqual([])
  })

  it('reads Fabric identity, dependencies and package summaries', async () => {
    const target = await fixture([
      { name: 'fabric.mod.json', data: JSON.stringify({ schemaVersion: 1, id: 'create_addition', name: 'Create Addition', version: '1.2.3', depends: { fabricloader: '>=0.16', minecraft: '1.21.1', create: '6.0.5' }, suggests: { jei: '*' } }) },
      { name: 'dev/example/create_addition/Entry.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
      { name: 'dev/example/create_addition/api/MachineApi.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
    ])
    const result = await inspectModJar(target, 'fabric')
    expect(result.profile).toMatchObject({ primaryModId: 'create_addition', displayName: 'Create Addition', version: '1.2.3', loader: 'fabric', classCount: 2 })
    expect(result.profile.packages).toContain('dev.example.create_addition')
    expect(result.minecraftVersions).toEqual(['1.21.1'])
    expect(result.dependencies).toEqual(expect.arrayContaining([{ modId: 'create', kind: 'required' }, { modId: 'jei', kind: 'optional' }]))
    expect(result.sha1).toMatch(/^[a-f0-9]{40}$/)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects archives without a supported mod descriptor', async () => {
    const target = await fixture([{ name: 'example/Only.class', data: Buffer.from([1, 2, 3]) }])
    await expect(inspectModJar(target, 'fabric')).rejects.toThrow(/描述文件/)
  })

  it('reads Forge TOML tables with trailing comments and quoted display names', async () => {
    const target = await fixture([
      {
        name: 'META-INF/mods.toml',
        data: `modLoader = "javafml"
[[mods]] #mandatory
modId = "irons_spellbooks" #mandatory
version = "1.20.1-3.16.3"
displayName = "Iron's Spells 'n Spellbooks" #mandatory
[[dependencies.irons_spellbooks]] #optional
modId = "forge"
mandatory = true
[[dependencies.irons_spellbooks]]
modId = "geckolib"
mandatory = true
[[dependencies.irons_spellbooks]]
modId = "jei"
mandatory = false
`
      },
      { name: 'io/redspace/ironsspellbooks/Entry.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
    ])
    const result = await inspectModJar(target, 'forge')
    expect(result.profile).toMatchObject({
      primaryModId: 'irons_spellbooks',
      displayName: "Iron's Spells 'n Spellbooks",
      version: '1.20.1-3.16.3',
      loader: 'forge'
    })
    expect(result.dependencies).toEqual(expect.arrayContaining([
      { modId: 'geckolib', kind: 'required' },
      { modId: 'jei', kind: 'optional' }
    ]))
  })

  it('reads the Minecraft version range from Forge dependencies', async () => {
    const target = await fixture([
      {
        name: 'META-INF/mods.toml',
        data: `modLoader="javafml"
[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"
[[dependencies.examplemod]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1]"
`
      },
      { name: 'dev/example/Entry.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
    ])
    await expect(inspectModJar(target, 'forge')).resolves.toMatchObject({ minecraftVersions: ['1.20.1'] })
  })

  it('falls back to legacy Forge @Mod annotations when mcmod.info leaves identity blank', async () => {
    const target = await fixture([
      { name: 'mcmod.info', data: JSON.stringify([{ modid: '', name: '', version: 'V33a' }]) },
      {
        name: 'example/LegacyMod.class',
        data: annotatedModClass({
          modid: 'ChromatiCraft',
          name: 'ChromatiCraft',
          version: 'v33a',
          dependencies: 'required-after:DragonAPI;after:Thaumcraft;required-before:BuildCraft|Core'
        })
      }
    ])
    const result = await inspectModJar(target, 'forge')
    expect(result.profile).toMatchObject({
      primaryModId: 'ChromatiCraft',
      modIds: ['ChromatiCraft'],
      displayName: 'ChromatiCraft',
      version: 'v33a',
      loader: 'forge'
    })
    expect(result.dependencies).toEqual(expect.arrayContaining([
      { modId: 'DragonAPI', kind: 'required' },
      { modId: 'Thaumcraft', kind: 'optional' },
      { modId: 'BuildCraft|Core', kind: 'required' }
    ]))
    expect(result.warnings).toContain('mcmod.info 未声明模组 ID，已通过 Forge @Mod 注解识别')
  })

  it('accepts legacy metadata wrappers and mixed-case multi-mod IDs', async () => {
    const target = await fixture([
      {
        name: 'mcmod.info',
        data: JSON.stringify({ modList: [
          { modid: 'OpenMods|Core', name: 'OpenModsLib Core', version: '@VERSION@', requiredMods: ['Forge@[10.13.4,)', 'FML@[7.10,)'] },
          { modid: 'OpenMods', name: 'OpenModsLib', version: '0.10', dependencies: ['NotEnoughItems', 'mcp'] }
        ] })
      },
      { name: 'example/Legacy.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
    ])
    const result = await inspectModJar(target, 'forge')
    expect(result.profile).toMatchObject({ primaryModId: 'OpenMods|Core', modIds: ['OpenMods|Core', 'OpenMods'], version: 'unknown' })
    expect(result.dependencies).toContainEqual({ modId: 'NotEnoughItems', kind: 'optional' })
    expect(result.dependencies.some((entry) => ['forge', 'fml', 'mcp'].includes(entry.modId?.toLowerCase() ?? ''))).toBe(false)
  })

  it('uses @Mod annotations when an old Forge jar has no mcmod.info', async () => {
    const target = await fixture([
      { name: 'example/LegacyMod.class', data: annotatedModClass({ modid: 'AnnotationOnly', version: '1.0' }) }
    ])
    await expect(inspectModJar(target, 'forge')).resolves.toMatchObject({
      profile: { primaryModId: 'AnnotationOnly', loader: 'forge' }
    })
    await expect(inspectModJar(target, 'fabric')).resolves.toMatchObject({
      profile: { primaryModId: 'AnnotationOnly', loader: 'forge' },
      warnings: ['JAR 使用 forge，当前项目使用 fabric']
    })
  })

  it('keeps modern loader mod IDs strict', async () => {
    const target = await fixture([
      { name: 'fabric.mod.json', data: JSON.stringify({ id: 'MixedCaseId', version: '1.0' }) }
    ])
    await expect(inspectModJar(target, 'fabric')).rejects.toThrow(/fabric\.mod\.json 缺少有效的模组 ID/)
  })
})
