import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import artifact from './legacyForgeJavaCompatibilityArtifact.json'

const filename = 'modmind-java8-fix.jar', licenseName = 'modmind-java8-fix-LICENSE.txt'

/** Forge 1.7.2's sorting code predates Java 8u20. Reuse Forge's MIT fix;
 * it does not provide game input, rendering or controller APIs. */
export async function prepareLegacyForgeJavaCompatibility(loader: string, minecraftVersion: string, gameDirectory: string): Promise<{ applied: boolean; existing?: string; sha256?: string }> {
  if (loader !== 'forge' || minecraftVersion !== '1.7.2') return { applied: false }
  const mods = path.join(gameDirectory, 'mods')
  await fs.mkdir(mods, { recursive: true })
  if ((await fs.lstat(mods)).isSymbolicLink()) throw new Error('旧版 Java 兼容补丁只能写入受管实例的实际 mods 目录')
  const target = path.join(mods, filename), license = path.join(mods, licenseName)
  for (const file of [target, license]) {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (stat?.isSymbolicLink()) throw new Error('旧版 Java 兼容补丁的受管文件不能是符号链接')
  }
  const supplied = (await fs.readdir(mods, { withFileTypes: true })).find(entry => entry.isFile() && /^legacy[-_]?java[-_]?fixer[-_\d.]*\.jar$/i.test(entry.name))?.name
  if (supplied) {
    // Only these two reserved generated files belong to ModMind. Keep the
    // user's selected compatibility patch and avoid duplicate coremods.
    await fs.rm(target, { force: true }); await fs.rm(license, { force: true })
    return { applied: false, existing: supplied }
  }
  const bytes = Buffer.from(artifact.data, 'base64'), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  if (bytes.length !== artifact.upstream.bytes || hash(bytes) !== artifact.upstream.sha256) throw new Error('旧版 Java 兼容补丁完整性校验失败')
  const previous = await fs.readFile(target).catch(() => undefined)
  if (!previous || hash(previous) !== artifact.upstream.sha256) {
    const temporary = `${target}.${randomUUID()}.tmp`
    try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, target) }
    finally { await fs.rm(temporary, { force: true }) }
  }
  await fs.writeFile(license, artifact.licenseText)
  return { applied: true, sha256: artifact.upstream.sha256 }
}
