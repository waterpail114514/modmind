import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveSignature, archiveSignatureForFile, extractTar } from './tarArchive'

function tarEntry(name: string, content: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write((content.length).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

describe('tar archive import', () => {
  it('checks expansion budgets immediately after the header, before receiving a large entry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-tar-budget-'))
    try {
      const header = tarEntry('huge.bin', Buffer.alloc(0))
      header.write((1024 * 1024 * 1024).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
      const archive = path.join(root, 'huge.tar')
      await fs.writeFile(archive, header)
      await expect(extractTar(archive, path.join(root, 'out'), entry => {
        expect(entry.uncompressedSize).toBe(1024 * 1024 * 1024)
        throw new Error('Expansion budget exceeded')
      })).rejects.toThrow('Expansion budget exceeded')
      expect(await fs.stat(path.join(root, 'out')).catch(() => null)).toBeNull()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('streams files and removes an incomplete output on truncation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-tar-stream-'))
    try {
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 33, 73)
      const archive = path.join(root, 'large.tar')
      const out = path.join(root, 'out')
      await fs.writeFile(archive, Buffer.concat([tarEntry('large.bin', bytes), Buffer.alloc(1024)]))
      await extractTar(archive, out)
      expect((await fs.readFile(path.join(out, 'large.bin'))).equals(bytes)).toBe(true)
      await fs.writeFile(archive, tarEntry('partial.bin', bytes).subarray(0, 100000))
      await expect(extractTar(archive, out)).rejects.toThrow(/ended/)
      expect(await fs.stat(path.join(out, 'partial.bin')).catch(() => null)).toBeNull()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('recognizes and extracts a tar stream even when the caller supplied a zip extension', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-tar-test-'))
    const archive = path.join(root, 'project.zip')
    const destination = path.join(root, 'out')
    await fs.writeFile(archive, Buffer.concat([
      tarEntry('gradle.properties', Buffer.from('minecraft_version=1.20.1\nforge_version=47.4.10\n')),
      tarEntry('src/main/java/Example.java', Buffer.from('class Example {}')),
      Buffer.alloc(1024)
    ]))
    expect(archiveSignature(await fs.readFile(archive))).toBe('tar')
    await extractTar(archive, destination)
    await expect(fs.readFile(path.join(destination, 'gradle.properties'), 'utf8')).resolves.toContain('forge_version=47.4.10')
    await expect(fs.readFile(path.join(destination, 'src/main/java/Example.java'), 'utf8')).resolves.toContain('class Example')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects traversal entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-tar-test-'))
    const archive = path.join(root, 'bad.tar')
    await fs.writeFile(archive, Buffer.concat([tarEntry('../escape.txt', Buffer.from('bad')), Buffer.alloc(1024)]))
    await expect(extractTar(archive, path.join(root, 'out'))).rejects.toThrow(/unsafe/)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('recognizes the AutoForge sample mislabeled as .zip when the diagnostic fixture is present', async () => {
    const sample = path.resolve('log/wangs_spells-source.zip')
    if (!(await fs.stat(sample).then(() => true).catch(() => false))) return
    expect(await archiveSignatureForFile(sample)).toBe('tar')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-autoforge-'))
    await extractTar(sample, root)
    await expect(fs.readFile(path.join(root, 'gradle.properties'), 'utf8')).resolves.toContain('minecraft_version=1.20.1')
    await expect(fs.readFile(path.join(root, 'build.gradle'), 'utf8')).resolves.toContain('legacyforge')
    await fs.rm(root, { recursive: true, force: true })
  })
})
