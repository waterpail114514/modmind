import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareLoaderApiTestPolicy } from './loaderApiTestPolicy'

describe('loader API test policy', () => {
  let root: string
  let configPath: string
  let mods: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-api-policy-'))
    configPath = path.join(root, '.modmind', 'minecraft-test.json')
    mods = path.join(root, '.modmind', 'minecraft', 'mods')
    await fs.mkdir(mods, { recursive: true })
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('keeps default API installation for existing projects and unrelated options', async () => {
    expect(await prepareLoaderApiTestPolicy(root, 'fabric')).toBe(true)
    await fs.writeFile(configPath, JSON.stringify({ otherOption: false }))
    expect(await prepareLoaderApiTestPolicy(root, 'fabric')).toBe(true)
  })

  it.each(['fabric', 'quilt'] as const)('removes only managed %s API files and supports re-enabling', async (loader) => {
    const api = loader === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'
    const owned = [`modmind-managed-${api}.jar`, `.modmind-${loader}-api-version`]
    const preserved = ['modmind-current-project.jar', `${api}-user-installed.jar`, 'other-mod.jar']
    for (const name of [...owned, ...preserved]) await fs.writeFile(path.join(mods, name), name)
    await fs.writeFile(path.join(root, 'gradle.properties'), 'fabric_api_version=compile-version')
    const settings = JSON.stringify({ managedLoaderApi: false, otherOption: 123 })
    await fs.writeFile(configPath, settings)

    expect(await prepareLoaderApiTestPolicy(root, loader)).toBe(false)
    expect((await fs.readdir(mods)).sort()).toEqual(preserved.sort())
    for (const name of preserved) expect(await fs.readFile(path.join(mods, name), 'utf8')).toBe(name)
    expect(await fs.readFile(configPath, 'utf8')).toBe(settings)
    expect(await fs.readFile(path.join(root, 'gradle.properties'), 'utf8')).toBe('fabric_api_version=compile-version')
    expect(await prepareLoaderApiTestPolicy(root, loader)).toBe(false)

    await fs.writeFile(configPath, JSON.stringify({ managedLoaderApi: true }))
    expect(await prepareLoaderApiTestPolicy(root, loader)).toBe(true)
  })

  it.each(['{', 'null', '[]', 'false', '{"managedLoaderApi":"false"}', '{"managedLoaderApi":null}'])('rejects invalid config %s instead of silently enabling API', async (content) => {
    await fs.writeFile(configPath, content)
    await expect(prepareLoaderApiTestPolicy(root, 'fabric')).rejects.toThrow('managedLoaderApi 必须为布尔值')
  })

  it('can disable installation before the mods directory exists', async () => {
    await fs.rm(mods, { recursive: true })
    await fs.writeFile(configPath, '{"managedLoaderApi":false}')
    expect(await prepareLoaderApiTestPolicy(root, 'fabric')).toBe(false)
  })
})
