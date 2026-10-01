import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { nativeFeatureFunction } from '../../src/main/nativeFeatureServices'

const sha256 = '6ecb5f604326a8cb74ede15f667d170e2001cd968ab7f99592a0045ff27b0fca'
async function verified(file: string): Promise<boolean> {
  try {
    if ((await fs.stat(file)).size !== 78162179) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === sha256
  } catch { return false }
}

export function activate(options: { pluginDirectory: string }) {
  let assembling: Promise<string> | undefined
  const assemble = async (): Promise<string> => {
    // Preserve the upstream JAR byte for byte while keeping each download below 64 MiB.
    const directory = path.join(app.getPath('userData'), 'server-pack-creator', 'runtime')
    const destination = path.join(directory, `ServerPackCreator-8.1.2-${sha256.slice(0, 12)}.jar`)
    if (await verified(destination)) return destination
    const tail = nativeFeatureFunction<() => string>('server-pack-runtime-data', 'resource')()
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `.assembling-${randomUUID()}`)
    const output = await fs.open(temporary, 'wx')
    try {
      for (const file of [path.join(options.pluginDirectory, 'assets', 'chunks', 'server-pack-creator.part'), tail]) {
        for await (const chunk of createReadStream(file)) await output.writeFile(chunk)
      }
      await output.close()
      if (!await verified(temporary)) throw new Error('服务端打包组件校验失败，请重新安装该功能')
      await fs.rename(temporary, destination)
      return destination
    } finally { await output.close().catch(() => undefined); await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }
  return { resource: (name: string): Promise<string> => {
    if (name !== 'ServerPackCreator-8.1.2.jar') throw new Error('未知服务端打包资源')
    return assembling ??= assemble().finally(() => { assembling = undefined })
  } }
}
