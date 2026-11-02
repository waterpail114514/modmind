import { promises as fs } from 'node:fs'
import path from 'node:path'
import extractZip from './safeExtractZip'
import type { ProjectInfo } from '../shared/types'
import { verifiedDownload } from './downloadService'
import { spawnManaged, terminateProcessTree } from './processTree'
import { windowsCmdInvocation } from './windowsCommand'
import { managedJavaEnvironment } from './javaEnvironment'
import { throwIfAborted } from './asyncControl'
import { installToolDirectory, withToolInstallLock } from './managedToolInstall'

// Apache's published SHA-512 for the pinned 3.9.9 binary ZIP. Metadata is not
// fetched from an overseas host before every first installation.
const MAVEN_SHA512 = '8beac8d11ef208f1e2a8df0682b9448a9a363d2ad13ca74af43705549e72e74c9378823bf689287801cbbfc2f6ea9596201d19ccacfdfb682ee8a2ff4c4418ba'
export const MAVEN_MIRROR_SETTINGS = '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><mirrors><mirror><id>modmind-central</id><mirrorOf>central</mirrorOf><url>https://repo.huaweicloud.com/repository/maven/</url></mirror></mirrors></settings>'

export async function buildMavenPlugin(project: ProjectInfo, options: { javaPath: string; cacheRoot: string; official?: boolean; signal?: AbortSignal; onOutput: (text: string) => void }): Promise<void> {
  const version = '3.9.9'
  const directory = path.resolve(options.cacheRoot, `apache-maven-${version}`)
  const executable = path.join(directory, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn')
  await withToolInstallLock(directory, options.signal, async () => {
    const required = ['bin/mvn', 'bin/mvn.cmd', 'boot/plexus-classworlds-2.8.0.jar']
    const complete = await Promise.all([...required, '.modmind-complete'].map(file => fs.stat(path.join(directory, file)).then(stat => stat.isFile()).catch(() => false)))
    if (!complete.every(Boolean)) {
      const url = `https://archive.apache.org/dist/maven/maven-3/${version}/binaries/apache-maven-${version}-bin.zip`
      await fs.mkdir(options.cacheRoot, { recursive: true })
      const archive = path.join(options.cacheRoot, `apache-maven-${version}.zip`)
      await verifiedDownload.download({ sources: [...(options.official ? [] : [{ id: 'huawei', label: '华为云 Maven 工具镜像', url: `https://repo.huaweicloud.com/apache/maven/maven-3/${version}/binaries/apache-maven-${version}-bin.zip` }]), { id: 'apache', label: 'Apache Maven', url }], destination: archive, expectedHash: { algorithm: 'sha512', value: MAVEN_SHA512 }, resume: true, signal: options.signal })
      await installToolDirectory(directory, options.signal, async stage => { await extractZip(archive, { dir: stage }); return path.join(stage, `apache-maven-${version}`) }, required)
    }
  })
  if (options.signal) throwIfAborted(options.signal)
  const mirrorSettings = path.join(options.cacheRoot, 'modmind-settings.xml')
  await fs.writeFile(mirrorSettings, MAVEN_MIRROR_SETTINGS)
  // Global settings merge with the user's settings; private server credentials
  // and explicit user mirrors retain Maven's normal precedence.
  for (const official of (options.official ? [true] : [false, true])) {
  options.signal?.throwIfAborted()
  const args = [...(official ? [] : ['--global-settings', mirrorSettings]), '--batch-mode', '--no-transfer-progress', 'package']
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
    await fs.writeFile(path.join(logRoot, official ? 'maven-build-official.log' : 'maven-build.log'), output)
    if (options.signal) throwIfAborted(options.signal)
    if (code !== 0 && !official && /repo\.huaweicloud\.com/.test(output) && /Could not (?:transfer|resolve)|timed? out|UnknownHost|Connection reset|status code: (?:404|408|429|5\d\d)/i.test(output)) { options.onOutput('Maven 镜像依赖获取失败，正在使用官方仓库重试一次\n'); continue }
    if (code !== 0) throw new Error(`Maven 构建失败：${output.slice(-4000)}\n完整日志：${path.join(logRoot, official ? 'maven-build-official.log' : 'maven-build.log')}`)
    return
  } finally { options.signal?.removeEventListener('abort', abort) }
  }
}
