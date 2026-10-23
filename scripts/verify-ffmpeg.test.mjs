import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sevenZip from '7zip-bin'
import { bundledFfmpegEntries, verifyBuildFfmpeg, verifyInstallerFfmpeg } from './verify-ffmpeg.mjs'

const repository = path.resolve(import.meta.dirname, '..')
const actualBinary = path.join(repository, 'node_modules/ffmpeg-static/ffmpeg.exe')
const windows = { skip: process.platform !== 'win32' }

async function fixture(t, { external = false, bundled = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ffmpeg-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  await fs.mkdir(path.join(root, 'node_modules/ffmpeg-static'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    version: '1.4.20', dependencies: external ? {} : { 'ffmpeg-static': '5.3.0' }
  }))
  if (external) {
    await fs.mkdir(path.join(root, 'feature-plugins/media-runtime'), { recursive: true })
    await fs.writeFile(path.join(root, 'feature-plugins/media-runtime/manifest.json'), JSON.stringify({
      id: 'media-runtime', nativeBinaries: { ffmpeg: 'ffmpeg-static' }
    }))
    await fs.mkdir(path.join(root, 'src/shared'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/shared/bundledStudios.json'), JSON.stringify(bundled ? ['media-runtime'] : []))
  }
  return root
}

async function installBinary(root) {
  await fs.copyFile(actualBinary, path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe'))
}

async function archive(root, entry, contents) {
  const payload = path.join(root, 'payload')
  const target = path.join(payload, entry ?? 'resources/unrelated.txt')
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (entry && contents === undefined) await fs.copyFile(actualBinary, target)
  else await fs.writeFile(target, contents ?? 'not an FFmpeg payload')
  const installer = path.join(root, 'fixture.exe')
  const result = spawnSync(sevenZip.path7za, ['a', '-t7z', '-mx=0', installer, 'resources'], {
    cwd: payload, windowsHide: true, encoding: 'utf8', timeout: 30000
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return installer
}

test('missing local executable blocks packaging even when the npm package directory exists', windows, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'node_modules/ffmpeg-static/package.json'), '{"version":"5.3.0"}')
  await assert.rejects(verifyBuildFfmpeg(root), /FFmpeg executable is missing/)
})

test('failed FFmpeg download blocks packaging', windows, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'node_modules/ffmpeg-static/install.js'), 'process.exit(42)')
  await assert.rejects(verifyBuildFfmpeg(root, { repair: true }), /FFmpeg download failed.*42/)
})

test('successful installer exit cannot hide a still-missing executable', windows, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'node_modules/ffmpeg-static/install.js'), 'process.exit(0)')
  await assert.rejects(verifyBuildFfmpeg(root, { repair: true }), /FFmpeg executable is missing/)
})

test('repair writes to the bundled dependency and verifies actual audio conversion', windows, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'node_modules/ffmpeg-static/install.js'),
    `require('node:fs').copyFileSync(${JSON.stringify(actualBinary)}, process.env.FFMPEG_BIN)`)
  const result = await verifyBuildFfmpeg(root, { repair: true })
  assert.equal(result.repaired, true)
  assert.match(result.version, /^ffmpeg version /)
  assert.ok(result.audioBytes > 44)
})

test('corrupt executable is rejected without overwriting it', windows, async t => {
  const root = await fixture(t)
  const binary = path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe')
  await fs.writeFile(binary, 'broken executable')
  await assert.rejects(verifyBuildFfmpeg(root, { repair: true }), /Invalid Windows FFmpeg executable/)
  assert.equal(await fs.readFile(binary, 'utf8'), 'broken executable')
})

test('a file with only a Windows executable header cannot pass the runtime check', windows, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1024)]))
  await assert.rejects(verifyBuildFfmpeg(root), /FFmpeg cannot run/)
})

test('installer without FFmpeg is rejected despite a healthy loose build dependency', windows, async t => {
  const root = await fixture(t)
  await installBinary(root)
  await assert.rejects(verifyInstallerFfmpeg(root, await archive(root)), /missing or unreadable in the actual installer/)
})

