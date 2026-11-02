import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Agent, interceptors } from 'undici'
import { Version } from '@xmcl/core'
import { installForgeTask, installNeoForgedTask, installLibrariesTask, resolveLibraryDownloadUrls } from '@xmcl/installer'
import { ensureXmclUndiciCompatibility } from '../src/main/xmclUndiciCompatibility.ts'

// Reuses the production XMCL installer/patcher. No asset or Java installer is
// called. All writes stay in the explicit acceptance resource root.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
ensureXmclUndiciCompatibility()
const root = path.resolve(arg('resources') || 'test-results/game-control-matrix-resources')
if (!root.startsWith(path.resolve('test-results') + path.sep)) throw new Error('Isolated test resource directory required')
const output = path.resolve(arg('output') || 'test-results/game-control-loader-preparation'); await fs.mkdir(output, { recursive: true })
const matrix = JSON.parse(await fs.readFile(arg('matrix') || 'docs/game-control-compatibility/compatibility-matrix.json', 'utf8'))
const requestedProfile = arg('profile-version'), profileCache = path.resolve(arg('profile-cache') || 'test-results/game-control-version-audit/loader-profiles')
const loaders = new Set((arg('loaders') || 'fabric,quilt,forge,neoforge').split(',')), keys = arg('keys') ? new Set(arg('keys').split(',')) : undefined
const all = matrix.combinations.filter(row => loaders.has(row.loader) && (!keys || keys.has(row.key)) && (!requestedProfile || row.profiles.some(profile => profile.loaderVersion === requestedProfile)))
const limit = Number(arg('budget-bytes') || 2 * 1024 ** 3), hash = value => createHash('sha256').update(value).digest('hex')
const installerBytes = all.reduce((sum, row) => sum + (row.profiles[0]?.totalInstallerBytes || 0), 0)
console.log(JSON.stringify({ phase: 'loader-preparation-plan', combinations: all.length, declaredInstallerBytes: installerBytes, newArtifactByteLimit: limit, assets: false, java: false }))
if (!process.argv.includes('--download-fixture')) process.exit(0)
const cache = path.resolve(process.env.APPDATA, 'modmind/minecraft-runtime/game')
// Preserve immutable existing cache files; never write to the player's install.
if (!process.argv.includes('--no-cache-copy')) await fs.cp(path.join(cache, 'libraries'), path.join(root, 'libraries'), { recursive: true, force: false, errorOnExist: false })
let downloadedBytes = 0
const metered = dispatch => (options, handler) => {
  let abort
  return dispatch(options, new Proxy(handler, { get(target, key) {
    if (key === 'onConnect' && typeof target.onConnect === 'function') return (cancel, context) => { abort = cancel; return target.onConnect(cancel, context) }
    if (key === 'onData' && typeof target.onData === 'function') return bytes => { downloadedBytes += bytes.length; if (downloadedBytes > limit) { abort?.(new Error('Acceptance loader download budget exceeded')); return false } return target.onData(bytes) }
    if (key === 'onResponseData' && typeof target.onResponseData === 'function') return (controller, bytes) => { downloadedBytes += bytes.length; if (downloadedBytes > limit) { controller.abort(new Error('Acceptance loader download budget exceeded')); return } return target.onResponseData(controller, bytes) }
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } }))
}
const network = new Agent({ connections: 3, headersTimeout: 30000, bodyTimeout: 45000, connect: { timeout: 15000 } }).compose(metered, interceptors.redirect({ maxRedirections: 5 }), interceptors.retry({ maxRetries: 1 }))
const hosts = ['https://maven.minecraftforge.net', 'https://maven.neoforged.net/releases', 'https://maven.fabricmc.net', 'https://maven.quiltmc.org/repository/release', 'https://libraries.minecraft.net', 'https://repo.maven.apache.org/maven2']
const libraryHost = library => [...new Set([...resolveLibraryDownloadUrls(library, {}), ...resolveLibraryDownloadUrls(library, { mavenHost: hosts })].map(url => url.replace(/^http:\/\//, 'https://')))]
const javas = { 8: path.resolve(process.env.APPDATA, '.minecraft/runtime/jre-legacy/bin/java.exe'), 17: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-17-windows-x64/bin/java.exe'), 21: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64/bin/java.exe'), 25: path.resolve(process.env.APPDATA, '.minecraft/runtime/java-runtime-epsilon/bin/java.exe') }
const results = await fs.readFile(path.join(output, 'results.json'), 'utf8').then(JSON.parse, () => ({ rows: [] }))
const saved = new Map(results.rows.map(row => [row.key, row]))
const children = new Set()
const describeError = (error, depth = 0) => depth > 3 ? String(error) : [error?.stack || String(error), ...(error?.errors || []).map(value => describeError(value, depth + 1)), ...(error?.cause ? [describeError(error.cause, depth + 1)] : [])].join('\n').slice(0, 6000)
let activeTask
const spawnJava = (command, args, options) => {
  const child = spawn(command, args, { ...options, windowsHide: true }); children.add(child); child.once('exit', () => children.delete(child)); return child
}
async function runTask(task) {
  activeTask = task
  let updated = Date.now(), progress = -1
  const timer = setInterval(() => {
    if (Date.now() - updated < 180000) return
    void task.cancel()
    for (const child of children) child.kill()
  }, 1000)
  try { return await task.startAndWait({ onUpdate(current) { if (current.progress !== progress) { progress = current.progress; updated = Date.now() } } }) }
  finally { clearInterval(timer); if (activeTask === task) activeTask = undefined }
}
const heartbeat = setInterval(() => console.log(JSON.stringify({ phase: 'loader-preparation-progress', completed: saved.size, downloadedBytes })), 20000)
try {
  for (const target of all) {
    const profile = requestedProfile ? target.profiles.find(profile => profile.loaderVersion === requestedProfile) : target.profiles.find(profile => profile.origins.includes('bundled')) || target.profiles[0]
    if (!profile) throw new Error('Selected Loader profile missing: ' + target.key)
    const key = requestedProfile ? `${target.key}@${profile.loaderVersion}` : target.key
    const previous = saved.get(key)
    if (previous?.status === 'prepared') {
      const installed = await fs.readFile(path.join(root, 'versions', previous.versionId, previous.versionId + '.json'), 'utf8').then(JSON.parse, () => undefined)
      if (installed && (target.loader !== 'forge' || installed.inheritsFrom === target.minecraftVersion)) continue
    }
    const beforeDownload = downloadedBytes
    const row = { key, baseKey: target.key, resources: root, loader: target.loader, minecraftVersion: target.minecraftVersion, loaderVersion: profile.loaderVersion, source: profile.url, profileSha256: profile.profileSha256, runtimeVerified: false }
    console.log(JSON.stringify({ phase: 'preparing-loader', ...row }))
    try {
      if (downloadedBytes >= limit) throw new Error('Loader acceptance budget reached')
      let versionId
      if (target.loader === 'fabric' || target.loader === 'quilt') {
        const raw = JSON.parse(await fs.readFile(path.join(profileCache, hash(profile.url) + '.json'), 'utf8'))
        const version = raw.documents['version.json'].value
        if (!/^[a-zA-Z0-9._-]+$/.test(version.id) || version.inheritsFrom !== target.minecraftVersion) throw new Error('Unexpected cached Loader profile identity')
        versionId = version.id
        const directory = path.join(root, 'versions', versionId); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, versionId + '.json'), JSON.stringify(version, null, 2))
      } else {
        const major = target.java?.majorVersion || 8, java = javas[major === 16 ? 17 : major]
        let loaderVersion = profile.loaderVersion.replace(new RegExp('^' + target.minecraftVersion.replaceAll('.', '\\.') + '-'), '')
        if (/^1\.(?:7|8)\./.test(target.minecraftVersion) && loaderVersion.endsWith('-' + target.minecraftVersion)) loaderVersion = loaderVersion.slice(0, -target.minecraftVersion.length - 1)
        const options = { java, spawn: spawnJava, side: 'client', inheritsFrom: target.minecraftVersion, mavenHost: hosts, libraryHost, dispatcher: network, librariesDownloadConcurrency: 3 }
        versionId = await runTask(target.loader === 'forge' ? installForgeTask({ mcversion: target.minecraftVersion, version: loaderVersion, installer: { path: profile.url } }, root, options) : installNeoForgedTask(target.minecraftVersion === '1.20.1' ? 'forge' : 'neoforge', loaderVersion, root, options))
      }
      const version = await Version.parse(root, versionId)
      for (const library of version.libraries) if (library.download.path.split('/').some(part => part === '..')) throw new Error('Invalid library path')
      await runTask(installLibrariesTask(version, { dispatcher: network, libraryHost, mavenHost: hosts, librariesDownloadConcurrency: 3 }))
      Object.assign(row, { status: 'prepared', versionId, libraries: version.libraries.length, completedAt: new Date().toISOString() })
    } catch (error) { Object.assign(row, { status: 'failed', error: describeError(error), completedAt: new Date().toISOString() }) }
    row.downloadedBytes = downloadedBytes - beforeDownload
    saved.set(row.key, row)
    const report = { createdAt: new Date().toISOString(), resources: root, assetsDownloaded: false, javaDownloaded: false, downloadedBytes, byteLimit: limit, rows: [...saved.values()] }
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...row, ...(row.error ? { error: row.error.slice(0, 600) } : {}) }))
    if (downloadedBytes >= limit) break
  }
} finally { clearInterval(heartbeat); if (activeTask) await activeTask.cancel().catch(() => {}); for (const child of children) child.kill(); await network.destroy() }
