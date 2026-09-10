$ErrorActionPreference = 'Stop'
$root = 'E:\waterpail\桌面\新建文件夹\modmind'
$codex = 'E:\waterpail\AppData\Roaming\npm\codex.ps1'
Set-Location -LiteralPath $root
$Host.UI.RawUI.WindowTitle = 'Codex YOLO - gpt-6-astra'
$env:TERM = 'xterm-256color'
$codexArgs = @(
  '--dangerously-bypass-approvals-and-sandbox',
  '-C', $root,
  '-m', 'gpt-6-astra',
  '-c', 'model_provider="gpt6_astra_temp"',
  '-c', 'model_providers.gpt6_astra_temp.name="Private GPT-6 Gateway"',
  '-c', 'model_providers.gpt6_astra_temp.base_url="http://154.44.10.36:8080/v1"',
  '-c', 'model_providers.gpt6_astra_temp.wire_api="responses"',
  '-c', 'model_providers.gpt6_astra_temp.requires_openai_auth=false',
  '-c', 'model_providers.gpt6_astra_temp.env_key="CODEX_TEMP_KEY"'
)
& $codex @codexArgs
