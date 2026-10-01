import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import {
  isBuiltinPackage,
  normalizeClassReference,
  scanClassFile,
  scanExtractedJarReferences,
  scanJarReferences
} from "../../feature-plugins/decompile/src/main/classReferenceScanner"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function scratch(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-classref-test-'))
  roots.push(root)
  return root
}

/** Assembles a minimal but valid class file with the given constant-pool class references. */
function buildClassFile(selfName: string, referencedNames: string[]): Buffer {
  const utf8 = (text: string): Buffer => {
    const body = Buffer.from(text, 'utf8')
    return Buffer.concat([Buffer.from([1]), Buffer.from([body.length >> 8 & 0xff, body.length & 0xff]), body])
  }
  const entries: Buffer[] = []
  // entry index 1..n built in order; we track indexes manually
  let next = 1
  const selfNameIndex = next++
  entries.push(utf8(selfName))
  const refIndexes: number[] = []
  for (const name of referencedNames) {
    refIndexes.push(next)
    entries.push(utf8(name))
    next += 1
  }
  const classEntryFor = (nameIndex: number): number => {
    const classIndex = next++
    entries.push(Buffer.from([7, nameIndex >> 8 & 0xff, nameIndex & 0xff]))
    return classIndex
  }
  const selfClassIndex = classEntryFor(selfNameIndex)
  for (const refIndex of refIndexes) classEntryFor(refIndex)
  const count = next // highest used index + 1 (slots are 1-indexed)
  const header = Buffer.alloc(10)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt16BE(0, 4) // minor
  header.writeUInt16BE(61, 6) // major Java 17
  header.writeUInt16BE(count, 8)
  return Buffer.concat([header, ...entries])
}

describe('class reference scanner', () => {
  it('parses constant-pool class references from a hand-built class file', () => {
    const parsed = scanClassFile(buildClassFile('com/example/Main', ['com/example/Helper', 'net/minecraft/world/World']))
    expect(parsed?.className).toBe('com/example/Main')
    expect(parsed?.referencedClasses).toEqual(['com/example/Helper', 'net/minecraft/world/World'])
  })

  it('rejects non-class buffers instead of throwing', () => {
    expect(scanClassFile(Buffer.from('not a class file'))).toBeNull()
    expect(scanClassFile(Buffer.alloc(0))).toBeNull()
  })

  it('normalizes descriptor-style and plain references safely', () => {
    expect(normalizeClassReference('Ljava/lang/String;')).toBe('java/lang/String')
    expect(normalizeClassReference('[Lcom/example/Foo;')).toBe('com/example/Foo')
    expect(normalizeClassReference('com/example/Foo')).toBe('com/example/Foo')
    expect(normalizeClassReference('Unqualified')).toBeNull()
    expect(normalizeClassReference('bad name!')).toBeNull()
  })

  it('filters builtin Minecraft/JDK packages', () => {
    expect(isBuiltinPackage('net/minecraft/world')).toBe(true)
    expect(isBuiltinPackage('com/mojang/blaze3d')).toBe(true)
    expect(isBuiltinPackage('java/util')).toBe(true)
    expect(isBuiltinPackage('com/example/thirdparty')).toBe(false)
  })

  it('aggregates package-level references across an extracted tree with mod matching', async () => {
    const root = await scratch()
    await fs.mkdir(path.join(root, 'com/example'), { recursive: true })
    await fs.writeFile(path.join(root, 'com/example/Main.class'), buildClassFile('com/example/Main', ['dev/othermod/api/Thing', 'net/minecraft/core/BlockPos']))
    await fs.writeFile(path.join(root, 'com/example/Second.class'), buildClassFile('com/example/Second', ['dev/othermod/api/Other']))
    const { items, scannedClasses } = await scanExtractedJarReferences(root, {
      knownModPackages: [{ modId: 'othermod', packages: ['dev.othermod'] }]
    })
    expect(scannedClasses).toBe(2)
    const other = items.find((item) => item.packageName === 'dev/othermod/api')
    expect(other?.referenceCount).toBe(2)
    expect(other?.matchedModIds).toEqual(['othermod'])
    expect(items.some((item) => item.packageName.startsWith('net/minecraft'))).toBe(false)
  })

  it('scans a real compiled jar end to end when a JDK is available', async () => {
    const javaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : ''
    const javac = javaHome && existsSync(path.join(javaHome, 'javac.exe')) ? path.join(javaHome, 'javac.exe') : javaHome && existsSync(path.join(javaHome, 'javac')) ? path.join(javaHome, 'javac') : null
    if (!javac) return
    const root = await scratch()
    const sourceDir = path.join(root, 'src')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'App.java'), [
      'public class App {',
      '  public static void main(String[] args) {',
      '    System.out.println("hi " + args.length);',
      '  }',
      '}'
    ].join('\n'), 'utf8')
    execFileSync(javac, ['-d', sourceDir, path.join(sourceDir, 'App.java')], { stdio: 'pipe' })
    const jarPath = path.join(root, 'app.jar')
    const files: Array<{ name: string; data: Buffer }> = []
    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.class')) files.push({ name: entry.name, data: await fs.readFile(path.join(sourceDir, entry.name)) })
    }
    await fs.writeFile(jarPath, createStoredZip(files))
    const report = await scanJarReferences(jarPath)
    expect(report.scannedClasses).toBeGreaterThanOrEqual(1)
    // java.* references are filtered out, so no builtin packages leak into the report.
    expect(report.items.every((item) => !isBuiltinPackage(item.packageName))).toBe(true)
  })
})
