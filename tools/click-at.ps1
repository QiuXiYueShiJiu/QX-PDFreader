# tools/click-at.ps1 —— 在屏幕绝对坐标点一下左键
param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
Send-QxClick -X $X -Y $Y
Write-Host "已点击屏幕坐标 ${X},${Y}"
