import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import {
  ensureYarnMappings,
  pickYarnBuild,
  remapJarWithTinyRemapper,
  tinyRemapperBundledJarCandidates,
  tinyRemapperCommand,
  yarnMappingsCachePath,
  yarnV2MappingsUrl,
  validateYarnMappings,
  type YarnVersionEntry
} from './jarRemapService'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function scratch(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-remap-test-'))
  roots.push(root)
  return root
}

const YARN_ENTRIES: YarnVersionEntry[] = [
  { gameVersion: '1.21.1', separator: '+build', build: 3, version: '1.21.1+build.3', stable: true },
  { gameVersion: '1.21.1', separator: '+build', build: 1, version: '1.21.1+build.1', stable: false },
  { gameVersion: '1.20.4', separator: '+build', build: 2, version: '1.20.4+build.2', stable: true }
]

const SAMPLE_TINY = [
  'tiny\t2\t0\tintermediary\tnamed',
  'c\tclass_1234\tcom/example/Widget',
  '\tm\t(Ljava/lang/String;)Ljava/lang/String;\tmethod_5678\tgreet',
  'c\tclass_5678\tcom/example/Helper',
  ''
].join('\n')

function findJava(): string | null {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const candidate of [process.env.JAVA_HOME, ...String(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!candidate) continue
    const executable = path.join(candidate.replace(/[\\/]bin$/i, ''), 'bin', `java${suffix}`)
    if (existsSync(executable)) return executable
    if (existsSync(path.join(candidate, `java${suffix}`))) return path.join(candidate, `java${suffix}`)
  }
  return null
}

function compileClass(directory: string): void {
  const javaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : ''
  const javac = javaHome && existsSync(path.join(javaHome, 'javac.exe')) ? path.join(javaHome, 'javac.exe')
    : javaHome && existsSync(path.join(javaHome, 'javac')) ? path.join(javaHome, 'javac')
    : 'javac'
  execFileSync(javac, ['-d', directory, path.join(directory, 'Main.java')], { stdio: 'pipe' })
}

/** Builds a jar whose class references intermediary-named classes so remapping has something to do. */
async function fixtureIntermediaryJar(): Promise<string> {
  const root = await scratch()
  const sourceDir = path.join(root, 'src')
  await fs.mkdir(sourceDir, { recursive: true })
  // The compiled constant pool will carry class_1234 / method_5678 references.
  await fs.writeFile(path.join(sourceDir, 'Main.java'), [
    'public class Main {',
    '  public static String use() {',
    '    return class_1234.method_5678("x");',
    '  }',
    '}'
  ].join('\n'), 'utf8')
  const classes = path.join(root, 'classes')
  await fs.mkdir(classes, { recursive: true })
  try {
    compileClass(classes)
  } catch {
    return ''
  }
  // Recompile against a stub named class_1234 so javac accepts the reference.
  await fs.writeFile(path.join(sourceDir, 'class_1234.java'), [
    'public class class_1234 {',
    '  public static String method_5678(String value) { return value; }',
    '  }',
    ''
  ].join('\n'), 'utf8')
  try {
    compileClass(classes)
  } catch {
    return ''
  }
  const files: Array<{ name: string; data: Buffer }> = []
  for (const entry of await fs.readdir(classes, { withFileTypes: true })) {
    if (entry.isFile()) files.push({ name: entry.name, data: await fs.readFile(path.join(classes, entry.name)) })
  }
  const jarPath = path.join(root, 'intermediary.jar')
  await fs.writeFile(jarPath, createStoredZip(files))
  return jarPath
}

