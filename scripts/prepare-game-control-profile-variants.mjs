import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

// Reuse the same SDK installer for the additional, already catalogued profile
// choices. No new Minecraft versions, assets or Java runtimes are introduced.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const workspace = process.cwd(), host = path.resolve(arg('host-root') || '.'), matrixFile = path.join(host, 'docs/game-control-compatibility/compatibility-matrix.json')
const matrix = JSON.parse(await fs.readFile(matrixFile, 'utf8'))
const root = path.resolve(arg('output') || 'test-results/game-control-profile-variant-preparation'), resources = path.resolve(arg('resources') || 'test-results/game-control-matrix-resources')
await fs.mkdir(root, { recursive: true })
const targets = matrix.combinations.flatMap(target => {
  const selected = target.profiles.find(profile => profile.origins.includes('bundled')) || target.profiles[0]
  return target.profiles.filter(profile => profile.loaderVersion !== selected.loaderVersion).map(profile => ({ ...target, profile, variantKey: `${target.key}@${profile.loaderVersion}` }))
})
const budget = Number(arg('budget-bytes') || 1024 ** 3)
const saved = () => fs.readFile(path.join(root, 'results.json'), 'utf8').then(JSON.parse, () => ({ rows: [] }))
let downloaded = (await fs.readFile(path.join(root, 'progress.json'), 'utf8').then(JSON.parse, () => ({ downloadedBytes: 0 }))).downloadedBytes
for (const target of targets) {
  const resourceRoots = [...new Set([resources, path.resolve(arg('extra-resources') || path.join(host, 'test-results/game-control-matrix-resources'))])]
  let selectedRoot
  for (const candidate of resourceRoots) if (await fs.access(path.join(candidate, 'versions', target.minecraftVersion, target.minecraftVersion + '.json')).then(() => true, () => false)) { selectedRoot = candidate; break }
  if (!selectedRoot) throw new Error('Existing client fixture missing: ' + target.minecraftVersion)
  const childWorkspace = [workspace, host].find(candidate => selectedRoot.startsWith(path.join(candidate, 'test-results') + path.sep))
  if (!childWorkspace) throw new Error('Profile writes must stay inside an explicit test workspace')
  const previous = (await saved()).rows.find(row => row.key === target.variantKey && row.status === 'prepared')
  if (previous && await fs.access(path.join(selectedRoot, 'versions', previous.versionId, previous.versionId + '.json')).then(() => true, () => false)) continue
  if (downloaded >= budget) throw new Error('Catalog profile fixture budget exhausted')
  const log = createWriteStream(path.join(root, createHash('sha256').update(target.variantKey).digest('hex').slice(0, 16) + '.log'))
  const child = spawn(process.execPath, ['scripts/prepare-game-control-loaders.mjs', `--resources=${selectedRoot}`, `--output=${root}`, `--matrix=${matrixFile}`, `--profile-cache=${path.join(host, 'test-results/game-control-version-audit/loader-profiles')}`, `--keys=${target.key}`, `--loaders=${target.loader}`, `--profile-version=${target.profile.loaderVersion}`, '--download-fixture', '--no-cache-copy', `--budget-bytes=${budget - downloaded}`], { cwd: childWorkspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  console.log(JSON.stringify({ phase: 'preparing-catalog-profile', key: target.variantKey, pid: child.pid }))
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) }); log.end()
  const report = await saved(), row = report.rows.find(row => row.key === target.variantKey)
  if (code !== 0 || row?.status !== 'prepared') throw new Error('Catalog profile preparation failed: ' + target.variantKey)
  downloaded += row.downloadedBytes || 0
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ updatedAt: new Date().toISOString(), expected: targets.length, prepared: report.rows.filter(row => row.status === 'prepared').length, downloadedBytes: downloaded, byteLimit: budget }, null, 2))
}
const report = await saved()
await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ ...report, downloadedBytes: downloaded, assessment: 'additional existing catalog profiles; no game runs inferred' }, null, 2))
console.log(JSON.stringify({ expected: targets.length, prepared: report.rows.filter(row => row.status === 'prepared').length, downloadedBytes: downloaded }))
