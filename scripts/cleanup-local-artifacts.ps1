param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$prefix = $workspace.TrimEnd('\') + '\'
$reportPath = Join-Path $workspace 'docs/local-cleanup-2026-10-01.json'
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if ($report.Workspace -ne $workspace) { throw 'Cleanup plan belongs to another workspace' }
$tracked = @(& git -C $workspace -c core.quotePath=false ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked files' }
$trackedPaths = @($tracked | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $workspace $_)) })
$rootArtifacts = @('$null', '%SystemDrive%', 'BuildTools.log.txt', 'tsconfig.node.tsbuildinfo', 'tsconfig.web.tsbuildinfo')
$targets = [Collections.Generic.List[object]]::new()

# Consume the reviewed plan without discovering or adding new cleanup targets.
foreach ($item in $report.Items) {
    if ($item.State -eq 'deleted') { continue }
    $full = [IO.Path]::GetFullPath((Join-Path $workspace $item.Path))
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Outside workspace: $full" }
    $relative = [IO.Path]::GetRelativePath($workspace, $full)
    if ($relative -notmatch '^(test-results|artifacts|release)\\' -and $rootArtifacts -notcontains $relative) { throw "Unapproved cleanup scope: $relative" }
    if ($relative -like 'release\1.5.0-plugintest-r7*' -or $relative -eq 'release\win-unpacked' -or $relative -like 'release\ModMind Setup 1.4.13*' -or $relative -like 'test-results\user-diagnostics-*' -or $relative -like 'test-results\closing-song-live\project*') { throw "Protected artifact: $relative" }
    $boundary = $full.TrimEnd('\') + '\'
    if (@($trackedPaths | Where-Object { $_ -eq $full -or $_.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase) }).Count) { throw "Contains tracked files: $relative" }
    if (-not (Test-Path -LiteralPath $full)) { $item.State = 'already absent'; continue }
    $cursor = $full
    while ($cursor -ne $workspace) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked cleanup path: $full" }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    $targets.Add([pscustomobject]@{ FullPath=$full; Item=$item })
}
$targetItems = @($targets | ForEach-Object { $_.Item })
Write-Output ([pscustomobject]@{ Targets=$targets.Count; GiB=[math]::Round(($targetItems | Measure-Object Bytes -Sum).Sum/1GB,2); Applying=[bool]$Apply } | ConvertTo-Json)
if (-not $Apply) { return }

$active = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe', 'electron.exe', 'ModMind.exe', 'ModMind Plugin Test.exe') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*modmind*' -and $_.CommandLine -notlike '*cua_node*') })
if ($active.Count) { throw 'A runtime process may be using these artifacts; stop cleanup' }
$beforeDiff = [string]::Join("`n", @(& git -C $workspace diff --binary HEAD))
$report.Mode = 'PermanentDelete'
$report | Add-Member -NotePropertyName AppliedAt -NotePropertyValue (Get-Date).ToString('o') -Force
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
$completed = 0
foreach ($target in $targets) {
    try {
        # Native PowerShell removes reparse points without traversing their targets.
        Remove-Item -LiteralPath $target.FullPath -Recurse -Force
        if (Test-Path -LiteralPath $target.FullPath) { throw "Cleanup target remains: $($target.FullPath)" }
        $target.Item.State = 'deleted'
        $completed++
        if ($completed % 20 -eq 0 -or $target.Item.Bytes -ge 1GB) { Write-Output "Deleted $completed/$($targets.Count): $($target.Item.Path)" }
    } catch {
        $target.Item.State = 'failed: ' + $_.Exception.Message
        throw
    } finally {
        $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
}
$afterDiff = [string]::Join("`n", @(& git -C $workspace diff --binary HEAD))
if ($beforeDiff -ne $afterDiff) { throw 'Tracked working-tree changes changed during cleanup; inspect before continuing' }
Write-Output ([pscustomobject]@{ Deleted=$completed; GiB=[math]::Round(($targetItems | Measure-Object Bytes -Sum).Sum/1GB,2); TrackedChangesPreserved=$true; Report=$reportPath } | ConvertTo-Json)
