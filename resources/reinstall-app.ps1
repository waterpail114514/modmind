param([Parameter(Mandatory = $true)][string]$PlanPath, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stage = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath))
$cleaningStarted = $false

function Full-Path([string]$Value) {
  if ($Value.Length -lt 3 -or $Value[1] -ne ':' -or $Value[2] -ne [char]92) { throw "Invalid absolute path: $Value" }
  return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}
function Is-Within([string]$Root, [string]$Candidate) {
  $rootPath = Full-Path $Root
  $candidatePath = Full-Path $Candidate
  return $candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or $candidatePath.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLinks([string]$Target) {
  $cursor = Full-Path $Target
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -Force -LiteralPath $cursor
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked directory is not allowed: $cursor" }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Assert-Installer {
  if (!(Test-Path -LiteralPath $plan.installerPath -PathType Leaf)) { throw 'The downloaded installer is missing.' }
  $stream = [IO.File]::OpenRead($plan.installerPath)
  $algorithm = [Security.Cryptography.SHA512]::Create()
  try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($digest -ine $plan.sha512) { throw 'Installer SHA-512 verification failed. No cleanup was performed.' }
}
function Remove-OwnedTree([string]$Target) {
  if (!(Test-Path -LiteralPath $Target)) { return }
  $item = Get-Item -Force -LiteralPath $Target
  # Do not traverse junctions/symlinks nested inside owned cache directories.
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName) }
    else { [IO.File]::Delete($item.FullName) }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -Force -LiteralPath $item.FullName) { Remove-OwnedTree $child.FullName }
    [IO.Directory]::Delete($item.FullName)
  } else {
    if ($item.IsReadOnly) { $item.IsReadOnly = $false }
    [IO.File]::Delete($item.FullName)
  }
}

