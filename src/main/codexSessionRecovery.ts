import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

export function isMissingCodexHistory(message: string): boolean {
  return /\bno\s+(?:rollout|thread|session|history)\s+found\b|\b(?:rollout|thread|session)\s+(?:was\s+)?not found\b/i.test(message)
    || (/failed to resolve rollout path/i.test(message) && /file does not exist|not found|ENOENT/i.test(message))
}

/** Search only this project's managed homes and the explicitly selected CLI home. */
export async function findCodexRollout(project: ProjectInfo, sessionId: string, sessionHome?: string): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(sessionId)) return undefined
  const roots = [
    ...(sessionHome ? [path.join(sessionHome, 'sessions')] : []),
    path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents', 'codex-homes')
  ]
  const pending = roots.map(directory => ({ directory, depth: 0 }))
  const seen = new Set<string>()
  const candidates: Array<{ file: string; modified: number }> = []
  while (pending.length) {
    const current = pending.shift()!
    const resolved = path.resolve(current.directory)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const file = path.join(resolved, entry.name)
      if (entry.isDirectory() && current.depth < 8 && entry.name !== 'archived_sessions') {
        pending.push({ directory: file, depth: current.depth + 1 })
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) {
        // A filename alone is not enough: never attach another conversation's history.
        const handle = await fs.open(file, 'r').catch(() => undefined)
        if (!handle) continue
        try {
          const buffer = Buffer.alloc(64 * 1024)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          const metadata = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0])
          if (metadata.type === 'session_meta' && metadata.payload?.id === sessionId) {
            candidates.push({ file, modified: (await handle.stat()).mtimeMs })
          }
        } catch { /* Incomplete or corrupt files are not recovery candidates. */ }
        finally { await handle.close() }
      }
    }
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.file
}
