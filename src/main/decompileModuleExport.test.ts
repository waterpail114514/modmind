import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createModuleFromDecompiledSources,
  DECOMPILE_ACKNOWLEDGEMENT_FILE,
  DECOMPILE_PROVENANCE_COPY,
  DECOMPILE_TERMS_FILE,
  DECOMPILE_TERMS_VERSION,
  plannedModulePaths,
  renderDecompileTerms,
  seedProjectFromDecompiledSources
} from "../../feature-plugins/decompile/src/main/decompileModuleExport"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function scratch(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-export-test-'))
  roots.push(root)
  return root
}

function provenance(): Parameters<typeof createModuleFromDecompiledSources>[0]['provenance'] {
  return {
    schemaVersion: 1 as const,
    sourceSha256: 'a'.repeat(64),
    sourceFileName: 'coolmod.jar',
    sourceSize: 1234,
    createdAt: '2026-08-26T00:00:00.000Z',
    engine: 'vineflower' as const,
    engineVersion: '1.11.1',
    engineArgs: [],
    obfuscationHint: 'clear' as const,
    readOnly: true as const
  }
}

async function seedSources(root: string): Promise<string> {
  const sources = path.join(root, 'sources')
  await fs.mkdir(path.join(sources, 'com/example'), { recursive: true })
  await fs.writeFile(path.join(sources, 'com/example/CoolMod.java'), 'public class CoolMod {}\n', 'utf8')
  await fs.writeFile(path.join(sources, 'overview.md'), '# notes\n', 'utf8')
  return sources
}

