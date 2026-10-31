# tools/send-click.ps1 —— 在指定窗口的客户区坐标点一下（先算窗口左上角偏移）
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][int]$ClientX,
  [Parameter(Mandatory = $true)][int]$ClientY
)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
$h = Get-QxMainWindow -ProcessId $ProcessId
$r = Get-QxWindowRect -Handle $h
Send-QxClick -X ($r.Left + $ClientX) -Y ($r.Top + $ClientY)
Write-Host "已在 pid=$ProcessId 的客户区 ${ClientX},${ClientY} 点击"
