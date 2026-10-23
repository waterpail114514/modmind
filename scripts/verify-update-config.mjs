import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import sevenZip from '7zip-bin'

function readInstallerFile(installer, name) {
  const result = spawnSync(sevenZip.path7za, ['x', '-so', '-bsp0', path.resolve(installer), name], {
    windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024
  })
  // 7-Zip can succeed with empty stdout when the requested entry is missing.
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    throw new Error(`Missing or unreadable ${name} in ${installer}. Rebuild with an explicit Windows publish configuration.`)
  }
  return result.stdout.toString('utf8')
}

function updateUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Packaged update URL must be an HTTPS base without credentials, query or fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

export function verifyInstallerUpdateConfig(installer, expectedUpdateUrl) {
  // Inspect the actual payload, not win-unpacked or source files left by another build.
  const config = parse(readInstallerFile(installer, 'resources/app-update.yml'))
  const services = JSON.parse(readInstallerFile(installer, 'resources/service-config.json'))
  if (config?.provider !== 'generic' || typeof config.url !== 'string') {
    throw new Error(`Invalid resources/app-update.yml in ${installer}: expected the explicit generic update provider`)
  }
  if (config.updaterCacheDirName !== 'modmind-updater') {
    throw new Error(`Invalid updaterCacheDirName in ${installer}: expected modmind-updater`)
  }
  const url = updateUrl(config.url)
  if (url !== updateUrl(services?.updateUrl) || url !== updateUrl(expectedUpdateUrl)) {
    throw new Error(`Update URL mismatch in ${installer}: app-update.yml, service-config.json and release configuration must agree`)
  }
  return { provider: config.provider, url, updaterCacheDirName: config.updaterCacheDirName }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..')
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const services = JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8'))
  const installer = process.argv[2] || path.join(root, 'release', `ModMind Setup ${version}.exe`)
  process.stdout.write(`${JSON.stringify(verifyInstallerUpdateConfig(installer, services.updateUrl), null, 2)}\n`)
}
