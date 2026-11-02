param([int]$GameProcessId, [int]$DurationMs = 2000, [string]$Output, [string]$ReadyFile, [string]$StopFile, [string]$GameProcessIdFile)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ModMindDesktopObservation {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT rect);
}
'@
$samples = [System.Collections.Generic.List[object]]::new()
$timer = [System.Diagnostics.Stopwatch]::StartNew()
if ($ReadyFile) { [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($ReadyFile), 'ready') }
while ($timer.ElapsedMilliseconds -lt $DurationMs -and (!$StopFile -or !(Test-Path -LiteralPath $StopFile))) {
    $window = [ModMindDesktopObservation]::GetForegroundWindow()
    [uint32]$foregroundProcess = 0
    [void][ModMindDesktopObservation]::GetWindowThreadProcessId($window, [ref]$foregroundProcess)
    $cursor = [ModMindDesktopObservation+POINT]::new()
    $clip = [ModMindDesktopObservation+RECT]::new()
    [void][ModMindDesktopObservation]::GetCursorPos([ref]$cursor)
    [void][ModMindDesktopObservation]::GetClipCursor([ref]$clip)
    $samples.Add([ordered]@{ ms = $timer.ElapsedMilliseconds; window = $window.ToInt64(); process = $foregroundProcess; x = $cursor.X; y = $cursor.Y; clip = @($clip.Left, $clip.Top, $clip.Right, $clip.Bottom) })
    Start-Sleep -Milliseconds 20
}
if ($GameProcessIdFile -and (Test-Path -LiteralPath $GameProcessIdFile)) { $GameProcessId = [int][System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($GameProcessIdFile)) }
# The PID is learned after the authenticated agent is ready. Classify all
# earlier samples too, including the window's initial creation and splash.
foreach ($sample in $samples) { $sample.gameForeground = ($GameProcessId -gt 0 -and $sample.process -eq $GameProcessId) }
$result = [ordered]@{ gameProcessId = $GameProcessId; gameEverForeground = ($samples.gameForeground -contains $true); samples = $samples }
$json = $result | ConvertTo-Json -Depth 6
if ($Output) { [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($Output), $json, [System.Text.UTF8Encoding]::new($false)) }
[ordered]@{ gameProcessId = $GameProcessId; gameEverForeground = $result.gameEverForeground; samples = $samples.Count; foregroundWindows = @($samples.window | Select-Object -Unique); cursorPositions = @($samples | ForEach-Object { "$($_.x),$($_.y)" } | Select-Object -Unique) } | ConvertTo-Json -Depth 4
