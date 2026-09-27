import { existsSync, readdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import {
  inspectForDecompilation,
  listCachedSourceFiles,
  readCachedSourceFile,
  runDecompilation,
  scanReferencesForJar
} from './decompilePipeline'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function scratch(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pipeline-test-'))
  roots.push(root)
  return root
}

function findJava(): string | null {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const candidate of [process.env.JAVA_HOME, ...String(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!candidate) continue
    const normalized = candidate.trim().replace(/[/\\]$/, '')
    // PATH entries may point directly at a bin directory or at a javapath shim directory.
    for (const executable of [
      path.join(normalized.replace(/[\\/]bin$/i, ''), 'bin', `java${suffix}`),
      path.join(normalized, `java${suffix}`),
      path.join(normalized, 'bin', `java${suffix}`)
    ]) {
      if (existsSync(executable)) return executable
    }
  }
  return null
}

function findJavac(): string | null {
  const java = findJava()
  if (!java) return null
  const candidate = path.join(path.dirname(java), `javac${process.platform === 'win32' ? '.exe' : ''}`)
  if (existsSync(candidate)) return candidate
  // javapath-style shims expose java but not javac; fall back to scanning PATH.
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const executable = path.join(dir, `javac${suffix}`)
    if (existsSync(executable)) return executable
  }
  return null
}

function compileAll(sourceDir: string): void {
  const javac = findJavac()
  if (!javac) throw new Error('no javac')
  execFileSync(javac, ['-d', sourceDir, ...allJavaFiles(sourceDir)], { stdio: 'pipe' })
}

function allJavaFiles(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...allJavaFiles(absolute))
    else if (entry.name.endsWith('.java')) out.push(absolute)
  }
  return out
}

/** Builds a Forge-style jar with readable names and a manifest. */
async function fixtureClearJar(): Promise<string> {
  const root = await scratch()
  const src = path.join(root, 'src')
  await fs.mkdir(src, { recursive: true })
  await fs.writeFile(path.join(src, 'MyMod.java'), [
    'public class MyMod {',
    '  public static int compute(int value) {',
    '    return value * 42;',
    '  }',
    '}'
  ].join('\n'), 'utf8')
  try {
    compileAll(src)
  } catch {
    return ''
  }
  const files: Array<{ name: string; data: Buffer }> = [
    { name: 'META-INF/mods.toml', data: Buffer.from([
      'modLoader="javafml"',
      'loaderVersion="[1,)"',
      '[[mods]]',
      'modId="mymod"',
      'version="1.0.0"',
      'displayName="My Mod"',
      '[[dependencies.mymod]]',
      'modId="minecraft"',
      'mandatory=true',
      'versionRange="[1.20.1]"',
      ''
    ].join('\n'), 'utf8') }
  ]
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.class')) files.push({ name: entry.name, data: await fs.readFile(path.join(src, entry.name)) })
  }
  const jarPath = path.join(root, 'mymod.jar')
  await fs.writeFile(jarPath, createStoredZip(files))
  return jarPath
}

describe('decompile pipeline', () => {
  it('inspects a clear forge-style jar without running Java', async () => {
    const jar = await fixtureClearJar()
    if (!jar) return
    const cacheRoot = await scratch()
    const result = await inspectForDecompilation(jar, { cacheRoot })
    expect(result.modId).toBe('mymod')
    expect(result.loader).toBe('forge')
    expect(result.minecraftVersions).toEqual(['1.20.1'])
    expect(result.hasClasses).toBe(true)
    expect(result.obfuscationHint).toBe('clear')
    expect(result.remapRecommended).toBe(false)
    expect(result.cached).toBe(false)
  })

  it('runs the full decompile pipeline end to end when a JDK is available', async () => {
    const jar = await fixtureClearJar()
    const javaPath = findJava()
    // Hard-fail (instead of silently skipping) on machines that have Java — this dev box does.
    expect(jar, 'fixture jar could not be built; javac missing or compile failed').toBeTruthy()
    expect(javaPath, 'no java executable found for end-to-end test').toBeTruthy()
    const cacheRoot = await scratch()
    const phases: string[] = []
    const result = await runDecompilation({ jarPath: jar }, {
      cacheRoot,
      javaPath: javaPath as string,
      onProgress: (event) => phases.push(event.phase)
    })
    expect(result.reused).toBe(false)
    expect(result.provenance.readOnly).toBe(true)
    expect(result.provenance.sourceSha256).toBe(result.sha256)
    expect(result.files.some((file) => file.relativePath === 'MyMod.java')).toBe(true)
    expect(phases).toContain('done')
    // Reading back through the cache API works and matches.
    const text = await readCachedSourceFile(cacheRoot, result.sha256, 'MyMod.java')
    expect(text).toContain('compute')
    const listed = await listCachedSourceFiles(cacheRoot, result.sha256)
    expect(listed.map((entry) => entry.relativePath)).toContain('MyMod.java')

    // Second run must hit the cache and skip Java entirely (bogus java path proves it).
    const second = await runDecompilation({ jarPath: jar }, { cacheRoot, javaPath: '/definitely/missing/java' })
    expect(second.reused).toBe(true)
    expect(second.sha256).toBe(result.sha256)
    await fs.writeFile(path.join(result.entryPath, 'sources', 'MyMod.java'), 'truncated')
    const repaired = await runDecompilation({ jarPath: jar }, { cacheRoot, javaPath: javaPath as string })
    expect(repaired.reused).toBe(false)
    expect(await readCachedSourceFile(cacheRoot, repaired.sha256, 'MyMod.java')).toContain('compute')
  }, 180_000)

  it('rejects non-jar inputs and missing files with clear errors', async () => {
    const root = await scratch()
    await expect(inspectForDecompilation(path.join(root, 'not-a-jar.zip'), { cacheRoot: root })).rejects.toThrow(/只能分析/i)
    await expect(runDecompilation({ jarPath: path.join(root, 'missing.jar') }, { cacheRoot: root, javaPath: 'java' })).rejects.toThrow(/JAR 文件不存在/)
  })

  it('scans references and reports third-party packages', async () => {
    const jar = await fixtureClearJar()
    if (!jar) return
    const report = await scanReferencesForJar(jar, [{ modId: 'partner', packages: ['dev.partner'] }])
    expect(report.declaredModIds).toContain('mymod')
    expect(report.scannedClasses).toBeGreaterThanOrEqual(1)
  })

  it('guards against path traversal in cached file reads', async () => {
    const root = await scratch()
    await expect(readCachedSourceFile(root, 'a'.repeat(64), '../../escape.java')).rejects.toThrow()
    await expect(listCachedSourceFiles(root, 'a'.repeat(64))).rejects.toThrow(/尚无反编译缓存/)
  })
})
