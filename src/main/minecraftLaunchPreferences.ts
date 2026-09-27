import fs from 'node:fs/promises'
import path from 'node:path'

export function gameDirectoryForLaunch(instanceRoot: string, withoutProjectMod = false): string {
  return withoutProjectMod ? path.join(instanceRoot, 'clean-game') : instanceRoot
}

export function validateJvmArguments(input: unknown): string[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 20 || input.some(value => typeof value !== 'string' || !value.startsWith('-') || value.length > 256 || /[\r\n\0]/.test(value))) {
    throw new Error('JVM 参数需每行一项，最多 20 项，每项不超过 256 个字符')
  }
  if (input.some(value => /^-Xm(?:s|x)/i.test(value))) throw new Error('内存请使用“最大内存”设置')
  return input
}

export async function applyNarratorPreference(gameDirectory: string, disableNarrator: boolean): Promise<void> {
  if (!disableNarrator) return
  const file = path.join(gameDirectory, 'options.txt')
  const original = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const values = new Map([['narrator', '0'], ['onboardAccessibility', 'false']])
  const lines = original.split(/\r?\n/).filter(Boolean).filter(line => {
    const key = line.slice(0, line.indexOf(':'))
    return !values.has(key)
  })
  for (const [key, value] of values) lines.push(`${key}:${value}`)
  await fs.mkdir(gameDirectory, { recursive: true })
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
}
