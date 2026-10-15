import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReleaseService, type ReleaseSecrets } from './releaseService'
import { createStoredZip } from './bedrockAddon'
import type { ProjectInfo } from '../shared/types'
import { addModpackFiles, createModpackTemplate } from './modpackService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('release preflight and publishing guard', () => {
  it('uses one project and one settings snapshot across a pending preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-identity-')); roots.push(root)
    const make = (name: string): ProjectInfo => ({ name, path: path.join(root, name), namespace: name, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' })
    const a = make('A'), b = make('B'); await fs.mkdir(a.path); await fs.mkdir(b.path)
    let current = a
    const service = new ReleaseService(() => current, async () => ({ githubToken: 'fixture-token', modrinthToken: '', curseForgeToken: '' }), async () => {})
    await service.saveSettings({ version: '1.0.0', displayName: 'A', changelog: '', channel: 'release', modrinthProjectId: '', curseForgeProjectId: '', githubRepository: 'owner/A' })
    current = b
    await service.saveSettings({ version: '2.0.0', displayName: 'B', changelog: '', channel: 'release', modrinthProjectId: '', curseForgeProjectId: '', githubRepository: 'owner/B' })
    current = a
    vi.spyOn(service, 'preflight').mockImplementation(async project => { expect(project?.path).toBe(a.path); current = b; return { ready: true, artifactPath: path.join(a.path, 'A.jar'), checks: [] } })
    await fs.writeFile(path.join(a.path, 'A.jar'), 'fixture')
    const requests: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body })
      return new Response(JSON.stringify({ upload_url: 'https://uploads.example.test/A', html_url: 'https://example.test/A' }), { status: 200 })
    })
    try {
      expect((await service.publish({ confirmed: true, targets: ['github'] }))[0].success).toBe(true)
      expect(requests[0].url).toContain('owner/A')
      expect(JSON.parse(String(requests[0].body)).tag_name).toBe('v1.0.0')
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })
  it('finds a release artifact and never publishes without explicit confirmation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-'))
    roots.push(root)
    const project: ProjectInfo = { name: 'Release Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'release_test', createdAt: '' }
    let secrets: ReleaseSecrets = { modrinthToken: '', curseForgeToken: '', githubToken: '' }
    const service = new ReleaseService(() => project, async () => secrets, async (next) => { secrets = next })
    await fs.mkdir(path.join(root, 'build', 'libs'), { recursive: true })
    await fs.mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), '{}', 'utf8')
    await fs.writeFile(path.join(root, 'LICENSE'), 'MIT', 'utf8')
    const artifactBytes = createStoredZip([
      { name: 'fabric.mod.json', data: Buffer.from('{}', 'utf8') },
      { name: 'release/Test.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
      { name: 'release/payload.bin', data: Buffer.alloc(2_048, 1) }
    ])
    await fs.writeFile(path.join(root, 'build', 'libs', 'release-test-1.0.0.jar'), artifactBytes)
    await service.saveSettings({
      version: '1.0.0', displayName: 'Release Test 1.0.0', changelog: 'Initial release', channel: 'release',
      modrinthProjectId: '', curseForgeProjectId: '', githubRepository: ''
    })

    await expect(service.preflight()).resolves.toMatchObject({ ready: true, artifactSize: artifactBytes.length })
    await expect(service.publish({ targets: ['github'], confirmed: false })).rejects.toThrow(/明确确认/)
  })

  it('keeps encrypted token values when the settings form submits an empty token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-'))
    roots.push(root)
    const project: ProjectInfo = { name: 'Release Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'release_test', createdAt: '' }
    let secrets: ReleaseSecrets = { modrinthToken: 'stored-token', curseForgeToken: '', githubToken: '' }
    const service = new ReleaseService(() => project, async () => secrets, async (next) => { secrets = next })
    const saved = await service.saveSettings({
      version: '1.0.0', displayName: 'Release Test', changelog: '', channel: 'release',
      modrinthProjectId: 'project', curseForgeProjectId: '', githubRepository: '', modrinthToken: ''
    })
    expect(secrets.modrinthToken).toBe('stored-token')
    expect(saved).toMatchObject({ hasModrinthToken: true })
    expect(saved.modrinthToken).toBeUndefined()
  })

  it('writes the Mod version before export and advances only after a successful export marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-version-'))
    roots.push(root)
    const project: ProjectInfo = { name: 'Versioned Mod', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'versioned_mod', createdAt: '' }
    const service = new ReleaseService(() => project, async () => ({ modrinthToken: '', curseForgeToken: '', githubToken: '' }), async () => undefined)
    await fs.writeFile(path.join(root, 'gradle.properties'), 'mod_version=1.4.2\n', 'utf8')
    await service.saveSettings({ version: '1.4.2', displayName: 'Versioned Mod 1.4.2', changelog: '', channel: 'release', autoBump: true, bumpMode: 'minor', modrinthProjectId: '', curseForgeProjectId: '', githubRepository: '' })

    await service.prepareExport()
    await expect(fs.readFile(path.join(root, 'gradle.properties'), 'utf8')).resolves.toContain('mod_version=1.4.2')
    await expect(service.markExported()).resolves.toMatchObject({ version: '1.5.0', displayName: 'Versioned Mod 1.5.0' })
  })

  it('rejects a large non-JAR artifact during release preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-invalid-'))
    roots.push(root)
    const project: ProjectInfo = { name: 'Invalid Release', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'invalid_release', createdAt: '' }
    const service = new ReleaseService(() => project, async () => ({ modrinthToken: '', curseForgeToken: '', githubToken: '' }), async () => undefined)
    await fs.mkdir(path.join(root, 'build', 'libs'), { recursive: true })
    await fs.mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), '{}', 'utf8')
    await fs.writeFile(path.join(root, 'build', 'libs', 'invalid.jar'), Buffer.alloc(2_048, 1))
    await expect(service.preflight()).resolves.toMatchObject({ ready: false })
  })

  it('creates a Modrinth artifact for a modpack release preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-release-'))
    roots.push(root)
    const project: ProjectInfo = { kind: 'modpack', name: 'Pack Release', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'pack_release', createdAt: '' }
    const service = new ReleaseService(() => project, async () => ({ modrinthToken: '', curseForgeToken: '', githubToken: '' }), async () => undefined)
    const source = path.join(root, 'example.jar')
    await fs.writeFile(source, Buffer.alloc(2_048, 7))
    await createModpackTemplate(project)
    await addModpackFiles(project, [source])
    await service.saveSettings({
      version: '1.0.0', displayName: 'Pack Release 1.0.0', changelog: 'Initial pack release', channel: 'release',
      modrinthProjectId: '', curseForgeProjectId: '', githubRepository: ''
    })

    const result = await service.preflight()
    expect(result).toMatchObject({ ready: true, artifactPath: expect.stringMatching(/pack_release-1\.0\.0\.mrpack$/) })
    await expect(fs.stat(result.artifactPath!)).resolves.toMatchObject({ size: expect.any(Number) })
  })
})
