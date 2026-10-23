import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export async function bundledFfmpegEntries(root) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  if (metadata.dependencies?.['ffmpeg-static']) {
    return ['resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe']
  }

  // In 1.5 the media runtime is an independently installed feature. Do not
  // silently excuse a missing production dependency in the 1.4 layout.
  const manifest = await fs.readFile(path.join(root, 'feature-plugins/media-runtime/manifest.json'), 'utf8')
    .then(JSON.parse).catch(() => null)
  if (manifest?.id !== 'media-runtime' || manifest.nativeBinaries?.ffmpeg !== 'ffmpeg-static') {
    throw new Error('FFmpeg packaging declaration is missing. Restore the production dependency or the media-runtime feature declaration.')
  }
  const studios = JSON.parse(await fs.readFile(path.join(root, 'src/shared/bundledStudios.json'), 'utf8'))
  return studios.includes(manifest.id) ? ['resources/bundled-studios/media-runtime/assets/native/ffmpeg.exe'] : []
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function failure(result) {
  return result.error?.message || result.stderr?.toString().trim().slice(0, 1000) || `exit ${result.status}`
}

export async function verifyFfmpegExecutable(file) {
  const handle = await fs.open(file, 'r').catch(() => {
    throw new Error(`FFmpeg executable is missing: ${file}`)
  })
  try {
    const header = Buffer.alloc(2)
    const { bytesRead } = await handle.read(header, 0, 2, 0)
    if (bytesRead !== 2 || header.toString() !== 'MZ') throw new Error(`Invalid Windows FFmpeg executable: ${file}`)
  } finally {
    await handle.close()
  }
  const options = { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }
  const version = spawnSync(file, ['-version'], options)
  if (version.error || version.status !== 0 || !/^ffmpeg version /m.test(version.stdout?.toString() ?? '')) {
    throw new Error(`FFmpeg cannot run: ${file}: ${failure(version)}`)
  }
  const audio = spawnSync(file, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1',
    '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'
  ], options)
  if (audio.error || audio.status !== 0 || audio.stdout?.length < 44 || audio.stdout?.subarray(0, 4).toString() !== 'RIFF') {
    throw new Error(`FFmpeg audio conversion failed: ${file}: ${failure(audio)}`)
  }
  return { version: version.stdout.toString().split(/\r?\n/)[0], audioBytes: audio.stdout.length }
}

export async function verifyBuildFfmpeg(root, { repair = false } = {}) {
  const entries = await bundledFfmpegEntries(root)
  if (!entries.length) return { bundled: false, reason: 'FFmpeg is supplied by the separate media-runtime feature.' }
  const directory = path.join(root, 'node_modules/ffmpeg-static')
  const binary = path.join(directory, 'ffmpeg.exe')
  const missing = await fs.stat(binary).then(() => false, error => {
    if (error.code !== 'ENOENT') throw error
    return true
  })
  if (missing && repair) {
    const installer = path.join(directory, 'install.js')
    await fs.access(installer).catch(() => { throw new Error('ffmpeg-static is not installed. Run npm ci in this workspace first.') })
    console.log('FFmpeg is missing; downloading it with the ffmpeg-static installer...')
    // Pin the destination: an inherited FFMPEG_BIN must not download only to an
    // external host path that electron-builder will never include.
    const result = spawnSync(process.execPath, [installer], {
      cwd: directory, windowsHide: true, timeout: 180000, stdio: 'inherit',
      env: { ...process.env, FFMPEG_BIN: binary, npm_config_platform: 'win32', npm_config_arch: process.arch }
    })
    if (result.error || result.status !== 0) throw new Error(`FFmpeg download failed (${failure(result)}). Check the network and run the BAT again.`)
  }
  const result = await verifyFfmpegExecutable(binary)
  return { bundled: true, repaired: missing && repair, ...result }
}

export async function verifyInstallerFfmpeg(root, installer) {
  const entries = await bundledFfmpegEntries(root)
  if (!entries.length) return { bundled: false, reason: 'FFmpeg is supplied by the separate media-runtime feature.' }
  const sevenZip = require('7zip-bin')
  const expectedHash = await sha256(path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe'))
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ffmpeg-release-'))
  try {
    const results = []
    for (const entry of entries) {
      const extracted = spawnSync(sevenZip.path7za, ['x', '-so', '-bsp0', path.resolve(installer), entry], {
        windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024
      })
      // 7-Zip may report success with empty output for an absent entry.
      if (extracted.error || extracted.status !== 0 || !extracted.stdout?.length) {
        throw new Error(`FFmpeg is missing or unreadable in the actual installer: ${entry}: ${failure(extracted)}`)
      }
      const hash = createHash('sha256').update(extracted.stdout).digest('hex')
      if (hash !== expectedHash) throw new Error(`FFmpeg in the installer differs from the build dependency: ${entry}`)
      const binary = path.join(temporary, 'ffmpeg.exe')
      await fs.writeFile(binary, extracted.stdout)
      const probe = await verifyFfmpegExecutable(binary)
      results.push({ entry, size: extracted.stdout.length, sha256: hash, ...probe })
    }
    return { bundled: true, files: results }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..')
  try {
    const index = process.argv.indexOf('--installer')
    if (index >= 0 && !process.argv[index + 1]) throw new Error('--installer requires an installer path')
    const result = index >= 0
      ? await verifyInstallerFfmpeg(root, process.argv[index + 1])
      : await verifyBuildFfmpeg(root, { repair: process.argv.includes('--repair') })
    console.log(JSON.stringify({ ffmpeg: 'verified', ...result }, null, 2))
  } catch (error) {
    console.error(`[ERROR] ${error.message}`)
    process.exitCode = 1
  }
}
