import { app, type BrowserWindow } from 'electron'
import { promises as fs, constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { path7za } from '7zip-bin'
import { ensureManagedCodexRuntime } from './codexSetup'
import { probeCodexExecutable } from './codexExecutable'
import { ensureManagedJdk } from './jdkDownload'

const execute = promisify(execFile)
const unpack = (file: string): string => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

/** Invoked only by the explicit packaged-app CI smoke command. */
export async function runPackagedNativeSmoke(window: BrowserWindow, root: string): Promise<void> {
  if (!app.isPackaged || process.platform !== 'darwin' || !path.isAbsolute(root)) throw new Error('Smoke test requires a packaged macOS application and an absolute output directory')
  await fs.mkdir(root, { recursive: true })
  const timeout = Date.now() + 60000
  let platform: { os?: string; arch?: string; node?: string } | undefined
  while (Date.now() < timeout) {
    platform = await window.webContents.executeJavaScript('window.modmind ? ({...window.modmind.app.getPlatformInfo(), node: typeof require}) : undefined').catch(() => undefined)
    if (platform) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (platform?.os !== 'macos' || platform.arch !== process.arch || platform.node !== 'undefined') throw new Error('Preload or renderer isolation failed')
  await fs.access(path.join(process.resourcesPath, 'blockbench/index.html'))
  await fs.access(path.join(app.getAppPath(), 'out/renderer/minipaint/index.html'))
  const png = path.join(root, 'image.png')
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#369' } }).resize(4, 4).png().toFile(png)
  if ((await sharp(png).metadata()).width !== 4) throw new Error('Sharp resize failed')
  if (!ffmpeg) throw new Error('Missing FFmpeg')
  const ffmpegExecutable = unpack(ffmpeg)
  const sevenZip = unpack(path7za)
  const expectedArch = process.arch === 'x64' ? 'x86_64' : 'arm64'
  for (const executable of [ffmpegExecutable, sevenZip]) {
    await fs.access(executable, constants.X_OK)
    const { stdout } = await execute('/usr/bin/lipo', ['-archs', executable])
    if (stdout.trim() !== expectedArch) throw new Error(`Native binary architecture mismatch: ${executable}: ${stdout}`)
  }
  const ffmpegVersion = (await execute(ffmpegExecutable, ['-version'])).stdout.split('\n')[0]
  await execute(ffmpegExecutable, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', path.join(root, 'audio.wav')])
  const archive = path.join(root, 'sample.7z')
  await execute(sevenZip, ['a', '-y', archive, png])
  await execute(sevenZip, ['l', archive])
  await execute(sevenZip, ['x', '-y', archive, `-o${path.join(root, 'extracted')}`])
  if (!(await fs.readFile(png)).equals(await fs.readFile(path.join(root, 'extracted/image.png')))) throw new Error('7-Zip round trip failed')
  const codex = await ensureManagedCodexRuntime({ rootDir: root })
  const codexVersion = await probeCodexExecutable(codex)
  const jdk = await ensureManagedJdk(path.join(root, 'jdk'), 21)
  const java = path.join(jdk.home, 'bin/java')
  const javaVersion = (await execute(java, ['-version'])).stderr
  await execute(path.join(jdk.home, 'bin/javac'), ['-version'])
  const project = path.join(root, 'Gradle 中文 project')
  await fs.mkdir(path.join(project, 'gradle/wrapper'), { recursive: true })
  const wrapper = path.join(process.resourcesPath, 'gradle-wrapper')
  await fs.copyFile(path.join(wrapper, 'gradlew'), path.join(project, 'gradlew'))
  await fs.chmod(path.join(project, 'gradlew'), 0o755)
  await fs.copyFile(path.join(wrapper, 'gradle-wrapper.jar'), path.join(project, 'gradle/wrapper/gradle-wrapper.jar'))
  await fs.writeFile(path.join(project, 'gradle/wrapper/gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n')
  await fs.writeFile(path.join(project, 'build.gradle'), "plugins { id 'java' }\n")
  await execute(path.join(project, 'gradlew'), ['--no-daemon', 'build'], { cwd: project, timeout: 600000, env: { ...process.env, JAVA_HOME: jdk.home, GRADLE_USER_HOME: path.join(root, 'gradle-cache') } })
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ success: true, platform: process.platform, arch: process.arch, version: app.getVersion(), electron: process.versions.electron, sharp: sharp.versions, ffmpeg: ffmpegVersion, codex: codexVersion, java: javaVersion }, null, 2))
}
