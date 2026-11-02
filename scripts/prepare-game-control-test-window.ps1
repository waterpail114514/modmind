param([Parameter(Mandatory=$true)][int]$GameProcessId, [string]$OwnedSessionDirectory, [int]$ResizeWidth = 0, [int]$ResizeHeight = 0)
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $GameProcessId
if ($target.ProcessName -notmatch '^java(w)?$') { throw 'Target is not a Java process' }
if ($OwnedSessionDirectory) {
    $endpoints = @(Get-ChildItem -LiteralPath $OwnedSessionDirectory -Filter '*.endpoint' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } | Where-Object { $_.pid -eq $GameProcessId -and $_.protocol -eq 1 })
    if ($endpoints.Count -ne 1) { throw 'Target is not the authenticated owned game-control JVM' }
} else {
    $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$GameProcessId"
    if ($identity.CommandLine -notmatch '-javaagent:.*game-control') { throw 'Target is not an owned game-control test JVM' }
}
$handle = (Get-Process -Id $GameProcessId).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Owned game has no window' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ModMindTestWindowPlacement {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
}
'@
$before = [ModMindTestWindowPlacement]::GetForegroundWindow()
$client = New-Object ModMindTestWindowPlacement+Rect
$outer = New-Object ModMindTestWindowPlacement+Rect
if (-not [ModMindTestWindowPlacement]::GetClientRect($handle, [ref]$client) -or -not [ModMindTestWindowPlacement]::GetWindowRect($handle, [ref]$outer)) { throw 'Cannot read owned game geometry' }
[void][ModMindTestWindowPlacement]::ShowWindow($handle, 4)
[void][ModMindTestWindowPlacement]::SetWindowPos($handle, [IntPtr]::new(1), 0, 0, 0, 0, 0x0013)
if ($ResizeWidth -or $ResizeHeight) {
    if ($ResizeWidth -lt 640 -or $ResizeWidth -gt 3840 -or $ResizeHeight -lt 360 -or $ResizeHeight -gt 2160) { throw 'Owned resize dimensions are outside acceptance bounds' }
    $width = $ResizeWidth + ($outer.Right - $outer.Left) - ($client.Right - $client.Left)
    $height = $ResizeHeight + ($outer.Bottom - $outer.Top) - ($client.Bottom - $client.Top)
    if (-not [ModMindTestWindowPlacement]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $width, $height, 0x0016)) { throw 'Owned resize failed' }
}
$after = [ModMindTestWindowPlacement]::GetForegroundWindow()
[ordered]@{ gameProcessId = $GameProcessId; window = $handle.ToInt64(); clientWidth = ($client.Right - $client.Left); clientHeight = ($client.Bottom - $client.Top); foregroundBefore = $before.ToInt64(); foregroundAfter = $after.ToInt64(); foregroundUnchanged = ($before -eq $after); placedBehindOtherWindows = $true } | ConvertTo-Json
