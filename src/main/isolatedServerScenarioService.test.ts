import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { IsolatedServerScenarioService, observeLoadedMods } from './isolatedServerScenarioService'
import { ServerFixtureService, fixtureJarHash } from './serverFixtureService'
import { createStoredZip } from './bedrockAddon'
import { ServerProcess } from './serverVerificationService'
import type { ProjectInfo } from '../shared/types'
const roots: string[] = []
const services: IsolatedServerScenarioService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const serverCode = `const net=require('net'),fs=require('fs');fs.mkdirSync('world',{recursive:true});const port=Number(process.argv[1]);const server=net.createServer(s=>s.end()).listen(port,'127.0.0.1',()=>{console.log(' - fixture 1.0.0');console.log('Done (0.1s)!');});let pending='';process.stdin.on('data',chunk=>{pending+=chunk;const lines=pending.split(/\\r?\\n/);pending=lines.pop();for(const command of lines){if(command==='stop'){server.close(()=>process.exit(0));}else if(command==='set'){fs.writeFileSync('world/state','persistent');console.log('state saved');}else if(command==='check'){console.log('state '+fs.readFileSync('world/state','utf8'));}else if(command==='fresh'){console.log(fs.existsSync('world/state')?'dirty world':'fresh world');}else if(command==='fail'){console.log('ERROR scenario failed');}else if(command==='hang'){}else console.log(command);}});`
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-isolated-server-')); roots.push(root)
  const project: ProjectInfo = { path: root, kind: 'modpack', name: 'Fixture', namespace: 'fixture', loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '47.4.23', createdAt: '' }
  const file = path.join(root, 'fixture.jar')
  await fs.writeFile(file, createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="fixture"\nversion="1.0.0"') }]))
  const java = vi.fn(async () => ({ path: process.execPath, version: '17' }))
  const install = vi.fn(async (options: any, _project: ProjectInfo) => {
    const properties = await fs.readFile(path.join(options.serverPack.root, 'server.properties'), 'utf8')
    const port = properties.match(/server-port=(\d+)/)![1]
    return { loader: 'forge' as const, loaderVersion: '47.4.23', launchCommand: [process.execPath, '-e', serverCode, port] }
  })
  const service = new IsolatedServerScenarioService({ fixtures: new ServerFixtureService(), java, install }); services.push(service)
  const input = { operation: 'start', acceptEula: true, fixture: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', jars: [{ path: file, sha256: (await fixtureJarHash(file)).sha256 }] }, steps: [{ command: 'fresh', expect: ['fresh world'] }] }
  const wait = async (taskId: string) => { await vi.waitFor(async () => expect((await service.read(project, taskId))?.status).not.toBe('running'), { timeout: 10000 }); return (await service.read(project, taskId))! }
  return { root, project, service, input, wait, java, install }
}
it('isolates fresh worlds, preserves only the current test across restart, cleans processes and keeps final evidence', async () => {
  const f = await fixture()
  const formal = path.join(f.root, '.modmind/server/instances/modpack/world')
  await fs.mkdir(formal, { recursive: true }); await fs.writeFile(path.join(formal, 'state'), 'formal')
  const task = f.service.start(f.project, { ...f.input, steps: [{ command: 'fresh', expect: ['fresh world'] }, { command: 'set', expect: ['state saved'] }, { operation: 'restart' }, { command: 'check', expect: ['state persistent'] }] })
  expect(task.status).toBe('running'); expect(f.service.isBusy()).toBe(true)
  const outcome = await f.wait(task.taskId)
  expect(outcome).toMatchObject({ status: 'completed', completed: 4, result: { success: true, cleanup: 'complete' } })
  expect(outcome.result?.observedMods).toEqual([expect.objectContaining({ id: 'fixture', version: '1.0.0' })])
  expect(await fs.readFile(path.join(formal, 'state'), 'utf8')).toBe('formal')
  await expect(fs.stat(path.join(path.dirname(outcome.logPath!), 'game'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(outcome.logPath!, 'utf8')).toContain('state persistent')
  const second = f.service.start(f.project, f.input)
  expect(second.taskId).not.toBe(task.taskId)
  expect((await f.wait(second.taskId)).status).toBe('completed')
  const afterRestart = new IsolatedServerScenarioService({ fixtures: new ServerFixtureService(), java: f.java, install: f.install }); services.push(afterRestart)
  expect((await afterRestart.read(f.project, task.taskId))?.result?.success).toBe(true)
  expect((await afterRestart.read(f.project))?.result?.success).toBe(true)
}, 20000)
it('returns task IDs promptly, supports bounded polling and cancels a running scenario', async () => {
  const f = await fixture()
  const task = f.service.start(f.project, { ...f.input, steps: [{ command: 'hang', expect: ['never'], timeoutMs: 120000 }] })
  await vi.waitFor(async () => expect((await f.service.read(f.project, task.taskId))?.phase).toBe('scenario'))
  expect((await f.service.read(f.project, task.taskId, 0))?.status).toBe('running')
  const acknowledgement = await f.service.cancel(f.project, task.taskId)
  expect(acknowledgement.canCancel).toBe(false)
  expect((await f.wait(task.taskId)).status).toBe('cancelled')
  expect(f.service.isBusy()).toBe(false)
  await expect(f.service.read({ ...f.project, path: path.join(f.root, 'other') }, task.taskId)).rejects.toThrow('不属于当前项目')
})
it('rejects unsafe setup before runtime downloads and records assertion failure separately from startup', async () => {
  const f = await fixture()
  expect(() => f.service.start(f.project, { ...f.input, acceptEula: false })).toThrow('EULA')
  expect(() => f.service.start(f.project, { ...f.input, outputDirectory: f.root })).toThrow('不能指定输出目录')
  expect(() => f.service.start(f.project, { ...f.input, onlineMode: true })).toThrow('离线')
  const task = f.service.start(f.project, { ...f.input, steps: [{ command: 'fail', expect: ['passed'] }] })
  const outcome = await f.wait(task.taskId)
  expect(outcome).toMatchObject({ status: 'failed', result: { success: false, failedStep: 1, completed: 0, cleanup: 'complete' } })
})
it('fails changed JARs before provisioning and cancels on project switch', async () => {
  const f = await fixture()
  const task = f.service.start(f.project, { ...f.input, fixture: { ...f.input.fixture, jars: [{ ...f.input.fixture.jars[0], sha256: 'f'.repeat(64) }] } })
  expect((await f.wait(task.taskId)).error).toContain('SHA-256 不符')
  expect(f.java).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled()
  const active = f.service.start(f.project, { ...f.input, steps: [{ command: 'hang', expect: ['never'], timeoutMs: 120000 }] })
  await f.service.projectChanged('another-project')
  expect((await f.wait(active.taskId)).status).toBe('cancelled')
})
it('does not call discovered metadata loaded evidence until server startup has completed', () => {
  const mods = [{ id: 'fixture', version: '1.0.0', file: 'fixture.jar', embedded: false }]
  expect(observeLoadedMods('Found valid mod file fixture.jar\nCreating LowCodeModContainer for fixture', mods)).toEqual([])
  const result = observeLoadedMods('Creating LowCodeModContainer for fixture\nDone (0.1s)!', mods)
  expect(result).toEqual([expect.objectContaining({ id: 'fixture', evidence: expect.stringContaining('version from SHA-256-verified JAR metadata') })])
})
it('checks Java constraints against the actual selected runtime before server installation', async () => {
  const f = await fixture()
  const file = f.input.fixture.jars[0].path
  await fs.writeFile(file, createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="fixture"\nversion="1.0.0"\n[[dependencies.fixture]]\nmodId="java"\nmandatory=true\nversionRange="[17,18)"') }]))
  f.java.mockResolvedValueOnce({ path: process.execPath, version: '21' })
  const task = f.service.start(f.project, { ...f.input, fixture: { ...f.input.fixture, jars: [{ path: file, sha256: (await fixtureJarHash(file)).sha256 }] } })
  expect((await f.wait(task.taskId)).error).toContain('实际 Java 21')
  expect(f.install).not.toHaveBeenCalled()
})
it('keeps an unconfirmed process owned and permits cleanup retry before another task starts', async () => {
  const f = await fixture()
  vi.spyOn(ServerProcess.prototype, 'stop').mockRejectedValueOnce(new Error('test stop failed'))
  const task = f.service.start(f.project, f.input)
  const failed = await f.wait(task.taskId)
  expect(failed).toMatchObject({ status: 'failed', canCancel: true, result: { success: false, cleanup: 'failed' } })
  expect(f.service.isBusy()).toBe(true)
  expect(() => f.service.start(f.project, f.input)).toThrow('已有隔离服务端测试')
  await f.service.cancel(f.project, task.taskId)
  expect((await f.wait(task.taskId))).toMatchObject({ status: 'cancelled', result: { success: false, cleanup: 'complete' } })
  expect(f.service.isBusy()).toBe(false)
})
