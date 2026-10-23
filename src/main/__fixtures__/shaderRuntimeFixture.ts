import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createStoredZip } from '../bedrockAddon'

export async function shaderRuntimeFixture(root: string) {
  const source = path.resolve('src/main/__fixtures__/shader-runtime'), classes = path.join(root, 'fixture-classes')
  const sources: string[] = []
  const collect = async (directory: string) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await collect(file); else if (file.endsWith('.java')) sources.push(file) } }
  await collect(source)
  await fs.mkdir(classes, { recursive: true })
  execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', classes, ...sources], { stdio: 'pipe', windowsHide: true })
  const entries: Array<{ name: string; data: Buffer }> = []
  const packageClasses = async (directory: string) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await packageClasses(file); else entries.push({ name: path.relative(classes, file).replaceAll('\\', '/'), data: await fs.readFile(file) }) } }
  await packageClasses(classes)
  const jar = createStoredZip(entries, true), runtimeRoot = path.join(root, 'fixture-runtime'), instancePath = path.join(root, 'fixture-instance')
  const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex')
  const write = async (relative: string, data: string | Buffer) => { const file = path.join(runtimeRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data) }
  const assets = Buffer.from('{"objects":{}}')
  await write('assets/indexes/fixture.json', assets)
  await write('versions/26.2/26.2.jar', jar)
  await write('libraries/net/fabricmc/fabric-loader/0.19.0/fabric-loader-0.19.0.jar', jar)
  await write('versions/26.2/26.2.json', JSON.stringify({ id: '26.2', mainClass: 'net.minecraft.client.main.Main', assets: 'fixture', assetIndex: { id: 'fixture', sha1: sha1(assets), size: assets.length, url: 'https://fixture.invalid/assets' },
    downloads: { client: { sha1: sha1(jar), size: jar.length, url: 'https://fixture.invalid/client' } }, libraries: [], javaVersion: { component: 'java-runtime-epsilon', majorVersion: 25 },
    arguments: { game: ['--gameDir', '${game_directory}'], jvm: ['-cp', '${classpath}'] }, releaseTime: '2026-10-06T00:00:00Z', time: '2026-10-06T00:00:00Z', type: 'release', minimumLauncherVersion: 21 }))
  const id = 'fabric-jvm-fixture'
  await write(`versions/${id}/${id}.json`, JSON.stringify({ id, inheritsFrom: '26.2', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.0', downloads: { artifact: { path: 'net/fabricmc/fabric-loader/0.19.0/fabric-loader-0.19.0.jar', sha1: sha1(jar), size: jar.length, url: 'https://fixture.invalid/loader' } } }] }))
  await fs.mkdir(path.join(instancePath, 'mods'), { recursive: true })
  await fs.writeFile(path.join(instancePath, 'mods/iris.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ id: 'iris', version: '1.11.2+mc26.2', depends: { minecraft: '26.2', java: '>=25', fabricloader: '*', sodium: '*' } })) }]))
  await fs.writeFile(path.join(instancePath, 'mods/sodium.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"id":"sodium","version":"0.9.1","depends":{"minecraft":"26.2"}}') }]))
  await fs.writeFile(path.join(instancePath, 'mods/unrelated.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"id":"unrelated","version":"1.0"}') }]))
  await fs.writeFile(path.join(instancePath, 'options.txt'), 'PLAYER OPTIONS MUST NOT CHANGE')
  // resolve the compiler's Java home without claiming the fixture JVM is Java 25.
  const javaClass = path.join(root, 'JavaHome.java')
  await fs.writeFile(javaClass, 'class JavaHome { public static void main(String[] a) { System.out.print(System.getProperty("java.home")); } }')
  const javaHome = execFileSync('java', [javaClass], { encoding: 'utf8', windowsHide: true }).trim()
  return { runtimeRoot, instancePath, versionId: id, javaHome, fixtureOnly: true as const }
}
