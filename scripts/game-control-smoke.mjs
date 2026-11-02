import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch } from '@xmcl/core'
import { createRequire } from 'node:module'

// Uses an existing local installation. This harness never installs Minecraft,
// downloads game assets, or writes into the player's game directory.
const root = path.resolve(import.meta.dirname, '..')
const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = path.resolve(value('directory') || path.join(root, 'test-results/game-control-live', String(Date.now())))
await fs.mkdir(directory, { recursive: true })
await fs.mkdir(path.join(directory, 'commands'), { recursive: true })
await fs.mkdir(path.join(directory, 'responses'), { recursive: true })
await build({ entryPoints: [path.join(root, 'feature-plugins/testing/src/main/gameControlSession.ts')], outfile: path.join(directory, 'session.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { BackgroundGameControlSession, backgroundGameWindowsHide } = await import(pathToFileURL(path.join(directory, 'session.mjs')).href)
const gameDirectory = path.join(directory, 'game')
await fs.mkdir(gameDirectory, { recursive: true })
await fs.writeFile(path.join(gameDirectory, 'options.txt'), 'lang:en_us\nnarrator:0\nguiScale:2\nrenderDistance:4\nsimulationDistance:4\nsoundCategory_master:0.0\n')
const session = await BackgroundGameControlSession.prepare(directory, gameDirectory)
const java = value('java') || 'java'
const socketRoot = value('socket-temp') || path.resolve(process.env.APPDATA, '..', 'Local', 'Temp')
// Java 17 AF_UNIX on this machine rejects the profile's redirected C: path;
// use an explicitly scoped absolute directory on the fixture's actual drive.
await fs.mkdir(socketRoot, { recursive: true })
const unixSocketTemporaryDirectory = await fs.mkdtemp(path.join(socketRoot, 'mm-gc-'))
let child
if (value('probe-classpath')) {
  child = spawn(java, [session.jvmArgument, ...(value('natives') ? [`-Djava.library.path=${value('natives')}`, `-Dorg.lwjgl.librarypath=${value('natives')}`] : []), '-cp', value('probe-classpath'), value('probe-class'), path.join(directory, 'probe.json')], { cwd: directory, env: session.environment(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
} else {
  const resources = path.resolve(value('resources') || path.join(process.env.APPDATA, 'ModMind/minecraft-runtime/game'))
  child = await launch({ gamePath: gameDirectory, resourcePath: resources, nativeRoot: path.join(directory, 'natives'), version: value('version') || '1.20.1', javaPath: java,
    gameProfile: { name: 'ModMindProbe', id: 'f78a4d78c9b44f9596f5f814091b4e75' }, accessToken: '0', userType: 'legacy', minMemory: 512, maxMemory: 2048,
    resolution: { width: 960, height: 540 }, extraJVMArgs: [`-Djdk.net.unixdomain.tmpdir=${unixSocketTemporaryDirectory}`, session.jvmArgument], extraExecOption: { cwd: gameDirectory, env: session.environment(process.env), windowsHide: backgroundGameWindowsHide(value('version') || '1.20.1') } })
}
session.bind(child)
const artifact = createRequire(import.meta.url)('../feature-plugins/testing/src/main/gameControlAgent.json')
await fs.writeFile(path.join(directory, 'launch.json'), JSON.stringify({ pid: child.pid, agentSha256: artifact.jarSha256, java, minecraft: value('version') || '1.20.1' }, null, 2))
const log = createWriteStream(path.join(directory, 'game.log')); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
let exited = false
child.once('exit', (code, signal) => { exited = true; log.end(); console.log(JSON.stringify({ event: 'game-exit', code, signal })); })
async function stop() { if (!exited) { await session.release().catch(() => {}); child.kill(); } await session.dispose() }
process.once('SIGINT', () => { void stop().then(() => process.exit()) })
process.once('SIGTERM', () => { void stop().then(() => process.exit()) })
try {
  const ready = await session.waitUntilReady(undefined, 90000)
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(ready, null, 2))
  console.log(JSON.stringify({ event: 'ready', directory, ...ready }))
  const first = await session.capture(); await fs.writeFile(path.join(directory, 'first.png'), first.image)
  console.log(JSON.stringify({ event: 'captured', frameId: first.frameId, image: path.join(directory, 'first.png') }))
  // Local command files keep test credentials in this process. Each request uses
  // the production business service and its exact authenticated transport.
  const deadline = Date.now() + 15 * 60_000
  while (!exited && Date.now() < deadline) {
    const name = (await fs.readdir(path.join(directory, 'commands'))).find(name => /^[a-f0-9-]{36}\.json$/.test(name))
    const commandFile = name ? path.join(directory, 'commands', name) : null
    const command = commandFile ? await fs.readFile(commandFile, 'utf8').then(JSON.parse, () => null) : null
    if (command) {
      await fs.rm(commandFile, { force: true })
      const result = { id: command.id }
      try {
        if (command.operation === 'stop') result.value = { stopping: true }
        else if (command.operation === 'capture') {
          const frame = await session.capture(); const { image, ...metadata } = frame
          const name = `frame-${frame.frameId}.png`; await fs.writeFile(path.join(directory, name), image); result.value = { ...metadata, image: name }
        } else if (command.operation === 'status') result.value = await session.status()
        else if (command.operation === 'release') { await session.release(); result.value = { released: true } }
        else if (command.operation === 'input') result.value = await session.input(command.action, { requestId: command.requestId })
        else throw new Error('Unknown harness command')
      } catch (error) { result.error = error.message }
      await fs.writeFile(path.join(directory, 'responses', `${command.id}.json`), JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result))
      if (command.operation === 'stop') break
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await stop(); await fs.rm(unixSocketTemporaryDirectory, { recursive: true, force: true }).catch(() => undefined) }
