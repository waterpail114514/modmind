import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exercise native modules with the shipped executable, not the development Electron. */
export async function verifyWinNative(appOutDir, executableName = 'ModMind Plugin Test.exe') {
  const executable = path.join(appOutDir, executableName)
  const script = `
const { createRequire } = require('node:module');
const path = require('node:path');
const requireApp = createRequire(path.join(${JSON.stringify(appOutDir)}, 'resources/app.asar/package.json'));
(async () => {
  const sharp = requireApp('sharp');
  const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#339988' } }).resize(8, 8).png().toBuffer();
  const metadata = await sharp(image).metadata();
  if (metadata.width !== 8 || metadata.height !== 8) throw Error('Sharp round-trip failed');
  const unpack = file => file.replace(/app\\.asar([\\\\/])/, 'app.asar.unpacked$1');
  const { execFileSync } = require('node:child_process');
  const sevenZip = execFileSync(unpack(requireApp('7zip-bin').path7za), [], { windowsHide: true, encoding: 'utf8' });
  if (!sevenZip.includes('7-Zip')) throw Error('7-Zip probe failed');
  console.log(JSON.stringify({ success: true, executable: process.execPath, electron: process.versions.electron, arch: process.arch, sharp: sharp.versions.sharp, vips: sharp.versions.vips, image: { width: metadata.width, height: metadata.height } }));
})().catch(error => { console.error(error); process.exitCode = 1 });`
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.ELECTRON_RENDERER_URL
  return await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const child = spawn(executable, ['-e', script], { cwd: appOutDir, windowsHide: true, env })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged native verification timed out')) }, 30000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', code => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`Packaged native verification failed (${code}): ${stderr}\n${stdout}`))
      else { try { const result = JSON.parse(stdout.trim()); if (!result.success) throw new Error('Missing successful report'); resolve(result) } catch (error) { reject(error) } }
    })
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyWinNative(path.resolve(process.argv[2] || 'release/1.5.0-plugintest/win-unpacked')), null, 2))
}
