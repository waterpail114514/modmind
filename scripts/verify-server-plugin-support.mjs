import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'test-results/plugin-version-support')
await fs.mkdir(output, { recursive: true })
const runtimePath = path.join(output, 'probe-runtime.cjs')
await build({ stdin: { contents: `export { ServerPluginCatalog } from './src/main/serverPluginCatalog'; export { serverCoreBuilds } from './src/main/serverCoreService'; export { DownloadManager } from './src/main/downloadService'; export { archiveEntries } from './src/main/ftbResourceArchive';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: runtimePath })
const { ServerPluginCatalog, serverCoreBuilds, DownloadManager, archiveEntries } = createRequire(import.meta.url)(runtimePath)
const report = { observedAt: new Date().toISOString(), catalogs: {}, cores: [], failures: [] }
const catalog = new ServerPluginCatalog(path.join(output, 'catalog'))
for (const platform of ['paper', 'spigot', 'folia', 'velocity']) {
  const versions = await catalog.listPlatform(platform, true)
  const degraded = versions.some(v => v.notes.some(n => n.includes('刷新失败')))
  report.catalogs[platform] = { count: versions.length, degraded, versions }
  if (degraded) report.failures.push(`${platform}: using fallback metadata`)
  console.log(`${platform}: ${versions.length} API targets${degraded ? ' (fallback)' : ''}`)
}
const downloader = new DownloadManager()
try {
  for (const [core, version] of [['paper', '26.2'], ['folia', '26.2'], ['velocity', '4.1.1'], ['purpur', '1.21.1']]) {
    try {
      const builds = await serverCoreBuilds(core, version)
      const selected = builds.find(b => b.channel === 'STABLE') ?? builds[0]
      if (!selected?.checksum) throw new Error('No verifiable build')
      const entry = { ...selected, downloadVerified: false }
      if (process.argv.includes('--download-cores')) {
        const destination = path.join(output, 'cores', `${core}-${version}-${selected.build}.jar`)
        const result = await downloader.download({ sources: [{ id: core, label: `${core} official`, url: selected.url }], destination, expectedHash: selected.checksum, trackActivity: false, signal: AbortSignal.timeout(180_000) })
        if (!(await archiveEntries(destination)).includes('META-INF/MANIFEST.MF')) throw new Error('Missing JAR manifest')
        Object.assign(entry, { downloadVerified: true, bytes: result.bytes, hash: result.hash, path: destination })
      }
      report.cores.push(entry)
      console.log(`${core} ${version} build ${selected.build}: ${entry.downloadVerified ? 'download/hash/JAR verified' : 'metadata verified'}`)
    } catch (error) { report.failures.push(`${core} ${version}: ${String(error)}`); console.error(report.failures.at(-1)) }
  }
} finally {
  await downloader.shutdown()
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (report.failures.length) process.exitCode = 1
