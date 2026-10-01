import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { adoptExternalModpack, createModpackTemplate } from './modpackService'
import { downloadModpackContent, importModpackContent, listModpackContent, removeModpackContent } from "../../feature-plugins/modpack-content/src/main/modpackContentInventoryService"
import { httpTransport } from './networkRequest'

function bytesResponse(bytes: Buffer): unknown {
  return {
    ok: true,
    statusCode: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: Readable.from([bytes])
  }
}

const roots: string[] = []

function project(root: string): ProjectInfo {
  return { kind: 'modpack', name: 'Content Pack', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'content_pack', createdAt: '2026-08-16T00:00:00.000Z' }
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const checksum = crc32(entry.content)
    const file = Buffer.alloc(30)
    file.writeUInt32LE(0x04034b50, 0)
    file.writeUInt16LE(20, 4)
    file.writeUInt32LE(checksum, 14)
    file.writeUInt32LE(entry.content.length, 18)
    file.writeUInt32LE(entry.content.length, 22)
    file.writeUInt16LE(name.length, 26)
    local.push(file, name, entry.content)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(entry.content.length, 20)
    directory.writeUInt32LE(entry.content.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += file.length + name.length + entry.content.length
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('modpack content inventory', () => {
  it('imports resource packs and world directories into their correct override roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-content-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const resource = path.join(root, 'visuals.zip')
    const world = path.join(root, 'StartWorld')
    await fs.writeFile(resource, Buffer.alloc(2_048, 6))
    await fs.mkdir(path.join(world, 'region'), { recursive: true })
    await fs.writeFile(path.join(world, 'level.dat'), Buffer.alloc(64, 1))
    await fs.writeFile(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(128, 2))

    await importModpackContent(info, 'resourcepacks', [resource], 'client')
    await importModpackContent(info, 'worlds', [world])
    const inventory = await listModpackContent(info)

    expect(inventory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'resourcepacks/visuals.zip', kind: 'resourcepacks', scope: 'client', delivery: 'embedded' }),
      expect.objectContaining({ path: 'saves/StartWorld', kind: 'worlds', directory: true })
    ]))
    await expect(fs.access(path.join(info.path, 'overrides', 'resourcepacks', 'visuals.zip'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(info.path, 'overrides', 'saves', 'StartWorld', 'level.dat'))).resolves.toBeUndefined()
  })

  it('lists content packs larger than the legacy 12,000-file discovery limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-large-inventory-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    const entries = Array.from({ length: 12_001 }, (_, index) => ({
      name: `entry-${String(index).padStart(5, '0')}.json`,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true
    }))
    const readdir = vi.spyOn(fs, 'readdir').mockResolvedValue(entries as never)
    const stat = vi.spyOn(fs, 'stat').mockResolvedValue({ isFile: () => true, size: 2, mtime: new Date() } as never)
    try {
      const inventory = await listModpackContent(info)
      expect(inventory.items).toHaveLength(12_001)
    } finally {
      readdir.mockRestore()
      stat.mockRestore()
    }
  })

  it('reuses an inventory scan until the caller explicitly refreshes it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-content-cache-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(path.join(info.path, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'overrides', 'config', 'cached.toml'), 'enabled=true\n', 'utf8')
    const readdir = vi.spyOn(fs, 'readdir')
    try {
      await listModpackContent(info)
      const firstScanCalls = readdir.mock.calls.length
      await listModpackContent(info)
      expect(readdir.mock.calls).toHaveLength(firstScanCalls)
      await listModpackContent(info, true)
      expect(readdir.mock.calls.length).toBeGreaterThan(firstScanCalls)
    } finally {
      readdir.mockRestore()
    }
  })

  it('downloads a remote content file into overrides and records both portable hashes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-download-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const bytes = Buffer.alloc(2_048, 4)
    vi.spyOn(httpTransport, 'request').mockImplementation(async () => bytesResponse(bytes) as never)

    const result = await downloadModpackContent(info, { kind: 'resourcepacks', scope: 'client', url: 'https://cdn.example.test/visuals.zip' })

    expect(result.item).toMatchObject({ path: 'resourcepacks/visuals.zip', delivery: 'remote', sourceUrl: 'https://cdn.example.test/visuals.zip', sha1: expect.stringMatching(/^[a-f0-9]{40}$/), sha512: expect.stringMatching(/^[a-f0-9]{128}$/) })
    await expect(fs.readFile(path.join(info.path, 'overrides', 'resourcepacks', 'visuals.zip'))).resolves.toEqual(bytes)
    await removeModpackContent(info, result.item.id)
    await expect(fs.access(path.join(info.path, 'overrides', 'resourcepacks', 'visuals.zip'))).rejects.toThrow()
  })

  it('rejects incomplete worlds and non-ZIP visual pack imports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-validation-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const incompleteWorld = path.join(root, 'IncompleteWorld')
    const textFile = path.join(root, 'not-a-pack.txt')
    await fs.mkdir(incompleteWorld)
    await fs.writeFile(textFile, 'not a ZIP archive')

    await expect(importModpackContent(info, 'worlds', [incompleteWorld])).rejects.toThrow('level.dat')
    await expect(importModpackContent(info, 'resourcepacks', [textFile], 'client')).rejects.toThrow('ZIP')
    await expect(importModpackContent(info, 'shaderpacks', [textFile], 'client')).rejects.toThrow('ZIP')
  })

  it('uses the archive name without its extension for extracted worlds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-world-download-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const archive = storedZip([{ name: 'StarterWorld/level.dat', content: Buffer.alloc(64, 1) }])
    vi.spyOn(httpTransport, 'request').mockImplementation(async () => bytesResponse(archive) as never)

    const result = await downloadModpackContent(info, { kind: 'worlds', url: 'https://cdn.example.test/StarterWorld.zip', extract: true })

    expect(result.item.path).toBe('saves/StarterWorld')
    await expect(fs.access(path.join(info.path, 'overrides', 'saves', 'StarterWorld', 'level.dat'))).resolves.toBeUndefined()
  })

  it('uses the instance root when an adopted pack owns its override layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-instance-content-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const manifestPath = path.join(info.path, 'modmind.pack.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.source = { format: 'instance', layout: 'instance', importedAt: '2026-08-16T00:00:00.000Z' }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const shader = path.join(root, 'lighting.zip')
    await fs.writeFile(shader, Buffer.alloc(2_048, 3))

    await importModpackContent(info, 'shaderpacks', [shader], 'client')

    await expect(fs.access(path.join(info.path, 'shaderpacks', 'lighting.zip'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(info.path, 'overrides', 'shaderpacks', 'lighting.zip'))).rejects.toThrow()
  })

  it("lists an adopted archive's configuration without treating override JARs as content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-archive-content-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(path.join(info.path, 'overrides', 'config'), { recursive: true })
    await fs.mkdir(path.join(info.path, 'overrides', 'mods'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'overrides', 'config', 'author.toml'), 'enabled=true\n', 'utf8')
    await fs.writeFile(path.join(info.path, 'overrides', 'mods', 'author.jar'), Buffer.alloc(2_048, 6))
    await adoptExternalModpack(info, { format: 'modrinth', layout: 'archive', importedAt: '2026-08-16T00:00:00.000Z' })

    const inventory = await listModpackContent(info)

    expect(inventory.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'config/author.toml', kind: 'config' })]))
    expect(inventory.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'mods/author.jar' })]))
  })
})
