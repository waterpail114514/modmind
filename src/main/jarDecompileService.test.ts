import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStoredZip } from './bedrockAddon'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDecompileJava,
  buildDecompileProvenance,
  classifyObfuscation,
  decompileJarWithVineflower,
  summarizeDecompiledTree,
  vineflowerBundledJarCandidates,
  vineflowerCommand
} from "../../feature-plugins/decompile/src/main/jarDecompileService"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function scratch(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-test-'))
  roots.push(root)
  return root
}

/** Compiles Java source with the local JDK so the end-to-end test exercises real bytecode. */
function compileClass(directory: string): void {
  const javaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : ''
  const javac = javaHome && existsSync(path.join(javaHome, 'javac.exe')) ? path.join(javaHome, 'javac.exe')
    : javaHome && existsSync(path.join(javaHome, 'javac')) ? path.join(javaHome, 'javac')
    : 'javac'
  execFileSync(javac, ['-d', directory, path.join(directory, 'Hello.java')], { stdio: 'pipe' })
}

async function fixtureJar(): Promise<string> {
  const root = await scratch()
  const classes = path.join(root, 'classes')
  await fs.mkdir(classes, { recursive: true })
  await fs.writeFile(path.join(classes, 'Hello.java'), [
    'public class Hello {',
    '  public static String greet(String name) {',
    '    return "hello " + name;',
    '  }',
    '}'
  ].join('\n'), 'utf8')
  try {
    compileClass(classes)
  } catch {
    // No JDK on this machine; fall back to a pre-baked minimal class file.
    await fs.writeFile(path.join(classes, 'Hello.class'), Buffer.from('cafeba', 'hex'))
  }
  const jarPath = path.join(root, 'fixture.jar')
  const files: Array<{ name: string; data: Buffer }> = []
  for (const entry of await fs.readdir(classes, { withFileTypes: true })) {
    if (entry.isFile()) files.push({ name: entry.name, data: await fs.readFile(path.join(classes, entry.name)) })
  }
  await fs.writeFile(jarPath, createStoredZip(files))
  return jarPath
}

describe('vineflower decompiler service', () => {
  it('resolves bundled candidates across dev and packaged layouts', () => {
    const candidates = vineflowerBundledJarCandidates('/app', '/resources')
    expect(candidates).toEqual([
      path.join('/resources', 'feature-plugins', 'decompile', 'assets', 'decompile-tools', 'vineflower-1.11.1.jar'),
      path.join('/app', 'feature-plugins', 'decompile', 'assets', 'decompile-tools', 'vineflower-1.11.1.jar')
    ])
  })

  it('pins the vineflower command shape', () => {
    const command = vineflowerCommand('/tools/vineflower.jar', '/in/mod.jar', '/out/dir')
    expect(command[0]).toBe('-jar')
    expect(command[1]).toBe('/tools/vineflower.jar')
    expect(command.at(-2)).toBe('/in/mod.jar')
    expect(command.at(-1)).toBe('/out/dir')
    expect(command.some((arg) => arg.startsWith('-dgs='))).toBe(true)
  })

  it('classifies obfuscated class names honestly', () => {
    expect(classifyObfuscation([])).toEqual({ obfuscationRatio: 0, hint: 'unknown' })
    expect(classifyObfuscation(['com.example.ModMain', 'com.example.Util']).hint).toBe('clear')
    const obfuscated = classifyObfuscation(['a', 'b', 'c.d', 'a.b.e'])
    expect(obfuscated.hint).toBe('obfuscated')
    expect(obfuscated.obfuscationRatio).toBeGreaterThan(0.5)
  })

  it('builds immutable read-only provenance', () => {
    const provenance = buildDecompileProvenance({
      sourceSha256: 'f'.repeat(64),
      sourceFileName: 'mod.jar',
      sourceSize: 123,
      engine: 'vineflower',
      engineVersion: '1.11.1',
      engineArgs: [],
      obfuscationHint: 'clear'
    })
    expect(provenance.schemaVersion).toBe(1)
    expect(provenance.readOnly).toBe(true)
    expect(provenance.createdAt).toBeTruthy()
  })

  it('rejects missing input jars and non-empty output directories', async () => {
    const root = await scratch()
    const javaPath = process.execPath.includes('node') ? findJava() : findJava()
    if (!javaPath) return
    await expect(decompileJarWithVineflower({ inputJar: path.join(root, 'missing.jar'), outputDirectory: path.join(root, 'out'), javaPath })).rejects.toThrow(/input jar does not exist/i)
    const outDir = path.join(root, 'out')
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(path.join(outDir, 'stale.txt'), 'x', 'utf8')
    const jar = await fixtureJar()
    await expect(decompileJarWithVineflower({ inputJar: jar, outputDirectory: outDir, javaPath })).rejects.toThrow(/must start empty/i)
  }, 60_000)

  it('decompiles a real compiled jar end to end when a JDK is available', async () => {
    const javaPath = findJava()
    if (!javaPath) return // CI without Java: covered by manual verification elsewhere
    await assertDecompileJava(javaPath)
    const jar = await fixtureJar()
    const output = path.join(await scratch(), 'sources')
    const progress: string[] = []
    const result = await decompileJarWithVineflower({
      inputJar: jar,
      outputDirectory: output,
      javaPath,
      onProgress: (message) => progress.push(message)
    })
    expect(result.engine).toBe('vineflower')
    expect(result.files.map((entry) => entry.relativePath)).toContain('Hello.java')
    const summary = await summarizeDecompiledTree(output, path.dirname(output))
    const hello = summary.find((entry) => entry.relativePath === 'Hello.java')
    expect(hello?.size).toBeGreaterThan(0)
    expect(hello?.hasErrors).toBe(false)
    const text = await fs.readFile(path.join(output, 'Hello.java'), 'utf8')
    expect(text).toContain('greet')
    expect(progress.length).toBeGreaterThan(0)
  }, 180_000)
})

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
