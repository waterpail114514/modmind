import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { verifyInstallerUpdateConfig } from './verify-update-config.mjs'

async function linkOrCopy(source, destination) {
  try {
    await fs.link(source, destination)
  } catch {
    await fs.copyFile(source, destination)
  }
}

export async function prepareUpdateArtifacts(root) {
  const releaseRoot = path.resolve(root, 'release')
  const updateRoot = path.join(releaseRoot, 'update')
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const version = String(packageJson.version)
  const prerelease = version.split('+')[0].includes('-')
  const metadataName = prerelease ? 'beta.yml' : 'latest.yml'
  const installerName = `ModMind Setup ${version}.exe`
  const artifactName = `ModMind-Setup-${version}.exe`
  if (path.posix.basename(installerName) !== installerName || path.win32.basename(installerName) !== installerName) {
    throw new Error(`Unsafe update artifact version: ${version}`)
  }

  const sourceInstaller = path.join(releaseRoot, installerName)
  const sourceBlockmap = `${sourceInstaller}.blockmap`
  const installerStat = await fs.stat(sourceInstaller)
  const blockmapStat = await fs.stat(sourceBlockmap)
  if (!installerStat.isFile() || installerStat.size === 0) throw new Error('Installer is missing or empty')
  if (!blockmapStat.isFile() || blockmapStat.size < 1024) throw new Error('Installer blockmap is missing or too small')

  const services = JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8'))
  verifyInstallerUpdateConfig(sourceInstaller, services.updateUrl)

  // Server metadata is separate from the embedded app-update.yml checked above.
  // Derive it from this version's verified installer, never from a previous
  // build's latest.yml or a publish provider's channel defaults.
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(sourceInstaller)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const metadataText = stringify({
    version,
    files: [{ url: artifactName, sha512, size: installerStat.size }],
    path: artifactName,
    sha512,
    releaseDate: installerStat.mtime.toISOString()
  })

  await fs.rm(updateRoot, { recursive: true, force: true })
  await fs.mkdir(updateRoot, { recursive: true })
  await linkOrCopy(sourceInstaller, path.join(updateRoot, artifactName))
  await linkOrCopy(sourceBlockmap, path.join(updateRoot, `${artifactName}.blockmap`))
  await fs.writeFile(path.join(updateRoot, metadataName), metadataText, 'utf8')
  await fs.writeFile(path.join(releaseRoot, metadataName), metadataText, 'utf8')

  const uploadFiles = [metadataName, artifactName, `${artifactName}.blockmap`]
  return { version, channel: prerelease ? 'beta' : 'stable', uploadDirectory: updateRoot, uploadFiles }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareUpdateArtifacts(path.resolve(import.meta.dirname, '..'))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
