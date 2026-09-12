import { promises as fs } from 'node:fs'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { setTimeout as delay } from 'node:timers/promises'

/** Cross-process ownership for one tool cache; interrupted extraction is never published. */
export async function withToolInstallLock<T>(directory: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(directory), { recursive: true })
  let release: (() => Promise<void>) | undefined
  const deadline = Date.now() + 180_000
  while (!release) {
    signal?.throwIfAborted()
    try { release = await lockfile.lock(directory, { realpath: false, stale: 30_000, update: 10_000, retries: 0 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error
      await delay(250, undefined, { signal })
    }
  }
  try { return await operation() } finally { await release() }
}

export async function installToolDirectory(directory: string, signal: AbortSignal | undefined, extract: (stage: string) => Promise<string>, required: string[]): Promise<void> {
  const root = path.resolve(path.dirname(directory))
  const stage = await fs.mkdtemp(path.join(root, '.install-'))
  try {
    const extracted = path.resolve(await extract(stage))
    if (!extracted.startsWith(stage + path.sep)) throw new Error('Tool extraction escaped staging directory')
    for (const file of required) if (!(await fs.stat(path.join(extracted, file))).isFile()) throw new Error(`Tool archive missing ${file}`)
    signal?.throwIfAborted()
    await fs.writeFile(path.join(extracted, '.modmind-complete'), 'verified archive; complete extraction\n')
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rename(extracted, directory)
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}
