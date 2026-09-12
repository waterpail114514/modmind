import { build } from 'esbuild'
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Apply the same managed Java environment to builds and child JVMs.
const output = path.join(root, 'test-results/plugin-runtime-matrix')
await fs.mkdir(output, { recursive: true })
const modulePath = path.join(output, 'runtime.cjs')
await build({ stdin: { contents: `export { ServerPluginCatalog } from './src/main/serverPluginCatalog'; export { pluginTemplateFiles } from './src/main/serverPluginTemplates'; export { serverCoreBuilds } from './src/main/serverCoreService'; export { DownloadManager } from './src/main/downloadService'; export { ServerProcess } from './src/main/serverVerificationService'; export { spawnManaged, terminateProcessTree } from './src/main/processTree'; export { inspectPluginJar } from './src/main/serverPluginService';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: modulePath })
const api = createRequire(import.meta.url)(modulePath)
const socketDirectory = path.join(process.env.LOCALAPPDATA, 'ModMind/java-sockets')
await fs.mkdir(socketDirectory, { recursive: true })
process.env.JAVA_TOOL_OPTIONS = `${process.env.JAVA_TOOL_OPTIONS ?? ''} -Djdk.net.unixdomain.tmpdir="${await fs.realpath(socketDirectory)}"`.trim()
const catalog = new api.ServerPluginCatalog(path.join(root, 'test-results/plugin-version-support/catalog'))
const downloader = new api.DownloadManager()
const jdkRoot = path.join(root, 'test-results/plugin-version-support/jdks')
const javas = { 8: path.join(jdkRoot, 'temurin-8-windows-x64'), 17: path.join(jdkRoot, 'temurin-17-windows-x64'), 25: path.join(jdkRoot, 'temurin-25-windows-x64'), 21: path.join(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64') }
const gradle = path.join(root, 'test-results/unified-upgrade-live/user-data/gradle-runtime/cache/wrapper/dists/gradle-9.5.1-bin/iq79hdu3mqx29lgffhp8bfmx/gradle-9.5.1')
const requestedTarget = process.argv.find(arg => arg.startsWith('--target='))?.slice(9)
const reportPath = path.join(output, requestedTarget ? `report-${requestedTarget.replace(':', '-')}.json` : process.argv.includes('--spigot') ? 'spigot-report.json' : process.argv.includes('--remaining') ? 'remaining-report.json' : 'report.json')
const report = { startedAt: new Date().toISOString(), entries: [], soak: null }
const active = new Set()
const write = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2))
async function hash(file, algorithm = 'sha256') { const h = createHash(algorithm); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex') }
async function run(command, args, cwd, logFile, timeout = 300000) {
  const child = api.spawnManaged(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JAVA_HOME: path.dirname(path.dirname(command)), GRADLE_USER_HOME: path.join(process.env.USERPROFILE, '.gradle/modmind-plugin-matrix') } })
  const live = createWriteStream(`${logFile}.live`)
  let text = ''; const capture = chunk => { live.write(chunk); text += chunk.toString(); if (text.length > 4000000) text = text.slice(-4000000) }
  child.stdout.on('data', capture); child.stderr.on('data', capture)
  const timer = setTimeout(() => void api.terminateProcessTree(child), timeout)
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); await fs.writeFile(logFile, text); if (code !== 0) throw new Error(`process exit ${code}: ${text.slice(-2500)}`); return text }
  finally { clearTimeout(timer); live.end() }
}
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port }
async function prepare(platform, version) {
  const option = await catalog.resolve(platform, version)
  const directory = path.join(output, `${platform}-${version}`)
  const project = { name: 'ModMind Runtime Probe', namespace: 'modmindprobe', path: directory, kind: 'server-plugin', loader: platform, minecraftVersion: version, apiVersion: option.apiVersion, javaVersion: option.javaVersion, createdAt: new Date().toISOString() }
  for (const [file, content] of Object.entries(api.pluginTemplateFiles(project))) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), content) }
  await run(path.join(javas[Math.max(17, option.javaVersion)], 'bin/java.exe'), ['-cp', path.join(gradle, 'lib/gradle-gradle-cli-main-9.5.1.jar'), 'org.gradle.launcher.GradleMain', '--no-daemon', '--max-workers=2', `-Dorg.gradle.java.installations.paths=${Object.values(javas).join(',')}`, 'clean', 'build'], directory, path.join(directory, 'build.log'))
  const jar = path.join(directory, 'build/libs/modmindprobe-0.1.0.jar')
  const descriptor = await api.inspectPluginJar(jar)
  const core = platform
  let selected
  if (core === 'spigot') {
    const local = path.join(output, 'buildtools', version, `spigot-${version}.jar`)
    if (!await fs.stat(local).then(s => s.isFile()).catch(() => false)) return { project, jar, descriptor, compiled: true, runtime: 'requires BuildTools core', expectedCore: local }
    selected = { core, version, build: 'BuildTools-200', javaVersion: option.javaVersion, checksum: { algorithm: 'sha256', value: await hash(local) }, local }
  } else {
    const builds = await api.serverCoreBuilds(core, version.replace('-SNAPSHOT', ''))
    selected = builds.find(b => b.channel === 'STABLE') ?? builds[0]
  }
  if (!selected?.checksum) throw new Error('No verifiable core')
  const instance = path.join(directory, 'server')
  await fs.mkdir(path.join(instance, 'plugins'), { recursive: true })
  const serverJar = path.join(instance, 'server.jar')
  if (await hash(serverJar, selected.checksum.algorithm).catch(() => '') !== selected.checksum.value) {
    if (selected.local) await fs.copyFile(selected.local, serverJar)
    else await downloader.download({ sources: [{ id: core, label: core, url: selected.url }], destination: serverJar, expectedHash: selected.checksum, trackActivity: false })
  }
  await fs.copyFile(jar, path.join(instance, 'plugins/modmindprobe.jar'))
  const port = await freePort()
  if (core === 'velocity') await fs.writeFile(path.join(instance, 'velocity.toml'), `bind = "127.0.0.1:${port}"\nonline-mode = false\nplayer-info-forwarding-mode = "none"\n`)
  else {
    await fs.writeFile(path.join(instance, 'eula.txt'), 'eula=true\n')
    await fs.writeFile(path.join(instance, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nlevel-type=minecraft:flat\ngenerate-structures=false\nmax-players=10\n`)
    if (core === 'folia') { await fs.mkdir(path.join(instance, 'config'), { recursive: true }); await fs.writeFile(path.join(instance, 'config/paper-global.yml'), 'threaded-regions:\n  threads: 2\n') }
  }
  const java = path.join(javas[selected.javaVersion], 'bin/java.exe')
  return { project, jar, descriptor, coreBuild: selected, compiled: true, options: { pack: { root: instance, manifestPath: '', copiedMods: [], skippedClientMods: [], warnings: [] }, runtime: { serverJar, launchCommand: [java, '-Xms256M', '-Xmx1024M', '-XX:ActiveProcessorCount=4', '-jar', 'server.jar', ...(core === 'velocity' ? [] : ['nogui'])], loader: core, loaderVersion: selected.build }, port, stopCommand: core === 'velocity' ? 'shutdown' : 'stop', gracefulTimeoutMs: 30000, readyTimeoutMs: 180000 } }
}
async function sample(server, item, index) {
  const javaHome = javas[item.coreBuild.javaVersion]
  const outputPath = path.join(item.project.path, `memory-${index}.txt`)
  const text = await run(path.join(javaHome, 'bin/jcmd.exe'), [String(server.pid), 'GC.class_histogram'], item.project.path, outputPath, 30000)
  const threads = await run(path.join(javaHome, 'bin/jcmd.exe'), [String(server.pid), 'Thread.print'], item.project.path, path.join(item.project.path, `threads-${index}.txt`), 30000)
  return { at: new Date().toISOString(), histogram: outputPath, retainedPlugin: text.split('\n').filter(l => /dev\.modmind/.test(l)), total: text.match(/Total\s+\d+\s+\d+/)?.[0], threadCount: threads.split('\n').filter(l => l.startsWith('"')).length }
}
async function verify(item, soakMinutes = 0) {
  const server = new api.ServerProcess(); active.add(server)
  const evidence = { ...item, options: undefined, jarHash: await hash(item.jar), samples: [] }
  const exits = []
  item.options.onExit = (code, signal) => exits.push({ code, signal })
  try {
    await server.start(item.options)
    if (!server.recentOutput.some(l => /Enabled 0.1.0/.test(l))) throw new Error('Core ready but plugin enablement missing')
    evidence.enabled = true
    const proxy = item.project.loader === 'velocity'
    const scenario = await server.runScenario([{ command: proxy ? 'velocity plugins' : 'modmindprobe', expect: [proxy ? 'modmindprobe' : 'modmindprobe 0.1.0'] }])
    if (!scenario.success) throw new Error('status scenario failed')
    evidence.scenario = scenario
    if (soakMinutes) {
      evidence.soakStartedAt = new Date().toISOString(); evidence.samples.push(await sample(server, item, 0))
      const deadline = Date.now() + soakMinutes * 60000
      let tick = 0
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 30000))
        if (!server.isRunning()) throw new Error('Server exited during soak')
        const cycle = await server.runScenario([{ command: proxy ? 'velocity plugins' : 'modmindprobe', expect: [proxy ? 'modmindprobe' : 'modmindprobe 0.1.0'] }])
        if (!cycle.success) throw new Error('soak command failed')
        tick++
        if (tick % 10 === 0) { evidence.samples.push(await sample(server, item, tick)); console.log('SOAK', tick / 2, 'minutes'); report.soak = evidence; await write() }
      }
      evidence.soakCompletedAt = new Date().toISOString()
    }
    await server.stop()
    evidence.shutdown = !server.isRunning()
    if (exits.at(-1)?.code !== 0 || exits.at(-1)?.signal) throw new Error('Server did not exit normally')
    if (!server.recentOutput.some(l => /Disabled 0.1.0/.test(l))) throw new Error('Shutdown callback missing')
    await server.start(item.options)
    evidence.restart = server.recentOutput.some(l => /Enabled 0.1.0/.test(l))
    await server.stop()
    evidence.exits = exits
    if (exits.at(-1)?.code !== 0 || exits.at(-1)?.signal) throw new Error('Restarted server did not exit normally')
    evidence.passed = evidence.shutdown && evidence.restart
    return evidence
  } finally { await server.stop().catch(() => undefined); active.delete(server) }
}
const targets = process.argv.includes('--quick') ? [['velocity','4.1.1'],['paper','26.2'],['folia','26.2']] : [['velocity','4.1.1'],['velocity','3.5.1'],['velocity','3.4.0'],...['1.17.1','1.20.4','1.20.6','1.21.1','1.21.11','26.2'].map(v=>['paper',v]),...['1.19.4','1.20.4','1.21.4','1.21.11','26.1.2','26.2'].map(v=>['folia',v]),...['1.8.8','1.12.2','1.16.5','1.17.1','1.20.4','1.20.6','1.21.1','1.21.11','26.2'].map(v=>['spigot',v])]
let soak
try {
  for (const [platform, version] of targets) {
    const selectedVersions = process.argv.find(arg => arg.startsWith('--versions='))?.slice(11).split(',')
    if (selectedVersions && !selectedVersions.includes(version)) continue
    if (process.argv.includes('--spigot') && platform !== 'spigot') continue
    const targetOption = process.argv.find(arg => arg.startsWith('--target='))?.slice(9)
    if (targetOption && `${platform}:${version}` !== targetOption) continue
    if (process.argv.includes('--remaining') && ((platform === 'velocity' && version === '4.1.1') || (platform !== 'spigot' && version === '26.2'))) continue
    console.log('START', platform, version)
    try {
      const item = await prepare(platform, version)
      if (!item.options) { report.entries.push({ ...item, error: 'Core artifact unavailable; runtime validation incomplete' }); await write(); continue }
      if (!soak && process.argv.includes('--soak')) { soak = verify(item, 30).then(value => { report.soak = value; return write() }).catch(error => { report.soak = { platform, version, error: String(error) }; return write() }); continue }
      const entry = await verify(item); report.entries.push(entry); console.log('PASS', platform, version)
    } catch (error) { report.entries.push({ platform, version, error: String(error) }); console.log('FAIL', platform, version, String(error).slice(-1500)) }
    await write()
  }
  await soak
} finally { for (const server of active) await server.stop().catch(() => undefined); await downloader.shutdown(); report.finishedAt = new Date().toISOString(); await write() }
if (report.entries.some(e => e.error) || report.soak?.error) process.exitCode = 1
