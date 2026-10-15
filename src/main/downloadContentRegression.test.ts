import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { McmodHttpClient, McmodService, parseMcmodDownloadHtml } from './mcmodService'
import { httpTransport } from './networkRequest'
import { materializeExternalModpack, type ExternalModpackInspection } from './modpackImportService'
import { createModpackTemplate, readModpackManifest, addModpackModule, syncModpackOverrides, createModrinthPackArchive } from './modpackService'
import { downloadModpackContent, importModpackContent, readManagedModpackContent } from './modpackContentInventoryService'
import { installContentTransaction } from './contentInstallTransaction'
import { archiveEntries } from './ftbResourceArchive'

const roots: string[] = []
const servers: http.Server[] = []
const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex')
async function fixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-content-regression-')); roots.push(root)
  const project: ProjectInfo = { path: path.join(root, 'pack'), name: 'Audit', namespace: 'audit', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1', loaderVersion: '0.15.11', createdAt: '' }
  await fs.mkdir(project.path)
  await createModpackTemplate(project)
  return project
}
async function transport(bytes: Buffer, status = 200): Promise<void> {
  const server = http.createServer((_request, response) => { response.writeHead(status, { 'content-length': bytes.length }); response.end(bytes) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const original = httpTransport.request
  vi.spyOn(httpTransport, 'request').mockImplementation((_url, options) => original(url, options))
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('download content transaction regressions', () => {
  it.each([false, true])('cancels content transport and preserves existing files (archive=%s)', async extract => {
    const project = await fixture(), controller = new AbortController()
    const relative = extract ? 'saves/world' : 'config/a.txt'
    const target = path.join(project.path, 'overrides', relative)
    if (extract) { await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'level.dat'), 'OLD') }
    else await fs.writeFile(target, 'OLD')
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-length': 4096 }); response.write(Buffer.alloc(2048, 1))
      setTimeout(() => controller.abort(), 20)
    }); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const original = httpTransport.request
    vi.spyOn(httpTransport, 'request').mockImplementation((_url, options) => original(`http://127.0.0.1:${(server.address() as { port: number }).port}`, options))
    await expect(downloadModpackContent(project, { kind: extract ? 'worlds' : 'config', url: 'https://fixture.test/a.zip', targetPath: relative, extract }, controller.signal)).rejects.toThrow()
    expect(controller.signal.aborted).toBe(true)
    expect(await fs.readFile(extract ? path.join(target, 'level.dat') : target, 'utf8')).toBe('OLD')
  })
  it.each(['HTTP 404', 'cancel'])('keeps an existing MC百科 target when download fails: %s', async failure => {
    const project = await fixture()
    const target = path.join(project.path, 'mods/same.jar')
    const old = Buffer.alloc(2048, 1)
    await fs.writeFile(target, old)
    const manifest = await fs.readFile(path.join(project.path, 'modmind.pack.json'), 'utf8')
    await transport(Buffer.from('missing'), 404)
    const html = `<script>var file_token = 'audit-token';</script><table><tr data-id="1" data-version="1.20.1" data-md5="${'a'.repeat(32)}" data-sha256="${'b'.repeat(64)}" data-filename="same" data-suffix="jar"><td>same.jar</td></tr></table>`
    const fetcher = (async (url: string | URL | Request) => String(url).includes('/action/doDownload/')
      ? Response.json({ state: 0, url: 'https://fixture.test/same.jar' })
      : String(url).includes('/DownloadCaptcha/') ? new Response('fixed-image') : new Response(html)) as typeof fetch
    const service = new McmodService(new McmodHttpClient(fetcher))
    const file = parseMcmodDownloadHtml('1', html).files[0]
    const challenge = await service.beginDownload(project, '1', file.fileKey)
    const controller = new AbortController()
    if (failure === 'cancel') controller.abort()
    await expect(service.submitCaptcha(project, challenge.sessionId, 'TEST', controller.signal)).rejects.toThrow()
    expect(await fs.readFile(target)).toEqual(old)
    expect(await fs.readFile(path.join(project.path, 'modmind.pack.json'), 'utf8')).toBe(manifest)
  })

  it('honors a pre-cancelled MRPack before any remote transfer or write', async () => {
    const project = await fixture()
    const bytes = Buffer.alloc(2048, 2)
    await transport(bytes)
    const controller = new AbortController(); controller.abort()
    const inspection: ExternalModpackInspection = { root: project.path, format: 'modrinth', layout: 'instance', localModFiles: [], overrideFiles: [], warnings: [], unresolvedDependencyCount: 0, remoteFiles: [{ path: 'mods/a.jar', downloads: ['https://fixture.test/a.jar'], hashes: { sha1: sha1(bytes) } }] }
    await expect(materializeExternalModpack(inspection, project.path, { signal: controller.signal })).rejects.toThrow()
    expect(httpTransport.request).not.toHaveBeenCalled()
    await expect(fs.access(path.join(project.path, 'mods/a.jar'))).rejects.toThrow()
  })

  it('rolls back an in-place MRPack replacement if destination promotion fails', async () => {
    const project = await fixture()
    const target = path.join(project.path, 'mods/a.jar'), bytes = Buffer.alloc(2048, 2), old = Buffer.alloc(2048, 1)
    await fs.writeFile(target, old)
    await transport(bytes)
    const originalRename = fs.rename.bind(fs)
    let injected = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from).startsWith(`${target}.pending-`) && String(to) === target) { injected = true; throw Object.assign(new Error('promotion EACCES'), { code: 'EACCES' }) }
      return originalRename(from, to)
    })
    const inspection: ExternalModpackInspection = { root: project.path, format: 'modrinth', layout: 'instance', localModFiles: [], overrideFiles: [], warnings: [], unresolvedDependencyCount: 0, remoteFiles: [{ path: 'mods/a.jar', downloads: ['https://fixture.test/a.jar'], hashes: { sha1: sha1(bytes) } }] }
    await expect(materializeExternalModpack(inspection, project.path)).rejects.toThrow('promotion EACCES')
    expect(injected).toBe(true)
    expect(await fs.readFile(target)).toEqual(old)
    expect((await fs.readdir(path.dirname(target))).filter(file => file.includes('.backup-'))).toEqual([])
  })

  it('retains recovery bytes if even rollback fails', async () => {
    const project = await fixture(), target = path.join(project.path, 'overrides/config/a.txt'), source = path.join(project.path, 'new.txt')
    await fs.writeFile(target, 'OLD'); await fs.writeFile(source, 'NEW')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).startsWith(`${target}.backup-`)) throw new Error('restore EACCES')
      return rename(from, to)
    })
    await expect(installContentTransaction(project.path, [{ source, destination: target }], async () => { throw new Error('manifest ENOSPC') })).rejects.toThrow('备份保留')
    const backups = (await fs.readdir(path.dirname(target))).filter(file => file.startsWith('a.txt.backup-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(target), backups[0]), 'utf8')).toBe('OLD')
  })

  it('does not start a content download when its saved inventory is corrupt', async () => {
    const project = await fixture(), target = path.join(project.path, 'overrides/config/a.txt')
    await fs.writeFile(target, 'OLD')
    await fs.writeFile(path.join(project.path, 'modmind.pack-content.json'), '{broken')
    await transport(Buffer.from('NEW'))
    await expect(downloadModpackContent(project, { kind: 'config', targetPath: 'config/a.txt', url: 'https://fixture.test/a.txt' })).rejects.toThrow()
    expect(await fs.readFile(target, 'utf8')).toBe('OLD')
    expect(httpTransport.request).not.toHaveBeenCalled()
  })

  it('restores old content when inventory publication fails', async () => {
    const project = await fixture(), target = path.join(project.path, 'overrides/config/a.txt')
    await fs.writeFile(target, 'OLD'); await transport(Buffer.from('NEW'))
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(project.path, 'modmind.pack-content.json')) throw new Error('inventory ENOSPC')
      return rename(from, to)
    })
    await expect(downloadModpackContent(project, { kind: 'config', targetPath: 'config/a.txt', url: 'https://fixture.test/a.txt' })).rejects.toThrow('inventory ENOSPC')
    expect(await fs.readFile(target, 'utf8')).toBe('OLD')
  })

  it('records each imported directory size independently', async () => {
    const project = await fixture(), base = path.dirname(project.path)
    const sources = ['one', 'two'].map(name => path.join(base, name))
    for (const [index, source] of sources.entries()) { await fs.mkdir(source); await fs.writeFile(path.join(source, 'level.dat'), Buffer.alloc(10 * (index + 1))) }
    const result = await importModpackContent(project, 'worlds', sources)
    expect(result.items.map(item => item.size)).toEqual([10, 20])
  })

  it('accepts directory totals above 512 MiB while keeping the 2 GiB directory budget', async () => {
    const project = await fixture(), source = path.join(path.dirname(project.path), 'world')
    await fs.mkdir(source); await fs.writeFile(path.join(source, 'level.dat'), 'small'); await fs.writeFile(path.join(source, 'region.mca'), 'small')
    const stat = fs.stat.bind(fs)
    vi.spyOn(fs, 'stat').mockImplementation(async (file, ...options) => {
      const result = await (stat as (...args: unknown[]) => Promise<import('node:fs').Stats>)(file, ...options)
      if (String(file).startsWith(`${source}${path.sep}`) && result.isFile()) Object.defineProperty(result, 'size', { value: 300 * 1024 * 1024 })
      return result as never
    })
    const result = await importModpackContent(project, 'worlds', [source])
    expect(result.items[0].size).toBe(600 * 1024 * 1024)
    expect((await readManagedModpackContent(project)).items[0].size).toBe(600 * 1024 * 1024)
  })

  it('keeps both updates when module imports modify the same pack concurrently', async () => {
    const project = await fixture()
    await Promise.all(['one', 'two'].map(namespace => addModpackModule(project, { name: namespace, namespace, path: `modules/${namespace}`, createdAt: '', linked: false })))
    expect((await readModpackManifest(project)).modules.map(item => item.namespace).sort()).toEqual(['one', 'two'])
  })

  it('keeps common, client and server overrides separate through import, sync and export', async () => {
    const project = await fixture(), source = path.join(path.dirname(project.path), 'source')
    for (const layer of ['overrides', 'client-overrides', 'server-overrides']) {
      await fs.mkdir(path.join(source, layer, 'config'), { recursive: true })
      await fs.writeFile(path.join(source, layer, 'config/a.txt'), layer)
    }
    const inspection: ExternalModpackInspection = { root: source, format: 'modrinth', layout: 'archive', localModFiles: [], overrideFiles: [], warnings: [], unresolvedDependencyCount: 0, remoteFiles: [] }
    await materializeExternalModpack(inspection, project.path)
    expect(await fs.readFile(path.join(project.path, 'overrides/config/a.txt'), 'utf8')).toBe('overrides')
    for (const side of ['client', 'server'] as const) {
      const destination = path.join(path.dirname(project.path), side)
      await syncModpackOverrides(project, destination, [], side)
      expect(await fs.readFile(path.join(destination, 'config/a.txt'), 'utf8')).toBe(`${side}-overrides`)
    }
    const archive = path.join(project.path, 'export.mrpack'); await fs.writeFile(archive, await createModrinthPackArchive(project))
    expect(await archiveEntries(archive)).toEqual(expect.arrayContaining(['overrides/config/a.txt', 'client-overrides/config/a.txt', 'server-overrides/config/a.txt']))
  })
})
