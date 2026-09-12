import { promises as fs } from 'node:fs'
import path from 'node:path'
import extractZip from 'extract-zip'
import type { ProjectInfo } from '../shared/types'
import { fetchTextWithRetry } from './networkRequest'
import { verifiedDownload } from './downloadService'
import { spawnManaged, terminateProcessTree } from './processTree'
import { windowsCmdInvocation } from './windowsCommand'
import { managedJavaEnvironment } from './javaEnvironment'
import { throwIfAborted } from './asyncControl'
import { installToolDirectory, withToolInstallLock } from './managedToolInstall'

export async function buildMavenPlugin(project: ProjectInfo, options: { javaPath: string; cacheRoot: string; signal?: AbortSignal; onOutput: (text: string) => void }): Promise<void> {
  const version = '3.9.9'
  const directory = path.resolve(options.cacheRoot, `apache-maven-${version}`)
  const executable = path.join(directory, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn')
  await withToolInstallLock(directory, options.signal, async () => {
    const required = ['bin/mvn', 'bin/mvn.cmd', 'boot/plexus-classworlds-2.8.0.jar']
    const complete = await Promise.all([...required, '.modmind-complete'].map(file => fs.stat(path.join(directory, file)).then(stat => stat.isFile()).catch(() => false)))
    if (!complete.every(Boolean)) {
      const url = `https://archive.apache.org/dist/maven/maven-3/${version}/binaries/apache-maven-${version}-bin.zip`
      const checksum = (await fetchTextWithRetry(`${url}.sha512`, { signal: options.signal })).trim().match(/[a-f0-9]{128}/i)?.[0]
      if (!checksum) throw new Error('Maven 官方 SHA-512 校验值无效')
      await fs.mkdir(options.cacheRoot, { recursive: true })
      const archive = path.join(options.cacheRoot, `apache-maven-${version}.zip`)
      await verifiedDownload.download({ sources: [{ id: 'apache', label: 'Apache Maven', url }], destination: archive, expectedHash: { algorithm: 'sha512', value: checksum }, signal: options.signal })
      await installToolDirectory(directory, options.signal, async stage => { await extractZip(archive, { dir: stage }); return path.join(stage, `apache-maven-${version}`) }, required)
    }
  })
  if (options.signal) throwIfAborted(options.signal)
  const args = ['--batch-mode', '--no-transfer-progress', 'package']
  const invocation = process.platform === 'win32' ? windowsCmdInvocation(executable, args) : { command: executable, args, windowsVerbatimArguments: false }
  const logRoot = path.join(project.path, '.modmind/builds')
  await fs.mkdir(logRoot, { recursive: true })
  let output = ''
  const child = spawnManaged(invocation.command, invocation.args, { cwd: project.path, windowsHide: true, shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'], env: managedJavaEnvironment({ ...process.env, JAVA_HOME: path.dirname(path.dirname(options.javaPath)) }) })
  const capture = (chunk: Buffer): void => { const text = chunk.toString('utf8'); output = (output + text).slice(-2_000_000); options.onOutput(text) }
  child.stdout?.on('data', capture); child.stderr?.on('data', capture)
  const abort = (): void => { void terminateProcessTree(child).catch(() => undefined) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    await fs.writeFile(path.join(logRoot, 'maven-build.log'), output)
    if (options.signal) throwIfAborted(options.signal)
    if (code !== 0) throw new Error(`Maven 构建失败：${output.slice(-4000)}\n完整日志：.modmind/builds/maven-build.log`)
  } finally { options.signal?.removeEventListener('abort', abort) }
}
