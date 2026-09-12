import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results/plugin-runtime-matrix/buildtools')
await fs.mkdir(output, { recursive: true })
const modulePath = path.join(output, 'tools.cjs')
await build({ stdin: { contents: `export { fetchJsonWithRetry } from './src/main/networkRequest'; export { DownloadManager } from './src/main/downloadService'; export { spawnManaged, terminateProcessTree } from './src/main/processTree'; export { managedJavaEnvironment } from './src/main/javaEnvironment';`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: modulePath })
const { fetchJsonWithRetry, DownloadManager, spawnManaged, terminateProcessTree, managedJavaEnvironment } = createRequire(import.meta.url)(modulePath)
const downloader = new DownloadManager()
const gitExecutable = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const gitBin = path.resolve(path.dirname(gitExecutable), '../bin')
const metadata = await fetchJsonWithRetry('https://hub.spigotmc.org/jenkins/job/BuildTools/200/api/json')
if (metadata.result !== 'SUCCESS' || !metadata.artifacts.some(a => a.relativePath === 'target/BuildTools.jar')) throw new Error('BuildTools 200 not available')
const jar = path.join(output, 'BuildTools.jar')
if (!await fs.stat(jar).then(s => s.isFile() && s.size > 0).catch(() => false)) await downloader.download({ sources: [{ id: 'spigot', label: 'Spigot BuildTools official', url: 'https://hub.spigotmc.org/jenkins/job/BuildTools/200/artifact/target/BuildTools.jar' }], destination: jar, trackActivity: false })
const report = { buildTools: 200, source: metadata.url, entries: [] }
const requestedVersions = process.argv.find(arg => arg.startsWith('--versions='))?.slice(11).split(',')
for (const version of requestedVersions ?? ['1.8.8','1.12.2','1.16.5','1.17.1','1.20.4','1.20.6','1.21.1','1.21.11','26.2']) {
  const cwd = path.join(output, version); await fs.mkdir(cwd, { recursive: true })
  if (await fs.stat(path.join(cwd, `spigot-${version}.jar`)).then(s => s.isFile()).catch(() => false)) { report.entries.push({ version, built: true, cached: true }); continue }
  const major = version.startsWith('26.') ? 25 : ['1.8.8','1.12.2','1.16.5'].includes(version) ? 8 : ['1.17.1','1.20.4'].includes(version) ? 17 : 21
  const javaHome = major === 21 ? path.join(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64') : path.join(root, `test-results/plugin-version-support/jdks/temurin-${major}-windows-x64`)
  let text = ''; console.log('BUILDTOOLS', version)
  try {
    await fs.writeFile(path.join(cwd, 'version.json'), JSON.stringify(await fetchJsonWithRetry(`https://hub.spigotmc.org/versions/${version}.json`), null, 2))
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
    const child = spawnManaged(path.join(javaHome, 'bin/java.exe'), ['-Xmx2G', '-Dsun.net.client.defaultConnectTimeout=30000', '-Dsun.net.client.defaultReadTimeout=30000', '-jar', jar, '--rev', version, '--compile', 'SPIGOT'], { cwd, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: managedJavaEnvironment({ ...environment, SHELL: path.join(gitBin, 'bash.exe'), JAVA_HOME: javaHome, M2_HOME: path.join(root, 'test-results/plugin-runtime-matrix/maven/apache-maven-3.9.9'), Path: `${path.join(javaHome, 'bin')};${gitBin};${process.env.Path ?? process.env.PATH}` }) })
    const liveLog = createWriteStream(path.join(cwd, 'live.log'))
    const capture = chunk => { liveLog.write(chunk); text = (text + chunk.toString()).slice(-6000000) }; child.stdout.on('data', capture); child.stderr.on('data', capture)
    const timer = setTimeout(() => void terminateProcessTree(child), 600000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => { clearTimeout(timer); liveLog.end() })
    await fs.writeFile(path.join(cwd, 'buildtools.log'), text)
    const exists = await fs.stat(path.join(cwd, `spigot-${version}.jar`)).then(s => s.isFile()).catch(() => false)
    report.entries.push({ version, major, code, built: exists }); console.log(version, exists ? 'BUILT' : text.slice(-600))
  } catch (error) { report.entries.push({ version, error: String(error) }); console.log(version, String(error)) }
  await fs.writeFile(path.join(output, requestedVersions ? `report-${requestedVersions.join('_')}.json` : 'report.json'), JSON.stringify(report, null, 2))
}
await downloader.shutdown()
