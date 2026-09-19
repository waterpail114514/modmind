import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import catalog from './testClientCatalog.json'
import { verifiedDownload } from './downloadService'

export function specificsFor(version: string, loader: string) {
  return catalog.entries.find(entry => entry.minecraft === version && entry.loader === loader)
}
const installing = new Map<string, Promise<void>>()
export async function installTestSpecifics(entry: NonNullable<ReturnType<typeof specificsFor>>, mods: string, signal?: AbortSignal): Promise<void> {
  const cache = path.join(app.getPath('userData'), 'test-tools', 'hmc-specifics', `${entry.sha256}.jar`)
  const valid = await fs.readFile(cache).then(bytes => createHash('sha256').update(bytes).digest('hex') === entry.sha256).catch(() => false)
  if (!valid) {
    if (!installing.has(cache)) {
      const request = verifiedDownload.download({ sources: [{ id: 'specifics-official', label: 'HMC Specifics', url: entry.url }, { id: 'specifics-mirror', label: 'HMC Specifics 镜像', url: `https://ghfast.top/${entry.url}` }], destination: cache, expectedHash: { algorithm: 'sha256', value: entry.sha256 }, maxBytes: 16 * 1024 * 1024, signal }).then(() => undefined)
      installing.set(cache, request)
      void request.finally(() => installing.delete(cache)).catch(() => undefined)
    }
    await installing.get(cache)
  }
  signal?.throwIfAborted()
  await fs.mkdir(mods, { recursive: true })
  await fs.copyFile(cache, path.join(mods, 'modmind-hmc-specifics.jar'))
}
