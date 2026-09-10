import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { macArtifactNames } from './macos-release-policy.mjs'

if (process.platform !== 'darwin') throw new Error('Notarization requires macOS')
for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) if (!process.env[name]) throw new Error(`Missing ${name}`)
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'))
const dmg = path.resolve('release', macArtifactNames(version, process.arch)[0])
const submit = spawnSync('xcrun', ['notarytool', 'submit', dmg, '--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER, '--wait', '--output-format', 'json'], { encoding: 'utf8', timeout: 1800000 })
if (submit.status !== 0 || JSON.parse(submit.stdout).status !== 'Accepted') throw new Error('DMG notarization was not accepted')
const staple = spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
if (staple.status !== 0) throw new Error('Could not staple the DMG ticket')