try {
  $plan = Get-Content -Raw -LiteralPath $PlanPath -Encoding UTF8 | ConvertFrom-Json
  if ($plan.schemaVersion -ne 1 -or (Full-Path $plan.stageDirectory) -ine (Full-Path $stage) -or [IO.Path]::GetFileName($stage) -notlike 'ModMind-reinstall-*') { throw 'Invalid reinstall plan.' }
  if ((Full-Path $plan.installerPath) -ine (Join-Path $stage 'ModMind-Setup.exe') -or $plan.sha512 -notmatch '^[a-fA-F0-9]{128}$') { throw 'Invalid installer metadata.' }
  $installDirectory = Full-Path $plan.installDirectory
  $ownedDirectories = @($installDirectory)
  foreach ($name in @('modmind', 'modtool')) {
    $ownedDirectories += Join-Path $plan.appDataPath $name
    $ownedDirectories += Join-Path $plan.localAppDataPath $name
    $ownedDirectories += Join-Path $plan.localAppDataPath ($name + '-updater')
  }
  $ownedDirectories = @($ownedDirectories | ForEach-Object { Full-Path $_ })
  $userDataDirectory = Full-Path $plan.userDataPath
  $allowedUserData = @(
    (Join-Path $plan.appDataPath 'modmind'), (Join-Path $plan.appDataPath 'modtool'),
    (Join-Path $plan.localAppDataPath 'modmind'), (Join-Path $plan.localAppDataPath 'modtool')
  ) | ForEach-Object { Full-Path $_ }
  if ($userDataDirectory -notin $allowedUserData) { throw 'Invalid project-list restore directory.' }
  Assert-NoLinks $userDataDirectory
  $protectedDirectories = @($plan.homePath, $plan.appDataPath, $plan.localAppDataPath, $stage, $env:SystemRoot, $env:ProgramFiles, ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')), (Join-Path $plan.localAppDataPath 'Programs'))
  foreach ($name in @('Desktop', 'Documents', 'Downloads')) { $protectedDirectories += Join-Path $plan.homePath $name }
  foreach ($target in $plan.cleanupDirectories) {
    $full = Full-Path $target
    if ($full -notin $ownedDirectories -or $full -match '^[a-zA-Z]:$') { throw "Cleanup target is not owned by ModMind: $target" }
    foreach ($protected in $protectedDirectories) {
      if ($protected -and (Is-Within $full $protected)) { throw "Cleanup target contains a protected directory: $target" }
    }
    Assert-NoLinks $full
  }
  Assert-NoLinks $stage
  Assert-NoLinks $installDirectory
  foreach ($file in @('ModMind.exe', 'resources\app.asar', 'Uninstall ModMind.exe')) {
    $targetFile = Join-Path $installDirectory $file
    if (!(Test-Path -LiteralPath $targetFile -PathType Leaf)) { throw "Installed application file is missing: $targetFile" }
    Assert-NoLinks $targetFile
  }
  Assert-Installer
  # Only act on an installed product, with the same per-user/all-users scope.
  $scope = $null
  foreach ($hive in @('HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE')) {
    foreach ($branch in @('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
      $entries = Get-ChildItem -LiteralPath ('Registry::' + $hive + '\' + $branch) -ErrorAction SilentlyContinue
      foreach ($entry in $entries) {
        $record = Get-ItemProperty -LiteralPath $entry.PSPath
        if ($record.PSObject.Properties['DisplayName'] -and $record.PSObject.Properties['UninstallString'] -and $record.DisplayName -match '^ModMind(?: |$)') {
          $match = [regex]::Match($record.UninstallString, '^"([^"]+)"')
          if ($match.Success -and (Full-Path $match.Groups[1].Value) -ieq (Join-Path $installDirectory 'Uninstall ModMind.exe')) {
            $scope = if ($hive -eq 'HKEY_CURRENT_USER') { '/currentuser' } else { '/allusers' }
          }
        }
      }
    }
  }
  if (!$scope) { throw 'Cannot find a matching ModMind installation record.' }
  $administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($scope -eq '/allusers' -and !$administrator) {
    if ($Elevated) { throw 'Administrator permissions were not granted.' }
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'), '-PlanPath', ('"' + $PlanPath + '"'), '-Elevated')
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden | Out-Null
    exit 0
  }
  $parent = Get-Process -Id $plan.parentPid
  if ((Full-Path $parent.Path) -ine (Join-Path $installDirectory 'ModMind.exe')) { throw 'The running application does not match the reinstall plan.' }
  $uninstaller = Join-Path $stage 'old-uninstaller.exe'
  Copy-Item -LiteralPath (Join-Path $installDirectory 'Uninstall ModMind.exe') -Destination $uninstaller
  [IO.File]::WriteAllText((Join-Path $stage 'ready'), 'ready')
  if (!$parent.WaitForExit(120000)) { throw 'ModMind did not exit; no cleanup was performed.' }
  if ((Test-Path -LiteralPath (Join-Path $stage 'cancel')) -or !(Test-Path -LiteralPath (Join-Path $stage 'proceed'))) { throw 'Reinstall was cancelled; no cleanup was performed.' }
  Assert-Installer
  foreach ($target in $plan.cleanupDirectories) { Assert-NoLinks $target }
  # Snapshot after shutdown so projects opened while downloading are included.
  # Preserve only path references, never settings, credentials, or caches.
  $recentProjectsFile = Join-Path $userDataDirectory 'recent-projects.json'
  $savedProjects = @()
  if (Test-Path -LiteralPath $recentProjectsFile) {
    Assert-NoLinks $recentProjectsFile
    $recentText = [IO.File]::ReadAllText($recentProjectsFile, [Text.Encoding]::UTF8)
    if (!$recentText.TrimStart().StartsWith('[')) { throw 'Cannot preserve the project list: invalid format.' }
    $decodedProjects = ConvertFrom-Json -InputObject $recentText
    foreach ($project in $decodedProjects) {
      $savedPath = if ($project -is [string]) { $project } elseif ($project -and $project.PSObject.Properties['path']) { $project.path } else { $null }
      if ($savedPath -isnot [string] -or [string]::IsNullOrWhiteSpace($savedPath) -or ![IO.Path]::IsPathRooted($savedPath)) { throw 'Cannot preserve the project list: invalid project path.' }
      $projectPath = [IO.Path]::GetFullPath($savedPath)
      foreach ($target in $plan.cleanupDirectories) {
        if ($projectPath.StartsWith('\\')) { continue }
        if (Is-Within $target $projectPath) { throw ('A project is inside a cleanup directory: ' + $projectPath) }
      }
      $savedProjects += [pscustomobject]@{ path = $savedPath }
    }
  }
  $savedProjectsJson = ConvertTo-Json -InputObject @($savedProjects) -Depth 4 -Compress
  $projectListBackup = Join-Path $stage 'recent-projects.json'
  [IO.File]::WriteAllText($projectListBackup, $savedProjectsJson, (New-Object Text.UTF8Encoding $false))
  $cleaningStarted = $true
  [IO.File]::WriteAllText((Join-Path $stage 'reinstall.log'), ('Reinstall ' + $plan.version + [Environment]::NewLine))
  # The old uninstaller removes registration/shortcuts; explicit cleanup below
  # also removes legacy data that would otherwise be migrated on next launch.
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList ('/S ' + $scope + ' /KEEP_APP_DATA _?=' + $installDirectory) -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw ('Uninstall failed with exit code ' + $uninstall.ExitCode + '. Cleanup has stopped.') }
  foreach ($target in $plan.cleanupDirectories) {
    Assert-NoLinks $target
    $removed = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      try { Remove-OwnedTree $target; $removed = $true; break }
      catch { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 500 }
    }
    if (!$removed) { throw "Cannot remove $target" }
    Add-Content -LiteralPath (Join-Path $stage 'reinstall.log') -Value ('Removed ' + $target) -Encoding UTF8
  }
  # Restore before launching the installer: --force-run may start the app
  # before the installer process returns. Only the project list is restored.
  Assert-NoLinks $userDataDirectory
  [IO.Directory]::CreateDirectory($userDataDirectory) | Out-Null
  [IO.File]::WriteAllText($recentProjectsFile, $savedProjectsJson, (New-Object Text.UTF8Encoding $false))
  # /D must be the final NSIS argument, without surrounding quotation marks.
  $installArguments = '/S --force-run ' + $scope + ' /D=' + $installDirectory
  $installation = Start-Process -FilePath $plan.installerPath -ArgumentList $installArguments -Wait -PassThru -WindowStyle Hidden
  if ($installation.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $installDirectory 'ModMind.exe'))) { throw ('Installation failed with exit code ' + $installation.ExitCode + '.') }
  Set-Location -LiteralPath $env:TEMP
  [Environment]::CurrentDirectory = $env:TEMP
  Remove-OwnedTree $stage
} catch {
  $message = $_.Exception.Message
  try { [IO.File]::WriteAllText((Join-Path $stage 'error.txt'), $message, [Text.Encoding]::UTF8) } catch { }
  if ($cleaningStarted) {
    try {
      Add-Type -AssemblyName PresentationFramework
      [System.Windows.MessageBox]::Show(('重装未完成。已下载的安装包与日志保留在：' + [Environment]::NewLine + $stage + [Environment]::NewLine + [Environment]::NewLine + $message), 'ModMind 重装', 'OK', 'Error') | Out-Null
    } catch { }
  }
  exit 1
}
