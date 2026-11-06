# setup-mcp.ps1 —— 装能力层（Python venv + douyin-mcp 依赖）
#
# 用法（在 standalone/ 或仓库根都行）：
#   powershell -ExecutionPolicy Bypass -File tools\setup-mcp.ps1
#   powershell -ExecutionPolicy Bypass -File tools\setup-mcp.ps1 -Python C:\path\to\python.exe
#   powershell -ExecutionPolicy Bypass -File tools\setup-mcp.ps1 -WithAsr     # 额外装 faster-whisper（口播转写，体积大）
#
# 装完验证：
#   node takeover.mjs --selfcheck
param(
  [string]$Python = '',
  [switch]$WithAsr,
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$standalone = Split-Path -Parent $PSScriptRoot
$repo       = Split-Path -Parent $standalone
$vendor     = Join-Path $repo 'vendor\douyin-mcp'
$venv       = Join-Path $vendor '.venv'
$server     = Join-Path $vendor 'mcp_server.py'

Write-Host "== 能力层安装 =="
if (-not (Test-Path $server)) {
  throw "缺少 $server。先拉取上游 vendor：git pull（本仓库已内置 vendor/douyin-mcp）"
}
Write-Host "上游脚本: $server"

# 1) 找一个能用的 Python 3.10+
$cands = @()
if ($Python) { $cands += $Python }
$cands += "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe"
$cands += "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python311\python.exe"
$cands += "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python310\python.exe"
$cmd = Get-Command python -ErrorAction SilentlyContinue; if ($cmd) { $cands += $cmd.Source }
$cmd = Get-Command python3 -ErrorAction SilentlyContinue; if ($cmd) { $cands += $cmd.Source }
$base = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $base) {
  # Windows 可以用 py 启动器兜底
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    $base = & py -3.12 -c "import sys;print(sys.executable)" 2>$null
    if (-not $base) { $base = & py -3 -c "import sys;print(sys.executable)" 2>$null }
  }
}
if (-not $base) { throw '找不到 Python 3.10+。装一个：winget install Python.Python.3.12' }
$ver = & $base --version
Write-Host "基础解释器: $base ($ver)"

# 2) venv
if (-not (Test-Path (Join-Path $venv 'pyvenv.cfg'))) {
  Write-Host '创建 venv ...'
  New-Item -ItemType Directory -Path (Split-Path -Parent $venv) -Force | Out-Null
  & $base -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "venv 创建失败（$LASTEXITCODE）" }
} else {
  Write-Host 'venv 已存在，跳过创建'
}
$vp = if ($IsWindows -or $env:OS -eq 'Windows_NT') { Join-Path $venv 'Scripts\python.exe' } else { Join-Path $venv 'bin/python' }
if (-not (Test-Path $vp)) { throw "venv python 不在预期位置：$vp" }

# 3) 依赖。mcp 必须 <2：2.x 把 FastMCP 改名成 MCPServer，上游用的是 v1 API。
Write-Host '升级 pip ...'
& $vp -m pip install --disable-pip-version-check -q --upgrade pip
$pkgs = @('mcp>=1.9,<2', 'playwright>=1.45', 'httpx>=0.27,<1', 'pillow>=10,<13')
if ($WithAsr) { $pkgs += @('numpy>=1.26', 'faster-whisper>=1.1,<2') }
Write-Host "安装: $($pkgs -join ', ')"
& $vp -m pip install --disable-pip-version-check @pkgs
if ($LASTEXITCODE -ne 0) { throw "pip 安装失败（$LASTEXITCODE）" }

# 4) 上游用 channel='chrome' 驱动系统 Chrome；装了 python playwright 就要铺一次浏览器
if (-not $SkipBrowser) {
  Write-Host '准备 Playwright 浏览器（上游优先用系统 Chrome，这一步是兜底）...'
  & $vp -m playwright install chromium
  if ($LASTEXITCODE -ne 0) { Write-Warning '浏览器安装失败；若本机已装 Chrome 通常仍可运行，可用 --selfcheck 验证' }
}

# 5) 冒烟：脚本要能 import + --selftest 退出码为 0
Write-Host '语法冒烟 ...'
$env:PYTHONUTF8 = '1'
& $vp -c "import mcp, playwright; from mcp.server.fastmcp import FastMCP; print('imports OK')"
if ($LASTEXITCODE -ne 0) { throw '依赖导入失败，看上面的报错' }
& $vp $server --selftest
Write-Host "selftest 退出码: $LASTEXITCODE（0=可用；报 needLogin 是正常的，说明还没登录）"

Write-Host @"

下一步：
  1) node takeover.mjs --selfcheck        看能力层与登录态
  2) node takeover.mjs --login            出二维码，手机抖音扫一次
  3) node takeover.mjs --mcp --dry --once 读真评论/真私信，只生成草稿，不发送
  登录态与缓存默认落在  `$env:USERPROFILE\.dsh\douyin-duty\`（config.mcp.home 可改）
"@
