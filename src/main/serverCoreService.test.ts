import { expect, it, vi } from 'vitest'
import { serverCoreBuilds, validateServerProfile, defaultServerProfile } from './serverCoreService'
import { fetchJsonWithRetry } from './networkRequest'
import type { ProjectInfo } from '../shared/types'

vi.mock('./networkRequest', () => ({ fetchJsonWithRetry: vi.fn() }))

it('filters unverifiable builds and sorts upstream builds before automatic selection', async () => {
  const download = { name: 'paper.jar', url: 'https://fill-data.papermc.io/test.jar', checksums: { sha256: 'a'.repeat(64) } }
  vi.mocked(fetchJsonWithRetry).mockResolvedValue([
    { id: 1, channel: 'STABLE', downloads: { 'server:default': download } },
    { id: 3, channel: 'STABLE', downloads: { 'server:default': { ...download, checksums: {} } } },
    { id: 2, channel: 'STABLE', downloads: { 'server:default': download } }
  ])
  expect((await serverCoreBuilds('paper', '1.21.1')).map(b => b.build)).toEqual(['2', '1'])
  const controller = new AbortController(); controller.abort()
  await expect(serverCoreBuilds('paper', '1.21.1', controller.signal)).rejects.toThrow()
})

it('keeps verified Purpur builds when another metadata request fails', async () => {
  vi.mocked(fetchJsonWithRetry).mockImplementation(async url => {
    if (url.endsWith('/1.20.4')) return { builds: { all: ['1', '2', '3'] } }
    if (url.endsWith('/2')) throw new Error('HTTP 503')
    return { result: 'SUCCESS', md5: 'b'.repeat(32) }
  })
  expect((await serverCoreBuilds('purpur', '1.20.4')).map(b => b.build)).toEqual(['3', '1'])
})

it('rejects too-old runtime Java and applies Velocity version boundaries', () => {
  const project: ProjectInfo = { name: 'Test', path: '', namespace: 'test', kind: 'server-plugin', loader: 'velocity', minecraftVersion: '4.1.1', createdAt: '' }
  expect(defaultServerProfile(project).javaVersion).toBe(25)
  expect(defaultServerProfile({ ...project, minecraftVersion: '3.4.0' }).javaVersion).toBe(17)
  expect(() => validateServerProfile(project, { ...defaultServerProfile(project), javaVersion: 21 })).toThrow('Java')
})