test('installer with different FFmpeg bytes is rejected', windows, async t => {
  const root = await fixture(t)
  await installBinary(root)
  const [entry] = await bundledFfmpegEntries(root)
  await assert.rejects(verifyInstallerFfmpeg(root, await archive(root, entry, 'MZbroken')), /differs from the build dependency/)
})

test('verified installer runs its extracted FFmpeg and converts audio', windows, async t => {
  const root = await fixture(t)
  await installBinary(root)
  const [entry] = await bundledFfmpegEntries(root)
  const result = await verifyInstallerFfmpeg(root, await archive(root, entry))
  assert.equal(result.bundled, true)
  assert.ok(result.files[0].audioBytes > 44)
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/)
})

test('separate 1.5 media feature is not mistaken for a missing core dependency', async t => {
  const root = await fixture(t, { external: true })
  assert.equal((await verifyBuildFfmpeg(root)).bundled, false)
})

test('bundled media feature requires FFmpeg at its actual resource path', async t => {
  const root = await fixture(t, { external: true, bundled: true })
  assert.deepEqual(await bundledFfmpegEntries(root), ['resources/bundled-studios/media-runtime/assets/native/ffmpeg.exe'])
})

test('removing the 1.4 production dependency cannot silently disable the check', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'package.json'), '{"devDependencies":{"ffmpeg-static":"5.3.0"}}')
  await assert.rejects(verifyBuildFfmpeg(root), /packaging declaration is missing/)
})

async function runBat(t, { preflight = 0, version = 0, build = 0, input = '1.4.21' } = {}) {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'scripts'))
  await fs.copyFile(path.join(repository, 'build-unsigned.bat'), path.join(root, 'build-unsigned.bat'))
  await fs.writeFile(path.join(root, 'scripts/verify-ffmpeg.mjs'), `process.exit(${preflight})`)
  await fs.writeFile(path.join(root, 'npm.cmd'), [
    '@echo off', 'echo %*>>"%MODMIND_BAT_TEST_LOG%"',
    `if "%1"=="version" exit /b ${version}`, `exit /b ${build}`, ''
  ].join('\r\n'))
  const log = path.join(root, 'npm-calls.txt')
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'build-unsigned.bat'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000, input: `${input}\r\n\r\n`,
    env: { ...process.env, NODE_PATH: path.join(repository, 'node_modules'), MODMIND_BAT_TEST_LOG: log }
  })
  assert.equal(result.error, undefined)
  return { ...result, calls: await fs.readFile(log, 'utf8').catch(() => '') }
}

test('BAT stops before changing the version when the preflight fails', windows, async t => {
  const result = await runBat(t, { preflight: 1 })
  assert.equal(result.status, 1)
  assert.equal(result.calls, '')
  assert.doesNotMatch(result.stdout, /\[DONE\]/)
})

test('BAT stops when npm version fails', windows, async t => {
  const result = await runBat(t, { version: 7 })
  assert.equal(result.status, 1)
  assert.match(result.calls, /version "1\.4\.21"/)
  assert.doesNotMatch(result.calls, /run dist/)
})

test('BAT never reports success when packaging or installer verification fails', windows, async t => {
  const result = await runBat(t, { build: 9 })
  assert.equal(result.status, 1)
  assert.match(result.calls, /run dist:win:unsigned/)
  assert.doesNotMatch(result.stdout, /\[DONE\]/)
})

test('BAT validates version input before using it in shell commands', windows, async t => {
  const result = await runBat(t, { input: '1.4.21 & echo SHOULD_NOT_RUN' })
  assert.equal(result.status, 1)
  assert.equal(result.calls, '')
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/)
})

test('BAT reports success only after the packaging command succeeds', windows, async t => {
  const result = await runBat(t)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\[DONE\]/)
  assert.match(result.stdout, /Verified upload directory: .*release\\update/)
})
