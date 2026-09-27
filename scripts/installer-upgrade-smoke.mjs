import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const nsis = process.env.MODMIND_MAKENSIS || path.join(os.homedir(), 'AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe')
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-installer-test-'))
const quote = value => value.replaceAll('$', '$$')

function run(file, args, input) {
  const result = spawnSync(file, args, { cwd: work, input, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`)
  return result
}

// Exercise the actual NSIS recovery functions in isolated directories, without
// touching the application's registry keys, shortcuts, or installed version.
async function recoveryCase(name, { differentTarget = false, missingApp = false, committed = false, partial = false, differentScope = false, junction = false, lockExtra = false, emptyPartial = false, secondary = false } = {}) {
  const old = path.join(work, name, 'ModMind')
  const target = differentTarget ? path.join(work, name, 'Other') : old
  await fs.mkdir(path.join(old, 'resources'), { recursive: true })
  await fs.writeFile(path.join(old, 'personal-project.txt'), 'user project')
  if (!missingApp) await fs.writeFile(path.join(old, 'ModMind.exe'), 'old executable')
  await fs.writeFile(path.join(old, 'resources/app.asar'), 'old application')
  if (junction) {
    await fs.rename(old, `${old}-real`)
    await fs.symlink(`${old}-real`, old, 'junction')
  }
  let holder
  if (lockExtra) {
    const ps = `$f = [IO.File]::Open('${path.join(old, 'personal-project.txt').replaceAll("'", "''")}', 'Open', 'Read', 'None'); [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $f.Dispose()`
    holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
    await new Promise((resolve, reject) => {
      holder.once('error', reject)
      holder.once('exit', code => reject(new Error(`lock holder exited: ${code}`)))
      holder.stdout.once('data', data => data.toString().includes('LOCKED') ? resolve() : reject(new Error(data.toString())))
    })
  }
  const source = `
Unicode true
!include LogicLib.nsh
!addincludedir "${quote(path.join(templates, 'include'))}"
!include "${quote(path.join(root, 'resources/installer-upgrade.nsh'))}"
!define VERSION "smoke-test"
!define APP_EXECUTABLE_FILENAME "ModMind.exe"
!define UNINSTALL_REGISTRY_KEY "Software\\ModMindInstallerSmokeTest"
!define INSTALL_REGISTRY_KEY "Software\\ModMindInstallerSmokeTest"
!define isUpdated '1 == 1'
!define isDeleteAppData '0 == 1'
!include StdUtils.nsh
!addplugindir /x86-unicode "${quote(path.join(path.dirname(path.dirname(nsis)), '../nsis-resources-3.4.1/plugins/x86-unicode'))}"
Var installMode
Var appExe
!include installUtil.nsh
!insertmacro ModMindUpgradeFunctions
Name "ModMind recovery test"
OutFile "${name}.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  StrCpy $INSTDIR "${quote(target)}"
  StrCpy $ModMindUpgradeDirectory "${quote(old)}"
  StrCpy $ModMindUpgradeRoot "${differentScope ? 'HKEY_CURRENT_USER' : 'SHELL_CONTEXT'}"
  StrCpy $installMode "${differentScope ? 'all' : 'CurrentUser'}"
  Call ModMindStageUpgradeBackup
  FileOpen $0 "$EXEDIR\\${name}.result" w
  FileWriteUTF16LE $0 "$ModMindUpgradeResult$\\r$\\n$ModMindUpgradeBackup"
  FileClose $0
  ${partial ? 'CreateDirectory "$INSTDIR"\nFileOpen $0 "$INSTDIR\\partial.txt" w\nFileWrite $0 "partial new installation"\nFileClose $0' : ''}
  ${emptyPartial ? 'CreateDirectory "$INSTDIR"' : ''}
  ${committed ? 'StrCpy $ModMindUpgradeCommitted 1' : ''}
  ${secondary ? 'StrCpy $ModMindUpgradeDirectory "$EXEDIR\\unrelated-directory"' : ''}
  Call ModMindFinishUpgrade
  StrCpy $ModMindUpgradeBackup ""
SectionEnd
`
  await fs.writeFile(path.join(work, `${name}.nsi`), source)
  try {
    run(nsis, ['-INPUTCHARSET', 'UTF8', '-V2', '-'], source)
    run(path.join(work, `${name}.exe`), ['/S'])
  } finally {
    if (holder) {
      const stopped = new Promise(resolve => holder.once('exit', resolve))
      holder.stdin.end('\n')
      await stopped
    }
  }
  const [result, backup] = (await fs.readFile(path.join(work, `${name}.result`), 'utf16le')).split('\r\n')
  if (differentTarget || missingApp || differentScope || junction || lockExtra) {
    assert.notEqual(result, '0')
    assert.equal(backup, '')
    if (lockExtra) assert.match(result, /Windows 错误 [1-9][0-9]*/)
    assert.equal(await fs.readFile(path.join(old, 'personal-project.txt'), 'utf8'), 'user project')
  } else {
    assert.equal(result, '0')
    const kept = committed ? backup : old
    assert.equal(await fs.readFile(path.join(kept, 'personal-project.txt'), 'utf8'), 'user project')
    assert.equal(await fs.readFile(path.join(kept, 'ModMind.exe'), 'utf8'), 'old executable')
    if (partial) assert.equal(await fs.readFile(path.join(`${backup}-incomplete`, 'partial.txt'), 'utf8'), 'partial new installation')
  }
  console.log(`PASS ${name}`)
}

await recoveryCase('rollback')
await recoveryCase('partial-rollback', { partial: true })
await recoveryCase('committed', { committed: true })
await recoveryCase('different-target', { differentTarget: true })
await recoveryCase('missing-app', { missingApp: true })
await recoveryCase('different-scope', { differentScope: true })
await recoveryCase('junction', { junction: true })
await recoveryCase('empty-partial-rollback', { emptyPartial: true })
await recoveryCase('locked-extra-file', { lockExtra: true })
await recoveryCase('secondary-uninstall-rollback', { partial: true, secondary: true })

// Invoke the hooked uninstall macro against real child executables and a
// test-only registry key. /S must fail closed (no automatic repair consent).
async function uninstallCase(name, { exitCode = 0, missing = false, fresh = false } = {}) {
  const old = path.join(work, name, 'ModMind')
  const registryKey = `Software\\ModMindInstallerSmokeTest\\${path.basename(work)}-${name}`
  await fs.mkdir(path.join(old, 'resources'), { recursive: true })
  await fs.writeFile(path.join(old, 'ModMind.exe'), 'old executable')
  await fs.writeFile(path.join(old, 'resources/app.asar'), 'old application')
  await fs.writeFile(path.join(old, 'personal-project.txt'), 'user project')
  const child = path.join(old, 'Uninstall ModMind.exe')
  const trace = path.join(work, `${name}.child-args`)
  if (!missing && !fresh) run(nsis, ['-INPUTCHARSET', 'UTF8', '-V2', '-'], `
Unicode true
Name "Old uninstaller fixture"
OutFile "${quote(child)}"
RequestExecutionLevel user
SilentInstall silent
Section
  FileOpen $0 "${quote(trace)}" a
  FileSeek $0 0 END
  FileWriteUTF16LE $0 "$CMDLINE$\\r$\\n"
  FileClose $0
  SetErrorLevel ${exitCode}
SectionEnd
`)
  const source = `
Unicode true
!include LogicLib.nsh
!addincludedir "${quote(path.join(templates, 'include'))}"
!include "${quote(path.join(root, 'resources/installer-upgrade.nsh'))}"
!define VERSION "smoke-${name}"
!define APP_EXECUTABLE_FILENAME "ModMind.exe"
!define UNINSTALL_REGISTRY_KEY "${registryKey}"
!define INSTALL_REGISTRY_KEY "${registryKey}"
!define isUpdated '1 == 1'
!define isDeleteAppData '0 == 1'
!include StdUtils.nsh
!addplugindir /x86-unicode "${quote(path.join(path.dirname(path.dirname(nsis)), '../nsis-resources-3.4.1/plugins/x86-unicode'))}"
Var installMode
Var appExe
!insertmacro ModMindUpgradeFunctions
!include installUtil.nsh
!include "${quote(path.join(root, 'resources/installer-upgrade-hook.nsh'))}"
Name "ModMind uninstall test"
OutFile "${name}.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  InitPluginsDir
  SetShellVarContext current
  StrCpy $installMode "CurrentUser"
  StrCpy $INSTDIR "${quote(old)}"
  StrCpy $appExe "$INSTDIR\\ModMind.exe"
  ${fresh ? '' : `WriteRegStr HKCU "${registryKey}" UninstallString '$\\"${quote(child)}$\\" /currentuser'
  WriteRegStr HKCU "${registryKey}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${registryKey}" KeepShortcuts "true"`}
  !insertmacro uninstallOldVersion SHELL_CONTEXT
  FileOpen $0 "$EXEDIR\\${name}.continued" w
  FileWrite $0 "$R0"
  FileClose $0
SectionEnd
`
  run(nsis, ['-INPUTCHARSET', 'UTF8', '-V2', '-'], source)
  let result
  try {
    result = spawnSync(path.join(work, `${name}.exe`), ['/S'], { cwd: work, windowsHide: true, timeout: 20_000 })
    assert.ifError(result.error)
  } finally {
    if (!fresh) run('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f'])
  }
  const fails = missing || exitCode !== 0
  assert.equal(result.status, fails ? 2 : 0)
  if (!fresh) {
    const log = await fs.readFile(path.join(os.tmpdir(), `ModMind-install-smoke-${name}-${result.pid}.log`), 'utf16le')
    assert.match(log, new RegExp(`attempt=${fails ? 2 : 1} result=${missing ? 'launch-failed' : exitCode}`))
    assert.ok(log.includes(old))
  }
  if (fails) await assert.rejects(fs.stat(path.join(work, `${name}.continued`)), { code: 'ENOENT' })
  else assert.equal(await fs.readFile(path.join(work, `${name}.continued`), 'utf8'), '0')
  assert.equal(await fs.readFile(path.join(old, 'personal-project.txt'), 'utf8'), 'user project')
  if (!missing && !fresh) {
    const args = await fs.readFile(trace, 'utf16le')
    assert.equal(args.trim().split('\r\n').length, fails ? 2 : 1)
    assert.match(args, /\/currentuser --updated \/KEEP_APP_DATA --keep-shortcuts/)
    assert.doesNotMatch(args, /--delete-app-data/)
  }
  console.log(`PASS ${name}`)
}
await uninstallCase('fresh', { fresh: true })
await uninstallCase('uninstall-success')
await uninstallCase('uninstall-failed', { exitCode: 7 })
await uninstallCase('uninstaller-missing', { missing: true })
console.log(`Isolated evidence: ${work}`)
