const fs = require('node:fs/promises')
const path = require('node:path')
const { Arch } = require('builder-util')

// Runs before signing. Never repair permissions or prune files after signing.
module.exports = async function prepareMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = Arch[context.arch]
  const modules = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources/app.asar.unpacked/node_modules')
  const sevenZip = path.join(modules, '7zip-bin')
  await fs.chmod(path.join(sevenZip, 'mac', arch, '7za'), 0o755)
  await fs.chmod(path.join(modules, 'ffmpeg-static/ffmpeg'), 0o755)
  for (const platform of ['win', 'linux']) await fs.rm(path.join(sevenZip, platform), { recursive: true, force: true })
  await fs.rm(path.join(sevenZip, 'mac', arch === 'arm64' ? 'x64' : 'arm64'), { recursive: true, force: true })
}
