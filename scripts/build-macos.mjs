import { build, Platform, Arch } from 'electron-builder'

const index = process.argv.indexOf('--arch')
const arch = index < 0 ? process.arch : process.argv[index + 1]
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || process.arch !== arch) {
  throw new Error('Build macOS on the matching native macOS architecture; reinstall dependencies with npm ci there')
}
const unsigned = process.argv.includes('--allow-unsigned')
if (unsigned) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
if (!unsigned) {
  for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (!process.env[key]) throw new Error(`Signed release requires ${key}; use --allow-unsigned only for test artifacts`)
  }
}
await build({
  targets: Platform.MAC.createTarget(['dmg', 'zip'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    afterPack: './scripts/prepare-macos-app.cjs',
    forceCodeSigning: !unsigned,
    dmg: { sign: !unsigned },
    mac: { ...(unsigned ? { identity: null, notarize: false } : { notarize: true }) }
  }
})
