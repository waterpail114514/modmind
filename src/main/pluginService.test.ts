import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from './pluginService'
import { createPluginPanelHtml } from '../shared/pluginUi'

vi.mock('./bedrockAddon', () => ({
  createStoredZip: (entries: Array<{ name: string; data: Buffer }>) => Buffer.concat(entries.map((e) => e.data))
}))

const roots: string[] = []

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plugin-service-'))
  roots.push(root)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function writePlugin(globalDir: string, id: string, manifest: Record<string, unknown>, extraFiles: Record<string, string> = {}): Promise<string> {
  const directory = path.join(globalDir, id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(directory, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return directory
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    description: 'demo plugin',
    permissions: ['project.read'],
    panel: { entry: 'panel/index.html' },
    ...overrides
  }
}

describe('PluginService', () => {
  it('loads overlay-only plugins and validates their entry', async () => {
    const globalDir = roots[roots.length - 1]
    await writePlugin(globalDir, 'desktop-pet', validManifest({
      id: 'desktop-pet',
      panel: undefined,
      overlay: { entry: 'overlay/index.html', mode: 'pet', width: 220, height: 260, alwaysOnTop: true }
    }), { 'overlay/index.html': '<html></html>' })
    await writePlugin(globalDir, 'broken-overlay', validManifest({
      id: 'broken-overlay',
      panel: undefined,
      overlay: { entry: 'overlay/missing.html' }
    }))

    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const snapshot = await service.refresh()
    expect(snapshot.plugins.find((plugin) => plugin.manifest.id === 'desktop-pet')?.manifest.overlay).toMatchObject({ mode: 'pet', width: 220, height: 260 })
    expect(snapshot.plugins.find((plugin) => plugin.manifest.id === 'broken-overlay')?.error).toContain('overlay.entry')
  })

  it('scans global and project scopes with project precedence', async () => {
    const globalDir = roots[roots.length - 1]
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plugin-project-'))
    roots.push(projectRoot)

    await writePlugin(globalDir, 'shared', validManifest({ id: 'shared', name: 'GlobalVersion' }), { 'panel/index.html': '<html></html>' })
    await writePlugin(path.join(projectRoot, '.modmind', 'plugins'), 'shared', validManifest({ id: 'shared', name: 'ProjectVersion' }), { 'panel/index.html': '<html></html>' })
    await writePlugin(globalDir, 'global-only', validManifest({ id: 'global-only', name: 'Only Global' }), { 'panel/index.html': '<html></html>' })

    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => projectRoot })
    const snapshot = await service.refresh()

    const shared = snapshot.plugins.find((p) => p.manifest.id === 'shared')
    expect(shared?.scope).toBe('project')
    expect(shared?.manifest.name).toBe('ProjectVersion')
    expect(snapshot.plugins.find((p) => p.manifest.id === 'global-only')?.scope).toBe('global')
    expect(service.getEnabledPlugin('shared')).toBeTruthy()
  })

  it('reuses the persisted registry when plugin metadata is unchanged', async () => {
    const globalDir = roots[roots.length - 1]
    const manifestPath = path.join(globalDir, 'cached-plugin', 'plugin.json')
    await writePlugin(globalDir, 'cached-plugin', validManifest({ id: 'cached-plugin', name: 'Cached Plugin' }), { 'panel/index.html': '<html></html>' })

    const first = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await first.refresh()
    const originalReadFile = fs.readFile.bind(fs)
    let manifestReads = 0
    const readFile = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(manifestPath)) manifestReads += 1
      return originalReadFile(...args as Parameters<typeof fs.readFile>)
    }) as typeof fs.readFile)

    const restarted = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const snapshot = await restarted.refresh()

    expect(snapshot.plugins[0]?.manifest.name).toBe('Cached Plugin')
    expect(manifestReads).toBe(0)
    expect(await fs.stat(path.join(path.dirname(globalDir), 'plugin-registry-cache.json')).then((stat) => stat.isFile())).toBe(true)
    readFile.mockRestore()

    await fs.writeFile(manifestPath, JSON.stringify(validManifest({ id: 'cached-plugin', name: 'Cached Plugin Updated' })), 'utf8')
    const changed = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const changedSnapshot = await changed.refresh()
    expect(changedSnapshot.plugins[0]?.manifest.name).toBe('Cached Plugin Updated')
  })

  it('reports broken plugins with errors instead of throwing', async () => {
    const globalDir = roots[roots.length - 1]
    await writePlugin(globalDir, 'broken', { id: 'broken', name: 'x' })
    await writePlugin(globalDir, 'missing-entry', validManifest({ id: 'missing-entry' }))
    // 非 kebab-case 目录应被忽略
    await writePlugin(globalDir, 'Not_Valid', validManifest({ id: 'Not_Valid' }))

    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const snapshot = await service.refresh()

    const broken = snapshot.plugins.find((p) => p.manifest.id === 'broken')
    expect(broken?.error).toBeTruthy()
    expect(broken?.enabled).toBe(false)
    const missingEntry = snapshot.plugins.find((p) => p.manifest.id === 'missing-entry')
    expect(missingEntry?.error).toContain('panel.entry')
    expect(snapshot.plugins.find((p) => p.manifest.id === 'Not_Valid')).toBeUndefined()
    expect(service.getEnabledPlugin('broken')).toBeUndefined()
  })

  it('rejects directory/manifest id mismatch', async () => {
    const globalDir = roots[roots.length - 1]
    await writePlugin(globalDir, 'folder-name', validManifest({ id: 'other-id' }), { 'panel/index.html': '<html></html>' })

    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const snapshot = await service.refresh()
    const record = snapshot.plugins.find((p) => p.directory.endsWith('folder-name'))
    expect(record?.error).toContain('不一致')
  })

  it('toggles enable state and notifies change listeners', async () => {
    const globalDir = roots[roots.length - 1]
    await writePlugin(globalDir, 'toggle-me', validManifest({ id: 'toggle-me' }), { 'panel/index.html': '<html></html>' })

    const onChange = vi.fn()
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null, onChange })
    await service.refresh()

    service.setEnabled('toggle-me', false)
    expect(service.getEnabledPlugin('toggle-me')).toBeUndefined()
    expect(onChange).toHaveBeenCalled()

    service.setEnabled('toggle-me', true)
    expect(service.getEnabledPlugin('toggle-me')).toBeTruthy()
  })

  it('scaffolds a full plugin with panel and backend entries', async () => {
    const globalDir = roots[roots.length - 1]
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await service.refresh()

    const { manifest, directory } = await service.scaffold({
      kind: 'panel-and-tools',
      id: 'my-new-plugin',
      name: 'My New Plugin',
      tools: [{ name: 'greet', description: 'greets someone', inputSchema: { type: 'object', properties: { who: { type: 'string' } } }, annotations: { readOnlyLocal: true } }]
    })

    expect(manifest.id).toBe('my-new-plugin')
    expect(manifest.backend?.tools[0].name).toBe('greet')
    const written = JSON.parse(await fs.readFile(path.join(directory, 'plugin.json'), 'utf8')) as { backend?: { entry?: string } }
    expect(written.backend?.entry).toBe('backend/main.mjs')
    await expect(fs.access(path.join(directory, 'panel', 'index.html'))).resolves.toBeUndefined()
    expect(await fs.readFile(path.join(directory, 'panel', 'index.html'), 'utf8')).toBe(createPluginPanelHtml('My New Plugin'))
    await expect(fs.access(path.join(directory, 'backend', 'main.mjs'))).resolves.toBeUndefined()
    expect(await fs.readFile(path.join(directory, 'backend', 'main.mjs'), 'utf8')).toContain('async "greet"(input)')
    expect(service.getPlugin('my-new-plugin')).toBeTruthy()

    await expect(service.scaffold({ kind: 'panel-only', id: 'my-new-plugin', name: 'dup' })).rejects.toThrow('已存在')
  })

  it('writes files inside the plugin boundary only', async () => {
    const globalDir = roots[roots.length - 1]
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await service.refresh()
    const { directory } = await service.scaffold({ kind: 'tools-only', id: 'writer', name: 'Writer' })

    await service.writePluginFiles('writer', [{ path: 'backend/main.mjs', content: '// updated' }])
    expect(await fs.readFile(path.join(directory, 'backend', 'main.mjs'), 'utf8')).toBe('// updated')

    await expect(service.writePluginFiles('writer', [{ path: '../evil.txt', content: 'no' }])).rejects.toThrow('越界')
    await expect(service.writePluginFiles('unknown', [{ path: 'a.txt', content: 'x' }])).rejects.toThrow('未找到插件')
  })

  it('reads back source files for the workbench editing loop', async () => {
    const globalDir = roots[roots.length - 1]
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await service.refresh()
    await service.scaffold({ kind: 'panel-and-tools', id: 'reader', name: 'Reader' })

    const files = await service.readPluginSource('reader')
    const paths = files.map((f) => f.path).sort()
    expect(paths).toContain('plugin.json')
    expect(paths).toContain('panel/index.html')
    expect(paths).toContain('backend/main.mjs')
    expect(files.find((f) => f.path === 'plugin.json')?.content).toContain('"id": "reader"')
  })

  it('exports a zip containing every plugin file under the id prefix', async () => {
    vi.resetModules()
    const realBedrock = await import('./bedrockAddon').catch(() => null)
    void realBedrock
    const globalDir = roots[roots.length - 1]
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await service.refresh()
    await service.scaffold({ kind: 'panel-only', id: 'exported', name: 'Exported' })

    const destination = path.join(globalDir, '..', 'exported.zip')
    await service.exportZip('exported', destination)
    const zipBytes = await fs.readFile(destination)
    expect(zipBytes.byteLength).toBeGreaterThan(0)
    await fs.rm(destination, { force: true })
  })

  it('imports a folder into the project scope and deletes cleanly', async () => {
    const globalDir = roots[roots.length - 1]
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plugin-import-'))
    roots.push(projectRoot)

    const sourceFolder = path.join(os.tmpdir(), `portable-plugin-${Date.now()}`)
    await writePlugin(path.dirname(sourceFolder), path.basename(sourceFolder), validManifest({ id: path.basename(sourceFolder) }).valueOf() as Record<string, unknown>, { 'panel/index.html': '<html></html>' })
    // writePlugin 以目录名建目录，这里手动修正 id
    const folderName = path.basename(sourceFolder)
    const manifestPath = path.join(sourceFolder, 'plugin.json')
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    parsed.id = folderName
    await fs.writeFile(manifestPath, JSON.stringify(parsed), 'utf8')

    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => projectRoot })
    await service.refresh()

    const imported = await service.importFolder(sourceFolder, 'project')
    expect(imported.id).toBe(folderName)
    expect(await fs.stat(path.join(projectRoot, '.modmind', 'plugins', folderName, 'plugin.json')).then(() => true)).toBe(true)

    await service.deletePlugin(folderName)
    expect(service.getPlugin(folderName)).toBeUndefined()
  })

  it('imports a zip whose plugin.json is at the archive root', async () => {
    const globalDir = roots[roots.length - 1]
    const destination = path.join(globalDir, '..', 'root-plugin.zip')
    const actualBedrock = await vi.importActual<typeof import('./bedrockAddon')>('./bedrockAddon')
    const manifest = validManifest({ id: 'root-plugin' })
    await fs.writeFile(destination, actualBedrock.createStoredZip([
      { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'panel/index.html', data: Buffer.from('<html></html>') }
    ]))
    const service = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await service.refresh()

    const preview = await service.previewZipImport(destination, 'global')
    expect(preview.manifest.id).toBe('root-plugin')
    await service.confirmImport(preview.stagedDirectory, 'global')
    expect(await fs.readFile(path.join(globalDir, 'root-plugin', 'plugin.json'), 'utf8')).toContain('root-plugin')
    await fs.rm(destination, { force: true })
  })

  it('persists disabled state independently from registry cache invalidation', async () => {
    const globalDir = roots[roots.length - 1]
    const directory = await writePlugin(globalDir, 'stay-disabled', validManifest({ id: 'stay-disabled' }), { 'panel/index.html': '<html></html>' })
    const first = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    await first.refresh()
    first.setEnabled('stay-disabled', false)
    await first.refresh()

    await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify(validManifest({ id: 'stay-disabled', version: '0.2.0' })), 'utf8')
    const restarted = new PluginService({ globalDirectory: globalDir, projectRoot: () => null })
    const snapshot = await restarted.refresh()
    expect(snapshot.plugins.find((plugin) => plugin.manifest.id === 'stay-disabled')?.enabled).toBe(false)
  })
})
