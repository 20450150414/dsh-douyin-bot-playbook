# start.ps1 —— 一键启动接管服务（幂等）
# 用法（在 standalone/ 或任意目录均可）：
#   powershell -ExecutionPolicy Bypass -File tools\start.ps1                # 默认：离线演示 + dry-run 常驻
#   powershell -ExecutionPolicy Bypass -File tools\start.ps1 -Once          # 只跑一轮
#   powershell -ExecutionPolicy Bypass -File tools\start.ps1 -Real          # 真机只读（需先装 playwright 并扫码登录）
#   powershell -ExecutionPolicy Bypass -File tools\start.ps1 -Config C:\path\config.json
param(
  [switch]$Real,
  [switch]$Once,
  [string]$Config
)

$ErrorActionPreference = 'Stop'
$standalone = Split-Path -Parent $PSScriptRoot
$state = Join-Path $standalone 'state'
$pidFile = Join-Path $state 'daemon.pid'
New-Item -ItemType Directory -Path $state -Force | Out-Null

# 找 node：PATH 优先，其次 Windows 常见安装位置
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $node = $nodeCmd.Source }
else {
  foreach ($c in @('C:\Program Files\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $c) { $node = $c; break }
  }
}
if (-not $node) { throw '找不到 node.exe（需要 Node.js >= 22.13）' }

# 幂等：已有存活的 daemon 就不重复起（避免抢 3210 端口 / 双写审计）
if (Test-Path $pidFile) {
  $old = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $proc = Get-Process -Id $old -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match '^node') {
    Write-Host "已在运行：PID=$old，无需重复启动。要重启请先运行 tools\stop.ps1"
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$argv = @('takeover.mjs')
if (-not $Real) { $argv += '--fixture' }
$argv += '--dry'                       # 永远强制 dry-run；真发送要在 config.json 里显式开
if ($Once)      { $argv += '--once' }
if ($Config)    { $argv += @('--config', $Config) }

$env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
$p = Start-Process -FilePath $node -ArgumentList $argv -WorkingDirectory $standalone `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $state 'daemon.out.log') `
  -RedirectStandardError  (Join-Path $state 'daemon.err.log')
$p.Id | Set-Content -LiteralPath $pidFile -Encoding ascii

$mode = if ($Real) { '真机只读' } else { '离线演示' }
Write-Host "已启动 [$mode / dry-run]  PID=$($p.Id)  node=$node"
Write-Host "参数: $($argv -join ' ')"

# 从 config.json 读控制台地址（读不到就给默认）
$cfgPath = if ($Config) { $Config } else { Join-Path $standalone 'config.json' }
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($cfg.console.enabled) {
      Write-Host "只读控制台: http://$($cfg.console.host):$($cfg.console.port)/health?token=$($cfg.console.token)"
      Write-Host "待审队列:   http://$($cfg.console.host):$($cfg.console.port)/pending?token=$($cfg.console.token)"
    }
  } catch { Write-Host '（控制台配置读取失败，不影响主循环）' }
}
Write-Host "日志: $(Join-Path $state 'takeover.log')"
Write-Host "停止: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'stop.ps1')`""
