import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { installServerRuntime, type ServerRuntimeInstallOptions, type ServerRuntimeResult } from './serverPackService'
import type { ProjectInfo } from '../shared/types'

/** Share only the fixed-version runtime, never mods, worlds or session configuration. */
export async function installFixtureRuntime(cacheRoot: string, options: ServerRuntimeInstallOptions, project: ProjectInfo): Promise<ServerRuntimeResult> {
  options.signal?.throwIfAborted()
  const key = createHash('sha256').update(JSON.stringify([project.minecraftVersion, project.loader, project.loaderVersion, process.platform, process.arch])).digest('hex')
  await fs.mkdir(cacheRoot, { recursive: true })
  const root = path.join(cacheRoot, key)
  const existing = await fs.stat(root).then(stat => stat.isDirectory()).catch(() => false)
  if (!existing) {
    const staging = `${root}.staging-${randomUUID()}`
    await fs.mkdir(staging)
    try {
      await installServerRuntime({ ...options, serverPack: { ...options.serverPack, root: staging } }, project)
      options.signal?.throwIfAborted()
      await fs.rename(staging, root)
    } finally { await fs.rm(staging, { recursive: true, force: true }) }
  }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    options.signal?.throwIfAborted()
    if (!['libraries', 'server.jar', 'run.bat', 'run.sh', 'user_jvm_args.txt', '.modmind-server-runtime.json'].includes(entry.name) && !/^minecraft_server.*\.jar$|^forge.*\.jar$/.test(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error('服务端运行时缓存包含符号链接')
    await fs.cp(path.join(root, entry.name), path.join(options.serverPack.root, entry.name), { recursive: true, filter: async source => {
      if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('服务端运行时缓存包含符号链接')
      return true
    } })
  }
  await fs.utimes(root, new Date(), new Date())
  const caches = await Promise.all((await fs.readdir(cacheRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).map(async entry => ({ name: entry.name, time: (await fs.stat(path.join(cacheRoot, entry.name))).mtimeMs })))
  caches.sort((a, b) => b.time - a.time)
  for (const entry of caches.slice(4)) await fs.rm(path.join(cacheRoot, entry.name), { recursive: true, force: true })
  const runtime = await installServerRuntime(options, project)
  if (project.loader === 'forge' || project.loader === 'neoforge') {
    const script = path.join(options.serverPack.root, process.platform === 'win32' ? 'run.bat' : 'run.sh')
    const content = await fs.readFile(script, 'utf8').catch(() => '')
    const argumentFile = content.match(/@(libraries\/[0-9A-Za-z_./+-]+\/(?:win|unix)_args\.txt)/)?.[1]
    if (argumentFile) {
      const file = path.resolve(options.serverPack.root, argumentFile)
      if (!file.startsWith(`${path.resolve(options.serverPack.root)}${path.sep}`) || !(await fs.stat(file)).isFile()) throw new Error('生成的服务端参数文件无效')
      // Invoke Java directly: Forge's Windows launcher pauses even after a clean shutdown.
      return { ...runtime, javaPath: options.javaPath, launchCommand: [options.javaPath, '-Xms512M', '-Xmx2G', `@${argumentFile}`, 'nogui'], windowsVerbatimArguments: false }
    }
  }
  return { ...runtime, javaPath: options.javaPath }
}
