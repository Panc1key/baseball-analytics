# 一键启动（自动修复 PATH 找不到 pnpm 的问题）
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 刷新当前会话 PATH（新开终端有时未加载用户环境变量）
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

function Find-NodeDir {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    return Split-Path $nodeCmd.Source -Parent
  }
  $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $wingetRoot) {
    $match = Get-ChildItem $wingetRoot -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) {
      return Split-Path $match.FullName -Parent
    }
  }
  return $null
}

$nodeDir = Find-NodeDir
if (-not $nodeDir) {
  Write-Host '未找到 Node.js。请先安装: winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
  exit 1
}

$env:Path = "$nodeDir;$env:Path"
Write-Host "使用 Node: $nodeDir" -ForegroundColor Cyan

$pnpm = Join-Path $nodeDir 'pnpm.cmd'
if (-not (Test-Path $pnpm)) {
  Write-Host '未找到 pnpm，正在通过 corepack 启用...' -ForegroundColor Yellow
  & (Join-Path $nodeDir 'corepack.cmd') enable
  & (Join-Path $nodeDir 'corepack.cmd') prepare pnpm@9.15.0 --activate
}

& $pnpm dev
