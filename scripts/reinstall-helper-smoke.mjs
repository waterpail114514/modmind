import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Run the production PowerShell flow against disposable files. Registry reads,
// parent-process checks, and installer launches are mocked in the child scope;
// no installed programs, real registry records, or user data are touched.
if (process.platform !== 'win32') throw new Error('Windows is required')
const workspace = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-reinstall-smoke-'))
assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const production = await fs.readFile(path.join(workspace, 'resources/reinstall-app.ps1'), 'utf8')
// Suppress only the native error message box in this automated smoke fixture.
const helperSource = production.replace('if ($cleaningStarted) {', 'if ($false) {')
try {
  for (const scenario of ['success', 'empty-projects', 'missing-projects', 'single-project', 'invalid-projects', 'project-inside-cleanup', 'bad-hash', 'cancelled', 'shutdown-timeout', 'uninstall-failed', 'install-failed', 'root-junction']) {
    const succeeds = ['success', 'empty-projects', 'missing-projects', 'single-project'].includes(scenario)
    const home = path.join(root, scenario)
    const install = path.join(home, 'Programs', 'ModMind')
    const stage = path.join(home, 'Temp', 'ModMind-reinstall-smoke')
    const roaming = path.join(home, 'Roaming'), local = path.join(home, 'Local')
    const targets = [install, ...['modmind', 'modtool'].map(name => path.join(roaming, name)), ...['modmind', 'modtool', 'modmind-updater', 'modtool-updater'].map(name => path.join(local, name))]
    const project = path.join(home, 'Projects', 'MyMod')
    await fs.mkdir(stage, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, 'keep.txt'), 'user project')
    for (const target of targets) { await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'old.txt'), 'old data') }
    const userDataPath = path.join(roaming, 'modmind')
    const projectListFile = path.join(userDataPath, 'recent-projects.json')
    const projects = ['empty-projects', 'missing-projects'].includes(scenario) ? [] : scenario === 'single-project' ? [{ path: project }] : [
      { path: project }, { path: path.join(home, 'Projects', '中文 项目') }, { path: 'Z:\\OfflineProject' }
    ]
    if (scenario !== 'missing-projects') await fs.writeFile(projectListFile, scenario === 'invalid-projects' ? '{broken'
      : JSON.stringify(scenario === 'project-inside-cleanup' ? [{ path: path.join(userDataPath, 'project') }]
        : projects.map((entry, index) => index === 1 ? entry.path : { ...entry, ignoredSetting: 'must not restore' })))
    await fs.mkdir(path.join(install, 'resources'), { recursive: true })
    for (const file of ['ModMind.exe', 'Uninstall ModMind.exe', 'resources/app.asar']) await fs.writeFile(path.join(install, file), 'fixture')
    await fs.symlink(project, path.join(roaming, 'modmind', 'external-project'), 'junction')
    if (scenario === 'root-junction') {
      await fs.rename(path.join(local, 'modtool'), path.join(local, 'modtool-original'))
      await fs.symlink(project, path.join(local, 'modtool'), 'junction')
    }
    const installer = path.join(stage, 'ModMind-Setup.exe')
    await fs.writeFile(installer, 'installer fixture')
    const plan = { schemaVersion: 1, userDataPath, installDirectory: install, cleanupDirectories: targets, appDataPath: roaming, localAppDataPath: local, homePath: home, stageDirectory: stage, installerPath: installer, sha512: createHash('sha512').update('installer fixture').digest('hex'), version: '1.4.11', parentPid: 12345 }
    if (scenario === 'bad-hash') plan.sha512 = '0'.repeat(128)
    await fs.writeFile(path.join(stage, 'plan.json'), JSON.stringify(plan))
    if (scenario !== 'cancelled') await fs.writeFile(path.join(stage, 'proceed'), 'confirmed')
    await fs.writeFile(path.join(stage, 'reinstall.ps1'), '\ufeff' + helperSource)
    const log = path.join(home, 'calls.txt')
    const runner = [
      "$ErrorActionPreference = 'Stop'",
      '$global:fixturePlan = Get-Content -Raw -LiteralPath ' + quote(path.join(stage, 'plan.json')) + ' | ConvertFrom-Json',
      '$global:fixtureScenario = ' + quote(scenario),
      '$global:fixtureLog = ' + quote(log),
      'function Get-Process { param($Id)',
      "  $fake = [pscustomobject]@{ Path = (Join-Path $global:fixturePlan.installDirectory 'ModMind.exe') }",
      "  $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout); return $global:fixtureScenario -ne 'shutdown-timeout' }",
      '  return $fake',
      '}',
      'function Get-ChildItem { [CmdletBinding()]param([string]$LiteralPath, [switch]$Force)',
      "  if ($LiteralPath.StartsWith('Registry::')) {",
      "    if ($LiteralPath.Contains('HKEY_CURRENT_USER') -and !$LiteralPath.Contains('WOW6432Node')) { return [pscustomobject]@{PSPath = 'fixture-install'} }; return @()",
      '  }',
      '  Microsoft.PowerShell.Management' + String.fromCharCode(92) + 'Get-ChildItem @PSBoundParameters',
      '}',
      'function Get-ItemProperty { param($LiteralPath)',
      "  return [pscustomobject]@{DisplayName = 'ModMind 1.4.11'; UninstallString = ('\"' + (Join-Path $global:fixturePlan.installDirectory 'Uninstall ModMind.exe') + '\" /currentuser')}",
      '}',
      'function Start-Process { [CmdletBinding()]param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)',
      '  Add-Content -LiteralPath $global:fixtureLog -Value ([IO.Path]::GetFileName($FilePath))',
      "  if ([IO.Path]::GetFileName($FilePath) -eq 'old-uninstaller.exe') {",
      "    if (!$ArgumentList.Contains('/KEEP_APP_DATA _?=')) { throw 'Bad uninstaller arguments' }",
      "    return [pscustomobject]@{ExitCode = $(if ($global:fixtureScenario -eq 'uninstall-failed') { 2 } else { 0 })}",
      '  }',
      "  if ([IO.Path]::GetFileName($FilePath) -ne 'ModMind-Setup.exe') { throw 'Unexpected process launch' }",
      "  foreach ($target in $global:fixturePlan.cleanupDirectories) { if (Test-Path -LiteralPath $target) { if ($target -ine $global:fixturePlan.userDataPath -or @(Get-ChildItem -LiteralPath $target).Count -ne 1 -or !(Test-Path -LiteralPath (Join-Path $target 'recent-projects.json'))) { throw ('Old data remains before install: ' + $target) } } }",
      "  if (!(Test-Path -LiteralPath (Join-Path $global:fixturePlan.userDataPath 'recent-projects.json'))) { throw 'Project list must be restored before starting the installer' }",
      "  if (!$ArgumentList.StartsWith('/S --force-run /currentuser /D=')) { throw 'Bad installer arguments' }",
      "  if ($global:fixtureScenario -eq 'install-failed') { return [pscustomobject]@{ExitCode = 2} }",
      '  [IO.Directory]::CreateDirectory($global:fixturePlan.installDirectory) | Out-Null',
      "  [IO.File]::WriteAllText((Join-Path $global:fixturePlan.installDirectory 'ModMind.exe'), 'new version')",
      '  return [pscustomobject]@{ExitCode = 0}',
      '}',
      '& ' + quote(path.join(stage, 'reinstall.ps1')) + ' -PlanPath ' + quote(path.join(stage, 'plan.json'))
    ].join('\n')
    const runnerPath = path.join(home, 'run.ps1')
    await fs.writeFile(runnerPath, '\ufeff' + runner)
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath], { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.ifError(result.error)
    const error = await fs.readFile(path.join(stage, 'error.txt'), 'utf8').catch(() => '')
    const calls = await fs.readFile(log, 'utf8').catch(() => '')
    assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'user project', scenario)
    if (succeeds) {
      assert.equal(error, '')
      assert.equal(result.status, 0, error || result.stderr)
      assert.match(calls, /old-uninstaller[.]exe[\s\S]*ModMind-Setup[.]exe/)
      assert.equal(await fs.readFile(path.join(install, 'ModMind.exe'), 'utf8'), 'new version')
      assert.deepEqual(JSON.parse(await fs.readFile(projectListFile, 'utf8')), projects)
      assert.deepEqual(await fs.readdir(userDataPath), ['recent-projects.json'])
      await assert.rejects(fs.stat(stage), { code: 'ENOENT' })
    } else {
      assert.ok(error, scenario + ': expected failure, got ' + result.stderr)
      assert.ok(await fs.stat(installer), 'retain installer for recovery')
      if (!['uninstall-failed', 'install-failed'].includes(scenario)) assert.equal(calls, '', error)
      if (scenario !== 'install-failed') assert.equal(await fs.readFile(path.join(install, 'ModMind.exe'), 'utf8'), 'fixture')
      if (scenario === 'uninstall-failed') assert.doesNotMatch(calls, /ModMind-Setup/)
      if (['uninstall-failed', 'install-failed'].includes(scenario)) {
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(stage, 'recent-projects.json'), 'utf8')), projects)
      }
    }
    process.stdout.write('PASS ' + scenario + '\n')
  }
} finally {
  assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  await fs.rm(root, { recursive: true, force: true })
}
