import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { diagnosticFileFingerprint } from './diagnosticFiles'

const text = /\.(?:jsonl?|log|txt|md|snbt|mcmeta|properties|toml|ya?ml|xml|lang|java|kt|[cm]?js|tsx?)$/i
const excluded = /(?:^|\/)(?:saves|world(?:_nether|_the_end)?|libraries|natives|node_modules|\.git|\.gradle|codex-homes|versions|\.data)(?:\/|$)|(?:^|\/)(?:\.env.*|.*(?:credentials?|secrets?|settings).*\.json)$/i
async function contained(root: string, target: string): Promise<boolean> {
  const [base, actual] = await Promise.all([fs.realpath(root), fs.realpath(target)])
  const relative = path.relative(base, actual)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Collect bounded business evidence through real project roots, not guessed runtime directories. */
export async function collectDiagnosticEvidence(collector: DiagnosticArchiveCollector, options: { projectPath?: string; userData: string; dataDirectory?: string; includeProjectFiles?: boolean }): Promise<void> {
  const { projectPath, userData } = options
  const availability: Array<{ source: string; status: string }> = []
  const scoped = async (root: string, relative: string, prefix: string, include = (file: string) => text.test(file)): Promise<void> => {
    const target = path.join(root, relative)
    if (!await contained(root, target).catch(() => false)) {
      availability.push({ source: prefix, status: 'missing-or-outside-project-boundary' }); return
    }
    await collector.addDirectory(target, prefix, { include: file => !excluded.test(file) && include(file), descend: file => !excluded.test(file) && !/(?:^|\/)files(?:\/|$)/.test(file) && !/(?:^|\/)(?:mods|assets)(?:\/|$)/.test(file), maxEntries: 3000, maxDepth: 12 })
    availability.push({ source: prefix, status: 'enumerated; check collection-report for individual omissions' })
  }
  await collector.addFile(path.join(userData, 'image-studio-history.json'), 'app-runtime/image-history.json', 1024 * 1024)
  await collector.addFile(path.join(userData, 'pending-app-update.json'), 'app-runtime/pending-update.json', 128 * 1024)
  collector.addJson('app-runtime/settings-integrity.json', await diagnosticFileFingerprint(path.join(userData, 'settings.json')).catch(error => ({ unavailable: String(error) })))
  if (projectPath) {
    const normalized = path.resolve(projectPath)
    const identity = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex')
    const journalIdentity = createHash('sha256').update(process.platform === 'win32' ? normalized.replaceAll('\\', '/').toLowerCase() : normalized.replaceAll('\\', '/')).digest('hex').slice(0, 24)
    for (const directory of ['creation', 'server/scenarios', 'server/instances', 'workbench-journal', 'workbench-store', 'migrations', 'snapshots', 'diagnostic-artifacts', 'import']) {
      await scoped(projectPath, `${options.dataDirectory ?? '.modmind'}/${directory}`, `project/evidence/${directory}`, file => (text.test(file) || directory.startsWith('workbench') && /(?:\.json\.previous|\.gz)$/i.test(file)) && (directory !== 'snapshots' || /(?:^|\/)(?:snapshot|manifest|index|catalog).*\.json$/i.test(file)))
    }
    for (const directory of ['inspiration-workflows', 'workbench-journal', 'workbench-mirror']) {
      const key = directory.startsWith('workbench') ? journalIdentity : identity
      await scoped(userData, `${directory}/${key}`, `app-runtime/project-evidence/${directory}`, file => text.test(file) || /(?:\.json\.previous|\.gz)$/i.test(file))
    }
    const knowledgeFile = path.join(userData, 'inspiration-knowledge', `${identity}.json`)
    if (await contained(userData, knowledgeFile).catch(() => false)) await collector.addFile(knowledgeFile, 'app-runtime/project-evidence/inspiration-knowledge.json')
    for (const file of ['modmind.relationships.json', 'modmind.dependencies.json', 'modmind.release.json', '.modmind/item-editor.json', '.modmind/resource-pack-deployments.json', '.modmind/minecraft/modmind-pack-sync.json', 'docs/modpack-migration-report.md']) {
      const target = path.join(projectPath, file)
      if (await contained(projectPath, target).catch(() => false)) await collector.addFile(target, `project/context/${file.replace(/^\.modmind\//, '')}`, 1024 * 1024)
    }
    const inventory: Array<Record<string, unknown>> = []
    const queue = ['src', 'behavior_pack', 'resource_pack', 'config', 'kubejs', 'scripts', 'assets', 'data', 'mods', 'overrides', 'client-overrides', 'server-overrides', 'resource-packs', 'resourcepacks', 'behavior_packs', 'resource_packs', 'build/libs', `${options.dataDirectory ?? '.modmind'}/exports`]
    let inspected = 0, hashedBytes = 0
    while (queue.length && inspected < 5000) {
      const directory = queue.shift()!
      const absolute = path.join(projectPath, directory)
      if (!await contained(projectPath, absolute).catch(() => false)) continue
      const children = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [])
      for (const entry of children) {
        if (++inspected > 5000) break
        const relative = path.posix.join(directory, entry.name)
        if (entry.isSymbolicLink() || excluded.test(relative)) continue
        if (entry.isDirectory()) { if (relative.split('/').length < 12) queue.push(relative); continue }
        if (!entry.isFile()) continue
        const file = path.join(projectPath, relative)
        const stat = await fs.lstat(file).catch(() => null)
        if (!stat?.isFile()) continue
        const item: Record<string, unknown> = { path: relative, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
        if (stat.size <= 8 * 1024 * 1024 && hashedBytes + stat.size <= 32 * 1024 * 1024) {
          try {
            const handle = await fs.open(file, 'r')
            try {
              const size = Math.min((await handle.stat()).size, 8 * 1024 * 1024)
              const buffer = Buffer.alloc(size)
              let offset = 0
              while (offset < size) { const read = await handle.read(buffer, offset, size - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
              hashedBytes += offset
              item.sha256 = createHash('sha256').update(buffer.subarray(0, offset)).digest('hex')
              item.hashIncomplete = offset !== stat.size
            } finally { await handle.close() }
          } catch (error) { item.hashError = String(error).slice(0, 1000) }
        } else item.hashOmitted = 'hashing byte budget reached or large artifact'
        inventory.push(item)
        if (options.includeProjectFiles && text.test(relative)) await collector.addFile(file, `project/selected-sources/${relative}`, 1024 * 1024)
      }
    }
    collector.addJson('project/content-inventory.json', { capturedAt: new Date().toISOString(), inspected, hashedBytes, traversalIncomplete: inspected >= 5000 || queue.length > 0, sourceContentsIncluded: options.includeProjectFiles === true, files: inventory })
    const testRoot = path.join(projectPath, options.dataDirectory ?? '.modmind', 'player-tests')
    const testEvidenceErrors: string[] = []
    const sessions: Array<{ name: string; modified: number }> = []
    for (const entry of (await fs.readdir(testRoot, { withFileTypes: true }).catch(() => [])).slice(0, 1000)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const target = path.join(testRoot, entry.name)
      if (await contained(projectPath, target).catch(() => false)) {
        const stat = await fs.stat(target).catch(error => { testEvidenceErrors.push(String(error)); return null })
        if (stat) sessions.push({ name: entry.name, modified: stat.mtimeMs })
      }
    }
    let imageBytes = 0, omittedImages = 0
    for (const session of sessions.sort((a,b) => b.modified - a.modified).slice(0, 6)) {
      const prefix = `project/test-evidence/${session.name}`, source = path.join(testRoot, session.name)
      await collector.addFile(path.join(source, 'last-action.json'), `${prefix}/last-action.json`)
      const history = path.join(source, 'diagnostic-activity')
      if (await contained(projectPath, history).catch(() => false)) await collector.addDirectory(history, `${prefix}/activity`, { include: file => /\.(?:jsonl|json)$/i.test(file), maxEntries: 32 })
      const screenshots = path.join(source, 'screenshots')
      if (!await contained(projectPath, screenshots).catch(() => false)) continue
      const images = [] as Array<{ file: string; name: string; bytes: number; modified: number }>
      for (const entry of (await fs.readdir(screenshots, { withFileTypes: true }).catch(error => { testEvidenceErrors.push(String(error)); return [] })).slice(0, 1000)) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/\.png$/i.test(entry.name)) continue
        const file = path.join(screenshots, entry.name), stat = await fs.lstat(file).catch(error => { testEvidenceErrors.push(String(error)); return null })
        if (!stat) continue
        images.push({ file, name: entry.name, bytes: stat.size, modified: stat.mtimeMs })
      }
      for (const image of images.sort((a,b) => b.modified - a.modified)) {
        if (image.bytes > 8 * 1024 * 1024 || imageBytes + image.bytes > 32 * 1024 * 1024) { omittedImages++; continue }
        await collector.addFile(image.file, `${prefix}/screenshots/${image.name}`, 8 * 1024 * 1024); imageBytes += image.bytes
      }
    }
    collector.addJson('project/test-evidence/availability.json', { selectedSessions: Math.min(sessions.length, 6), omittedSessions: Math.max(0, sessions.length - 6), imageBytes, omittedImages, errors: testEvidenceErrors.slice(0, 30), policy: 'Only previously captured test images; no new game capture is requested during export. Per-item errors are listed in collection-report.json.' })
  }
  collector.addJson('evidence-availability.json', { generatedAt: new Date().toISOString(), sources: availability,
    externalEvidence: ['Billing disputes require provider transaction/refund records correlated with request/job IDs.', 'Another computer or external game requires its own logs, environment and the exact exported artifact.', 'A native dump may establish a native failure; an unconfirmed exit alone cannot distinguish a crash from system termination.'] })
}
