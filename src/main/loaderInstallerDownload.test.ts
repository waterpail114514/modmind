import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Version } from '@xmcl/core'
import { createStoredZip } from './bedrockAddon'
import { loaderLibraryHost, prepareLoaderInstaller } from './loaderInstallerDownload'
import { httpTransport } from './networkRequest'
import { forgeInstallerUrl, forgeInstallerVersion } from './forgeInstallerVersion'

afterEach(() => vi.restoreAllMocks())

it.each([
  ['1.8.8', '1.8.8-11.15.0.1655'],
  ['1.8', '1.8-11.14.4.1577'],
  ['1.7.2', '1.7.2-10.12.2.1161-mc172']
])('downloads the catalog-selected %s Forge installer without SDK-invented suffixes', async (minecraftVersion, artifact) => {
  const bytes = createStoredZip([{ name: 'install_profile.json', data: Buffer.from('{}') }, { name: 'Installer.class', data: Buffer.from('class fixture') }])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-exact-forge-')), requested: string[] = []
  const server = createServer((req, res) => { res.end(req.url!.endsWith('.sha1') ? createHash('sha1').update(bytes).digest('hex') : bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = httpTransport.request
  const mock = vi.spyOn(httpTransport, 'request').mockImplementation((url, options) => {
    requested.push(url)
    return transport(`http://127.0.0.1:${(server.address() as { port: number }).port}${new URL(url).pathname}`, options)
  })
  try {
    const options = { loader: 'forge' as const, minecraftVersion, version: forgeInstallerVersion(minecraftVersion, artifact), installerUrl: forgeInstallerUrl(minecraftVersion, artifact), resourceRoot: root }
    await prepareLoaderInstaller(options)
    expect(requested.filter(url => url.endsWith('.jar'))).toEqual([`https://maven.minecraftforge.net/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`])
    mock.mockImplementation(async () => { throw new Error('offline') })
    await expect(prepareLoaderInstaller(options)).resolves.toBeUndefined()
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('omits Maven Central for NeoForge while retaining it for ordinary dependencies', () => {
  const resolve = loaderLibraryHost(['https://bmclapi2.bangbang93.com/maven', 'https://maven.neoforged.net/releases'])
  const library = Version.resolveLibrary({ name: 'net.neoforged:neoforge:21.1.244:installer', downloads: { artifact: { path: 'net/neoforged/neoforge/21.1.244/neoforge-21.1.244-installer.jar', url: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.244/neoforge-21.1.244-installer.jar', sha1: '', size: 0 } } })
  expect(resolve(library!)).toHaveLength(2)
  expect(resolve(Version.resolveLibrary({ name: 'org.example:library:1.0' })!)).toContain('https://repo1.maven.org/maven2/org/example/library/1.0/library-1.0.jar')
})

it('downloads a verified installer through the common transport and reuses it offline', async () => {
  const bytes = createStoredZip([{ name: 'install_profile.json', data: Buffer.from('{}') }, { name: 'Installer.class', data: Buffer.from('class fixture') }])
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url!)
    if (req.url!.endsWith('.sha1')) res.end(createHash('sha1').update(bytes).digest('hex'))
    else if (req.url!.startsWith('/mirror')) res.end('<html>blocked</html>'.repeat(100))
    else res.end(bytes)
  })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-loader-prepare-'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = httpTransport.request
  const mock = vi.spyOn(httpTransport, 'request').mockImplementation((url, options) => transport(`http://127.0.0.1:${(server.address() as { port: number }).port}/${url.includes('bmclapi') ? 'mirror' : 'official'}/${path.basename(new URL(url).pathname)}`, options))
  try {
    const options = { loader: 'neoforge' as const, minecraftVersion: '1.21.1', version: '21.1.244', resourceRoot: root }
    await prepareLoaderInstaller(options)
    const file = path.join(root, 'libraries/net/neoforged/neoforge/21.1.244/neoforge-21.1.244-installer.jar')
    expect(await fs.readFile(file)).toEqual(bytes)
    expect(requests.filter(url => url.startsWith('/mirror'))).toHaveLength(2)
    mock.mockImplementation(async () => { throw new Error('offline') })
    await expect(prepareLoaderInstaller(options)).resolves.toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
