import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

const lanes = new Map<string, Promise<string>>()
export async function ensureProjectIdentity(project: ProjectInfo): Promise<string> {
  const key = path.resolve(project.path)
  const existing = lanes.get(key)
  if (existing) return existing
  const pending = (async () => {
    const file = path.join(key, 'modmind.project.json')
    const data = await fs.readFile(file, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { ...project } as Record<string, unknown>
    })
    const id = typeof data.projectId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(data.projectId) ? data.projectId : randomUUID()
    if (data.projectId !== id) {
      await fs.mkdir(key, { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, JSON.stringify({ ...data, projectId: id }, null, 2) + '\n', 'utf8')
      await fs.rename(temporary, file)
    }
    project.projectId = id
    return id
  })()
  lanes.set(key, pending)
  try { return await pending } finally { lanes.delete(key) }
}
