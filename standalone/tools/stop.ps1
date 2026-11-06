# stop.ps1 —— 停止由 start.ps1 启动的常驻服务
# 用法：powershell -ExecutionPolicy Bypass -File tools\stop.ps1
$ErrorActionPreference = 'Stop'
$standalone = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $standalone 'state\daemon.pid'

if (-not (Test-Path $pidFile)) {
  Write-Host '没有运行中的 daemon（daemon.pid 不存在）。'
  exit 0
}
$raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if (-not [int]::TryParse($raw, [ref]$null)) {
  Write-Host "daemon.pid 内容异常：$raw，已清理"
  Remove-Item -LiteralPath $pidFile -Force
  exit 0
}
$proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host "PID $raw 已不在运行，清理 pid 文件。"
  Remove-Item -LiteralPath $pidFile -Force
  exit 0
}
if ($proc.ProcessName -notmatch '^node') {
  throw "PID $raw 是 $($proc.ProcessName)，不是 node，拒绝停止（可能是 PID 复用）"
}
# 优先优雅退出，让脚本收尾（关控制台 / 关浏览器 / flush 账本）
try { Stop-Process -Id ([int]$raw) -ErrorAction Stop } catch { Write-Host "优雅停止失败：$_" }
Start-Sleep -Milliseconds 800
if (Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue) {
  Stop-Process -Id ([int]$raw) -Force -ErrorAction SilentlyContinue
  Write-Host "已强制停止 PID $raw"
} else {
  Write-Host "已停止 PID $raw"
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host '账本与日志保留在 state/ 下，重启不会重复发送（seen.json 去重）。'
