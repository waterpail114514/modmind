import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:net'
import type { ProjectInfo } from '../../../../src/shared/types'
import { shaderRuntimeFixture } from '../../../../src/main/__fixtures__/shaderRuntimeFixture'
import { shaderTemplateFiles } from '../../../studio-shader/src/main/shaderTemplates'
import { ShaderSessionService, type ShaderSessionDependencies } from './shaderSessionService'
import { saveRuntimeBinding, shaderRuntimeCapabilities, shaderModClosure, installedShaderMods, shaderInstalledVersion } from './shaderRuntimeEnvironment'
import { ShaderSessionAgentClient } from './shaderSessionAgentClient'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
async function fixture(overrides: Partial<ShaderSessionDependencies> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-shader-session-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const runtime = await shaderRuntimeFixture(root)
  let current: ProjectInfo = { path: path.join(root, 'project'), name: 'JVM fixture', kind: 'shader', loader: 'iris', studioId: 'minecraft-shader', minecraftVersion: '26.2', namespace: 'fixture', createdAt: '' }
  await fs.mkdir(current.path)
  for (const [name, data] of Object.entries(shaderTemplateFiles(current))) { const file = path.join(current.path, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data) }
  const bindingDirectory = path.join(root, 'application-bindings')
  await saveRuntimeBinding(bindingDirectory, current, runtime)
  // Java major is a capability fixture; the real JVM runs only the release-17 test classes, never Minecraft.
  const javaHomes = async () => [{ home: runtime.javaHome, major: 25 }]
  const service = new ShaderSessionService({ currentProject: () => current, bindingDirectory, javaHomes, startupTimeoutMs: 10000, shutdownTimeoutMs: 3000, ...overrides })
  cleanup.push(() => service.dispose())
  return { root, runtime, current, service, bindingDirectory, javaHomes, switchProject: () => { current = { ...current, path: path.join(root, 'other') } } }
}
async function ready(service: ShaderSessionService, project: ProjectInfo, id: string) {
  for (let i = 0; i < 150; i++) { const state = service.state(project, id)!; if (state.status === 'ready' || state.status === 'failed' || state.status === 'stopped') return state; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('JVM fixture did not become ready')
}

it('launches an isolated owned JVM through XMCL, reads actual agent state, reloads a changed artifact and exits gracefully', async () => {
  const f = await fixture(), capabilities = await f.service.capabilities(f.current)
  expect(capabilities).toMatchObject({ supported: true, ready: true, runtimeVerified: false, versions: [{ id: f.runtime.versionId }] })
  const started = f.service.start(f.current, f.runtime.versionId)
  expect(started.status).toBe('preparing')
  expect(() => f.service.start(f.current, f.runtime.versionId)).toThrow('已有')
  const running = await ready(f.service, f.current, started.sessionId)
  expect(running, JSON.stringify(running)).toMatchObject({ status: 'ready', observation: { effectiveOptions: { TAA: 'true' }, profile: 'jvm-fixture' }, gameVerified: false })
  expect(running.observation?.packName).toBe(running.artifact?.name)
  expect(await fs.readdir(path.join(running.directory, 'mods'))).toEqual(['iris.jar', 'sodium.jar'])
  expect(await fs.readFile(path.join(f.runtime.instancePath, 'options.txt'), 'utf8')).toBe('PLAYER OPTIONS MUST NOT CHANGE')
  expect(await fs.stat(path.join(running.directory, 'saves')).catch(() => null)).toBeNull()
  await fs.appendFile(path.join(f.current.path, 'shaders/final.fsh'), '\n// reload fixture\n')
  const reloaded = await f.service.observe(f.current, started.sessionId, true)
  expect(reloaded.artifact?.sha256).not.toBe(running.artifact?.sha256)
  expect(reloaded.observation?.packName).toBe(reloaded.artifact?.name)
  expect(reloaded.gameVerified).toBe(false)
  const stopped = await f.service.stop(f.current, started.sessionId)
  expect(stopped).toMatchObject({ status: 'stopped', shutdown: 'graceful' })
  expect(f.service.isBusy()).toBe(false)
  await expect(f.service.observe(f.current, '0'.repeat(36))).rejects.toThrow('过期')
}, 30000)

it('cancels preparation, rejects project-controlled bindings and reports missing/unsupported environments', async () => {
  const f = await fixture()
  const started = f.service.start(f.current, f.runtime.versionId)
  expect(await f.service.stop(f.current, started.sessionId)).toMatchObject({ status: 'stopped', shutdown: 'not-started' })
  expect(f.service.isBusy()).toBe(false)
  const unsupported = await shaderRuntimeCapabilities({ ...f.current, minecraftVersion: '1.21.1' }, null, f.javaHomes)
  expect(unsupported).toMatchObject({ ready: false, supported: false })
  const missingJava = await shaderRuntimeCapabilities(f.current, f.runtime, async () => [{ home: f.runtime.javaHome, major: 22 }])
  expect(missingJava.ready).toBe(false); expect(missingJava.issues.join(' ')).toContain('Java 25')
  const unrelated = new ShaderSessionService({ currentProject: () => f.current, bindingDirectory: path.join(f.root, 'unbound'), javaHomes: f.javaHomes })
  cleanup.push(() => unrelated.dispose())
  const rejected = unrelated.start(f.current, f.runtime.versionId)
  expect(await ready(unrelated, f.current, rejected.sessionId)).toMatchObject({ status: 'failed', shutdown: 'not-started' })
  expect(() => f.service.state({ ...f.current, path: path.join(f.root, 'wrong') })).toThrow('当前项目')
}, 30000)

it('cleans up only the signal-owning session and stops for project changes', async () => {
  const f = await fixture(), owner = new AbortController()
  const first = f.service.start(f.current, f.runtime.versionId, owner.signal)
  expect((await ready(f.service, f.current, first.sessionId)).status).toBe('ready')
  await f.service.stopForSignal(new AbortController().signal)
  expect(f.service.isBusy()).toBe(true)
  await f.service.stopForSignal(owner.signal)
  expect(f.service.state(f.current, first.sessionId)?.shutdown).toBe('graceful')
  const second = f.service.start(f.current, f.runtime.versionId)
  expect((await ready(f.service, f.current, second.sessionId)).status).toBe('ready')
  await f.service.projectChanged(path.join(f.root, 'other'))
  expect(f.service.isBusy()).toBe(false)
}, 30000)

it('copies only the Iris dependency closure and rejects missing/duplicate dependencies', async () => {
  const f = await fixture(), mods = await installedShaderMods(f.runtime.instancePath)
  expect(shaderModClosure(mods).map(mod => mod.id)).toEqual(['iris', 'sodium'])
  expect(() => shaderModClosure(mods.filter(mod => mod.id !== 'sodium'))).toThrow('依赖 sodium')
  expect(() => shaderModClosure([...mods, mods.find(mod => mod.id === 'iris')!])).toThrow('多个版本')
}, 15000)

it('reports forced recovery when the owned client cannot acknowledge normal shutdown', async () => {
  const f = await fixture({ shutdownTimeoutMs: 50, client: (...args) => { const client = new ShaderSessionAgentClient(...args); client.stop = async () => { throw new Error('fixture stop unavailable') }; return client } })
  const started = f.service.start(f.current, f.runtime.versionId)
  expect((await ready(f.service, f.current, started.sessionId)).status).toBe('ready')
  const stopped = await f.service.stop(f.current, started.sessionId)
  expect(stopped).toMatchObject({ status: 'stopped', running: false, shutdown: 'forced', gameVerified: false })
  expect(f.service.isBusy()).toBe(false)
}, 20000)

it('refuses a control endpoint whose claimed PID/session does not match ownership', async () => {
  const server = createServer(socket => socket.on('data', bytes => {
    const id = bytes.toString().split('\t')[0]
    socket.end(`${id}\tok\t${Buffer.from('{"protocol":1,"sessionId":"wrong","pid":123}').toString('base64')}\n`)
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }
  const client = new ShaderSessionAgentClient(address.port, 123, 'expected', 'token', () => true)
  await expect(client.verify()).rejects.toThrow('身份不匹配')
})

it('rejects runtime inheritance escapes, injected launch parameters and missing asset objects', async () => {
  const f = await fixture(), config = path.join(f.runtime.runtimeRoot, `versions/${f.runtime.versionId}/${f.runtime.versionId}.json`)
  const original = JSON.parse(await fs.readFile(config, 'utf8'))
  await fs.writeFile(config, JSON.stringify({ ...original, inheritsFrom: '../escape' }))
  await expect(shaderInstalledVersion(f.runtime.runtimeRoot, f.runtime.versionId)).rejects.toThrow('越界')
  await fs.writeFile(config, JSON.stringify({ ...original, arguments: { jvm: ['-javaagent:/outside/agent.jar'] } }))
  await expect(shaderInstalledVersion(f.runtime.runtimeRoot, f.runtime.versionId)).rejects.toThrow('额外执行参数')
  await fs.writeFile(config, JSON.stringify(original))
  await fs.writeFile(path.join(f.runtime.runtimeRoot, 'assets/indexes/fixture.json'), JSON.stringify({ objects: { missing: { hash: 'a'.repeat(40), size: 100 } } }))
  await expect(shaderInstalledVersion(f.runtime.runtimeRoot, f.runtime.versionId)).rejects.toThrow()
  expect((await f.service.capabilities(f.current)).ready).toBe(false)
}, 15000)
