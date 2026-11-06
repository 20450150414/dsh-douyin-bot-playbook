# build-pack.ps1 —— 可选：把 standalone/ 打包成 zip（排除登录态与运行时数据）
# 用法（在仓库根）：
#   powershell -ExecutionPolicy Bypass -File tools\build-pack.ps1
#   powershell -ExecutionPolicy Bypass -File tools\build-pack.ps1 -OutFile ..\douyin-takeover.zip
param(
  [string]$OutFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\douyin-takeover.zip')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'standalone'
if (-not (Test-Path $src)) { throw "缺少 standalone/：$src" }

$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
if (Test-Path $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("douyin-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Copy-Item -Path (Join-Path $src '*') -Destination $tmp -Recurse -Force

  # 绝不把登录态 / 密钥 / 运行时数据带进包
  foreach ($p in @('state', 'node_modules', 'config.json', 'selectors.local.json', '.env')) {
    $target = Join-Path $tmp $p
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  Get-ChildItem -LiteralPath $tmp -Recurse -Force -File |
    Where-Object { $_.Name -match '^(audit\.jsonl|approval\.jsonl|seen\.json|takeover\.log|video-cache\.json|dom-dump-.*|\.verify-probe)$' } |
    Remove-Item -Force

  # 附一份空白配置模板，方便解包即用
  $example = Join-Path $repo 'config\config.example.json'
  if (Test-Path $example) { Copy-Item -LiteralPath $example -Destination (Join-Path $tmp 'config.example.json') -Force }

  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $OutFile -Force
  Write-Host "已打包：$OutFile"
  Write-Host "提醒：包内不含 config.json / state/，解包后先复制模板并填值，再跑 --fixture --dry --once"
}
finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
