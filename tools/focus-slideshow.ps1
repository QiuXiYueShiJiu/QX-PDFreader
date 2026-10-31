# tools/focus-slideshow.ps1 —— 把幻灯片窗口拉前台（课上投影用，测试里只为复现前台问题）
param([Parameter(Mandatory = $true)][string]$Title = '幻灯片放映')
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $p) { throw "没找到标题含「$Title」的窗口" }
Set-QxForeground -Handle $p.MainWindowHandle
Write-Host "已切到窗口：$($p.MainWindowTitle)"
