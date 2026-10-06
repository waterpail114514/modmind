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

afterEach(() => vi.restoreAllMocks())

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
