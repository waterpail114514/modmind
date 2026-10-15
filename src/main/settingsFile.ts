import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** A failed replacement must leave the previous file in place. Never unlink it to retry. */
export async function writeSettingsFile(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
