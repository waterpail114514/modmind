import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { macArtifactNames, assertMacArchitecture, sha256 } from './macos-release-policy.mjs'

if (process.platform !== 'darwin') throw new Error('macOS release verification requires macOS')
function option(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const arch = option('--arch', process.arch)
const release = path.resolve(option('--output', 'release'))
const unsigned = process.argv.includes('--allow-unsigned')
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'))
const names = macArtifactNames(version, arch)
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
  return `${result.stdout}\n${result.stderr}`.trim()
}
function verifyApp(appPath) {
  const plist = path.join(appPath, 'Contents/Info.plist')
  if (run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]) !== version) throw new Error('Bundle version mismatch')
  const executable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])
  assertMacArchitecture(run('/usr/bin/lipo', ['-archs', path.join(appPath, 'Contents/MacOS', executable)]), arch)
  if (!run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleURLTypes', plist]).includes('mcdev')) throw new Error('Missing mcdev protocol')
  if (!unsigned) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    const identity = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
    if (!identity.includes('Authority=Developer ID Application:') || !/flags=.*runtime/.test(identity)) throw new Error('Missing Developer ID or Hardened Runtime')
    if (!process.env.APPLE_TEAM_ID || !identity.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`)) throw new Error('Signing Team ID mismatch or missing expected APPLE_TEAM_ID')
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  }
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ModMind 验证 '))
const mount = path.join(temporary, 'mounted')
let mounted = false
try {
  for (const name of names) {
    const file = path.join(release, name)
    if ((await fs.stat(file)).size < 10 * 1024 * 1024) throw new Error(`Implausibly small artifact: ${name}`)
  }
  const unpacked = path.join(temporary, 'zip')
  run('/usr/bin/ditto', ['-x', '-k', path.join(release, names[1]), unpacked])
  verifyApp(path.join(unpacked, 'ModMind.app'))
  await fs.mkdir(mount)
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(release, names[0])])
  mounted = true
  verifyApp(path.join(mount, 'ModMind.app'))
  if (!unsigned) {
    run('/usr/bin/codesign', ['--verify', '--strict', path.join(release, names[0])])
    run('/usr/bin/xcrun', ['stapler', 'validate', path.join(release, names[0])])
  }
  const sums = await Promise.all(names.sort().map(async name => `${await sha256(path.join(release, name))}  ${name}`))
  await fs.writeFile(path.join(release, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  console.log(JSON.stringify({ version, arch, signed: !unsigned, artifacts: names }))
} finally {
  if (mounted) run('/usr/bin/hdiutil', ['detach', mount])
  await fs.rm(temporary, { recursive: true, force: true })
}
