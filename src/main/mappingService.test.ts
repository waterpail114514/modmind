import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MappingService } from './mappingService'
import { fetchTextWithRetry } from './networkRequest'

vi.mock('./networkRequest', () => ({ fetchTextWithRetry: vi.fn() }))
const roots: string[] = []
const validIndex = 'const data = `mojang:official\nnet/minecraft/world/level/block/Block\n`;'
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-mappings-cache-'))
  roots.push(root)
  return root
}
beforeEach(() => vi.resetAllMocks())
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('repairs a poisoned index once even when concurrent services read it, then works offline', async () => {
  const root = await fixture()
  await fs.mkdir(path.join(root, '1.21.1'))
  await fs.writeFile(path.join(root, '1.21.1/class-index.js'), '<html>upstream error</html>')
  vi.mocked(fetchTextWithRetry).mockResolvedValue(validIndex)
  const results = await Promise.all(Array.from({ length: 4 }, () => new MappingService(root).search('1.21.1', 'Block')))
  expect(results.every(result => result.results.length === 1)).toBe(true)
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(1)
  vi.mocked(fetchTextWithRetry).mockRejectedValue(new Error('offline'))
  expect((await new MappingService(root).search('1.21.1', 'Block')).cached).toBe(true)
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(1)
  expect(await fs.readdir(path.join(root, '1.21.1'))).toEqual(['class-index.js'])
})

it('does not publish or loop on invalid upstream data and can recover on the next request', async () => {
  const root = await fixture()
  const service = new MappingService(root)
  vi.mocked(fetchTextWithRetry).mockResolvedValue('<html>error</html>')
  await expect(service.search('1.21.1', 'Block')).rejects.toThrow('类索引格式无效')
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(1)
  expect(await fs.stat(path.join(root, '1.21.1/class-index.js')).catch(() => null)).toBeNull()
  vi.mocked(fetchTextWithRetry).mockResolvedValue(validIndex)
  expect((await service.search('1.21.1', 'Block')).results).toHaveLength(1)
})

it('repairs a truncated cached class page instead of returning an empty member list forever', async () => {
  const root = await fixture()
  const directory = path.join(root, '1.21.1')
  await fs.mkdir(path.join(directory, 'pages/net/minecraft/world/level/block'), { recursive: true })
  await fs.writeFile(path.join(directory, 'class-index.js'), validIndex)
  const page = path.join(directory, 'pages/net/minecraft/world/level/block/Block.html')
  await fs.writeFile(page, '<html>error</html>')
  vi.mocked(fetchTextWithRetry).mockResolvedValue('<main><div class="A"><p>public class Block</p></div></main>')
  const result = await new MappingService(root).getClass('1.21.1', 'net.minecraft.world.level.block.Block')
  expect(result.declaration).toBe('public class Block')
  expect(result.cached).toBe(false)
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(1)
})
