import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Version } from '@xmcl/core'

// Independently compare the SDK's effective launch libraries with the audited
// input JAR bytes. This is classpath evidence, never a substitute for a game run.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const host = path.resolve(arg('host-root') || '.')
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
const matrix = await read(path.join(host, 'docs/game-control-compatibility/compatibility-matrix.json'))
const hooks = await read(path.join(host, 'docs/game-control-compatibility/input-hook-inspection.json'))
const files = ['test-results/game-control-loader-preparation/results.json', 'test-results/game-control-forge-preparation/results.json', ...(arg('extra-preparation') ? [arg('extra-preparation')] : []), ...(arg('profile-variants') ? [arg('profile-variants')] : [])]
const preparations = (await Promise.all(files.map(read))).flatMap(report => report.rows.map(row => ({ ...row, resources: row.resources || report.resources })))
const variants = arg('profile-variants') ? (await read(arg('profile-variants'))).rows : []
const targets = [...matrix.combinations, ...variants.map(row => ({ ...matrix.combinations.find(target => target.key === row.baseKey), key: row.key }))]
const checked = new Map(), rows = []
for (const target of targets) {
  const prepared = preparations.find(row => row.key === target.key && row.status === 'prepared')
  assert(prepared, 'Prepared profile missing: ' + target.key)
  const version = await Version.parse(prepared.resources, prepared.versionId)
  assert.equal(version.minecraftVersion, target.minecraftVersion, 'Wrong base client: ' + target.key)
  const inputs = version.libraries.filter(library => !library.classifier && (library.groupId === 'org.lwjgl.lwjgl' && library.artifactId === 'lwjgl' || library.groupId === 'org.lwjgl' && ['lwjgl-glfw', 'lwjgl-sdl'].includes(library.artifactId)))
  assert.equal(inputs.length, 1, 'Unexpected effective input classpath: ' + target.key)
  const evidence = []
  for (const library of inputs) {
    const name = `${library.groupId}:${library.artifactId}:${library.version}`, file = path.join(prepared.resources, 'libraries', library.path)
    const expected = hooks.artifacts.find(artifact => artifact.name === name)
    assert(expected, 'Unaudited input library: ' + name)
    if (!checked.has(file)) {
      const bytes = await fs.readFile(file), sha1 = createHash('sha1').update(bytes).digest('hex')
      assert.equal(sha1, expected.sha1); assert.equal(bytes.length, expected.bytes)
      checked.set(file, { name, sha1, bytes: bytes.length, family: expected.family, file })
    }
    evidence.push(checked.get(file))
  }
  const profile = path.join(prepared.resources, 'versions', prepared.versionId, prepared.versionId + '.json')
  rows.push({ key: target.key, versionId: prepared.versionId, minecraftVersion: version.minecraftVersion, originalProfileSha256: prepared.profileSha256, installedProfileSha256: createHash('sha256').update(await fs.readFile(profile)).digest('hex'), inputs: evidence })
}
const result = { checkedAt: new Date().toISOString(), assessment: 'effective Windows launch classpath and input JAR SHA1/size only; no game run inferred', expected: targets.length, verified: rows.length, distinctInputJars: [...checked.values()], rows }
const output = path.resolve(arg('output') || 'test-results/game-control-runtime-libraries.json')
await fs.writeFile(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ verified: rows.length, distinctInputJars: checked.size, output }))
