import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { path7za } from '7zip-bin'
import { managedCodexExecutablePath } from './codexSetup'

const execute = promisify(execFile)
async function version(executable: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execute(executable, args, { timeout: 5000, maxBuffer: 64000, windowsHide: true })
    return `${stdout}\n${stderr}`.trim().split('\n').filter(Boolean).slice(0, 3).join('\n')
  } catch (error) { return `unavailable: ${(error as NodeJS.ErrnoException).code ?? 'probe-failed'}` }
}
async function signatureSummary(executable: string): Promise<string> {
  const bundle = path.resolve(executable, '../../..')
  try {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 15000 })
    const { stderr } = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { timeout: 5000 })
    return `verified\n${stderr.split('\n').filter(line => /^(Authority|TeamIdentifier|CodeDirectory|Signature)=/.test(line)).join('\n')}`
  } catch { return 'unsigned-or-invalid' }
}
export async function nativeToolDiagnostics(userData: string, packaged: boolean, executable: string) {
  const unpack = (file: string): string => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const [ffmpegVersion, sevenZip, codex, signature] = await Promise.all([
    ffmpeg ? version(unpack(ffmpeg), ['-version']) : 'unavailable',
    version(unpack(path7za), ['i']),
    Promise.resolve().then(() => version(managedCodexExecutablePath(userData), ['--version'])).catch(() => 'unsupported'),
    process.platform === 'darwin' && packaged
      ? signatureSummary(executable)
      : 'not-applicable'
  ])
  return { platform: process.platform, arch: process.arch, signature, sharp: sharp.versions, ffmpeg: ffmpegVersion, sevenZip, codex }
}
