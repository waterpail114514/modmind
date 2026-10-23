import { promises as fs } from 'node:fs'
import path from 'node:path'
import ids from '../shared/bundledStudios.json'

export async function builtinStudioDirectories(directory: string): Promise<Array<{ id: string; directory: string }>> {
  const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'))
  if (index.format !== 'modmind-bundled-studios' || index.schemaVersion !== 2 || !Array.isArray(index.packages)
    || index.packages.length !== ids.length || new Set(index.packages.map((entry: { id: string }) => entry.id)).size !== ids.length
    || index.packages.some((entry: { id: string; directory: string }) => !ids.includes(entry.id) || entry.directory !== entry.id)) throw new Error('内置工作台索引无效')
  return index.packages.map((entry: { id: string; directory: string }) => ({ id: entry.id, directory: path.join(directory, entry.directory) }))
}