describe('decompile module export', () => {
  it('renders terms that disclaim compile-ability and ownership explicitly', () => {
    const terms = renderDecompileTerms('coolmod.jar')
    expect(terms).toContain('免责声明')
    expect(terms).toContain('不承担任何责任')
    expect(terms).toContain('演绎件')
    expect(terms).toContain(DECOMPILE_TERMS_VERSION)
    expect(terms).toContain('不含原作者的注释') // comments/locals are unrecoverable
  })

  it('normalizes module names and computes stable paths', () => {
    expect(plannedModulePaths('/pack', 'Cool Mod!').namespace).toBe('cool_mod')
    expect(() => plannedModulePaths('/pack', '')).toThrow(/不能为空/)
    expect(() => plannedModulePaths('/pack', '9bad')).toThrow(/命名空间/)
  })

  it('creates a module seeded with sources, terms, provenance and acknowledgement', async () => {
    const root = await scratch()
    const sources = await seedSources(root)
    const result = await createModuleFromDecompiledSources({
      packPath: root,
      jarName: 'coolmod.jar',
      moduleName: 'Cool Mod',
      provenance: provenance(),
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: '2026-08-26T12:00:00.000Z', sourceJarSha256: 'a'.repeat(64), sourceFileName: 'coolmod.jar', origin: 'user-workspace' }
    })
    expect(result.namespace).toBe('cool_mod')
    expect(result.fileCount).toBe(2)
    const moduleRoot = path.join(root, 'modules', 'cool_mod')
    await expect(fs.readFile(path.join(moduleRoot, 'com/example/CoolMod.java'), 'utf8')).resolves.toContain('CoolMod')
    await expect(fs.readFile(path.join(moduleRoot, ...DECOMPILE_TERMS_FILE.split('/')), 'utf8')).resolves.toContain('不承担任何责任')
    const ack = JSON.parse(await fs.readFile(path.join(moduleRoot, ...DECOMPILE_ACKNOWLEDGEMENT_FILE.split('/')), 'utf8')) as { termsVersion?: string; origin?: string }
    expect(ack.termsVersion).toBe(DECOMPILE_TERMS_VERSION)
    expect(ack.origin).toBe('user-workspace')
    const provCopy = JSON.parse(await fs.readFile(path.join(moduleRoot, ...DECOMPILE_PROVENANCE_COPY.split('/')), 'utf8')) as { exportedToModule?: string; readOnly?: boolean }
    expect(provCopy.exportedToModule).toBe('modules/cool_mod')
    expect(provCopy.readOnly).toBe(true)
  })

  it('records AI-originated exports distinctly from user clicks', async () => {
    const root = await scratch()
    const sources = await seedSources(root)
    const result = await createModuleFromDecompiledSources({
      packPath: root,
      jarName: 'x.jar',
      moduleName: 'ai mod',
      provenance: provenance(),
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: new Date().toISOString(), sourceJarSha256: 'b'.repeat(64), sourceFileName: 'x.jar', origin: 'ai-action' }
    })
    const ack = JSON.parse(await fs.readFile(path.join(result.acknowledgementPath), 'utf8')) as { origin?: string }
    expect(ack.origin).toBe('ai-action')
  })

  it('seeds a standalone project with Java sources and audit records', async () => {
    const root = await scratch()
    const sources = await seedSources(root)
    const projectPath = path.join(root, 'project')
    await fs.mkdir(projectPath)
    await fs.writeFile(path.join(projectPath, 'README.md'), '# Existing project\n', 'utf8')
    const result = await seedProjectFromDecompiledSources({
      projectPath,
      jarName: 'coolmod.jar',
      provenance: provenance(),
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: '2026-08-26T12:00:00.000Z', sourceJarSha256: 'a'.repeat(64), sourceFileName: 'coolmod.jar', origin: 'user-workspace' }
    })
    expect(result.fileCount).toBe(1)
    await expect(fs.readFile(path.join(projectPath, 'src/main/java/com/example/CoolMod.java'), 'utf8')).resolves.toContain('CoolMod')
    await expect(fs.stat(path.join(projectPath, 'src/main/java/overview.md'))).rejects.toThrow()
    await expect(fs.readFile(path.join(projectPath, ...DECOMPILE_TERMS_FILE.split('/')), 'utf8')).resolves.toContain(DECOMPILE_TERMS_VERSION)
    const ack = JSON.parse(await fs.readFile(path.join(projectPath, ...DECOMPILE_ACKNOWLEDGEMENT_FILE.split('/')), 'utf8')) as { termsVersion?: string }
    expect(ack.termsVersion).toBe(DECOMPILE_TERMS_VERSION)
    const source = JSON.parse(await fs.readFile(path.join(projectPath, ...DECOMPILE_PROVENANCE_COPY.split('/')), 'utf8')) as { exportedToProject?: boolean }
    expect(source.exportedToProject).toBe(true)
  })

  it('refuses to create a project from an empty decompile cache', async () => {
    const root = await scratch()
    const sources = path.join(root, 'sources')
    const projectPath = path.join(root, 'project')
    await fs.mkdir(sources)
    await fs.mkdir(projectPath)
    await expect(seedProjectFromDecompiledSources({
      projectPath,
      jarName: 'empty.jar',
      provenance: provenance(),
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: new Date().toISOString(), sourceJarSha256: 'a'.repeat(64), sourceFileName: 'empty.jar', origin: 'user-workspace' }
    })).rejects.toThrow(/结果为空/)
  })

  it('refuses invalid provenance and existing modules, cleaning up partial output', async () => {
    const root = await scratch()
    const sources = await seedSources(root)
    const badProvenance = { ...provenance(), readOnly: false } as unknown as Parameters<typeof createModuleFromDecompiledSources>[0]['provenance']
    await expect(createModuleFromDecompiledSources({
      packPath: root, jarName: 'x.jar', moduleName: 'ok',
      provenance: badProvenance,
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: new Date().toISOString(), sourceJarSha256: 'c'.repeat(64), sourceFileName: 'x.jar', origin: 'user-workspace' }
    })).rejects.toThrow(/缓存记录无效/)
    // Pre-create the target so creation must fail after seeding begins.
    await fs.mkdir(path.join(root, 'modules', 'dupe'), { recursive: true })
    await expect(createModuleFromDecompiledSources({
      packPath: root, jarName: 'x.jar', moduleName: 'dupe',
      provenance: provenance(),
      sourcesDirectory: sources,
      acknowledgement: { acceptedAt: new Date().toISOString(), sourceJarSha256: 'd'.repeat(64), sourceFileName: 'x.jar', origin: 'user-workspace' }
    })).rejects.toThrow(/同名自制模组已存在/)
    await expect(createModuleFromDecompiledSources({
      packPath: root, jarName: 'x.jar', moduleName: 'ghost',
      provenance: provenance(),
      sourcesDirectory: path.join(root, 'missing'),
      acknowledgement: { acceptedAt: new Date().toISOString(), sourceJarSha256: 'e'.repeat(64), sourceFileName: 'x.jar', origin: 'user-workspace' }
    })).rejects.toThrow(/缓存不存在/)
  })
})