describe('jar remap service', () => {
  it('rebuilds nonempty broken mappings and coalesces concurrent requests', async () => {
    const root = await scratch()
    const target = yarnMappingsCachePath(root, '1.21.1')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'corrupt')
    const payload = createStoredZip([{ name: 'mappings/mappings.tiny', data: Buffer.from(SAMPLE_TINY) }])
    const download = vi.fn(async (request) => {
      await fs.writeFile(request.destination, payload)
      return { source: request.sources[0], destination: request.destination, bytes: payload.length, attempts: 1, failures: [] }
    })
    await Promise.all(Array.from({ length: 3 }, () => ensureYarnMappings(root, '1.21.1', { download, listVersions: async () => YARN_ENTRIES })))
    expect(download).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(target, 'utf8')).toBe(SAMPLE_TINY)
    expect(await fs.readdir(path.dirname(target))).toEqual(['1.21.1.tiny'])
  })

  it('rejects empty, wrong-format and truncated mapping records', () => {
    for (const content of ['', 'error\n', 'tiny\t2\t0\tintermediary\tnamed\n', 'tiny\t2\t0\tintermediary\tnamed\nc\tExample\tNamed\n\tm\t()V\n', SAMPLE_TINY.trimEnd()]) {
      expect(() => validateYarnMappings(content)).toThrow('Yarn 映射格式无效')
    }
    expect(() => validateYarnMappings(SAMPLE_TINY)).not.toThrow()
  })

  it('never publishes an invalid mapping from a successful archive download', async () => {
    const root = await scratch()
    const payload = createStoredZip([{ name: 'mappings/mappings.tiny', data: Buffer.from('broken') }])
    await expect(ensureYarnMappings(root, '1.21.1', {
      download: async request => {
        await fs.writeFile(request.destination, payload)
        return { source: request.sources[0], destination: request.destination, bytes: payload.length, attempts: 1, failures: [] }
      }, listVersions: async () => YARN_ENTRIES
    })).rejects.toThrow('Yarn 映射格式无效')
    expect(await fs.readdir(path.join(root, 'yarn'))).toEqual([])
  })
  it('resolves bundled candidates across dev and packaged layouts', () => {
    const candidates = tinyRemapperBundledJarCandidates('/app', '/resources')
    expect(candidates).toEqual([
      path.join('/resources', 'decompile-tools', 'tiny-remapper-0.14.0.jar'),
      path.join('/app', 'resources', 'decompile-tools', 'tiny-remapper-0.14.0.jar')
    ])
  })

  it('pins the tiny-remapper command shape confirmed from the binary usage output', () => {
    const command = tinyRemapperCommand('java', ['/cp/tiny.jar'], { inputJar: '/in/mod.jar', outputJar: '/out/mod-remapped.jar', mappingsPath: '/maps/yarn.tiny' })
    expect(command).toEqual(['java', '-cp', '/cp/tiny.jar', 'net.fabricmc.tinyremapper.Main', path.resolve('/in/mod.jar'), path.resolve('/out/mod-remapped.jar'), path.resolve('/maps/yarn.tiny'), 'intermediary', 'named'])
  })

  it('picks the newest yarn build for a Minecraft version and builds the v2 URL', () => {
    expect(pickYarnBuild(YARN_ENTRIES, '1.21.1')?.version).toBe('1.21.1+build.3')
    expect(pickYarnBuild(YARN_ENTRIES, '9.9.9')).toBeNull()
    expect(yarnV2MappingsUrl({ gameVersion: '1.21.1', build: 3 })).toBe('https://maven.fabricmc.net/net/fabricmc/yarn/1.21.1+build.3/yarn-1.21.1+build.3-v2.jar')
    expect(yarnMappingsCachePath('/cache/root', '1.21.1')).toBe(path.join('/cache/root', 'yarn', '1.21.1.tiny'))
    expect(() => yarnMappingsCachePath('/cache/root', '../escape')).toThrow(/invalid minecraft version/i)
  })

  it('downloads and caches yarn mappings through injected fetch/download implementations', async () => {
    const cacheRoot = await scratch()
    const downloads: Array<{ destination: string }> = []
    const jarPayload = createStoredZip([{ name: 'mappings/mappings.tiny', data: Buffer.from(SAMPLE_TINY, 'utf8') }])
    const mappingsPath = await ensureYarnMappings(cacheRoot, '1.21.1', {
      download: async (request) => {
        downloads.push({ destination: request.destination })
        await fs.writeFile(request.destination, jarPayload)
        return { source: request.sources[0], destination: request.destination, bytes: jarPayload.length, attempts: 1, failures: [] }
      },
      listVersions: async () => YARN_ENTRIES
    })
    expect(mappingsPath).toBe(yarnMappingsCachePath(cacheRoot, '1.21.1'))
    expect(await fs.readFile(mappingsPath, 'utf8')).toContain('com/example/Widget')
    expect(downloads).toHaveLength(1)
    // Second call must reuse the cache without downloading again.
    const second = await ensureYarnMappings(cacheRoot, '1.21.1', {
      download: async () => { throw new Error('should not download when cached') },
      listVersions: async () => { throw new Error('should not list versions when cached') }
    })
    expect(second).toBe(mappingsPath)
  })

  it('fails with an honest error when no yarn build exists for the requested version', async () => {
    const cacheRoot = await scratch()
    await expect(ensureYarnMappings(cacheRoot, '9.9.9', {
      download: async () => { throw new Error('unreachable') },
      listVersions: async () => YARN_ENTRIES
    })).rejects.toThrow(/no yarn mappings published/i)
  })

  it('remaps an intermediary-named jar end to end when a JDK is available', async () => {
    const javaPath = findJava()
    if (!javaPath) return
    const jar = await fixtureIntermediaryJar()
    if (!jar) return // no JDK compiler available
    const cacheRoot = await scratch()
    const mappingsPath = path.join(cacheRoot, 'yarn', 'test.tiny')
    await fs.writeFile(mappingsPath, SAMPLE_TINY, 'utf8')
    const outputJar = path.join(path.dirname(jar), 'remapped', 'named.jar')
    await fs.mkdir(path.dirname(outputJar), { recursive: true })
    const result = await remapJarWithTinyRemapper({ inputJar: jar, outputJar, mappingsPath, javaPath })
    expect(result.toolVersion).toBe('0.14.0')
    const stat = await fs.stat(outputJar)
    expect(stat.size).toBeGreaterThan(100)
  }, 120_000)

  it('rejects missing inputs before spawning Java', async () => {
    const javaPath = findJava() ?? 'java'
    const root = await scratch()
    await expect(remapJarWithTinyRemapper({
      inputJar: path.join(root, 'missing.jar'),
      outputJar: path.join(root, 'out.jar'),
      mappingsPath: path.join(root, 'mappings.tiny'),
      javaPath
    })).rejects.toThrow(/input jar does not exist/i)
  })
})
