$ErrorActionPreference = 'Stop'
$sessionHome = 'C:\Users\waterpail\AppData\Local\Temp\modmind-codex-gpt6-astra-session'
$workspace = $PSScriptRoot
$keyFile = Join-Path $workspace '.codex-gpt6-astra-session.key'
$codex = 'E:\waterpail\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
try {
  $env:CODEX_HOME = $sessionHome
  $env:MODMIND_THIRD_PARTY_API_KEY = [IO.File]::ReadAllText($keyFile).Trim()
  Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
  $env:TERM = 'xterm-256color'
  Set-Location -LiteralPath $workspace
  $Host.UI.RawUI.WindowTitle = 'ModMind Codex YOLO - gpt-6-astra'
  & $codex '--dangerously-bypass-approvals-and-sandbox' '-C' $workspace
} finally {
  Remove-Item Env:MODMIND_THIRD_PARTY_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue
}
