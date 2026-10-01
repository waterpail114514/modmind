import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'
import { configureNativeFeatureServices } from './nativeFeatureServices'
import { runSoundFfmpeg } from '../../feature-plugins/sound-studio/src/main/soundFiles'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
it('loads media conversion exclusively from a verified optional package and enforces dependent lifecycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-media-')); roots.push(root)
  const service = new FeaturePluginService(root, { requireFrom: path.resolve('package.json'), capabilities: { runtime: {} }, options: () => ({}), busy: () => false, changed: () => undefined })
  await service.initialize()
  configureNativeFeatureServices(id => service.service(id))
  await service.install(await prepareFeaturePlugin(path.resolve('feature-plugin-dist/sound-studio.mmfeature')))
  expect(service.catalog().find(entry => entry.id === 'sound-studio')?.state).toBe('dependency-missing')
  await expect(runSoundFfmpeg(['-version'])).rejects.toThrow('未启用')
  await service.install(await prepareFeaturePlugin(path.resolve('feature-plugin-dist/media-runtime.mmfeature')))
  expect(service.catalog().find(entry => entry.id === 'sound-studio')?.state).toBe('ready')
  const runtime = service.service<{ executable: () => string }>('media-runtime')
  const binary = runtime.executable()
  expect(path.relative(root, binary).replaceAll('\\', '/')).toMatch(/^media-runtime\/assets\/native\/ffmpeg/)
  expect((await promisify(execFile)(binary, ['-version'], { windowsHide: true })).stdout).toContain('ffmpeg version')
  const output = path.join(root, 'sample.ogg')
  await runSoundFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-c:a', 'libvorbis', output])
  expect((await fs.readFile(output)).subarray(0, 4).toString()).toBe('OggS')
  await expect(service.setEnabled('media-runtime', false)).rejects.toThrow('先停用')
  await service.setEnabled('sound-studio', false)
  await service.setEnabled('media-runtime', false)
  await expect(runSoundFfmpeg(['-version'])).rejects.toThrow('未启用')
  await service.setEnabled('media-runtime', true)
  const active = service.service<{ executable: () => string }>('media-runtime')
  active.executable()
  await fs.appendFile(binary, 'tampered')
  expect(() => active.executable()).toThrow('校验失败')
  await service.shutdown()
}, 30000)
