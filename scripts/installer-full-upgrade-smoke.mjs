import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/installer-full-upgrade', String(Date.now()))
await fs.mkdir(work, { recursive: true })
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: work, env, windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => { child.kill(); reject(new Error('Process timed out: ' + command)) }, 60000)
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('exit', code => { clearTimeout(timer); if (code) reject(new Error(`${command} exited ${code}: ${output}`)); else resolve({ code, output, pid: child.pid }) })
})
const fixture = path.join(work, 'app'), install = path.join(work, 'installed')
await fs.mkdir(path.join(fixture, 'resources'), { recursive: true })
const productName = 'ModMind Upgrade Regression ' + path.basename(work)
const executable = path.join(fixture, productName + '.exe')
const nsis = path.join(os.homedir(), 'AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe')
const fixtureSource = path.join(work, 'fixture.nsi')
await fs.writeFile(fixtureSource, `Unicode true\nName "Upgrade fixture"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSectionEnd\n`)
await run(nsis, ['-INPUTCHARSET', 'UTF8', '-V2', fixtureSource])
const appDirectory = path.join(work, 'project')
await fs.mkdir(appDirectory)
await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'modmind-upgrade-regression-' + path.basename(work), version: '1.0.0', description: 'Isolated full installer upgrade test', author: 'ModMind', main: 'index.js' }))
const guid = 'e73a6d00-1234-4567-89ab-' + path.basename(work).slice(-12)
const installKey = `Software\\${guid}`
const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`
const { build, Platform } = require('electron-builder')
const inPlace = process.argv.includes('--in-place')
const installerTemp = path.join(os.homedir(), 'AppData/Local/Temp')
const installerEnvironment = { ...process.env, TEMP: installerTemp, TMP: installerTemp }
let uninstallPath
try {
  for (const version of ['1.0.0', '1.0.1']) {
    await fs.writeFile(path.join(fixture, 'resources/app.asar'), version)
    const output = path.join(work, version)
    await build({ projectDir: appDirectory, prepackaged: fixture, targets: Platform.WINDOWS.createTarget(['nsis'], 1), config: {
      extends: null, electronVersion: '33.4.11',
      appId: 'dev.modmind.test.upgrade.' + path.basename(work), productName, compression: 'normal',
      extraMetadata: { version }, directories: { output, buildResources: path.join(root, 'resources') },
      asar: false, artifactName: 'fixture-${version}.${ext}', publish: null,
      win: { signAndEditExecutable: false },
      nsis: { guid, oneClick: false, allowElevation: false, allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false, createStartMenuShortcut: false,
        useZip: true, differentialPackage: false, include: path.join(root, inPlace ? 'resources/installer-plugintest.nsh' : 'resources/installer.nsh') },
    } })
    const installer = path.join(output, `fixture-${version}.exe`)
    const result = await run(installer, ['/S', '/currentuser', '/no-desktop-shortcut', '/D=' + install], installerEnvironment)
    assert.equal(await fs.readFile(path.join(install, 'resources/app.asar'), 'utf8'), version)
    if (version === '1.0.0' && inPlace) await fs.writeFile(path.join(install, 'personal-project.txt'), 'keep extra file')
    const registry = await run('reg.exe', ['query', 'HKCU\\' + uninstallKey, '/v', 'DisplayVersion'])
    assert.ok(registry.output.includes(version))
    if (version === '1.0.1') {
      const log = await fs.readFile(path.join(installerTemp, `ModMind-install-1.0.1-${result.pid}.log`), 'utf16le')
      if (inPlace) {
        assert.match(log, /same-directory test upgrade/)
        assert.doesNotMatch(log, /uninstall attempt|uninstall temporary directory/)
        assert.equal(await fs.readFile(path.join(install, 'personal-project.txt'), 'utf8'), 'keep extra file')
      } else assert.match(log, /uninstall attempt=1 result=0/)
      assert.ok(log.includes(path.dirname(install)))
      await fs.writeFile(path.join(work, 'upgrade.log'), log)
    }
    uninstallPath = path.join(install, 'Uninstall ' + productName + '.exe')
    console.log('PASS real installer ' + version)
  }
  const leftovers = (await fs.readdir(work)).filter(name => name.endsWith('-ModMind-upgrade-temp'))
  assert.deepEqual(leftovers, [])
  assert.notEqual(path.parse(installerTemp).root.toLowerCase(), path.parse(install).root.toLowerCase())
  await fs.writeFile(path.join(work, 'result.json'), JSON.stringify({ success: true, install, installerTemp, inPlace, cases: ['real fresh installer', 'real upgrade installer', inPlace ? 'in-place upgrade preserves extra files without old uninstaller' : 'real old uninstaller', 'registry version', 'same-volume stage cleanup', 'system temporary directory on a different drive'] }, null, 2))
  console.log(JSON.stringify({ success: true, work }))
} finally {
  // Test-only keys and files. Never uninstall a user application.
  if (uninstallPath) await run(uninstallPath, ['/S', '/currentuser', '/KEEP_APP_DATA', '_?=' + install]).catch(error => console.error(error.message))
  await run('reg.exe', ['delete', 'HKCU\\' + installKey, '/f']).catch(() => undefined)
  await run('reg.exe', ['delete', 'HKCU\\' + uninstallKey, '/f']).catch(() => undefined)
  const desktop = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"])
  await fs.rm(path.join(desktop.output.trim(), productName + '.lnk'), { force: true })
}
