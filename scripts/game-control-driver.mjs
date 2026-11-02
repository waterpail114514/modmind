import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function command(directory, body) {
  const id = randomUUID(), commandPath = path.join(directory, 'commands', `${id}.json`)
  await fs.mkdir(path.dirname(commandPath), { recursive: true })
  await fs.writeFile(commandPath + '.tmp', JSON.stringify({ ...body, id }))
  await fs.rename(commandPath + '.tmp', commandPath)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const response = await fs.readFile(path.join(directory, 'responses', `${id}.json`), 'utf8').then(text => { try { return JSON.parse(text) } catch { return null } }, () => null)
    if (response?.id === id) { if (response.error) throw new Error(response.error); return response.value }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Smoke harness did not respond')
}
export const input = (directory, action) => command(directory, { operation: 'input', action })
export async function click(directory, x, y) {
  await input(directory, { type: 'move', x, y })
  await input(directory, { type: 'button', code: 0, state: 'down', leaseMs: 1000 })
  await input(directory, { type: 'button', code: 0, state: 'up' })
}
export async function key(directory, code, leaseMs = 100) {
  await input(directory, { type: 'key', code, state: 'down', leaseMs })
  await new Promise(resolve => setTimeout(resolve, leaseMs + 100))
}
