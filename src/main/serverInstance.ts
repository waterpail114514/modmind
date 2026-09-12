import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { throwIfAborted } from './asyncControl'

interface DeploymentManifest { version: 1; source: string; files: Record<string, string>; createdAt: string }
const manifestName = '.modmind-deployment.json'

async function hash(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function filesIn(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`服务端部署不接受符号链接：${entry.name}`)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await filesIn(root, relative))
    else if (entry.isFile() && entry.name !== manifestName) files.push(relative)
  }
  return files
}

export async function preserveLegacyServerInstance(projectRoot: string, output: string): Promise<void> {
  const expected = path.join(projectRoot, '.modmind', 'server-pack')
  if (path.resolve(output) !== path.resolve(expected)) return
  const files = await fs.readdir(expected).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  if (!files.some(file => ['world', 'world_nether', 'world_the_end', 'logs', 'usercache.json', 'ops.json'].includes(file))) return
  const target = path.join(projectRoot, '.modmind', 'server', 'instances', 'modpack')
  if (await fs.stat(target).then(() => true).catch(() => false)) return
  await filesIn(expected)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const stage = `${target}.legacy-${randomUUID()}`
  try { await fs.cp(expected, stage, { recursive: true }); await fs.rename(stage, target) }
  finally { await fs.rm(stage, { recursive: true, force: true }) }
}

export async function commitDirectory(staging: string, target: string): Promise<void> {
  if (path.dirname(path.resolve(staging)) !== path.dirname(path.resolve(target))) throw new Error('提交目录必须位于同一父目录')
  const backup = `${target}.backup-${randomUUID()}`
  const exists = await fs.stat(target).then(() => true).catch(() => false)
  if (exists) await fs.rename(target, backup)
  try { await fs.rename(staging, target) }
  catch (error) { if (exists) await fs.rename(backup, target); throw error }
  if (exists) await fs.rm(backup, { recursive: true, force: true })
}

/** Update owned files; preserve worlds and locally edited defaults across deployments. */
export async function deployServerInstance(source: string, target: string, signal?: AbortSignal): Promise<{ conflicts: string[] }> {
  const sourceRoot = path.resolve(source)
  const targetRoot = path.resolve(target)
  if (sourceRoot === targetRoot || sourceRoot.startsWith(`${targetRoot}${path.sep}`) || targetRoot.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('构建目录和运行实例必须分离')
  if (signal) throwIfAborted(signal)
  const existing = await fs.stat(targetRoot).then(() => true).catch(() => false)
  if (existing) await filesIn(targetRoot)
  const previous = await fs.readFile(path.join(targetRoot, manifestName), 'utf8').then(text => JSON.parse(text) as DeploymentManifest).catch(() => null)
  const staging = `${targetRoot}.staging-${randomUUID()}`
  await fs.mkdir(path.dirname(targetRoot), { recursive: true })
  await fs.mkdir(staging)
  const conflicts: string[] = []
  try {
    if (existing) await fs.cp(targetRoot, staging, { recursive: true })
    const next: DeploymentManifest = { version: 1, source: sourceRoot, files: {}, createdAt: new Date().toISOString() }
    const sourceFiles = await filesIn(sourceRoot)
    for (const relative of sourceFiles) {
      if (signal) throwIfAborted(signal)
      if (/^(?:world(?:_nether|_the_end)?|logs|crash-reports)\//.test(relative)) continue
      const sourcePath = path.join(sourceRoot, relative)
      const output = path.join(staging, relative)
      const currentHash = await hash(output)
      const nextHash = (await hash(sourcePath))!
      const previousHash = previous?.files?.[relative]
      const binary = relative === 'server.jar' || /^(?:mods|plugins)\/[^/]+\.jar$/i.test(relative)
      if (currentHash && currentHash !== nextHash && currentHash !== previousHash && !binary && !['modmind.server.json', '.modmind-server-runtime.json'].includes(relative)) {
        conflicts.push(relative)
        if (previousHash) next.files[relative] = previousHash
        continue
      }
      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.copyFile(sourcePath, output)
      next.files[relative] = nextHash
    }
    for (const [relative, previousHash] of Object.entries(previous?.files ?? {})) {
      if (sourceFiles.includes(relative)) continue
      const output = path.resolve(staging, relative)
      if (!output.startsWith(`${staging}${path.sep}`)) throw new Error('部署清单路径无效')
      if (await hash(output) === previousHash) await fs.rm(output, { force: true })
    }
    await fs.writeFile(path.join(staging, manifestName), JSON.stringify(next, null, 2))
    if (signal) throwIfAborted(signal)
    await commitDirectory(staging, targetRoot)
    return { conflicts }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}

export async function configureLocalServer(root: string, port: number, onlineMode: boolean, acceptEula: boolean): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('服务端端口无效')
  const target = path.join(root, 'server.properties')
  const content = await fs.readFile(target, 'utf8').catch(() => '')
  const settings: Record<string, string> = { 'server-ip': '127.0.0.1', 'server-port': String(port), 'online-mode': String(onlineMode) }
  const lines = content.split(/\r?\n/).filter(line => !Object.keys(settings).some(key => new RegExp(`^\\s*${key}\\s*[:=]`).test(line)))
  await fs.writeFile(target, [...lines, ...Object.entries(settings).map(([key, value]) => `${key}=${value}`)].join('\n'))
  if (acceptEula) await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n')
  else if (!/eula\s*=\s*true/.test(await fs.readFile(path.join(root, 'eula.txt'), 'utf8').catch(() => ''))) throw new Error('首次启动需要接受 Minecraft EULA')
}
